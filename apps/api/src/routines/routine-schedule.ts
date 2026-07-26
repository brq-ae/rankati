import type { FixedRule, IntervalUnit, PeriodUnit } from '@rankati/shared';

/**
 * The pure date math for routines (ADR 0066). No I/O, no `now()` — every function takes the calendar
 * day it should reckon against, so the reads/writes stay compute-fresh-per-read (0059) and the whole
 * module is deterministic and unit-testable.
 *
 * Calendar days are `YYYY-MM-DD` strings with UTC-midnight semantics (the 0052 discipline). Weekdays
 * are 0–6 with 0 = Sunday (JS `getUTCDay`). String comparison on `YYYY-MM-DD` is chronological, and
 * this module relies on that.
 */

function parse(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}
function fmt(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}
export function addDays(day: string, n: number): string {
  const dt = parse(day);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmt(dt);
}
function weekdayOf(day: string): number {
  return parse(day).getUTCDay();
}
function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Whole days from `on` to `day`; negative = past/overdue. What the tab needs to order by climbing. */
export function daysUntil(day: string, on: string): number {
  return Math.round((parse(day).getTime() - parse(on).getTime()) / 86_400_000);
}

// ── Frequency ────────────────────────────────────────────────────────────────────────────────────

/** The start-of-period calendar day for `day`: itself / that week's Monday / the 1st / Jan 1. */
export function periodStartOf(unit: PeriodUnit, day: string): string {
  const dt = parse(day);
  if (unit === 'day') return day;
  if (unit === 'week') {
    const sinceMonday = (dt.getUTCDay() + 6) % 7; // Mon→0, Tue→1, … Sun→6
    return addDays(day, -sinceMonday);
  }
  if (unit === 'month') return fmt(new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1)));
  return fmt(new Date(Date.UTC(dt.getUTCFullYear(), 0, 1))); // year
}

/**
 * Has the stored period rolled over relative to `on`? A read shows 0 when stale (no history — the
 * prior period is discarded); a "Did it" write resets the count before incrementing. A null start
 * (fresh routine) reads as stale so it starts at 0.
 */
export function isPeriodStale(unit: PeriodUnit, periodStart: string | null, on: string): boolean {
  if (periodStart === null) return true;
  return periodStart !== periodStartOf(unit, on);
}

// ── Interval — floating ───────────────────────────────────────────────────────────────────────────

/** `day` + `count` units. Month arithmetic clamps the day to the target month's length (Jan 31 +1mo → Feb 28). */
export function addInterval(day: string, unit: IntervalUnit, count: number): string {
  if (unit === 'day') return addDays(day, count);
  if (unit === 'week') return addDays(day, count * 7);
  const dt = parse(day);
  const totalMonth = dt.getUTCMonth() + count;
  const year = dt.getUTCFullYear() + Math.floor(totalMonth / 12);
  const month0 = ((totalMonth % 12) + 12) % 12;
  const d = Math.min(dt.getUTCDate(), daysInMonth(year, month0));
  return fmt(new Date(Date.UTC(year, month0, d)));
}

/**
 * Snap `day` FORWARD to the next occurrence of `preferredWeekday` — never earlier. If `day` already
 * IS that weekday, stay on it (delta 0, no over-advance). Null preference → `day` unchanged.
 */
export function snapForward(day: string, preferredWeekday: number | null): string {
  if (preferredWeekday === null) return day;
  const delta = (preferredWeekday - weekdayOf(day) + 7) % 7;
  return addDays(day, delta);
}

/** What "Did it" writes for a floating routine: completion + interval, then snapped to the weekday. */
export function nextFloatingDue(
  completionDay: string,
  unit: IntervalUnit,
  count: number,
  preferredWeekday: number | null,
): string {
  return snapForward(addInterval(completionDay, unit, count), preferredWeekday);
}

// ── Interval — fixed ──────────────────────────────────────────────────────────────────────────────

/** The rule's occurrence within a given month, or null when it doesn't exist (e.g. a 5th Friday). */
function occurrenceInMonth(rule: FixedRule, year: number, month0: number): string | null {
  const dim = daysInMonth(year, month0);
  if (rule.kind === 'day_of_month') {
    // CLAMP to the last day: "the 31st" fires on Feb 28/29. There is no last-day-of-month pattern, so
    // clamping is the only way to express end-of-month, and it never collides with another pattern.
    return fmt(new Date(Date.UTC(year, month0, Math.min(rule.day, dim))));
  }
  if (rule.kind === 'last_weekday_of_month') {
    const lastWd = new Date(Date.UTC(year, month0, dim)).getUTCDay();
    return fmt(new Date(Date.UTC(year, month0, dim - ((lastWd - rule.weekday + 7) % 7))));
  }
  // nth_weekday_of_month
  const firstWd = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  const dayNum = 1 + ((rule.weekday - firstWd + 7) % 7) + (rule.ordinal - 1) * 7;
  // SKIP when the ordinal doesn't exist this month (only a 5th can be missing): "5th Friday" means the
  // 5th or nothing — clamping to the 4th would silently become last_weekday, an already-separate pattern.
  return dayNum > dim ? null : fmt(new Date(Date.UTC(year, month0, dayNum)));
}

/** The earliest occurrence of `rule` on or after `on` (recomputes to next month once the date passes). */
export function nextFixedOccurrence(rule: FixedRule, on: string): string {
  const start = parse(on);
  let year = start.getUTCFullYear();
  let month0 = start.getUTCMonth();
  for (let i = 0; i < 120; i++) {
    const occ = occurrenceInMonth(rule, year, month0);
    if (occ !== null && occ >= on) return occ;
    if (++month0 > 11) {
      month0 = 0;
      year += 1;
    }
  }
  // Unreachable for a valid rule (a 5th weekday recurs within a handful of months); loud if it isn't.
  throw new Error(`nextFixedOccurrence: no occurrence within 120 months for ${JSON.stringify(rule)}`);
}
