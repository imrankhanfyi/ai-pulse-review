// test/triage-calibration.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { computeCalibrationEffectiveness } from '../src/audit-analyze/pass2-effectiveness';
import { FlaggedConversation } from '../src/audit-analyze/types';

function makeFlagged(p1Total: number, p2Total: number | null, p1BM = 0, p1RA = 0, p2BM: number | null = null, p2RA: number | null = null): FlaggedConversation {
  return {
    result: {} as any,
    flags: [],
    pass1TotalDiv: p1Total,
    pass2TotalDiv: p2Total,
    pass1ABDiv: p1BM,
    pass1PCDiv: p1RA,
    pass2ABDiv: p2BM,
    pass2PCDiv: p2RA,
  };
}

describe('computeCalibrationEffectiveness', () => {
  it('returns null when no pass2 data', () => {
    const convs = [makeFlagged(1.0, null)];
    assert.equal(computeCalibrationEffectiveness(convs), null);
  });

  it('counts closer vs further correctly', () => {
    const convs = [
      makeFlagged(1.0, 0.5, -0.5, -0.5, -0.3, -0.2),  // closer
      makeFlagged(0.5, 1.5, -0.3, -0.2, -1.0, -0.5),   // further
      makeFlagged(1.0, 1.0, -0.5, -0.5, -0.6, -0.4),   // unchanged
    ];
    const eff = computeCalibrationEffectiveness(convs)!;
    assert.equal(eff.closerToPanel, 1);
    assert.equal(eff.furtherFromPanel, 1);
    assert.equal(eff.unchanged, 1);
  });

  it('computes direction as mean signed shift', () => {
    const convs = [
      makeFlagged(1.0, 1.5, -0.5, -0.5, -0.8, -0.7), // BM shift: -0.3, RA shift: -0.2
      makeFlagged(1.0, 0.5, -0.5, -0.5, -0.2, -0.3),  // BM shift: +0.3, RA shift: +0.2
    ];
    const eff = computeCalibrationEffectiveness(convs)!;
    assert.ok(Math.abs(eff.meanABShift) < 0.01); // average of -0.3 and +0.3 = 0
  });
});
