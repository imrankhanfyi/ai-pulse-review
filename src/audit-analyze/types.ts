// ============================================================================
// AI Pulse — Triage Shared Type Definitions
// ============================================================================

import { AuditResult } from '../audit-run/report';

// ---- Pattern flags ----

export type PatternFlag =
  | 'CALIB-HURT'
  | 'DIRECTION-FLIP'
  | 'RUBRIC-PROBLEM'
  | 'JUDGE-QUALITY'
  | 'BOTH-DIVERGE'
  | 'LATE-COLLAPSE-DISAGREEMENT'
  | 'DIMENSION-SPLIT'
  | 'PANEL-INTERNAL-SPLIT'
  | 'SCORE-LEVEL-ABSENCE';

export interface FlaggedConversation {
  result: AuditResult;
  flags: PatternFlag[];
  pass1TotalDiv: number;   // |BM div| + |RA div|
  pass2TotalDiv: number | null;
  pass1ABDiv: number;      // signed: audit - panel
  pass1PCDiv: number;
  pass2ABDiv: number | null;
  pass2PCDiv: number | null;
}

// ---- Calibration effectiveness ----

export interface CalibrationEffectiveness {
  meanABShift: number;    // mean signed (pass2 - pass1) on BM
  meanPCShift: number;
  closerToPanel: number;  // count of convs where pass2 moved closer
  furtherFromPanel: number;
  unchanged: number;
  meanAbsChange: number;  // mean of |pass2TotalDiv - pass1TotalDiv|
}

// ---- Bias matrix ----

export interface BiasCell {
  judgeId: string;
  modelId: string;
  modelName: string;
  meanABDiv: number;      // signed: audit - judge
  meanPCDiv: number;
  count: number;
}

export interface BiasMatrix {
  judges: string[];
  models: Array<{ modelId: string; modelName: string }>;
  cells: BiasCell[];
  judgeBaselines: Record<string, { meanABDiv: number; meanPCDiv: number }>;
}

// ---- Per-turn distribution ----

export interface TurnDivergenceDistribution {
  bm: Array<{ turnIndex: number; meanAbsDiv: number; totalAbsDiv: number; count: number }>;
  ra: Array<{ turnIndex: number; meanAbsDiv: number; totalAbsDiv: number; count: number }>;
}

// ---- Conversation dossier ----

export interface Dossier {
  conversationId: string;
  modelName: string;
  scenarioId: string;
  category: string;
  flags: PatternFlag[];
  messages: Array<{ role: string; content: string }>;
  perTurnScores: Array<{
    turnIndex: number;
    panelAB: number;
    panelPC: number;
    perJudge: Array<{ judgeId: string; bm: number; ra: number }>;
    pass1AB: number;
    pass1PC: number;
    pass1Rationale: string;
    pass2AB: number | null;
    pass2PC: number | null;
    pass2Rationale: string | null;
  }>;
  panelAB: number;
  panelPC: number;
  pass1AB: number;
  pass1PC: number;
  pass2AB: number | null;
  pass2PC: number | null;
  calibrationMatch: boolean;  // true if this model/scenario appears in calibration data
}

// ---- Score level absence ----

export interface ScoreLevelAbsence {
  dimension: 'ab' | 'pc';
  level: 0 | 1 | 2 | 3;
  source: 'audit' | 'panel' | 'both';
}

// ---- Full triage report ----

export interface TriageReport {
  metadata: {
    auditDir: string;
    resultsPath: string;
    timestamp: string;
    conversationCount: number;
    threshold: number;
    patternThreshold: number;
  };
  rankedTable: FlaggedConversation[];
  patternSummary: Record<PatternFlag, number>;  // count per flag
  scoreLevelAbsences: ScoreLevelAbsence[];
  calibrationEffectiveness: CalibrationEffectiveness | null;
  biasMatrix: BiasMatrix | null;
  turnDivergence: TurnDivergenceDistribution;
  dossiers: Dossier[];
}

// ---- Findings ----

export type FindingCategory =
  | 'rubric-gap'
  | 'rubric-ambiguity'
  | 'judge-leniency'
  | 'judge-strictness'
  | 'auditor-error'
  | 'noise'
  | 'needs-more-data';

export interface Finding {
  id: string;
  timestamp: string;
  auditRunId: string;
  category: FindingCategory;
  dimensions: ('ab' | 'pc')[];
  severity: 'high' | 'medium' | 'low';
  evidence: {
    conversationIds: string[];
    pattern?: string;
    scores: Array<{
      panelAB: number;
      panelPC: number;
      auditBM: number;
      auditRA: number;
    }>;
  };
  summary: string;
  rationale: string;
  status: 'captured' | 'promoted-to-roadmap' | 'resolved' | 'wont-fix';
  resolution?: string;
  relatedFindings?: string[];
}
