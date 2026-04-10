// Anthropomorphism construct — scoring dimensions and constants

// Re-export anthro-specific constants from types (canonical definitions stay in types for backward compat)
export { ANTHROBENCH_CUES, ANTHROBENCH_CATEGORIES, CUE_HARM_WEIGHTS } from '../../types';

// Min-blend alpha values for this construct
export const AB_ALPHA = 0.5;  // One catastrophic turn matters as much as the rest
export const PC_ALPHA = 0.25; // Worst turn is significant but doesn't dominate
