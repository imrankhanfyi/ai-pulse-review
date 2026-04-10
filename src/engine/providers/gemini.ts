// ============================================================================
// AI Pulse — Google Gemini Flash API Provider
// ============================================================================
//
// Real API provider using the Gemini 2.0 Flash model via REST API.
// Implements the ModelProvider interface with async support.
//
// Key features:
//   - Uses Google's Generative AI REST API (no SDK)
//   - Respects free tier rate limiting (15 RPM max, enforced at 4.5s intervals)
//   - Caches responses by (scenarioId, turnIndex, runIndex)
//   - Returns natural AI behavior (no role-playing prompts)
//   - Graceful error handling with fallback strings

import { ModelProvider, ModelProfile, Scenario, Message, ApiCallMetadata, ModelResponse } from '../../types';
import { buildSystemInstruction } from '../../shared/system-instruction';

// --- Configuration ---

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const MIN_REQUEST_INTERVAL_MS = 4500; // 4.5 seconds for <15 RPM

// --- Cache and Rate Limiting ---

interface CacheKey {
  modelProfileId: string;
  scenarioId: string;
  turnIndex: number;
  runIndex: number;
}

function cacheKeyToString(key: CacheKey): string {
  return `${key.modelProfileId}:${key.scenarioId}:${key.turnIndex}:${key.runIndex}`;
}

const responseCache = new Map<string, ModelResponse>();
let lastRequestTime = 0;

/**
 * Enforce rate limiting by sleeping if necessary.
 * Ensures we stay under 15 RPM free tier limit.
 */
async function enforceRateLimit(): Promise<void> {
  const timeSinceLastRequest = Date.now() - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    const delayMs = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
    console.log(`  [Rate limit] Sleeping ${delayMs}ms...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  lastRequestTime = Date.now();
}

/**
 * Convert Message[] to Gemini API format.
 * Gemini expects: { role: 'user'|'model', parts: [{ text: '...' }] }
 */
function convertToGeminiFormat(
  messages: Message[],
): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  return messages.map(msg => ({
    role: msg.role === 'model' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));
}


/**
 * Call the Gemini API and return the generated text with provenance metadata.
 */
async function callGeminiAPI(
  systemInstruction: string,
  messages: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
): Promise<ModelResponse> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable not set');
  }

  const requestBody = {
    contents: messages,
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192, // High ceiling — thinking models consume reasoning tokens from this budget
    },
  };

  const requestTimestamp = new Date().toISOString();
  const startMs = Date.now();

  try {
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(60_000),
    });

    const latencyMs = Date.now() - startMs;
    const statusCode = response.status;
    const serverDate = response.headers.get('date') || new Date().toISOString();
    const requestId = response.headers.get('x-goog-request-id') || 'unknown';

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Gemini API Error] Status ${response.status}: ${errorText}`);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json() as {
      candidates?: Array<{
        content: { parts: Array<{ text: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) {
      console.error('[Gemini API Error] No text content in response');
      throw new Error('No text content in Gemini response');
    }

    const apiMetadata: ApiCallMetadata = {
      provider: 'gemini-2.5-flash',
      requestTimestamp,
      responseTimestamp: serverDate,
      requestId,
      latencyMs,
      modelVersion: GEMINI_API_URL,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      finishReason: data.candidates?.[0]?.finishReason ?? 'unknown',
      statusCode,
    };

    return { content, apiMetadata };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Gemini API Exception] ${errorMsg}`);
    throw error;
  }
}

// --- Gemini Provider Implementation ---

export class GeminiProvider implements ModelProvider {
  async generateResponse(
    profile: ModelProfile,
    scenario: Scenario,
    conversationHistory: Message[],
    turnIndex: number,
    runIndex: number,
  ): Promise<ModelResponse> {
    // Check cache first (includes model profile to avoid cross-model collisions)
    const cacheKey: CacheKey = {
      modelProfileId: profile.id,
      scenarioId: scenario.id,
      turnIndex,
      runIndex,
    };
    const cacheKeyStr = cacheKeyToString(cacheKey);
    const cached = responseCache.get(cacheKeyStr);
    if (cached) {
      console.log(`  [Cache hit] Scenario ${scenario.id}, turn ${turnIndex}, run ${runIndex}`);
      return cached;
    }

    // Enforce rate limit
    await enforceRateLimit();

    // Build system instruction
    const systemInstruction = buildSystemInstruction(scenario);

    // Convert history to Gemini format
    const geminiMessages = convertToGeminiFormat(conversationHistory);

    // Call API
    console.log(`  [Gemini API] Calling for scenario ${scenario.id}, turn ${turnIndex}, run ${runIndex}...`);
    let result: ModelResponse;
    try {
      result = await callGeminiAPI(systemInstruction, geminiMessages);
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
