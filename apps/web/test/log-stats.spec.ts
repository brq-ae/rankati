import { describe, expect, it } from 'vitest';
import { type LogEntryInput, computeLogStats } from '@rankati/shared';

/**
 * Log cadence stats (ADR 0087). Pure — the caller passes `today`. Covers the entry-count boundaries
 * (0 / 1 / 2 / N), the null-average rule (<2 occurrences), the gap math (mean, order-independence),
 * and the calendar-day discipline (0052): gaps counted straight from the dates, no timezone/DST drift.
 */
const e = (...dates: string[]): LogEntryInput[] => dates.map((doneOn) => ({ doneOn }));

describe('computeLogStats — Log cadence stats (ADR 0087)', () => {
  describe('entry-count boundaries', () => {
    it('0 entries → not-logged-yet: all null, count 0', () => {
      expect(computeLogStats([], '2026-02-10')).toEqual({
        lastDoneOn: null,
        count: 0,
        averageGapDays: null,
        currentGapDays: null,
      });
    });

    it('1 entry → last-done + current gap, but NO average (a single date has no gap)', () => {
      expect(computeLogStats(e('2026-01-21'), '2026-02-10')).toEqual({
        lastDoneOn: '2026-01-21',
        count: 1,
        averageGapDays: null,
        currentGapDays: 20,
      });
    });

    it('the null-average boundary is exactly 2: appears at 2, absent at 1', () => {
      expect(computeLogStats(e('2026-01-01'), '2026-01-01').averageGapDays).toBeNull();
      expect(computeLogStats(e('2026-01-01', '2026-01-11'), '2026-01-11').averageGapDays).toBe(10);
    });
  });

  describe('gap math', () => {
    it('2 entries → average is the single gap between them', () => {
      expect(computeLogStats(e('2026-01-01', '2026-01-11'), '2026-01-20')).toEqual({
        lastDoneOn: '2026-01-11',
        count: 2,
        averageGapDays: 10,
        currentGapDays: 9,
      });
    });

    it('N even gaps → average is that gap (span / (count-1))', () => {
      expect(computeLogStats(e('2026-01-01', '2026-01-11', '2026-01-21'), '2026-01-21')).toMatchObject({
        count: 3,
        averageGapDays: 10,
        currentGapDays: 0,
      });
    });

    it('N uneven gaps → the MEAN, not the median (gaps 5 and 15 → 10)', () => {
      expect(computeLogStats(e('2026-01-01', '2026-01-06', '2026-01-21'), '2026-02-10')).toMatchObject({
        lastDoneOn: '2026-01-21',
        averageGapDays: 10,
        currentGapDays: 20,
      });
    });

    it('a fractional mean is returned unrounded (client rounds the hint)', () => {
      // gaps 30 and 40 over 2 intervals → 70/2 = 35; add a third of 41 → 111/3 = 37
      expect(computeLogStats(e('2026-01-01', '2026-01-31', '2026-03-12'), '2026-03-12').averageGapDays).toBe(35);
      expect(
        computeLogStats(e('2026-01-01', '2026-01-31', '2026-03-12', '2026-04-22'), '2026-04-22').averageGapDays,
      ).toBe(37);
    });

    it('order-independent — shuffled occurrences give the same stats', () => {
      const ordered = computeLogStats(e('2026-01-01', '2026-01-06', '2026-01-21'), '2026-02-10');
      const shuffled = computeLogStats(e('2026-01-21', '2026-01-01', '2026-01-06'), '2026-02-10');
      expect(shuffled).toEqual(ordered);
    });

    it('current gap is 0 the day it was done', () => {
      expect(computeLogStats(e('2026-01-10', '2026-02-14'), '2026-02-14').currentGapDays).toBe(0);
    });
  });

  describe('calendar-day discipline (ADR 0052) — no timezone/DST drift', () => {
    it('counts days straight across a DST spring-forward boundary', () => {
      // Around a typical mid-March DST change: 2 calendar days, not 1.96 or 2.04.
      expect(computeLogStats(e('2026-03-07', '2026-03-09'), '2026-03-09').averageGapDays).toBe(2);
    });

    it('counts across a year boundary (Dec 31 → Jan 1 = 1 day)', () => {
      expect(computeLogStats(e('2025-12-31', '2026-01-01'), '2026-01-01').averageGapDays).toBe(1);
    });

    it('honours a leap day (2028-02-28 → 2028-03-01 = 2 days, Feb 29 exists)', () => {
      expect(computeLogStats(e('2028-02-28', '2028-03-01'), '2028-03-01').averageGapDays).toBe(2);
    });

    it('current gap spans a month boundary correctly', () => {
      expect(computeLogStats(e('2026-01-21'), '2026-03-02').currentGapDays).toBe(40);
    });
  });
});
