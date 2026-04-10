// ============================================================================
// AI Pulse — Audit Triage CLI Entry Point
// ============================================================================
//
// Analyzes audit results, detects patterns, computes bias signals, generates
// conversation dossiers, and produces a structured triage report for human review.
//
// Usage:
//   node dist/audit-triage.js <audit-dir> --results PATH [--dossier-count N] [--threshold N]
//   node dist/audit-triage.js --rebuild-cumulative

import * as fs from 'fs';
import * as path from 'path';
import { PipelineOutput, ConversationResult, JudgeScore } from '../types';
import { AuditResult } from '../audit-run/report';
import { minBlend, AB_ALPHA, PC_ALPHA } from '../scoring/aggregation';
import {
  TriageReport,
  PatternFlag,
  FlaggedConversation,
} from './types';
import {
  buildFlaggedConversations,
  detectScoreLevelAbsences,
  computeTurnDivergenceDistribution,
} from './patterns';
import { computeCalibrationEffectiveness } from './pass2-effectiveness';
import { computeBiasMatrix } from './bias';
import { buildDossiers } from './dossiers';
import { formatTriageReport } from './format';
import { updateCumulative, rebuildCumulative } from './cumulative';
import { initFindingsFile } from './findings';

// ============================================================================
// CLI Flag Parsing
// ============================================================================

interface TriageOptions {
  auditDir: string | null;     // null when --rebuild-cumulative
  resultsPath: string | null;  // null when --rebuild-cumulative
  dossierCount: number;
  threshold: number;
  rebuildCumulative: boolean;
}

function parseArgs(argv: string[]): TriageOptions {
  const args = argv.slice(2); // strip node + script
  const opts: TriageOptions = {
    auditDir: null,
    resultsPath: null,
    dossierCount: 10,
    threshold: 1.0,
    rebuildCumulative: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--rebuild-cumulative':
        opts.rebuildCumulative = true;
        break;
      case '--results':
        if (i + 1 < args.length) {
          opts.resultsPath = args[++i];
        } else {
          console.error('[Triage] --results requires a PATH argument');
          process.exit(1);
        }
        break;
      case '--dossier-count': {
        if (i + 1 < args.length) {
          const val = parseInt(args[++i], 10);
          if (isNaN(val) || val < 0) {
            console.error('[Triage] --dossier-count requires a non-negative integer');
            process.exit(1);
          }
          opts.dossierCount = val;
        } else {
          console.error('[Triage] --dossier-count requires a number argument');
          process.exit(1);
        }
        break;
      }
      case '--threshold': {
        if (i + 1 < args.length) {
          const val = parseFloat(args[++i]);
          if (isNaN(val) || val < 0) {
            console.error('[Triage] --threshold requires a non-negative number');
            process.exit(1);
          }
          opts.threshold = val;
        } else {
          console.error('[Triage] --threshold requires a number argument');
          process.exit(1);
        }
        break;
      }
      default:
        // Positional argument: audit directory
        if (!arg.startsWith('--') && opts.auditDir === null) {
          opts.auditDir = arg;
        } else {
          console.error(`[Triage] Unknown argument: ${arg}`);
          process.exit(1);
        }
    }
  }

  return opts;
}

// ============================================================================
// Panel Per-Turn Helpers
// ============================================================================

/**
 * Derive panel per-turn averages from pipeline results.
 * Returns a map of conversationId -> array of {bm, ra} per turn (averaged across judges).
 */
function derivePanelPerTurnAverages(
  pipelineOutput: PipelineOutput,
  auditConvIds: Set<string>,
): Map<string, Array<{ bm: number; ra: number }>> {
  const result = new Map<string, Array<{ bm: number; ra: number }>>();

  for (const modelResults of pipelineOutput.results) {
    for (const conv of modelResults.conversations) {
      if (!auditConvIds.has(conv.conversationId)) continue;
      if (!conv.scores.perTurnScores) continue;

      const perTurn: Array<{ bm: number; ra: number }> = [];
      for (const turn of conv.scores.perTurnScores) {
        if (turn.judgeScores.length === 0) continue;
        const avgBM = turn.judgeScores.reduce((s, j) => s + j.anthropomorphicBehaviour, 0) / turn.judgeScores.length;
        const avgRA = turn.judgeScores.reduce((s, j) => s + j.proactiveClarification, 0) / turn.judgeScores.length;
        perTurn.push({ bm: avgBM, ra: avgRA });
      }
      result.set(conv.conversationId, perTurn);
    }
  }

  return result;
}

/**
 * Derive panel per-turn data grouped by judge (for score level absences).
 * Returns Map<conversationId, Array<Array<{bm, ra}>>> where outer array is per-judge.
 */
function derivePanelPerTurnByJudge(
  pipelineOutput: PipelineOutput,
  auditConvIds: Set<string>,
): Map<string, Array<Array<{ bm: number; ra: number }>>> {
  const result = new Map<string, Array<Array<{ bm: number; ra: number }>>>();

  for (const modelResults of pipelineOutput.results) {
    for (const conv of modelResults.conversations) {
      if (!auditConvIds.has(conv.conversationId)) continue;
      if (!conv.scores.perTurnScores || conv.scores.perTurnScores.length === 0) continue;

      // Figure out judge IDs from the first turn
      const judgeIds = conv.scores.perTurnScores[0].judgeScores.map(j => j.judgeId);
      const byJudge: Array<Array<{ bm: number; ra: number }>> = judgeIds.map(() => []);

      for (const turn of conv.scores.perTurnScores) {
        for (let ji = 0; ji < judgeIds.length; ji++) {
          const js = turn.judgeScores.find(j => j.judgeId === judgeIds[ji]);
          if (js) {
            byJudge[ji].push({ bm: js.anthropomorphicBehaviour, ra: js.proactiveClarification });
          }
        }
      }

      result.set(conv.conversationId, byJudge);
    }
  }

  return result;
}

/**
 * Detect panel internal splits: conversations where per-judge blended scores
 * diverge by more than 1.0 on any dimension.
 */
function detectPanelInternalSplits(
  pipelineOutput: PipelineOutput,
  auditConvIds: Set<string>,
): Set<string> {
  const splits = new Set<string>();

  for (const modelResults of pipelineOutput.results) {
    for (const conv of modelResults.conversations) {
      if (!auditConvIds.has(conv.conversationId)) continue;
      if (!conv.scores.perTurnScores || conv.scores.perTurnScores.length === 0) continue;

      // Derive per-judge blended scores
      const judgeScoreMap = new Map<string, { bms: number[]; ras: number[] }>();
      for (const turn of conv.scores.perTurnScores) {
        for (const js of turn.judgeScores) {
          if (!judgeScoreMap.has(js.judgeId)) {
            judgeScoreMap.set(js.judgeId, { bms: [], ras: [] });
          }
          judgeScoreMap.get(js.judgeId)!.bms.push(js.anthropomorphicBehaviour);
          judgeScoreMap.get(js.judgeId)!.ras.push(js.proactiveClarification);
        }
      }

      const blended: Array<{ bm: number; ra: number }> = [];
      for (const [, data] of judgeScoreMap) {
        blended.push({
          bm: minBlend(data.bms, AB_ALPHA),
          ra: minBlend(data.ras, PC_ALPHA),
        });
      }

      // Check if any pair diverges by > 1.0
      for (let i = 0; i < blended.length; i++) {
        for (let j = i + 1; j < blended.length; j++) {
          if (Math.abs(blended[i].bm - blended[j].bm) > 1.0 ||
              Math.abs(blended[i].ra - blended[j].ra) > 1.0) {
            splits.add(conv.conversationId);
          }
        }
      }
    }
  }

  return splits;
}

/**
 * Load calibration conversation IDs from calibration data.
 */
function loadCalibrationConvIds(): Set<string> {
  const calibPath = path.join(process.cwd(), 'calibration', 'human-scores-v2.json');
  if (!fs.existsSync(calibPath)) return new Set();

  try {
    const data = JSON.parse(fs.readFileSync(calibPath, 'utf-8'));
    return new Set(data.map((e: { id: string }) => e.id));
  } catch {
    return new Set();
  }
}

// ============================================================================
// Build Pattern Summary
// ============================================================================

function buildPatternSummary(
  flagged: FlaggedConversation[],
  scoreLevelAbsences: boolean,
): Record<PatternFlag, number> {
  const allFlags: PatternFlag[] = [
    'CALIB-HURT', 'DIRECTION-FLIP', 'RUBRIC-PROBLEM', 'JUDGE-QUALITY',
    'BOTH-DIVERGE', 'LATE-COLLAPSE-DISAGREEMENT', 'DIMENSION-SPLIT',
    'PANEL-INTERNAL-SPLIT', 'SCORE-LEVEL-ABSENCE',
  ];

  const summary = {} as Record<PatternFlag, number>;
  for (const flag of allFlags) {
    summary[flag] = 0;
  }

  for (const conv of flagged) {
    for (const flag of conv.flags) {
      summary[flag]++;
    }
  }

  if (scoreLevelAbsences) {
    summary['SCORE-LEVEL-ABSENCE'] = 1;
  }

  return summary;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const opts = parseArgs(process.argv);

  // ---- Rebuild cumulative mode ----
  if (opts.rebuildCumulative) {
    console.log('[Triage] Rebuilding cumulative files...');
    rebuildCumulative(path.join(process.cwd(), 'audits'));
    console.log('[Triage] Done.');
    return;
  }

  // ---- Normal triage mode ----
  if (!opts.auditDir) {
    console.error('[Triage] Usage: node dist/audit-triage.js <audit-dir> --results PATH');
    console.error('         or:    node dist/audit-triage.js --rebuild-cumulative');
    process.exit(1);
  }
  if (!opts.resultsPath) {
    console.error('[Triage] --results PATH is required');
    process.exit(1);
  }

  // Validate paths
  if (!fs.existsSync(opts.auditDir)) {
    console.error(`[Triage] Audit directory not found: ${opts.auditDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(opts.resultsPath)) {
    console.error(`[Triage] Results file not found: ${opts.resultsPath}`);
    process.exit(1);
  }

  // 1. Load audit results
  const auditResultsPath = path.join(opts.auditDir, 'audit-results.json');
  if (!fs.existsSync(auditResultsPath)) {
    console.error(`[Triage] audit-results.json not found in ${opts.auditDir}`);
    process.exit(1);
  }
  const auditResults: AuditResult[] = JSON.parse(fs.readFileSync(auditResultsPath, 'utf-8'));
  console.log(`[Triage] Loaded ${auditResults.length} audit results from ${opts.auditDir}`);

  // 2. Load pipeline results
  const pipelineOutput: PipelineOutput = JSON.parse(fs.readFileSync(opts.resultsPath, 'utf-8'));
  console.log(`[Triage] Loaded pipeline results from ${opts.resultsPath}`);

  // 3. Load calibration data (optional)
  const calibrationConvIds = loadCalibrationConvIds();
  if (calibrationConvIds.size > 0) {
    console.log(`[Triage] Loaded ${calibrationConvIds.size} calibration conversation IDs`);
  }

  // 4. Compute thresholds
  const threshold = opts.threshold;
  const patternThreshold = threshold / 2;
  console.log(`[Triage] Threshold: ${threshold}, Pattern threshold: ${patternThreshold}`);

  // 5. Derive panel per-turn data
  const auditConvIds = new Set(auditResults.map(r => r.conversationId));
  const panelPerTurnByConv = derivePanelPerTurnAverages(pipelineOutput, auditConvIds);
  const panelPerTurnByJudge = derivePanelPerTurnByJudge(pipelineOutput, auditConvIds);

  // 6. Detect panel internal splits
  const panelInternalSplits = detectPanelInternalSplits(pipelineOutput, auditConvIds);

  // 7. Build flagged conversations
  const flaggedConversations = buildFlaggedConversations(
    auditResults, patternThreshold, panelPerTurnByConv, panelInternalSplits,
  );

  // 8. Detect score level absences
  const scoreLevelAbsences = detectScoreLevelAbsences(auditResults, panelPerTurnByJudge);

  // 9. Compute calibration effectiveness
  const calibrationEffectiveness = computeCalibrationEffectiveness(flaggedConversations);

  // 10. Compute bias matrix
  const biasMatrix = computeBiasMatrix(auditResults, pipelineOutput);

  // 11. Compute per-turn divergence distribution
  const turnDivergence = computeTurnDivergenceDistribution(auditResults, panelPerTurnByConv);

  // 12. Build dossiers for top N
  const dossiers = buildDossiers(
    opts.dossierCount, flaggedConversations, pipelineOutput, calibrationConvIds,
  );

  // 13. Build pattern summary
  const patternSummary = buildPatternSummary(flaggedConversations, scoreLevelAbsences.length > 0);

  // 14. Assemble triage report
  const triageReport: TriageReport = {
    metadata: {
      auditDir: opts.auditDir,
      resultsPath: opts.resultsPath,
      timestamp: new Date().toISOString(),
      conversationCount: auditResults.length,
      threshold,
      patternThreshold,
    },
    rankedTable: flaggedConversations,
    patternSummary,
    scoreLevelAbsences,
    calibrationEffectiveness,
    biasMatrix,
    turnDivergence,
    dossiers,
  };

  // 15. Write outputs
  const reportJsonPath = path.join(opts.auditDir, 'triage-report.json');
  const reportTxtPath = path.join(opts.auditDir, 'triage-report.txt');

  fs.writeFileSync(reportJsonPath, JSON.stringify(triageReport, null, 2), 'utf-8');
  console.log(`[Triage] Wrote ${reportJsonPath}`);

  const reportText = formatTriageReport(triageReport);
  fs.writeFileSync(reportTxtPath, reportText, 'utf-8');
  console.log(`[Triage] Wrote ${reportTxtPath}`);

  // 16. Create empty findings.json if it doesn't exist
  const findingsPath = path.join(opts.auditDir, 'findings.json');
  initFindingsFile(findingsPath);

  // 17. Update cumulative files
  updateCumulative(opts.auditDir, triageReport);
  console.log(`[Triage] Updated cumulative files`);

  // Print summary
  console.log('');
  console.log(`[Triage] === Summary ===`);
  console.log(`  Conversations:   ${auditResults.length}`);
  console.log(`  Patterns found:  ${Object.values(patternSummary).reduce((a, b) => a + b, 0)}`);
  console.log(`  Dossiers:        ${dossiers.length}`);
  if (calibrationEffectiveness) {
    console.log(`  Calibration:     ${calibrationEffectiveness.closerToPanel} closer, ${calibrationEffectiveness.furtherFromPanel} further, ${calibrationEffectiveness.unchanged} unchanged`);
  }
  if (biasMatrix) {
    console.log(`  Bias matrix:     ${biasMatrix.judges.length} judges × ${biasMatrix.models.length} models`);
  }
  console.log(`  Score absences:  ${scoreLevelAbsences.length}`);
  console.log('');
}

main().catch(err => {
  console.error('[Triage] Fatal error:', err);
  process.exit(1);
});
