import type { Task } from '@rankati/shared';

/**
 * The inherited-urgency subtext (ADR 0059): "for: <deadline> (<due>)". A task ranks high not for
 * its own deadline but for one it unblocks, and this says which — the same principle as the
 * overdue marker (a visible reason for the rank).
 *
 * Ids-only (0053): the server sends `urgencySourceId`, and the source's title and due are resolved
 * from the client's own full task list. It renders NOTHING in three cases, all graceful:
 *   - no `urgencySourceId` — the task's own urgency drives it, nothing to explain;
 *   - the source is not resolvable — it is blocked and absent from this response, and a race left
 *     the client without it; show no dangling id;
 *   - the source is DONE — decision 8 says inherited urgency vanishes when the deadline completes,
 *     but the client's two fetches do not land at the same instant: for one render the scored read
 *     still carries the id while the task list already shows the source finished. Never point the
 *     subtext at a completed task; the next read drops the id.
 */
export default function UrgencySubtext({
  task,
  tasksById,
}: {
  task: Task;
  tasksById: ReadonlyMap<string, Task>;
}) {
  const id = task.urgencySourceId;
  if (!id) return null;
  const source = tasksById.get(id);
  if (!source || source.status === 'done') return null;
  return (
    <span className="block text-xs italic text-faint">
      for: {source.title}
      {source.due ? ` (${source.due})` : ''}
    </span>
  );
}
