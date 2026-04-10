// ============================================================================
// AI Pulse — Stratified Rationale Sampler
// ============================================================================
//
// Extracts per-turn rationale-score pairs from PipelineOutput and returns
// a sample stratified by judge x scenario, with uniform random selection
// within each stratum. Used by the rationale-score consistency checker.

import { PipelineOutput } from '../types';
import { createRng, hashSeed } from '../engine/rng';
import { MOCK_MODEL_IDS, getCategoryForScenario } from '../shared/scenarios';

// --- Public Types ---

export interface RationalePair {
  conversationId: string;
  modelId: string;
  modelName: string;
  scenarioId: string;
  category: string;
  turnIndex: number;
  judgeId: string;
  givenAB: number;
  givenPC: number;
  rationale: string;
}

export interface RationaleSamplerOptions {
  targetSize: number;
  seed: string;
}

// --- Helpers ---

/**
 * Fisher-Yates shuffle using the seeded RNG.
 * Returns a new shuffled array; does not mutate input.
 */
function shuffleWithRng<T>(arr: T[], rng: ReturnType<typeof createRng>): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- Core Sampler ---

/**
 * Extracts and samples rationale-score pairs from a PipelineOutput.
 *
 * Stratification: judgeId x scenarioId. Within each stratum, pairs are
 * shuffled uniformly at random. Selection uses round-robin across strata
 * to ensure coverage of all judges and scenarios.
 *
 * The selection is deterministic given the same seed and input data.
 */
export function sampleRationalePairs(
  output: PipelineOutput,
  options: RationaleSamplerOptions,
): RationalePair[] {
  const { targetSize, seed } = options;
  const rng = createRng(hashSeed(seed));

  // 1. Extract all eligible rationale-score pairs
  const allPairs: RationalePair[] = [];

  for (const modelResult of output.results) {
    if (MOCK_MODEL_IDS.includes(modelResult.modelProfileId)) continue;

    for (const conv of modelResult.conversations) {
      // Skip conversations without perTurnScores or with scoringFailed
      if (!conv.scores.perTurnScores) continue;
      if (conv.scores.scoringFailed) continue;

      const category = getCategoryForScenario(conv.scenarioId);

      for (const turn of conv.scores.perTurnScores) {
        for (const js of turn.judgeScores) {
          // Skip entries with empty or missing rationale
          if (!js.rationale || js.rationale.trim().length === 0) continue;

          allPairs.push({
            conversationId: conv.conversationId,
            modelId: modelResult.modelProfileId,
            modelName: modelResult.modelName,
            scenarioId: conv.scenarioId,
            category,
            turnIndex: turn.turnIndex,
            judgeId: js.judgeId,
            givenAB: js.anthropomorphicBehaviour,
            givenPC: js.proactiveClarification,
            rationale: js.rationale,
          });
        }
      }
    }
  }

  // 2. If no pairs, return empty
  if (allPairs.length === 0) return [];

  // 3. If targetSize >= total, return all (shuffled for fairness)
  if (targetSize >= allPairs.length) {
    return shuffleWithRng(allPairs, rng);
  }

  // 4. Stratify by judgeId x scenarioId
  const strata = new Map<string, RationalePair[]>();
  for (const pair of allPairs) {
    const key = `${pair.judgeId}::${pair.scenarioId}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key)!.push(pair);
  }

  // 5. Shuffle within each stratum
  const shuffledStrata: RationalePair[][] = [];
  for (const [, pairs] of strata) {
    shuffledStrata.push(shuffleWithRng(pairs, rng));
  }

  // Shuffle the strata order itself for fairness
  const orderedStrata = shuffleWithRng(shuffledStrata, rng);

  // 6. Round-robin across strata to fill targetSize
  const selected: RationalePair[] = [];
  const indices = new Array(orderedStrata.length).fill(0);

  while (selected.length < targetSize) {
    let added = false;
    for (let s = 0; s < orderedStrata.length; s++) {
      if (selected.length >= targetSize) break;
      if (indices[s] < orderedStrata[s].length) {
        selected.push(orderedStrata[s][indices[s]]);
        indices[s]++;
        added = true;
      }
    }
    // Safety: if no stratum had remaining items, break to avoid infinite loop
    if (!added) break;
  }

  return selected;
}
