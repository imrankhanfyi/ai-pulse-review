// ============================================================================
// AI Pulse — Results Type Definitions
// ============================================================================

import type { Message, ModelResponse, Scenario } from './conversation';
import type {
  AnthroBenchCue,
  DetectionMatrix,
  ConversationScores,
  CueDetectionRate,
} from './scoring';
import type { ErrorSummary } from './errors';

// --- Model Profiles ---

export type ModelProfileId =
  // Mock archetypes
  | 'anthropomorphizer' | 'cold_but_correct' | 'goldilocks'
  // Live models (Gemini API)
  | 'gemini-flash'
  // Live models (OpenRouter)
  | 'llama-4-maverick' | 'mistral-large-3' | 'claude-sonnet-4.6'
  | 'gpt-5.3-chat' | 'deepseek-v3' | 'grok-4' | 'gemini-3.1-pro'
  | 'qwen-3.5' | 'kimi-k2'
  // Live models (OpenRouter) — added Pulse 35
  | 'claude-opus-4.6' | 'gemini-2.5-pro' | 'o4-mini'
  | 'llama-4-scout' | 'qwen3-max' | 'qwen3-max-thinking'
  | 'kimi-k2.5' | 'kimi-k2-thinking';

export interface ModelProfile {
  id: ModelProfileId;
  name: string;
  description: string;
}

/** Interface for model response generation — mocks implement this, real APIs will too */
export interface ModelProvider {
  generateResponse(
    profile: ModelProfile,
    scenario: Scenario,
    conversationHistory: Message[],
    turnIndex: number,
    runIndex: number,
  ): string | ModelResponse | Promise<string | ModelResponse>;
}

// --- Aggregated Results ---

export interface ConfidenceInterval {
  lower: number;
  upper: number;
  mean: number;
}

export interface ModelResults {
  modelProfileId: ModelProfileId;
  modelName: string;
  /** Number of conversations successfully scored */
  conversationCount: number;
  /** Number of conversations where LLM judge scoring failed after retries */
  failedScoringCount: number;
  /** Aggregate scores with CIs */
  anthropomorphicBehaviour: ConfidenceInterval;
  proactiveClarification: ConfidenceInterval;
  /** Detection rates by cue, with affirm/deny breakdown */
  cueDetectionRates?: Record<AnthroBenchCue, CueDetectionRate>;
  /** Per-conversation details */
  conversations: ConversationResult[];
}

export interface ConversationResult {
  conversationId: string;
  scenarioId: string;
  runIndex: number;
  detectionMatrix?: DetectionMatrix;
  scores: ConversationScores;
  /** Full conversation messages (piped through from pipeline) */
  messages: Message[];
}

export interface PipelineOutput {
  metadata: {
    version: string;
    timestamp: string;
    /** Unique run identifier (ISO timestamp) */
    runId: string;
    /** Git commit SHA at time of run (short hash) */
    gitSha?: string;
    /** Whether pipeline was run in live or mock mode */
    mode: 'live' | 'mock';
    parameters: {
      scenarioCount: number;
      modelCount: number;
      runsPerScenarioModel: number;
      turnsPerConversation: number;
      totalConversations: number;
      bootstrapResamples: number;
      judgeCount: number;
      failedScoringCount: number;
      scoreScale?: 'percentage';
    };
    /** Summary of real API calls made during this pipeline run (absent if mock-only) */
    provenance?: {
      apiCallCount: number;
      providers: string[];
      earliestCall: string;
      latestCall: string;
      totalInputTokens: number;
      totalOutputTokens: number;
    };
    /** Judge panel configuration (present when using multi-judge panel) */
    judgePanelConfig?: {
      judges: Array<{ judgeId: string; modelId: string; displayName: string }>;
      aggregation: 'mean' | 'min-blend';
      scoringMethod?: 'holistic' | 'per-turn';
    };
    /** Error diagnostics for the run (present when errors occurred) */
    errorSummary?: ErrorSummary;
  };
  results: ModelResults[];
}

// --- Seeded RNG ---

/** Simple seeded PRNG for reproducibility */
export interface SeededRng {
  next(): number;           // Returns [0, 1)
  nextInt(max: number): number;  // Returns [0, max)
  nextBool(probability: number): boolean;
}
