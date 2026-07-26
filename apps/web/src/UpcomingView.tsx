import type { List, Task } from '@rankati/shared';
import { tierOf } from './tiers';
import UrgencySubtext from './UrgencySubtext';

/**
 * Upcoming — dated tasks that have a deadline ahead but have not yet crossed into Today
 * (ADR 0058). Ordered by the same escalated score the server computes for Today; this renders
 * that order without re-sorting, exactly as TodayView does.
 *
 * The tab answers "what is coming, and when", so it LEADS with the due date — the scannable
 * field — and shows the tier beside it, because the tier is what explains why one task surfaces
 * fourteen days out and another only three (ADR 0057). Every task here has a due date by
 * definition; that is what put it in this read.
 */
interface UpcomingViewProps {
  tasks: Task[];
  lists: List[];
  /** Full task list keyed by id, for the inherited-urgency subtext (ADR 0059) — see TodayView. */
  tasksById: ReadonlyMap<string, Task>;
  /** The active location filter's name (null = Everywhere) and how many it hides here (ADR 0060). */
  locationName: string | null;
  hiddenByFilter: number;
}

export default function UpcomingView({
  tasks,
  lists,
  tasksById,
  locationName,
  hiddenByFilter,
}: UpcomingViewProps) {
  const listName = (id: string) => lists.find((l) => l.id === id)?.name;

  if (tasks.length === 0) {
    return (
      <section className="rounded-2xl bg-card p-4 shadow-sm ring-1 ring-edge">
        <p className="text-muted">
          {locationName && hiddenByFilter > 0
            ? // Empty because FILTERED — name the place and the way out (ADR 0060).
              `Nothing upcoming at ${locationName} — ${hiddenByFilter} ${
                hiddenByFilter === 1 ? 'task is' : 'tasks are'
              } hidden by this filter. Switch to Everywhere to see ${
                hiddenByFilter === 1 ? 'it' : 'them'
              }.`
            : 'Nothing on the horizon — a task with a due date appears here, then climbs into Today as its deadline nears.'}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-card p-4 shadow-sm ring-1 ring-edge">
      <h2 className="mb-3 flex items-baseline justify-between gap-2">
        <span className="font-medium">Upcoming</span>
        <span className="text-xs text-faint">
          {tasks.length} with a deadline ahead, soonest-weighted
        </span>
      </h2>

      <ol className="flex flex-col gap-2">
        {tasks.map((task) => {
          const tier = tierOf(task.tier);
          return (
            <li
              key={task.id}
              className="flex items-baseline gap-3 rounded-xl bg-subtle px-3 py-2 ring-1 ring-divider"
            >
              {/* Leads with the due date, tinted by tier — the same ⚑ vocabulary the Lists row
                  uses, so the colour reads the same everywhere (tiers.ts is the one source). */}
              <span className={`shrink-0 text-sm tabular-nums ${tier.accent}`}>
                <span aria-hidden="true">⚑ </span>
                {task.due}
              </span>

              {/* The tier word — why this one is here at its distance. */}
              <span className="shrink-0 text-xs text-faint">{tier.label}</span>

              <span className="min-w-0 flex-1 break-words">
                {task.title}
                {listName(task.listId) && (
                  <span className="ml-2 text-xs text-faint">
                    {listName(task.listId)}
                  </span>
                )}
                <UrgencySubtext task={task} tasksById={tasksById} />
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
