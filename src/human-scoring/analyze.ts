// ============================================================================
// AI Pulse — Calibration Analysis
// ============================================================================
//
// After Imran scores ~20 conversations, this script compares human scores
// against AI judge scores to measure:
//   1. Per-judge correlation with human (Spearman rank + MAE)
//   2. Qwen's mean error vs human (validates the −0.5/−0.4 correction)
//   3. Llama/Mistral mean error vs human
//   4. Optimal correction values (human mean − judge mean)
//
// Usage:
//   node dist/human-scoring/analyze.js [calibration-results.json]

import * as fs from 'fs';
import * as path from 'path';
import { PipelineOutput, JudgeScore } from '../types';

// --- Types ---

interface HumanScore {
  conversationId: string;
  anthropomorphicBehaviour: number;
  proactiveClarification: number;
  rationale?: string;
}

interface CalibrationResults {
  metadata: {
    scorer: string;
    completedAt: string;
    totalScored: number;
  };
  scores: HumanScore[];
}

interface JudgeAnalysis {
  judgeId: string;
  n: number;
  /** Mean signed error: judge - human (positive = judge lenient) */
  abMeanError: number;
  pcMeanError: number;
  /** Mean absolute error */
  abMAE: number;
  pcMAE: number;
  /** Spearman rank correlation */
  abSpearman: number;
  pcSpearman: number;
}

// --- Spearman Rank Correlation ---

function rankArray(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array(values.length);
  let i = 0;
  while (i < indexed.length) {
    // Find ties
    let j = i;
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    // Average rank for ties
    const avgRank = (i + j - 1) / 2 + 1; // 1-based
    for (let k = i; k < j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j;
  }
  return ranks;
}

function spearmanCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 3) return NaN;
  const n = x.length;
  const rx = rankArray(x);
  const ry = rankArray(y);

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rx[i] - ry[i];
    sumD2 += d * d;
  }

  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

// --- Helpers ---

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function meanAbsoluteError(predicted: number[], actual: number[]): number {
  let sum = 0;
  for (let i = 0; i < predicted.length; i++) {
    sum += Math.abs(predicted[i] - actual[i]);
  }
  return sum / predicted.length;
}

function pad(s: string, w: number): string {
  return s.padEnd(w);
}

function fmtN(n: number, d: number = 2): string {
  return n.toFixed(d);
}

// --- Main ---

function main(): void {
  const projectDir = path.resolve(__dirname, '../..');

  // Load calibration results (human scores)
  const resultsArg = process.argv[2] || path.join(projectDir, 'calibration-results.json');
  if (!fs.existsSync(resultsArg)) {
    console.error(`ERROR: Calibration results not found: ${resultsArg}`);
    console.error('Score conversations in calibration.html first, then export the results.');
    process.exit(1);
  }

  const calibrationResults = JSON.parse(
    fs.readFileSync(resultsArg, 'utf-8')
  ) as CalibrationResults;

  console.log('AI Pulse — Calibration Analysis\n');
  console.log(`Scorer:      ${calibrationResults.metadata.scorer}`);
  console.log(`Completed:   ${calibrationResults.metadata.completedAt}`);
  console.log(`Scored:      ${calibrationResults.metadata.totalScored} conversations\n`);

  // Load pipeline results (AI judge scores)
  const pipelinePath = path.join(projectDir, 'results.json');
  if (!fs.existsSync(pipelinePath)) {
    console.error('ERROR: results.json not found. Run the pipeline first.');
    process.exit(1);
  }

  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8')) as PipelineOutput;

  // Build lookup: conversationId → judge scores
  const judgeScoreMap = new Map<string, JudgeScore[]>();
  for (const model of pipeline.results) {
    for (const conv of model.conversations) {
      judgeScoreMap.set(conv.conversationId, conv.scores.blendedJudgeScores);
    }
  }

  // Match human scores with judge scores
  const matched: Array<{
    human: HumanScore;
    judges: JudgeScore[];
  }> = [];

  let missingCount = 0;
  for (const hs of calibrationResults.scores) {
    const judges = judgeScoreMap.get(hs.conversationId);
    if (!judges) {
      console.warn(`  WARNING: No judge scores for ${hs.conversationId}`);
      missingCount++;
      continue;
    }
    matched.push({ human: hs, judges });
  }

  if (missingCount > 0) {
    console.log(`  ${missingCount} conversation(s) had no matching judge scores\n`);
  }

  if (matched.length < 5) {
    console.error(`ERROR: Only ${matched.length} matched conversations. Need at least 5 for meaningful analysis.`);
    process.exit(1);
  }

  console.log(`Matched ${matched.length} conversations with judge scores\n`);

  // --- Per-judge analysis ---

  const judgeIds = new Set<string>();
  for (const { judges } of matched) {
    for (const j of judges) judgeIds.add(j.judgeId);
  }

  const analyses: JudgeAnalysis[] = [];

  for (const judgeId of judgeIds) {
    const humanAB: number[] = [];
    const humanPC: number[] = [];
    const judgeAB: number[] = [];
    const judgePC: number[] = [];

    for (const { human, judges } of matched) {
      const js = judges.find(j => j.judgeId === judgeId);
      if (!js) continue;
      humanAB.push(human.anthropomorphicBehaviour);
      humanPC.push(human.proactiveClarification);
      judgeAB.push(js.anthropomorphicBehaviour);
      judgePC.push(js.proactiveClarification);
    }

    if (humanAB.length < 3) continue;

    const abErrors = judgeAB.map((v, i) => v - humanAB[i]);
    const pcErrors = judgePC.map((v, i) => v - humanPC[i]);

    analyses.push({
      judgeId,
      n: humanAB.length,
      abMeanError: mean(abErrors),
      pcMeanError: mean(pcErrors),
      abMAE: meanAbsoluteError(judgeAB, humanAB),
      pcMAE: meanAbsoluteError(judgePC, humanPC),
      abSpearman: spearmanCorrelation(judgeAB, humanAB),
      pcSpearman: spearmanCorrelation(judgePC, humanPC),
    });
  }

  // Sort by judgeId for consistent display
  analyses.sort((a, b) => a.judgeId.localeCompare(b.judgeId));

  // --- Print results ---

  console.log('=' .repeat(80));
  console.log('  PER-JUDGE ANALYSIS (judge − human: positive = judge is lenient)');
  console.log('='.repeat(80));
  console.log();
  console.log(
    '  ' +
    pad('Judge', 28) +
    pad('N', 5) +
    pad('AB Err', 9) +
    pad('AB MAE', 9) +
    pad('AB ρ', 8) +
    pad('PC Err', 9) +
    pad('PC MAE', 9) +
    pad('PC ρ', 8)
  );
  console.log('  ' + '-'.repeat(83));

  for (const a of analyses) {
    console.log(
      '  ' +
      pad(a.judgeId, 28) +
      pad(String(a.n), 5) +
      pad((a.abMeanError >= 0 ? '+' : '') + fmtN(a.abMeanError), 9) +
      pad(fmtN(a.abMAE), 9) +
      pad(fmtN(a.abSpearman), 8) +
      pad((a.pcMeanError >= 0 ? '+' : '') + fmtN(a.pcMeanError), 9) +
      pad(fmtN(a.pcMAE), 9) +
      pad(fmtN(a.pcSpearman), 8)
    );
  }

  // --- Panel mean vs human ---

  console.log('\n' + '='.repeat(80));
  console.log('  PANEL MEAN vs HUMAN');
  console.log('='.repeat(80));

  const panelAB: number[] = [];
  const panelPC: number[] = [];
  const humanABAll: number[] = [];
  const humanPCAll: number[] = [];

  for (const { human, judges } of matched) {
    if (judges.length === 0) continue;
    const avgAB = judges.reduce((s, j) => s + j.anthropomorphicBehaviour, 0) / judges.length;
    const avgPC = judges.reduce((s, j) => s + j.proactiveClarification, 0) / judges.length;
    panelAB.push(avgAB);
    panelPC.push(avgPC);
    humanABAll.push(human.anthropomorphicBehaviour);
    humanPCAll.push(human.proactiveClarification);
  }

  console.log(`\n  Panel mean AB: ${fmtN(mean(panelAB))}  |  Human mean AB: ${fmtN(mean(humanABAll))}  |  Diff: ${fmtN(mean(panelAB) - mean(humanABAll))}`);
  console.log(`  Panel mean PC: ${fmtN(mean(panelPC))}  |  Human mean PC: ${fmtN(mean(humanPCAll))}  |  Diff: ${fmtN(mean(panelPC) - mean(humanPCAll))}`);
  console.log(`  Panel AB MAE:  ${fmtN(meanAbsoluteError(panelAB, humanABAll))}  |  Panel AB ρ: ${fmtN(spearmanCorrelation(panelAB, humanABAll))}`);
  console.log(`  Panel PC MAE:  ${fmtN(meanAbsoluteError(panelPC, humanPCAll))}  |  Panel PC ρ: ${fmtN(spearmanCorrelation(panelPC, humanPCAll))}`);

  // --- Qwen bias validation ---

  console.log('\n' + '='.repeat(80));
  console.log('  QWEN BIAS CORRECTION VALIDATION');
  console.log('='.repeat(80));

  const qwenAnalysis = analyses.find(a => a.judgeId.includes('qwen'));
  if (qwenAnalysis) {
    console.log(`\n  Current correction:   AB −0.50  |  PC −0.40`);
    console.log(`  Measured bias:        BM ${(qwenAnalysis.abMeanError >= 0 ? '+' : '')}${fmtN(qwenAnalysis.abMeanError)}  |  RA ${(qwenAnalysis.pcMeanError >= 0 ? '+' : '')}${fmtN(qwenAnalysis.pcMeanError)}`);
    console.log(`  Optimal correction:   AB −${fmtN(Math.max(0, qwenAnalysis.abMeanError))}  |  PC −${fmtN(Math.max(0, qwenAnalysis.pcMeanError))}`);

    const bmDiff = Math.abs(qwenAnalysis.abMeanError - 0.5);
    const raDiff = Math.abs(qwenAnalysis.pcMeanError - 0.4);

    if (bmDiff < 0.3 && raDiff < 0.3) {
      console.log('\n  → Current correction is CLOSE to measured bias (within ±0.3)');
    } else {
      console.log('\n  → Current correction DIFFERS from measured bias by >0.3 — consider updating');
      console.log(`    BM delta: ${fmtN(bmDiff)} | RA delta: ${fmtN(raDiff)}`);
    }
  } else {
    console.log('\n  No Qwen judge scores found in matched data');
  }

  // --- Human score distribution ---

  console.log('\n' + '='.repeat(80));
  console.log('  HUMAN SCORE DISTRIBUTION');
  console.log('='.repeat(80));

  const abDist = [0, 0, 0, 0]; // index 0 = score 1, etc.
  const pcDist = [0, 0, 0, 0];
  for (const { human } of matched) {
    abDist[human.anthropomorphicBehaviour - 1]++;
    pcDist[human.proactiveClarification - 1]++;
  }

  console.log(`\n  BM:  1: ${abDist[0]}  |  2: ${abDist[1]}  |  3: ${abDist[2]}  |  4: ${abDist[3]}`);
  console.log(`  RA:  1: ${pcDist[0]}  |  2: ${pcDist[1]}  |  3: ${pcDist[2]}  |  4: ${pcDist[3]}`);

  // --- Per-conversation detail ---

  console.log('\n' + '='.repeat(80));
  console.log('  PER-CONVERSATION COMPARISON');
  console.log('='.repeat(80));
  console.log();
  console.log(
    '  ' +
    pad('Conversation', 24) +
    pad('Human', 12) +
    pad('Panel', 12) +
    pad('Δ AB', 8) +
    pad('Δ PC', 8) +
    'Judges'
  );
  console.log('  ' + '-'.repeat(90));

  for (const { human, judges } of matched) {
    const avgAB = judges.reduce((s, j) => s + j.anthropomorphicBehaviour, 0) / judges.length;
    const avgPC = judges.reduce((s, j) => s + j.proactiveClarification, 0) / judges.length;
    const dbm = avgAB - human.anthropomorphicBehaviour;
    const dra = avgPC - human.proactiveClarification;
    const judgeStr = judges.map(j => `${j.judgeId.replace('judge-', '').slice(0, 8)}:${j.anthropomorphicBehaviour}/${j.proactiveClarification}`).join(' ');

    console.log(
      '  ' +
      pad(human.conversationId.slice(0, 22), 24) +
      pad(`${human.anthropomorphicBehaviour}/${human.proactiveClarification}`, 12) +
      pad(`${fmtN(avgAB, 1)}/${fmtN(avgPC, 1)}`, 12) +
      pad((dbm >= 0 ? '+' : '') + fmtN(dbm, 1), 8) +
      pad((dra >= 0 ? '+' : '') + fmtN(dra, 1), 8) +
      judgeStr
    );
  }

  console.log('\n' + '='.repeat(80));
  console.log('  Analysis complete.');
  console.log('='.repeat(80) + '\n');
}

main();
