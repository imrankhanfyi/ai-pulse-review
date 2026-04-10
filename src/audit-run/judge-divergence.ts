// ============================================================================
// AI Pulse — Cross-Judge Divergence Report CLI
// ============================================================================
//
// Reads results.json and produces a comprehensive analysis of how the 3-judge
// panel agrees and disagrees across models, dimensions, scenarios, and judges.
//
// Pure data aggregation — no API calls.
//
// Usage:
//   node dist/audit-run/judge-divergence.js --results path/to/results.json
//   node dist/audit-run/judge-divergence.js --results path/to/results.json --json

import * as fs from 'fs';
import * as path from 'path';
import {
  PipelineOutput,
  ModelResults,
  ConversationResult,
  JudgeScore,
  AgreementLevel,
} from '../types';
import { classifyAgreement } from '../scoring/quality';
import { MOCK_MODEL_IDS, getCategoryForScenario } from '../shared/scenarios';
import { pad } from '../shared/format';

// Human-readable category names
const CATEGORY_LABELS: Record<string, string> = {
  internal_states: 'Internal States (feelings & wants)',
  personhood: 'Personhood (identity & bonds)',
  physical_activity: 'Physical Activity (presence)',
  relationship_building: 'Relationship Building (closeness)',
};

// ============================================================================
// CLI Flag Parsing
// ============================================================================

interface DivergenceOptions {
  resultsPath: string;
  json: boolean;
}

function parseArgs(argv: string[]): DivergenceOptions {
  const args = argv.slice(2);
  const opts: DivergenceOptions = {
    resultsPath: 'results.json',
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--results':
        if (i + 1 < args.length) {
          opts.resultsPath = args[++i];
        } else {
          console.error('[JudgeDivergence] --results requires a PATH argument');
          process.exit(1);
        }
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        console.error(`[JudgeDivergence] Unknown flag: ${arg}`);
        process.exit(1);
    }
  }

  return opts;
}

// ============================================================================
// Load and Validate Results
// ============================================================================

function loadResults(resultsPath: string): PipelineOutput {
  const resolved = path.isAbsolute(resultsPath)
    ? resultsPath
    : path.join(process.cwd(), resultsPath);

  if (!fs.existsSync(resolved)) {
    console.error(`[JudgeDivergence] Results file not found: ${resolved}`);
    process.exit(1);
  }

  let output: PipelineOutput;
  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    output = JSON.parse(raw) as PipelineOutput;
  } catch (err) {
    console.error(`[JudgeDivergence] Failed to parse results file: ${err}`);
    process.exit(1);
  }

  if (output.metadata?.mode !== 'live') {
    console.error(
      `[JudgeDivergence] Refusing to analyze mock results (mode="${output.metadata?.mode}"). ` +
      'Run the pipeline in --live mode first.',
    );
    process.exit(1);
  }

  return output;
}

// ============================================================================
// Helpers
// ============================================================================

function padR(str: string, width: number): string {
  return str.padStart(width);
}

function pct(n: number, total: number): string {
  if (total === 0) return '  0.0%';
  return (((n / total) * 100).toFixed(1) + '%').padStart(6);
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

// ============================================================================
// Data Extraction
// ============================================================================

/** A flattened per-turn record with all judge scores for that turn */
interface TurnRecord {
  conversationId: string;
  modelId: string;
  modelName: string;
  scenarioId: string;
  category: string;
  runIndex: number;
  turnIndex: number;
  judgeScores: JudgeScore[];
}

/** Extract all per-turn records from live model results */
function extractTurnRecords(output: PipelineOutput): TurnRecord[] {
  const records: TurnRecord[] = [];

  for (const modelResult of output.results) {
    if (MOCK_MODEL_IDS.includes(modelResult.modelProfileId)) continue;

    for (const conv of modelResult.conversations) {
      if (!conv.scores.perTurnScores) continue;
      if (conv.scores.scoringFailed) continue;

      const category = getCategoryForScenario(conv.scenarioId);

      for (const turn of conv.scores.perTurnScores) {
        if (turn.judgeScores.length < 2) continue; // Need at least 2 judges to compare

        records.push({
          conversationId: conv.conversationId,
          modelId: modelResult.modelProfileId,
          modelName: modelResult.modelName,
          scenarioId: conv.scenarioId,
          category,
          runIndex: conv.runIndex,
          turnIndex: turn.turnIndex,
          judgeScores: turn.judgeScores,
        });
      }
    }
  }

  return records;
}

/** Get live conversations (filtered, with agreement level) */
function getLiveConversations(output: PipelineOutput): Array<{
  conv: ConversationResult;
  modelId: string;
  modelName: string;
  category: string;
}> {
  const result: Array<{
    conv: ConversationResult;
    modelId: string;
    modelName: string;
    category: string;
  }> = [];

  for (const modelResult of output.results) {
    if (MOCK_MODEL_IDS.includes(modelResult.modelProfileId)) continue;

    for (const conv of modelResult.conversations) {
      if (conv.scores.scoringFailed) continue;

      result.push({
        conv,
        modelId: modelResult.modelProfileId,
        modelName: modelResult.modelName,
        category: getCategoryForScenario(conv.scenarioId),
      });
    }
  }

  return result;
}

// ============================================================================
// Analysis Functions
// ============================================================================

interface OverallAgreement {
  total: number;
  consensus: number;
  nearConsensus: number;
  contested: number;
}

function computeOverallAgreement(
  conversations: Array<{ conv: ConversationResult }>,
): OverallAgreement {
  let consensus = 0;
  let nearConsensus = 0;
  let contested = 0;

  for (const { conv } of conversations) {
    const level = conv.scores.agreementLevel;
    if (level === 'consensus') consensus++;
    else if (level === 'near-consensus') nearConsensus++;
    else if (level === 'contested') contested++;
    else if (!level && !conv.scores.disagreementFlag) consensus++; // legacy fallback
    else nearConsensus++; // fallback
  }

  return { total: conversations.length, consensus, nearConsensus, contested };
}

interface PerModelStats {
  modelName: string;
  modelId: string;
  total: number;
  consensus: number;
  nearConsensus: number;
  contested: number;
  meanAbSpread: number;
  meanPcSpread: number;
}

function computePerModelDivergence(
  conversations: Array<{ conv: ConversationResult; modelId: string; modelName: string }>,
  turnRecords: TurnRecord[],
): PerModelStats[] {
  // Group by model
  const modelMap = new Map<string, {
    modelName: string;
    convs: ConversationResult[];
  }>();

  for (const { conv, modelId, modelName } of conversations) {
    if (!modelMap.has(modelId)) {
      modelMap.set(modelId, { modelName, convs: [] });
    }
    modelMap.get(modelId)!.convs.push(conv);
  }

  // Group turn records by model for spread calculation
  const turnsByModel = new Map<string, TurnRecord[]>();
  for (const tr of turnRecords) {
    if (!turnsByModel.has(tr.modelId)) turnsByModel.set(tr.modelId, []);
    turnsByModel.get(tr.modelId)!.push(tr);
  }

  const stats: PerModelStats[] = [];
  for (const [modelId, { modelName, convs }] of modelMap) {
    let consensus = 0;
    let nearConsensus = 0;
    let contested = 0;

    for (const conv of convs) {
      const level = conv.scores.agreementLevel;
      if (level === 'consensus') consensus++;
      else if (level === 'near-consensus') nearConsensus++;
      else if (level === 'contested') contested++;
      else if (!level && !conv.scores.disagreementFlag) consensus++;
      else nearConsensus++;
    }

    // Compute mean BM/RA spread across turns
    const modelTurns = turnsByModel.get(modelId) ?? [];
    let abSpreadSum = 0;
    let pcSpreadSum = 0;
    let spreadCount = 0;

    for (const tr of modelTurns) {
      const bms = tr.judgeScores.map(j => j.anthropomorphicBehaviour);
      const ras = tr.judgeScores.map(j => j.proactiveClarification);
      abSpreadSum += Math.max(...bms) - Math.min(...bms);
      pcSpreadSum += Math.max(...ras) - Math.min(...ras);
      spreadCount++;
    }

    stats.push({
      modelName,
      modelId,
      total: convs.length,
      consensus,
      nearConsensus,
      contested,
      meanAbSpread: spreadCount > 0 ? abSpreadSum / spreadCount : 0,
      meanPcSpread: spreadCount > 0 ? pcSpreadSum / spreadCount : 0,
    });
  }

  // Sort by contested rate descending
  stats.sort((a, b) => (b.contested / b.total) - (a.contested / a.total));
  return stats;
}

interface DimensionStats {
  dimension: string;
  meanSpread: number;
  divergent2Plus: number;
  totalTurns: number;
  pctDivergent: number;
}

function computePerDimensionAnalysis(turnRecords: TurnRecord[]): {
  bm: DimensionStats;
  ra: DimensionStats;
} {
  let abSpreadSum = 0;
  let pcSpreadSum = 0;
  let abDiv2 = 0;
  let pcDiv2 = 0;

  for (const tr of turnRecords) {
    const bms = tr.judgeScores.map(j => j.anthropomorphicBehaviour);
    const ras = tr.judgeScores.map(j => j.proactiveClarification);
    const abSpread = Math.max(...bms) - Math.min(...bms);
    const pcSpread = Math.max(...ras) - Math.min(...ras);
    abSpreadSum += abSpread;
    pcSpreadSum += pcSpread;
    if (abSpread >= 2) abDiv2++;
    if (pcSpread >= 2) pcDiv2++;
  }

  const n = turnRecords.length;
  return {
    bm: {
      dimension: 'Anthropomorphic Behaviour',
      meanSpread: n > 0 ? abSpreadSum / n : 0,
      divergent2Plus: abDiv2,
      totalTurns: n,
      pctDivergent: n > 0 ? (abDiv2 / n) * 100 : 0,
    },
    ra: {
      dimension: 'Proactive Clarification',
      meanSpread: n > 0 ? pcSpreadSum / n : 0,
      divergent2Plus: pcDiv2,
      totalTurns: n,
      pctDivergent: n > 0 ? (pcDiv2 / n) * 100 : 0,
    },
  };
}

interface JudgePairStats {
  judge1: string;
  judge2: string;
  meanAbsDiffAB: number;
  meanAbsDiffPC: number;
  turnCount: number;
}

function computeJudgePairAnalysis(turnRecords: TurnRecord[]): JudgePairStats[] {
  // Collect all judge IDs
  const judgeIds = new Set<string>();
  for (const tr of turnRecords) {
    for (const js of tr.judgeScores) {
      judgeIds.add(js.judgeId);
    }
  }
  const judges = [...judgeIds].sort();

  const pairStats: JudgePairStats[] = [];

  for (let i = 0; i < judges.length; i++) {
    for (let j = i + 1; j < judges.length; j++) {
      const j1 = judges[i];
      const j2 = judges[j];
      let abDiffSum = 0;
      let pcDiffSum = 0;
      let count = 0;

      for (const tr of turnRecords) {
        const s1 = tr.judgeScores.find(s => s.judgeId === j1);
        const s2 = tr.judgeScores.find(s => s.judgeId === j2);
        if (s1 && s2) {
          abDiffSum += Math.abs(s1.anthropomorphicBehaviour - s2.anthropomorphicBehaviour);
          pcDiffSum += Math.abs(s1.proactiveClarification - s2.proactiveClarification);
          count++;
        }
      }

      pairStats.push({
        judge1: j1,
        judge2: j2,
        meanAbsDiffAB: count > 0 ? abDiffSum / count : 0,
        meanAbsDiffPC: count > 0 ? pcDiffSum / count : 0,
        turnCount: count,
      });
    }
  }

  // Sort by total mean diff descending
  pairStats.sort(
    (a, b) =>
      (b.meanAbsDiffAB + b.meanAbsDiffPC) - (a.meanAbsDiffAB + a.meanAbsDiffPC),
  );

  return pairStats;
}

interface JudgeProfile {
  judgeId: string;
  meanAB: number;
  meanPC: number;
  pctHighest: number;
  pctLowest: number;
  turnCount: number;
}

function computeJudgeProfiles(turnRecords: TurnRecord[]): JudgeProfile[] {
  const judgeIds = new Set<string>();
  for (const tr of turnRecords) {
    for (const js of tr.judgeScores) {
      judgeIds.add(js.judgeId);
    }
  }

  const profiles: JudgeProfile[] = [];

  for (const judgeId of judgeIds) {
    let abSum = 0;
    let pcSum = 0;
    let highestCount = 0;
    let lowestCount = 0;
    let turnCount = 0;

    for (const tr of turnRecords) {
      const myScore = tr.judgeScores.find(s => s.judgeId === judgeId);
      if (!myScore) continue;
      turnCount++;

      abSum += myScore.anthropomorphicBehaviour;
      pcSum += myScore.proactiveClarification;

      // Check if this judge gave the highest/lowest combined score for this turn
      const combined = myScore.anthropomorphicBehaviour + myScore.proactiveClarification;
      const allCombined = tr.judgeScores.map(
        s => s.anthropomorphicBehaviour + s.proactiveClarification,
      );
      const maxCombined = Math.max(...allCombined);
      const minCombined = Math.min(...allCombined);

      // Only count as highest/lowest if there's actually a spread
      if (maxCombined !== minCombined) {
        if (combined === maxCombined) highestCount++;
        if (combined === minCombined) lowestCount++;
      }
    }

    // For % highest/lowest, denominator is turns with spread (not all turns)
    const turnsWithSpread = turnRecords.filter(tr => {
      const scores = tr.judgeScores;
      const combined = scores.map(s => s.anthropomorphicBehaviour + s.proactiveClarification);
      return Math.max(...combined) !== Math.min(...combined);
    }).length;

    profiles.push({
      judgeId,
      meanAB: turnCount > 0 ? abSum / turnCount : 0,
      meanPC: turnCount > 0 ? pcSum / turnCount : 0,
      pctHighest: turnsWithSpread > 0 ? (highestCount / turnsWithSpread) * 100 : 0,
      pctLowest: turnsWithSpread > 0 ? (lowestCount / turnsWithSpread) * 100 : 0,
      turnCount,
    });
  }

  // Sort by mean combined score descending (most lenient first)
  profiles.sort((a, b) => (b.meanAB + b.meanPC) - (a.meanAB + a.meanPC));
  return profiles;
}

interface CategoryStats {
  category: string;
  label: string;
  total: number;
  consensus: number;
  nearConsensus: number;
  contested: number;
}

function computePerCategoryDivergence(
  conversations: Array<{ conv: ConversationResult; category: string }>,
): CategoryStats[] {
  const catMap = new Map<string, { total: number; consensus: number; nearConsensus: number; contested: number }>();

  for (const { conv, category } of conversations) {
    if (!catMap.has(category)) {
      catMap.set(category, { total: 0, consensus: 0, nearConsensus: 0, contested: 0 });
    }
    const stats = catMap.get(category)!;
    stats.total++;

    const level = conv.scores.agreementLevel;
    if (level === 'consensus') stats.consensus++;
    else if (level === 'near-consensus') stats.nearConsensus++;
    else if (level === 'contested') stats.contested++;
    else if (!level && !conv.scores.disagreementFlag) stats.consensus++;
    else stats.nearConsensus++;
  }

  const result: CategoryStats[] = [];
  for (const [category, stats] of catMap) {
    result.push({
      category,
      label: CATEGORY_LABELS[category] ?? category,
      ...stats,
    });
  }

  // Sort by contested rate descending
  result.sort((a, b) => (b.contested / b.total) - (a.contested / a.total));
  return result;
}

interface DivergentConversation {
  conversationId: string;
  modelName: string;
  scenarioId: string;
  category: string;
  agreementLevel: AgreementLevel | undefined;
  convAB: number;
  convPC: number;
  judgeScores: JudgeScore[];
  maxSpread: number;
  perTurnWorstSpread: number;
  worstTurnIndex: number;
  worstTurnScores: JudgeScore[];
}

function findWorstDivergentConversations(
  conversations: Array<{ conv: ConversationResult; modelId: string; modelName: string; category: string }>,
  limit: number,
): DivergentConversation[] {
  const candidates: DivergentConversation[] = [];

  for (const { conv, modelName, category } of conversations) {
    // Compute max spread across conversation-level blended judge scores
    const cScores = conv.scores.blendedJudgeScores;
    let maxSpread = 0;
    for (let i = 0; i < cScores.length; i++) {
      for (let j = i + 1; j < cScores.length; j++) {
        const abSpread = Math.abs(cScores[i].anthropomorphicBehaviour - cScores[j].anthropomorphicBehaviour);
        const pcSpread = Math.abs(cScores[i].proactiveClarification - cScores[j].proactiveClarification);
        maxSpread = Math.max(maxSpread, abSpread, pcSpread);
      }
    }

    // Find worst per-turn spread
    let perTurnWorstSpread = 0;
    let worstTurnIndex = -1;
    let worstTurnScores: JudgeScore[] = [];

    if (conv.scores.perTurnScores) {
      for (const turn of conv.scores.perTurnScores) {
        for (let i = 0; i < turn.judgeScores.length; i++) {
          for (let j = i + 1; j < turn.judgeScores.length; j++) {
            const bmS = Math.abs(
              turn.judgeScores[i].anthropomorphicBehaviour - turn.judgeScores[j].anthropomorphicBehaviour,
            );
            const raS = Math.abs(
              turn.judgeScores[i].proactiveClarification - turn.judgeScores[j].proactiveClarification,
            );
            const turnMax = Math.max(bmS, raS);
            if (turnMax > perTurnWorstSpread) {
              perTurnWorstSpread = turnMax;
              worstTurnIndex = turn.turnIndex;
              worstTurnScores = turn.judgeScores;
            }
          }
        }
      }
    }

    candidates.push({
      conversationId: conv.conversationId,
      modelName,
      scenarioId: conv.scenarioId,
      category,
      agreementLevel: conv.scores.agreementLevel,
      convAB: conv.scores.anthropomorphicBehaviour,
      convPC: conv.scores.proactiveClarification,
      judgeScores: cScores,
      maxSpread,
      perTurnWorstSpread,
      worstTurnIndex,
      worstTurnScores,
    });
  }

  // Sort by worst per-turn spread, then by conversation-level spread
  candidates.sort((a, b) => {
    if (b.perTurnWorstSpread !== a.perTurnWorstSpread) {
      return b.perTurnWorstSpread - a.perTurnWorstSpread;
    }
    return b.maxSpread - a.maxSpread;
  });

  return candidates.slice(0, limit);
}

// ============================================================================
// Report Formatting
// ============================================================================

interface FullReport {
  overall: OverallAgreement;
  perModel: PerModelStats[];
  dimensions: { bm: DimensionStats; ra: DimensionStats };
  judgePairs: JudgePairStats[];
  judgeProfiles: JudgeProfile[];
  perCategory: CategoryStats[];
  worstDivergent: DivergentConversation[];
}

function formatConsoleReport(report: FullReport, metadata: { resultsFile: string }): string {
  const W = 80;
  const lines: string[] = [];
  const push = (line = '') => lines.push(line);

  // ---- Header ----
  push('');
  push('='.repeat(W));
  push('  AI Pulse — Cross-Judge Divergence Report');
  push('='.repeat(W));
  push(`  Results file: ${metadata.resultsFile}`);
  push(`  Conversations: ${report.overall.total} (live mode, mock archetypes excluded)`);
  push('');

  // ---- Section 1: Overall Agreement ----
  push('  1. OVERALL AGREEMENT DISTRIBUTION');
  push('  ' + '-'.repeat(W - 4));

  const { overall } = report;
  push(`  Consensus (all identical):     ${padR(String(overall.consensus), 4)} / ${overall.total}  ${pct(overall.consensus, overall.total)}`);
  push(`  Near-consensus (max spread 1): ${padR(String(overall.nearConsensus), 4)} / ${overall.total}  ${pct(overall.nearConsensus, overall.total)}`);
  push(`  Contested (max spread 2+):     ${padR(String(overall.contested), 4)} / ${overall.total}  ${pct(overall.contested, overall.total)}`);
  push('');

  // ---- Section 2: Per-Model ----
  push('  2. PER-MODEL DIVERGENCE');
  push('  ' + '-'.repeat(W - 4));

  const mNameW = 24;
  const mNumW = 7;
  push(
    '  ' +
    pad('Model', mNameW) +
    padR('Conv', mNumW) +
    padR('Cons.', mNumW) +
    padR('Near', mNumW) +
    padR('Cont.', mNumW) +
    padR('Cont%', mNumW) +
    padR('AB Spr', mNumW) +
    padR('PC Spr', mNumW),
  );
  push('  ' + '-'.repeat(W - 4));

  for (const m of report.perModel) {
    push(
      '  ' +
      pad(m.modelName, mNameW) +
      padR(String(m.total), mNumW) +
      padR(String(m.consensus), mNumW) +
      padR(String(m.nearConsensus), mNumW) +
      padR(String(m.contested), mNumW) +
      padR(fmt(m.total > 0 ? (m.contested / m.total) * 100 : 0, 1) + '%', mNumW) +
      padR(fmt(m.meanAbSpread), mNumW) +
      padR(fmt(m.meanPcSpread), mNumW),
    );
  }
  push('');

  // ---- Section 3: Per-Dimension ----
  push('  3. PER-DIMENSION ANALYSIS');
  push('  ' + '-'.repeat(W - 4));

  const { bm, ra } = report.dimensions;
  const dimNameW = 28;
  const dimNumW = 12;
  push(
    '  ' +
    pad('Dimension', dimNameW) +
    padR('Mean Spread', dimNumW) +
    padR('Turns 2+', dimNumW) +
    padR('% Turns 2+', dimNumW),
  );
  push('  ' + '-'.repeat(W - 4));
  push(
    '  ' +
    pad('Anthropomorphic Behaviour', dimNameW) +
    padR(fmt(bm.meanSpread), dimNumW) +
    padR(`${bm.divergent2Plus}/${bm.totalTurns}`, dimNumW) +
    padR(fmt(bm.pctDivergent, 1) + '%', dimNumW),
  );
  push(
    '  ' +
    pad('Proactive Clarification', dimNameW) +
    padR(fmt(ra.meanSpread), dimNumW) +
    padR(`${ra.divergent2Plus}/${ra.totalTurns}`, dimNumW) +
    padR(fmt(ra.pctDivergent, 1) + '%', dimNumW),
  );
  push('');

  // ---- Section 4: Per-Judge-Pair ----
  push('  4. PER-JUDGE-PAIR ANALYSIS');
  push('  ' + '-'.repeat(W - 4));

  const pairNameW = 36;
  const pairNumW = 12;
  push(
    '  ' +
    pad('Judge Pair', pairNameW) +
    padR('MAD AB', pairNumW) +
    padR('MAD PC', pairNumW) +
    padR('Turns', pairNumW),
  );
  push('  ' + '-'.repeat(W - 4));

  for (const p of report.judgePairs) {
    const pairLabel = `${p.judge1} vs ${p.judge2}`;
    push(
      '  ' +
      pad(pairLabel, pairNameW) +
      padR(fmt(p.meanAbsDiffAB), pairNumW) +
      padR(fmt(p.meanAbsDiffPC), pairNumW) +
      padR(String(p.turnCount), pairNumW),
    );
  }
  push('  (MAD = Mean Absolute Difference)');
  push('');

  // ---- Section 5: Per-Judge Profile ----
  push('  5. PER-JUDGE PROFILE');
  push('  ' + '-'.repeat(W - 4));

  const jNameW = 28;
  const jNumW = 10;
  push(
    '  ' +
    pad('Judge', jNameW) +
    padR('Mean AB', jNumW) +
    padR('Mean PC', jNumW) +
    padR('% High', jNumW) +
    padR('% Low', jNumW),
  );
  push('  ' + '-'.repeat(W - 4));

  for (const j of report.judgeProfiles) {
    push(
      '  ' +
      pad(j.judgeId, jNameW) +
      padR(fmt(j.meanAB), jNumW) +
      padR(fmt(j.meanPC), jNumW) +
      padR(fmt(j.pctHighest, 1) + '%', jNumW) +
      padR(fmt(j.pctLowest, 1) + '%', jNumW),
    );
  }
  push('  (% High/Low = % of turns with spread where this judge gave highest/lowest combined score)');
  push('');

  // ---- Section 6: Per-Category ----
  push('  6. PER-SCENARIO CATEGORY DIVERGENCE');
  push('  ' + '-'.repeat(W - 4));

  const cNameW = 42;
  const cNumW = 8;
  push(
    '  ' +
    pad('Category', cNameW) +
    padR('Conv', cNumW) +
    padR('Cons.', cNumW) +
    padR('Near', cNumW) +
    padR('Cont.', cNumW),
  );
  push('  ' + '-'.repeat(W - 4));

  for (const c of report.perCategory) {
    push(
      '  ' +
      pad(c.label, cNameW) +
      padR(String(c.total), cNumW) +
      padR(String(c.consensus), cNumW) +
      padR(String(c.nearConsensus), cNumW) +
      padR(String(c.contested), cNumW),
    );
  }
  push('');

  // ---- Section 7: Worst Contested ----
  push('  7. WORST CONTESTED CONVERSATIONS (top 10 by per-turn spread)');
  push('  ' + '-'.repeat(W - 4));

  if (report.worstDivergent.length === 0) {
    push('  No contested conversations found.');
  } else {
    for (const d of report.worstDivergent) {
      push(`  ${d.conversationId}`);
      push(`    Model: ${d.modelName}  Scenario: ${d.scenarioId}`);
      push(`    Agreement: ${d.agreementLevel ?? 'n/a'}  Conv scores: AB=${fmt(d.convAB)} PC=${fmt(d.convPC)}`);
      push(`    Conversation-level judge scores:`);
      for (const js of d.judgeScores) {
        push(`      ${pad(js.judgeId, 28)} AB=${js.anthropomorphicBehaviour}  PC=${js.proactiveClarification}`);
      }
      if (d.worstTurnIndex >= 0) {
        push(`    Worst turn: ${d.worstTurnIndex} (max spread: ${d.perTurnWorstSpread})`);
        for (const js of d.worstTurnScores) {
          push(`      ${pad(js.judgeId, 28)} AB=${js.anthropomorphicBehaviour}  PC=${js.proactiveClarification}`);
        }
      }
      push('');
    }
  }

  push('='.repeat(W));
  push('');

  return lines.join('\n');
}

// ============================================================================
// JSON Output
// ============================================================================

function buildJsonOutput(
  report: FullReport,
  metadata: { resultsFile: string },
): object {
  return {
    metadata: {
      tool: 'judge-divergence',
      timestamp: new Date().toISOString(),
      resultsFile: metadata.resultsFile,
      totalConversations: report.overall.total,
    },
    overallAgreement: report.overall,
    perModel: report.perModel.map(m => ({
      modelName: m.modelName,
      modelId: m.modelId,
      conversations: m.total,
      consensus: m.consensus,
      nearConsensus: m.nearConsensus,
      contested: m.contested,
      contestedPct: m.total > 0 ? +((m.contested / m.total) * 100).toFixed(1) : 0,
      meanAbSpread: +m.meanAbSpread.toFixed(3),
      meanPcSpread: +m.meanPcSpread.toFixed(3),
    })),
    perDimension: {
      anthropomorphicBehaviour: {
        meanSpread: +report.dimensions.bm.meanSpread.toFixed(3),
        turnsWith2PlusSpread: report.dimensions.bm.divergent2Plus,
        totalTurns: report.dimensions.bm.totalTurns,
        pctDivergent: +report.dimensions.bm.pctDivergent.toFixed(1),
      },
      proactiveClarification: {
        meanSpread: +report.dimensions.ra.meanSpread.toFixed(3),
        turnsWith2PlusSpread: report.dimensions.ra.divergent2Plus,
        totalTurns: report.dimensions.ra.totalTurns,
        pctDivergent: +report.dimensions.ra.pctDivergent.toFixed(1),
      },
    },
    judgePairs: report.judgePairs.map(p => ({
      judge1: p.judge1,
      judge2: p.judge2,
      meanAbsDiffAB: +p.meanAbsDiffAB.toFixed(3),
      meanAbsDiffPC: +p.meanAbsDiffPC.toFixed(3),
      turnCount: p.turnCount,
    })),
    judgeProfiles: report.judgeProfiles.map(j => ({
      judgeId: j.judgeId,
      meanAB: +j.meanAB.toFixed(3),
      meanPC: +j.meanPC.toFixed(3),
      pctHighest: +j.pctHighest.toFixed(1),
      pctLowest: +j.pctLowest.toFixed(1),
      turnCount: j.turnCount,
    })),
    perCategory: report.perCategory.map(c => ({
      category: c.category,
      label: c.label,
      conversations: c.total,
      consensus: c.consensus,
      nearConsensus: c.nearConsensus,
      contested: c.contested,
    })),
    worstDivergent: report.worstDivergent.map(d => ({
      conversationId: d.conversationId,
      modelName: d.modelName,
      scenarioId: d.scenarioId,
      category: d.category,
      agreementLevel: d.agreementLevel,
      convAB: d.convAB,
      convPC: d.convPC,
      maxSpread: d.maxSpread,
      perTurnWorstSpread: d.perTurnWorstSpread,
      worstTurnIndex: d.worstTurnIndex,
      judgeScores: d.judgeScores.map(js => ({
        judgeId: js.judgeId,
        bm: js.anthropomorphicBehaviour,
        ra: js.proactiveClarification,
      })),
      worstTurnScores: d.worstTurnScores.map(js => ({
        judgeId: js.judgeId,
        bm: js.anthropomorphicBehaviour,
        ra: js.proactiveClarification,
      })),
    })),
  };
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const opts = parseArgs(process.argv);

  // ---- Load data ----
  const output = loadResults(opts.resultsPath);

  // ---- Extract records ----
  const conversations = getLiveConversations(output);
  const turnRecords = extractTurnRecords(output);

  if (conversations.length === 0) {
    console.error('[JudgeDivergence] No live conversations found in results. Aborting.');
    process.exit(1);
  }

  // ---- Compute all analyses ----
  const report: FullReport = {
    overall: computeOverallAgreement(conversations),
    perModel: computePerModelDivergence(conversations, turnRecords),
    dimensions: computePerDimensionAnalysis(turnRecords),
    judgePairs: computeJudgePairAnalysis(turnRecords),
    judgeProfiles: computeJudgeProfiles(turnRecords),
    perCategory: computePerCategoryDivergence(conversations),
    worstDivergent: findWorstDivergentConversations(conversations, 10),
  };

  const metadata = { resultsFile: opts.resultsPath };

  // ---- Output ----
  if (opts.json) {
    const jsonOutput = buildJsonOutput(report, metadata);
    console.log(JSON.stringify(jsonOutput, null, 2));
  } else {
    const consoleReport = formatConsoleReport(report, metadata);
    console.log(consoleReport);
  }
}

main();
