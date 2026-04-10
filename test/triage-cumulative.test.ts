// test/triage-cumulative.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  updateCumulative,
  rebuildCumulative,
  BiasTrackerEntry,
  CalibrationDriftEntry,
  FindingsIndexEntry,
} from '../src/audit-analyze/cumulative';
import { TriageReport, Finding } from '../src/audit-analyze/types';

// ---- Factory helpers ----

function makeTriageReport(overrides: Partial<TriageReport> = {}): TriageReport {
  return {
    metadata: {
      auditDir: 'audits/2026-03-19T16-00-00Z',
      resultsPath: 'results.json',
      timestamp: '2026-03-19T16:00:00Z',
      conversationCount: 10,
      threshold: 1.0,
      patternThreshold: 0.5,
    },
    rankedTable: [],
    patternSummary: {
      'CALIB-HURT': 0,
      'DIRECTION-FLIP': 0,
      'RUBRIC-PROBLEM': 0,
      'JUDGE-QUALITY': 0,
      'BOTH-DIVERGE': 0,
      'LATE-COLLAPSE-DISAGREEMENT': 0,
      'DIMENSION-SPLIT': 0,
      'PANEL-INTERNAL-SPLIT': 0,
      'SCORE-LEVEL-ABSENCE': 0,
    },
    scoreLevelAbsences: [],
    calibrationEffectiveness: {
      meanABShift: -0.3,
      meanPCShift: -0.1,
      closerToPanel: 6,
      furtherFromPanel: 2,
      unchanged: 2,
      meanAbsChange: 0.4,
    },
    biasMatrix: {
      judges: ['llama-3.3-70b', 'mistral-large'],
      models: [{ modelId: 'gpt-4.1', modelName: 'GPT-4.1' }],
      cells: [{
        judgeId: 'llama-3.3-70b',
        modelId: 'gpt-4.1',
        modelName: 'GPT-4.1',
        meanABDiv: 0.5,
        meanPCDiv: 0.3,
        count: 5,
      }],
      judgeBaselines: {
        'llama-3.3-70b': { meanABDiv: 0.4, meanPCDiv: 0.2 },
        'mistral-large': { meanABDiv: 0.3, meanPCDiv: 0.1 },
      },
    },
    turnDivergence: { bm: [], ra: [] },
    dossiers: [],
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'F-2026-03-19-001',
    timestamp: '2026-03-19T00:00:00Z',
    auditRunId: '2026-03-19T16-00-00Z',
    category: 'rubric-gap',
    dimensions: ['ab'],
    severity: 'medium',
    evidence: { conversationIds: ['conv-1'], scores: [{ panelAB: 3, panelPC: 3, auditBM: 2, auditRA: 3 }] },
    summary: 'BM rubric gap on mild affective language',
    rationale: 'Test rationale',
    status: 'captured',
    ...overrides,
  };
}

function setupTempAuditsDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-cumulative-'));
  return tmpDir;
}

// ---- Tests: updateCumulative ----

describe('updateCumulative', () => {
  it('creates cumulative directory if it does not exist', () => {
    const base = setupTempAuditsDir();
    const auditDir = path.join(base, '2026-03-19T16-00-00Z');
    fs.mkdirSync(auditDir, { recursive: true });

    updateCumulative(auditDir, makeTriageReport());

    assert.ok(fs.existsSync(path.join(base, 'cumulative')));
    fs.rmSync(base, { recursive: true });
  });

  it('appends bias data to bias-tracker.json', () => {
    const base = setupTempAuditsDir();
    const auditDir = path.join(base, '2026-03-19T16-00-00Z');
    fs.mkdirSync(auditDir, { recursive: true });

    updateCumulative(auditDir, makeTriageReport());

    const biasPath = path.join(base, 'cumulative', 'bias-tracker.json');
    const data: BiasTrackerEntry[] = JSON.parse(fs.readFileSync(biasPath, 'utf-8'));
    assert.equal(data.length, 1);
    assert.equal(data[0].auditDir, '2026-03-19T16-00-00Z');
    assert.deepEqual(data[0].judges, ['llama-3.3-70b', 'mistral-large']);
    assert.equal(data[0].judgeBaselines['llama-3.3-70b'].meanABDiv, 0.4);
    fs.rmSync(base, { recursive: true });
  });

  it('appends calibration data to calibration-drift.json', () => {
    const base = setupTempAuditsDir();
    const auditDir = path.join(base, '2026-03-19T16-00-00Z');
    fs.mkdirSync(auditDir, { recursive: true });

    updateCumulative(auditDir, makeTriageReport());

    const calibPath = path.join(base, 'cumulative', 'calibration-drift.json');
    const data: CalibrationDriftEntry[] = JSON.parse(fs.readFileSync(calibPath, 'utf-8'));
    assert.equal(data.length, 1);
    assert.equal(data[0].effectiveness.meanABShift, -0.3);
    assert.equal(data[0].effectiveness.closerToPanel, 6);
    fs.rmSync(base, { recursive: true });
  });

  it('indexes findings from findings.json in audit dir', () => {
    const base = setupTempAuditsDir();
    const auditDir = path.join(base, '2026-03-19T16-00-00Z');
    fs.mkdirSync(auditDir, { recursive: true });

    // Write findings file in the audit directory
    const findings = [makeFinding(), makeFinding({ id: 'F-2026-03-19-002', summary: 'Second finding' })];
    fs.writeFileSync(path.join(auditDir, 'findings.json'), JSON.stringify(findings));

    updateCumulative(auditDir, makeTriageReport());

    const indexPath = path.join(base, 'cumulative', 'findings-index.json');
    const data: FindingsIndexEntry[] = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    assert.equal(data.length, 2);
    assert.equal(data[0].findingId, 'F-2026-03-19-001');
    assert.equal(data[0].auditDir, '2026-03-19T16-00-00Z');
    assert.equal(data[0].category, 'rubric-gap');
    assert.equal(data[1].findingId, 'F-2026-03-19-002');
    fs.rmSync(base, { recursive: true });
  });

  it('first run creates files from scratch', () => {
    const base = setupTempAuditsDir();
    const auditDir = path.join(base, '2026-03-19T16-00-00Z');
    fs.mkdirSync(auditDir, { recursive: true });

    // No cumulative dir exists yet
    assert.ok(!fs.existsSync(path.join(base, 'cumulative')));

    updateCumulative(auditDir, makeTriageReport());

    // All files created
    assert.ok(fs.existsSync(path.join(base, 'cumulative', 'bias-tracker.json')));
    assert.ok(fs.existsSync(path.join(base, 'cumulative', 'calibration-drift.json')));
    fs.rmSync(base, { recursive: true });
  });

  it('second run appends to existing cumulative files', () => {
    const base = setupTempAuditsDir();
    const auditDir1 = path.join(base, '2026-03-19T16-00-00Z');
    const auditDir2 = path.join(base, '2026-03-19T17-00-00Z');
    fs.mkdirSync(auditDir1, { recursive: true });
    fs.mkdirSync(auditDir2, { recursive: true });

    const report1 = makeTriageReport();
    const report2 = makeTriageReport({
      metadata: {
        ...makeTriageReport().metadata,
        auditDir: 'audits/2026-03-19T17-00-00Z',
        timestamp: '2026-03-19T17:00:00Z',
      },
    });

    updateCumulative(auditDir1, report1);
    updateCumulative(auditDir2, report2);

    const biasPath = path.join(base, 'cumulative', 'bias-tracker.json');
    const biasData: BiasTrackerEntry[] = JSON.parse(fs.readFileSync(biasPath, 'utf-8'));
    assert.equal(biasData.length, 2);
    assert.equal(biasData[0].auditDir, '2026-03-19T16-00-00Z');
    assert.equal(biasData[1].auditDir, '2026-03-19T17-00-00Z');

    const calibPath = path.join(base, 'cumulative', 'calibration-drift.json');
    const calibData: CalibrationDriftEntry[] = JSON.parse(fs.readFileSync(calibPath, 'utf-8'));
    assert.equal(calibData.length, 2);

    fs.rmSync(base, { recursive: true });
  });

  it('skips bias-tracker when biasMatrix is null', () => {
    const base = setupTempAuditsDir();
    const auditDir = path.join(base, '2026-03-19T16-00-00Z');
    fs.mkdirSync(auditDir, { recursive: true });

    updateCumulative(auditDir, makeTriageReport({ biasMatrix: null }));

    const biasPath = path.join(base, 'cumulative', 'bias-tracker.json');
    assert.ok(!fs.existsSync(biasPath));
    fs.rmSync(base, { recursive: true });
  });

  it('skips calibration-drift when calibrationEffectiveness is null', () => {
    const base = setupTempAuditsDir();
    const auditDir = path.join(base, '2026-03-19T16-00-00Z');
    fs.mkdirSync(auditDir, { recursive: true });

    updateCumulative(auditDir, makeTriageReport({ calibrationEffectiveness: null }));

    const calibPath = path.join(base, 'cumulative', 'calibration-drift.json');
    assert.ok(!fs.existsSync(calibPath));
    fs.rmSync(base, { recursive: true });
  });

  it('skips findings-index when no findings.json exists', () => {
    const base = setupTempAuditsDir();
    const auditDir = path.join(base, '2026-03-19T16-00-00Z');
    fs.mkdirSync(auditDir, { recursive: true });

    // No findings.json in auditDir
    updateCumulative(auditDir, makeTriageReport());

    const indexPath = path.join(base, 'cumulative', 'findings-index.json');
    // findings-index.json should NOT be created since no findings file exists
    assert.ok(!fs.existsSync(indexPath));
    fs.rmSync(base, { recursive: true });
  });

  it('skips findings-index when findings.json is empty array', () => {
    const base = setupTempAuditsDir();
    const auditDir = path.join(base, '2026-03-19T16-00-00Z');
    fs.mkdirSync(auditDir, { recursive: true });

    fs.writeFileSync(path.join(auditDir, 'findings.json'), '[]');

    updateCumulative(auditDir, makeTriageReport());

    const indexPath = path.join(base, 'cumulative', 'findings-index.json');
    assert.ok(!fs.existsSync(indexPath));
    fs.rmSync(base, { recursive: true });
  });
});

// ---- Tests: rebuildCumulative ----

describe('rebuildCumulative', () => {
  it('scans audit directories and rebuilds cumulative files', () => {
    const base = setupTempAuditsDir();

    // Create two audit directories with triage reports
    const dir1 = path.join(base, '2026-03-19T16-00-00Z');
    const dir2 = path.join(base, '2026-03-19T17-00-00Z');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const report1 = makeTriageReport();
    const report2 = makeTriageReport({
      metadata: {
        ...makeTriageReport().metadata,
        auditDir: 'audits/2026-03-19T17-00-00Z',
        timestamp: '2026-03-19T17:00:00Z',
      },
    });

    fs.writeFileSync(path.join(dir1, 'triage-report.json'), JSON.stringify(report1));
    fs.writeFileSync(path.join(dir2, 'triage-report.json'), JSON.stringify(report2));

    // Add findings to one dir
    fs.writeFileSync(path.join(dir1, 'findings.json'), JSON.stringify([makeFinding()]));

    rebuildCumulative(base);

    // Verify bias tracker
    const biasPath = path.join(base, 'cumulative', 'bias-tracker.json');
    const biasData: BiasTrackerEntry[] = JSON.parse(fs.readFileSync(biasPath, 'utf-8'));
    assert.equal(biasData.length, 2);

    // Verify calibration drift
    const calibPath = path.join(base, 'cumulative', 'calibration-drift.json');
    const calibData: CalibrationDriftEntry[] = JSON.parse(fs.readFileSync(calibPath, 'utf-8'));
    assert.equal(calibData.length, 2);

    // Verify findings index
    const indexPath = path.join(base, 'cumulative', 'findings-index.json');
    const indexData: FindingsIndexEntry[] = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    assert.equal(indexData.length, 1);
    assert.equal(indexData[0].findingId, 'F-2026-03-19-001');

    fs.rmSync(base, { recursive: true });
  });

  it('skips directories without triage-report.json', () => {
    const base = setupTempAuditsDir();

    const dir1 = path.join(base, '2026-03-19T16-00-00Z');
    const dir2 = path.join(base, '2026-03-19T17-00-00Z');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    // Only dir1 has a triage report
    fs.writeFileSync(path.join(dir1, 'triage-report.json'), JSON.stringify(makeTriageReport()));

    rebuildCumulative(base);

    const biasPath = path.join(base, 'cumulative', 'bias-tracker.json');
    const biasData: BiasTrackerEntry[] = JSON.parse(fs.readFileSync(biasPath, 'utf-8'));
    assert.equal(biasData.length, 1);

    fs.rmSync(base, { recursive: true });
  });

  it('skips cumulative directory itself', () => {
    const base = setupTempAuditsDir();

    const dir1 = path.join(base, '2026-03-19T16-00-00Z');
    fs.mkdirSync(dir1, { recursive: true });
    fs.writeFileSync(path.join(dir1, 'triage-report.json'), JSON.stringify(makeTriageReport()));

    // Pre-create cumulative dir with stale data
    const cumulativeDir = path.join(base, 'cumulative');
    fs.mkdirSync(cumulativeDir, { recursive: true });
    fs.writeFileSync(
      path.join(cumulativeDir, 'bias-tracker.json'),
      JSON.stringify([{ auditDir: 'stale', timestamp: 'stale', judges: [], judgeBaselines: {} }]),
    );

    rebuildCumulative(base);

    // Stale data should be replaced, not duplicated
    const biasPath = path.join(base, 'cumulative', 'bias-tracker.json');
    const biasData: BiasTrackerEntry[] = JSON.parse(fs.readFileSync(biasPath, 'utf-8'));
    assert.equal(biasData.length, 1);
    assert.equal(biasData[0].auditDir, '2026-03-19T16-00-00Z');

    fs.rmSync(base, { recursive: true });
  });

  it('produces empty arrays when no audit directories exist', () => {
    const base = setupTempAuditsDir();

    rebuildCumulative(base);

    const biasPath = path.join(base, 'cumulative', 'bias-tracker.json');
    const calibPath = path.join(base, 'cumulative', 'calibration-drift.json');
    const indexPath = path.join(base, 'cumulative', 'findings-index.json');

    assert.deepEqual(JSON.parse(fs.readFileSync(biasPath, 'utf-8')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(calibPath, 'utf-8')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(indexPath, 'utf-8')), []);

    fs.rmSync(base, { recursive: true });
  });

  it('processes directories in chronological order', () => {
    const base = setupTempAuditsDir();

    // Create in reverse order to test sorting
    const dir2 = path.join(base, '2026-03-19T17-00-00Z');
    const dir1 = path.join(base, '2026-03-19T16-00-00Z');
    fs.mkdirSync(dir2, { recursive: true });
    fs.mkdirSync(dir1, { recursive: true });

    const report1 = makeTriageReport();
    const report2 = makeTriageReport({
      metadata: {
        ...makeTriageReport().metadata,
        timestamp: '2026-03-19T17:00:00Z',
      },
    });

    fs.writeFileSync(path.join(dir1, 'triage-report.json'), JSON.stringify(report1));
    fs.writeFileSync(path.join(dir2, 'triage-report.json'), JSON.stringify(report2));

    rebuildCumulative(base);

    const biasPath = path.join(base, 'cumulative', 'bias-tracker.json');
    const biasData: BiasTrackerEntry[] = JSON.parse(fs.readFileSync(biasPath, 'utf-8'));
    assert.equal(biasData.length, 2);
    assert.equal(biasData[0].timestamp, '2026-03-19T16:00:00Z');
    assert.equal(biasData[1].timestamp, '2026-03-19T17:00:00Z');

    fs.rmSync(base, { recursive: true });
  });
});
