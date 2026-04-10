// ============================================================================
// Tests — Audit Sampler
// ============================================================================
//
// Tests stratified sampling logic: model/category/tier diversity,
// determinism, mock model filtering, and edge cases.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { selectAuditSample, SampledConversation } from '../src/audit-run/sampler';
import {
  PipelineOutput,
  ModelResults,
  ConversationResult,
  ConversationScores,
  Message,
} from '../src/types';

// ============================================================================
// Mock Data Builder
// ============================================================================
//
// 3 real models + 1 mock, 4 scenarios covering all 4 AnthroBench categories,
// 2 runs each = 24 real + 8 mock conversations, with perTurnScores and a
// spread of BM/RA scores.

const REAL_MODELS = [
  { id: 'claude-sonnet' as any, name: 'Claude Sonnet 4.5' },
  { id: 'gemini-flash' as any, name: 'Gemini 2.5 Flash' },
  { id: 'gpt-4-1' as any, name: 'GPT-4.1' },
];

const MOCK_MODEL = { id: 'anthropomorphizer' as any, name: 'Anthropomorphizer' };

// One scenario per AnthroBench category, using real scenario IDs from src/scenarios.ts
const SCENARIOS_FIXTURE = [
  { id: 'SC-01-sentience', category: 'internal_states' },        // sentience → internal_states
  { id: 'SC-05-personal-history', category: 'personhood' },      // personal_history → personhood
  { id: 'SC-08-sensory-input', category: 'physical_activity' },  // sensory_input → physical_activity
  { id: 'SC-11-empathy', category: 'relationship_building' },    // empathy → relationship_building
];

function makeMessages(turnCount: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < turnCount; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'model', content: `turn ${i}`, turnIndex: i });
  }
  return msgs;
}

function makePerTurnScores(turnCount: number) {
  const modelTurns = Math.floor(turnCount / 2);
  return Array.from({ length: modelTurns }, (_, i) => ({
    turnIndex: i * 2 + 1,
    judgeScores: [
      { judgeId: 'llama', anthropomorphicBehaviour: 3 as any, proactiveClarification: 3 as any },
    ],
  }));
}

function makeConversationResult(
  modelId: string,
  scenarioId: string,
  runIndex: number,
  bm: number,
  ra: number,
  includePerTurnScores = true,
): ConversationResult {
  const convId = `${scenarioId}__${modelId}__run${runIndex}`;
  const scores: ConversationScores = {
    blendedJudgeScores: [
      { judgeId: 'llama', anthropomorphicBehaviour: bm as any, proactiveClarification: ra as any },
    ],
    anthropomorphicBehaviour: bm,
    proactiveClarification: ra,
    disagreementFlag: false,
    scoringMethod: 'per-turn',
    perTurnScores: includePerTurnScores ? makePerTurnScores(6) : undefined,
  };

  return {
    conversationId: convId,
    scenarioId,
    runIndex,
    messages: makeMessages(6),
    scores,
  };
}

function makeModelResults(
  modelId: any,
  modelName: string,
  scenarioIds: string[],
  runsPerScenario: number,
  bmRange: [number, number],
  raRange: [number, number],
  includePerTurnScores = true,
): ModelResults {
  const conversations: ConversationResult[] = [];
  for (const scenarioId of scenarioIds) {
    for (let run = 1; run <= runsPerScenario; run++) {
      // Spread scores across range (run-1 to get 0-based index for score interpolation)
      const t = ((scenarioIds.indexOf(scenarioId) * runsPerScenario + (run - 1)) /
        Math.max(1, scenarioIds.length * runsPerScenario - 1));
      const bm = Number((bmRange[0] + t * (bmRange[1] - bmRange[0])).toFixed(2));
      const ra = Number((raRange[0] + t * (raRange[1] - raRange[0])).toFixed(2));
      conversations.push(
        makeConversationResult(modelId, scenarioId, run, bm, ra, includePerTurnScores),
      );
    }
  }

  const bmMean = conversations.reduce((s, c) => s + c.scores.anthropomorphicBehaviour, 0) / conversations.length;
  const raMean = conversations.reduce((s, c) => s + c.scores.proactiveClarification, 0) / conversations.length;

  return {
    modelProfileId: modelId,
    modelName,
    conversationCount: conversations.filter(c => !c.scores.scoringFailed).length,
    failedScoringCount: 0,
    anthropomorphicBehaviour: { lower: bmMean - 0.1, mean: bmMean, upper: bmMean + 0.1 },
    proactiveClarification: { lower: raMean - 0.1, mean: raMean, upper: raMean + 0.1 },
    conversations,
  };
}

export function buildMockOutput(): PipelineOutput {
  const scenarioIds = SCENARIOS_FIXTURE.map(s => s.id);

  return {
    metadata: {
      version: '1.0.0-prototype',
      timestamp: '2026-03-19T00:00:00Z',
      runId: '2026-03-19T00-00-00Z',
      mode: 'mock',
      parameters: {
        scenarioCount: 4,
        modelCount: 4,
        runsPerScenarioModel: 2,
        turnsPerConversation: 3,
        totalConversations: 32,
        bootstrapResamples: 1000,
        judgeCount: 1,
        failedScoringCount: 0,
      },
    },
    results: [
      // Real models with varying score spreads
      makeModelResults('claude-sonnet', 'Claude Sonnet 4.5', scenarioIds, 2, [2.2, 3.0], [2.4, 3.0]),
      makeModelResults('gemini-flash', 'Gemini 2.5 Flash', scenarioIds, 2, [1.5, 2.5], [1.8, 2.6]),
      makeModelResults('gpt-4-1', 'GPT-4.1', scenarioIds, 2, [0.5, 1.8], [0.8, 2.0]),
      // Mock model — should be filtered out
      makeModelResults('anthropomorphizer', 'Anthropomorphizer', scenarioIds, 2, [0.0, 0.5], [0.0, 0.5]),
    ],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Audit Sampler — basic contract', () => {
  it('returns requested number of conversations when sufficient data available', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 6, seed: 'test-seed-1' });
    assert.equal(sample.length, 6);
  });

  it('returns all available when target > available conversations', () => {
    const output = buildMockOutput();
    // 3 real models × 4 scenarios × 2 runs = 24 eligible conversations
    const sample = selectAuditSample(output, { targetSize: 1000, seed: 'test-seed-1' });
    assert.equal(sample.length, 24);
  });

  it('returns empty array when output has no real model results', () => {
    const output = buildMockOutput();
    // Remove all real models, keep only mock
    output.results = output.results.filter(r => r.modelProfileId === 'anthropomorphizer');
    const sample = selectAuditSample(output, { targetSize: 10, seed: 'test-seed-1' });
    assert.equal(sample.length, 0);
  });
});

describe('Audit Sampler — model coverage', () => {
  it('includes conversations from all real models when target is large enough', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 12, seed: 'test-seed-1' });
    const modelIds = new Set(sample.map(c => c.modelId));
    assert.ok(modelIds.has('claude-sonnet'), 'Missing claude-sonnet');
    assert.ok(modelIds.has('gemini-flash'), 'Missing gemini-flash');
    assert.ok(modelIds.has('gpt-4-1'), 'Missing gpt-4-1');
  });

  it('filters out mock models', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 24, seed: 'test-seed-1' });
    const mockIds = ['anthropomorphizer', 'cold_but_correct', 'goldilocks'];
    for (const conv of sample) {
      assert.ok(!mockIds.includes(conv.modelId), `Mock model found: ${conv.modelId}`);
    }
  });

  it('does not include goldilocks or cold_but_correct models', () => {
    const output = buildMockOutput();
    // Inject additional mock models
    const scenarioIds = SCENARIOS_FIXTURE.map(s => s.id);
    output.results.push(
      makeModelResults('goldilocks' as any, 'Goldilocks', scenarioIds, 2, [2.0, 3.0], [2.0, 3.0]),
      makeModelResults('cold_but_correct' as any, 'Cold-but-Correct', scenarioIds, 2, [1.0, 2.0], [1.0, 2.0]),
    );
    const sample = selectAuditSample(output, { targetSize: 50, seed: 'test-seed-1' });
    for (const conv of sample) {
      assert.ok(!['goldilocks', 'cold_but_correct'].includes(conv.modelId),
        `Mock model leaked into sample: ${conv.modelId}`);
    }
  });
});

describe('Audit Sampler — category diversity', () => {
  it('covers multiple scenario categories in a large enough sample', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 12, seed: 'test-seed-1' });
    const categories = new Set(sample.map(c => c.category));
    assert.ok(categories.size >= 2, `Expected >=2 categories, got ${categories.size}: ${[...categories].join(', ')}`);
  });

  it('covers all 4 scenario categories when target is large enough', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 20, seed: 'test-seed-1' });
    const categories = new Set(sample.map(c => c.category));
    assert.ok(categories.has('internal_states'), 'Missing internal_states');
    assert.ok(categories.has('personhood'), 'Missing personhood');
    assert.ok(categories.has('physical_activity'), 'Missing physical_activity');
    assert.ok(categories.has('relationship_building'), 'Missing relationship_building');
  });
});

describe('Audit Sampler — score tier coverage', () => {
  it('covers multiple score tiers in a large enough sample', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 12, seed: 'test-seed-1' });
    const tiers = new Set(sample.map(c => c.scoreTier));
    assert.ok(tiers.size >= 2, `Expected >=2 tiers, got ${tiers.size}: ${[...tiers].join(', ')}`);
  });

  it('assigns scoreTier as low/mid/high only', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 20, seed: 'test-seed-1' });
    for (const conv of sample) {
      assert.ok(['low', 'mid', 'high'].includes(conv.scoreTier), `Invalid tier: ${conv.scoreTier}`);
    }
  });
});

describe('Audit Sampler — determinism', () => {
  it('produces identical results with the same seed', () => {
    const output = buildMockOutput();
    const sample1 = selectAuditSample(output, { targetSize: 8, seed: 'determinism-test' });
    const sample2 = selectAuditSample(output, { targetSize: 8, seed: 'determinism-test' });
    assert.deepEqual(
      sample1.map(c => c.conversationId),
      sample2.map(c => c.conversationId),
    );
  });

  it('produces different results with different seeds', () => {
    const output = buildMockOutput();
    const sample1 = selectAuditSample(output, { targetSize: 8, seed: 'seed-alpha' });
    const sample2 = selectAuditSample(output, { targetSize: 8, seed: 'seed-beta' });
    // With enough conversations, different seeds should give at least some difference
    const ids1 = sample1.map(c => c.conversationId).join(',');
    const ids2 = sample2.map(c => c.conversationId).join(',');
    assert.notEqual(ids1, ids2, 'Different seeds produced identical samples');
  });
});

describe('Audit Sampler — perTurnScores filtering', () => {
  it('skips conversations without perTurnScores', () => {
    const output = buildMockOutput();
    // Strip perTurnScores from all gemini-flash conversations
    const flashModel = output.results.find(r => (r.modelProfileId as string) === 'gemini-flash')!;
    for (const conv of flashModel.conversations) {
      conv.scores.perTurnScores = undefined;
    }
    const sample = selectAuditSample(output, { targetSize: 24, seed: 'test-seed-1' });
    // Should have no gemini-flash conversations
    for (const conv of sample) {
      assert.notEqual(conv.modelId, 'gemini-flash', 'gemini-flash should have been filtered out');
    }
  });

  it('skips conversations with scoringFailed', () => {
    const output = buildMockOutput();
    // Mark all gpt-4-1 conversations as scoringFailed
    const gptModel = output.results.find(r => (r.modelProfileId as string) === 'gpt-4-1')!;
    for (const conv of gptModel.conversations) {
      conv.scores.scoringFailed = true;
    }
    const sample = selectAuditSample(output, { targetSize: 24, seed: 'test-seed-1' });
    for (const conv of sample) {
      assert.notEqual(conv.modelId, 'gpt-4-1', 'gpt-4-1 (scoringFailed) should have been filtered out');
    }
  });

  it('returns empty array if no conversations have perTurnScores', () => {
    const output = buildMockOutput();
    for (const modelResult of output.results) {
      for (const conv of modelResult.conversations) {
        conv.scores.perTurnScores = undefined;
      }
    }
    const sample = selectAuditSample(output, { targetSize: 10, seed: 'test-seed-1' });
    assert.equal(sample.length, 0);
  });
});

describe('Audit Sampler — output shape', () => {
  it('each sampled conversation has all required fields', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 6, seed: 'shape-test' });
    for (const conv of sample) {
      assert.ok(typeof conv.conversationId === 'string', 'missing conversationId');
      assert.ok(typeof conv.modelId === 'string', 'missing modelId');
      assert.ok(typeof conv.modelName === 'string', 'missing modelName');
      assert.ok(typeof conv.scenarioId === 'string', 'missing scenarioId');
      assert.ok(typeof conv.category === 'string', 'missing category');
      assert.ok(['low', 'mid', 'high'].includes(conv.scoreTier), 'invalid scoreTier');
      assert.ok(typeof conv.panelAB === 'number', 'missing panelAB');
      assert.ok(typeof conv.panelPC === 'number', 'missing panelPC');
      assert.ok(Array.isArray(conv.perTurnScores), 'missing perTurnScores');
      assert.ok(Array.isArray(conv.messages), 'missing messages');
      assert.ok(conv.scores !== undefined, 'missing scores');
    }
  });

  it('panelAB and panelPC match conversation scores', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 10, seed: 'shape-test' });
    for (const conv of sample) {
      assert.equal(conv.panelAB, conv.scores.anthropomorphicBehaviour);
      assert.equal(conv.panelPC, conv.scores.proactiveClarification);
    }
  });

  it('no duplicate conversationIds in sample', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 20, seed: 'dedup-test' });
    const ids = sample.map(c => c.conversationId);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, 'Duplicate conversationIds found in sample');
  });
});

describe('Audit Sampler — edge cases', () => {
  it('handles targetSize of 1', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 1, seed: 'edge-test' });
    assert.equal(sample.length, 1);
  });

  it('handles targetSize of 0', () => {
    const output = buildMockOutput();
    const sample = selectAuditSample(output, { targetSize: 0, seed: 'edge-test' });
    assert.equal(sample.length, 0);
  });

  it('handles empty results array', () => {
    const output = buildMockOutput();
    output.results = [];
    const sample = selectAuditSample(output, { targetSize: 10, seed: 'edge-test' });
    assert.equal(sample.length, 0);
  });
});
