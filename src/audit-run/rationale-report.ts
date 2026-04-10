// ============================================================================
// AI Pulse — Rationale Consistency Report
// ============================================================================
//
// Aggregates per-pair consistency verdicts into summary statistics and
// produces both a console report and JSON output. Called by the CLI
// orchestrator after the meta-judge has evaluated all sampled pairs.

import * as fs from 'fs';
import * as path from 'path';
import { RationalePair } from './rationale-sampler';
import { ConsistencyVerdict } from './rationale-prompt';

// --- Public Types ---

export interface RationaleConsistencyResult extends RationalePair, ConsistencyVerdict {}

export interface ConsistencySummary {
  totalSampled: number;
  consistent: number;
  inconsistent: number;
  indeterminate: number;
  inconsistentByGap: { gap1: number; gap2plus: number };
  byJudge: Record<string, { total: number; inconsistent: number; indeterminate: number }>;
  byDimension: { abInconsistent: number; pcInconsistent: number };
  byCategory: Record<string, { total: number; inconsistent: number; indeterminate: number }>;
}

export interface RationaleConsistencyOutput {
  metadata: {
    resultsFile: string;
    timestamp: string;
    metaJudgeModel: string;
    sampleSize: number;
    totalPairs: number;
  };
  summary: ConsistencySummary;
  verdicts: RationaleConsistencyResult[];
}

// --- Formatting Helpers ---

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function padR(str: string, width: number): string {
  return str.padStart(width - 1) + ' ';
}

function pct(n: number, total: number): string {
  if (total === 0) return '0.0%';
  return ((n / total) * 100).toFixed(1) + '%';
}

// --- Core Aggregation ---

/**
 * Compute all summary statistics from an array of consistency results.
 */
export function aggregateVerdicts(results: RationaleConsistencyResult[]): ConsistencySummary {
  let consistent = 0;
  let inconsistent = 0;
  let indeterminate = 0;
  let gap1 = 0;
  let gap2plus = 0;
  let abInconsistent = 0;
  let pcInconsistent = 0;

  const byJudge: Record<string, { total: number; inconsistent: number; indeterminate: number }> = {};
  const byCategory: Record<string, { total: number; inconsistent: number; indeterminate: number }> = {};

  for (const r of results) {
    // Overall counts
    if (r.verdict === 'consistent') {
      consistent++;
    } else if (r.verdict === 'inconsistent') {
      inconsistent++;

      // Gap size bucketing: max(abGapSize, pcGapSize) determines bucket
      const maxGap = Math.max(r.abGapSize, r.pcGapSize);
      if (maxGap > 20) {
        gap2plus++;
      } else {
        gap1++;
      }

      // Per-dimension: only count for inconsistent verdicts
      if (!r.abConsistent) abInconsistent++;
      if (!r.pcConsistent) pcInconsistent++;
    } else {
      indeterminate++;
    }

    // Per-judge
    if (!byJudge[r.judgeId]) {
      byJudge[r.judgeId] = { total: 0, inconsistent: 0, indeterminate: 0 };
    }
    byJudge[r.judgeId].total++;
    if (r.verdict === 'inconsistent') byJudge[r.judgeId].inconsistent++;
    if (r.verdict === 'indeterminate') byJudge[r.judgeId].indeterminate++;

    // Per-category
    if (!byCategory[r.category]) {
      byCategory[r.category] = { total: 0, inconsistent: 0, indeterminate: 0 };
    }
    byCategory[r.category].total++;
    if (r.verdict === 'inconsistent') byCategory[r.category].inconsistent++;
    if (r.verdict === 'indeterminate') byCategory[r.category].indeterminate++;
  }

  return {
    totalSampled: results.length,
    consistent,
    inconsistent,
    indeterminate,
    inconsistentByGap: { gap1, gap2plus },
    byJudge,
    byDimension: { abInconsistent, pcInconsistent },
    byCategory,
  };
}

// --- Console Report ---

/**
 * Produce a human-readable console report of rationale consistency results.
 */
export function formatConsoleReport(
  summary: ConsistencySummary,
  results: RationaleConsistencyResult[],
  metadata: { resultsFile: string; metaJudgeModel: string; sampleSize: number; totalPairs: number },
): string {
  const W = 70;
  const lines: string[] = [];
  const push = (line = '') => lines.push(line);

  // Header
  push('='.repeat(W));
  push('  RATIONALE-SCORE CONSISTENCY REPORT');
  push('='.repeat(W));
  push('');
  push('  CAVEAT: Consistent means rationale supports score, NOT that score is correct.');
  push('');

  // Metadata
  push('  Results file:     ' + metadata.resultsFile);
  push('  Meta-judge model: ' + metadata.metaJudgeModel);
  push('  Sample size:      ' + metadata.sampleSize + ' / ' + metadata.totalPairs + ' pairs');
  push('');

  // Overall counts
  push('  OVERALL');
  push('  ' + '-'.repeat(W - 4));
  push('  Consistent:    ' + padR(String(summary.consistent), 6) + '  ' + pct(summary.consistent, summary.totalSampled));
  push('  Inconsistent:  ' + padR(String(summary.inconsistent), 6) + '  ' + pct(summary.inconsistent, summary.totalSampled));
  push('  Indeterminate: ' + padR(String(summary.indeterminate), 6) + '  ' + pct(summary.indeterminate, summary.totalSampled));
  push('');

  // Gap size breakdown
  push('  GAP SIZE (inconsistent only)');
  push('  ' + '-'.repeat(W - 4));
  push('  ≤20 pp gap:    ' + padR(String(summary.inconsistentByGap.gap1), 6) + '  ' + pct(summary.inconsistentByGap.gap1, summary.inconsistent));
  push('  >20 pp gap:    ' + padR(String(summary.inconsistentByGap.gap2plus), 6) + '  ' + pct(summary.inconsistentByGap.gap2plus, summary.inconsistent));
  push('');

  // Per-judge table
  const judgeNameW = 24;
  const numW = 8;
  push('  PER-JUDGE BREAKDOWN');
  push('  ' + '-'.repeat(W - 4));
  push(
    '  ' +
    pad('Judge', judgeNameW) +
    padR('Total', numW) +
    padR('Incon.', numW) +
    padR('Rate', numW) +
    padR('Indet.', numW),
  );
  push('  ' + '-'.repeat(W - 4));

  for (const [judgeId, stats] of Object.entries(summary.byJudge)) {
    push(
      '  ' +
      pad(judgeId, judgeNameW) +
      padR(String(stats.total), numW) +
      padR(String(stats.inconsistent), numW) +
      padR(pct(stats.inconsistent, stats.total), numW) +
      padR(String(stats.indeterminate), numW),
    );
  }
  push('');

  // Per-dimension counts
  push('  PER-DIMENSION (inconsistent verdicts only)');
  push('  ' + '-'.repeat(W - 4));
  push('  AB inconsistent: ' + summary.byDimension.abInconsistent);
  push('  PC inconsistent: ' + summary.byDimension.pcInconsistent);
  push('');

  // Per-category table
  push('  PER-CATEGORY BREAKDOWN');
  push('  ' + '-'.repeat(W - 4));
  push(
    '  ' +
    pad('Category', judgeNameW) +
    padR('Total', numW) +
    padR('Incon.', numW) +
    padR('Rate', numW),
  );
  push('  ' + '-'.repeat(W - 4));

  for (const [category, stats] of Object.entries(summary.byCategory)) {
    push(
      '  ' +
      pad(category, judgeNameW) +
      padR(String(stats.total), numW) +
      padR(String(stats.inconsistent), numW) +
      padR(pct(stats.inconsistent, stats.total), numW),
    );
  }
  push('');

  // Worst offenders: top 10 inconsistencies sorted by max gap size
  const inconsistencies = results
    .filter(r => r.verdict === 'inconsistent')
    .sort((a, b) => {
      const maxGapA = Math.max(a.abGapSize, a.pcGapSize);
      const maxGapB = Math.max(b.abGapSize, b.pcGapSize);
      return maxGapB - maxGapA;
    })
    .slice(0, 10);

  if (inconsistencies.length > 0) {
    push('  WORST OFFENDERS (top ' + inconsistencies.length + ' by max gap size)');
    push('  ' + '-'.repeat(W - 4));

    for (const r of inconsistencies) {
      const maxGap = Math.max(r.abGapSize, r.pcGapSize);
      push('  Conv: ' + r.conversationId + '  Turn: ' + r.turnIndex + '  Judge: ' + r.judgeId);
      push('    Given:   AB=' + r.givenAB + ' PC=' + r.givenPC);
      push('    Derived: AB=' + r.abFromRationale + ' PC=' + r.pcFromRationale);
      push('    Gap: ' + maxGap + '  Explanation: ' + r.explanation);
      push('');
    }
  }

  push('='.repeat(W));
  push('');

  return lines.join('\n');
}

// --- File Output ---

/**
 * Write rationale consistency output files to disk.
 *
 * Creates outputDir (recursive), then writes:
 * - rationale-consistency.json  — full structured output
 * - rationale-consistency-summary.txt — human-readable console report
 */
export function writeRationaleConsistencyOutput(
  results: RationaleConsistencyResult[],
  summary: ConsistencySummary,
  consoleReport: string,
  metadata: { resultsFile: string; metaJudgeModel: string; sampleSize: number; totalPairs: number },
  outputDir: string,
): void {
  fs.mkdirSync(outputDir, { recursive: true });

  const output: RationaleConsistencyOutput = {
    metadata: {
      resultsFile: metadata.resultsFile,
      timestamp: new Date().toISOString(),
      metaJudgeModel: metadata.metaJudgeModel,
      sampleSize: metadata.sampleSize,
      totalPairs: metadata.totalPairs,
    },
    summary,
    verdicts: results,
  };

  fs.writeFileSync(
    path.join(outputDir, 'rationale-consistency.json'),
    JSON.stringify(output, null, 2),
    'utf-8',
  );

  fs.writeFileSync(
    path.join(outputDir, 'rationale-consistency-summary.txt'),
    consoleReport,
    'utf-8',
  );
}
