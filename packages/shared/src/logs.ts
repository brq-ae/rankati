/**
 * Log cadence stats — pure logic (ADR 0087), SHARED by every client like the pin (ADR 0086).
 *
 * A Log is a pull-based cadence tracker: its dated occurrences ARE its history. This derives the
 * neutral cadence stats a client shows when the Log is opened — last-done, how many, the average gap
 * between occurrences, and how long it's been since the last one. It is NEVER a nudge: no climb, no
 * overdue, no pace pressure (that is Reminders' world).
 *
 * Pure: no storage, no wall-clock — the caller passes `today` (the client's local day). It lives in
 * `@rankati/shared` so the api (which runs the built `dist`) and any future mobile/bot client compute
 * the IDENTICAL stats from one function, instead of each reimplementing the cadence math (ADR 0087).
 *
 * Calendar-day discipline (ADR 0052): occurrences and `today` are plain days (`YYYY-MM-DD`). Gaps are
 * counted between the DATES themselves, via a UTC day-index, so no timezone or DST shift can drift a
 * gap by a day.
 */

const MS_PER_DAY = 86_400_000;

/**
 * The day-index (whole days since the epoch) of a `YYYY-MM-DD` calendar date. Built through `Date.UTC`
 * on purpose: UTC has no DST, so the difference of two indices is the exact number of calendar days
 * between the dates regardless of the viewer's timezone — the 0052 discipline (ADR 0087).
 */
function dayIndex(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** The minimal per-occurrence input `computeLogStats` needs — a Log entry's calendar day. */
export interface LogEntryInput {
  doneOn: string; // YYYY-MM-DD
}

/**
 * The neutral cadence stats for a Log, derived from its occurrences against the client's local day.
 * `averageGapDays` is null until there are at least TWO occurrences (a single date has no gap — the
 * client shows "logged once on <date>" instead of a bogus average). `currentGapDays` and `lastDoneOn`
 * are null only when the Log has NO occurrences ("not logged yet").
 */
export interface LogStats {
  lastDoneOn: string | null;
  count: number;
  averageGapDays: number | null;
  currentGapDays: number | null;
}

/**
 * Derive a Log's cadence stats (ADR 0087). `entries` are its occurrences in any order; `today` is the
 * client's local day (`YYYY-MM-DD`). The average gap telescopes to (last − first) / (count − 1), i.e.
 * the mean of the consecutive gaps. Returned unrounded — the client rounds for the "usually ~35 days"
 * hint. `currentGapDays = today − lastDoneOn` (0 the day it was done).
 */
export function computeLogStats(entries: ReadonlyArray<LogEntryInput>, today: string): LogStats {
  const count = entries.length;
  if (count === 0) {
    return { lastDoneOn: null, count: 0, averageGapDays: null, currentGapDays: null };
  }

  // The most recent occurrence, by calendar day (not array order).
  const last = entries.reduce((max, e) => (dayIndex(e.doneOn) > dayIndex(max.doneOn) ? e : max));
  const lastDoneOn = last.doneOn;
  const currentGapDays = dayIndex(today) - dayIndex(lastDoneOn);

  let averageGapDays: number | null = null;
  if (count >= 2) {
    const days = entries.map((e) => dayIndex(e.doneOn));
    const span = Math.max(...days) - Math.min(...days);
    averageGapDays = span / (count - 1);
  }

  return { lastDoneOn, count, averageGapDays, currentGapDays };
}
