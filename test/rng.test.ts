// ============================================================================
// Tests — Seeded RNG
// ============================================================================

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRng, hashSeed } from '../src/engine/rng';

describe('Seeded RNG', () => {
  it('is deterministic — same seed produces same sequence', () => {
    const rng1 = createRng(42);
    const rng2 = createRng(42);
    for (let i = 0; i < 100; i++) {
      assert.equal(rng1.next(), rng2.next(), `Mismatch at step ${i}`);
    }
  });

  it('different seeds produce different sequences', () => {
    const rng1 = createRng(42);
    const rng2 = createRng(43);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      if (rng1.next() === rng2.next()) same++;
    }
    assert.ok(same < 5, `Too many collisions: ${same}/100`);
  });

  it('next() returns values in [0, 1)', () => {
    const rng = createRng(12345);
    for (let i = 0; i < 1000; i++) {
      const val = rng.next();
      assert.ok(val >= 0 && val < 1, `Value out of range: ${val}`);
    }
  });

  it('nextInt(max) returns values in [0, max)', () => {
    const rng = createRng(99);
    for (let i = 0; i < 500; i++) {
      const val = rng.nextInt(10);
      assert.ok(val >= 0 && val < 10 && Number.isInteger(val), `Invalid: ${val}`);
    }
  });

  it('nextBool produces rough proportions', () => {
    const rng = createRng(77);
    let trues = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) {
      if (rng.nextBool(0.3)) trues++;
    }
    const ratio = trues / n;
    assert.ok(ratio > 0.25 && ratio < 0.35, `Expected ~30% trues, got ${(ratio * 100).toFixed(1)}%`);
  });
});

describe('hashSeed', () => {
  it('same string produces same hash', () => {
    assert.equal(hashSeed('test'), hashSeed('test'));
  });

  it('different strings produce different hashes', () => {
    assert.notEqual(hashSeed('hello'), hashSeed('world'));
  });

  it('returns a number', () => {
    assert.equal(typeof hashSeed('anything'), 'number');
  });
});
