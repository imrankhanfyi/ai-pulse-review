// test/triage-findings.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initFindingsFile, appendFinding, validateFinding } from '../src/audit-analyze/findings';
import { Finding } from '../src/audit-analyze/types';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'F-2026-03-19-001',
    timestamp: '2026-03-19T00:00:00Z',
    auditRunId: '2026-03-19T16-20-49Z',
    category: 'rubric-gap',
    dimensions: ['ab'],
    severity: 'medium',
    evidence: { conversationIds: ['conv-1'], scores: [{ panelAB: 3, panelPC: 3, auditBM: 2, auditRA: 3 }] },
    summary: 'Test finding',
    rationale: 'Test rationale',
    status: 'captured',
    ...overrides,
  };
}

describe('initFindingsFile', () => {
  it('creates empty array JSON file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    const filePath = path.join(dir, 'findings.json');
    initFindingsFile(filePath);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.deepEqual(data, []);
    fs.rmSync(dir, { recursive: true });
  });

  it('does not overwrite existing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    const filePath = path.join(dir, 'findings.json');
    fs.writeFileSync(filePath, JSON.stringify([makeFinding()]));
    initFindingsFile(filePath);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(data.length, 1); // not overwritten
    fs.rmSync(dir, { recursive: true });
  });
});

describe('validateFinding', () => {
  it('accepts valid finding', () => {
    assert.equal(validateFinding(makeFinding()), null);
  });

  it('rejects missing required fields', () => {
    const bad = { ...makeFinding(), summary: '' };
    assert.ok(validateFinding(bad) !== null);
  });

  it('rejects invalid category', () => {
    const bad = { ...makeFinding(), category: 'invalid' as any };
    assert.ok(validateFinding(bad) !== null);
  });
});

describe('appendFinding', () => {
  it('appends to existing findings file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    const filePath = path.join(dir, 'findings.json');
    initFindingsFile(filePath);
    appendFinding(filePath, makeFinding());
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'F-2026-03-19-001');
    fs.rmSync(dir, { recursive: true });
  });
});
