// ============================================================================
// AI Pulse — Findings File Utilities
// ============================================================================

import * as fs from 'fs';
import { Finding, FindingCategory } from './types';

const VALID_CATEGORIES: FindingCategory[] = [
  'rubric-gap', 'rubric-ambiguity', 'judge-leniency',
  'judge-strictness', 'auditor-error', 'noise', 'needs-more-data',
];

export function initFindingsFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '[]', 'utf-8');
  }
}

export function validateFinding(finding: Finding): string | null {
  if (!finding.id || !finding.timestamp || !finding.auditRunId) return 'Missing id, timestamp, or auditRunId';
  if (!VALID_CATEGORIES.includes(finding.category)) return `Invalid category: ${finding.category}`;
  if (!finding.summary) return 'Missing summary';
  if (!finding.rationale) return 'Missing rationale';
  if (!finding.dimensions || finding.dimensions.length === 0) return 'Missing dimensions';
  return null;
}

export function appendFinding(filePath: string, finding: Finding): void {
  const error = validateFinding(finding);
  if (error) throw new Error(`Invalid finding: ${error}`);

  const existing: Finding[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  existing.push(finding);
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8');
}
