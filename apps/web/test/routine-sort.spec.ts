import type { Routine } from '@rankati/shared';
import { describe, expect, it } from 'vitest';
import { pacePressure, sortRoutines } from '../src/routine-sort';

// A Routine with everything null; each test overrides only the fields its case exercises.
const base: Routine = {
  id: '', ownerId: 'o', name: '', type: 'frequency', createdAt: '2026-01-01T00:00:00.000Z',
  snoozedUntil: null, periodUnit: null, targetCount: null, periodCount: null, periodStart: null,
  intervalUnit: null, intervalCount: null, preferredWeekday: null, nextDue: null,
  ruleKind: null, ruleOrdinal: null, ruleWeekday: null, ruleDayOfMonth: null, acknowledgedDate: null,
};
// A weekly frequency routine anchored to the current week's Monday (2026-07-20).
const freq = (name: string, target: number, count: number, periodStart = '2026-07-20'): Routine => ({
  ...base, id: name, name, type: 'frequency', periodUnit: 'week', targetCount: target,
  periodCount: count, periodStart,
});
const due = (name: string, nextDue: string): Routine => ({
  ...base, id: name, name, type: 'interval_floating', nextDue,
});
const ids = (rs: Routine[]) => rs.map((r) => r.id);

// The week 2026-07-20 (Mon) .. 2026-07-27 (next Mon). Sat = 07-25 (2 days left), Tue = 07-21 (6 left).
describe('pace pressure = remaining / daysLeft (ADR 0066 v0.18 extension)', () => {
  it('the worked example: gym 0/3 on Saturday is more at risk than read 1/5 on Tuesday', () => {
    // Shared calendar weeks mean this is a CROSS-DAY metric comparison (each on its own day) — the
    // exact framing the approved ADR used: gym 3/2 = 1.5 vs read 4/6 ≈ 0.667.
    const gymSat = pacePressure(freq('gym', 3, 0), '2026-07-25');
    const readTue = pacePressure(freq('read', 5, 1), '2026-07-21');
    expect(gymSat).toBeCloseTo(1.5, 5);
    expect(readTue).toBeCloseTo(4 / 6, 5);
    expect(gymSat).toBeGreaterThan(readTue);
  });

  it('goal-met has pace pressure 0', () => {
    expect(pacePressure(freq('met', 3, 3), '2026-07-25')).toBe(0);
    expect(pacePressure(freq('over', 3, 5), '2026-07-25')).toBe(0);
  });
});

describe('the climb order (two bands; pace within the frequency band)', () => {
  const on = '2026-07-25'; // Saturday — 2 days left this week
  const eOverdue = due('e-overdue', '2026-07-24'); // due-based, overdue (-1)
  const dDue5 = due('d-due5', '2026-07-30'); // due-based, +5
  const bP20 = freq('b-p20', 5, 1); // remaining 4 / 2 = 2.0
  const aP15 = freq('a-p15', 3, 0); // remaining 3 / 2 = 1.5
  const cMet = freq('c-met', 3, 3); // remaining 0 -> pressure 0

  it('due-based first (overdue→soonest), then frequency band by pace, goal-met last', () => {
    const out = sortRoutines([cMet, aP15, dDue5, bP20, eOverdue], on);
    expect(ids(out)).toEqual(['e-overdue', 'd-due5', 'b-p20', 'a-p15', 'c-met']);
  });

  it('every frequency sits below every due-based, even a far-off due one', () => {
    // dDue5 is 5 days out; the frequencies are highly pressured — they STILL rank below it.
    const out = sortRoutines([bP20, aP15, dDue5], on);
    expect(ids(out)).toEqual(['d-due5', 'b-p20', 'a-p15']);
    expect(out.slice(1).every((r) => r.type === 'frequency')).toBe(true);
  });

  it('within the frequency band, more pace pressure ranks higher; goal-met sinks', () => {
    const out = sortRoutines([cMet, aP15, bP20], on);
    expect(ids(out)).toEqual(['b-p20', 'a-p15', 'c-met']);
  });
});
