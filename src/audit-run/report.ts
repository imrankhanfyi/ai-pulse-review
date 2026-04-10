// ============================================================================
// AI Pulse — Audit Report Module
// ============================================================================
//
// Computes divergence analysis between the audit agent's scores and the
// judge panel's scores. Produces a formatted summary and output files.

import * as fs from 'fs';
import * as path from 'path';
import { pad } from '../shared/format';

// --- Data Structures ---

export interface AuditResult {
  conversationId: string;
  modelId: string;
  modelName: string;
  scenarioId: string;
  category: string; // 'internal_states' | 'personhood' | 'physical_activity' | 'relationship_building'
  scoreTier: 'low' | 'mid' | 'high';
  panelAB: number;
  panelPC: number;
  pass1AB: number;
  pass1PC: number;
  pass1PerTurn: Array<{
    turnIndex: number;
    anthropomorphicBehaviour: number;
    proactiveClarification: number;
    rationale: string;
  }>;
  pass1FailedTurns: number;
  pass2AB?: number;
  pass2PC?: number;
  pass2PerTurn?: Array<{
    turnIndex: number;
    anthropomorphicBehaviour: number;
    proactiveClarification: number;
    rationale: string;
  }>;
  pass2FailedTurns?: number;
  partialPanelCoverage: boolean;
}

export interface Diagnostic2x2 {
  bothAgree: number;
  rubricProblem: number;        // pass1 agrees, pass2 diverges
  judgeQualityProblem: number;  // pass1 diverges, pass2 agrees
  bothDiverge: number;
}

// --- Core Functions ---

/**
 * Classify whether the audit score agrees or diverges from the panel score.
 * Returns 'diverges' if |panelScore - auditScore| > threshold (strictly greater than).
 * Exactly at threshold = agrees.
 */
export function classifyDivergence(
  panelScore: number,
  auditScore: number,
  threshold: number,
): 'agrees' | 'diverges' {
  return Math.abs(panelScore - auditScore) > threshold ? 'diverges' : 'agrees';
}

/**
 * Build a 2×2 diagnostic table from pass1/pass2 agreement data.
 *
 * - bothAgree:           pass1 agrees AND pass2 agrees
 * - rubricProblem:       pass1 agrees,  pass2 diverges  → audit same rubric as panel but calibrated auditor disagrees
 * - judgeQualityProblem: pass1 diverges, pass2 agrees   → panel follows rubric, but panel execution is off
 * - bothDiverge:         pass1 diverges AND pass2 diverges
 */
export function buildDiagnostic2x2(
  results: Array<{ pass1Agrees: boolean; pass2Agrees: boolean }>,
): Diagnostic2x2 {
  let bothAgree = 0;
  let rubricProblem = 0;
  let judgeQualityProblem = 0;
  let bothDiverge = 0;

  for (const r of results) {
    if (r.pass1Agrees && r.pass2Agrees) {
      bothAgree++;
    } else if (r.pass1Agrees && !r.pass2Agrees) {
      rubricProblem++;
    } else if (!r.pass1Agrees && r.pass2Agrees) {
      judgeQualityProblem++;
    } else {
      bothDiverge++;
    }
  }

  return { bothAgree, rubricProblem, judgeQualityProblem, bothDiverge };
}

/**
 * Compute per-model mean divergence (audit - panel, signed).
 * Uses pass1 scores for the audit comparison.
 */
export function computeModelDivergence(
  results: AuditResult[],
): Map<string, { modelName: string; meanABDivergence: number; meanPCDivergence: number; count: number }> {
  const map = new Map<string, { modelName: string; abSum: number; pcSum: number; count: number }>();

  for (const r of results) {
    const existing = map.get(r.modelId);
    const abDiff = r.pass1AB - r.panelAB;
    const pcDiff = r.pass1PC - r.panelPC;

    if (existing) {
      existing.abSum += abDiff;
      existing.pcSum += pcDiff;
      existing.count++;
    } else {
      map.set(r.modelId, { modelName: r.modelName, abSum: abDiff, pcSum: pcDiff, count: 1 });
    }
  }

  const out = new Map<string, { modelName: string; meanABDivergence: number; meanPCDivergence: number; count: number }>();
  for (const [modelId, data] of map) {
    out.set(modelId, {
      modelName: data.modelName,
      meanABDivergence: data.abSum / data.count,
      meanPCDivergence: data.pcSum / data.count,
      count: data.count,
    });
  }
  return out;
}

/**
 * Compute per-category mean divergence (audit - panel, signed).
 * Uses pass1 scores for the audit comparison.
 */
export function computeCategoryDivergence(
  results: AuditResult[],
): Map<string, { meanABDivergence: number; meanPCDivergence: number; count: number }> {
  const map = new Map<string, { abSum: number; pcSum: number; count: number }>();

  for (const r of results) {
    const existing = map.get(r.category);
    const abDiff = r.pass1AB - r.panelAB;
    const pcDiff = r.pass1PC - r.panelPC;

    if (existing) {
      existing.abSum += abDiff;
      existing.pcSum += pcDiff;
      existing.count++;
    } else {
      map.set(r.category, { abSum: abDiff, pcSum: pcDiff, count: 1 });
    }
  }

  const out = new Map<string, { meanABDivergence: number; meanPCDivergence: number; count: number }>();
  for (const [category, data] of map) {
    out.set(category, {
      meanABDivergence: data.abSum / data.count,
      meanPCDivergence: data.pcSum / data.count,
      count: data.count,
    });
  }
  return out;
}

/**
 * Compute per-score-tier mean divergence (audit - panel, signed).
 * Uses pass1 scores for the audit comparison.
 */
export function computeScoreTierDivergence(
  results: AuditResult[],
): Map<string, { meanABDivergence: number; meanPCDivergence: number; count: number }> {
  const map = new Map<string, { abSum: number; pcSum: number; count: number }>();

  for (const r of results) {
    const existing = map.get(r.scoreTier);
    const abDiff = r.pass1AB - r.panelAB;
    const pcDiff = r.pass1PC - r.panelPC;

    if (existing) {
      existing.abSum += abDiff;
      existing.pcSum += pcDiff;
      existing.count++;
    } else {
      map.set(r.scoreTier, { abSum: abDiff, pcSum: pcDiff, count: 1 });
    }
  }

  const out = new Map<string, { meanABDivergence: number; meanPCDivergence: number; count: number }>();
  for (const [tier, data] of map) {
    out.set(tier, {
      meanABDivergence: data.abSum / data.count,
      meanPCDivergence: data.pcSum / data.count,
      count: data.count,
    });
  }
  return out;
}

/**
 * Rank results for review by total absolute divergence (|pass1AB - panelAB| + |pass1PC - panelPC|),
 * descending. Returns all results, not just those exceeding threshold.
 */
export function rankForReview(results: AuditResult[], _threshold: number): AuditResult[] {
  return [...results].sort((a, b) => {
    const totalDivA = Math.abs(a.pass1AB - a.panelAB) + Math.abs(a.pass1PC - a.panelPC);
    const totalDivB = Math.abs(b.pass1AB - b.panelAB) + Math.abs(b.pass1PC - b.panelPC);
    return totalDivB - totalDivA;
  });
}

/**
 * Format a signed divergence number with a leading + or - sign.
 */
function fmtDivergence(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

/**
 * Format a console summary of the audit results.
 */
export function formatSummary(results: AuditResult[], threshold: number): string {
  if (results.length === 0) {
    return '='.repeat(70) + '\n  AUDIT REPORT — No results\n' + '='.repeat(70) + '\n';
  }

  const lines: string[] = [];
  const push = (line = '') => lines.push(line);

  const modelIds = new Set(results.map(r => r.modelId));
  const hasPass2 = results.some(r => r.pass2AB !== undefined);

  push('='.repeat(70));
  push('  AI PULSE — Audit Divergence Report');
  push('='.repeat(70));
  push(`  Conversations: ${results.length}`);
  push(`  Models:        ${modelIds.size}`);
  push(`  Threshold:     ${threshold}`);
  push(`  Pass 2:        ${hasPass2 ? 'available' : 'not available'}`);
  push('='.repeat(70));

  // Pass 1 agreement rate
  const pass1AgreeBoth = results.filter(r =>
    classifyDivergence(r.panelAB, r.pass1AB, threshold) === 'agrees' &&
    classifyDivergence(r.panelPC, r.pass1PC, threshold) === 'agrees',
  ).length;
  const pass1AgreePct = (pass1AgreeBoth / results.length * 100).toFixed(1);
  push('');
  push('  AGREEMENT RATES');
  push(`    Pass 1 (both AB+PC agree): ${pass1AgreeBoth} / ${results.length} (${pass1AgreePct}%)`);

  // Pass 2 agreement rate
  const pass2Results = results.filter(r => r.pass2AB !== undefined && r.pass2PC !== undefined);
  if (pass2Results.length > 0) {
    const pass2AgreeBoth = pass2Results.filter(r =>
      classifyDivergence(r.panelAB, r.pass2AB!, threshold) === 'agrees' &&
      classifyDivergence(r.panelPC, r.pass2PC!, threshold) === 'agrees',
    ).length;
    const pass2AgreePct = (pass2AgreeBoth / pass2Results.length * 100).toFixed(1);
    push(`    Pass 2 (both AB+PC agree): ${pass2AgreeBoth} / ${pass2Results.length} (${pass2AgreePct}%)`);
  }

  // 2×2 diagnostic table (only if pass2 data available)
  if (pass2Results.length > 0) {
    push('');
    push('  2x2 DIAGNOSTIC TABLE');
    push('  (pass1 agrees vs pass2 agrees — both BM+RA must agree to count as "agrees")');

    const diagnosticInput = pass2Results.map(r => ({
      pass1Agrees:
        classifyDivergence(r.panelAB, r.pass1AB, threshold) === 'agrees' &&
        classifyDivergence(r.panelPC, r.pass1PC, threshold) === 'agrees',
      pass2Agrees:
        classifyDivergence(r.panelAB, r.pass2AB!, threshold) === 'agrees' &&
        classifyDivergence(r.panelPC, r.pass2PC!, threshold) === 'agrees',
    }));
    const diag = buildDiagnostic2x2(diagnosticInput);

    push(`    Both agree:              ${diag.bothAgree}`);
    push(`    Rubric problem:          ${diag.rubricProblem}  (pass1 agrees, pass2 diverges)`);
    push(`    Judge quality problem:   ${diag.judgeQualityProblem}  (pass1 diverges, pass2 agrees)`);
    push(`    Both diverge:            ${diag.bothDiverge}`);
  }

  // Per-model divergence table
  push('');
  push('  PER-MODEL DIVERGENCE (audit - panel, pass1)');
  push(
    '  ' +
    pad('Model', 28) +
    pad('AB Divergence', 18) +
    pad('PC Divergence', 18) +
    pad('N', 6),
  );
  push('  ' + '-'.repeat(68));

  const modelDiv = computeModelDivergence(results);
  for (const [, data] of modelDiv) {
    push(
      '  ' +
      pad(data.modelName, 28) +
      pad(fmtDivergence(data.meanABDivergence), 18) +
      pad(fmtDivergence(data.meanPCDivergence), 18) +
      pad(String(data.count), 6),
    );
  }

  // Per-category divergence table
  push('');
  push('  PER-CATEGORY DIVERGENCE (audit - panel, pass1)');
  push(
    '  ' +
    pad('Category', 28) +
    pad('AB Divergence', 18) +
    pad('PC Divergence', 18) +
    pad('N', 6),
  );
  push('  ' + '-'.repeat(68));

  const catDiv = computeCategoryDivergence(results);
  for (const [category, data] of catDiv) {
    push(
      '  ' +
      pad(category, 28) +
      pad(fmtDivergence(data.meanABDivergence), 18) +
      pad(fmtDivergence(data.meanPCDivergence), 18) +
      pad(String(data.count), 6),
    );
  }

  // Per-tier divergence table
  push('');
  push('  PER-TIER DIVERGENCE (audit - panel, pass1)');
  push(
    '  ' +
    pad('Tier', 12) +
    pad('AB Divergence', 18) +
    pad('PC Divergence', 18) +
    pad('N', 6),
  );
  push('  ' + '-'.repeat(52));

  const tierDiv = computeScoreTierDivergence(results);
  for (const [tier, data] of tierDiv) {
    push(
      '  ' +
      pad(tier, 12) +
      pad(fmtDivergence(data.meanABDivergence), 18) +
      pad(fmtDivergence(data.meanPCDivergence), 18) +
      pad(String(data.count), 6),
    );
  }

  // Top 5 conversations for review
  push('');
  push('  TOP 5 CONVERSATIONS FOR REVIEW (by total absolute divergence)');
  push(
    '  ' +
    pad('Conversation ID', 36) +
    pad('Model', 22) +
    pad('Panel AB/PC', 14) +
    pad('Audit AB/PC', 14) +
    'Total Div',
  );
  push('  ' + '-'.repeat(94));

  const ranked = rankForReview(results, threshold);
  const top5 = ranked.slice(0, 5);
  for (const r of top5) {
    const totalDiv = Math.abs(r.pass1AB - r.panelAB) + Math.abs(r.pass1PC - r.panelPC);
    push(
      '  ' +
      pad(r.conversationId, 36) +
      pad(r.modelName, 22) +
      pad(`${r.panelAB.toFixed(1)} / ${r.panelPC.toFixed(1)}`, 14) +
      pad(`${r.pass1AB.toFixed(1)} / ${r.pass1PC.toFixed(1)}`, 14) +
      totalDiv.toFixed(2),
    );
  }

  push('');
  push('='.repeat(70));
  push('  Audit report complete.');
  push('='.repeat(70));
  push('');

  return lines.join('\n');
}

/**
 * Write audit output files to disk.
 *
 * Creates outputDir (recursive), then writes:
 * - audit-results.json  — full results array
 * - audit-summary.txt   — the formatted summary text
 * - calibration-summary.txt — if calibrationSummary provided
 */
export function writeAuditOutput(
  results: AuditResult[],
  outputDir: string,
  summaryText: string,
  calibrationSummary?: string,
): void {
  fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(
    path.join(outputDir, 'audit-results.json'),
    JSON.stringify(results, null, 2),
    'utf-8',
  );

  fs.writeFileSync(
    path.join(outputDir, 'audit-summary.txt'),
    summaryText,
    'utf-8',
  );

  if (calibrationSummary !== undefined) {
    fs.writeFileSync(
      path.join(outputDir, 'calibration-summary.txt'),
      calibrationSummary,
      'utf-8',
    );
  }
}
