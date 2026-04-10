// ============================================================================
// AI Pulse — Shared Formatting Utilities
// ============================================================================

/** Pad a string to a fixed width (right-padded with spaces) */
export function pad(str: string, width: number): string {
  return str.padEnd(width);
}
