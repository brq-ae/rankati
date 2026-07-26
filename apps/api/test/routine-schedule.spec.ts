import { describe, expect, it } from 'vitest';
import {
  addInterval,
  daysUntil,
  isPeriodStale,
  nextFixedOccurrence,
  nextFloatingDue,
  periodStartOf,
  snapForward,
} from '../src/routines/routine-schedule';

/**
 * Pure date math for routines (ADR 0066) — no DB, no clock. Dates verified against the 2026 calendar
 * (weekday 0 = Sunday). Jan 1 2026 = Thursday; Jan 2026 has FIVE Fridays (2,9,16,23,30); Feb 2026 has
 * FOUR (6,13,20,27) and 28 days; Feb 2028 is a leap February (29 days).
 */
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const FRI = 5;
const SUN = 0;

describe('daysUntil — the tab-ordering primitive', () => {
  it('0 same day, positive future, negative overdue (overdue climbs to the top)', () => {
    expect(daysUntil('2026-01-10', '2026-01-10')).toBe(0);
    expect(daysUntil('2026-01-15', '2026-01-10')).toBe(5);
    expect(daysUntil('2026-01-05', '2026-01-10')).toBe(-5); // an overdue floating routine sorts first
  });
});

describe('periodStartOf', () => {
  it('day → itself', () => expect(periodStartOf('day', '2026-01-14')).toBe('2026-01-14'));
  it('week → that week’s Monday', () => {
    expect(periodStartOf('week', '2026-01-14')).toBe('2026-01-12'); // Wed → Mon
    expect(periodStartOf('week', '2026-01-12')).toBe('2026-01-12'); // Mon → Mon
    expect(periodStartOf('week', '2026-01-18')).toBe('2026-01-12'); // Sun → its Monday
  });
  it('month → the 1st', () => expect(periodStartOf('month', '2026-01-14')).toBe('2026-01-01'));
  it('year → Jan 1', () => expect(periodStartOf('year', '2026-07-14')).toBe('2026-01-01'));
});

describe('isPeriodStale — frequency reset detection', () => {
  it('null start is stale, so a fresh routine reads 0', () => {
    expect(isPeriodStale('week', null, '2026-01-14')).toBe(true);
  });
  it('same period not stale; an earlier period is stale, per unit', () => {
    expect(isPeriodStale('week', '2026-01-12', '2026-01-14')).toBe(false);
    expect(isPeriodStale('week', '2026-01-05', '2026-01-14')).toBe(true); // last week
    expect(isPeriodStale('month', '2025-12-01', '2026-01-14')).toBe(true);
    expect(isPeriodStale('year', '2025-01-01', '2026-07-14')).toBe(true);
    expect(isPeriodStale('day', '2026-01-13', '2026-01-14')).toBe(true);
  });
});

describe('addInterval', () => {
  it('days and weeks are plain day arithmetic', () => {
    expect(addInterval('2026-01-01', 'day', 10)).toBe('2026-01-11');
    expect(addInterval('2026-01-01', 'week', 3)).toBe('2026-01-22');
  });
  it('months clamp the day to the target month (Jan 31 + 1mo → Feb 28)', () => {
    expect(addInterval('2026-01-31', 'month', 1)).toBe('2026-02-28');
    expect(addInterval('2026-01-15', 'month', 2)).toBe('2026-03-15');
  });
});

describe('snapForward — the "never earlier" rule', () => {
  it('null preference leaves the day untouched', () => {
    expect(snapForward('2026-01-06', null)).toBe('2026-01-06');
  });
  it('EDGE: already ON the preferred weekday → stay, do NOT push a week forward', () => {
    expect(weekday('2026-01-04')).toBe(SUN); // Sunday
    expect(snapForward('2026-01-04', SUN)).toBe('2026-01-04');
  });
  it('Tuesday → next Sunday (5 days forward, never back)', () => {
    expect(weekday('2026-01-06')).toBe(2); // Tuesday
    expect(snapForward('2026-01-06', SUN)).toBe('2026-01-11');
  });
});

describe('nextFloatingDue — Did it (interval then snap)', () => {
  it('done Tue 6th, every 3 weeks, preferred Sunday → +3wk = Tue 27th → next Sun = Feb 1', () => {
    expect(nextFloatingDue('2026-01-06', 'week', 3, SUN)).toBe('2026-02-01');
  });
  it('no preferred weekday → just the interval', () => {
    expect(nextFloatingDue('2026-01-06', 'week', 3, null)).toBe('2026-01-27');
  });
});

describe('nextFixedOccurrence — nth_weekday_of_month ("1st Friday")', () => {
  const firstFri = { kind: 'nth_weekday_of_month', ordinal: 1, weekday: FRI } as const;
  it('this month before it, next month after it (two consecutive months)', () => {
    expect(nextFixedOccurrence(firstFri, '2026-01-01')).toBe('2026-01-02');
    expect(nextFixedOccurrence(firstFri, '2026-01-03')).toBe('2026-02-06'); // Jan's passed
  });
  it('the occurrence day itself counts (>= on)', () => {
    expect(nextFixedOccurrence(firstFri, '2026-01-02')).toBe('2026-01-02');
  });
});

describe('nextFixedOccurrence — EDGE: a 5th weekday that does not exist → SKIP the month', () => {
  const fifthFri = { kind: 'nth_weekday_of_month', ordinal: 5, weekday: FRI } as const;
  it('Jan 2026 HAS a 5th Friday (Jan 30)', () => {
    expect(nextFixedOccurrence(fifthFri, '2026-01-01')).toBe('2026-01-30');
  });
  it('from Feb 2026 (only four Fridays) it rolls PAST February to a real 5th Friday', () => {
    const r = nextFixedOccurrence(fifthFri, '2026-02-01');
    expect(r.slice(0, 7)).not.toBe('2026-02'); // February skipped, not clamped
    expect(weekday(r)).toBe(FRI); // still a Friday
    expect(Number(r.slice(8, 10))).toBeGreaterThanOrEqual(29); // genuinely a 5th (day >= 29)
  });
});

describe('nextFixedOccurrence — EDGE: day_of_month beyond the month → CLAMP to last day', () => {
  it('"the 31st" → Feb 28 in 2026, Feb 29 in leap 2028', () => {
    expect(nextFixedOccurrence({ kind: 'day_of_month', day: 31 }, '2026-02-01')).toBe('2026-02-28');
    expect(nextFixedOccurrence({ kind: 'day_of_month', day: 31 }, '2028-02-01')).toBe('2028-02-29');
  });
  it('"the 15th" is exact every month', () => {
    expect(nextFixedOccurrence({ kind: 'day_of_month', day: 15 }, '2026-01-01')).toBe('2026-01-15');
  });
});

describe('nextFixedOccurrence — last_weekday_of_month ("last Friday")', () => {
  const lastFri = { kind: 'last_weekday_of_month', weekday: FRI } as const;
  it('last Friday of Jan 2026 is Jan 30, then Feb 27 once January passes', () => {
    expect(nextFixedOccurrence(lastFri, '2026-01-01')).toBe('2026-01-30');
    expect(nextFixedOccurrence(lastFri, '2026-01-31')).toBe('2026-02-27');
  });
});
