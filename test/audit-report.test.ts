// ============================================================================
// Tests — Audit Report Module
// ============================================================================
//
// Tests divergence classification, 2×2 diagnostic table, per-model/category/tier
// divergence computation, ranked review list, summary formatting, and file output.

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AuditResult,
  classifyDivergence,
  buildDiagnostic2x2,
  computeModelDivergence,
  computeCategoryDivergence,
  computeScoreTierDivergence,
  rankForReview,
  formatSummary,
  writeAuditOutput,
} from '../src/audit-run/report';

// --- Test Helpers ---

function makeResult(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    conversationId: 'conv-001',
    modelId: 'model-a',
    modelName: 'Model A',
    scenarioId: 'SC-01',
    category: 'internal_states',
    scoreTier: 'mid',
    panelAB: 3,
    panelPC: 3,
    pass1AB: 3,
    pass1PC: 3,
    pass1PerTurn: [
      { turnIndex: 0, anthropomorphicBehaviour: 3, proactiveClarification: 3, rationale: 'ok' },
    ],
    pass1FailedTurns: 0,
    partialPanelCoverage: false,
    ...overrides,
  };
}

// --- classifyDivergence ---

describe('classifyDivergence', () => {
  it('returns agrees when difference is zero', () => {
    assert.equal(classifyDivergence(3, 3, 0.5), 'agrees');
  });

  it('returns agrees when difference is within threshold', () => {
    assert.equal(classifyDivergence(3, 3.4, 0.5), 'agrees');
    assert.equal(classifyDivergence(3, 2.6, 0.5), 'agrees');
  });

  it('returns agrees when difference is exactly at threshold', () => {
    assert.equal(classifyDivergence(3, 3.5, 0.5), 'agrees');
    assert.equal(classifyDivergence(3, 2.5, 0.5), 'agrees');
  });

  it('returns diverges when difference exceeds threshold', () => {
    assert.equal(classifyDivergence(3, 3.6, 0.5), 'diverges');
    assert.equal(classifyDivergence(3, 2.4, 0.5), 'diverges');
  });

  it('works with integer scores and threshold 0', () => {
    assert.equal(classifyDivergence(2, 2, 0), 'agrees');
    assert.equal(classifyDivergence(2, 3, 0), 'diverges');
  });

  it('handles negative divergence (panel > audit)', () => {
    assert.equal(classifyDivergence(3, 1, 0.5), 'diverges');
    assert.equal(classifyDivergence(3, 2.6, 0.5), 'agrees');
  });
});

// --- buildDiagnostic2x2 ---

describe('buildDiagnostic2x2', () => {
  it('both agree', () => {
    const input = [
      { pass1Agrees: true, pass2Agrees: true },
      { pass1Agrees: true, pass2Agrees: true },
    ];
    const diag = buildDiagnostic2x2(input);
    assert.equal(diag.bothAgree, 2);
    assert.equal(diag.rubricProblem, 0);
    assert.equal(diag.judgeQualityProblem, 0);
    assert.equal(diag.bothDiverge, 0);
  });

  it('rubric problem: pass1 agrees, pass2 diverges', () => {
    const input = [
      { pass1Agrees: true, pass2Agrees: false },
    ];
    const diag = buildDiagnostic2x2(input);
    assert.equal(diag.rubricProblem, 1);
    assert.equal(diag.bothAgree, 0);
    assert.equal(diag.judgeQualityProblem, 0);
    assert.equal(diag.bothDiverge, 0);
  });

  it('judge quality problem: pass1 diverges, pass2 agrees', () => {
    const input = [
      { pass1Agrees: false, pass2Agrees: true },
    ];
    const diag = buildDiagnostic2x2(input);
    assert.equal(diag.judgeQualityProblem, 1);
    assert.equal(diag.bothAgree, 0);
    assert.equal(diag.rubricProblem, 0);
    assert.equal(diag.bothDiverge, 0);
  });

  it('both diverge', () => {
    const input = [
      { pass1Agrees: false, pass2Agrees: false },
    ];
    const diag = buildDiagnostic2x2(input);
    assert.equal(diag.bothDiverge, 1);
    assert.equal(diag.bothAgree, 0);
    assert.equal(diag.rubricProblem, 0);
    assert.equal(diag.judgeQualityProblem, 0);
  });

  it('mixed results count correctly', () => {
    const input = [
      { pass1Agrees: true, pass2Agrees: true },   // bothAgree
      { pass1Agrees: true, pass2Agrees: false },  // rubricProblem
      { pass1Agrees: false, pass2Agrees: true },  // judgeQualityProblem
      { pass1Agrees: false, pass2Agrees: false }, // bothDiverge
      { pass1Agrees: true, pass2Agrees: true },   // bothAgree
    ];
    const diag = buildDiagnostic2x2(input);
    assert.equal(diag.bothAgree, 2);
    assert.equal(diag.rubricProblem, 1);
    assert.equal(diag.judgeQualityProblem, 1);
    assert.equal(diag.bothDiverge, 1);
  });

  it('returns all zeros for empty input', () => {
    const diag = buildDiagnostic2x2([]);
    assert.equal(diag.bothAgree, 0);
    assert.equal(diag.rubricProblem, 0);
    assert.equal(diag.judgeQualityProblem, 0);
    assert.equal(diag.bothDiverge, 0);
  });
});

// --- computeModelDivergence ---

describe('computeModelDivergence', () => {
  it('returns per-model mean divergence with correct signs', () => {
    const results = [
      makeResult({ modelId: 'a', modelName: 'Model A', panelAB: 2, panelPC: 2, pass1AB: 3, pass1PC: 1 }),
      makeResult({ modelId: 'a', modelName: 'Model A', panelAB: 2, panelPC: 2, pass1AB: 1, pass1PC: 3 }),
    ];
    const div = computeModelDivergence(results);
    const a = div.get('a')!;
    assert.ok(a, 'model a should be present');
    // BM: (3-2) + (1-2) = 1 + (-1) = 0 → mean = 0
    assert.equal(a.meanABDivergence, 0);
    // RA: (1-2) + (3-2) = (-1) + 1 = 0 → mean = 0
    assert.equal(a.meanPCDivergence, 0);
    assert.equal(a.count, 2);
    assert.equal(a.modelName, 'Model A');
  });

  it('positive divergence when audit scores higher than panel', () => {
    const results = [
      makeResult({ modelId: 'b', modelName: 'Model B', panelAB: 1, panelPC: 1, pass1AB: 3, pass1PC: 3 }),
    ];
    const div = computeModelDivergence(results);
    const b = div.get('b')!;
    assert.equal(b.meanABDivergence, 2);
    assert.equal(b.meanPCDivergence, 2);
  });

  it('negative divergence when audit scores lower than panel', () => {
    const results = [
      makeResult({ modelId: 'c', modelName: 'Model C', panelAB: 3, panelPC: 3, pass1AB: 1, pass1PC: 1 }),
    ];
    const div = computeModelDivergence(results);
    const c = div.get('c')!;
    assert.equal(c.meanABDivergence, -2);
    assert.equal(c.meanPCDivergence, -2);
  });

  it('groups multiple models correctly', () => {
    const results = [
      makeResult({ modelId: 'x', modelName: 'X', panelAB: 2, panelPC: 2, pass1AB: 3, pass1PC: 2 }),
      makeResult({ modelId: 'y', modelName: 'Y', panelAB: 2, panelPC: 2, pass1AB: 1, pass1PC: 2 }),
    ];
    const div = computeModelDivergence(results);
    assert.equal(div.size, 2);
    assert.equal(div.get('x')!.meanABDivergence, 1);
    assert.equal(div.get('y')!.meanABDivergence, -1);
  });

  it('returns empty map for empty results', () => {
    const div = computeModelDivergence([]);
    assert.equal(div.size, 0);
  });
});

// --- computeCategoryDivergence ---

describe('computeCategoryDivergence', () => {
  it('groups by category correctly', () => {
    const results = [
      makeResult({ category: 'internal_states', panelAB: 2, panelPC: 2, pass1AB: 3, pass1PC: 2 }),
      makeResult({ category: 'internal_states', panelAB: 2, panelPC: 2, pass1AB: 1, pass1PC: 2 }),
      makeResult({ category: 'personhood', panelAB: 1, panelPC: 2, pass1AB: 3, pass1PC: 2 }),
    ];
    const div = computeCategoryDivergence(results);

    const is = div.get('internal_states')!;
    assert.ok(is);
    // BM: (3-2)+(1-2) = 0 → mean 0
    assert.equal(is.meanABDivergence, 0);
    assert.equal(is.count, 2);

    const p = div.get('personhood')!;
    assert.ok(p);
    // BM: 3-1 = 2
    assert.equal(p.meanABDivergence, 2);
    assert.equal(p.count, 1);
  });

  it('returns empty map for empty results', () => {
    const div = computeCategoryDivergence([]);
    assert.equal(div.size, 0);
  });
});

// --- computeScoreTierDivergence ---

describe('computeScoreTierDivergence', () => {
  it('groups by score tier correctly', () => {
    const results = [
      makeResult({ scoreTier: 'low', panelAB: 0, panelPC: 0, pass1AB: 1, pass1PC: 1 }),
      makeResult({ scoreTier: 'low', panelAB: 1, panelPC: 1, pass1AB: 1, pass1PC: 1 }),
      makeResult({ scoreTier: 'high', panelAB: 3, panelPC: 3, pass1AB: 2, pass1PC: 2 }),
    ];
    const div = computeScoreTierDivergence(results);

    const low = div.get('low')!;
    assert.ok(low);
    // BM: (1-0)+(1-1) = 1 → mean 0.5
    assert.equal(low.meanABDivergence, 0.5);
    assert.equal(low.count, 2);

    const high = div.get('high')!;
    assert.ok(high);
    // BM: 2-3 = -1
    assert.equal(high.meanABDivergence, -1);
    assert.equal(high.count, 1);
  });

  it('handles all three tiers', () => {
    const results = [
      makeResult({ scoreTier: 'low' }),
      makeResult({ scoreTier: 'mid' }),
      makeResult({ scoreTier: 'high' }),
    ];
    const div = computeScoreTierDivergence(results);
    assert.equal(div.size, 3);
  });

  it('returns empty map for empty results', () => {
    const div = computeScoreTierDivergence([]);
    assert.equal(div.size, 0);
  });
});

// --- rankForReview ---

describe('rankForReview', () => {
  it('orders by total absolute divergence descending', () => {
    const results = [
      makeResult({ conversationId: 'low', panelAB: 3, panelPC: 3, pass1AB: 3, pass1PC: 3 }),   // div = 0
      makeResult({ conversationId: 'high', panelAB: 3, panelPC: 3, pass1AB: 0, pass1PC: 0 }),  // div = 6
      makeResult({ conversationId: 'mid', panelAB: 3, panelPC: 3, pass1AB: 2, pass1PC: 3 }),   // div = 1
    ];
    const ranked = rankForReview(results, 0.5);
    assert.equal(ranked[0].conversationId, 'high');
    assert.equal(ranked[1].conversationId, 'mid');
    assert.equal(ranked[2].conversationId, 'low');
  });

  it('includes all results, not just those exceeding threshold', () => {
    const results = [
      makeResult({ conversationId: 'a', panelAB: 3, panelPC: 3, pass1AB: 3, pass1PC: 3 }),
      makeResult({ conversationId: 'b', panelAB: 3, panelPC: 3, pass1AB: 3, pass1PC: 3 }),
    ];
    const ranked = rankForReview(results, 0.5);
    assert.equal(ranked.length, 2);
  });

  it('does not mutate the original array', () => {
    const results = [
      makeResult({ conversationId: 'a', panelAB: 0, panelPC: 0, pass1AB: 3, pass1PC: 3 }),
      makeResult({ conversationId: 'b', panelAB: 3, panelPC: 3, pass1AB: 3, pass1PC: 3 }),
    ];
    const original = [...results];
    rankForReview(results, 0.5);
    assert.equal(results[0].conversationId, original[0].conversationId);
  });

  it('handles empty input', () => {
    const ranked = rankForReview([], 0.5);
    assert.equal(ranked.length, 0);
  });

  it('handles ties in divergence (order stable is not required, but all included)', () => {
    const results = [
      makeResult({ conversationId: 'a', panelAB: 2, panelPC: 2, pass1AB: 3, pass1PC: 3 }),
      makeResult({ conversationId: 'b', panelAB: 2, panelPC: 2, pass1AB: 3, pass1PC: 3 }),
    ];
    const ranked = rankForReview(results, 0.5);
    assert.equal(ranked.length, 2);
    const ids = ranked.map(r => r.conversationId);
    assert.ok(ids.includes('a'));
    assert.ok(ids.includes('b'));
  });
});

// --- formatSummary ---

describe('formatSummary', () => {
  const sampleResults: AuditResult[] = [
    makeResult({
      conversationId: 'conv-001',
      modelId: 'model-a',
      modelName: 'Model A',
      category: 'internal_states',
      scoreTier: 'mid',
      panelAB: 3,
      panelPC: 3,
      pass1AB: 3,
      pass1PC: 3,
    }),
    makeResult({
      conversationId: 'conv-002',
      modelId: 'model-b',
      modelName: 'Model B',
      category: 'personhood',
      scoreTier: 'high',
      panelAB: 3,
      panelPC: 3,
      pass1AB: 2,
      pass1PC: 2,
    }),
  ];

  it('returns a non-empty string', () => {
    const summary = formatSummary(sampleResults, 0.5);
    assert.ok(summary.length > 0);
    assert.ok(typeof summary === 'string');
  });

  it('includes a header with run stats', () => {
    const summary = formatSummary(sampleResults, 0.5);
    assert.ok(summary.toLowerCase().includes('audit'));
    assert.ok(summary.includes('Conversations:'));
    assert.ok(summary.includes('Models:'));
    assert.ok(summary.includes('Threshold:'));
  });

  it('includes Pass 1 agreement rate', () => {
    const summary = formatSummary(sampleResults, 0.5);
    assert.ok(summary.includes('Pass 1'));
    assert.ok(summary.includes('%'));
  });

  it('includes per-model divergence table', () => {
    const summary = formatSummary(sampleResults, 0.5);
    assert.ok(summary.includes('PER-MODEL'));
    assert.ok(summary.includes('Model A'));
    assert.ok(summary.includes('Model B'));
  });

  it('includes per-category divergence table', () => {
    const summary = formatSummary(sampleResults, 0.5);
    assert.ok(summary.includes('PER-CATEGORY') || summary.includes('CATEGORY'));
    assert.ok(summary.includes('internal_states'));
    assert.ok(summary.includes('personhood'));
  });

  it('includes per-tier divergence table', () => {
    const summary = formatSummary(sampleResults, 0.5);
    assert.ok(summary.includes('TIER') || summary.includes('tier'));
    assert.ok(summary.includes('mid') || summary.includes('high'));
  });

  it('includes top 5 conversations for review', () => {
    const summary = formatSummary(sampleResults, 0.5);
    assert.ok(summary.includes('TOP 5') || summary.includes('REVIEW') || summary.includes('conv-'));
  });

  it('includes Pass 2 agreement rate when pass2 data available', () => {
    const resultsWithPass2 = sampleResults.map(r => ({
      ...r,
      pass2AB: r.pass1AB,
      pass2PC: r.pass1PC,
      pass2PerTurn: r.pass1PerTurn,
      pass2FailedTurns: 0,
    }));
    const summary = formatSummary(resultsWithPass2, 0.5);
    assert.ok(summary.includes('Pass 2'));
  });

  it('includes 2x2 diagnostic table when pass2 data available', () => {
    const resultsWithPass2 = sampleResults.map(r => ({
      ...r,
      pass2AB: r.pass1AB,
      pass2PC: r.pass1PC,
      pass2PerTurn: r.pass1PerTurn,
      pass2FailedTurns: 0,
    }));
    const summary = formatSummary(resultsWithPass2, 0.5);
    assert.ok(summary.includes('2x2') || summary.includes('DIAGNOSTIC'));
  });

  it('returns a fallback string for empty results', () => {
    const summary = formatSummary([], 0.5);
    assert.ok(summary.length > 0);
  });
});

// --- writeAuditOutput ---

describe('writeAuditOutput', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-report-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates output directory and writes audit-results.json', () => {
    const outputDir = path.join(tmpDir, 'run-1');
    const results = [makeResult()];
    const summary = 'test summary';

    writeAuditOutput(results, outputDir, summary);

    assert.ok(fs.existsSync(outputDir));
    const jsonPath = path.join(outputDir, 'audit-results.json');
    assert.ok(fs.existsSync(jsonPath));
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].conversationId, 'conv-001');
  });

  it('writes audit-summary.txt', () => {
    const outputDir = path.join(tmpDir, 'run-2');
    const summary = 'This is the audit summary.';

    writeAuditOutput([], outputDir, summary);

    const txtPath = path.join(outputDir, 'audit-summary.txt');
    assert.ok(fs.existsSync(txtPath));
    assert.equal(fs.readFileSync(txtPath, 'utf-8'), summary);
  });

  it('writes calibration-summary.txt when provided', () => {
    const outputDir = path.join(tmpDir, 'run-3');
    const calibSummary = 'Calibration notes here.';

    writeAuditOutput([], outputDir, 'summary', calibSummary);

    const calibPath = path.join(outputDir, 'calibration-summary.txt');
    assert.ok(fs.existsSync(calibPath));
    assert.equal(fs.readFileSync(calibPath, 'utf-8'), calibSummary);
  });

  it('does not write calibration-summary.txt when not provided', () => {
    const outputDir = path.join(tmpDir, 'run-4');

    writeAuditOutput([], outputDir, 'summary');

    const calibPath = path.join(outputDir, 'calibration-summary.txt');
    assert.equal(fs.existsSync(calibPath), false);
  });

  it('creates nested output directory recursively', () => {
    const outputDir = path.join(tmpDir, 'deep', 'nested', 'run-5');

    writeAuditOutput([], outputDir, 'summary');

    assert.ok(fs.existsSync(outputDir));
  });
});
