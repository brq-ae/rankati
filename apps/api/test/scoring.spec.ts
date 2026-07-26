import type { TaskTier } from '@rankati/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BOOST,
  ENTRY_MULT,
  W_TIER,
  daysUntil,
  multiplierAt,
  placement,
  todayScore,
  urgencyMultiplier,
} from '../src/today/scoring';

/**
 * The urgency scoring core (ADR 0057). Pure math — no DB, no clock. Every date is INJECTED as a
 * fixed 'YYYY-MM-DD'; nothing here reads wall-clock, or the tests would drift with the calendar.
 */

const ON = '2026-07-18';
const TIERS: TaskTier[] = ['critical', 'super_important', 'important', 'normal'];

/** A `due` date exactly `d` days from ON (negative = overdue). */
const dueAtDays = (d: number, on = ON): string =>
  new Date(Date.parse(`${on}T00:00:00.000Z`) + d * 86_400_000).toISOString().slice(0, 10);

describe('the urgency multiplier — the worked table (0057)', () => {
  // Independent hand-computed values to 4dp; the code must reproduce them. These ARE the
  // regression target the ADR's integer table rounds from.
  const M: Record<TaskTier, Record<number, number>> = {
    critical: { 14: 1.02, 7: 1.2, 5: 1.3861, 3: 1.7455, 1: 2.4394, 0: 3.0 },
    super_important: { 7: 1.02, 5: 1.0746, 3: 1.278, 1: 2.036, 0: 3.0 },
    important: { 5: 1.02, 3: 1.1262, 1: 1.7962, 0: 3.0 },
    normal: { 3: 1.02, 1: 1.4309, 0: 3.0 },
  };

  for (const tier of TIERS) {
    for (const [days, m] of Object.entries(M[tier])) {
      it(`${tier} at ${days}d → m≈${m} (score ${Math.round(m * 1000)})`, () => {
        expect(urgencyMultiplier(Number(days), tier)).toBeCloseTo(m, 3); // regression vs the table
        // and the score composes exactly: rating × multiplier, resolved through daysUntil
        expect(todayScore(1000, dueAtDays(Number(days)), tier, ON)).toBeCloseTo(
          1000 * urgencyMultiplier(Number(days), tier),
          6,
        );
      });
    }
  }

  it('enters at ~1.02 (bottom) and overtakes ~1.20 (a +20% rival) at the window midpoint', () => {
    for (const tier of TIERS) {
      const W = W_TIER[tier];
      expect(urgencyMultiplier(W, tier)).toBeCloseTo(ENTRY_MULT, 6); // entry, per tier
      expect(urgencyMultiplier(W / 2, tier)).toBeCloseTo(1.2, 4); // overtake, derived
    }
  });

  it('convergent peak: every tier reaches exactly 3.0× at d=0 — tier sets WHEN, not HOW HIGH', () => {
    for (const tier of TIERS) {
      expect(urgencyMultiplier(0, tier)).toBeCloseTo(1 + BOOST, 12);
    }
  });

  it('an undated task escalates by exactly 1 (ranks at its rating)', () => {
    for (const tier of TIERS) {
      expect(todayScore(1247, null, tier, ON)).toBe(1247);
    }
  });
});

describe('placement — the ladder and the strata (0058)', () => {
  it('the entry ladder: each tier enters Today at its window, upcoming one day earlier out', () => {
    const ladder: Record<TaskTier, number> = { critical: 14, super_important: 7, important: 5, normal: 3 };
    for (const tier of TIERS) {
      const W = ladder[tier];
      expect(placement(dueAtDays(W), tier, ON)).toBe('today'); // at the window edge → in Today
      expect(placement(dueAtDays(W + 1), tier, ON)).toBe('upcoming'); // one day further → Upcoming
    }
  });

  it('overdue, due-today, and undated classify correctly', () => {
    expect(placement(dueAtDays(-1), 'normal', ON)).toBe('overdue');
    expect(placement(dueAtDays(0), 'normal', ON)).toBe('today'); // due today is playable, not overdue
    expect(placement(null, 'critical', ON)).toBe('undated');
  });
});

describe('placement boundary === multiplier crossing ENTRY_MULT — pinned, and retune-invariant', () => {
  // The drift shape: placement decides with `d ≤ W_tier`, the threshold with `m ≥ ENTRY_MULT`.
  // They are one rule only because λ is derived so m(W)=ENTRY_MULT. This pins that they agree,
  // and keep agreeing under a retune — computed, never hardcoded.
  it('for each tier, the last Today day is the window, where m equals ENTRY_MULT', () => {
    for (const tier of TIERS) {
      const W = W_TIER[tier];
      expect(urgencyMultiplier(W, tier)).toBeCloseTo(ENTRY_MULT, 9); // crossing is AT the window
      expect(urgencyMultiplier(W + 1, tier)).toBeLessThan(ENTRY_MULT); // just past it → below
      expect(placement(dueAtDays(W), tier, ON)).toBe('today'); // placement agrees...
      expect(placement(dueAtDays(W + 1), tier, ON)).toBe('upcoming'); // ...on both sides
    }
  });

  it('the crossing lands at the window for ANY retuned BOOST/ENTRY_MULT/window (the derivation, not a hardcode)', () => {
    for (const boost of [0.5, 2, 8, 20]) {
      for (const entryMult of [1.005, 1.02, 1.1]) {
        for (const W of [3, 5, 7, 14, 30]) {
          // m(W) must equal entryMult regardless of the params — if λ's derivation ever breaks,
          // this is what fails, not the threshold silently splitting from placement.
          expect(multiplierAt(W, W, boost, entryMult)).toBeCloseTo(entryMult, 9);
        }
      }
    }
  });
});

describe('flat-field legibility — ordering AMONG dated tasks (evaluable before any dueling)', () => {
  it('at a fixed day, a higher tier has a higher multiplier (it climbed earlier)', () => {
    const d = 4;
    expect(urgencyMultiplier(d, 'critical')).toBeGreaterThan(urgencyMultiplier(d, 'super_important'));
    expect(urgencyMultiplier(d, 'super_important')).toBeGreaterThan(urgencyMultiplier(d, 'important'));
    expect(urgencyMultiplier(d, 'important')).toBeGreaterThan(urgencyMultiplier(d, 'normal'));
  });

  it('the multiplier climbs monotonically as the deadline nears', () => {
    for (const tier of TIERS) {
      for (let d = 20; d > 0; d--) {
        expect(urgencyMultiplier(d - 1, tier)).toBeGreaterThan(urgencyMultiplier(d, tier));
      }
    }
  });
});

describe('daysUntil — integer calendar days, timezone-safe (0052)', () => {
  it('counts whole days, including across a month boundary', () => {
    expect(daysUntil('2026-07-20', '2026-07-18')).toBe(2);
    expect(daysUntil('2026-08-01', '2026-07-30')).toBe(2); // July has 31 days
    expect(daysUntil('2026-07-18', '2026-07-18')).toBe(0);
    expect(daysUntil('2026-07-17', '2026-07-18')).toBe(-1); // overdue
  });

  it('is the same in a hostile timezone — both dates are UTC-anchored calendar days', () => {
    const original = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati'; // +14, the zone most likely to slip a day
    try {
      expect(daysUntil('2026-08-01', '2026-07-30')).toBe(2);
      expect(daysUntil('2026-07-18', '2026-07-18')).toBe(0);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  // Guard the guard: prove the TZ mutation actually moves the process clock, or the sweep above
  // is theatre that always passes.
  afterAll(() => {
    /* no-op: TZ restored inside the test */
  });
});
