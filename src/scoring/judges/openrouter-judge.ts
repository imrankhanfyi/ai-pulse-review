// ============================================================================
// AI Pulse — OpenRouter Judge (Multi-Model Judge via OpenRouter API)
// ============================================================================
//
// Judge implementation that scores conversations using models accessed
// through OpenRouter's OpenAI-compatible API. Each instance wraps a
// single model; the pipeline creates one instance per judge model,
// each with its own rate limiter (OpenRouter rate-limits per-model).

import {
  Judge, JudgeScore, Conversation, DetectionMatrix, Scenario,
  ErrorCategory,
} from '../../types';
import { buildHolisticJudgePrompt, buildPerTurnJudgePrompt, buildABPrompt, buildPCPrompt } from '../../constructs/anthropomorphism/judge-prompt';
import { extractJudgeResponse, extractABResponse, extractPCResponse } from '../json-parser';
import { SharedRateLimiter } from '../../engine/rate-limiter';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// --- Retry Config ---

const MAX_RETRIES = 2;         // 2 retries = 3 total attempts
const RETRY_BACKOFF_MS = 3000; // 3s between retries

// --- Judge Model Configurations ---

export interface JudgeModelConfig {
  judgeId: string;
  modelId: string;
  displayName: string;
}

export const JUDGE_MODELS: Record<string, JudgeModelConfig> = {
  llama: {
    judgeId: 'judge-llama-3.3-70b',
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    displayName: 'Llama 3.3 70B',
  },
  mistral3: {
    judgeId: 'judge-mistral-large-3',
    // Mistral Large 3 (2512) — same version as the subject model.
    // Known self-preference overlap: disclosed. 4x cheaper than 2411.
    modelId: 'mistralai/mistral-large-2512',
    displayName: 'Mistral Large 3',
  },
  qwen3: {
    judgeId: 'judge-qwen3-235b',
    // Qwen 3 235B MoE (22B active params). No subject model overlap.
    // Qwen 2.5 72B was removed in Pulse 23 for structural scoring failures —
    // Qwen 3 is a new generation, needs validation before production use.
    modelId: 'qwen/qwen3-235b-a22b-2507',
    displayName: 'Qwen 3 235B',
  },
};

// --- OpenRouter Judge ---

export class OpenRouterJudge implements Judge {
  public id: string;
  private modelId: string;
  private displayName: string;
  private rateLimiter: SharedRateLimiter;

  /** Set after scoreConversation returns null — describes why. Read by JudgePanel. */
  public lastError: { category: ErrorCategory; httpStatus?: number; detail?: string; attempts: number } | null = null;

  constructor(config: JudgeModelConfig & { rateLimiter: SharedRateLimiter }) {
    this.id = config.judgeId;
    this.modelId = config.modelId;
    this.displayName = config.displayName;
    this.rateLimiter = config.rateLimiter;
  }

  async scoreConversation(
    conversation: Conversation,
    _detectionMatrix: DetectionMatrix | undefined,
    scenario: Scenario,
  ): Promise<JudgeScore | null> {
    const prompt = buildHolisticJudgePrompt(conversation, scenario);
    return this.sendJudgeRequest(prompt, conversation.id);
  }

  /**
   * Score a single child→model turn using the per-turn prompt.
   */
  async scoreTurn(
    childMessage: string,
    modelResponse: string,
    scenario: Scenario,
    turnLabel: string,
  ): Promise<JudgeScore | null> {
    const prompt = buildPerTurnJudgePrompt(childMessage, modelResponse, scenario);
    return this.sendJudgeRequest(prompt, turnLabel);
  }

  /**
   * Shared request logic: rate-limit, call OpenRouter, parse response, retry on failure.
   * Used by both scoreConversation and scoreTurn.
   */
  private async sendJudgeRequest(
    prompt: string,
    label: string,
  ): Promise<JudgeScore | null> {
    this.lastError = null;

    if (!OPENROUTER_API_KEY) {
      console.error(`[${this.displayName}] OPENROUTER_API_KEY not set — cannot score`);
      this.lastError = { category: 'api_error', attempts: 0, detail: 'OPENROUTER_API_KEY not set' };
      return null;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        await this.rateLimiter.acquire();

        console.log(`  [${this.displayName}] Scoring ${label}${attempt > 1 ? ` (attempt ${attempt})` : ''}...`);

        const response = await fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://aipulse.dev',
            'X-Title': 'AI Pulse Judge Panel',
          },
          body: JSON.stringify({
            model: this.modelId,
            messages: [
              { role: 'user', content: prompt },
            ],
            temperature: 0,
            max_tokens: 8192,
          }),
          signal: AbortSignal.timeout(60_000),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[${this.displayName}] API error ${response.status}: ${errorText}`);
          if (attempt <= MAX_RETRIES && (response.status === 429 || response.status >= 500)) {
            console.log(`  [${this.displayName}] Retrying in ${RETRY_BACKOFF_MS}ms...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
            continue;
          }
          const category: ErrorCategory = response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'server_error' : 'api_error';
          this.lastError = { category, httpStatus: response.status, attempts: attempt, detail: errorText.slice(0, 200) };
          return null;
        }

        const data = await response.json() as {
          choices?: Array<{ message: { content: string }; finish_reason?: string }>;
        };

        const text = data.choices?.[0]?.message?.content;
        if (!text) {
          console.error(`[${this.displayName}] No text in API response`);
          if (attempt <= MAX_RETRIES) {
            console.log(`  [${this.displayName}] Retrying in ${RETRY_BACKOFF_MS}ms...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
            continue;
          }
          this.lastError = { category: 'empty_response', attempts: attempt };
          return null;
        }

        // Parse response using robust JSON parser
        const parsed = extractJudgeResponse(text);
        if (!parsed) {
          console.error(`[${this.displayName}] Failed to parse response: ${text.slice(0, 200)}`);
          if (attempt <= MAX_RETRIES) {
            console.log(`  [${this.displayName}] Retrying in ${RETRY_BACKOFF_MS}ms...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
            continue;
          }
          this.lastError = { category: 'parse_failure', attempts: attempt, detail: text.slice(0, 200) };
          return null;
        }

        const bm = this.clampScore(parsed.anthropomorphicBehaviour);
        const ra = this.clampScore(parsed.proactiveClarification);

        if (bm === null || ra === null) {
          console.error(`[${this.displayName}] Invalid scores after parsing: AB=${parsed.anthropomorphicBehaviour}, PC=${parsed.proactiveClarification}`);
          this.lastError = { category: 'invalid_scores', attempts: attempt, detail: `AB=${parsed.anthropomorphicBehaviour}, PC=${parsed.proactiveClarification}` };
          return null;
        }

        this.lastError = null; // Success — clear any residual
        const result: JudgeScore = {
          judgeId: this.id,
          anthropomorphicBehaviour: bm,
          proactiveClarification: ra,
        };

        if (parsed.rationale) {
          result.rationale = parsed.rationale;
        }

        return result;
      } catch (err) {
        console.error(`[${this.displayName}] Error (attempt ${attempt}): ${err}`);
        if (attempt <= MAX_RETRIES) {
          console.log(`  [${this.displayName}] Retrying in ${RETRY_BACKOFF_MS}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
          continue;
        }
        this.lastError = { category: 'exception', attempts: attempt, detail: String(err).slice(0, 200) };
        return null;
      }
    }

    return null; // Unreachable, but TypeScript needs it
  }

  /**
   * Score AB categories for a single child→model turn.
   * Returns categories and quotes only — no score (computed by pipeline).
   */
  async scoreAB(
    childMessage: string,
    modelResponse: string,
    scenario: Scenario,
    turnLabel: string,
  ): Promise<{ categories: Array<{ category: string; quote: string }> } | null> {
    const prompt = buildABPrompt(childMessage, modelResponse, scenario);
    const result = await this.sendStructuredRequest(prompt, `${turnLabel} [AB]`, 'ab');
    return result as { categories: Array<{ category: string; quote: string }> } | null;
  }

  /**
   * Score PC strategies for a single child→model turn.
   * Returns strategies and quotes only — no score (computed by pipeline).
   */
  async scorePC(
    childMessage: string,
    modelResponse: string,
    scenario: Scenario,
    turnLabel: string,
  ): Promise<{ strategies: Array<{ strategy: string; quote: string }> } | null> {
    const prompt = buildPCPrompt(childMessage, modelResponse, scenario);
    const result = await this.sendStructuredRequest(prompt, `${turnLabel} [PC]`, 'pc');
    return result as { strategies: Array<{ strategy: string; quote: string }> } | null;
  }

  /**
   * Send a structured (categories-only) request. Same retry logic as sendJudgeRequest
   * but parses AB or PC response format.
   */
  private async sendStructuredRequest(
    prompt: string,
    label: string,
    dimension: 'ab' | 'pc',
  ): Promise<{ categories: Array<{ category: string; quote: string }> } | { strategies: Array<{ strategy: string; quote: string }> } | null> {
    this.lastError = null;

    if (!OPENROUTER_API_KEY) {
      this.lastError = { category: 'api_error', attempts: 0, detail: 'OPENROUTER_API_KEY not set' };
      return null;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        await this.rateLimiter.acquire();

        console.log(`  [${this.displayName}] Scoring ${label}${attempt > 1 ? ` (attempt ${attempt})` : ''}...`);

        const response = await fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://aipulse.dev',
            'X-Title': 'AI Pulse Judge Panel',
          },
          body: JSON.stringify({
            model: this.modelId,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: 2048,
          }),
          signal: AbortSignal.timeout(60_000),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[${this.displayName}] API error ${response.status}: ${errorText}`);
          if (attempt <= MAX_RETRIES && (response.status === 429 || response.status >= 500)) {
            await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
            continue;
          }
          const category: ErrorCategory = response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'server_error' : 'api_error';
          this.lastError = { category, httpStatus: response.status, attempts: attempt, detail: errorText.slice(0, 200) };
          return null;
        }

        const data = await response.json() as {
          choices?: Array<{ message: { content: string } }>;
        };

        const text = data.choices?.[0]?.message?.content;
        if (!text) {
          if (attempt <= MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
            continue;
          }
          this.lastError = { category: 'empty_response', attempts: attempt };
          return null;
        }

        const parsed = dimension === 'ab' ? extractABResponse(text) : extractPCResponse(text);
        if (!parsed) {
          console.error(`[${this.displayName}] Failed to parse ${dimension} response: ${text.slice(0, 200)}`);
          if (attempt <= MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
            continue;
          }
          this.lastError = { category: 'parse_failure', attempts: attempt, detail: text.slice(0, 200) };
          return null;
        }

        this.lastError = null;
        return parsed;
      } catch (err) {
        console.error(`[${this.displayName}] Error (attempt ${attempt}): ${err}`);
        if (attempt <= MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
          continue;
        }
        this.lastError = { category: 'exception', attempts: attempt, detail: String(err).slice(0, 200) };
        return null;
      }
    }

    return null;
  }

  private clampScore(value: number): number | null {
    const num = Number(value);
    if (isNaN(num)) return null;
    return Math.max(0, Math.min(100, Math.round(num)));
  }
}
