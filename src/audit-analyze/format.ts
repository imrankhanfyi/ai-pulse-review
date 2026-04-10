// ============================================================================
// AI Pulse — Triage Report Formatter
// ============================================================================
//
// Produces human-readable text output from a TriageReport.
// Follows the formatting conventions from audit-report.ts:formatSummary().

import {
  TriageReport,
  PatternFlag,
  FlaggedConversation,
  Dossier,
  CalibrationEffectiveness,
  BiasMatrix,
  TurnDivergenceDistribution,
  ScoreLevelAbsence,
} from './types';

// --- Formatting Helpers ---

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function fmtDiv(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

function fmtDivOrNA(value: number | null): string {
  if (value === null) return 'N/A';
  return fmtDiv(value);
}

const ALL_FLAGS: PatternFlag[] = [
  'CALIB-HURT',
  'DIRECTION-FLIP',
  'RUBRIC-PROBLEM',
  'JUDGE-QUALITY',
  'BOTH-DIVERGE',
  'LATE-COLLAPSE-DISAGREEMENT',
  'DIMENSION-SPLIT',
  'PANEL-INTERNAL-SPLIT',
  'SCORE-LEVEL-ABSENCE',
];

// --- Main Formatter ---

export function formatTriageReport(report: TriageReport): string {
  const lines: string[] = [];
  const push = (line = '') => lines.push(line);

  // 1. Header
  formatHeader(report, push);

  // 2. Pattern Summary
  formatPatternSummary(report, push);

  // 3. Calibration Effectiveness (conditional)
  if (report.calibrationEffectiveness !== null) {
    formatCalibrationEffectiveness(report.calibrationEffectiveness, push);
  }

  // 4. Bias Matrix (conditional)
  if (report.biasMatrix !== null) {
    formatBiasMatrix(report.biasMatrix, push);
  }

  // 5. Per-Turn Divergence
  formatTurnDivergence(report.turnDivergence, push);

  // 6. Score Level Absences
  formatScoreLevelAbsences(report.scoreLevelAbsences, push);

  // 7. Ranked Divergence Table
  formatRankedTable(report.rankedTable, push);

  // 8. Conversation Dossiers
  formatDossiers(report.dossiers, push);

  // Footer
  push('='.repeat(70));
  push('  Triage report complete.');
  push('='.repeat(70));
  push('');

  return lines.join('\n');
}

// --- Section Formatters ---

function formatHeader(report: TriageReport, push: (line?: string) => void): void {
  const m = report.metadata;
  push('='.repeat(70));
  push('  AI PULSE — Triage Report');
  push('='.repeat(70));
  push(`  Audit dir:      ${m.auditDir}`);
  push(`  Results path:   ${m.resultsPath}`);
  push(`  Timestamp:      ${m.timestamp}`);
  push(`  Conversations:  ${m.conversationCount}`);
  push(`  Threshold:      ${m.threshold}`);
  push(`  Pattern thr:    ${m.patternThreshold}`);
  push('='.repeat(70));
}

function formatPatternSummary(report: TriageReport, push: (line?: string) => void): void {
  push('');
  push('  PATTERN SUMMARY');
  push('  ' + '-'.repeat(50));

  for (const flag of ALL_FLAGS) {
    const count = report.patternSummary[flag] ?? 0;
    push('  ' + pad(flag, 34) + String(count));
  }
}

function formatCalibrationEffectiveness(
  cal: CalibrationEffectiveness,
  push: (line?: string) => void,
): void {
  push('');
  push('  CALIBRATION EFFECTIVENESS');
  push('  ' + '-'.repeat(50));
  push(`  Closer to panel:     ${cal.closerToPanel}`);
  push(`  Further from panel:  ${cal.furtherFromPanel}`);
  push(`  Unchanged:           ${cal.unchanged}`);
  push(`  Mean abs change:     ${cal.meanAbsChange.toFixed(3)}`);
  push(`  Mean AB shift:       ${fmtDiv(cal.meanABShift)}`);
  push(`  Mean PC shift:       ${fmtDiv(cal.meanPCShift)}`);
}

function formatBiasMatrix(bias: BiasMatrix, push: (line?: string) => void): void {
  push('');
  push('  BIAS MATRIX (judge x model divergence)');
  push('  ' + '-'.repeat(68));

  // Header row
  const modelColWidth = 22;
  const cellWidth = 16;

  push(
    '  ' +
    pad('Judge', modelColWidth) +
    pad('Model', modelColWidth) +
    pad('AB Div', cellWidth) +
    pad('PC Div', cellWidth) +
    'N',
  );
  push('  ' + '-'.repeat(68));

  for (const cell of bias.cells) {
    push(
      '  ' +
      pad(cell.judgeId, modelColWidth) +
      pad(cell.modelName, modelColWidth) +
      pad(fmtDiv(cell.meanABDiv), cellWidth) +
      pad(fmtDiv(cell.meanPCDiv), cellWidth) +
      String(cell.count),
    );
  }

  // Judge baselines
  if (Object.keys(bias.judgeBaselines).length > 0) {
    push('');
    push('  Judge baselines (mean divergence across all models):');
    for (const [judgeId, baseline] of Object.entries(bias.judgeBaselines)) {
      push(
        '    ' +
        pad(judgeId, 24) +
        'AB: ' + pad(fmtDiv(baseline.meanABDiv), 10) +
        'PC: ' + fmtDiv(baseline.meanPCDiv),
      );
    }
  }
}

function formatTurnDivergence(
  td: TurnDivergenceDistribution,
  push: (line?: string) => void,
): void {
  push('');
  push('  PER-TURN DIVERGENCE');
  push('  ' + '-'.repeat(50));

  if (td.bm.length === 0 && td.ra.length === 0) {
    push('  (no per-turn data)');
    return;
  }

  // AB table
  if (td.bm.length > 0) {
    push('');
    push('  AB (Anthropomorphic Behaviour):');
    push(
      '    ' +
      pad('Turn', 8) +
      pad('Mean |Div|', 14) +
      pad('Total |Div|', 14) +
      'N',
    );
    push('    ' + '-'.repeat(42));
    for (const entry of td.bm) {
      push(
        '    ' +
        pad(String(entry.turnIndex), 8) +
        pad(entry.meanAbsDiv.toFixed(3), 14) +
        pad(entry.totalAbsDiv.toFixed(3), 14) +
        String(entry.count),
      );
    }
  }

  // PC table
  if (td.ra.length > 0) {
    push('');
    push('  PC (Proactive Clarification):');
    push(
      '    ' +
      pad('Turn', 8) +
      pad('Mean |Div|', 14) +
      pad('Total |Div|', 14) +
      'N',
    );
    push('    ' + '-'.repeat(42));
    for (const entry of td.ra) {
      push(
        '    ' +
        pad(String(entry.turnIndex), 8) +
        pad(entry.meanAbsDiv.toFixed(3), 14) +
        pad(entry.totalAbsDiv.toFixed(3), 14) +
        String(entry.count),
      );
    }
  }
}

function formatScoreLevelAbsences(
  absences: ScoreLevelAbsence[],
  push: (line?: string) => void,
): void {
  push('');
  push('  SCORE LEVEL ABSENCES');
  push('  ' + '-'.repeat(50));

  if (absences.length === 0) {
    push('  (none)');
    return;
  }

  for (const a of absences) {
    const dim = a.dimension.toUpperCase();
    push(`  ${dim} level ${a.level} — absent in: ${a.source}`);
  }
}

function formatRankedTable(
  ranked: FlaggedConversation[],
  push: (line?: string) => void,
): void {
  push('');
  push('  RANKED DIVERGENCE TABLE');
  push('  ' + '-'.repeat(94));

  if (ranked.length === 0) {
    push('  (no conversations)');
    return;
  }

  const idWidth = 36;
  const modelWidth = 22;
  const divWidth = 12;
  push(
    '  ' +
    pad('Conversation ID', idWidth) +
    pad('Model', modelWidth) +
    pad('P1 Total', divWidth) +
    pad('AB Div', divWidth) +
    pad('PC Div', divWidth) +
    'Flags',
  );
  push('  ' + '-'.repeat(94));

  for (const fc of ranked) {
    const flagStr = fc.flags.length > 0 ? fc.flags.join(', ') : '';
    push(
      '  ' +
      pad(fc.result.conversationId, idWidth) +
      pad(fc.result.modelName, modelWidth) +
      pad(fc.pass1TotalDiv.toFixed(2), divWidth) +
      pad(fmtDiv(fc.pass1ABDiv), divWidth) +
      pad(fmtDiv(fc.pass1PCDiv), divWidth) +
      flagStr,
    );
  }
}

function formatDossiers(dossiers: Dossier[], push: (line?: string) => void): void {
  if (dossiers.length === 0) return;

  push('');
  push('='.repeat(70));
  push('  CONVERSATION DOSSIERS');
  push('='.repeat(70));

  for (let i = 0; i < dossiers.length; i++) {
    const d = dossiers[i];
    push('');
    push('-'.repeat(70));
    push(`  Dossier ${i + 1}/${dossiers.length}: ${d.conversationId}`);
    push('-'.repeat(70));
    push(`  Model:      ${d.modelName}`);
    push(`  Scenario:   ${d.scenarioId}`);
    push(`  Category:   ${d.category}`);
    push(`  Flags:      ${d.flags.length > 0 ? d.flags.join(', ') : '(none)'}`);
    push(`  Panel:      AB ${d.panelAB.toFixed(2)} / PC ${d.panelPC.toFixed(2)}`);
    push(`  Pass 1:     AB ${d.pass1AB.toFixed(2)} / PC ${d.pass1PC.toFixed(2)}`);
    if (d.pass2AB !== null && d.pass2PC !== null) {
      push(`  Pass 2:     AB ${d.pass2AB.toFixed(2)} / PC ${d.pass2PC.toFixed(2)}`);
    }
    push(`  Calibration match: ${d.calibrationMatch ? 'yes' : 'no'}`);

    // Messages
    push('');
    push('  Messages:');
    for (const msg of d.messages) {
      const roleLabel = msg.role.toUpperCase();
      push(`    [${roleLabel}]`);
      // Indent message content, wrapping long lines
      const contentLines = msg.content.split('\n');
      for (const line of contentLines) {
        push(`      ${line}`);
      }
    }

    // Per-turn scores
    if (d.perTurnScores.length > 0) {
      push('');
      push('  Per-Turn Scores:');
      for (const turn of d.perTurnScores) {
        push(`    Turn ${turn.turnIndex}:`);
        push(`      Panel:  AB ${turn.panelAB.toFixed(2)} / PC ${turn.panelPC.toFixed(2)}`);

        for (const judge of turn.perJudge) {
          push(`      ${pad(judge.judgeId + ':', 20)} AB ${judge.bm.toFixed(2)} / PC ${judge.ra.toFixed(2)}`);
        }

        push(`      Pass 1: AB ${turn.pass1AB.toFixed(2)} / PC ${turn.pass1PC.toFixed(2)}`);
        if (turn.pass1Rationale) {
          push(`        Rationale: ${turn.pass1Rationale}`);
        }

        if (turn.pass2AB !== null && turn.pass2PC !== null) {
          push(`      Pass 2: AB ${turn.pass2AB.toFixed(2)} / PC ${turn.pass2PC.toFixed(2)}`);
          if (turn.pass2Rationale) {
            push(`        Rationale: ${turn.pass2Rationale}`);
          }
        }
      }
    }
  }
}
