// ============================================================================
// AI Pulse — Judge Quality & Agreement Classification
// ============================================================================
//
// Functions and types for assessing judge agreement and bias corrections.

import { JudgeScore, AgreementLevel } from '../types';

// --- Agreement Classification ---

/**
 * Classify agreement level across judge scores based on max spread (percentage scale).
 * AB steps are 14pp apart, PC steps are 20pp. Thresholds:
 * - Max spread <= 15 → 'consensus' (same count or one AB step apart)
 * - Max spread <= 34 → 'near-consensus' (up to two AB steps or one PC step)
 * - Max spread > 34 → 'contested' (three+ AB categories or two+ PC strategies apart)
 */
export function classifyAgreement(scores: JudgeScore[]): AgreementLevel {
  if (scores.length < 2) return 'consensus';

  let maxSpread = 0;

  for (let i = 0; i < scores.length; i++) {
    for (let j = i + 1; j < scores.length; j++) {
      const abSpread = Math.abs(scores[i].anthropomorphicBehaviour - scores[j].anthropomorphicBehaviour);
      const pcSpread = Math.abs(scores[i].proactiveClarification - scores[j].proactiveClarification);
      maxSpread = Math.max(maxSpread, abSpread, pcSpread);
    }
  }

  if (maxSpread <= 15) return 'consensus';
  if (maxSpread <= 34) return 'near-consensus';
  return 'contested';
}

/**
 * Classify agreement level for each dimension independently (percentage scale).
 * Unlike classifyAgreement, which takes the worst spread across BOTH dimensions,
 * this evaluates AB spread and PC spread separately.
 *
 * Thresholds: consensus ≤15pp, near-consensus ≤34pp, contested >34pp.
 * Returns { ab, pc } where each is an independent AgreementLevel.
 */
export function classifyDimensionAgreement(scores: JudgeScore[]): { ab: AgreementLevel; pc: AgreementLevel } {
  if (scores.length < 2) return { ab: 'consensus', pc: 'consensus' };

  let maxABSpread = 0;
  let maxPCSpread = 0;

  for (let i = 0; i < scores.length; i++) {
    for (let j = i + 1; j < scores.length; j++) {
      const abSpread = Math.abs(scores[i].anthropomorphicBehaviour - scores[j].anthropomorphicBehaviour);
      const pcSpread = Math.abs(scores[i].proactiveClarification - scores[j].proactiveClarification);
      maxABSpread = Math.max(maxABSpread, abSpread);
      maxPCSpread = Math.max(maxPCSpread, pcSpread);
    }
  }

  const classifySpread = (spread: number): AgreementLevel => {
    if (spread <= 15) return 'consensus';
    if (spread <= 34) return 'near-consensus';
    return 'contested';
  };

  return {
    ab: classifySpread(maxABSpread),
    pc: classifySpread(maxPCSpread),
  };
}
