// ============================================================================
// AI Pulse — Shared Rate Limiter
// ============================================================================
//
// All judge models hit the same OpenRouter API key. Without coordination,
// simultaneous calls per conversation = 429 floods. This rate limiter
// serializes requests with a configurable minimum interval using a
// promise-chain pattern (no mutex, no sleep loops).

export class SharedRateLimiter {
  private lastPromise: Promise<void> = Promise.resolve();
  private minIntervalMs: number;
  private label: string;

  constructor(minIntervalMs: number = 2000, label: string = 'RateLimiter') {
    this.minIntervalMs = minIntervalMs;
    this.label = label;
  }

  /**
   * Acquire a slot. Chains onto previous call's completion,
   * enforcing minimum gap between requests.
   */
  async acquire(): Promise<void> {
    const previous = this.lastPromise;
    let resolve: () => void;
    this.lastPromise = new Promise<void>(r => { resolve = r; });

    await previous;

    const now = Date.now();
    if (!this._lastCallTime) {
      this._lastCallTime = now;
      resolve!();
      return;
    }

    const elapsed = now - this._lastCallTime;
    if (elapsed < this.minIntervalMs) {
      const sleepMs = this.minIntervalMs - elapsed;
      console.log(`  [${this.label}] Rate limit: sleeping ${sleepMs}ms...`);
      await new Promise(r => setTimeout(r, sleepMs));
    }

    this._lastCallTime = Date.now();
    resolve!();
  }

  private _lastCallTime: number = 0;
}
