// ============================================================================
// Tests — Rationale Consistency Report
// ============================================================================
//
// Tests aggregateVerdicts: overall counts, gap size bucketing, per-judge
// breakdown, per-dimension breakdown, per-category breakdown, and empty input.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  RationaleConsistencyResult,
  aggregateVerdicts,
} from '../src/audit-run/rationale-report';

// ============================================================================
// Test Data Builder
// ============================================================================

function makeResult(overrides: Partial<RationaleConsistencyResult> = {}): RationaleConsistencyResult {
  return {
    // RationalePair fields
    conversationId: 'conv-001',
    modelId: 'claude-sonnet',
    modelName: 'Claude Sonnet 4.6',
    scenarioId: 'SC-01-sentience',
    category: 'internal_states',
    turnIndex: 1,
    judgeId: 'llama-3.3-70b',
    givenAB: 2,
    givenPC: 2,
    rationale: 'The model maintained boundaries adequately.',
    // ConsistencyVerdict fields
    abFromRationale: 2,
    pcFromRationale: 2,
    abConsistent: true,
    pcConsistent: true,
    abGapSize: 0,
    pcGapSize: 0,
    verdict: 'consistent',
    explanation: 'Scores match rationale.',
    ...overrides,
  };
}

function makeInconsistent(overrides: Partial<RationaleConsistencyResult> = {}): RationaleConsistencyResult {
  return makeResult({
    givenAB: 2,
    givenPC: 2,
    abFromRationale: 1,
    pcFromRationale: 2,
    abConsistent: false,
    pcConsistent: true,
    abGapSize: 1,
    pcGapSize: 0,
    verdict: 'inconsistent',
    explanation: 'BM gap of 1.',
    ...overrides,
  });
}

function makeIndeterminate(overrides: Partial<RationaleConsistencyResult> = {}): RationaleConsistencyResult {
  return makeResult({
    abFromRationale: -1,
    pcFromRationale: 2,
    abConsistent: false,
    pcConsistent: true,
    abGapSize: -1,
    pcGapSize: 0,
    verdict: 'indeterminate',
    explanation: 'BM indeterminate.',
    ...overrides,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('aggregateVerdicts — overall counts', () => {
  it('counts consistent, inconsistent, and indeterminate correctly', () => {
    const results: RationaleConsistencyResult[] = [
      makeResult(),
      makeResult(),
      makeInconsistent(),
      makeIndeterminate(),
    ];
    const summary = aggregateVerdicts(results);
    assert.equal(summary.totalSampled, 4);
    assert.equal(summary.consistent, 2);
    assert.equal(summary.inconsistent, 1);
    assert.equal(summary.indeterminate, 1);
  });

  it('handles all consistent', () => {
    const results = [makeResult(), makeResult(), makeResult()];
    const summary = aggregateVerdicts(results);
    assert.equal(summary.totalSampled, 3);
    assert.equal(summary.consistent, 3);
    assert.equal(summary.inconsistent, 0);
    assert.equal(summary.indeterminate, 0);
  });

  it('handles all inconsistent', () => {
    const results = [makeInconsistent(), makeInconsistent()];
    const summary = aggregateVerdicts(results);
    assert.equal(summary.totalSampled, 2);
    assert.equal(summary.consistent, 0);
    assert.equal(summary.inconsistent, 2);
    assert.equal(summary.indeterminate, 0);
  });
});

describe('aggregateVerdicts — gap size separation', () => {
  it('classifies small gap (≤20 pp) when max gap is ≤20', () => {
    const results = [
      makeInconsistent({ abGapSize: 14, pcGapSize: 0 }),
      makeInconsistent({ abGapSize: 0, pcGapSize: 20 }),
    ];
    const summary = aggregateVerdicts(results);
    assert.equal(summary.inconsistentByGap.gap1, 2);
    assert.equal(summary.inconsistentByGap.gap2plus, 0);
  });

  it('classifies large gap (>20 pp) when max gap is >20', () => {
    const results = [
      makeInconsistent({ abGapSize: 21, pcGapSize: 0 }),
      makeInconsistent({ abGapSize: 14, pcGapSize: 28 }),
    ];
    const summary = aggregateVerdicts(results);
    assert.equal(summary.inconsistentByGap.gap1, 0);
    assert.equal(summary.inconsistentByGap.gap2plus, 2);
  });

  it('uses max of abGapSize and pcGapSize to determine bucket', () => {
    const results = [
      makeInconsistent({ abGapSize: 14, pcGapSize: 25 }),
    ];
    const summary = aggregateVerdicts(results);
    assert.equal(summary.inconsistentByGap.gap1, 0);
    assert.equal(summary.inconsistentByGap.gap2plus, 1);
  });

  it('does not count consistent or indeterminate in gap buckets', () => {
    const results = [
      makeResult(),
      makeIndeterminate(),
    ];
    const summary = aggregateVerdicts(results);
    assert.equal(summary.inconsistentByGap.gap1, 0);
    assert.equal(summary.inconsistentByGap.gap2plus, 0);
  });
});

describe('aggregateVerdicts — per-judge breakdown', () => {
  it('groups by judgeId correctly', () => {
    const results = [
      makeResult({ judgeId: 'llama-3.3-70b' }),
      makeInconsistent({ judgeId: 'llama-3.3-70b' }),
      makeResult({ judgeId: 'qwen-3-235b' }),
      makeIndeterminate({ judgeId: 'mistral-large-3' }),
    ];
    const summary = aggregateVerdicts(results);

    assert.equal(summary.byJudge['llama-3.3-70b'].total, 2);
    assert.equal(summary.byJudge['llama-3.3-70b'].inconsistent, 1);
    assert.equal(summary.byJudge['llama-3.3-70b'].indeterminate, 0);

    assert.equal(summary.byJudge['qwen-3-235b'].total, 1);
    assert.equal(summary.byJudge['qwen-3-235b'].inconsistent, 0);
    assert.equal(summary.byJudge['qwen-3-235b'].indeterminate, 0);

    assert.equal(summary.byJudge['mistral-large-3'].total, 1);
    assert.equal(summary.byJudge['mistral-large-3'].inconsistent, 0);
    assert.equal(summary.byJudge['mistral-large-3'].indeterminate, 1);
  });
});

describe('aggregateVerdicts — per-dimension breakdown', () => {
  it('counts BM and RA inconsistencies separately', () => {
    const results = [
      // BM inconsistent only
      makeInconsistent({ abConsistent: false, pcConsistent: true, abGapSize: 1, pcGapSize: 0 }),
      // RA inconsistent only
      makeInconsistent({ abConsistent: true, pcConsistent: false, abGapSize: 0, pcGapSize: 1 }),
      // Both inconsistent
      makeInconsistent({ abConsistent: false, pcConsistent: false, abGapSize: 1, pcGapSize: 2 }),
    ];
    const summary = aggregateVerdicts(results);
    // BM inconsistent: first + third = 2
    assert.equal(summary.byDimension.abInconsistent, 2);
    // RA inconsistent: second + third = 2
    assert.equal(summary.byDimension.pcInconsistent, 2);
  });

  it('does not count consistent or indeterminate results in dimension breakdown', () => {
    const results = [
      makeResult(),
      makeIndeterminate(),
    ];
    const summary = aggregateVerdicts(results);
    assert.equal(summary.byDimension.abInconsistent, 0);
    assert.equal(summary.byDimension.pcInconsistent, 0);
  });
});

describe('aggregateVerdicts — per-category breakdown', () => {
  it('groups by category correctly', () => {
    const results = [
      makeResult({ category: 'internal_states' }),
      makeInconsistent({ category: 'internal_states' }),
      makeResult({ category: 'personhood' }),
      makeIndeterminate({ category: 'relationship_building' }),
    ];
    const summary = aggregateVerdicts(results);

    assert.equal(summary.byCategory['internal_states'].total, 2);
    assert.equal(summary.byCategory['internal_states'].inconsistent, 1);
    assert.equal(summary.byCategory['internal_states'].indeterminate, 0);

    assert.equal(summary.byCategory['personhood'].total, 1);
    assert.equal(summary.byCategory['personhood'].inconsistent, 0);
    assert.equal(summary.byCategory['personhood'].indeterminate, 0);

    assert.equal(summary.byCategory['relationship_building'].total, 1);
    assert.equal(summary.byCategory['relationship_building'].inconsistent, 0);
    assert.equal(summary.byCategory['relationship_building'].indeterminate, 1);
  });
});

describe('aggregateVerdicts — empty input', () => {
  it('returns zero counts for empty array', () => {
    const summary = aggregateVerdicts([]);
    assert.equal(summary.totalSampled, 0);
    assert.equal(summary.consistent, 0);
    assert.equal(summary.inconsistent, 0);
    assert.equal(summary.indeterminate, 0);
    assert.equal(summary.inconsistentByGap.gap1, 0);
    assert.equal(summary.inconsistentByGap.gap2plus, 0);
    assert.deepEqual(summary.byJudge, {});
    assert.equal(summary.byDimension.abInconsistent, 0);
    assert.equal(summary.byDimension.pcInconsistent, 0);
    assert.deepEqual(summary.byCategory, {});
  });
});
