import type { Effort } from '@rankati/shared';
import { describe, expect, it } from 'vitest';
import { FIT_PENALTY, fitPenalty, isBlock } from '../src/today/fit';

/**
 * The fit multiplier's truth table (ADR 0072). Pure — no DB, no clock, no wall-time. This is the
 * function the Today band multiplies its sort score by; the HTTP suite (tasks-fit.spec.ts) proves
 * the ranking behaviour, this pins the contract point-by-point.
 *
 * The rule: 1 (no effect) whenever the block is Any (undefined), the task is untagged (null), or the
 * task fits (effort ≤ block); FIT_PENALTY only when the task is STRICTLY bigger than the block.
 */
const BUCKETS: Effort[] = ['quick', 'medium', 'long'];

describe('fitPenalty — the truth table (0072)', () => {
  it('Any (no block) is neutral for every effort, including untagged', async () => {
    for (const e of [...BUCKETS, null] as (Effort | null)[]) {
      expect(fitPenalty(e, undefined)).toBe(1);
    }
  });

  it('untagged (NULL) never sinks — 1 under every block', async () => {
    for (const b of BUCKETS) {
      expect(fitPenalty(null, b)).toBe(1);
    }
  });

  it('fits (effort ≤ block) is 1; too big (effort > block) is FIT_PENALTY', async () => {
    // The full 3×3 grid, read against ordinal quick < medium < long.
    const order = { quick: 1, medium: 2, long: 3 } as const;
    for (const e of BUCKETS) {
      for (const b of BUCKETS) {
        const expected = order[e] > order[b] ? FIT_PENALTY : 1;
        expect(fitPenalty(e, b)).toBe(expected);
      }
    }
  });

  it('the strict boundary: equal fits, one bigger sinks', async () => {
    expect(fitPenalty('medium', 'medium')).toBe(1); // equal → fits
    expect(fitPenalty('quick', 'medium')).toBe(1); // smaller → fits
    expect(fitPenalty('long', 'medium')).toBe(FIT_PENALTY); // bigger → sinks
  });

  it('FIT_PENALTY is a sink, not a boost (0 < p < 1)', async () => {
    expect(FIT_PENALTY).toBeGreaterThan(0);
    expect(FIT_PENALTY).toBeLessThan(1);
  });

  it('isBlock guards the three buckets and rejects everything else', async () => {
    for (const b of BUCKETS) expect(isBlock(b)).toBe(true);
    for (const bad of ['huge', 'Quick', '', null, undefined, 2]) expect(isBlock(bad)).toBe(false);
  });
});
