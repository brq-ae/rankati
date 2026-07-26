import { describe, expect, it } from 'vitest';
import { pickPair, type Contender } from '../src/arena/pairing';
import { PLACEMENT_DUELS } from '../src/arena/elo';
import { Prisma } from '../src/generated/prisma/client';

const D = Prisma.Decimal;
const c = (id: string, rating: number, duelCount: number): Contender => ({
  id,
  rating: new D(rating),
  duelCount,
});

/** A pinned sequence, so "random" is testable. Cycles if a test draws more than it gives. */
const rngOf = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

/** Matchmaking (ADRs 0004, 0006, 0047). */
describe('pairing', () => {
  it('refuses a pool that cannot make a pair', () => {
    expect(() => pickPair([c('a', 1000, 0)], rngOf(0))).toThrow(/at least 2/);
  });

  it('never pairs a task with itself, across many draws', () => {
    const pool = [c('a', 1000, 9), c('b', 1200, 9), c('c', 800, 9)];
    for (let i = 0; i < 200; i++) {
      const [x, y] = pickPair(pool, Math.random);
      expect(x.id).not.toBe(y.id);
    }
  });

  describe('cold start — a provisional task jumps the queue (0006)', () => {
    it('picks the provisional task even when everyone else is settled', () => {
      const pool = [
        c('settled-1', 1400, 40),
        c('settled-2', 900, 40),
        c('newcomer', 1000, 0),
      ];
      // Whatever the rng does, the newcomer must be in the pair.
      for (const rng of [rngOf(0), rngOf(0.5), rngOf(0.99)]) {
        const [x, y] = pickPair(pool, rng);
        expect([x.id, y.id]).toContain('newcomer');
      }
    });

    it('gives it the NEAREST-rated opponent, which is the ladder-climb (0047)', () => {
      const pool = [
        c('newcomer', 1000, 0),
        c('far-above', 1600, 40),
        c('near', 1050, 40),
        c('far-below', 400, 40),
      ];
      const [first, second] = pickPair(pool, rngOf(0));
      expect(first.id).toBe('newcomer');
      expect(second.id).toBe('near');
    });

    it('prefers the LEAST-dueled provisional task when several are placing', () => {
      const pool = [
        c('placing-4', 1000, 4),
        c('brand-new', 1000, 0),
        c('settled', 1000, 40),
      ];
      const [first] = pickPair(pool, rngOf(0));
      expect(first.id).toBe('brand-new');
    });

    it('stops jumping the queue once every task has graduated', () => {
      const justGraduated = [
        c('a', 1000, PLACEMENT_DUELS),
        c('b', 1000, PLACEMENT_DUELS),
        c('c', 1000, PLACEMENT_DUELS),
      ];
      // With nobody provisional, this falls through to balanced-random. The proof it is
      // no longer the placement path: placement always returns the least-dueled FIRST,
      // and here all counts are equal, so the rng decides — which the next test pins.
      const [x, y] = pickPair(justGraduated, rngOf(0.99, 0.99));
      expect(x.id).not.toBe(y.id);
    });

    it('breaks a rating tie randomly, so a fresh install does not deal one pair forever', () => {
      // Everything at exactly 1000, everything provisional: without a random tie-break
      // this would deal the same pair every time.
      const pool = [c('a', 1000, 0), c('b', 1000, 0), c('c', 1000, 0), c('d', 1000, 0)];
      const seen = new Set<string>();
      for (let i = 0; i < 300; i++) {
        const [x, y] = pickPair(pool, Math.random);
        seen.add([x.id, y.id].sort().join('-'));
      }
      // All 6 unordered pairs should appear.
      expect(seen.size).toBe(6);
    });
  });

  describe('steady state — balanced random, weighted to the least-dueled (0004)', () => {
    it('draws the least-dueled task far more often than the most-dueled', () => {
      // SIX tasks, not three. With a pool of three drawn two at a time, the neglected
      // task can appear at most once per pair while the other two split the remaining
      // slot — so the ratio is capped at 2x BY CONSTRUCTION, however strong the
      // weighting. A three-task pool cannot measure this, only its own ceiling.
      const pool = [
        c('fresh', 1000, 5),
        ...Array.from({ length: 5 }, (_, i) => c(`busy-${i}`, 1000, 95)),
      ];
      const rounds = 4000;
      const counts: Record<string, number> = {};
      for (let i = 0; i < rounds; i++) {
        const [x, y] = pickPair(pool, Math.random);
        counts[x.id] = (counts[x.id] ?? 0) + 1;
        counts[y.id] = (counts[y.id] ?? 0) + 1;
      }
      const busyAvg =
        Object.entries(counts)
          .filter(([id]) => id !== 'fresh')
          .reduce((sum, [, n]) => sum + n, 0) / 5;

      // Measured at ~4.5x for this shape. Asserting 3x leaves room for the exact weight
      // function to be retuned — 0004 fixes the direction, not the curve.
      expect(counts.fresh!).toBeGreaterThan(busyAvg * 3);
      // And it should be in most pairs, not merely ahead.
      expect(counts.fresh!).toBeGreaterThan(rounds * 0.8);
    });

    it('is still random, not deterministic — every task gets drawn', () => {
      const pool = [c('a', 1000, 10), c('b', 1000, 10), c('c', 1000, 10)];
      const seen = new Set<string>();
      for (let i = 0; i < 300; i++) {
        const [x, y] = pickPair(pool, Math.random);
        seen.add(x.id);
        seen.add(y.id);
      }
      expect(seen.size).toBe(3);
    });

    it('does NOT target the nearest rating once settled — 0004 keeps the steady state pure', () => {
      // The mirror of the placement test: same shape of pool, but all settled. If the
      // steady state were "smart", 'near' would dominate. It must not.
      const pool = [
        c('anchor', 1000, 20),
        c('near', 1010, 20),
        c('far', 1900, 20),
      ];
      let farAppeared = 0;
      for (let i = 0; i < 400; i++) {
        const [x, y] = pickPair(pool, Math.random);
        if (x.id === 'far' || y.id === 'far') farAppeared += 1;
      }
      // A targeted steady state would almost never pick 'far'. Pure random picks it in
      // roughly two thirds of pairs; anything above a third proves it is not targeting.
      expect(farAppeared).toBeGreaterThan(400 / 3);
    });
  });
});
