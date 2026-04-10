// ============================================================================
// AI Pulse — Triage Judge-Subject Bias Matrix
// ============================================================================
//
// Computes per-judge × per-model divergence between audit scores and
// individual judge scores. This decomposes the panel-level divergence
// reported by audit-report.ts into per-judge signal, revealing whether
// specific judges are systematically lenient or strict on specific models.

import { AuditResult } from '../audit-run/report';
import { PipelineOutput, ConversationResult, JudgeScore } from '../types';
import { BiasCell, BiasMatrix } from './types';
import { minBlend, AB_ALPHA, PC_ALPHA } from '../scoring/aggregation';

// --- Per-Judge Conversation Score Derivation ---

/**
 * For each unique judge in the per-turn scores, extract that judge's BM/RA
 * values per turn and apply minBlend to get conversation-level scores.
 *
 * Returns a map from judgeId to { bm, ra } blended scores.
 */
export function derivePerJudgeConversationScores(
  perTurnScores: Array<{ turnIndex: number; judgeScores: JudgeScore[] }>,
  bmAlpha: number = AB_ALPHA,
  raAlpha: number = PC_ALPHA,
): Map<string, { bm: number; ra: number }> {
  const result = new Map<string, { bm: number; ra: number }>();

  if (!perTurnScores || perTurnScores.length === 0) {
    return result;
  }

  // Collect all unique judge IDs across all turns
  const judgeIds = new Set<string>();
  for (const turn of perTurnScores) {
    for (const js of turn.judgeScores) {
      judgeIds.add(js.judgeId);
    }
  }

  // For each judge, extract their per-turn scores and apply minBlend
  for (const judgeId of judgeIds) {
    const bmValues: number[] = [];
    const raValues: number[] = [];

    for (const turn of perTurnScores) {
      const judgeScore = turn.judgeScores.find(js => js.judgeId === judgeId);
      if (judgeScore) {
        bmValues.push(judgeScore.anthropomorphicBehaviour);
        raValues.push(judgeScore.proactiveClarification);
      }
    }

    if (bmValues.length > 0) {
      result.set(judgeId, {
        bm: minBlend(bmValues, bmAlpha),
        ra: minBlend(raValues, raAlpha),
      });
    }
  }

  return result;
}

// --- Bias Matrix Computation ---

/**
 * Build a judge × model bias matrix by comparing audit pass1 scores
 * against individual judge blended scores.
 *
 * For each audit result:
 * 1. Find the matching conversation in pipelineOutput by conversationId
 * 2. Derive per-judge conversation-level scores via minBlend
 * 3. Compute signed divergence: audit_pass1 - judge_blended
 * 4. Group by judge × model and compute means
 */
export function computeBiasMatrix(
  auditResults: AuditResult[],
  pipelineOutput: PipelineOutput,
  bmAlpha: number = AB_ALPHA,
  raAlpha: number = PC_ALPHA,
): BiasMatrix | null {
  if (auditResults.length === 0) {
    return null;
  }

  // Build a lookup from conversationId to ConversationResult
  const convLookup = new Map<string, ConversationResult>();
  for (const modelResults of pipelineOutput.results) {
    for (const conv of modelResults.conversations) {
      convLookup.set(conv.conversationId, conv);
    }
  }

  // Accumulate divergences per judge × model
  // Key: `${judgeId}::${modelId}`
  const accum = new Map<string, {
    judgeId: string;
    modelId: string;
    modelName: string;
    abDivSum: number;
    pcDivSum: number;
    count: number;
  }>();

  const judgeIdSet = new Set<string>();
  const modelSet = new Map<string, string>(); // modelId -> modelName

  for (const audit of auditResults) {
    const conv = convLookup.get(audit.conversationId);
    if (!conv || !conv.scores.perTurnScores || conv.scores.perTurnScores.length === 0) {
      continue;
    }

    const perJudge = derivePerJudgeConversationScores(
      conv.scores.perTurnScores,
      bmAlpha,
      raAlpha,
    );

    for (const [judgeId, judgeScores] of perJudge) {
      const key = `${judgeId}::${audit.modelId}`;
      const abDiv = audit.pass1AB - judgeScores.bm;
      const raDiv = audit.pass1PC - judgeScores.ra;

      judgeIdSet.add(judgeId);
      modelSet.set(audit.modelId, audit.modelName);

      const existing = accum.get(key);
      if (existing) {
        existing.abDivSum += abDiv;
        existing.pcDivSum += raDiv;
        existing.count++;
      } else {
        accum.set(key, {
          judgeId,
          modelId: audit.modelId,
          modelName: audit.modelName,
          abDivSum: abDiv,
          pcDivSum: raDiv,
          count: 1,
        });
      }
    }
  }

  // Convert accumulator to BiasCell array
  const cells: BiasCell[] = [];
  for (const data of accum.values()) {
    cells.push({
      judgeId: data.judgeId,
      modelId: data.modelId,
      modelName: data.modelName,
      meanABDiv: data.abDivSum / data.count,
      meanPCDiv: data.pcDivSum / data.count,
      count: data.count,
    });
  }

  if (cells.length === 0) {
    return null;
  }

  // Compute judge baselines
  const judgeBaselines = computeJudgeBaselines(cells);

  return {
    judges: Array.from(judgeIdSet).sort(),
    models: Array.from(modelSet.entries())
      .map(([modelId, modelName]) => ({ modelId, modelName }))
      .sort((a, b) => a.modelId.localeCompare(b.modelId)),
    cells,
    judgeBaselines,
  };
}

// --- Judge Baselines ---

/**
 * Compute the mean divergence per judge across all models.
 * This is the judge's overall bias direction: positive = audit scores higher
 * than this judge (judge is stricter), negative = audit scores lower (judge
 * is more lenient).
 */
export function computeJudgeBaselines(
  cells: BiasCell[],
): Record<string, { meanABDiv: number; meanPCDiv: number }> {
  const accum = new Map<string, { abDivSum: number; pcDivSum: number; totalCount: number }>();

  for (const cell of cells) {
    const existing = accum.get(cell.judgeId);
    if (existing) {
      existing.abDivSum += cell.meanABDiv * cell.count;
      existing.pcDivSum += cell.meanPCDiv * cell.count;
      existing.totalCount += cell.count;
    } else {
      accum.set(cell.judgeId, {
        abDivSum: cell.meanABDiv * cell.count,
        pcDivSum: cell.meanPCDiv * cell.count,
        totalCount: cell.count,
      });
    }
  }

  const result: Record<string, { meanABDiv: number; meanPCDiv: number }> = {};
  for (const [judgeId, data] of accum) {
    result[judgeId] = {
      meanABDiv: data.abDivSum / data.totalCount,
      meanPCDiv: data.pcDivSum / data.totalCount,
    };
  }

  return result;
}
