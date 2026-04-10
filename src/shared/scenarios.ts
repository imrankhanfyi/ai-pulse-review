// ============================================================================
// AI Pulse — Shared Scenario Utilities
// ============================================================================

import { SCENARIOS } from '../constructs/anthropomorphism/scenarios';
import { ANTHROBENCH_CATEGORIES, ModelProfileId } from '../types';

/** Mock model profile IDs — used to filter mock archetypes from live results */
export const MOCK_MODEL_IDS: ModelProfileId[] = ['anthropomorphizer', 'cold_but_correct', 'goldilocks'];

/** Look up the AnthroBench category for a scenario by its ID */
export function getCategoryForScenario(scenarioId: string): string {
  const scenario = SCENARIOS.find(s => s.id === scenarioId);
  if (!scenario) return 'unknown';
  for (const [category, cues] of Object.entries(ANTHROBENCH_CATEGORIES)) {
    if (cues.includes(scenario.targetCue)) {
      return category;
    }
  }
  return 'unknown';
}
