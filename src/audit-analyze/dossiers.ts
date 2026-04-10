// ============================================================================
// AI Pulse — Triage Conversation Dossiers
// ============================================================================
//
// Builds detailed dossier objects for the top-N flagged conversations.
// Each dossier includes the original messages, per-turn panel scores with
// per-judge breakdown, audit pass1/pass2 per-turn scores with rationales,
// and calibration match information.

import { Dossier, FlaggedConversation } from './types';
import { PipelineOutput, ConversationResult } from '../types';

/**
 * Build conversation dossiers for the top N flagged conversations.
 *
 * For each flagged conversation (sorted by pass1TotalDiv descending), finds
 * the original ConversationResult in pipelineOutput, extracts messages,
 * panel per-turn scores with per-judge breakdown, and audit per-turn scores
 * with rationales from both passes.
 *
 * @param topN - Maximum number of dossiers to produce
 * @param flaggedConversations - Ranked flagged conversations (pre-sorted or will be sorted)
 * @param pipelineOutput - Full pipeline output to look up conversations
 * @param calibrationConvIds - Optional set of conversation IDs that appear in calibration data
 */
export function buildDossiers(
  topN: number,
  flaggedConversations: FlaggedConversation[],
  pipelineOutput: PipelineOutput,
  calibrationConvIds?: Set<string>,
): Dossier[] {
  // Sort by pass1TotalDiv descending
  const sorted = [...flaggedConversations].sort(
    (a, b) => b.pass1TotalDiv - a.pass1TotalDiv,
  );

  // Build a lookup map: conversationId -> ConversationResult
  const convMap = new Map<string, ConversationResult>();
  for (const modelResult of pipelineOutput.results) {
    for (const conv of modelResult.conversations) {
      convMap.set(conv.conversationId, conv);
    }
  }

  const dossiers: Dossier[] = [];

  for (const flagged of sorted) {
    if (dossiers.length >= topN) break;

    const audit = flagged.result;
    const conv = convMap.get(audit.conversationId);

    // Skip gracefully if conversation not found in pipeline output
    if (!conv) continue;

    // Extract messages
    const messages = conv.messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    // Build per-turn scores
    const perTurnScores = buildPerTurnScores(conv, audit);

    const dossier: Dossier = {
      conversationId: audit.conversationId,
      modelName: audit.modelName,
      scenarioId: audit.scenarioId,
      category: audit.category,
      flags: flagged.flags,
      messages,
      perTurnScores,
      panelAB: audit.panelAB,
      panelPC: audit.panelPC,
      pass1AB: audit.pass1AB,
      pass1PC: audit.pass1PC,
      pass2AB: audit.pass2AB ?? null,
      pass2PC: audit.pass2PC ?? null,
      calibrationMatch: calibrationConvIds?.has(audit.conversationId) ?? false,
    };

    dossiers.push(dossier);
  }

  return dossiers;
}

/**
 * Build per-turn score entries by merging panel per-turn data with
 * audit pass1/pass2 per-turn data.
 */
function buildPerTurnScores(
  conv: ConversationResult,
  audit: { pass1PerTurn: Array<{ turnIndex: number; anthropomorphicBehaviour: number; proactiveClarification: number; rationale: string }>; pass2PerTurn?: Array<{ turnIndex: number; anthropomorphicBehaviour: number; proactiveClarification: number; rationale: string }> },
): Dossier['perTurnScores'] {
  // Collect all turn indices from panel and audit data
  const turnIndices = new Set<number>();

  const panelTurns = conv.scores.perTurnScores ?? [];
  for (const pt of panelTurns) {
    turnIndices.add(pt.turnIndex);
  }
  for (const at of audit.pass1PerTurn) {
    turnIndices.add(at.turnIndex);
  }
  if (audit.pass2PerTurn) {
    for (const at of audit.pass2PerTurn) {
      turnIndices.add(at.turnIndex);
    }
  }

  const sortedIndices = [...turnIndices].sort((a, b) => a - b);

  // Index panel turns and audit turns by turnIndex for O(1) lookup
  const panelByTurn = new Map(panelTurns.map(t => [t.turnIndex, t]));
  const pass1ByTurn = new Map(audit.pass1PerTurn.map(t => [t.turnIndex, t]));
  type AuditTurn = { turnIndex: number; anthropomorphicBehaviour: number; proactiveClarification: number; rationale: string };
  const pass2ByTurn: Map<number, AuditTurn> = audit.pass2PerTurn
    ? new Map(audit.pass2PerTurn.map(t => [t.turnIndex, t]))
    : new Map();

  return sortedIndices.map(ti => {
    const panelTurn = panelByTurn.get(ti);
    const pass1Turn = pass1ByTurn.get(ti);
    const pass2Turn = pass2ByTurn.get(ti);

    // Panel BM/RA: average across judges for this turn
    let panelAB = 0;
    let panelPC = 0;
    const perJudge: Array<{ judgeId: string; bm: number; ra: number }> = [];

    if (panelTurn) {
      const js = panelTurn.judgeScores;
      for (const j of js) {
        perJudge.push({
          judgeId: j.judgeId,
          bm: j.anthropomorphicBehaviour,
          ra: j.proactiveClarification,
        });
      }
      if (js.length > 0) {
        panelAB = js.reduce((s, j) => s + j.anthropomorphicBehaviour, 0) / js.length;
        panelPC = js.reduce((s, j) => s + j.proactiveClarification, 0) / js.length;
      }
    }

    return {
      turnIndex: ti,
      panelAB,
      panelPC,
      perJudge,
      pass1AB: pass1Turn?.anthropomorphicBehaviour ?? 0,
      pass1PC: pass1Turn?.proactiveClarification ?? 0,
      pass1Rationale: pass1Turn?.rationale ?? '',
      pass2AB: pass2Turn?.anthropomorphicBehaviour ?? null,
      pass2PC: pass2Turn?.proactiveClarification ?? null,
      pass2Rationale: pass2Turn?.rationale ?? null,
    };
  });
}
