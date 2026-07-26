import type { Task } from '@rankati/shared';
import { msElapsed, RING_CIRCUMFERENCE, RING_RADIUS, TICK_GRACE_MS } from './tick';

/**
 * The completion tick — the done-circle plus the 15-second undo ring (ADR 0055).
 *
 * ONE definition, shared by the Lists row (TaskRow) and the dealt-hand card (TodayView, ADR 0074),
 * so "play a card" means exactly the same mechanic in both places: it LOOKS done the instant you
 * tap, nothing is written until the ring ends, and while the ring runs the same tap un-ticks it. All
 * the completion LOGIC (the grace period, commit-on-leave, undo) lives in App's onToggleTick — this
 * is only the control.
 */
export default function TickCircle({
  task,
  pendingUntil,
  onToggleTick,
}: {
  task: Task;
  /** Set while this tick is pending — the ring is running and nothing has been written. */
  pendingUntil?: number;
  onToggleTick: (id: string) => void;
}) {
  const ticked = task.status === 'done' || pendingUntil !== undefined;
  return (
    <button
      type="button"
      onClick={() => onToggleTick(task.id)}
      disabled={task.status === 'done'}
      aria-label={pendingUntil !== undefined ? `Undo completing ${task.title}` : `Complete ${task.title}`}
      className={`touch-manipulation relative grid size-6 shrink-0 place-items-center rounded-full border text-xs ${
        ticked ? 'border-primary bg-primary text-on-primary' : 'border-field text-transparent'
      }`}
    >
      {ticked ? '✓' : ''}
      {pendingUntil !== undefined && (
        // Drawn over the circle, winding down. Orange reads as "time running out".
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full -rotate-90 text-pending"
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
              // Duration from the constant, START POSITION from the real deadline: the negative
              // delay resumes the wind-down after a remount instead of restarting.
              animationDuration: `${TICK_GRACE_MS}ms`,
              animationDelay: `-${msElapsed(pendingUntil, Date.now())}ms`,
              ['--deck-ring-circumference' as string]: `${RING_CIRCUMFERENCE}`,
            }}
          />
        </svg>
      )}
    </button>
  );
}
