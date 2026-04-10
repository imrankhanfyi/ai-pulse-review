// ============================================================================
// AI Pulse — OpenRouter API Provider
// ============================================================================
//
// Multi-model provider using OpenRouter's OpenAI-compatible API.
// One API key gives access to hundreds of models (Llama, Mistral, etc.).
//
// Key features:
//   - Uses OpenAI chat completions format (POST /chat/completions)
//   - Supports multiple model IDs via a single provider class
//   - Rate limiting (configurable per instance)
//   - Caches responses by (modelId, scenarioId, turnIndex, runIndex)
//   - Returns ModelResponse with full API provenance metadata

import { ModelProvider, ModelProfile, Scenario, Message, ApiCallMetadata, ModelResponse } from '../../types';
import { buildSystemInstruction } from '../../shared/system-instruction';

// --- Configuration ---

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MIN_REQUEST_INTERVAL_MS = 1000; // 1 second between requests per model

// --- Cache and Rate Limiting ---

interface CacheKey {
  modelId: string;
  scenarioId: string;
  turnIndex: number;
  runIndex: number;
}

function cacheKeyToString(key: CacheKey): string {
  return `${key.modelId}:${key.scenarioId}:${key.turnIndex}:${key.runIndex}`;
}

const responseCache = new Map<string, ModelResponse>();

/**
 * Convert Message[] to OpenAI chat format.
 */
function convertToOpenAIFormat(
  systemInstruction: string,
  messages: Message[],
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const formatted: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemInstruction },
  ];
  for (const msg of messages) {
    formatted.push({
      role: msg.role === 'model' ? 'assistant' : 'user',
      content: msg.content,
    });
  }
  return formatted;
}


/**
 * Call the OpenRouter API and return the generated text with provenance metadata.
 */
async function callOpenRouterAPI(
  modelId: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<ModelResponse> {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY environment variable not set');
  }

  const requestBody = {
    model: modelId,
    messages,
    temperature: 0.7,
    max_tokens: 8192, // High ceiling — thinking models (e.g. Gemini Pro) consume reasoning tokens from this budget
  };

  const requestTimestamp = new Date().toISOString();
  const startMs = Date.now();

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://aipulse.dev',
        'X-Title': 'AI Pulse Evaluation',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(60_000),
    });

    const latencyMs = Date.now() - startMs;
    const statusCode = response.status;
    const serverDate = response.headers.get('date') || new Date().toISOString();
    const requestId = response.headers.get('x-request-id') || response.headers.get('cf-ray') || 'unknown';

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OpenRouter API Error] Status ${response.status}: ${errorText}`);
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json() as {
      id?: string;
      choices?: Array<{
        message: { content: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      model?: string;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error('[OpenRouter API Error] No content in response');
      throw new Error('No content in OpenRouter response');
    }

    const apiMetadata: ApiCallMetadata = {
      provider: `openrouter/${modelId}`,
      requestTimestamp,
      responseTimestamp: serverDate,
      requestId: data.id || requestId,
      latencyMs,
      modelVersion: data.model || modelId,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      finishReason: data.choices?.[0]?.finish_reason ?? 'unknown',
      statusCode,
    };

    return { content, apiMetadata };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[OpenRouter API Exception] ${errorMsg}`);
    throw error;
  }
}

// --- OpenRouter Provider Implementation ---

export class OpenRouterProvider implements ModelProvider {
  private modelId: string;
  /** Per-instance rate limiter — OpenRouter rate-limits per-model, not globally */
  private lastRequestTime = 0;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  private async enforceRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      const delayMs = MIN_REQUEST_INTERVAL_MS - elapsed;
      console.log(`  [Rate limit: ${this.modelId}] Sleeping ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    this.lastRequestTime = Date.now();
  }

  async generateResponse(
    profile: ModelProfile,
    scenario: Scenario,
    conversationHistory: Message[],
    turnIndex: number,
    runIndex: number,
  ): Promise<ModelResponse> {
    // Check cache first
    const cacheKey: CacheKey = {
      modelId: this.modelId,
      scenarioId: scenario.id,
      turnIndex,
      runIndex,
    };
    const cacheKeyStr = cacheKeyToString(cacheKey);
    const cached = responseCache.get(cacheKeyStr);
    if (cached) {
      console.log(`  [Cache hit] ${this.modelId}, scenario ${scenario.id}, turn ${turnIndex}, run ${runIndex}`);
      return cached;
    }

    // Enforce rate limit (per-instance, not global)
    await this.enforceRateLimit();

    // Build system instruction and messages
    const systemInstruction = buildSystemInstruction(scenario);
    const openaiMessages = convertToOpenAIFormat(systemInstruction, conversationHistory);

    // Call API
    console.log(`  [OpenRouter] Calling ${this.modelId} for scenario ${scenario.id}, turn ${turnIndex}, run ${runIndex}...`);
    let result: ModelResponse;
    try {
      result = await callOpenRouterAPI(this.modelId, openaiMessages);
    } catch (error) {
      const status = error instanceof Error ? error.message : 'unknown';
      result = { content: `[API Error: ${status}]`, isError: true };
    }

    // Cache result (skip errors — a retry should hit the API, not return a cached error)
    if (!result.isError) {
      responseCache.set(cacheKeyStr, result);
    }

    return result;
  }
}

// --- Predefined model configs for the prototype ---

export interface OpenRouterModelConfig {
  modelId: string;
  profileId: string;
  displayName: string;
  description: string;
}

export const OPENROUTER_MODELS: OpenRouterModelConfig[] = [
  {
    modelId: 'meta-llama/llama-4-maverick',
    profileId: 'llama-4-maverick',
    displayName: 'Llama 4 Maverick',
    description: 'Meta Llama 4 Maverick 17B MoE (open-source, via OpenRouter)',
  },
  {
    modelId: 'mistralai/mistral-large-2512',
    profileId: 'mistral-large-3',
    displayName: 'Mistral Large 3',
    description: 'Mistral Large 3 25.12 MoE (open-weight, via OpenRouter)',
  },
  {
    modelId: 'anthropic/claude-sonnet-4.6',
    profileId: 'claude-sonnet-4.6',
    displayName: 'Claude Sonnet 4.6',
    description: 'Anthropic Claude Sonnet 4.6 (via OpenRouter)',
  },
  {
    modelId: 'openai/gpt-5.3-chat',
    profileId: 'gpt-5.3-chat',
    displayName: 'GPT-5.3 Chat',
    description: 'OpenAI GPT-5.3 Chat (via OpenRouter)',
  },
  {
    modelId: 'deepseek/deepseek-chat',
    profileId: 'deepseek-v3',
    displayName: 'DeepSeek V3',
    description: 'DeepSeek V3 (open-source, via OpenRouter)',
  },
  {
    modelId: 'x-ai/grok-4',
    profileId: 'grok-4',
    displayName: 'Grok 4',
    description: 'xAI Grok 4 (via OpenRouter)',
  },
  {
    modelId: 'google/gemini-3.1-pro-preview',
    profileId: 'gemini-3.1-pro',
    displayName: 'Gemini 3.1 Pro',
    description: 'Google Gemini 3.1 Pro Preview (via OpenRouter)',
  },
  {
    modelId: 'qwen/qwen3.5-397b-a17b',
    profileId: 'qwen-3.5',
    displayName: 'Qwen 3.5',
    description: 'Alibaba Qwen 3.5 397B MoE (open-weight, via OpenRouter). Judge-subject family overlap: Qwen 3 235B is a judge (disclosed).',
  },
  {
    modelId: 'moonshotai/kimi-k2',
    profileId: 'kimi-k2',
    displayName: 'Kimi K2',
    description: 'Moonshot Kimi K2 (via OpenRouter)',
  },
  // --- Added Pulse 35 ---
  {
    modelId: 'anthropic/claude-opus-4.6',
    profileId: 'claude-opus-4.6',
    displayName: 'Claude Opus 4.6',
    description: 'Anthropic Claude Opus 4.6 (via OpenRouter). Cost-probed Pulse 35: $1.19/run, 0 reasoning tokens.',
  },
  {
    modelId: 'google/gemini-2.5-pro',
    profileId: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    description: 'Google Gemini 2.5 Pro thinking model (via OpenRouter)',
  },
  {
    modelId: 'openai/o4-mini',
    profileId: 'o4-mini',
    displayName: 'o4-mini',
    description: 'OpenAI o4-mini reasoning model (via OpenRouter)',
  },
  {
    modelId: 'meta-llama/llama-4-scout',
    profileId: 'llama-4-scout',
    displayName: 'Llama 4 Scout',
    description: 'Meta Llama 4 Scout (open-source, via OpenRouter). Smaller sibling of Maverick.',
  },
  {
    modelId: 'qwen/qwen3-max',
    profileId: 'qwen3-max',
    displayName: 'Qwen3 Max',
    description: 'Alibaba Qwen3 Max (via OpenRouter). Judge-subject family overlap: Qwen 3 235B is a judge (disclosed).',
  },
  {
    modelId: 'qwen/qwen3-max-thinking',
    profileId: 'qwen3-max-thinking',
    displayName: 'Qwen3 Max Thinking',
    description: 'Alibaba Qwen3 Max Thinking reasoning model (via OpenRouter). Judge-subject family overlap: Qwen 3 235B is a judge (disclosed).',
  },
  {
    modelId: 'moonshotai/kimi-k2.5',
    profileId: 'kimi-k2.5',
    displayName: 'Kimi K2.5',
    description: 'Moonshot Kimi K2.5 (via OpenRouter)',
  },
  {
    modelId: 'moonshotai/kimi-k2-thinking',
    profileId: 'kimi-k2-thinking',
    displayName: 'Kimi K2 Thinking',
    description: 'Moonshot Kimi K2 Thinking reasoning model (via OpenRouter)',
  },
];
