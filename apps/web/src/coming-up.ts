import type { Task } from '@rankati/shared';
import { isGated, isWindowOpen } from './local-day';

/**
 * "Coming up" — the GLOBAL gated set (ADR 0074): active tasks the server dropped from BOTH Today and
 * Upcoming (gated by date / dependency / hours), soonest-to-unlock first, each labeled with its reason.
 *
 * Membership is SERVER-AUTHORITATIVE: a task is "coming up" iff it is active and in neither the Today
 * nor the Upcoming read — a plain set difference, no re-derived gates. The reason and the sort ARE
 * derived client-side (the same display mirror the waiting strip already used, 0059/0070) — a drift
 * there mis-labels or mis-orders a task, it never changes membership. GLOBAL, not location-scoped:
 * soon-to-unlock is a "what's next" signal, not a here-and-now context read.
 */
export interface ComingUpItem {
  task: Task;
  /** Why it is not yet playable — the most actionable gate (blocked > not-before > hours). */
  reason: string;
  /** Sort key: smaller unlocks sooner. Blocked = unknown (last); a window reopens within a day;
   *  a not-before unlocks on its date, ordered by how many days out. */
  order: number;
}

/** Whole days from `today` to `date` ('YYYY-MM-DD'), UTC-anchored so no timezone leaks in. */
function daysUntil(date: string, today: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`);
  return Math.round(ms / 86_400_000);
}

export function comingUp(
  tasks: Task[],
  todayIds: ReadonlySet<string>,
  upcomingIds: ReadonlySet<string>,
  day: string,
  at: string,
): ComingUpItem[] {
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));
  const titleById = new Map(tasks.map((t) => [t.id, t.title]));
  const items: ComingUpItem[] = [];

  for (const task of tasks) {
    // The gated set: active, and in NEITHER read. (Upcoming is playable-later-ungated — excluded.)
    if (task.status !== 'active' || todayIds.has(task.id) || upcomingIds.has(task.id)) continue;

    // Precedence blocked > not-before > hours (waitingBreakdown's order): the most actionable reason
    // names the task, and it drives the sort key.
    const unfinished = task.dependsOn.filter((id) => statusById.get(id) !== 'done');
    if (unfinished.length > 0) {
      const names = unfinished.map((id) => titleById.get(id) ?? '(deleted)').join(', ');
      items.push({ task, reason: `waiting on ${names}`, order: Number.POSITIVE_INFINITY });
    } else if (isGated(task.notBefore, day)) {
      items.push({ task, reason: `not before ${task.notBefore}`, order: daysUntil(task.notBefore!, day) });
    } else if (task.availabilityWindow !== null && !isWindowOpen(task.availabilityWindow, day, at)) {
      // A window reopens within a day — sooner than any future not-before, later than "now".
      items.push({ task, reason: 'outside hours', order: 0.5 });
    } else {
      // None of the three: the reads raced (server gated it, client cannot explain). Show it plainly,
      // sorted last-but-before-blocked, rather than dropping it — the set difference is the truth.
      items.push({ task, reason: 'not playable yet', order: Number.MAX_SAFE_INTEGER });
    }
  }

  // Soonest-to-unlock first; stable tiebreak by rating desc so a stable order is shown within a bucket.
  return items.sort((a, b) => a.order - b.order || b.task.rating - a.task.rating);
}
