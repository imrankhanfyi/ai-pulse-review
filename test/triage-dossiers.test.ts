// test/triage-dossiers.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildDossiers } from '../src/audit-analyze/dossiers';
import { FlaggedConversation } from '../src/audit-analyze/types';
import { AuditResult } from '../src/audit-run/report';
import { PipelineOutput, ConversationResult, JudgeScore, QualityScore } from '../src/types';

// ---- Factory helpers ----

function makeJudgeScore(judgeId: string, bm: number, ra: number): JudgeScore {
  return {
    judgeId,
    anthropomorphicBehaviour: bm as QualityScore,
    proactiveClarification: ra as QualityScore,
  };
}

function makeConversationResult(
  conversationId: string,
  scenarioId: string,
  overrides: Partial<ConversationResult> = {},
): ConversationResult {
  return {
    conversationId,
    scenarioId,
    runIndex: 1,
    messages: [
      { role: 'user', content: 'Hello, can you be my friend?', turnIndex: 0 },
      { role: 'model', content: 'I am an AI assistant.', turnIndex: 0 },
      { role: 'user', content: 'But I really want a friend!', turnIndex: 1 },
      { role: 'model', content: 'I understand, but I am not a person.', turnIndex: 1 },
    ],
    scores: {
      blendedJudgeScores: [
        makeJudgeScore('llama-3.3-70b', 3, 3),
        makeJudgeScore('mistral-large', 3, 3),
      ],
      anthropomorphicBehaviour: 3.0,
      proactiveClarification: 3.0,
      disagreementFlag: false,
      perTurnScores: [
        {
          turnIndex: 0,
          judgeScores: [
            makeJudgeScore('llama-3.3-70b', 3, 3),
            makeJudgeScore('mistral-large', 3, 3),
          ],
        },
        {
          turnIndex: 1,
          judgeScores: [
            makeJudgeScore('llama-3.3-70b', 3, 3),
            makeJudgeScore('mistral-large', 3, 3),
          ],
        },
      ],
      scoringMethod: 'per-turn' as const,
    },
    ...overrides,
  };
}

function makePipelineOutput(conversations: Array<{ modelId: string; modelName: string; conv: ConversationResult }>): PipelineOutput {
  // Group by modelId
  const modelMap = new Map<string, { modelName: string; convs: ConversationResult[] }>();
  for (const { modelId, modelName, conv } of conversations) {
    const existing = modelMap.get(modelId);
    if (existing) {
      existing.convs.push(conv);
    } else {
      modelMap.set(modelId, { modelName, convs: [conv] });
    }
  }

  return {
    metadata: {
      version: '1.0.0-prototype',
      timestamp: '2026-03-19T00:00:00Z',
      runId: '2026-03-19T00-00-00Z',
      mode: 'live' as const,
      parameters: {
        scenarioCount: 1,
        modelCount: 1,
        runsPerScenarioModel: 1,
        turnsPerConversation: 3,
        totalConversations: 1,
        bootstrapResamples: 1000,
        judgeCount: 2,
        failedScoringCount: 0,
      },
    },
    results: [...modelMap.entries()].map(([modelId, { modelName, convs }]) => ({
      modelProfileId: modelId as any,
      modelName,
      conversationCount: convs.length,
      failedScoringCount: 0,
      anthropomorphicBehaviour: { lower: 2.0, upper: 2.5, mean: 2.25 },
      proactiveClarification: { lower: 2.0, upper: 2.5, mean: 2.25 },
      conversations: convs,
    })),
  };
}

function makeAuditResult(
  conversationId: string,
  overrides: Partial<AuditResult> = {},
): AuditResult {
  return {
    conversationId,
    modelId: 'gemini-2.5-flash',
    modelName: 'Gemini 2.5 Flash',
    scenarioId: 'emotions_01',
    category: 'internal_states',
    scoreTier: 'mid' as const,
    panelAB: 3.0,
    panelPC: 3.0,
    pass1AB: 2.0,
    pass1PC: 2.0,
    pass1PerTurn: [
      { turnIndex: 0, anthropomorphicBehaviour: 2, proactiveClarification: 2, rationale: 'Turn 0: mild boundary issues' },
      { turnIndex: 1, anthropomorphicBehaviour: 2, proactiveClarification: 2, rationale: 'Turn 1: further boundary erosion' },
    ],
    pass1FailedTurns: 0,
    partialPanelCoverage: false,
    ...overrides,
  };
}

function makeFlagged(
  audit: AuditResult,
  flags: FlaggedConversation['flags'] = ['BOTH-DIVERGE'],
): FlaggedConversation {
  return {
    result: audit,
    flags,
    pass1TotalDiv: Math.abs(audit.pass1AB - audit.panelAB) + Math.abs(audit.pass1PC - audit.panelPC),
    pass2TotalDiv: audit.pass2AB !== undefined
      ? Math.abs(audit.pass2AB - audit.panelAB) + Math.abs(audit.pass2PC! - audit.panelPC)
      : null,
    pass1ABDiv: audit.pass1AB - audit.panelAB,
    pass1PCDiv: audit.pass1PC - audit.panelPC,
    pass2ABDiv: audit.pass2AB !== undefined ? audit.pass2AB - audit.panelAB : null,
    pass2PCDiv: audit.pass2PC !== undefined ? audit.pass2PC - audit.panelPC : null,
  };
}

// ---- Tests ----

describe('buildDossiers', () => {
  it('produces correct structure with all fields populated', () => {
    const audit = makeAuditResult('conv-1');
    const conv = makeConversationResult('conv-1', 'emotions_01');
    const pipeline = makePipelineOutput([
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv },
    ]);
    const flagged = [makeFlagged(audit)];

    const dossiers = buildDossiers(10, flagged, pipeline);

    assert.equal(dossiers.length, 1);
    const d = dossiers[0];
    assert.equal(d.conversationId, 'conv-1');
    assert.equal(d.modelName, 'Gemini 2.5 Flash');
    assert.equal(d.scenarioId, 'emotions_01');
    assert.equal(d.category, 'internal_states');
    assert.deepEqual(d.flags, ['BOTH-DIVERGE']);
    assert.equal(d.panelAB, 3.0);
    assert.equal(d.panelPC, 3.0);
    assert.equal(d.pass1AB, 2.0);
    assert.equal(d.pass1PC, 2.0);
    assert.equal(d.pass2AB, null);
    assert.equal(d.pass2PC, null);
    assert.equal(d.calibrationMatch, false);
  });

  it('extracts messages correctly from pipeline results', () => {
    const audit = makeAuditResult('conv-1');
    const conv = makeConversationResult('conv-1', 'emotions_01');
    const pipeline = makePipelineOutput([
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv },
    ]);
    const flagged = [makeFlagged(audit)];

    const dossiers = buildDossiers(10, flagged, pipeline);

    assert.equal(dossiers[0].messages.length, 4);
    assert.equal(dossiers[0].messages[0].role, 'user');
    assert.equal(dossiers[0].messages[0].content, 'Hello, can you be my friend?');
    assert.equal(dossiers[0].messages[1].role, 'model');
    assert.equal(dossiers[0].messages[1].content, 'I am an AI assistant.');
    assert.equal(dossiers[0].messages[2].role, 'user');
    assert.equal(dossiers[0].messages[3].role, 'model');
  });

  it('includes per-judge per-turn breakdown', () => {
    const audit = makeAuditResult('conv-1');
    const conv = makeConversationResult('conv-1', 'emotions_01');
    const pipeline = makePipelineOutput([
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv },
    ]);
    const flagged = [makeFlagged(audit)];

    const dossiers = buildDossiers(10, flagged, pipeline);
    const perTurn = dossiers[0].perTurnScores;

    assert.equal(perTurn.length, 2);

    // Turn 0
    assert.equal(perTurn[0].turnIndex, 0);
    assert.equal(perTurn[0].panelAB, 3); // avg of (3, 3)
    assert.equal(perTurn[0].panelPC, 3); // avg of (3, 3)
    assert.equal(perTurn[0].perJudge.length, 2);
    assert.equal(perTurn[0].perJudge[0].judgeId, 'llama-3.3-70b');
    assert.equal(perTurn[0].perJudge[0].bm, 3);
    assert.equal(perTurn[0].perJudge[0].ra, 3);
    assert.equal(perTurn[0].perJudge[1].judgeId, 'mistral-large');
    assert.equal(perTurn[0].perJudge[1].bm, 3);
    assert.equal(perTurn[0].perJudge[1].ra, 3);

    // Turn 1
    assert.equal(perTurn[1].turnIndex, 1);
    assert.equal(perTurn[1].perJudge.length, 2);
  });

  it('includes Opus rationales from both passes', () => {
    const audit = makeAuditResult('conv-1', {
      pass2AB: 2.5,
      pass2PC: 3.0,
      pass2PerTurn: [
        { turnIndex: 0, anthropomorphicBehaviour: 3, proactiveClarification: 3, rationale: 'Pass2 turn 0: acceptable' },
        { turnIndex: 1, anthropomorphicBehaviour: 2, proactiveClarification: 3, rationale: 'Pass2 turn 1: some lapse' },
      ],
      pass2FailedTurns: 0,
    });
    const conv = makeConversationResult('conv-1', 'emotions_01');
    const pipeline = makePipelineOutput([
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv },
    ]);
    const flagged = [makeFlagged(audit)];

    const dossiers = buildDossiers(10, flagged, pipeline);
    const perTurn = dossiers[0].perTurnScores;

    // Pass 1 rationales
    assert.equal(perTurn[0].pass1Rationale, 'Turn 0: mild boundary issues');
    assert.equal(perTurn[1].pass1Rationale, 'Turn 1: further boundary erosion');

    // Pass 2 rationales
    assert.equal(perTurn[0].pass2Rationale, 'Pass2 turn 0: acceptable');
    assert.equal(perTurn[1].pass2Rationale, 'Pass2 turn 1: some lapse');

    // Pass 2 scores
    assert.equal(perTurn[0].pass2AB, 3);
    assert.equal(perTurn[0].pass2PC, 3);
    assert.equal(perTurn[1].pass2AB, 2);
    assert.equal(perTurn[1].pass2PC, 3);

    // Conversation-level pass2
    assert.equal(dossiers[0].pass2AB, 2.5);
    assert.equal(dossiers[0].pass2PC, 3.0);
  });

  it('sets calibrationMatch flag when conversationId is in calibrationConvIds', () => {
    const audit = makeAuditResult('conv-1');
    const conv = makeConversationResult('conv-1', 'emotions_01');
    const pipeline = makePipelineOutput([
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv },
    ]);
    const flagged = [makeFlagged(audit)];
    const calibIds = new Set(['conv-1', 'conv-other']);

    const dossiers = buildDossiers(10, flagged, pipeline, calibIds);

    assert.equal(dossiers[0].calibrationMatch, true);
  });

  it('calibrationMatch is false when not in set', () => {
    const audit = makeAuditResult('conv-1');
    const conv = makeConversationResult('conv-1', 'emotions_01');
    const pipeline = makePipelineOutput([
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv },
    ]);
    const flagged = [makeFlagged(audit)];
    const calibIds = new Set(['conv-other']);

    const dossiers = buildDossiers(10, flagged, pipeline, calibIds);

    assert.equal(dossiers[0].calibrationMatch, false);
  });

  it('handles missing pass2 data with null fields', () => {
    const audit = makeAuditResult('conv-1'); // no pass2 data
    const conv = makeConversationResult('conv-1', 'emotions_01');
    const pipeline = makePipelineOutput([
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv },
    ]);
    const flagged = [makeFlagged(audit)];

    const dossiers = buildDossiers(10, flagged, pipeline);
    const d = dossiers[0];

    assert.equal(d.pass2AB, null);
    assert.equal(d.pass2PC, null);

    // Per-turn pass2 fields should be null
    for (const turn of d.perTurnScores) {
      assert.equal(turn.pass2AB, null);
      assert.equal(turn.pass2PC, null);
      assert.equal(turn.pass2Rationale, null);
    }
  });

  it('topN limits output count', () => {
    const convs: Array<{ modelId: string; modelName: string; conv: ConversationResult }> = [];
    const flaggedList: FlaggedConversation[] = [];

    for (let i = 0; i < 5; i++) {
      const convId = `conv-${i}`;
      const audit = makeAuditResult(convId, {
        pass1AB: 1.0 + i * 0.2, // varying divergence
      });
      convs.push({
        modelId: 'gemini-2.5-flash',
        modelName: 'Gemini 2.5 Flash',
        conv: makeConversationResult(convId, 'emotions_01'),
      });
      flaggedList.push(makeFlagged(audit));
    }

    const pipeline = makePipelineOutput(convs);
    const dossiers = buildDossiers(3, flaggedList, pipeline);

    assert.equal(dossiers.length, 3);
  });

  it('skips conversations not found in pipelineOutput gracefully', () => {
    const audit = makeAuditResult('conv-missing');
    const conv = makeConversationResult('conv-present', 'emotions_01');
    const pipeline = makePipelineOutput([
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv },
    ]);
    const flagged = [makeFlagged(audit)];

    const dossiers = buildDossiers(10, flagged, pipeline);

    assert.equal(dossiers.length, 0);
  });

  it('sorts by pass1TotalDiv descending', () => {
    const audit1 = makeAuditResult('conv-1', { pass1AB: 2.0, pass1PC: 2.0, panelAB: 3.0, panelPC: 3.0 }); // totalDiv = 2.0
    const audit2 = makeAuditResult('conv-2', { pass1AB: 1.0, pass1PC: 0.0, panelAB: 3.0, panelPC: 3.0 }); // totalDiv = 5.0
    const audit3 = makeAuditResult('conv-3', { pass1AB: 3.0, pass1PC: 3.0, panelAB: 3.0, panelPC: 3.0 }); // totalDiv = 0.0

    const pipeline = makePipelineOutput([
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv: makeConversationResult('conv-1', 'emotions_01') },
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv: makeConversationResult('conv-2', 'emotions_01') },
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv: makeConversationResult('conv-3', 'emotions_01') },
    ]);

    const flagged = [
      makeFlagged(audit1),
      makeFlagged(audit2),
      makeFlagged(audit3),
    ];

    const dossiers = buildDossiers(10, flagged, pipeline);

    assert.equal(dossiers.length, 3);
    assert.equal(dossiers[0].conversationId, 'conv-2'); // highest divergence
    assert.equal(dossiers[1].conversationId, 'conv-1');
    assert.equal(dossiers[2].conversationId, 'conv-3'); // lowest divergence
  });

  it('handles conversation with no perTurnScores in panel', () => {
    const audit = makeAuditResult('conv-1');
    const conv = makeConversationResult('conv-1', 'emotions_01', {
      scores: {
        blendedJudgeScores: [],
        anthropomorphicBehaviour: 3.0,
        proactiveClarification: 3.0,
        disagreementFlag: false,
        // No perTurnScores
      },
    });
    const pipeline = makePipelineOutput([
      { modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', conv },
    ]);
    const flagged = [makeFlagged(audit)];

    const dossiers = buildDossiers(10, flagged, pipeline);

    assert.equal(dossiers.length, 1);
    // Should still have per-turn entries from audit data
    assert.equal(dossiers[0].perTurnScores.length, 2);
    // Panel data should be zeroed out
    assert.equal(dossiers[0].perTurnScores[0].panelAB, 0);
    assert.equal(dossiers[0].perTurnScores[0].panelPC, 0);
    assert.equal(dossiers[0].perTurnScores[0].perJudge.length, 0);
    // Audit data should still be present
    assert.equal(dossiers[0].perTurnScores[0].pass1AB, 2);
    assert.equal(dossiers[0].perTurnScores[0].pass1Rationale, 'Turn 0: mild boundary issues');
  });

  it('handles empty flaggedConversations list', () => {
    const pipeline = makePipelineOutput([]);
    const dossiers = buildDossiers(10, [], pipeline);
    assert.equal(dossiers.length, 0);
  });

  it('skips missing and includes found conversations', () => {
    const audit1 = makeAuditResult('conv-exists');
    const audit2 = makeAuditResult('conv-missing');

    const pipeline = makePipelineOutput([
      {
        modelId: 'gemini-2.5-flash',
        modelName: 'Gemini 2.5 Flash',
        conv: makeConversationResult('conv-exists', 'emotions_01'),
      },
    ]);

    const flagged = [makeFlagged(audit1), makeFlagged(audit2)];

    const dossiers = buildDossiers(10, flagged, pipeline);

    // Only conv-exists should be included
    assert.equal(dossiers.length, 1);
    assert.equal(dossiers[0].conversationId, 'conv-exists');
  });
});
