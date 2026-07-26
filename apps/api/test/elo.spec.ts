import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client';
import {
  applyDuel,
  expectedScore,
  kFor,
  K_PROVISIONAL,
  K_SETTLED,
  PLACEMENT_DUELS,
  roundForStorage,
} from '../src/arena/elo';

const D = Prisma.Decimal;
const d = (n: number | string) => new D(n);

/**
 * The Arena's arithmetic (ADR 0047).
 *
 * The expected values below were computed INDEPENDENTLY, in Python's decimal module, and
 * pasted in. Asserting against numbers the code produced would only prove it agrees with
 * itself.
 */
describe('Elo', () => {
  describe('expectedScore', () => {
    it('is exactly 0.5 between equal ratings', () => {
      expect(expectedScore(d(1000), d(1000)).equals(d('0.5'))).toBe(true);
    });

    it('favours the higher rating', () => {
      expect(expectedScore(d(1200), d(1000)).toFixed(10)).toBe('0.7597469266');
      expect(expectedScore(d(1000), d(1200)).toFixed(10)).toBe('0.2402530734');
    });

    it('sums to exactly 1 at ordinary rating gaps', () => {
      const pairs: [number, number][] = [
        [1000, 1000],
        [1200, 1000],
        [1000, 1200],
        [1500, 900],
      ];
      for (const [a, b] of pairs) {
        const sum = expectedScore(d(a), d(b)).plus(expectedScore(d(b), d(a)));
        expect(sum.equals(1)).toBe(true);
      }
    });

    it('drifts below 1 at extreme gaps — which is WHY applyDuel uses the complement', () => {
      // Measured, not assumed: at a 1500-point gap decimal.js's 20-significant-digit
      // rounding leaves the two computed expectations summing to 0.99999999999999999998.
      // Tiny, but it means "Eb == 1 - Ea" is an approximation, not an identity. applyDuel
      // therefore derives the loser's expectation as the exact complement rather than
      // recomputing it, so its zero-sum property holds by construction at any gap.
      const sum = expectedScore(d(1000), d(2500)).plus(expectedScore(d(2500), d(1000)));
      expect(sum.equals(1)).toBe(false);
      expect(sum.toFixed(20)).toBe('0.99999999999999999998');
    });
  });

  describe('kFor — provisional is derived, never stored (0047)', () => {
    it('is provisional below the placement threshold and settled at or above it', () => {
      expect(kFor(0)).toBe(K_PROVISIONAL);
      expect(kFor(PLACEMENT_DUELS - 1)).toBe(K_PROVISIONAL);
      expect(kFor(PLACEMENT_DUELS)).toBe(K_SETTLED);
      expect(kFor(500)).toBe(K_SETTLED);
    });
  });

  describe('applyDuel — worked example, hand-computed', () => {
    it('two even provisional tasks: the winner takes exactly half of K', () => {
      // Python: A=1032.00 B=968.00
      const r = applyDuel(d(1000), d(1000), 64, 64);
      expect(roundForStorage(r.winner).toFixed(2)).toBe('1032.00');
      expect(roundForStorage(r.loser).toFixed(2)).toBe('968.00');
    });

    it('a second win over the same opponent compounds, and moves less', () => {
      // The same pair may repeat within a sitting; picking the same winner twice IS
      // expressing that judgement twice, so it compounds. Known behaviour (0047).
      // Python: A=1058.17 B=941.83
      const r = applyDuel(d('1032.00'), d('968.00'), 64, 64);
      expect(roundForStorage(r.winner).toFixed(2)).toBe('1058.17');
      expect(roundForStorage(r.loser).toFixed(2)).toBe('941.83');
    });

    it('moves the two tasks by DIFFERENT amounts when their K differs (0047)', () => {
      // A newcomer beating a settled task: it climbs by 64-scale, the veteran drops by 24.
      const r = applyDuel(d(1000), d(1000), K_PROVISIONAL, K_SETTLED);
      expect(roundForStorage(r.winner).toFixed(2)).toBe('1032.00'); // +32 = 64 * 0.5
      expect(roundForStorage(r.loser).toFixed(2)).toBe('988.00'); //  -12 = 24 * 0.5
    });

    it('is a zero-sum move only when both Ks match', () => {
      const even = applyDuel(d(1000), d(1000), 64, 64);
      const gained = even.winner.minus(1000);
      const lost = d(1000).minus(even.loser);
      expect(gained.equals(lost)).toBe(true);
    });

    it('barely moves an expected result, and swings an upset', () => {
      // Python: expected(1600,1000) = 0.969347 -> 24 * (1 - 0.969347) = 0.74
      //         expected(1000,1600) = 0.030653 -> 24 * (1 - 0.030653) = 23.26
      const expectedWin = applyDuel(d(1600), d(1000), K_SETTLED, K_SETTLED);
      const upset = applyDuel(d(1000), d(1600), K_SETTLED, K_SETTLED);
      const expectedDelta = expectedWin.winner.minus(1600);
      const upsetDelta = upset.winner.minus(1000);
      expect(expectedDelta.lessThan(upsetDelta)).toBe(true);
      expect(expectedDelta.toFixed(2)).toBe('0.74');
      expect(upsetDelta.toFixed(2)).toBe('23.26');
    });
  });

  describe('determinism — what 0048 promises about replay', () => {
    it('reproduces the same rating bit-for-bit across runs', () => {
      const run = () => {
        let a = d(1000);
        let b = d(1000);
        for (let i = 0; i < 200; i++) {
          const r = applyDuel(a, b, 64, 24);
          a = roundForStorage(r.winner);
          b = roundForStorage(r.loser);
        }
        return `${a.toString()}/${b.toString()}`;
      };
      expect(run()).toBe(run());
    });
  });

  describe('roundForStorage', () => {
    it('rounds to the two decimals the column stores', () => {
      expect(roundForStorage(d('1058.171155')).toFixed(2)).toBe('1058.17');
      expect(roundForStorage(d('1058.175')).toFixed(2)).toBe('1058.18');
    });
  });
});
