// test/triage-bias.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  derivePerJudgeConversationScores,
  computeBiasMatrix,
  computeJudgeBaselines,
} from '../src/audit-analyze/bias';
import { AuditResult } from '../src/audit-run/report';
import { PipelineOutput, JudgeScore, ConversationScores } from '../src/types';
import { BiasCell } from '../src/audit-analyze/types';

// --- Helpers ---

function makeJudgeScore(judgeId: string, bm: number, ra: number): JudgeScore {
  return {
    judgeId,
    anthropomorphicBehaviour: bm as any,
    proactiveClarification: ra as any,
  };
}

function makePerTurnScores(
  turns: Array<{ turnIndex: number; judgeScores: JudgeScore[] }>,
) {
  return turns;
}

function makeAuditResult(overrides: Partial<AuditResult> & { conversationId: string; modelId: string; modelName: string }): AuditResult {
  return {
    scenarioId: 'scenario-1',
    category: 'internal_states',
    scoreTier: 'mid' as const,
    panelAB: 3.0,
    panelPC: 3.0,
    pass1AB: 2.0,
    pass1PC: 2.5,
    pass1PerTurn: [],
    pass1FailedTurns: 0,
    partialPanelCoverage: false,
    ...overrides,
  };
}

function makePipelineOutput(conversations: Array<{
  conversationId: string;
  modelProfileId: string;
  perTurnScores?: Array<{ turnIndex: number; judgeScores: JudgeScore[] }>;
}>): PipelineOutput {
  return {
    metadata: {
      version: '1.0.0',
      timestamp: '2026-03-19T00:00:00Z',
      runId: 'test-run',
      mode: 'mock',
      parameters: {
        scenarioCount: 1,
        modelCount: 1,
        runsPerScenarioModel: 1,
        turnsPerConversation: 3,
        totalConversations: conversations.length,
        bootstrapResamples: 100,
        judgeCount: 2,
        failedScoringCount: 0,
      },
    },
    results: [{
      modelProfileId: 'goldilocks' as any,
      modelName: 'Test Model',
      conversationCount: conversations.length,
      failedScoringCount: 0,
      anthropomorphicBehaviour: { lower: 1, upper: 3, mean: 2 },
      proactiveClarification: { lower: 1, upper: 3, mean: 2 },

      conversations: conversations.map(c => ({
        conversationId: c.conversationId,
        scenarioId: 'scenario-1',
        runIndex: 1,
        messages: [],
        scores: {
          blendedJudgeScores: [],
          anthropomorphicBehaviour: 3,
          proactiveClarification: 3,
          disagreementFlag: false,
          perTurnScores: c.perTurnScores,
          scoringMethod: 'per-turn' as const,
        } as ConversationScores,
      })),
    }],
  };
}

// --- Tests ---

describe('derivePerJudgeConversationScores', () => {
  it('applies min-blend to each judge independently', () => {
    // Judge A: BM [3, 1, 2], RA [2, 2, 2]
    // Judge B: BM [2, 2, 2], RA [3, 1, 2]
    const perTurn = makePerTurnScores([
      { turnIndex: 0, judgeScores: [makeJudgeScore('judge-a', 3, 2), makeJudgeScore('judge-b', 2, 3)] },
      { turnIndex: 1, judgeScores: [makeJudgeScore('judge-a', 1, 2), makeJudgeScore('judge-b', 2, 1)] },
      { turnIndex: 2, judgeScores: [makeJudgeScore('judge-a', 2, 2), makeJudgeScore('judge-b', 2, 2)] },
    ]);

    // AB_ALPHA=0.5, PC_ALPHA=0.25
    const result = derivePerJudgeConversationScores(perTurn);

    // Judge A BM: min=1, mean=2 => 0.5*1 + 0.5*2 = 1.5
    // Judge A RA: min=2, mean=2 => 0.25*2 + 0.75*2 = 2.0
    const judgeA = result.get('judge-a')!;
    assert.ok(judgeA, 'judge-a should be present');
    assert.ok(Math.abs(judgeA.bm - 1.5) < 0.001, `judge-a BM should be 1.5, got ${judgeA.bm}`);
    assert.ok(Math.abs(judgeA.ra - 2.0) < 0.001, `judge-a RA should be 2.0, got ${judgeA.ra}`);

    // Judge B BM: min=2, mean=2 => 0.5*2 + 0.5*2 = 2.0
    // Judge B RA: min=1, mean=2 => 0.25*1 + 0.75*2 = 1.75
    const judgeB = result.get('judge-b')!;
    assert.ok(judgeB, 'judge-b should be present');
    assert.ok(Math.abs(judgeB.bm - 2.0) < 0.001, `judge-b BM should be 2.0, got ${judgeB.bm}`);
    assert.ok(Math.abs(judgeB.ra - 1.75) < 0.001, `judge-b RA should be 1.75, got ${judgeB.ra}`);
  });

  it('handles a single judge', () => {
    const perTurn = makePerTurnScores([
      { turnIndex: 0, judgeScores: [makeJudgeScore('solo-judge', 3, 3)] },
      { turnIndex: 1, judgeScores: [makeJudgeScore('solo-judge', 1, 2)] },
    ]);

    const result = derivePerJudgeConversationScores(perTurn);
    assert.equal(result.size, 1);

    // BM: min=1, mean=2 => 0.5*1 + 0.5*2 = 1.5
    // RA: min=2, mean=2.5 => 0.25*2 + 0.75*2.5 = 2.375
    const solo = result.get('solo-judge')!;
    assert.ok(Math.abs(solo.bm - 1.5) < 0.001);
    assert.ok(Math.abs(solo.ra - 2.375) < 0.001);
  });

  it('handles missing judge scores on some turns', () => {
    // Judge A present on all 3 turns, Judge B only on turn 0 and 2
    const perTurn = makePerTurnScores([
      { turnIndex: 0, judgeScores: [makeJudgeScore('judge-a', 3, 3), makeJudgeScore('judge-b', 2, 2)] },
      { turnIndex: 1, judgeScores: [makeJudgeScore('judge-a', 1, 1)] },
      { turnIndex: 2, judgeScores: [makeJudgeScore('judge-a', 2, 2), makeJudgeScore('judge-b', 0, 0)] },
    ]);

    const result = derivePerJudgeConversationScores(perTurn);

    // Judge A: BM [3,1,2], RA [3,1,2]
    // BM: min=1, mean=2 => 0.5*1 + 0.5*2 = 1.5
    // RA: min=1, mean=2 => 0.25*1 + 0.75*2 = 1.75
    const judgeA = result.get('judge-a')!;
    assert.ok(Math.abs(judgeA.bm - 1.5) < 0.001);
    assert.ok(Math.abs(judgeA.ra - 1.75) < 0.001);

    // Judge B: BM [2,0], RA [2,0] (only turns 0 and 2)
    // BM: min=0, mean=1 => 0.5*0 + 0.5*1 = 0.5
    // RA: min=0, mean=1 => 0.25*0 + 0.75*1 = 0.75
    const judgeB = result.get('judge-b')!;
    assert.ok(Math.abs(judgeB.bm - 0.5) < 0.001);
    assert.ok(Math.abs(judgeB.ra - 0.75) < 0.001);
  });

  it('returns empty map for empty perTurnScores', () => {
    const result = derivePerJudgeConversationScores([]);
    assert.equal(result.size, 0);
  });

  it('returns empty map for undefined-like input', () => {
    const result = derivePerJudgeConversationScores(
      undefined as any,
    );
    assert.equal(result.size, 0);
  });

  it('accepts custom alpha values', () => {
    const perTurn = makePerTurnScores([
      { turnIndex: 0, judgeScores: [makeJudgeScore('judge-a', 3, 3)] },
      { turnIndex: 1, judgeScores: [makeJudgeScore('judge-a', 1, 1)] },
    ]);

    // All-min: alpha=1.0 for both
    const result = derivePerJudgeConversationScores(perTurn, 1.0, 1.0);
    const judgeA = result.get('judge-a')!;
    assert.ok(Math.abs(judgeA.bm - 1.0) < 0.001); // 1.0*1 + 0.0*2 = 1.0
    assert.ok(Math.abs(judgeA.ra - 1.0) < 0.001); // 1.0*1 + 0.0*2 = 1.0
  });
});

describe('computeBiasMatrix', () => {
  it('groups by judge x model and computes mean divergence', () => {
    const perTurn = [
      { turnIndex: 0, judgeScores: [makeJudgeScore('llama', 2, 2), makeJudgeScore('mistral', 3, 3)] },
      { turnIndex: 1, judgeScores: [makeJudgeScore('llama', 2, 2), makeJudgeScore('mistral', 3, 3)] },
      { turnIndex: 2, judgeScores: [makeJudgeScore('llama', 2, 2), makeJudgeScore('mistral', 3, 3)] },
    ];

    const pipelineOutput = makePipelineOutput([
      { conversationId: 'conv-1', modelProfileId: 'model-a', perTurnScores: perTurn },
    ]);

    // Audit says AB=1, PC=1.5
    // llama blended: BM = 0.5*2 + 0.5*2 = 2, RA = 0.25*2 + 0.75*2 = 2
    // mistral blended: BM = 0.5*3 + 0.5*3 = 3, RA = 0.25*3 + 0.75*3 = 3
    // Divergence (audit - judge):
    //   llama:   BM = 1-2 = -1,   RA = 1.5-2 = -0.5
    //   mistral: BM = 1-3 = -2,   RA = 1.5-3 = -1.5
    const auditResults = [
      makeAuditResult({ conversationId: 'conv-1', modelId: 'model-a', modelName: 'Model A', pass1AB: 1, pass1PC: 1.5 }),
    ];

    const matrix = computeBiasMatrix(auditResults, pipelineOutput)!;
    assert.ok(matrix, 'matrix should not be null');
    assert.deepEqual(matrix.judges.sort(), ['llama', 'mistral']);
    assert.equal(matrix.cells.length, 2);

    const llamaCell = matrix.cells.find(c => c.judgeId === 'llama')!;
    assert.ok(Math.abs(llamaCell.meanABDiv - (-1)) < 0.001);
    assert.ok(Math.abs(llamaCell.meanPCDiv - (-0.5)) < 0.001);
    assert.equal(llamaCell.count, 1);

    const mistralCell = matrix.cells.find(c => c.judgeId === 'mistral')!;
    assert.ok(Math.abs(mistralCell.meanABDiv - (-2)) < 0.001);
    assert.ok(Math.abs(mistralCell.meanPCDiv - (-1.5)) < 0.001);
    assert.equal(mistralCell.count, 1);
  });

  it('averages divergence across multiple conversations for same judge x model', () => {
    // Two conversations for the same model, same judges
    const perTurn1 = [
      { turnIndex: 0, judgeScores: [makeJudgeScore('llama', 2, 2)] },
      { turnIndex: 1, judgeScores: [makeJudgeScore('llama', 2, 2)] },
    ];
    const perTurn2 = [
      { turnIndex: 0, judgeScores: [makeJudgeScore('llama', 3, 3)] },
      { turnIndex: 1, judgeScores: [makeJudgeScore('llama', 3, 3)] },
    ];

    const pipelineOutput = makePipelineOutput([
      { conversationId: 'conv-1', modelProfileId: 'model-a', perTurnScores: perTurn1 },
      { conversationId: 'conv-2', modelProfileId: 'model-a', perTurnScores: perTurn2 },
    ]);

    // Conv-1: llama blended AB=2, PC=2. Audit AB=1, PC=1. Div: AB=-1, PC=-1
    // Conv-2: llama blended AB=3, PC=3. Audit AB=2, PC=2. Div: AB=-1, PC=-1
    // Mean: AB=-1, PC=-1
    const auditResults = [
      makeAuditResult({ conversationId: 'conv-1', modelId: 'model-a', modelName: 'Model A', pass1AB: 1, pass1PC: 1 }),
      makeAuditResult({ conversationId: 'conv-2', modelId: 'model-a', modelName: 'Model A', pass1AB: 2, pass1PC: 2 }),
    ];

    const matrix = computeBiasMatrix(auditResults, pipelineOutput)!;
    assert.equal(matrix.cells.length, 1);
    const cell = matrix.cells[0];
    assert.ok(Math.abs(cell.meanABDiv - (-1)) < 0.001);
    assert.ok(Math.abs(cell.meanPCDiv - (-1)) < 0.001);
    assert.equal(cell.count, 2);
  });

  it('computes judge baselines as weighted mean across models', () => {
    // Two different models, same judge
    const perTurnA = [
      { turnIndex: 0, judgeScores: [makeJudgeScore('llama', 2, 2)] },
    ];
    const perTurnB = [
      { turnIndex: 0, judgeScores: [makeJudgeScore('llama', 3, 3)] },
    ];

    const pipelineOutput: PipelineOutput = {
      metadata: {
        version: '1.0.0',
        timestamp: '2026-03-19T00:00:00Z',
        runId: 'test-run',
        mode: 'mock',
        parameters: {
          scenarioCount: 1, modelCount: 2, runsPerScenarioModel: 1,
          turnsPerConversation: 1, totalConversations: 2,
          bootstrapResamples: 100, judgeCount: 1, failedScoringCount: 0,
        },
      },
      results: [
        {
          modelProfileId: 'goldilocks' as any,
          modelName: 'Model A',
          conversationCount: 1,
          failedScoringCount: 0,
          anthropomorphicBehaviour: { lower: 1, upper: 3, mean: 2 },
          proactiveClarification: { lower: 1, upper: 3, mean: 2 },
    
          conversations: [{
            conversationId: 'conv-a', scenarioId: 'scenario-1', runIndex: 1, messages: [],
            scores: {
              blendedJudgeScores: [], anthropomorphicBehaviour: 2, proactiveClarification: 2,
              disagreementFlag: false,
              perTurnScores: perTurnA, scoringMethod: 'per-turn' as const,
            } as ConversationScores,
          }],
        },
        {
          modelProfileId: 'goldilocks' as any,
          modelName: 'Model B',
          conversationCount: 1,
          failedScoringCount: 0,
          anthropomorphicBehaviour: { lower: 1, upper: 3, mean: 2 },
          proactiveClarification: { lower: 1, upper: 3, mean: 2 },
    
          conversations: [{
            conversationId: 'conv-b', scenarioId: 'scenario-1', runIndex: 1, messages: [],
            scores: {
              blendedJudgeScores: [], anthropomorphicBehaviour: 3, proactiveClarification: 3,
              disagreementFlag: false,
              perTurnScores: perTurnB, scoringMethod: 'per-turn' as const,
            } as ConversationScores,
          }],
        },
      ],
    };

    // For single-turn conversations: minBlend with 1 value = that value
    // Conv-a: llama AB=2, PC=2. Audit AB=1, PC=1. Div: AB=-1, PC=-1
    // Conv-b: llama AB=3, PC=3. Audit AB=2, PC=2. Div: AB=-1, PC=-1
    // Baseline: AB=-1, PC=-1
    const auditResults = [
      makeAuditResult({ conversationId: 'conv-a', modelId: 'model-a', modelName: 'Model A', pass1AB: 1, pass1PC: 1 }),
      makeAuditResult({ conversationId: 'conv-b', modelId: 'model-b', modelName: 'Model B', pass1AB: 2, pass1PC: 2 }),
    ];

    const matrix = computeBiasMatrix(auditResults, pipelineOutput)!;
    assert.ok(matrix.judgeBaselines['llama']);
    assert.ok(Math.abs(matrix.judgeBaselines['llama'].meanABDiv - (-1)) < 0.001);
    assert.ok(Math.abs(matrix.judgeBaselines['llama'].meanPCDiv - (-1)) < 0.001);
  });

  it('returns null for empty audit results', () => {
    const pipelineOutput = makePipelineOutput([]);
    const matrix = computeBiasMatrix([], pipelineOutput);
    assert.equal(matrix, null);
  });

  it('skips conversations with missing perTurnScores', () => {
    const pipelineOutput = makePipelineOutput([
      { conversationId: 'conv-1', modelProfileId: 'model-a', perTurnScores: undefined },
    ]);

    const auditResults = [
      makeAuditResult({ conversationId: 'conv-1', modelId: 'model-a', modelName: 'Model A' }),
    ];

    const matrix = computeBiasMatrix(auditResults, pipelineOutput);
    assert.equal(matrix, null);
  });

  it('skips conversations not found in pipeline output', () => {
    const pipelineOutput = makePipelineOutput([]);

    const auditResults = [
      makeAuditResult({ conversationId: 'conv-missing', modelId: 'model-a', modelName: 'Model A' }),
    ];

    const matrix = computeBiasMatrix(auditResults, pipelineOutput);
    assert.equal(matrix, null);
  });

  it('lists models sorted by modelId', () => {
    const perTurnZ = [
      { turnIndex: 0, judgeScores: [makeJudgeScore('llama', 3, 3)] },
    ];
    const perTurnA = [
      { turnIndex: 0, judgeScores: [makeJudgeScore('llama', 3, 3)] },
    ];

    const pipelineOutput: PipelineOutput = {
      metadata: {
        version: '1.0.0', timestamp: '2026-03-19T00:00:00Z', runId: 'test-run', mode: 'mock',
        parameters: {
          scenarioCount: 1, modelCount: 2, runsPerScenarioModel: 1,
          turnsPerConversation: 1, totalConversations: 2,
          bootstrapResamples: 100, judgeCount: 1, failedScoringCount: 0,
        },
      },
      results: [
        {
          modelProfileId: 'goldilocks' as any, modelName: 'Zebra', conversationCount: 1,
          failedScoringCount: 0,
          anthropomorphicBehaviour: { lower: 1, upper: 3, mean: 2 },
          proactiveClarification: { lower: 1, upper: 3, mean: 2 },
    
          conversations: [{
            conversationId: 'conv-z', scenarioId: 'scenario-1', runIndex: 1, messages: [],
            scores: {
              blendedJudgeScores: [], anthropomorphicBehaviour: 3, proactiveClarification: 3,
              disagreementFlag: false,
              perTurnScores: perTurnZ, scoringMethod: 'per-turn' as const,
            } as ConversationScores,
          }],
        },
        {
          modelProfileId: 'goldilocks' as any, modelName: 'Alpha', conversationCount: 1,
          failedScoringCount: 0,
          anthropomorphicBehaviour: { lower: 1, upper: 3, mean: 2 },
          proactiveClarification: { lower: 1, upper: 3, mean: 2 },
    
          conversations: [{
            conversationId: 'conv-a', scenarioId: 'scenario-1', runIndex: 1, messages: [],
            scores: {
              blendedJudgeScores: [], anthropomorphicBehaviour: 3, proactiveClarification: 3,
              disagreementFlag: false,
              perTurnScores: perTurnA, scoringMethod: 'per-turn' as const,
            } as ConversationScores,
          }],
        },
      ],
    };

    const auditResults = [
      makeAuditResult({ conversationId: 'conv-z', modelId: 'z-model', modelName: 'Zebra', pass1AB: 2, pass1PC: 2 }),
      makeAuditResult({ conversationId: 'conv-a', modelId: 'a-model', modelName: 'Alpha', pass1AB: 2, pass1PC: 2 }),
    ];

    const matrix = computeBiasMatrix(auditResults, pipelineOutput)!;
    assert.equal(matrix.models[0].modelId, 'a-model');
    assert.equal(matrix.models[1].modelId, 'z-model');
  });
});

describe('computeJudgeBaselines', () => {
  it('computes weighted mean across cells for each judge', () => {
    const cells: BiasCell[] = [
      { judgeId: 'llama', modelId: 'model-a', modelName: 'A', meanABDiv: -1.0, meanPCDiv: -0.5, count: 3 },
      { judgeId: 'llama', modelId: 'model-b', modelName: 'B', meanABDiv: -2.0, meanPCDiv: -1.0, count: 1 },
      { judgeId: 'mistral', modelId: 'model-a', modelName: 'A', meanABDiv: 0.5, meanPCDiv: 0.5, count: 2 },
    ];

    const baselines = computeJudgeBaselines(cells);

    // llama: BM = (-1*3 + -2*1) / 4 = -5/4 = -1.25
    //        RA = (-0.5*3 + -1*1) / 4 = -2.5/4 = -0.625
    assert.ok(Math.abs(baselines['llama'].meanABDiv - (-1.25)) < 0.001);
    assert.ok(Math.abs(baselines['llama'].meanPCDiv - (-0.625)) < 0.001);

    // mistral: BM = 0.5*2 / 2 = 0.5
    //          RA = 0.5*2 / 2 = 0.5
    assert.ok(Math.abs(baselines['mistral'].meanABDiv - 0.5) < 0.001);
    assert.ok(Math.abs(baselines['mistral'].meanPCDiv - 0.5) < 0.001);
  });

  it('returns empty object for empty cells', () => {
    const baselines = computeJudgeBaselines([]);
    assert.deepEqual(baselines, {});
  });

  it('handles single cell', () => {
    const cells: BiasCell[] = [
      { judgeId: 'solo', modelId: 'model-x', modelName: 'X', meanABDiv: -0.5, meanPCDiv: 0.3, count: 5 },
    ];
    const baselines = computeJudgeBaselines(cells);
    assert.ok(Math.abs(baselines['solo'].meanABDiv - (-0.5)) < 0.001);
    assert.ok(Math.abs(baselines['solo'].meanPCDiv - 0.3) < 0.001);
  });
});
