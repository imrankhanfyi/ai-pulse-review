// ============================================================================
// Tests — Shared Rate Limiter
// ============================================================================

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SharedRateLimiter } from '../src/engine/rate-limiter';

describe('SharedRateLimiter', () => {
  it('first acquire resolves immediately', async () => {
    const limiter = new SharedRateLimiter(100, 'test');
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `First acquire should be instant, took ${elapsed}ms`);
  });

  it('two sequential acquires respect minimum interval', async () => {
    const limiter = new SharedRateLimiter(100, 'test');
    await limiter.acquire();
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 90, `Second acquire should wait ~100ms, took ${elapsed}ms`);
  });

  it('concurrent acquires serialize (do not interleave)', async () => {
    const limiter = new SharedRateLimiter(50, 'test');
    const order: number[] = [];

    // Fire 3 concurrent acquires
    const p1 = limiter.acquire().then(() => { order.push(1); });
    const p2 = limiter.acquire().then(() => { order.push(2); });
    const p3 = limiter.acquire().then(() => { order.push(3); });

    await Promise.all([p1, p2, p3]);

    assert.deepEqual(order, [1, 2, 3], 'Acquires should resolve in order');
  });
});
