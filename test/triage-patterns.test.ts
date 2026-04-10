// ============================================================================
// AI Pulse — Triage Pattern Detection Tests
// ============================================================================

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  detectPatterns,
  computeDivergences,
  detectLateCollapse,
  detectScoreLevelAbsences,
  computeTurnDivergenceDistribution,
} from '../src/audit-analyze/patterns';
import { AuditResult } from '../src/audit-run/report';

function makeResult(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    conversationId: 'test-conv',
    modelId: 'test-model',
    modelName: 'Test Model',
    scenarioId: 'SC-01-sentience',
    category: 'internal_states',
    scoreTier: 'mid' as const,
    panelAB: 3.0,
    panelPC: 3.0,
    pass1AB: 2.5,
    pass1PC: 2.5,
    pass1PerTurn: [
      { turnIndex: 0, anthropomorphicBehaviour: 3, proactiveClarification: 3, rationale: 'ok' },
      { turnIndex: 1, anthropomorphicBehaviour: 3, proactiveClarification: 3, rationale: 'ok' },
      { turnIndex: 2, anthropomorphicBehaviour: 2, proactiveClarification: 2, rationale: 'weak' },
    ],
    pass1FailedTurns: 0,
    partialPanelCoverage: false,
    ...overrides,
  };
}

describe('computeDivergences', () => {
  it('computes signed divergences correctly', () => {
    const result = makeResult({ panelAB: 3.0, panelPC: 3.0, pass1AB: 2.0, pass1PC: 2.5 });
    const div = computeDivergences(result);
    assert.equal(div.pass1ABDiv, -1.0);
    assert.equal(div.pass1PCDiv, -0.5);
    assert.equal(div.pass1TotalDiv, 1.5);
  });

  it('computes pass2 divergences when present', () => {
    const result = makeResult({ panelAB: 3.0, panelPC: 3.0, pass1AB: 2.5, pass1PC: 2.5, pass2AB: 2.0, pass2PC: 2.0 });
    const div = computeDivergences(result);
    assert.equal(div.pass2ABDiv, -1.0);
    assert.equal(div.pass2TotalDiv, 2.0);
  });

  it('returns null pass2 values when pass2 absent', () => {
    const result = makeResult();
    const div = computeDivergences(result);
    assert.equal(div.pass2ABDiv, null);
    assert.equal(div.pass2TotalDiv, null);
  });
});

describe('detectPatterns - CALIB-HURT', () => {
  it('flags when pass2 divergence exceeds pass1', () => {
    const result = makeResult({ pass1AB: 2.5, pass1PC: 2.5, pass2AB: 1.5, pass2PC: 1.5 });
    // pass1 total = 1.0, pass2 total = 3.0
    const flags = detectPatterns(computeDivergences(result), 0.5);
    assert.ok(flags.includes('CALIB-HURT'));
  });

  it('does not flag when pass2 is closer', () => {
    const result = makeResult({ pass1AB: 2.0, pass1PC: 2.0, pass2AB: 2.8, pass2PC: 2.8 });
    // pass1 total = 2.0, pass2 total = 0.4
    const flags = detectPatterns(computeDivergences(result), 0.5);
    assert.ok(!flags.includes('CALIB-HURT'));
  });
});

describe('detectPatterns - DIRECTION-FLIP', () => {
  it('flags when pass1 positive and pass2 negative on BM', () => {
    const result = makeResult({ panelAB: 2.0, pass1AB: 3.0, pass2AB: 1.5, pass2PC: 3.0 });
    const flags = detectPatterns(computeDivergences(result), 0.5);
    assert.ok(flags.includes('DIRECTION-FLIP'));
  });
});

describe('detectPatterns - 2x2 patterns', () => {
  it('flags RUBRIC-PROBLEM when pass1 agrees but pass2 diverges', () => {
    // panel 3.0/3.0, pass1 2.8/2.8 (agrees at 0.5), pass2 2.0/2.0 (diverges at 0.5)
    const result = makeResult({ panelAB: 3.0, panelPC: 3.0, pass1AB: 2.8, pass1PC: 2.8, pass2AB: 2.0, pass2PC: 2.0 });
    const flags = detectPatterns(computeDivergences(result), 0.5);
    assert.ok(flags.includes('RUBRIC-PROBLEM'));
  });

  it('flags JUDGE-QUALITY when pass1 diverges but pass2 agrees', () => {
    const result = makeResult({ panelAB: 3.0, panelPC: 3.0, pass1AB: 2.0, pass1PC: 2.0, pass2AB: 2.8, pass2PC: 2.8 });
    const flags = detectPatterns(computeDivergences(result), 0.5);
    assert.ok(flags.includes('JUDGE-QUALITY'));
  });

  it('flags BOTH-DIVERGE when neither pass agrees', () => {
    const result = makeResult({ panelAB: 3.0, panelPC: 3.0, pass1AB: 2.0, pass1PC: 2.0, pass2AB: 2.0, pass2PC: 2.0 });
    const flags = detectPatterns(computeDivergences(result), 0.5);
    assert.ok(flags.includes('BOTH-DIVERGE'));
  });
});

describe('detectPatterns - DIMENSION-SPLIT', () => {
  it('flags when BM agrees but RA diverges', () => {
    const result = makeResult({ panelAB: 3.0, panelPC: 3.0, pass1AB: 2.8, pass1PC: 2.0 });
    const flags = detectPatterns(computeDivergences(result), 0.5);
    assert.ok(flags.includes('DIMENSION-SPLIT'));
  });

  it('does not flag when both agree', () => {
    const result = makeResult({ panelAB: 3.0, panelPC: 3.0, pass1AB: 2.8, pass1PC: 2.8 });
    const flags = detectPatterns(computeDivergences(result), 0.5);
    assert.ok(!flags.includes('DIMENSION-SPLIT'));
  });
});

describe('detectLateCollapse', () => {
  it('flags when last turn accounts for >60% of divergence', () => {
    const result = makeResult({
      pass1PerTurn: [
        { turnIndex: 0, anthropomorphicBehaviour: 3, proactiveClarification: 3, rationale: '' },
        { turnIndex: 1, anthropomorphicBehaviour: 3, proactiveClarification: 3, rationale: '' },
        { turnIndex: 2, anthropomorphicBehaviour: 1, proactiveClarification: 1, rationale: '' },
      ],
    });
    const panelPerTurn = [
      { bm: 3, ra: 3 },
      { bm: 3, ra: 3 },
      { bm: 3, ra: 3 },
    ];
    assert.ok(detectLateCollapse(result, panelPerTurn));
  });

  it('does not flag when divergence is spread across turns', () => {
    const result = makeResult({
      pass1PerTurn: [
        { turnIndex: 0, anthropomorphicBehaviour: 2, proactiveClarification: 2, rationale: '' },
        { turnIndex: 1, anthropomorphicBehaviour: 2, proactiveClarification: 2, rationale: '' },
        { turnIndex: 2, anthropomorphicBehaviour: 2, proactiveClarification: 2, rationale: '' },
      ],
    });
    const panelPerTurn = [
      { bm: 3, ra: 3 },
      { bm: 3, ra: 3 },
      { bm: 3, ra: 3 },
    ];
    assert.ok(!detectLateCollapse(result, panelPerTurn));
  });
});

describe('detectScoreLevelAbsences', () => {
  it('detects missing levels in audit per-turn scores', () => {
    // Audit only has BM levels 2 and 3, never 0 or 1
    const results = [makeResult({
      pass1PerTurn: [
        { turnIndex: 0, anthropomorphicBehaviour: 2, proactiveClarification: 3, rationale: '' },
        { turnIndex: 1, anthropomorphicBehaviour: 3, proactiveClarification: 3, rationale: '' },
        { turnIndex: 2, anthropomorphicBehaviour: 2, proactiveClarification: 2, rationale: '' },
      ],
    })];
    // Panel has some levels
    const panelData = new Map([['test-conv', [[{ bm: 0, ra: 0 }, { bm: 1, ra: 1 }, { bm: 3, ra: 3 }]]]]);
    const absences = detectScoreLevelAbsences(results, panelData);
    const auditBMAbsences = absences.filter(a => a.dimension === 'ab' && a.source === 'audit');
    assert.ok(auditBMAbsences.some(a => a.level === 0));
    assert.ok(auditBMAbsences.some(a => a.level === 1));
  });

  it('returns empty when all levels present', () => {
    const results = [makeResult({
      pass1PerTurn: [
        { turnIndex: 0, anthropomorphicBehaviour: 0, proactiveClarification: 0, rationale: '' },
        { turnIndex: 1, anthropomorphicBehaviour: 1, proactiveClarification: 1, rationale: '' },
        { turnIndex: 2, anthropomorphicBehaviour: 2, proactiveClarification: 2, rationale: '' },
      ],
    }), makeResult({
      pass1PerTurn: [
        { turnIndex: 0, anthropomorphicBehaviour: 3, proactiveClarification: 3, rationale: '' },
      ],
    })];
    const panelData = new Map([['test-conv', [[{ bm: 0, ra: 0 }, { bm: 1, ra: 1 }, { bm: 2, ra: 2 }, { bm: 3, ra: 3 }]]]]);
    const absences = detectScoreLevelAbsences(results, panelData);
    assert.equal(absences.length, 0);
  });
});

describe('computeTurnDivergenceDistribution', () => {
  it('computes BM and RA divergence per turn index separately', () => {
    const results = [makeResult({
      conversationId: 'conv-1',
      pass1PerTurn: [
        { turnIndex: 0, anthropomorphicBehaviour: 3, proactiveClarification: 2, rationale: '' },
        { turnIndex: 1, anthropomorphicBehaviour: 3, proactiveClarification: 3, rationale: '' },
        { turnIndex: 2, anthropomorphicBehaviour: 1, proactiveClarification: 3, rationale: '' },
      ],
    })];
    const panelPerTurnByConv = new Map([
      ['conv-1', [{ bm: 3, ra: 3 }, { bm: 3, ra: 3 }, { bm: 3, ra: 3 }]],
    ]);
    const dist = computeTurnDivergenceDistribution(results, panelPerTurnByConv);
    assert.equal(dist.bm.length, 3);
    assert.equal(dist.ra.length, 3);
    // BM divergence: turn 0=0, turn 1=0, turn 2=2 — concentrated on turn 2
    assert.equal(dist.bm[2].meanAbsDiv, 2);
    assert.equal(dist.bm[0].meanAbsDiv, 0);
    // RA divergence: turn 0=1, turn 1=0, turn 2=0 — concentrated on turn 0
    assert.equal(dist.ra[0].meanAbsDiv, 1);
    assert.equal(dist.ra[2].meanAbsDiv, 0);
  });

  it('returns empty arrays for no data', () => {
    const dist = computeTurnDivergenceDistribution([], new Map());
    assert.equal(dist.bm.length, 0);
    assert.equal(dist.ra.length, 0);
  });
});
