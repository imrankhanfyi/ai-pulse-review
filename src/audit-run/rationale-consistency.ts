// ============================================================================
// AI Pulse — Rationale-Score Consistency Checker CLI
// ============================================================================
//
// Orchestrates stratified sampling of rationale-score pairs, meta-judge
// evaluation via Gemini 2.5 Flash, and report generation.
//
// Usage:
//   node dist/audit-run/rationale-consistency.js [--results PATH]
//        [--sample N] [--full] [--seed STRING]

import 'dotenv/config'; // Load .env into process.env before anything else
import * as fs from 'fs';
import * as path from 'path';
import { PipelineOutput } from '../types';
import { sampleRationalePairs } from './rationale-sampler';
import { buildMetaJudgePrompt, callMetaJudge, parseMetaJudgeResponse } from './rationale-prompt';
import {
  RationaleConsistencyResult,
  aggregateVerdicts,
  formatConsoleReport,
  writeRationaleConsistencyOutput,
} from './rationale-report';
import { MOCK_MODEL_IDS } from '../shared/scenarios';

// ============================================================================
// Constants
// ============================================================================

const META_JUDGE_MODEL = 'gemini-2.5-flash';
const DEFAULT_SAMPLE_SIZE = 150;

// ============================================================================
// CLI Flag Parsing
// ============================================================================

interface RationaleConsistencyOptions {
  resultsPath: string;
  sampleSize: number;
  full: boolean;
  seed: string | undefined;
}

function parseArgs(argv: string[]): RationaleConsistencyOptions {
  const args = argv.slice(2); // strip node + script
  const opts: RationaleConsistencyOptions = {
    resultsPath: 'results.json',
    sampleSize: DEFAULT_SAMPLE_SIZE,
    full: false,
    seed: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--results':
        if (i + 1 < args.length) {
          opts.resultsPath = args[++i];
        } else {
          console.error('[RationaleConsistency] --results requires a PATH argument');
          process.exit(1);
        }
        break;
      case '--sample': {
        if (i + 1 < args.length) {
          const val = parseInt(args[++i], 10);
          if (isNaN(val) || val <= 0) {
            console.error('[RationaleConsistency] --sample requires a positive integer');
            process.exit(1);
          }
          opts.sampleSize = val;
        } else {
          console.error('[RationaleConsistency] --sample requires a numeric argument');
          process.exit(1);
        }
        break;
      }
      case '--full':
        opts.full = true;
        break;
      case '--seed':
        if (i + 1 < args.length) {
          opts.seed = args[++i];
        } else {
          console.error('[RationaleConsistency] --seed requires a string argument');
          process.exit(1);
        }
        break;
      default:
        console.error(`[RationaleConsistency] Unknown flag: ${arg}`);
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
    console.error(`[RationaleConsistency] Results file not found: ${resolved}`);
    process.exit(1);
  }

  let output: PipelineOutput;
  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    output = JSON.parse(raw) as PipelineOutput;
  } catch (err) {
    console.error(`[RationaleConsistency] Failed to parse results file: ${err}`);
    process.exit(1);
  }

  if (output.metadata?.mode !== 'live') {
    console.error(
      `[RationaleConsistency] Refusing to check mock results (mode="${output.metadata?.mode}"). ` +
      'Run the pipeline in --live mode first.',
    );
    process.exit(1);
  }

  return output;
}

// ============================================================================
// Count Total Eligible Pairs
// ============================================================================

function countTotalPairs(output: PipelineOutput): number {
  let count = 0;
  for (const modelResult of output.results) {
    if (MOCK_MODEL_IDS.includes(modelResult.modelProfileId)) continue;
    for (const conv of modelResult.conversations) {
      if (!conv.scores.perTurnScores) continue;
      if (conv.scores.scoringFailed) continue;
      for (const turn of conv.scores.perTurnScores) {
        for (const js of turn.judgeScores) {
          if (js.rationale && js.rationale.trim().length > 0) {
            count++;
          }
        }
      }
    }
  }
  return count;
}

// ============================================================================
// Main Orchestration
// ============================================================================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  // Derive target size
  const targetSize = opts.full ? Number.MAX_SAFE_INTEGER : opts.sampleSize;

  console.log('');
  console.log('='.repeat(60));
  console.log('  AI Pulse — Rationale-Score Consistency Checker');
  console.log('='.repeat(60));
  console.log(`  Sample size:  ${opts.full ? 'all (full)' : targetSize}`);
  console.log(`  Results file: ${opts.resultsPath}`);
  console.log(`  Seed:         ${opts.seed ?? '(default)'}`);
  console.log(`  Meta-judge:   ${META_JUDGE_MODEL}`);
  console.log('='.repeat(60));
  console.log('');

  // ---- [1/3] Sample -------------------------------------------------------
  console.log('[1/3] Sampling rationale-score pairs...');
  const output = loadResults(opts.resultsPath);
  const totalPairs = countTotalPairs(output);

  const seed = opts.seed ?? `rationale-${output.metadata.runId}`;
  const sample = sampleRationalePairs(output, { targetSize, seed });

  if (sample.length === 0) {
    console.error('[RationaleConsistency] No eligible rationale-score pairs found. Aborting.');
    process.exit(1);
  }

  console.log(`  Sampled ${sample.length} / ${totalPairs} eligible pairs.`);
  console.log('');

  // ---- [2/3] Score ---------------------------------------------------------
  console.log('[2/3] Scoring with meta-judge...');
  const results: RationaleConsistencyResult[] = [];
  let failures = 0;

  for (let i = 0; i < sample.length; i++) {
    const pair = sample[i];
    console.log(
      `  [${i + 1}/${sample.length}] ${pair.conversationId} turn ${pair.turnIndex} [${pair.judgeId}]`,
    );

    const prompt = buildMetaJudgePrompt(pair.rationale, pair.givenAB, pair.givenPC);
    const raw = await callMetaJudge(prompt);

    if (!raw) {
      console.error(`    [FAIL] Null response from meta-judge`);
      failures++;
      continue;
    }

    const verdict = parseMetaJudgeResponse(raw, pair.givenAB, pair.givenPC);
    if (!verdict) {
      console.error(`    [FAIL] Could not parse meta-judge response`);
      failures++;
      continue;
    }

    results.push({ ...pair, ...verdict });
  }

  console.log('');
  console.log(`  Scored: ${results.length}  Failures: ${failures}`);
  console.log('');

  // ---- [3/3] Report --------------------------------------------------------
  console.log('[3/3] Building report...');

  const summary = aggregateVerdicts(results);
  const metadata = {
    resultsFile: opts.resultsPath,
    metaJudgeModel: META_JUDGE_MODEL,
    sampleSize: sample.length,
    totalPairs,
  };

  const consoleReport = formatConsoleReport(summary, results, metadata);
  console.log('');
  console.log(consoleReport);

  const outputDir = buildOutputDir();
  writeRationaleConsistencyOutput(results, summary, consoleReport, metadata, outputDir);

  console.log(`  Output written to: ${outputDir}`);
  console.log('');
  console.log('='.repeat(60));
  console.log('  Rationale-score consistency check complete.');
  console.log('='.repeat(60));
  console.log('');
}

main().catch(err => {
  console.error('[RationaleConsistency] Fatal error:', err);
  process.exit(1);
});
