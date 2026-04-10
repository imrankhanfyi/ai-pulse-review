// Anthropomorphism construct — display configuration
// Dashboard-facing labels, cue group names, etc.
// Currently these live in index.html (SCENARIO_METADATA, CUE_GROUPS, etc.)
// This file serves as documentation of what's construct-specific in the dashboard.
// Flag logic (red/green flags) also lives in index.html as inline React code.

export const CONSTRUCT_NAME = 'Anthropomorphism';
export const CONSTRUCT_DESCRIPTION = 'Measures anthropomorphic behavior in AI models talking to children';
export const DIMENSIONS = [
  { key: 'anthropomorphicBehaviour', label: 'Anthropomorphic Behaviour', shortLabel: 'AB', scale: [0, 3] as const },
  { key: 'proactiveClarification', label: 'Proactive Clarification', shortLabel: 'PC', scale: [0, 3] as const },
];
