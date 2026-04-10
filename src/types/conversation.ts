// ============================================================================
// AI Pulse — Conversation Type Definitions
// ============================================================================

import type { AnthroBenchCue } from './scoring';

// --- Scenarios ---

export type AgeGroup = '7-11' | '12-17';

export interface Scenario {
  id: string;
  /** The AnthroBench cue this scenario is designed to elicit */
  targetCue: AnthroBenchCue;
  /** Short description of the scenario */
  description: string;
  /** User persona details */
  persona: {
    name: string;
    age: number;
    ageGroup: AgeGroup;
    emotionalState: string;
    attachmentStyle: string;
  };
  /** The opening user message that kicks off the conversation */
  openingMessage: string;
  /** Follow-up user messages that escalate pressure (indexed by turn) */
  followUpMessages: string[];
  /** What conversational pressure this scenario applies */
  pressureDescription: string;
}

// --- Conversations ---

export type MessageRole = 'user' | 'model';

export interface Message {
  role: MessageRole;
  content: string;
  turnIndex: number;
  /** Present only on model messages from real API calls */
  apiMetadata?: ApiCallMetadata;
  /** True if this message is an API error placeholder, not a real model response */
  isError?: boolean;
}

// --- API Provenance ---

/** Metadata captured from a real API call, proving the response came from an actual model */
export interface ApiCallMetadata {
  /** Which API provider generated this (e.g., "gemini-2.5-flash") */
  provider: string;
  /** When the request was sent (ISO 8601 timestamp, measured client-side) */
  requestTimestamp: string;
  /** When the response arrived (from the server's Date header, or client-side if unavailable) */
  responseTimestamp: string;
  /** Unique request ID from the API server (e.g., x-goog-request-id header) */
  requestId: string;
  /** Round-trip time in milliseconds, measured client-side */
  latencyMs: number;
  /** The model identifier / API endpoint used */
  modelVersion: string;
  /** Number of tokens in the prompt, as reported by the API */
  inputTokens: number;
  /** Number of tokens in the generated response, as reported by the API */
  outputTokens: number;
  /** Why the model stopped generating (e.g., "STOP", "MAX_TOKENS") */
  finishReason: string;
  /** HTTP status code of the API response */
  statusCode: number;
}

/** Return type for model providers. Mock providers omit apiMetadata; real providers include it. */
export interface ModelResponse {
  content: string;
  apiMetadata?: ApiCallMetadata;
  /** True if this response is an API error placeholder, not a real model response */
  isError?: boolean;
}

export interface Conversation {
  id: string;
  scenarioId: string;
  modelProfileId: string;
  runIndex: number;
  messages: Message[];
}
