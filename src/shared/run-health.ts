// ============================================================================
// AI Pulse — Run Health Collector
// ============================================================================
//
// Accumulates warnings and errors during a pipeline run, then prints a
// consolidated health summary at the end. Replaces scattered console.warn
// calls that scroll past unseen.
//
// Each entry is logged to the console in real time AND stored for the
// end-of-run summary, so you don't lose live feedback.

export type HealthLevel = 'error' | 'warning' | 'info';

export interface HealthEntry {
  level: HealthLevel;
  source: string;    // e.g. 'judge-panel', 'conversation', 'json-parser'
  message: string;
}

export class RunHealthCollector {
  private entries: HealthEntry[] = [];

  /** Log an error (something failed) and store it for the summary. */
  error(source: string, message: string): void {
    this.entries.push({ level: 'error', source, message });
    console.error(`  [ERROR] [${source}] ${message}`);
  }

  /** Log a warning (something unexpected but non-fatal) and store it. */
  warn(source: string, message: string): void {
    this.entries.push({ level: 'warning', source, message });
    console.warn(`  [WARN] [${source}] ${message}`);
  }

  /** Log an informational note. */
  info(source: string, message: string): void {
    this.entries.push({ level: 'info', source, message });
  }

  /** Get all entries at a given level. */
  byLevel(level: HealthLevel): HealthEntry[] {
    return this.entries.filter(e => e.level === level);
  }

  /** Total count of entries at a given level. */
  count(level: HealthLevel): number {
    return this.entries.filter(e => e.level === level).length;
  }

  /** True if no warnings or errors were recorded. */
  isClean(): boolean {
    return this.count('error') === 0 && this.count('warning') === 0;
  }

  /** All collected entries. */
  all(): readonly HealthEntry[] {
    return this.entries;
  }

  /**
   * Print the end-of-run health summary.
   * Only prints if there are warnings or errors — stays silent on clean runs.
   */
  printSummary(): void {
    const errors = this.byLevel('error');
    const warnings = this.byLevel('warning');

    if (errors.length === 0 && warnings.length === 0) {
      console.log('\n  Run health: clean (0 errors, 0 warnings)');
      return;
    }

    console.log('\n' + '='.repeat(70));
    console.log('  RUN HEALTH SUMMARY');
    console.log('='.repeat(70));

    if (errors.length > 0) {
      console.log(`\n  Errors (${errors.length})`);
      for (const e of errors) {
        console.log(`    ✗ [${e.source}] ${e.message}`);
      }
    }

    if (warnings.length > 0) {
      console.log(`\n  Warnings (${warnings.length})`);
      // Group by source for readability
      const bySource = new Map<string, string[]>();
      for (const w of warnings) {
        if (!bySource.has(w.source)) bySource.set(w.source, []);
        bySource.get(w.source)!.push(w.message);
      }
      for (const [source, msgs] of bySource) {
        if (msgs.length === 1) {
          console.log(`    ⚠ [${source}] ${msgs[0]}`);
        } else {
          console.log(`    ⚠ [${source}] (${msgs.length} warnings)`);
          for (const m of msgs) {
            console.log(`        ${m}`);
          }
        }
      }
    }

    console.log('\n' + '='.repeat(70));
  }
}

/**
 * Global singleton for the current pipeline run.
 * Import and use directly — reset between runs if needed.
 */
let _instance: RunHealthCollector | null = null;

export function getRunHealth(): RunHealthCollector {
  if (!_instance) _instance = new RunHealthCollector();
  return _instance;
}

export function resetRunHealth(): RunHealthCollector {
  _instance = new RunHealthCollector();
  return _instance;
}
