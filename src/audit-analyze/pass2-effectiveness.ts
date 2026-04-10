// ============================================================================
// AI Pulse — Triage Calibration Effectiveness
// ============================================================================

import { FlaggedConversation, CalibrationEffectiveness } from './types';

export function computeCalibrationEffectiveness(
  conversations: FlaggedConversation[],
): CalibrationEffectiveness | null {
  const withPass2 = conversations.filter(c => c.pass2TotalDiv !== null);
  if (withPass2.length === 0) return null;

  let closerToPanel = 0;
  let furtherFromPanel = 0;
  let unchanged = 0;
  let totalAbsChange = 0;
  let totalBMShift = 0;
  let totalRAShift = 0;

  for (const c of withPass2) {
    const diff = c.pass2TotalDiv! - c.pass1TotalDiv;
    totalAbsChange += Math.abs(diff);

    if (diff < -0.001) closerToPanel++;
    else if (diff > 0.001) furtherFromPanel++;
    else unchanged++;

    totalBMShift += (c.pass2ABDiv! - c.pass1ABDiv);
    totalRAShift += (c.pass2PCDiv! - c.pass1PCDiv);
  }

  const n = withPass2.length;
  return {
    meanABShift: totalBMShift / n,
    meanPCShift: totalRAShift / n,
    closerToPanel,
    furtherFromPanel,
    unchanged,
    meanAbsChange: totalAbsChange / n,
  };
}
