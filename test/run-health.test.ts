// ============================================================================
// Tests — Run Health Collector + Enforcement
// ============================================================================
//
// 1. Unit tests for RunHealthCollector behavior
// 2. Enforcement: pipeline-path source files must use the RunHealthCollector
//    instead of raw console.warn/console.error. This prevents new warnings
//    from bypassing the end-of-run health summary.

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { RunHealthCollector } from '../src/shared/run-health';

// --- Unit Tests ---

describe('RunHealthCollector', () => {
  let collector: RunHealthCollector;

  beforeEach(() => {
    collector = new RunHealthCollector();
  });

  it('starts clean', () => {
    assert.equal(collector.isClean(), true);
    assert.equal(collector.count('error'), 0);
    assert.equal(collector.count('warning'), 0);
    assert.equal(collector.all().length, 0);
  });

  it('records warnings', () => {
    collector.warn('test-source', 'something happened');
    assert.equal(collector.count('warning'), 1);
    assert.equal(collector.isClean(), false);
    assert.equal(collector.byLevel('warning')[0].source, 'test-source');
    assert.equal(collector.byLevel('warning')[0].message, 'something happened');
  });

  it('records errors', () => {
    collector.error('test-source', 'something broke');
    assert.equal(collector.count('error'), 1);
    assert.equal(collector.isClean(), false);
  });

  it('records info without affecting isClean', () => {
    collector.info('test-source', 'fyi');
    assert.equal(collector.count('info'), 1);
    assert.equal(collector.isClean(), true); // info doesn't count as dirty
  });

  it('separates levels correctly', () => {
    collector.error('a', 'err');
    collector.warn('b', 'warn');
    collector.info('c', 'info');
    assert.equal(collector.count('error'), 1);
    assert.equal(collector.count('warning'), 1);
    assert.equal(collector.count('info'), 1);
    assert.equal(collector.all().length, 3);
  });

  it('byLevel returns only matching entries', () => {
    collector.warn('a', 'w1');
    collector.error('b', 'e1');
    collector.warn('c', 'w2');
    const warnings = collector.byLevel('warning');
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every(w => w.level === 'warning'));
  });
});

// --- Enforcement Test ---
//
// Pipeline-path source files must route warnings/errors through the
// RunHealthCollector. Raw console.warn/console.error calls bypass the
// end-of-run health summary, making problems invisible.
//
// Files in the enforcement set are the "core pipeline path" — code that
// runs during every pipeline execution and whose warnings/errors represent
// outcomes the user needs to know about.
//
// Files NOT in the enforcement set:
//   - src/engine/providers/* — per-call API retry logs; outcomes captured
//     by conversation.ts (isError) and reported via the collector
//   - src/scoring/judges/* — per-attempt retry logs; outcomes captured
//     by judge-panel.ts (null → collector warning)
//   - src/detection/* — mock mode only
//   - src/audit-run/*, src/audit-analyze/* — standalone tools, not pipeline
//   - src/human-scoring/*, src/experiments/* — standalone tools
//   - src/shared/run-health.ts — the collector itself uses console.*

const ENFORCED_FILES = [
  'src/engine/conversation.ts',
  'src/scoring/judge-panel.ts',
  'src/scoring/json-parser.ts',
  'src/scoring/aggregation.ts',
  'src/scoring/data-quality.ts',
  'src/output.ts',
];

// pipeline.ts has some legitimate console.error calls (pre-run validation,
// fatal error handler) that fire before the collector exists or after an
// unrecoverable crash. These are allowlisted by line content.
const PIPELINE_ALLOWLIST = [
  'console.error(`ERROR: Unknown flag',   // pre-run CLI validation
  'console.error(`Valid flags:',           // pre-run CLI validation
  "console.error('ERROR: OPENROUTER_API_KEY", // pre-run config validation
  "console.error('Set it in .env",         // pre-run config validation
  "console.error('Fatal error:'",          // unrecoverable crash handler
];

describe('Run health enforcement — no raw console.warn/error in pipeline path', () => {
  const repoRoot = process.cwd();

  for (const relPath of ENFORCED_FILES) {
    it(`${relPath} has no raw console.warn or console.error`, () => {
      const filePath = path.join(repoRoot, relPath);
      if (!fs.existsSync(filePath)) {
        // File might not exist yet — skip rather than fail
        return;
      }
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      const violations: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('//') || line.startsWith('*')) continue; // skip comments
        if (/console\.(warn|error)\s*\(/.test(line)) {
          violations.push(`  line ${i + 1}: ${line.slice(0, 120)}`);
        }
      }

      assert.equal(
        violations.length, 0,
        `Found ${violations.length} raw console.warn/error call(s) — use getRunHealth().warn() or .error() instead:\n${violations.join('\n')}`,
      );
    });
  }

  it('src/pipeline.ts has no un-allowlisted console.warn or console.error', () => {
    const filePath = path.join(repoRoot, 'src/pipeline.ts');
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('//') || line.startsWith('*')) continue;
      if (/console\.(warn|error)\s*\(/.test(line)) {
        const isAllowlisted = PIPELINE_ALLOWLIST.some(pattern => line.includes(pattern));
        if (!isAllowlisted) {
          violations.push(`  line ${i + 1}: ${line.slice(0, 120)}`);
        }
      }
    }

    assert.equal(
      violations.length, 0,
      `Found ${violations.length} un-allowlisted console.warn/error call(s) in pipeline.ts — use health.warn() or .error(), or add to PIPELINE_ALLOWLIST:\n${violations.join('\n')}`,
    );
  });
});
