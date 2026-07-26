import type { AvailabilityWindow } from '@rankati/shared';

/**
 * The availability-window check (ADR 0070) — pure and CLOCK-FREE, like the rest of today/.
 *
 * Day-of-week and time-of-day are PASSED IN; nothing here reads the ambient clock. That is
 * what lets `isGated` stay one unit-testable predicate with no fixture clock (0059's shape),
 * and it is also the correctness argument: "is the window open?" is judged by the USER'S
 * local clock, which only the client knows — both boxes run UTC and the user does not (0052).
 */

/**
 * The day of week of a 'YYYY-MM-DD' local day: 0 = Sunday … 6 = Saturday.
 *
 * UTC-anchored, the exact discipline of scoring.ts's `daysUntil`: the string is pinned to
 * UTC midnight and read back with getUTCDay, so the server's own timezone cannot leak in.
 * DERIVED from `on` rather than sent as its own parameter, so the day and its weekday can
 * never disagree about what day it is (0070).
 */
export function dayOfWeekOf(on: string): number {
  return new Date(`${on}T00:00:00.000Z`).getUTCDay();
}

/**
 * Is this preset's window open at (day-of-week, local time)? (ADR 0070)
 *
 * `at` is zero-padded 24h 'HH:MM', which makes plain string comparison chronological —
 * the same trick the calendar-day gates lean on ('YYYY-MM-DD' compares as days, 0052).
 * The reads validate the format before it gets here; this function only compares.
 *
 * `working_hours` is END-EXCLUSIVE: at exactly '14:00' the window is CLOSED. "Until 14:00"
 * means the task is doable before two, not at the stroke of it — and half-open ranges are
 * the only kind that tile without overlap should a future preset ever abut this one.
 *
 * The switch is exhaustive over the closed set: a fourth preset added to the shared type
 * without a clause here is a compile error, not a silently-ungated window.
 */
export function windowOpen(window: AvailabilityWindow, dow: number, at: string): boolean {
  const workday = dow >= 1 && dow <= 5; // Mon–Fri, in getUTCDay numbering
  switch (window) {
    case 'working_hours':
      return workday && at >= '08:00' && at < '14:00';
    case 'workdays':
      return workday;
    case 'weekend':
      return !workday;
  }
}
