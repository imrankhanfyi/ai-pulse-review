// test/triage-format.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatTriageReport } from '../src/audit-analyze/format';
import { TriageReport, PatternFlag, FlaggedConversation, Dossier } from '../src/audit-analyze/types';
import { AuditResult } from '../src/audit-run/report';

function makeMinimalReport(): TriageReport {
  return {
    metadata: {
      auditDir: 'audits/test/', resultsPath: 'results.json',
      timestamp: '2026-03-19T00:00:00Z', conversationCount: 0,
      threshold: 1.0, patternThreshold: 0.5,
    },
    rankedTable: [], patternSummary: {} as any, scoreLevelAbsences: [],
    calibrationEffectiveness: null, biasMatrix: null,
    turnDivergence: { bm: [], ra: [] }, dossiers: [],
  };
}

function makeAuditResult(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    conversationId: 'conv-001',
    modelId: 'model-a',
    modelName: 'Model A',
    scenarioId: 'scenario-1',
    category: 'internal_states',
    scoreTier: 'mid',
    panelAB: 3.0,
    panelPC: 3.0,
    pass1AB: 2.5,
    pass1PC: 2.0,
    pass1PerTurn: [],
    pass1FailedTurns: 0,
    partialPanelCoverage: false,
    ...overrides,
  };
}

function makeFlaggedConversation(overrides: Partial<FlaggedConversation> = {}): FlaggedConversation {
  return {
    result: makeAuditResult(),
    flags: [],
    pass1TotalDiv: 1.5,
    pass2TotalDiv: null,
    pass1ABDiv: -0.5,
    pass1PCDiv: -1.0,
    pass2ABDiv: null,
    pass2PCDiv: null,
    ...overrides,
  };
}

function makeDossier(overrides: Partial<Dossier> = {}): Dossier {
  return {
    conversationId: 'conv-001',
    modelName: 'Model A',
    scenarioId: 'scenario-1',
    category: 'internal_states',
    flags: ['BOTH-DIVERGE'],
    messages: [
      { role: 'user', content: 'Hi there!' },
      { role: 'assistant', content: 'Hello! How can I help you?' },
    ],
    perTurnScores: [
      {
        turnIndex: 0,
        panelAB: 3.0,
        panelPC: 3.0,
        perJudge: [
          { judgeId: 'llama-judge', bm: 3.0, ra: 3.0 },
          { judgeId: 'mistral-judge', bm: 3.0, ra: 3.0 },
        ],
        pass1AB: 2.5,
        pass1PC: 2.0,
        pass1Rationale: 'Model uses affective language.',
        pass2AB: 2.75,
        pass2PC: 2.5,
        pass2Rationale: 'After calibration, slight adjustment.',
      },
    ],
    panelAB: 3.0,
    panelPC: 3.0,
    pass1AB: 2.5,
    pass1PC: 2.0,
    pass2AB: 2.75,
    pass2PC: 2.5,
    calibrationMatch: false,
    ...overrides,
  };
}

describe('formatTriageReport', () => {
  it('returns non-empty string', () => {
    const text = formatTriageReport(makeMinimalReport());
    assert.ok(text.length > 0);
  });

  it('includes expected section headers', () => {
    const text = formatTriageReport(makeMinimalReport());
    assert.ok(text.includes('PATTERN SUMMARY'));
    assert.ok(text.includes('RANKED DIVERGENCE'));
  });

  it('includes calibration section when data present', () => {
    const report = makeMinimalReport();
    report.calibrationEffectiveness = {
      meanABShift: -0.1, meanPCShift: -0.05,
      closerToPanel: 5, furtherFromPanel: 3, unchanged: 2, meanAbsChange: 0.3,
    };
    const text = formatTriageReport(report);
    assert.ok(text.includes('CALIBRATION'));
  });

  it('excludes calibration section when data is null', () => {
    const report = makeMinimalReport();
    report.calibrationEffectiveness = null;
    const text = formatTriageReport(report);
    assert.ok(!text.includes('CALIBRATION EFFECTIVENESS'));
  });

  it('handles empty/minimal report without errors', () => {
    const report = makeMinimalReport();
    // Should not throw
    const text = formatTriageReport(report);
    assert.ok(text.includes('Triage report complete.'));
  });

  it('shows all 9 pattern flags in summary with zero counts for minimal report', () => {
    const report = makeMinimalReport();
    // patternSummary is empty, should still show all 9 flags with 0
    report.patternSummary = {} as any;
    const text = formatTriageReport(report);
    assert.ok(text.includes('CALIB-HURT'));
    assert.ok(text.includes('DIRECTION-FLIP'));
    assert.ok(text.includes('RUBRIC-PROBLEM'));
    assert.ok(text.includes('JUDGE-QUALITY'));
    assert.ok(text.includes('BOTH-DIVERGE'));
    assert.ok(text.includes('LATE-COLLAPSE-DISAGREEMENT'));
    assert.ok(text.includes('DIMENSION-SPLIT'));
    assert.ok(text.includes('PANEL-INTERNAL-SPLIT'));
    assert.ok(text.includes('SCORE-LEVEL-ABSENCE'));
  });

  it('shows non-zero pattern counts', () => {
    const report = makeMinimalReport();
    report.patternSummary = {
      'CALIB-HURT': 3,
      'DIRECTION-FLIP': 1,
      'RUBRIC-PROBLEM': 0,
      'JUDGE-QUALITY': 2,
      'BOTH-DIVERGE': 5,
      'LATE-COLLAPSE-DISAGREEMENT': 0,
      'DIMENSION-SPLIT': 0,
      'PANEL-INTERNAL-SPLIT': 4,
      'SCORE-LEVEL-ABSENCE': 0,
    };
    const text = formatTriageReport(report);
    // Check that specific counts appear on the same line as their flag
    const lines = text.split('\n');
    const calibHurtLine = lines.find(l => l.includes('CALIB-HURT'));
    assert.ok(calibHurtLine?.includes('3'));
    const bothDivLine = lines.find(l => l.includes('BOTH-DIVERGE'));
    assert.ok(bothDivLine?.includes('5'));
  });

  it('includes header metadata', () => {
    const text = formatTriageReport(makeMinimalReport());
    assert.ok(text.includes('audits/test/'));
    assert.ok(text.includes('results.json'));
    assert.ok(text.includes('2026-03-19T00:00:00Z'));
  });

  it('includes bias matrix when present', () => {
    const report = makeMinimalReport();
    report.biasMatrix = {
      judges: ['llama-judge'],
      models: [{ modelId: 'model-a', modelName: 'Model A' }],
      cells: [
        { judgeId: 'llama-judge', modelId: 'model-a', modelName: 'Model A', meanABDiv: 0.3, meanPCDiv: -0.2, count: 5 },
      ],
      judgeBaselines: {
        'llama-judge': { meanABDiv: 0.15, meanPCDiv: -0.10 },
      },
    };
    const text = formatTriageReport(report);
    assert.ok(text.includes('BIAS MATRIX'));
    assert.ok(text.includes('llama-judge'));
    assert.ok(text.includes('Model A'));
  });

  it('includes per-turn divergence tables', () => {
    const report = makeMinimalReport();
    report.turnDivergence = {
      bm: [{ turnIndex: 0, meanAbsDiv: 0.5, totalAbsDiv: 5.0, count: 10 }],
      ra: [{ turnIndex: 0, meanAbsDiv: 0.3, totalAbsDiv: 3.0, count: 10 }],
    };
    const text = formatTriageReport(report);
    assert.ok(text.includes('PER-TURN DIVERGENCE'));
    assert.ok(text.includes('Anthropomorphic Behaviour'));
    assert.ok(text.includes('Proactive Clarification'));
  });

  it('shows score level absences', () => {
    const report = makeMinimalReport();
    report.scoreLevelAbsences = [
      { dimension: 'ab', level: 0, source: 'audit' },
      { dimension: 'pc', level: 3, source: 'both' },
    ];
    const text = formatTriageReport(report);
    assert.ok(text.includes('SCORE LEVEL ABSENCES'));
    assert.ok(text.includes('AB level 0'));
    assert.ok(text.includes('PC level 3'));
  });

  it('formats ranked table with flags', () => {
    const report = makeMinimalReport();
    report.rankedTable = [
      makeFlaggedConversation({
        result: makeAuditResult({ conversationId: 'conv-abc', modelName: 'TestModel' }),
        flags: ['BOTH-DIVERGE', 'DIRECTION-FLIP'],
        pass1TotalDiv: 2.5,
        pass1ABDiv: -1.0,
        pass1PCDiv: -1.5,
      }),
    ];
    const text = formatTriageReport(report);
    assert.ok(text.includes('conv-abc'));
    assert.ok(text.includes('TestModel'));
    assert.ok(text.includes('BOTH-DIVERGE'));
    assert.ok(text.includes('DIRECTION-FLIP'));
  });

  it('formats conversation dossiers', () => {
    const report = makeMinimalReport();
    report.dossiers = [makeDossier()];
    const text = formatTriageReport(report);
    assert.ok(text.includes('CONVERSATION DOSSIERS'));
    assert.ok(text.includes('conv-001'));
    assert.ok(text.includes('Hi there!'));
    assert.ok(text.includes('Hello! How can I help you?'));
    assert.ok(text.includes('Model uses affective language.'));
  });

  it('formats signed divergences correctly', () => {
    const report = makeMinimalReport();
    report.rankedTable = [
      makeFlaggedConversation({
        pass1ABDiv: 0.5,
        pass1PCDiv: -0.3,
      }),
    ];
    const text = formatTriageReport(report);
    assert.ok(text.includes('+0.50'));
    assert.ok(text.includes('-0.30'));
  });

  it('handles dossier without pass2 data', () => {
    const dossier = makeDossier({
      pass2AB: null,
      pass2PC: null,
      perTurnScores: [{
        turnIndex: 0,
        panelAB: 3.0,
        panelPC: 3.0,
        perJudge: [],
        pass1AB: 2.5,
        pass1PC: 2.0,
        pass1Rationale: 'Test rationale',
        pass2AB: null,
        pass2PC: null,
        pass2Rationale: null,
      }],
    });
    const report = makeMinimalReport();
    report.dossiers = [dossier];
    // Should not throw
    const text = formatTriageReport(report);
    assert.ok(text.includes('conv-001'));
    // Should not include "Pass 2" line for this dossier's header
    const dossierSection = text.split('CONVERSATION DOSSIERS')[1];
    // The header-level Pass 2 line should be absent
    const headerLines = dossierSection.split('\n').filter(l => l.match(/^\s+Pass 2:\s+AB/));
    assert.equal(headerLines.length, 0);
  });
});
