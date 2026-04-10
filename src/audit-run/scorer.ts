// ============================================================================
// AI Pulse — Audit Scorer
// ============================================================================
//
// Scores sampled conversations using Claude Opus via OpenRouter for the
// independent audit agent. Runs two passes:
//   Pass 1: Same rubric as the judge panel
//   Pass 2: Rubric + human calibration summary prepended
//
// Each pass scores per-turn, then aggregates with minBlend (BM α=0.5, RA α=0.25).

import { Scenario, JudgeScore } from '../types';
import { buildPerTurnJudgePrompt } from '../constructs/anthropomorphism/judge-prompt';
import { extractJudgeResponse } from '../scoring/json-parser';
import { SCENARIOS } from '../constructs/anthropomorphism/scenarios';
import { AB_ALPHA, PC_ALPHA } from '../constructs/anthropomorphism/dimensions';
import { minBlend } from '../scoring/aggregation';
import { SampledConversation } from './sampler';
import { SharedRateLimiter } from '../engine/rate-limiter';

// --- Constants ---

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

const MAX_RETRIES = 2;          // 2 retries = 3 total attempts
const RETRY_BACKOFF_MS = 3000;  // 3s between retries

// --- Rate Limiter ---

// One shared rate limiter for all Opus calls (same API key).
const opusRateLimiter = new SharedRateLimiter(2000, 'AuditOpus');

// --- Public Types ---

export interface AuditTurnScore {
  turnIndex: number;
  anthropomorphicBehaviour: number;
  proactiveClarification: number;
  rationale: string;
}

export interface AuditConversationScore {
  conversationId: string;
  perTurnScores: AuditTurnScore[];
  anthropomorphicBehaviour: number;
  proactiveClarification: number;
  failedTurns: number;
}

// --- API Call ---

/**
 * Call Claude Opus via OpenRouter with the given prompt.
 * Retries up to MAX_RETRIES times on 429/5xx.
 * Returns the response text, or null on failure.
 */
export async function callOpus(prompt: string): Promise<string | null> {
  if (!OPENROUTER_API_KEY) {
    console.error('[AuditOpus] OPENROUTER_API_KEY not set — cannot call Opus');
    return null;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      await opusRateLimiter.acquire();

      console.log(`  [AuditOpus] Calling Opus${attempt > 1 ? ` (attempt ${attempt})` : ''}...`);

      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://aipulse.dev',
          'X-Title': 'AI Pulse Audit Agent',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-opus-4',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 8192,
        }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[AuditOpus] API error ${response.status}: ${errorText}`);
        if (attempt <= MAX_RETRIES && (response.status === 429 || response.status >= 500)) {
          console.log(`  [AuditOpus] Retrying in ${RETRY_BACKOFF_MS}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
          continue;
        }
        return null;
      }

      const data = await response.json() as {
        choices?: Array<{ message: { content: string }; finish_reason?: string }>;
      };

      const text = data.choices?.[0]?.message?.content;
      if (!text) {
        console.error('[AuditOpus] No text in API response');
        if (attempt <= MAX_RETRIES) {
          console.log(`  [AuditOpus] Retrying in ${RETRY_BACKOFF_MS}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
          continue;
        }
        return null;
      }

      return text;
    } catch (err) {
      console.error(`[AuditOpus] Error (attempt ${attempt}): ${err}`);
      if (attempt <= MAX_RETRIES) {
        console.log(`  [AuditOpus] Retrying in ${RETRY_BACKOFF_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
        continue;
      }
      return null;
    }
  }

  return null; // Unreachable, but TypeScript needs it
}

// --- Score Helpers ---

function clampScore(value: number): number {
  return Math.floor(Math.max(0, Math.min(3, value)));
}

// --- Per-Turn Scoring ---

/**
 * Score a single child→model turn using the standard per-turn rubric (Pass 1).
 */
export async function scorePass1Turn(
  childMessage: string,
  modelResponse: string,
  scenario: Scenario,
): Promise<AuditTurnScore | null> {
  const prompt = buildPerTurnJudgePrompt(childMessage, modelResponse, scenario);
  const text = await callOpus(prompt);
  if (!text) return null;

  const parsed = extractJudgeResponse(text);
  if (!parsed) {
    console.error(`[AuditOpus] Pass 1: failed to parse response: ${text.slice(0, 200)}`);
    return null;
  }

  const bm = clampScore(parsed.anthropomorphicBehaviour);
  const ra = clampScore(parsed.proactiveClarification);

  return {
    turnIndex: -1, // Caller sets this
    anthropomorphicBehaviour: bm,
    proactiveClarification: ra,
    rationale: parsed.rationale ?? '',
  };
}

/**
 * Score a single child→model turn with calibration summary prepended (Pass 2).
 */
export async function scorePass2Turn(
  childMessage: string,
  modelResponse: string,
  scenario: Scenario,
  calibrationSummary: string,
): Promise<AuditTurnScore | null> {
  const basePrompt = buildPerTurnJudgePrompt(childMessage, modelResponse, scenario);
  const prompt = `${calibrationSummary}\n\n---\n\n${basePrompt}`;
  const text = await callOpus(prompt);
  if (!text) return null;

  const parsed = extractJudgeResponse(text);
  if (!parsed) {
    console.error(`[AuditOpus] Pass 2: failed to parse response: ${text.slice(0, 200)}`);
    return null;
  }

  const bm = clampScore(parsed.anthropomorphicBehaviour);
  const ra = clampScore(parsed.proactiveClarification);

  return {
    turnIndex: -1, // Caller sets this
    anthropomorphicBehaviour: bm,
    proactiveClarification: ra,
    rationale: parsed.rationale ?? '',
  };
}

// --- Conversation Scoring ---

/**
 * Score all turns in a sampled conversation, then aggregate with minBlend.
 *
 * @param sampled       The conversation to score
 * @param pass          1 = standard rubric; 2 = rubric + calibration summary
 * @param calibrationSummary  Required when pass === 2
 */
export async function scoreConversation(
  sampled: SampledConversation,
  pass: 1 | 2,
  calibrationSummary?: string,
): Promise<AuditConversationScore> {
  // Look up the scenario for this conversation
  const scenario = SCENARIOS.find(s => s.id === sampled.scenarioId);
  if (!scenario) {
    console.error(`[AuditOpus] Unknown scenarioId: ${sampled.scenarioId}`);
    return {
      conversationId: sampled.conversationId,
      perTurnScores: [],
      anthropomorphicBehaviour: -1, // Sentinel for scoring failure — not a valid score. Check scoringFailed flag.
      proactiveClarification: -1, // Sentinel for scoring failure — not a valid score. Check scoringFailed flag.
      failedTurns: 0,
    };
  }

  // Extract adjacent child→model turn pairs (adjacent-message pattern from judges.ts)
  const turns: Array<{ childMessage: string; modelResponse: string }> = [];
  for (let i = 0; i < sampled.messages.length; i++) {
    const msg = sampled.messages[i];
    if (msg.role === 'model' && !msg.isError) {
      const prevUser = sampled.messages[i - 1];
      if (prevUser && prevUser.role === 'user') {
        turns.push({ childMessage: prevUser.content, modelResponse: msg.content });
      }
    }
  }

  if (turns.length === 0) {
    console.warn(`[AuditOpus] No scorable turns for ${sampled.conversationId}`);
    return {
      conversationId: sampled.conversationId,
      perTurnScores: [],
      anthropomorphicBehaviour: -1, // Sentinel for scoring failure — not a valid score. Check scoringFailed flag.
      proactiveClarification: -1, // Sentinel for scoring failure — not a valid score. Check scoringFailed flag.
      failedTurns: 0,
    };
  }

  // Score each turn sequentially (rate limiter handles spacing)
  const perTurnScores: AuditTurnScore[] = [];
  let failedTurns = 0;

  for (let ti = 0; ti < turns.length; ti++) {
    const { childMessage, modelResponse } = turns[ti];
    console.log(`  [AuditOpus] ${sampled.conversationId} turn ${ti + 1}/${turns.length} (pass ${pass})`);

    let result: AuditTurnScore | null;
    if (pass === 2 && calibrationSummary) {
      result = await scorePass2Turn(childMessage, modelResponse, scenario, calibrationSummary);
    } else {
      result = await scorePass1Turn(childMessage, modelResponse, scenario);
    }

    if (result !== null) {
      result.turnIndex = ti;
      perTurnScores.push(result);
    } else {
      failedTurns++;
      console.warn(`  [AuditOpus] Turn ${ti + 1} failed for ${sampled.conversationId}`);
    }
  }

  // Aggregate with minBlend if we have any scored turns
  if (perTurnScores.length === 0) {
    return {
      conversationId: sampled.conversationId,
      perTurnScores: [],
      anthropomorphicBehaviour: -1, // Sentinel for scoring failure — not a valid score. Check scoringFailed flag.
      proactiveClarification: -1, // Sentinel for scoring failure — not a valid score. Check scoringFailed flag.
      failedTurns,
    };
  }

  const abValues = perTurnScores.map(t => t.anthropomorphicBehaviour);
  const pcValues = perTurnScores.map(t => t.proactiveClarification);

  const anthropomorphicBehaviour = minBlend(abValues, AB_ALPHA);
  const proactiveClarification = minBlend(pcValues, PC_ALPHA);

  return {
    conversationId: sampled.conversationId,
    perTurnScores,
    anthropomorphicBehaviour,
    proactiveClarification,
    failedTurns,
  };
}
