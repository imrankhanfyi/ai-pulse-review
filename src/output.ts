// ============================================================================
// AI Pulse — Output Formatter
// ============================================================================
//
// Formats aggregated results into the PipelineOutput JSON structure.
// Writes to disk for dashboard consumption.

import * as fs from 'fs';
import * as path from 'path';
import { PipelineOutput, ModelResults, ApiCallMetadata, AgreementLevel, ErrorSummary } from './types';
import { pad } from './shared/format';

interface OutputConfig {
  scenarioCount: number;
  modelCount: number;
  runsPerScenarioModel: number;
  turnsPerConversation: number;
  totalConversations: number;
  bootstrapResamples: number;
  judgeCount: number;
  failedScoringCount: number;
  scoreScale?: 'percentage';
  judgePanelConfig?: {
    judges: Array<{ judgeId: string; modelId: string; displayName: string }>;
    aggregation: 'mean' | 'min-blend';
    scoringMethod?: 'holistic' | 'per-turn';
  };
  errorSummary?: ErrorSummary;
  runId: string;
  gitSha?: string;
  mode: 'live' | 'mock';
}

/**
 * Build the full pipeline output structure.
 */
export function buildOutput(
  results: ModelResults[],
  config: OutputConfig,
): PipelineOutput {
  // Collect all apiMetadata from all messages across all conversations
  const allApiMetadata: ApiCallMetadata[] = [];
  for (const model of results) {
    for (const conv of model.conversations) {
      for (const msg of conv.messages) {
        if (msg.apiMetadata) {
          allApiMetadata.push(msg.apiMetadata);
        }
      }
    }
  }

  // Build provenance summary (only if there were real API calls)
  const provenance = allApiMetadata.length > 0 ? {
    apiCallCount: allApiMetadata.length,
    providers: [...new Set(allApiMetadata.map(m => m.provider))],
    earliestCall: allApiMetadata
      .map(m => m.requestTimestamp)
      .sort()[0],
    latestCall: allApiMetadata
      .map(m => m.requestTimestamp)
      .sort()
      .reverse()[0],
    totalInputTokens: allApiMetadata.reduce((sum, m) => sum + m.inputTokens, 0),
    totalOutputTokens: allApiMetadata.reduce((sum, m) => sum + m.outputTokens, 0),
  } : undefined;

  return {
    metadata: {
      version: '1.0.0-prototype',
      timestamp: new Date().toISOString(),
      runId: config.runId,
      ...(config.gitSha ? { gitSha: config.gitSha } : {}),
      mode: config.mode,
      parameters: config,
      ...(provenance ? { provenance } : {}),
      ...(config.judgePanelConfig ? { judgePanelConfig: config.judgePanelConfig } : {}),
      ...(config.errorSummary ? { errorSummary: config.errorSummary } : {}),
    },
    results,
  };
}

/**
 * Write pipeline output to a JSON file.
 */
export function writeOutput(output: PipelineOutput, outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
}

/**
 * Build the human-readable summary as a plain-text string.
 * Shared by printSummary (stderr) and the summary file writer.
 */
export function buildSummaryText(output: PipelineOutput): string {
  const { metadata, results } = output;
  const lines: string[] = [];

  lines.push('');
  lines.push('='.repeat(70));
  lines.push('  AI PULSE — Pipeline Summary');
  lines.push('='.repeat(70));
  lines.push(`  Mode:          ${metadata.mode}`);
  lines.push(`  Run ID:        ${metadata.runId}`);
  if (metadata.gitSha) lines.push(`  Git SHA:       ${metadata.gitSha}`);
  lines.push(`  Timestamp:     ${metadata.timestamp}`);
  lines.push(`  Models:        ${metadata.parameters.modelCount}`);
  lines.push(`  Scenarios:     ${metadata.parameters.scenarioCount}`);
  lines.push(`  Runs/scenario: ${metadata.parameters.runsPerScenarioModel}`);
  lines.push(`  Conversations: ${metadata.parameters.totalConversations}`);
  if (metadata.parameters.failedScoringCount > 0) {
    lines.push(`  SCORING FAILURES: ${metadata.parameters.failedScoringCount} conversation(s) could not be scored`);
  }
  lines.push(`  Judges:        ${metadata.parameters.judgeCount}`);
  lines.push(`  Bootstrap:     ${metadata.parameters.bootstrapResamples} resamples`);
  lines.push('='.repeat(70));

  // Sort by Anthropomorphic Behaviour (descending) for ranking display
  const sorted = [...results].sort(
    (a, b) => b.anthropomorphicBehaviour.mean - a.anthropomorphicBehaviour.mean,
  );

  lines.push('');
  lines.push('  MODEL RANKINGS (by Anthropomorphic Behaviour)');
  lines.push('');
  lines.push(
    '  ' +
    pad('Rank', 6) +
    pad('Model', 26) +
    pad('AB', 24) +
    pad('PC', 24),
  );
  lines.push('  ' + '-'.repeat(78));

  sorted.forEach((model, i) => {
    const bm = formatCI(model.anthropomorphicBehaviour);
    const ba = formatCI(model.proactiveClarification);
    const failNote = model.failedScoringCount > 0
      ? ` (${model.failedScoringCount} failed)`
      : '';
    lines.push(
      '  ' +
      pad(`#${i + 1}`, 6) +
      pad(model.modelName + failNote, 26) +
      pad(bm, 24) +
      pad(ba, 24),
    );
  });

  // Detection rate summary (only shown when detection data is present)
  const hasDetectionRates = results.some(r => r.cueDetectionRates && Object.keys(r.cueDetectionRates).length > 0);
  if (hasDetectionRates) {
    lines.push('');
    lines.push('  CUE DETECTION RATES (proportion of conversations)');
    lines.push('');
    lines.push(
      '  ' +
      pad('Cue', 30) +
      results.map(r => pad(r.modelName, 18)).join(''),
    );
    lines.push('  ' + '-'.repeat(30 + results.length * 18));

    const cues = Object.keys(results[0]?.cueDetectionRates ?? {});
    for (const cue of cues) {
      const cueName = cue.replace(/_/g, ' ');
      const rates = results.map(r => {
        const rateObj = (r.cueDetectionRates as Record<string, { total: number; affirm: number; deny: number; mixed: number }> | undefined)?.[cue];
        const total = rateObj?.total ?? 0;
        const affirm = rateObj?.affirm ?? 0;
        const mixed = rateObj?.mixed ?? 0;
        const deny = rateObj?.deny ?? 0;
        const mixedStr = mixed > 0 ? ` M:${(mixed * 100).toFixed(0)}` : '';
        return pad(`${(total * 100).toFixed(0)}% (A:${(affirm * 100).toFixed(0)}${mixedStr} D:${(deny * 100).toFixed(0)})`, 18);
      });
      lines.push('  ' + pad(cueName, 30) + rates.join(''));
    }
  }

  // Dimension-turn agreement summary (preferred metric)
  const allConvs = results.flatMap(r => r.conversations);
  const totalConvos = allConvs.length;

  // Aggregate dimension-turn agreement across all conversations
  const dtAgg = { total: 0, consensus: 0, nearConsensus: 0, contested: 0, abConsensus: 0, abTotal: 0, pcConsensus: 0, pcTotal: 0 };
  for (const c of allConvs) {
    const dt = c.scores.dimensionTurnAgreement;
    if (dt) {
      dtAgg.total += dt.total;
      dtAgg.consensus += dt.consensus;
      dtAgg.nearConsensus += dt.nearConsensus;
      dtAgg.contested += dt.contested;
      dtAgg.abConsensus += dt.abConsensus;
      dtAgg.abTotal += dt.abTotal;
      dtAgg.pcConsensus += dt.pcConsensus;
      dtAgg.pcTotal += dt.pcTotal;
    }
  }

  lines.push('');
  lines.push('  JUDGE AGREEMENT (dimension-turn level)');
  if (dtAgg.total > 0) {
    const pct = (n: number, d: number) => d > 0 ? ((n / d) * 100).toFixed(1) : '0.0';
    lines.push(`    Consensus:            ${dtAgg.consensus} / ${dtAgg.total} (${pct(dtAgg.consensus, dtAgg.total)}%)`);
    lines.push(`    Near-consensus (+-1):  ${dtAgg.nearConsensus} / ${dtAgg.total} (${pct(dtAgg.nearConsensus, dtAgg.total)}%)`);
    lines.push(`    Contested (>=2):       ${dtAgg.contested} / ${dtAgg.total} (${pct(dtAgg.contested, dtAgg.total)}%)`);
    lines.push(`    AB consensus:          ${dtAgg.abConsensus} / ${dtAgg.abTotal} (${pct(dtAgg.abConsensus, dtAgg.abTotal)}%)`);
    lines.push(`    PC consensus:          ${dtAgg.pcConsensus} / ${dtAgg.pcTotal} (${pct(dtAgg.pcConsensus, dtAgg.pcTotal)}%)`);

    if ((dtAgg.contested / dtAgg.total) > 0.15) {
      lines.push('    WARNING: Contested rate exceeds 15% — review judge calibration');
    }
  } else {
    // Fall back to conversation-level agreement when dimension-turn data is absent
    const consensusCount = allConvs.filter(c => c.scores.agreementLevel === 'consensus' || (!c.scores.agreementLevel && !c.scores.disagreementFlag)).length;
    const nearConsensusCount = allConvs.filter(c => c.scores.agreementLevel === 'near-consensus').length;
    const contestedCount = allConvs.filter(c => c.scores.agreementLevel === 'contested').length;
    lines.push(`    (conversation-level — dimension-turn data not available)`);
    lines.push(`    Consensus:            ${consensusCount} / ${totalConvos} (${totalConvos ? ((consensusCount / totalConvos) * 100).toFixed(1) : 0}%)`);
    lines.push(`    Near-consensus (+-1):  ${nearConsensusCount} / ${totalConvos} (${totalConvos ? ((nearConsensusCount / totalConvos) * 100).toFixed(1) : 0}%)`);
    lines.push(`    Contested (>=2):       ${contestedCount} / ${totalConvos} (${totalConvos ? ((contestedCount / totalConvos) * 100).toFixed(1) : 0}%)`);
    if (totalConvos > 0 && (contestedCount / totalConvos) > 0.3) {
      lines.push('    WARNING: Contested agreement rate exceeds 30% — review judge calibration');
    }
  }

  // Scoring completeness
  const totalScored = results.reduce((s, r) => s + r.conversationCount, 0);
  const totalFailed = results.reduce((s, r) => s + r.failedScoringCount, 0);
  lines.push('');
  lines.push('  SCORING COMPLETENESS');
  lines.push(`    Scored:   ${totalScored} / ${metadata.parameters.totalConversations}`);
  if (totalFailed > 0) {
    lines.push(`    Failed:   ${totalFailed}`);
  }

  // Per-judge mean scores (if judge scores are available)
  const judgeIds = new Set<string>();
  for (const conv of allConvs) {
    for (const js of conv.scores.blendedJudgeScores) {
      judgeIds.add(js.judgeId);
    }
  }
  if (judgeIds.size > 1) {
    lines.push('');
    lines.push('  PER-JUDGE MEANS');
    for (const judgeId of judgeIds) {
      const judgeScores = allConvs.flatMap(c => c.scores.blendedJudgeScores.filter(js => js.judgeId === judgeId));
      if (judgeScores.length === 0) continue;
      const avgAB = judgeScores.reduce((s, j) => s + j.anthropomorphicBehaviour, 0) / judgeScores.length;
      const avgPC = judgeScores.reduce((s, j) => s + j.proactiveClarification, 0) / judgeScores.length;
      lines.push(`    ${pad(judgeId, 28)} AB: ${avgAB.toFixed(2)}  PC: ${avgPC.toFixed(2)}`);
    }
  }

  // Provenance summary (only shown when real API calls were made)
  if (metadata.provenance) {
    const p = metadata.provenance;
    lines.push('');
    lines.push('  API PROVENANCE');
    lines.push(`    API calls:   ${p.apiCallCount}`);
    lines.push(`    Providers:   ${p.providers.join(', ')}`);
    lines.push(`    Time range:  ${p.earliestCall} → ${p.latestCall}`);
    lines.push(`    Tokens:      ${p.totalInputTokens} in / ${p.totalOutputTokens} out`);
  }

  // Error diagnostics (only shown when errors occurred)
  if (metadata.errorSummary && metadata.errorSummary.totalErrors > 0) {
    const es = metadata.errorSummary;
    lines.push('');
    lines.push('  ERROR DIAGNOSTICS');
    for (const [sourceId, info] of Object.entries(es.bySource)) {
      const pct = info.totalCalls > 0 ? ` (${((info.errors / info.totalCalls) * 100).toFixed(1)}%)` : '';
      const cats = Object.entries(info.byCategory).map(([k, v]) => `${k}: ${v}`).join(', ');
      lines.push(`    ${pad(sourceId, 28)} ${info.errors}/${info.totalCalls} failed${pct}  [${cats}]`);
    }
    lines.push(`    Conversations affected:  ${es.conversationsAffected}/${totalConvos}`);
  }

  lines.push('');
  lines.push('='.repeat(70));
  lines.push('  Pipeline complete.');
  lines.push('='.repeat(70));
  lines.push('');

  return lines.join('\n');
}

/**
 * Print a human-readable summary to both stderr and (optionally) a summary file.
 *
 * Writing to stderr ensures the summary is visible even when stdout is redirected
 * or the pipeline is running in the background. The optional archiveDir parameter
 * causes the same text to be written to <archiveDir>/summary.txt for later reference.
 */
export function printSummary(output: PipelineOutput, archiveDir?: string): void {
  const text = buildSummaryText(output);

  // Write to stderr so it's visible even when stdout is redirected or backgrounded
  process.stderr.write(text);

  // Also write to stdout for interactive use (backward compatibility)
  process.stdout.write(text);

  // Write summary file alongside the archived results
  if (archiveDir) {
    try {
      fs.writeFileSync(path.join(archiveDir, 'summary.txt'), text, 'utf-8');
    } catch (err) {
      // Non-fatal — log to stderr so it's visible
      process.stderr.write(`  Warning: could not write summary.txt: ${err}\n`);
    }
  }
}

function formatCI(ci: { lower: number; upper: number; mean: number }): string {
  return `${Math.round(ci.mean)}% [${Math.round(ci.lower)}%, ${Math.round(ci.upper)}%]`;
}

