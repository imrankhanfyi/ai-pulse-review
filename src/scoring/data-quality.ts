// ============================================================================
// AI Pulse — Post-Run Data Quality Report
// ============================================================================
//
// Prints a per-model summary after pipeline scoring completes, making data
// quality anomalies (truncation, empty responses, outlier response lengths)
// immediately visible. Added after Pulse 22 discovered that 100% of Gemini
// Pro responses were silently truncated, yet the pipeline reported success.

import { ModelResults } from '../types';
import { pad } from '../shared/format';

interface ModelStats {
  modelName: string;
  totalConversations: number;
  totalModelTurns: number;
  responseLengths: number[];
  meanResponseLength: number;
  minResponseLength: number;
  maxResponseLength: number;
  truncationCount: number;
  emptyCount: number;
  errorCount: number;
  scoredCount: number;
  belowQuorumCount: number;
  judgeErrorCount: number;
}

/**
 * Collect per-model statistics from pipeline results.
 */
function collectModelStats(results: ModelResults[]): ModelStats[] {
  return results.map(model => {
    const responseLengths: number[] = [];
    let truncationCount = 0;
    let emptyCount = 0;
    let errorCount = 0;
    let scoredCount = 0;
    let belowQuorumCount = 0;
    let judgeErrorCount = 0;
    let totalModelTurns = 0;

    for (const conv of model.conversations) {
      // Count scoring issues
      if (conv.scores.scoringFailed) {
        // not counted in scoredCount
      } else {
        scoredCount++;
      }
      if (conv.scores.belowQuorum) {
        belowQuorumCount++;
      }
      if (conv.scores.judgeErrors) {
        judgeErrorCount += conv.scores.judgeErrors.length;
      }

      // Examine model messages
      for (const msg of conv.messages) {
        if (msg.role !== 'model') continue;
        totalModelTurns++;

        // Error responses
        if (msg.isError) {
          errorCount++;
          continue;
        }

        const len = msg.content.length;
        responseLengths.push(len);

        // Truncation check
        if (msg.apiMetadata) {
          const fr = msg.apiMetadata.finishReason;
          if (fr === 'length' || fr === 'MAX_TOKENS') {
            truncationCount++;
          }
        }

        // Empty/near-empty check
        if (len < 20) {
          emptyCount++;
        }
      }
    }

    const meanResponseLength = responseLengths.length > 0
      ? responseLengths.reduce((a, b) => a + b, 0) / responseLengths.length
      : 0;
    const minResponseLength = responseLengths.length > 0
      ? Math.min(...responseLengths)
      : 0;
    const maxResponseLength = responseLengths.length > 0
      ? Math.max(...responseLengths)
      : 0;

    return {
      modelName: model.modelName,
      totalConversations: model.conversations.length,
      totalModelTurns,
      responseLengths,
      meanResponseLength,
      minResponseLength,
      maxResponseLength,
      truncationCount,
      emptyCount,
      errorCount,
      scoredCount,
      belowQuorumCount,
      judgeErrorCount,
    };
  });
}

/**
 * Collect warnings from model stats.
 */
function collectWarnings(allStats: ModelStats[]): string[] {
  const warnings: string[] = [];

  // Cross-model average response length
  const allLengths = allStats.flatMap(s => s.responseLengths);
  const crossModelMean = allLengths.length > 0
    ? allLengths.reduce((a, b) => a + b, 0) / allLengths.length
    : 0;
  const halfCrossModelMean = crossModelMean * 0.5;

  for (const stats of allStats) {
    if (stats.truncationCount > 0) {
      warnings.push(
        `${stats.modelName}: ${stats.truncationCount} truncated response(s) ` +
        `(${((stats.truncationCount / stats.totalModelTurns) * 100).toFixed(0)}% of turns)`
      );
    }
    if (stats.emptyCount > 0) {
      warnings.push(
        `${stats.modelName}: ${stats.emptyCount} empty/near-empty response(s) (<20 chars)`
      );
    }
    if (crossModelMean > 0 && stats.meanResponseLength < halfCrossModelMean) {
      warnings.push(
        `${stats.modelName}: mean response length ${Math.round(stats.meanResponseLength)} chars ` +
        `is <50% of cross-model average (${Math.round(crossModelMean)} chars)`
      );
    }
    if (stats.belowQuorumCount > 0) {
      warnings.push(
        `${stats.modelName}: ${stats.belowQuorumCount} conversation(s) scored below judge quorum`
      );
    }
  }

  return warnings;
}

/**
 * Print a formatted data quality report to console.
 * Should be called after scoring is complete, before writing output.
 */
export function printDataQualityReport(results: ModelResults[]): void {
  if (results.length === 0) return;

  const allStats = collectModelStats(results);

  // --- Header ---
  console.log('\n' + '='.repeat(70));
  console.log('  DATA QUALITY REPORT');
  console.log('='.repeat(70));

  // --- Column widths ---
  const nameW = 22;
  const numW = 8;

  // --- Per-model stats table ---
  console.log('\n  Per-Model Response Statistics\n');
  console.log(
    '  ' +
    pad('Model', nameW) +
    padR('Convs', numW) +
    padR('Turns', numW) +
    padR('Mean', numW) +
    padR('Min', numW) +
    padR('Max', numW) +
    padR('Trunc', numW) +
    padR('Empty', numW) +
    padR('Error', numW)
  );
  console.log('  ' + '-'.repeat(nameW + numW * 8));

  for (const stats of allStats) {
    console.log(
      '  ' +
      pad(stats.modelName, nameW) +
      padR(String(stats.totalConversations), numW) +
      padR(String(stats.totalModelTurns), numW) +
      padR(String(Math.round(stats.meanResponseLength)), numW) +
      padR(String(stats.minResponseLength), numW) +
      padR(String(stats.maxResponseLength), numW) +
      padR(String(stats.truncationCount), numW) +
      padR(String(stats.emptyCount), numW) +
      padR(String(stats.errorCount), numW)
    );
  }

  // --- Judge scoring table ---
  console.log('\n  Judge Scoring Summary\n');
  console.log(
    '  ' +
    pad('Model', nameW) +
    padR('Scored', numW) +
    padR('BelowQ', numW) +
    padR('JdgErr', numW)
  );
  console.log('  ' + '-'.repeat(nameW + numW * 3));

  for (const stats of allStats) {
    console.log(
      '  ' +
      pad(stats.modelName, nameW) +
      padR(String(stats.scoredCount), numW) +
      padR(String(stats.belowQuorumCount), numW) +
      padR(String(stats.judgeErrorCount), numW)
    );
  }

  // --- Warnings ---
  const warnings = collectWarnings(allStats);

  if (warnings.length > 0) {
    console.log('\n  WARNINGS\n');
    for (const w of warnings) {
      console.log(`  !! ${w}`);
    }
  } else {
    console.log('\n  No data quality warnings.');
  }

  console.log('\n' + '='.repeat(70) + '\n');
}

function padR(str: string, width: number): string {
  return str.padStart(width - 1) + ' ';
}
