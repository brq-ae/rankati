import type { AvailabilityWindow } from '@rankati/shared';

/**
 * The calendar day it is *here*, as 'YYYY-MM-DD' (ADR 0052).
 *
 * This is the context the client owes the server. The server runs UTC and you do not, so
 * only the browser knows what day it is for you — and the Today read refuses to guess
 * (400 without it).
 *
 * LOCAL getters, deliberately. `toISOString().slice(0, 10)` would be shorter and would
 * return the UTC day: at 02:00 in Dubai it reports yesterday, so a task gated until today
 * would stay hidden for the first four hours of its own morning — silently, looking exactly
 * like the gate working. That is the bug 0052 exists to prevent, and this function is where
 * it would be reintroduced.
 *
 * `now` is a parameter so tests pass a fixed instant instead of asking the wall clock what
 * day it is.
 */
export function localDay(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The wall-clock time it is *here*, as zero-padded 24h 'HH:MM' (ADR 0070).
 *
 * localDay's sibling, and the other half of the clock context the client owes the server:
 * the availability-window gate is judged by the USER's clock, never the server's — the
 * server runs UTC and refuses to guess (400 the moment any windowed task exists).
 *
 * LOCAL getters and zero-padding, both load-bearing for the same reasons as localDay's:
 * UTC getters would report Dubai's 02:00 as 22:00 yesterday, and an un-padded '9:5' fails
 * the server's strict HH:MM parser — a clock whose meaning is negotiable is refused.
 *
 * `now` is a parameter so tests pass a fixed instant instead of asking the wall clock.
 */
export function localTime(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Is this task's gate still shut, as of `day`?
 *
 * Plain string comparison, which is exact rather than lucky: 'YYYY-MM-DD' sorts
 * lexicographically in the same order as the calendar, so '2026-07-21' > '2026-07-20'
 * means what it looks like. No Date is constructed, so no timezone can enter.
 */
export function isGated(notBefore: string | null, day: string): boolean {
  return notBefore !== null && notBefore > day;
}

/**
 * Is this availability window open at (day, 'HH:MM')? — the DISPLAY mirror of the server's
 * ADR 0070 predicate, for naming windowed-out tasks in the waiting strip. **The server
 * remains the gate**: this re-derives the answer for explanation only, exactly as the strip
 * already re-derives blocked and not-yet-due, and a drift here mis-labels a count — it never
 * un-hides a task. The spec pins the same end-exclusive boundary the server pins
 * (14:00 is CLOSED) so the two predicates cannot drift silently.
 *
 * The weekday is derived from the day string UTC-anchored — pin to UTC midnight, read
 * getUTCDay — the same discipline as everything else in this file: no construction that
 * lets the box's own timezone leak in.
 */
export function isWindowOpen(window: AvailabilityWindow, day: string, at: string): boolean {
  const dow = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  const workday = dow >= 1 && dow <= 5; // Mon–Fri, in getUTCDay numbering
  switch (window) {
    case 'working_hours':
      // End-EXCLUSIVE, like the server: at exactly '14:00' the window is shut (0070).
      return workday && at >= '08:00' && at < '14:00';
    case 'workdays':
      return workday;
    case 'weekend':
      return !workday;
  }
}

/**
 * Why are tasks missing from Today, and how many (ADRs 0052, 0053, 0070)?
 *
 * A task can be gated for SEVERAL reasons at once — blocked by an unfinished prerequisite,
 * dated for later, outside its availability window. Counting each reason independently would
 * make the parts exceed the whole: "2 waiting — 1 blocked, 2 not yet due" is nonsense on a
 * screen.
 *
 * So each task is counted exactly ONCE, in precedence order **blocked > not-yet-due >
 * outside-hours** — the more actionable reason names the task. Blocked is work you can go
 * and do right now; a date resolves by waiting for a DAY; a window resolves by waiting for
 * a mere HOUR. Saying "outside hours" about a task that is also blocked sends you to the
 * clock when the answer is "finish the other thing".
 *
 * `total` is the server's truth — active tasks the Today read did not return. The parts are
 * this client's explanation of it. They should always sum to it; if they ever do not, the
 * caller shows the total alone rather than an equation that does not add up.
 */
export interface Waiting {
  /** Active tasks Today did not return. */
  total: number;
  /** Waiting on an unfinished prerequisite. */
  blocked: number;
  /** Not blocked, but dated for a later day. */
  notYetDue: number;
  /** Not blocked, not dated — outside its availability window right now (ADR 0070). */
  outsideHours: number;
}

export function waitingBreakdown(
  all: {
    id: string;
    status: string;
    notBefore: string | null;
    dependsOn: string[];
    availabilityWindow: AvailabilityWindow | null;
  }[],
  todayIds: ReadonlySet<string>,
  day: string,
  at: string,
): Waiting {
  const statusById = new Map(all.map((t) => [t.id, t.status]));
  let total = 0;
  let blocked = 0;
  let notYetDue = 0;
  let outsideHours = 0;

  for (const task of all) {
    if (task.status !== 'active' || todayIds.has(task.id)) continue;
    total += 1;

    // A dependency id with no task behind it cannot normally happen — deleting a task
    // cascades its links (0053) — so an unknown id is treated as UNFINISHED rather than
    // assumed done. Guessing "done" would silently unblock.
    const isBlocked = task.dependsOn.some((id) => statusById.get(id) !== 'done');
    if (isBlocked) blocked += 1;
    else if (isGated(task.notBefore, day)) notYetDue += 1;
    else if (task.availabilityWindow !== null && !isWindowOpen(task.availabilityWindow, day, at))
      outsideHours += 1;
    // None of the three? Then this client cannot explain the absence — the two reads raced.
    // It is counted in `total` and in no part, and the caller notices the parts do not sum.
  }

  return { total, blocked, notYetDue, outsideHours };
}
