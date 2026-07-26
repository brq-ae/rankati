import type { Task } from '@rankati/shared';
import { isGated, isWindowOpen, localDay, localTime } from './local-day';
import PendingBar from './PendingBar';
import TickCircle from './TickCircle';
import { tierOf } from './tiers';

/** The row marker's label for each preset (ADR 0070) — same words as TaskDetail's picker. */
const WINDOW_LABEL = {
  working_hours: 'Working hours',
  workdays: 'Workdays',
  weekend: 'Weekend',
} as const;

/**
 * One task in a list (ADRs 0054, 0056).
 *
 * TWO tap targets, cleanly separated: the done-circle completes, and the NAME opens the detail
 * view. Renaming, the dates and the tier are all SET there — the row only shows them. It grew a
 * form once (a date picker, an inline rename, a ⋯ button all competing on one line, and two
 * dates could hide the task name); this collapses it back. The small ✕ deletes, kept off at the
 * end where it cannot be mistaken for done.
 *
 * The layout is two lines when there is metadata to show and one when there is not:
 *   - line 1 is always the done-circle, the name, and ✕;
 *   - line 2 appears IFF the task has a not-before, a due, or a non-normal tier — the things
 *     worth a glance. When it is absent, the name is free to wrap to two lines; when it is
 *     present, the name stays one line and truncates, so metadata never squeezes the name out.
 */

interface TaskRowProps {
  task: Task;
  /** Every task, for resolving what this one requires. */
  tasks: Task[];
  /** Start the grace period, or take a pending tick back (ADR 0055). */
  onToggleTick: (id: string) => void;
  /** Set while this tick is pending — the ring is running and nothing has been written. */
  pendingUntil?: number;
  onDelete: (id: string) => void;
  /** Opens the detail view — where the name, dates, tier and list are edited. */
  onOpenDetail: (id: string) => void;
}

export default function TaskRow({
  task,
  tasks,
  onToggleTick,
  pendingUntil,
  onDelete,
  onOpenDetail,
}: TaskRowProps) {
  const tier = tierOf(task.tier);

  /** Line 2 exists only when there is something on it — a date, an ELEVATED tier, or an
   *  availability window (ADR 0070). A dateless, windowless, normal task has none, and its
   *  name may then wrap freely (see the class below). */
  const hasMeta =
    task.notBefore !== null ||
    task.due !== null ||
    task.tier !== 'normal' ||
    task.availabilityWindow !== null ||
    task.needsHand;

  const titleOf = (id: string) => tasks.find((t) => t.id === id)?.title ?? '(deleted)';
  const isDone = (id: string) => tasks.find((t) => t.id === id)?.status === 'done';

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {/* The tick control (ADR 0055) — the shared done-circle + undo ring, identical to the
            dealt-hand card so completing means the same thing in both places (ADR 0074). */}
        <TickCircle task={task} pendingUntil={pendingUntil} onToggleTick={onToggleTick} />

        {/* The NAME is the route to the detail view — no ⋯ and no inline rename (0056). The
            `title` gives desktop a full-name peek when it is truncated; the modal shows it in
            full everywhere. Truncated to one line when line 2 is present, clamped to two when it
            is not, so the name is never hidden by metadata. */}
        <button
          type="button"
          onClick={() => onOpenDetail(task.id)}
          aria-label={`Open details for ${task.title}`}
          title={task.title}
          className={`min-w-0 flex-1 text-left ${hasMeta ? 'truncate' : 'line-clamp-2 break-words'} ${
            task.status === 'done'
              ? 'text-faint line-through'
              : 'text-fg'
          }`}
        >
          {task.title}
        </button>

        {/* Minor and last, well clear of the done-circle so it cannot be mis-tapped for it. */}
        <button
          type="button"
          onClick={() => onDelete(task.id)}
          aria-label={`Delete ${task.title}`}
          className="touch-manipulation shrink-0 rounded-sm px-2 py-1 text-sm text-faint hover:bg-danger-bg hover:text-danger"
        >
          ✕
        </button>
      </div>

      {/* Line 2: the metadata glance (0056), display-only — set in the detail view. Rendered
          only when it has content, which is what frees the name to wrap when it does not. */}
      {hasMeta && (
        <div className="ml-8 flex flex-wrap items-center gap-2 text-xs">
          {/* Not before — the start gate (0052), with its unchanged amber "waiting" marker. ⧗ is
              monochrome so the amber tint lands. */}
          {task.notBefore && (
            <span
              aria-label={`Not before ${task.notBefore}`}
              title="Not before — hidden from Today until this day"
              className={`shrink-0 tabular-nums ${
                isGated(task.notBefore, localDay())
                  ? 'rounded-sm text-not-before ring-1 ring-not-before-edge'
                  : 'text-faint'
              }`}
            >
              <span aria-hidden="true">⧗ </span>
              {task.notBefore}
            </span>
          )}

          {/* Due — the deadline (0056), a different statement. The flag is TINTED by the tier
              accent (from the same tiers.ts the modal reads), a first hint of urgency. */}
          {task.due && (
            <span
              aria-label={`Due ${task.due}, importance ${tier.label}`}
              title={`Due ${task.due} — importance ${tier.label}`}
              className={`shrink-0 tabular-nums ${tier.accent}`}
            >
              <span aria-hidden="true">⚑ </span>
              {task.due}
            </span>
          )}

          {/* The tier dot — ONLY for a non-normal tier (0056). Normal is the baseline and shows
              nothing, so a dot always MEANS elevated. Colour is not the only signal: the label
              rides the due glyph and this dot's own title/aria-label. `data-tier` makes the tier
              machine-readable in the DOM and is what the Clear theme shape-codes (ADR 0062). */}
          {task.tier !== 'normal' && (
            <span
              aria-label={`Importance: ${tier.label}`}
              title={`Importance: ${tier.label}`}
              data-tier={task.tier}
              className={`size-2 shrink-0 rounded-full ${tier.swatch}`}
            />
          )}

          {/* The availability window (ADR 0070) — ALWAYS shown for a windowed task, absent for
              Anytime (null). Amber, in the EXACT not-before "waiting" treatment, when the window
              is shut right now; plain otherwise. Reuses isWindowOpen — the single display
              predicate this file, the waiting strip and TaskDetail all share. */}
          {task.availabilityWindow && (
            <span
              aria-label={`Availability: ${WINDOW_LABEL[task.availabilityWindow]}`}
              title="Availability window — when this task can be done"
              className={`shrink-0 ${
                isWindowOpen(task.availabilityWindow, localDay(), localTime())
                  ? 'text-faint'
                  : 'rounded-sm text-not-before ring-1 ring-not-before-edge'
              }`}
            >
              <span aria-hidden="true">⏰ </span>
              {WINDOW_LABEL[task.availabilityWindow]}
            </span>
          )}

          {/* The needs-a-hand marker (ADR 0071) — ALWAYS text-faint, NEVER the amber
              not-before/window treatment above. Amber means "currently held back" (a gate
              shutting the task out right now); needsHand is a soft label that never gates or
              holds anything back, so it never earns the amber that would say otherwise. */}
          {task.needsHand && (
            <span aria-label="Needs a hand" title="Involves or waits on a person" className="shrink-0 text-faint">
              <span aria-hidden="true">🤝 </span>
              needs a hand
            </span>
          )}
        </div>
      )}

      {/* What this task requires (ADR 0053) — read-only; editing lives in the detail view
          (0054). A blocked task still explains its own absence from Today. */}
      {task.dependsOn.map((id) => (
        <div key={id} className="ml-8 text-xs text-muted">
          <span className={isDone(id) ? 'text-faint line-through' : ''}>
            {isDone(id) ? '✓' : '⛓'} Requires: {titleOf(id)}
          </span>
        </div>
      ))}

      {/* The same countdown as the ring, spanning the row — one deadline (0055 addendum). */}
      {pendingUntil !== undefined && <PendingBar deadline={pendingUntil} />}
    </li>
  );
}
