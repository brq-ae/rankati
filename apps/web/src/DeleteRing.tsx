import type { Task } from '@rankati/shared';
import { msElapsed, RING_CIRCUMFERENCE, RING_RADIUS, TICK_GRACE_MS } from './tick';

/**
 * The delete control — the ✕, and while a delete is pending its 15-second undo ring (ADR 0092, mirrors
 * TickCircle/0055). All the grace/commit/undo LOGIC lives in App's onToggleDelete; this is only the control.
 * A pending delete winds a DANGER-toned ring (vs the tick's orange) so it reads as "about to go", and the
 * same tap undoes it. Reuses the shared deck-ring geometry + its reduced-motion CSS, so behaviour matches
 * the tick exactly — the negative animation-delay resumes the wind-down after a remount instead of restarting.
 */
export default function DeleteRing({
  task,
  pendingDeleteUntil,
  onToggleDelete,
}: {
  task: Task;
  /** Set while this delete is pending — the ring is running and nothing has been written. */
  pendingDeleteUntil?: number;
  onToggleDelete: (id: string) => void;
}) {
  const pending = pendingDeleteUntil !== undefined;
  return (
    <button
      type="button"
      onClick={() => onToggleDelete(task.id)}
      aria-label={pending ? `Undo deleting ${task.title}` : `Delete ${task.title}`}
      className={
        pending
          ? 'touch-manipulation relative grid size-6 shrink-0 place-items-center rounded-full text-sm text-danger'
          : 'touch-manipulation shrink-0 rounded-sm px-2 py-1 text-sm text-faint hover:bg-danger-bg hover:text-danger'
      }
    >
      ✕
      {pending && (
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full -rotate-90 text-danger"
        >
          <circle
            className="deck-ring"
            cx="12"
            cy="12"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeDasharray={RING_CIRCUMFERENCE}
            style={{
              animationDuration: `${TICK_GRACE_MS}ms`,
              animationDelay: `-${msElapsed(pendingDeleteUntil, Date.now())}ms`,
              ['--deck-ring-circumference' as string]: `${RING_CIRCUMFERENCE}`,
            }}
          />
        </svg>
      )}
    </button>
  );
}
