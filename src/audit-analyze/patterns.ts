// ============================================================================
// AI Pulse — Triage Pattern Detection
// ============================================================================
//
// Computes divergences between audit and panel scores, detects diagnostic
// patterns (CALIB-HURT, DIRECTION-FLIP, RUBRIC-PROBLEM, etc.), and builds
// the ranked flagged-conversation list used by the triage report.

import { AuditResult } from '../audit-run/report';
import {
  PatternFlag,
  FlaggedConversation,
  ScoreLevelAbsence,
  TurnDivergenceDistribution,
} from './types';

// ---- Divergence computation ----

// Export the Divergences interface so downstream consumers always work with
// null-normalized pass2 values (AuditResult uses undefined, we convert to null).
export interface Divergences {
  pass1ABDiv: number;
  pass1PCDiv: number;
  pass1TotalDiv: number;
  pass2ABDiv: number | null;
  pass2PCDiv: number | null;
  pass2TotalDiv: number | null;
}

export function computeDivergences(result: AuditResult): Divergences {
  const pass1ABDiv = result.pass1AB - result.panelAB;
  const pass1PCDiv = result.pass1PC - result.panelPC;
  const pass1TotalDiv = Math.abs(pass1ABDiv) + Math.abs(pass1PCDiv);

  let pass2ABDiv: number | null = null;
  let pass2PCDiv: number | null = null;
  let pass2TotalDiv: number | null = null;

  if (result.pass2AB !== undefined && result.pass2PC !== undefined) {
    pass2ABDiv = result.pass2AB - result.panelAB;
    pass2PCDiv = result.pass2PC - result.panelPC;
    pass2TotalDiv = Math.abs(pass2ABDiv) + Math.abs(pass2PCDiv);
  }

  return { pass1ABDiv, pass1PCDiv, pass1TotalDiv, pass2ABDiv, pass2PCDiv, pass2TotalDiv };
}

// ---- Pattern detection ----

export function detectPatterns(div: Divergences, patternThreshold: number): PatternFlag[] {
  const flags: PatternFlag[] = [];

  const p1BMAgrees = Math.abs(div.pass1ABDiv) <= patternThreshold;
  const p1RAAgrees = Math.abs(div.pass1PCDiv) <= patternThreshold;
  const p1Agrees = p1BMAgrees && p1RAAgrees;

  let p2Agrees: boolean | null = null;
  if (div.pass2ABDiv !== null && div.pass2PCDiv !== null) {
    const p2BMAgrees = Math.abs(div.pass2ABDiv) <= patternThreshold;
    const p2RAAgrees = Math.abs(div.pass2PCDiv) <= patternThreshold;
    p2Agrees = p2BMAgrees && p2RAAgrees;
  }

  // CALIB-HURT: pass2 total divergence > pass1 total divergence
  if (div.pass2TotalDiv !== null && div.pass2TotalDiv > div.pass1TotalDiv) {
    flags.push('CALIB-HURT');
  }

  // DIRECTION-FLIP: pass1 and pass2 divergence have opposite signs on BM or RA
  if (div.pass2ABDiv !== null && div.pass2PCDiv !== null) {
    if ((div.pass1ABDiv > 0 && div.pass2ABDiv < 0) || (div.pass1ABDiv < 0 && div.pass2ABDiv > 0)) {
      flags.push('DIRECTION-FLIP');
    } else if ((div.pass1PCDiv > 0 && div.pass2PCDiv < 0) || (div.pass1PCDiv < 0 && div.pass2PCDiv > 0)) {
      if (!flags.includes('DIRECTION-FLIP')) flags.push('DIRECTION-FLIP');
    }
  }

  // 2x2 patterns (only when pass2 exists)
  if (p2Agrees !== null) {
    if (p1Agrees && !p2Agrees) flags.push('RUBRIC-PROBLEM');
    if (!p1Agrees && p2Agrees) flags.push('JUDGE-QUALITY');
    if (!p1Agrees && !p2Agrees) flags.push('BOTH-DIVERGE');
  }

  // DIMENSION-SPLIT: one dimension agrees, other diverges (using pattern threshold)
  if ((p1BMAgrees && !p1RAAgrees) || (!p1BMAgrees && p1RAAgrees)) {
    flags.push('DIMENSION-SPLIT');
  }

  return flags;
}

// ---- Late collapse detection (needs per-turn data) ----

export function detectLateCollapse(
  result: AuditResult,
  panelPerTurn: Array<{ bm: number; ra: number }>,
): boolean {
  const auditPerTurn = result.pass1PerTurn;
  if (!auditPerTurn || auditPerTurn.length === 0 || panelPerTurn.length === 0) return false;

  const lastIdx = auditPerTurn.length - 1;
  let totalDiv = 0;
  let lastTurnDiv = 0;

  for (let i = 0; i < auditPerTurn.length && i < panelPerTurn.length; i++) {
    const bmDiv = Math.abs(auditPerTurn[i].anthropomorphicBehaviour - panelPerTurn[i].bm);
    const raDiv = Math.abs(auditPerTurn[i].proactiveClarification - panelPerTurn[i].ra);
    const turnDiv = bmDiv + raDiv;
    totalDiv += turnDiv;
    if (i === lastIdx) lastTurnDiv = turnDiv;
  }

  return totalDiv > 0 && (lastTurnDiv / totalDiv) > 0.6;
}

// ---- Score level absence ----

export function detectScoreLevelAbsences(
  results: AuditResult[],
  panelPerTurnData: Map<string, Array<Array<{ bm: number; ra: number }>>>,
): ScoreLevelAbsence[] {
  const auditBMLevels = new Set<number>();
  const auditRALevels = new Set<number>();
  const panelBMLevels = new Set<number>();
  const panelRALevels = new Set<number>();

  for (const r of results) {
    for (const turn of r.pass1PerTurn || []) {
      auditBMLevels.add(Math.round(turn.anthropomorphicBehaviour));
      auditRALevels.add(Math.round(turn.proactiveClarification));
    }
  }

  for (const turns of panelPerTurnData.values()) {
    for (const judgeTurns of turns) {
      for (const t of judgeTurns) {
        panelBMLevels.add(Math.round(t.bm));
        panelRALevels.add(Math.round(t.ra));
      }
    }
  }

  const absences: ScoreLevelAbsence[] = [];
  for (const level of [0, 1, 2, 3] as const) {
    const auditMissesBM = !auditBMLevels.has(level);
    const panelMissesBM = !panelBMLevels.has(level);
    if (auditMissesBM || panelMissesBM) {
      absences.push({
        dimension: 'ab',
        level,
        source: auditMissesBM && panelMissesBM ? 'both' : auditMissesBM ? 'audit' : 'panel',
      });
    }

    const auditMissesRA = !auditRALevels.has(level);
    const panelMissesRA = !panelRALevels.has(level);
    if (auditMissesRA || panelMissesRA) {
      absences.push({
        dimension: 'pc',
        level,
        source: auditMissesRA && panelMissesRA ? 'both' : auditMissesRA ? 'audit' : 'panel',
      });
    }
  }

  return absences;
}

// ---- Build flagged conversation list ----

export function buildFlaggedConversations(
  results: AuditResult[],
  patternThreshold: number,
  panelPerTurnByConv: Map<string, Array<{ bm: number; ra: number }>>,
  panelInternalSplits: Set<string>,
): FlaggedConversation[] {
  return results.map(result => {
    const div = computeDivergences(result);
    const flags = detectPatterns(div, patternThreshold);

    // Late collapse
    const panelPerTurn = panelPerTurnByConv.get(result.conversationId);
    if (panelPerTurn && detectLateCollapse(result, panelPerTurn)) {
      flags.push('LATE-COLLAPSE-DISAGREEMENT');
    }

    // Panel internal split (computed externally from per-judge data)
    if (panelInternalSplits.has(result.conversationId)) {
      flags.push('PANEL-INTERNAL-SPLIT');
    }

    return {
      result,
      flags,
      pass1TotalDiv: div.pass1TotalDiv,
      pass2TotalDiv: div.pass2TotalDiv,
      pass1ABDiv: div.pass1ABDiv,
      pass1PCDiv: div.pass1PCDiv,
      pass2ABDiv: div.pass2ABDiv,
      pass2PCDiv: div.pass2PCDiv,
    };
  }).sort((a, b) => b.pass1TotalDiv - a.pass1TotalDiv);
}

// ---- Per-turn divergence distribution ----

export function computeTurnDivergenceDistribution(
  results: AuditResult[],
  panelPerTurnByConv: Map<string, Array<{ bm: number; ra: number }>>,
): TurnDivergenceDistribution {
  const bmByTurn = new Map<number, number[]>();
  const raByTurn = new Map<number, number[]>();

  for (const result of results) {
    const panelPerTurn = panelPerTurnByConv.get(result.conversationId);
    if (!panelPerTurn || !result.pass1PerTurn) continue;

    for (let i = 0; i < result.pass1PerTurn.length && i < panelPerTurn.length; i++) {
      const bmDiv = Math.abs(result.pass1PerTurn[i].anthropomorphicBehaviour - panelPerTurn[i].bm);
      const raDiv = Math.abs(result.pass1PerTurn[i].proactiveClarification - panelPerTurn[i].ra);

      if (!bmByTurn.has(i)) bmByTurn.set(i, []);
      if (!raByTurn.has(i)) raByTurn.set(i, []);
      bmByTurn.get(i)!.push(bmDiv);
      raByTurn.get(i)!.push(raDiv);
    }
  }

  const toEntries = (m: Map<number, number[]>) =>
    Array.from(m.entries())
      .sort(([a], [b]) => a - b)
      .map(([turnIndex, vals]) => ({
        turnIndex,
        meanAbsDiv: vals.reduce((a, b) => a + b, 0) / vals.length,
        totalAbsDiv: vals.reduce((a, b) => a + b, 0),
        count: vals.length,
      }));

  return { bm: toEntries(bmByTurn), ra: toEntries(raByTurn) };
}
