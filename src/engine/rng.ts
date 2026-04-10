// ============================================================================
// AI Pulse — Seeded PRNG (mulberry32)
// ============================================================================

import { SeededRng } from '../types';

/**
 * Creates a seeded PRNG using the mulberry32 algorithm.
 * Deterministic: same seed always produces same sequence.
 */
export function createRng(seed: number): SeededRng {
  let state = seed | 0;

  function next(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    nextInt(max: number): number {
      return Math.floor(next() * max);
    },
    nextBool(probability: number): boolean {
      return next() < probability;
    },
  };
}

/** Hash a string to a numeric seed */
export function hashSeed(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash;
}
