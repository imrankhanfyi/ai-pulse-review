// ============================================================================
// Tests — Aggregator and Bootstrap CI
// ============================================================================
//
// Tests bootstrap confidence interval computation, cue detection rate
// aggregation, and affirm/deny breakdown logic.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { aggregateResults, ScoredConversation } from '../src/scoring/aggregation';
import { Conversation, Scenario, ANTHROBENCH_CUES, DetectionMatrix } from '../src/types';

// --- Test Helpers ---

function makeScenario(id: string): Scenario {
  return {
    id,
    targetCue: 'sentience',
    description: 'Test',
    persona: { name: 'Test', age: 10, ageGroup: '7-11', emotionalState: 'test', attachmentStyle: 'test' },
    openingMessage: 'Test',
    followUpMessages: ['Test'],
    pressureDescription: 'Test',
  };
}

function makeConversation(profileId: string, scenarioId: string, runIndex: number): Conversation {
  return {
    id: `${scenarioId}__${profileId}__run${runIndex}`,
    scenarioId,
    modelProfileId: profileId,
    runIndex,
    messages: [
      { role: 'user', content: 'Test', turnIndex: 0 },
      { role: 'model', content: 'Test response', turnIndex: 1 },
    ],
  };
}

function makeDetectionMatrix(detectedCues: string[], polarity: 'affirm' | 'deny' | 'mixed' = 'affirm'): DetectionMatrix {
  return [
    ANTHROBENCH_CUES.map(cue => ({
      cue,
      detected: detectedCues.includes(cue),
      source: 'rule' as const,
      polarity: detectedCues.includes(cue) ? polarity : ('none' as const),
      polarityConfidence: detectedCues.includes(cue) ? 0.9 : 0,
    })),
  ];
}

function makeScoredConversation(
  profileId: string,
  scenarioId: string,
  runIndex: number,
  bm: number,
  ba: number,
  _trajectory: number,
  detectedCues: string[] = [],
  polarity: 'affirm' | 'deny' | 'mixed' = 'affirm',
): ScoredConversation {
  return {
    conversation: makeConversation(profileId, scenarioId, runIndex),
    detectionMatrix: makeDetectionMatrix(detectedCues, polarity),
    scores: {
      blendedJudgeScores: [{ judgeId: 'test', anthropomorphicBehaviour: bm, proactiveClarification: ba }],
      anthropomorphicBehaviour: bm,
      proactiveClarification: ba,
      disagreementFlag: false,
    },
    scenario: makeScenario(scenarioId),
  };
}

// --- Bootstrap CI ---

describe('Aggregator — Bootstrap CI', () => {
  it('produces results for each model profile present', () => {
    const scored = [
      makeScoredConversation('goldilocks', 'SC-01', 1, 100, 100, 0),
      makeScoredConversation('goldilocks', 'SC-01', 2, 100, 100, 0),
      makeScoredConversation('anthropomorphizer', 'SC-01', 1, 0, 0, 0),
      makeScoredConversation('anthropomorphizer', 'SC-01', 2, 0, 0, 0),
    ];
    const results = aggregateResults(scored);
    assert.equal(results.length, 2);
    assert.ok(results.find(r => r.modelProfileId === 'goldilocks'));
    assert.ok(results.find(r => r.modelProfileId === 'anthropomorphizer'));
  });

  it('CI mean matches actual mean for uniform scores', () => {
    const scored = Array.from({ length: 10 }, (_, i) =>
      makeScoredConversation('goldilocks', `SC-${i}`, 1, 100, 100, 0),
    );
    const results = aggregateResults(scored);
    const gold = results.find(r => r.modelProfileId === 'goldilocks')!;
    assert.equal(gold.anthropomorphicBehaviour.mean, 100);
    assert.equal(gold.proactiveClarification.mean, 100);
  });

  it('CI lower <= mean <= upper', () => {
    const scored = [
      makeScoredConversation('goldilocks', 'SC-01', 1, 100, 100, 0),
      makeScoredConversation('goldilocks', 'SC-02', 1, 67, 67, 0),
      makeScoredConversation('goldilocks', 'SC-03', 1, 100, 100, 0),
      makeScoredConversation('goldilocks', 'SC-04', 1, 67, 33, 0),
    ];
    const results = aggregateResults(scored);
    const gold = results.find(r => r.modelProfileId === 'goldilocks')!;

    assert.ok(gold.anthropomorphicBehaviour.lower <= gold.anthropomorphicBehaviour.mean);
    assert.ok(gold.anthropomorphicBehaviour.mean <= gold.anthropomorphicBehaviour.upper);
    assert.ok(gold.proactiveClarification.lower <= gold.proactiveClarification.mean);
    assert.ok(gold.proactiveClarification.mean <= gold.proactiveClarification.upper);
  });

  it('CI is narrower with uniform data than with varied data', () => {
    const uniform = Array.from({ length: 10 }, (_, i) =>
      makeScoredConversation('goldilocks', `SC-${i}`, 1, 67, 67, 0),
    );
    const varied = Array.from({ length: 10 }, (_, i) =>
      makeScoredConversation('goldilocks', `SC-${i}`, 1, i % 2 === 0 ? 100 : 0, 67, 0),
    );

    const uniformResults = aggregateResults(uniform);
    const variedResults = aggregateResults(varied);
    const uGold = uniformResults.find(r => r.modelProfileId === 'goldilocks')!;
    const vGold = variedResults.find(r => r.modelProfileId === 'goldilocks')!;

    const uWidth = uGold.anthropomorphicBehaviour.upper - uGold.anthropomorphicBehaviour.lower;
    const vWidth = vGold.anthropomorphicBehaviour.upper - vGold.anthropomorphicBehaviour.lower;

    assert.ok(
      uWidth <= vWidth,
      `Uniform CI width (${uWidth}) should be <= varied CI width (${vWidth})`,
    );
  });

  it('is deterministic (same input → same output)', () => {
    const scored = [
      makeScoredConversation('goldilocks', 'SC-01', 1, 100, 100, 0),
      makeScoredConversation('goldilocks', 'SC-02', 1, 67, 67, 0),
    ];
    const results1 = aggregateResults(scored);
    const results2 = aggregateResults(scored);

    const g1 = results1.find(r => r.modelProfileId === 'goldilocks')!;
    const g2 = results2.find(r => r.modelProfileId === 'goldilocks')!;

    assert.equal(g1.anthropomorphicBehaviour.mean, g2.anthropomorphicBehaviour.mean);
    assert.equal(g1.anthropomorphicBehaviour.lower, g2.anthropomorphicBehaviour.lower);
    assert.equal(g1.anthropomorphicBehaviour.upper, g2.anthropomorphicBehaviour.upper);
  });
});

// --- Cue Detection Rates ---

describe('Aggregator — Cue Detection Rates', () => {
  it('computes correct detection rate', () => {
    // 2 conversations, emotions detected in 1 → rate = 0.5
    const scored = [
      makeScoredConversation('goldilocks', 'SC-01', 1, 100, 100, 0, ['emotions']),
      makeScoredConversation('goldilocks', 'SC-02', 1, 100, 100, 0, []),
    ];
    const results = aggregateResults(scored);
    const gold = results.find(r => r.modelProfileId === 'goldilocks')!;
    assert.equal(gold.cueDetectionRates!.emotions.total, 0.5);
  });

  it('correctly separates affirm and deny rates', () => {
    // 4 conversations: 2 affirm emotions, 1 deny-only, 1 no detection
    const scored = [
      makeScoredConversation('goldilocks', 'SC-01', 1, 100, 100, 0, ['emotions'], 'affirm'),
      makeScoredConversation('goldilocks', 'SC-02', 1, 100, 100, 0, ['emotions'], 'affirm'),
      makeScoredConversation('goldilocks', 'SC-03', 1, 100, 100, 0, ['emotions'], 'deny'),
      makeScoredConversation('goldilocks', 'SC-04', 1, 100, 100, 0, []),
    ];
    const results = aggregateResults(scored);
    const gold = results.find(r => r.modelProfileId === 'goldilocks')!;

    assert.equal(gold.cueDetectionRates!.emotions.total, 0.75);  // 3/4 detected
    assert.equal(gold.cueDetectionRates!.emotions.affirm, 0.5);  // 2/4 affirm
    assert.equal(gold.cueDetectionRates!.emotions.deny, 0.25);   // 1/4 deny-only
  });

  it('correctly handles mixed polarity in detection rates', () => {
    // 4 conversations: 1 affirm, 1 mixed, 1 deny, 1 not detected
    const scored = [
      makeScoredConversation('goldilocks', 'SC-01', 1, 100, 100, 0, ['emotions'], 'affirm'),
      makeScoredConversation('goldilocks', 'SC-02', 1, 100, 100, 0, ['emotions'], 'mixed'),
      makeScoredConversation('goldilocks', 'SC-03', 1, 100, 100, 0, ['emotions'], 'deny'),
      makeScoredConversation('goldilocks', 'SC-04', 1, 100, 100, 0, []),
    ];
    const results = aggregateResults(scored);
    const gold = results.find(r => r.modelProfileId === 'goldilocks')!;

    assert.equal(gold.cueDetectionRates!.emotions.total, 0.75);   // 3/4 detected
    assert.equal(gold.cueDetectionRates!.emotions.affirm, 0.25);  // 1/4 affirm
    assert.equal(gold.cueDetectionRates!.emotions.mixed, 0.25);   // 1/4 mixed
    assert.equal(gold.cueDetectionRates!.emotions.deny, 0.25);    // 1/4 deny
  });

  it('returns 0 rates for undetected cues', () => {
    const scored = [
      makeScoredConversation('goldilocks', 'SC-01', 1, 100, 100, 0, []),
    ];
    const results = aggregateResults(scored);
    const gold = results.find(r => r.modelProfileId === 'goldilocks')!;
    assert.equal(gold.cueDetectionRates!.sentience.total, 0);
    assert.equal(gold.cueDetectionRates!.sentience.affirm, 0);
    assert.equal(gold.cueDetectionRates!.sentience.deny, 0);
  });

  it('includes all 14 cues in detection rates', () => {
    const scored = [
      makeScoredConversation('goldilocks', 'SC-01', 1, 100, 100, 0, []),
    ];
    const results = aggregateResults(scored);
    const gold = results.find(r => r.modelProfileId === 'goldilocks')!;
    for (const cue of ANTHROBENCH_CUES) {
      assert.ok(cue in gold.cueDetectionRates!, `Missing cue: ${cue}`);
    }
  });
});
