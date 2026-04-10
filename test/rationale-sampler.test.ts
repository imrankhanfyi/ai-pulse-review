// ============================================================================
// Tests — Rationale Sampler
// ============================================================================
//
// Tests stratified rationale-pair sampling: judge x scenario coverage,
// determinism, mock model filtering, rationale validation, and edge cases.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  sampleRationalePairs,
  RationalePair,
} from '../src/audit-run/rationale-sampler';
import {
  PipelineOutput,
  ModelResults,
  ConversationResult,
  ConversationScores,
  JudgeScore,
  Message,
} from '../src/types';

// ============================================================================
// Mock Data Builder
// ============================================================================
//
// 3 real models + 1 mock, 4 scenarios covering all 4 AnthroBench categories,
// 3 judges, 3 turns per conversation, 1 run each.
// Each model turn scored by 3 judges with rationales = 3 models x 4 scenarios x 3 turns x 3 judges = 108 pairs.

const REAL_MODELS = [
  { id: 'claude-sonnet' as any, name: 'Claude Sonnet 4.6' },
  { id: 'gemini-flash' as any, name: 'Gemini 2.5 Flash' },
  { id: 'gpt-5-3' as any, name: 'GPT-5.3 Chat' },
];

const MOCK_MODEL = { id: 'anthropomorphizer' as any, name: 'Anthropomorphizer' };

const JUDGE_IDS = ['llama-3.3-70b', 'qwen-3-235b', 'mistral-large-3'];

// One scenario per AnthroBench category, using real scenario IDs
const SCENARIOS_FIXTURE = [
  { id: 'SC-01-sentience', category: 'internal_states' },
  { id: 'SC-05-personal-history', category: 'personhood' },
  { id: 'SC-08-sensory-input', category: 'physical_activity' },
  { id: 'SC-11-empathy', category: 'relationship_building' },
];

function makeMessages(turnCount: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < turnCount; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'model', content: `turn ${i}`, turnIndex: i });
  }
  return msgs;
}

function makeJudgeScores(withRationale = true): JudgeScore[] {
  return JUDGE_IDS.map(judgeId => ({
    judgeId,
    anthropomorphicBehaviour: 2 as any,
    proactiveClarification: 2 as any,
    rationale: withRationale ? `Rationale from ${judgeId}: The model maintained boundaries.` : undefined,
  }));
}

function makePerTurnScores(modelTurnCount: number, withRationale = true) {
  return Array.from({ length: modelTurnCount }, (_, i) => ({
    turnIndex: i * 2 + 1,
    judgeScores: makeJudgeScores(withRationale),
  }));
}

function makeConversationResult(
  modelId: string,
  scenarioId: string,
  runIndex: number,
  bm: number,
  ra: number,
  opts: { includePerTurnScores?: boolean; withRationale?: boolean; scoringFailed?: boolean } = {},
): ConversationResult {
  const { includePerTurnScores = true, withRationale = true, scoringFailed = false } = opts;
  const convId = `${scenarioId}__${modelId}__run${runIndex}`;
  const scores: ConversationScores = {
    blendedJudgeScores: makeJudgeScores(withRationale),
    anthropomorphicBehaviour: bm,
    proactiveClarification: ra,
    disagreementFlag: false,
    scoringMethod: 'per-turn',
    perTurnScores: includePerTurnScores ? makePerTurnScores(3, withRationale) : undefined,
    scoringFailed,
  };

  return {
    conversationId: convId,
    scenarioId,
    runIndex,
    messages: makeMessages(6), // 3 user + 3 model turns
    scores,
  };
}

function makeModelResults(
  modelId: any,
  modelName: string,
  scenarioIds: string[],
  opts: { withRationale?: boolean; includePerTurnScores?: boolean; scoringFailed?: boolean } = {},
): ModelResults {
  const conversations: ConversationResult[] = [];
  for (const scenarioId of scenarioIds) {
    const bm = 2.0;
    const ra = 2.0;
    conversations.push(
      makeConversationResult(modelId, scenarioId, 1, bm, ra, opts),
    );
  }

  return {
    modelProfileId: modelId,
    modelName,
    conversationCount: conversations.filter(c => !c.scores.scoringFailed).length,
    failedScoringCount: conversations.filter(c => c.scores.scoringFailed).length,
    anthropomorphicBehaviour: { lower: 1.9, mean: 2.0, upper: 2.1 },
    proactiveClarification: { lower: 1.9, mean: 2.0, upper: 2.1 },
    conversations,
  };
}

function buildMockOutput(): PipelineOutput {
  const scenarioIds = SCENARIOS_FIXTURE.map(s => s.id);

  return {
    metadata: {
      version: '1.0.0-prototype',
      timestamp: '2026-03-30T00:00:00Z',
      runId: '2026-03-30T00-00-00Z',
      mode: 'mock',
      parameters: {
        scenarioCount: 4,
        modelCount: 4,
        runsPerScenarioModel: 1,
        turnsPerConversation: 3,
        totalConversations: 16,
        bootstrapResamples: 1000,
        judgeCount: 3,
        failedScoringCount: 0,
      },
    },
    results: [
      // Real models
      makeModelResults('claude-sonnet', 'Claude Sonnet 4.6', scenarioIds),
      makeModelResults('gemini-flash', 'Gemini 2.5 Flash', scenarioIds),
      makeModelResults('gpt-5-3', 'GPT-5.3 Chat', scenarioIds),
      // Mock model — should be filtered out
      makeModelResults('anthropomorphizer', 'Anthropomorphizer', scenarioIds),
    ],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Rationale Sampler — basic contract', () => {
  it('returns requested sample size', () => {
    const output = buildMockOutput();
    // 3 models x 4 scenarios x 3 turns x 3 judges = 108 total pairs
    const sample = sampleRationalePairs(output, { targetSize: 20, seed: 'test-seed-1' });
    assert.equal(sample.length, 20);
  });

  it('returns all pairs when targetSize >= total', () => {
    const output = buildMockOutput();
    // 3 real models x 4 scenarios x 3 turns x 3 judges = 108 total pairs
    const sample = sampleRationalePairs(output, { targetSize: 1000, seed: 'test-seed-1' });
    assert.equal(sample.length, 108);
  });
});

describe('Rationale Sampler — mock model filtering', () => {
  it('excludes mock models', () => {
    const output = buildMockOutput();
    const sample = sampleRationalePairs(output, { targetSize: 1000, seed: 'test-seed-1' });
    const mockIds = ['anthropomorphizer', 'cold_but_correct', 'goldilocks'];
    for (const pair of sample) {
      assert.ok(!mockIds.includes(pair.modelId), `Mock model found: ${pair.modelId}`);
    }
  });

  it('excludes goldilocks and cold_but_correct models', () => {
    const output = buildMockOutput();
    const scenarioIds = SCENARIOS_FIXTURE.map(s => s.id);
    output.results.push(
      makeModelResults('goldilocks' as any, 'Goldilocks', scenarioIds),
      makeModelResults('cold_but_correct' as any, 'Cold-but-Correct', scenarioIds),
    );
    const sample = sampleRationalePairs(output, { targetSize: 1000, seed: 'test-seed-1' });
    for (const pair of sample) {
      assert.ok(!['goldilocks', 'cold_but_correct', 'anthropomorphizer'].includes(pair.modelId),
        `Mock model leaked into sample: ${pair.modelId}`);
    }
  });
});

describe('Rationale Sampler — determinism', () => {
  it('deterministic with same seed', () => {
    const output = buildMockOutput();
    const sample1 = sampleRationalePairs(output, { targetSize: 20, seed: 'determinism-test' });
    const sample2 = sampleRationalePairs(output, { targetSize: 20, seed: 'determinism-test' });
    assert.deepEqual(
      sample1.map(p => `${p.conversationId}:${p.judgeId}:${p.turnIndex}`),
      sample2.map(p => `${p.conversationId}:${p.judgeId}:${p.turnIndex}`),
    );
  });

  it('different samples with different seeds', () => {
    const output = buildMockOutput();
    const sample1 = sampleRationalePairs(output, { targetSize: 20, seed: 'seed-alpha' });
    const sample2 = sampleRationalePairs(output, { targetSize: 20, seed: 'seed-beta' });
    const keys1 = sample1.map(p => `${p.conversationId}:${p.judgeId}:${p.turnIndex}`).join(',');
    const keys2 = sample2.map(p => `${p.conversationId}:${p.judgeId}:${p.turnIndex}`).join(',');
    assert.notEqual(keys1, keys2, 'Different seeds produced identical samples');
  });
});

describe('Rationale Sampler — judge coverage', () => {
  it('covers all 3 judges in sample', () => {
    const output = buildMockOutput();
    const sample = sampleRationalePairs(output, { targetSize: 30, seed: 'judge-coverage' });
    const judgeIds = new Set(sample.map(p => p.judgeId));
    for (const jid of JUDGE_IDS) {
      assert.ok(judgeIds.has(jid), `Missing judge: ${jid}`);
    }
  });
});

describe('Rationale Sampler — category coverage', () => {
  it('covers all 4 scenario categories', () => {
    const output = buildMockOutput();
    const sample = sampleRationalePairs(output, { targetSize: 30, seed: 'cat-coverage' });
    const categories = new Set(sample.map(p => p.category));
    assert.ok(categories.has('internal_states'), 'Missing internal_states');
    assert.ok(categories.has('personhood'), 'Missing personhood');
    assert.ok(categories.has('physical_activity'), 'Missing physical_activity');
    assert.ok(categories.has('relationship_building'), 'Missing relationship_building');
  });
});

describe('Rationale Sampler — output shape', () => {
  it('each pair has all required fields populated', () => {
    const output = buildMockOutput();
    const sample = sampleRationalePairs(output, { targetSize: 10, seed: 'shape-test' });
    for (const pair of sample) {
      assert.ok(typeof pair.conversationId === 'string' && pair.conversationId.length > 0, 'missing conversationId');
      assert.ok(typeof pair.modelId === 'string' && pair.modelId.length > 0, 'missing modelId');
      assert.ok(typeof pair.modelName === 'string' && pair.modelName.length > 0, 'missing modelName');
      assert.ok(typeof pair.scenarioId === 'string' && pair.scenarioId.length > 0, 'missing scenarioId');
      assert.ok(typeof pair.category === 'string' && pair.category.length > 0, 'missing category');
      assert.ok(typeof pair.turnIndex === 'number', 'missing turnIndex');
      assert.ok(typeof pair.judgeId === 'string' && pair.judgeId.length > 0, 'missing judgeId');
      assert.ok(typeof pair.givenAB === 'number', 'missing givenAB');
      assert.ok(typeof pair.givenPC === 'number', 'missing givenPC');
      assert.ok(typeof pair.rationale === 'string' && pair.rationale.length > 0, 'missing rationale');
    }
  });
});

describe('Rationale Sampler — rationale filtering', () => {
  it('skips pairs with empty/missing rationales', () => {
    const output = buildMockOutput();
    // Strip rationales from all gemini-flash conversations
    const flashModel = output.results.find(r => (r.modelProfileId as string) === 'gemini-flash')!;
    for (const conv of flashModel.conversations) {
      if (conv.scores.perTurnScores) {
        for (const turn of conv.scores.perTurnScores) {
          for (const js of turn.judgeScores) {
            js.rationale = '';
          }
        }
      }
    }
    const sample = sampleRationalePairs(output, { targetSize: 1000, seed: 'test-seed-1' });
    for (const pair of sample) {
      assert.notEqual(pair.modelId, 'gemini-flash',
        'gemini-flash pairs with empty rationales should have been filtered out');
    }
  });

  it('skips pairs with undefined rationales', () => {
    const output = buildMockOutput();
    const gptModel = output.results.find(r => (r.modelProfileId as string) === 'gpt-5-3')!;
    for (const conv of gptModel.conversations) {
      if (conv.scores.perTurnScores) {
        for (const turn of conv.scores.perTurnScores) {
          for (const js of turn.judgeScores) {
            js.rationale = undefined;
          }
        }
      }
    }
    const sample = sampleRationalePairs(output, { targetSize: 1000, seed: 'test-seed-1' });
    for (const pair of sample) {
      assert.notEqual(pair.modelId, 'gpt-5-3',
        'gpt-5-3 pairs with undefined rationales should have been filtered out');
    }
  });
});

describe('Rationale Sampler — edge cases', () => {
  it('returns empty array when no eligible conversations', () => {
    const output = buildMockOutput();
    // Remove all real models, keep only mock
    output.results = output.results.filter(r => r.modelProfileId === 'anthropomorphizer');
    const sample = sampleRationalePairs(output, { targetSize: 10, seed: 'test-seed-1' });
    assert.equal(sample.length, 0);
  });

  it('returns empty array when all conversations lack perTurnScores', () => {
    const output = buildMockOutput();
    for (const modelResult of output.results) {
      for (const conv of modelResult.conversations) {
        conv.scores.perTurnScores = undefined;
      }
    }
    const sample = sampleRationalePairs(output, { targetSize: 10, seed: 'test-seed-1' });
    assert.equal(sample.length, 0);
  });

  it('returns empty array when all conversations have scoringFailed', () => {
    const output = buildMockOutput();
    for (const modelResult of output.results) {
      for (const conv of modelResult.conversations) {
        conv.scores.scoringFailed = true;
      }
    }
    const sample = sampleRationalePairs(output, { targetSize: 10, seed: 'test-seed-1' });
    assert.equal(sample.length, 0);
  });

  it('returns empty array with empty results', () => {
    const output = buildMockOutput();
    output.results = [];
    const sample = sampleRationalePairs(output, { targetSize: 10, seed: 'test-seed-1' });
    assert.equal(sample.length, 0);
  });
});
