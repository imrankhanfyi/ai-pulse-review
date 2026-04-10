// ============================================================================
// AI Pulse — Audit CLI Entry Point
// ============================================================================
//
// Orchestrates stratified sampling, Pass 1 scoring, optional Pass 2 scoring
// with calibration, and divergence report generation.
//
// Usage:
//   node dist/audit.js [--smoke] [--quick] [--pass2]
//                      [--results PATH] [--threshold N]
//
// Pass 2 (calibration-aware re-scoring) is disabled by default.
// It was found to be net harmful in Pulses 24-26 (Opus overcorrects
// when given calibration data — 16/30 CALIB-HURT). Retained as a tool
// for re-evaluation when the judge panel is updated.

import 'dotenv/config'; // Load .env into process.env before anything else
import * as fs from 'fs';
import * as path from 'path';
import { PipelineOutput } from '../types';
import { selectAuditSample, SampledConversation } from './sampler';
import { scoreConversation, callOpus, AuditTurnScore } from './scorer';
import {
  loadCalibrationData,
  generateCalibrationSummary,
  confirmCalibrationSummary,
} from './human-baseline';
import {
  AuditResult,
  formatSummary,
  writeAuditOutput,
} from './report';

// ============================================================================
// CLI Flag Parsing
// ============================================================================

interface AuditOptions {
  smoke: boolean;
  quick: boolean;
  pass2: boolean;
  resultsPath: string;
  threshold: number;
  seed: string | undefined;
}

function parseArgs(argv: string[]): AuditOptions {
  const args = argv.slice(2); // strip node + script
  const opts: AuditOptions = {
    smoke: false,
    quick: false,
    pass2: false,
    resultsPath: 'results.json',
    threshold: 1.0,
    seed: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--smoke':
        opts.smoke = true;
        break;
      case '--quick':
        opts.quick = true;
        break;
      case '--pass2':
        opts.pass2 = true;
        break;
      case '--pass1-only':
        // Legacy flag — Pass 1 only is now the default
        break;
      case '--results':
        if (i + 1 < args.length) {
          opts.resultsPath = args[++i];
        } else {
          console.error('[Audit] --results requires a PATH argument');
          process.exit(1);
        }
        break;
      case '--threshold': {
        if (i + 1 < args.length) {
          const val = parseFloat(args[++i]);
          if (isNaN(val) || val < 0) {
            console.error(`[Audit] --threshold requires a non-negative number`);
            process.exit(1);
          }
          opts.threshold = val;
        } else {
          console.error('[Audit] --threshold requires a numeric argument');
          process.exit(1);
        }
        break;
      }
      case '--seed':
        if (i + 1 < args.length) {
          opts.seed = args[++i];
        } else {
          console.error('[Audit] --seed requires a string argument');
          process.exit(1);
        }
        break;
      default:
        console.error(`[Audit] Unknown flag: ${arg}`);
        process.exit(1);
    }
  }

  return opts;
}

// ============================================================================
// Output Directory
// ============================================================================

/** Build the output directory path: audits/YYYY-MM-DDTHH-MM-SSZ */
function buildOutputDir(): string {
  const now = new Date();
  const iso = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  return path.join(__dirname, '..', '..', 'audits', iso);
}

// ============================================================================
// Load and Validate Results
// ============================================================================

function loadResults(resultsPath: string): PipelineOutput {
  const resolved = path.isAbsolute(resultsPath)
    ? resultsPath
    : path.join(process.cwd(), resultsPath);

  if (!fs.existsSync(resolved)) {
    console.error(`[Audit] Results file not found: ${resolved}`);
    process.exit(1);
  }

  let output: PipelineOutput;
  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    output = JSON.parse(raw) as PipelineOutput;
  } catch (err) {
    console.error(`[Audit] Failed to parse results file: ${err}`);
    process.exit(1);
  }

  if (output.metadata?.mode !== 'live') {
    console.error(
      `[Audit] Refusing to audit mock results (mode="${output.metadata?.mode}"). ` +
      'Run the pipeline in --live mode first.',
    );
    process.exit(1);
  }

  return output;
}

// ============================================================================
// Partial Panel Coverage Check
// ============================================================================

function hasPartialPanelCoverage(
  sampled: SampledConversation,
  expectedJudgeCount: number,
): boolean {
  if (!sampled.scores.perTurnScores) return false;
  return sampled.scores.perTurnScores.some(
    turn => turn.judgeScores.length < expectedJudgeCount,
  );
}

// ============================================================================
// Build AuditResult
// ============================================================================

function buildAuditResult(
  sampled: SampledConversation,
  pass1Score: Awaited<ReturnType<typeof scoreConversation>>,
  pass2Score: Awaited<ReturnType<typeof scoreConversation>> | null,
  output: PipelineOutput,
): AuditResult {
  const expectedJudgeCount =
    output.metadata.judgePanelConfig?.judges.length ??
    output.metadata.parameters.judgeCount;

  const result: AuditResult = {
    conversationId: sampled.conversationId,
    modelId: sampled.modelId,
    modelName: sampled.modelName,
    scenarioId: sampled.scenarioId,
    category: sampled.category,
    scoreTier: sampled.scoreTier,
    panelAB: sampled.panelAB,
    panelPC: sampled.panelPC,
    pass1AB: pass1Score.anthropomorphicBehaviour,
    pass1PC: pass1Score.proactiveClarification,
    pass1PerTurn: pass1Score.perTurnScores,
    pass1FailedTurns: pass1Score.failedTurns,
    partialPanelCoverage: hasPartialPanelCoverage(sampled, expectedJudgeCount),
  };

  if (pass2Score !== null) {
    result.pass2AB = pass2Score.anthropomorphicBehaviour;
    result.pass2PC = pass2Score.proactiveClarification;
    result.pass2PerTurn = pass2Score.perTurnScores;
    result.pass2FailedTurns = pass2Score.failedTurns;
  }

  return result;
}

// ============================================================================
// Main Orchestration
// ============================================================================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  // Derive run parameters from flags
  const targetSize = opts.smoke ? 3 : opts.quick ? 10 : 30;
  const runPass2 = opts.pass2 && !opts.smoke;
  const autoProceed = opts.quick; // skip calibration confirmation prompt in quick mode

  console.log('');
  console.log('='.repeat(60));
  console.log('  AI Pulse — Audit Agent');
  console.log('='.repeat(60));
  console.log(`  Mode:         ${opts.smoke ? 'smoke' : opts.quick ? 'quick' : 'full'}`);
  console.log(`  Sample size:  ${targetSize}`);
  console.log(`  Pass 2:       ${runPass2 ? 'yes' : 'no'}`);
  console.log(`  Threshold:    ${opts.threshold}`);
  console.log(`  Results file: ${opts.resultsPath}`);
  console.log(`  Seed:         ${opts.seed ?? '(default)'}`);

  console.log('='.repeat(60));
  console.log('');

  // ---- [1/4] Select sample ------------------------------------------------
  console.log('[1/4] Selecting sample...');
  const output = loadResults(opts.resultsPath);
  const sample = selectAuditSample(output, {
    targetSize,
    seed: opts.seed ?? `audit-${output.metadata.runId}`,
  });

  if (sample.length === 0) {
    console.error('[Audit] No eligible conversations found. Aborting.');
    process.exit(1);
  }

  console.log(`  Selected ${sample.length} conversations.`);
  console.log('');

  // ---- [2/4] Pass 1 -------------------------------------------------------
  console.log('[2/4] Pass 1: scoring with standard rubric...');
  const pass1Scores = new Map<string, Awaited<ReturnType<typeof scoreConversation>>>();

  for (let i = 0; i < sample.length; i++) {
    const sampled = sample[i];
    console.log(
      `  [${i + 1}/${sample.length}] [pass1] Scoring ` +
      `${sampled.modelName} / ${sampled.scenarioId} ...`,
    );
    const score = await scoreConversation(sampled, 1);
    pass1Scores.set(sampled.conversationId, score);
  }

  console.log('');

  // ---- [3/4] Pass 2 (optional) -------------------------------------------
  let calibrationSummary: string | undefined;
  const pass2Scores = new Map<string, Awaited<ReturnType<typeof scoreConversation>>>();

  if (runPass2) {
    console.log('[3/4] Pass 2: loading calibration data...');

    let entries;
    try {
      entries = loadCalibrationData();
      console.log(`  Loaded ${entries.length} calibration entries.`);
    } catch (err) {
      console.error(`[Audit] Failed to load calibration data: ${err}`);
      console.error('[Audit] Skipping Pass 2.');
      entries = null;
    }

    if (entries && entries.length > 0) {
      const summary = await generateCalibrationSummary(entries, callOpus);

      if (!summary) {
        console.error('[Audit] Failed to generate calibration summary. Skipping Pass 2.');
      } else {
        let proceed = true;

        if (!autoProceed) {
          proceed = await confirmCalibrationSummary(summary);
          if (!proceed) {
            console.log('[Audit] Calibration summary rejected. Skipping Pass 2.');
          }
        } else {
          console.log('  [quick mode] Auto-proceeding with calibration summary.');
        }

        if (proceed) {
          calibrationSummary = summary;

          console.log(`  Scoring ${sample.length} conversations with calibrated rubric...`);

          for (let i = 0; i < sample.length; i++) {
            const sampled = sample[i];
            console.log(
              `  [${i + 1}/${sample.length}] [pass2] Scoring ` +
              `${sampled.modelName} / ${sampled.scenarioId} ...`,
            );
            const score = await scoreConversation(sampled, 2, calibrationSummary);
            pass2Scores.set(sampled.conversationId, score);
          }
        }
      }
    }

    console.log('');
  } else {
    console.log('[3/4] Pass 2: skipped.');
    console.log('');
  }

  // ---- [4/4] Build results + write output --------------------------------
  console.log('[4/4] Building results and writing output...');

  const results: AuditResult[] = sample.map(sampled => {
    const p1 = pass1Scores.get(sampled.conversationId)!;
    const p2 = pass2Scores.get(sampled.conversationId) ?? null;
    return buildAuditResult(sampled, p1, p2, output);
  });

  const summaryText = formatSummary(results, opts.threshold);
  console.log('');
  console.log(summaryText);

  const outputDir = buildOutputDir();
  writeAuditOutput(results, outputDir, summaryText, calibrationSummary);

  console.log(`  Output written to: ${outputDir}`);
  console.log('');
  console.log('='.repeat(60));
  console.log('  Audit complete.');
  console.log('='.repeat(60));
  console.log('');
}

main().catch(err => {
  console.error('[Audit] Fatal error:', err);
  process.exit(1);
});
