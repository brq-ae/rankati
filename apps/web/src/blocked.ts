import type { Task } from '@rankati/shared';

export interface BlockedRow {
  task: Task;
  /** The unfinished DIRECT prerequisites this task waits on (ADR 0053). */
  waitingOn: Task[];
}

/**
 * The tasks currently blocked by an unfinished DIRECT prerequisite (ADRs 0053, 0069) — the Blocked
 * filter's read. Pure and client-side over the already-loaded set: a task is blocked iff some of its
 * `dependsOn` ids resolves, in THIS set, to a task that is not `done`. This is the same client-side
 * blocked-ness the Task DTO's `dependsOn` comment already relies on.
 *
 * Direct prerequisites only — no transitive walk (that would re-implement the server's graph rule,
 * free to drift, 0054). A `done` task is never itself "blocked". A prerequisite id that resolves to
 * nothing (deleted) does not block. Input order (already ranked) is preserved.
 */
export function blockedTasks(tasks: Task[]): BlockedRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows: BlockedRow[] = [];
  for (const task of tasks) {
    if (task.status === 'done') continue;
    const waitingOn = task.dependsOn
      .map((id) => byId.get(id))
      .filter((d): d is Task => d !== undefined && d.status !== 'done');
    if (waitingOn.length > 0) rows.push({ task, waitingOn });
  }
  return rows;
}
