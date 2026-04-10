// ============================================================================
// AI Pulse — Cumulative Audit Data Updater
// ============================================================================
//
// Maintains running cumulative files across audit runs:
// - bias-tracker.json: bias matrix data over time
// - calibration-drift.json: calibration effectiveness over time
// - findings-index.json: all findings across audits with source links
//
// Also supports full rebuild from existing audit directories.

import * as fs from 'fs';
import * as path from 'path';
import { TriageReport, BiasMatrix, CalibrationEffectiveness, Finding } from './types';

// ---- Cumulative file structures ----

export interface BiasTrackerEntry {
  auditDir: string;
  timestamp: string;
  judges: string[];
  judgeBaselines: Record<string, { meanABDiv: number; meanPCDiv: number }>;
}

export interface CalibrationDriftEntry {
  auditDir: string;
  timestamp: string;
  effectiveness: CalibrationEffectiveness;
}

export interface FindingsIndexEntry {
  findingId: string;
  auditDir: string;
  category: string;
  severity: string;
  summary: string;
}

// ---- Helpers ----

function ensureCumulativeDir(auditsBaseDir: string): string {
  const cumulativeDir = path.join(auditsBaseDir, 'cumulative');
  if (!fs.existsSync(cumulativeDir)) {
    fs.mkdirSync(cumulativeDir, { recursive: true });
  }
  return cumulativeDir;
}

function readJsonArray<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJsonArray<T>(filePath: string, data: T[]): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ---- Update cumulative files from a single triage report ----

export function updateCumulative(auditDir: string, triageReport: TriageReport): void {
  const auditsBaseDir = path.dirname(auditDir);
  const cumulativeDir = ensureCumulativeDir(auditsBaseDir);

  // --- Bias tracker ---
  if (triageReport.biasMatrix) {
    const biasPath = path.join(cumulativeDir, 'bias-tracker.json');
    const biasData = readJsonArray<BiasTrackerEntry>(biasPath);
    biasData.push({
      auditDir: path.basename(auditDir),
      timestamp: triageReport.metadata.timestamp,
      judges: triageReport.biasMatrix.judges,
      judgeBaselines: triageReport.biasMatrix.judgeBaselines,
    });
    writeJsonArray(biasPath, biasData);
  }

  // --- Calibration drift ---
  if (triageReport.calibrationEffectiveness) {
    const calibPath = path.join(cumulativeDir, 'calibration-drift.json');
    const calibData = readJsonArray<CalibrationDriftEntry>(calibPath);
    calibData.push({
      auditDir: path.basename(auditDir),
      timestamp: triageReport.metadata.timestamp,
      effectiveness: triageReport.calibrationEffectiveness,
    });
    writeJsonArray(calibPath, calibData);
  }

  // --- Findings index ---
  const findingsPath = path.join(auditDir, 'findings.json');
  if (fs.existsSync(findingsPath)) {
    const findings: Finding[] = JSON.parse(fs.readFileSync(findingsPath, 'utf-8'));
    if (findings.length > 0) {
      const indexPath = path.join(cumulativeDir, 'findings-index.json');
      const indexData = readJsonArray<FindingsIndexEntry>(indexPath);
      for (const f of findings) {
        indexData.push({
          findingId: f.id,
          auditDir: path.basename(auditDir),
          category: f.category,
          severity: f.severity,
          summary: f.summary,
        });
      }
      writeJsonArray(indexPath, indexData);
    }
  }
}

// ---- Rebuild all cumulative files from scratch ----

export function rebuildCumulative(auditsBaseDir: string): void {
  const cumulativeDir = ensureCumulativeDir(auditsBaseDir);

  // Clear existing cumulative files
  const biasPath = path.join(cumulativeDir, 'bias-tracker.json');
  const calibPath = path.join(cumulativeDir, 'calibration-drift.json');
  const indexPath = path.join(cumulativeDir, 'findings-index.json');
  writeJsonArray(biasPath, []);
  writeJsonArray(calibPath, []);
  writeJsonArray(indexPath, []);

  // Scan audit directories (skip 'cumulative')
  const entries = fs.readdirSync(auditsBaseDir, { withFileTypes: true });
  const auditDirs = entries
    .filter(e => e.isDirectory() && e.name !== 'cumulative')
    .map(e => e.name)
    .sort(); // chronological order (ISO timestamp dirs sort naturally)

  for (const dirName of auditDirs) {
    const auditDir = path.join(auditsBaseDir, dirName);
    const reportPath = path.join(auditDir, 'triage-report.json');

    if (!fs.existsSync(reportPath)) continue;

    const triageReport: TriageReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    updateCumulative(auditDir, triageReport);
  }
}
