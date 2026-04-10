// ============================================================================
// AI Pulse — Error Type Definitions
// ============================================================================

// --- Error Tracking ---

export type ErrorCategory =
  | 'api_error'       // Non-retryable HTTP (4xx except 429)
  | 'rate_limit'      // HTTP 429, retries exhausted
  | 'server_error'    // HTTP 5xx, retries exhausted
  | 'empty_response'  // API 200 but no text content
  | 'truncation'      // finishReason=MAX_TOKENS
  | 'parse_failure'   // JSON parse or extractJudgeResponse returned null
  | 'invalid_scores'  // Parsed but AB/PC out of range or NaN
  | 'exception';      // Unexpected thrown error (network timeout, etc.)

export interface EvalError {
  source: 'judge' | 'classifier';
  sourceId: string;
  category: ErrorCategory;
  conversationId: string;
  /** Total attempts including retries */
  attempts: number;
  httpStatus?: number;
  /** Brief detail (e.g., first 200 chars of unparseable response) */
  detail?: string;
}

export interface ErrorSummary {
  totalErrors: number;
  bySource: Record<string, {
    errors: number;
    totalCalls: number;
    byCategory: Record<string, number>;
  }>;
  conversationsAffected: number;
  errors: EvalError[];
}
