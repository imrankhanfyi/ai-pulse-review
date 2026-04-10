// ============================================================================
// AI Pulse — Stratified Audit Sampler
// ============================================================================
//
// Selects a deterministic, stratified sample of conversations from
// PipelineOutput for human audit review. Sampling is seeded for
// reproducibility and stratified across model, scenario category, and
// score tier.

import { PipelineOutput, ConversationResult, ANTHROBENCH_CATEGORIES } from '../types';
import { createRng, hashSeed } from '../engine/rng';
import { MOCK_MODEL_IDS, getCategoryForScenario } from '../shared/scenarios';

// --- Public Types ---

export interface SampledConversation {
  conversationId: string;
  modelId: string;
  modelName: string;
  scenarioId: string;
  category: string;
  scoreTier: 'low' | 'mid' | 'high';
  panelAB: number;
  panelPC: number;
  perTurnScores: NonNullable<ConversationResult['scores']['perTurnScores']>;
  messages: ConversationResult['messages'];
  scores: ConversationResult['scores'];
}

export interface SamplerOptions {
  targetSize: number;
  seed: string;
}

// --- Internal Types ---

interface EligibleConversation {
  conversationId: string;
  modelId: string;
  modelName: string;
  scenarioId: string;
  category: string;
  combinedScore: number;
  panelAB: number;
  panelPC: number;
  perTurnScores: NonNullable<ConversationResult['scores']['perTurnScores']>;
  messages: ConversationResult['messages'];
  scores: ConversationResult['scores'];
}

// --- Helpers ---

/** Compute score tertile thresholds from an array of scores. Returns [low_max, mid_max]. */
function computeTertiles(scores: number[]): [number, number] {
  if (scores.length === 0) return [2, 3];
  const sorted = [...scores].sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length / 3)];
  const t2 = sorted[Math.floor((2 * sorted.length) / 3)];
  return [t1, t2];
}

/** Assign a score tier based on tertile thresholds. */
function assignTier(score: number, tertiles: [number, number]): 'low' | 'mid' | 'high' {
  if (score <= tertiles[0]) return 'low';
  if (score <= tertiles[1]) return 'mid';
  return 'high';
}

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
 * Selects a stratified audit sample from a PipelineOutput.
 *
 * Stratification dimensions:
 *   - Model (one per real model, if target allows)
 *   - Scenario category (4 AnthroBench categories)
 *   - Score tier (low / mid / high tertiles of combined BM+RA)
 *
 * The selection is deterministic given the same seed and input data.
 */
export function selectAuditSample(
  output: PipelineOutput,
  options: SamplerOptions,
): SampledConversation[] {
  const { targetSize, seed } = options;
  const rng = createRng(hashSeed(seed));

  // 1. Collect eligible conversations from real models only
  const eligible: EligibleConversation[] = [];

  for (const modelResult of output.results) {
    if (MOCK_MODEL_IDS.includes(modelResult.modelProfileId)) continue;

    for (const conv of modelResult.conversations) {
      // Must have perTurnScores and not scoringFailed
      if (!conv.scores.perTurnScores) continue;
      if (conv.scores.scoringFailed) continue;

      const panelAB = conv.scores.anthropomorphicBehaviour;
      const panelPC = conv.scores.proactiveClarification;
      const combinedScore = panelAB + panelPC;
      const category = getCategoryForScenario(conv.scenarioId);

      eligible.push({
        conversationId: conv.conversationId,
        modelId: modelResult.modelProfileId,
        modelName: modelResult.modelName,
        scenarioId: conv.scenarioId,
        category,
        combinedScore,
        panelAB,
        panelPC,
        perTurnScores: conv.scores.perTurnScores,
        messages: conv.messages,
        scores: conv.scores,
      });
    }
  }

  // 2. If no eligible conversations, return empty
  if (eligible.length === 0) return [];

  // 3. Compute tertile thresholds from all eligible combined scores
  const allScores = eligible.map(c => c.combinedScore);
  const tertiles = computeTertiles(allScores);

  // 4. Assign tiers and annotate
  const annotated = eligible.map(c => ({
    ...c,
    scoreTier: assignTier(c.combinedScore, tertiles) as 'low' | 'mid' | 'high',
  }));

  // 5. Group by model
  const byModel = new Map<string, typeof annotated>();
  for (const conv of annotated) {
    if (!byModel.has(conv.modelId)) byModel.set(conv.modelId, []);
    byModel.get(conv.modelId)!.push(conv);
  }

  // 6. For each model, greedily select conversations maximising category/tier diversity
  const selected: typeof annotated = [];
  const usedKeys = new Set<string>(); // prevent duplicate conversationIds

  // How many slots per model (floor, then handle remainder)
  const modelIds = [...byModel.keys()];
  const numModels = modelIds.length;
  const baseSlots = Math.min(targetSize, annotated.length);
  const slotsPerModel = Math.max(1, Math.floor(baseSlots / numModels));

  // Shuffle model order deterministically
  const shuffledModels = shuffleWithRng(modelIds, rng);

  // Categories and tiers we want to cover
  const allCategories = Object.keys(ANTHROBENCH_CATEGORIES);
  const allTiers: Array<'low' | 'mid' | 'high'> = ['low', 'mid', 'high'];

  for (const modelId of shuffledModels) {
    const pool = shuffleWithRng(byModel.get(modelId)!, rng);
    const modelSelected: typeof annotated = [];
    const coveredCategories = new Set<string>();
    const coveredTiers = new Set<string>();

    // Greedy pass 1: pick to maximise diversity
    for (const conv of pool) {
      if (modelSelected.length >= slotsPerModel) break;
      if (usedKeys.has(conv.conversationId)) continue;

      const newCategory = !coveredCategories.has(conv.category);
      const newTier = !coveredTiers.has(conv.scoreTier);

      if (newCategory || newTier || modelSelected.length === 0) {
        modelSelected.push(conv);
        coveredCategories.add(conv.category);
        coveredTiers.add(conv.scoreTier);
        usedKeys.add(conv.conversationId);
      }
    }

    // Greedy pass 2: fill remaining slots from pool if still under quota
    for (const conv of pool) {
      if (modelSelected.length >= slotsPerModel) break;
      if (usedKeys.has(conv.conversationId)) continue;
      modelSelected.push(conv);
      usedKeys.add(conv.conversationId);
    }

    selected.push(...modelSelected);
  }

  // 7. If we're still under targetSize, draw from remaining eligible conversations
  if (selected.length < targetSize) {
    const remaining = shuffleWithRng(
      annotated.filter(c => !usedKeys.has(c.conversationId)),
      rng,
    );
    for (const conv of remaining) {
      if (selected.length >= targetSize) break;
      selected.push(conv);
      usedKeys.add(conv.conversationId);
    }
  }

  // 8. Trim to targetSize
  const trimmed = selected.slice(0, targetSize);

  // 9. Map to public output type
  return trimmed.map(c => ({
    conversationId: c.conversationId,
    modelId: c.modelId,
    modelName: c.modelName,
    scenarioId: c.scenarioId,
    category: c.category,
    scoreTier: c.scoreTier,
    panelAB: c.panelAB,
    panelPC: c.panelPC,
    perTurnScores: c.perTurnScores,
    messages: c.messages,
    scores: c.scores,
  }));
}
