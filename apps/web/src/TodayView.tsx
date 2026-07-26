import type { ReactNode } from 'react';
import type { Effort, List, Task } from '@rankati/shared';
import { localDay, type Waiting } from './local-day';
import { EFFORTS, type Thresholds, bucketLabel } from './effort-prefs';
import type { ComingUpItem } from './coming-up';
import type { HandState } from './hand';
import PendingBar from './PendingBar';
import TickCircle from './TickCircle';
import UrgencySubtext from './UrgencySubtext';

/** A group of playable errands at one other place — the "When you head out" strip (ADR 0074). */
export interface HeadOutGroup {
  name: string;
  tasks: Task[];
}

/**
 * Today — the dealt HAND (ADR 0074), the payoff of importance + urgency + fit.
 *
 * Today is no longer an open-ended ranked list: it is a finite, beatable HAND — the top-N playable
 * cards, HELD and manual. One stable layout renders exactly one of three states: the `hand` (the
 * held cards), `won` ("you beat the deck" — cleared, cards remain to deal), or `nothing-playable`
 * (never blank — the strips are the focus). The block picker stays at the top and shapes what is
 * dealt (0072).
 *
 * The composition, the held set and Deal again all live in App over `hand.ts`; this renders what it
 * is handed. Scoring, gating, the overdue pin (0058) and inherited-urgency subtexts (0059) are the
 * server's — unchanged. The ONLY thing computed here is the "overdue" marker (`due < today`), so the
 * pin is legible without re-deriving score. Ratings are shown — the number explains the order (0050).
 */

interface TodayViewProps {
  /** The SHOWN hand — held ∩ playable, ranked, capped at N (ADR 0074). Rendered exactly as given. */
  hand: Task[];
  /** Which of the three states to render (ADR 0074): hand / won / nothing-playable. */
  state: HandState;
  /** Deal again — top up the empty slots with the next-best not-held (ADR 0074). */
  onDealAgain: () => void;
  /** Whether Deal again would do anything — there are empty slots AND more playable to pull. */
  canDeal: boolean;
  /** Complete a card FROM the hand (ADR 0074) — the same tick/undo mechanic as Lists (ADR 0055). */
  onToggleTick: (id: string) => void;
  /** The impact safety-net pin (ADR 0075) — one task to surface above the hand, or null. */
  pinTask: Task | null;
  /** The pin's reason line, e.g. "high-impact · 8 days" (ADR 0075). */
  pinReason: string;
  /** Dismiss the pin for its level's span (ADR 0075) — High a day, Medium three. */
  onSnoozePin: () => void;
  /** Open a task's detail — used by the pin card's tap (the same path as elsewhere). */
  onOpenDetail: (id: string) => void;
  lists: List[];
  /**
   * What is being held back, and why (0052, 0053).
   *
   * Without this a gated task is simply absent, which reads as a bug. 0052 says Today and
   * Lists disagreeing is the feature working — but only if you can tell.
   */
  waiting: Waiting;
  /**
   * Pending ticks, task id -> commit deadline (ADR 0055 addendum). A task ticked in Lists is
   * still active, so it is still HERE — this lets its row show the same draining countdown
   * rather than sitting untouched for fifteen seconds. Read-only; Today never starts a tick.
   */
  pending: ReadonlyMap<string, number>;
  /**
   * The full task list keyed by id, for resolving the inherited-urgency subtext (ADR 0059). A row
   * pulled up by a deadline it unblocks carries that deadline's id in `urgencySourceId`; this is
   * how the row names it. The map spans ALL tasks, including the blocked source itself, which is
   * absent from Today's own list.
   */
  tasksById: ReadonlyMap<string, Task>;
  /**
   * The active location filter's name, or null for Everywhere (ADR 0060). With `hiddenByFilter`,
   * this lets an empty view say WHY it is empty — "nothing here" reads differently from "nothing
   * to do", and a filter that silently empties a view is the lying view 0060 exists to prevent.
   */
  locationName: string | null;
  /** How many Today tasks the active filter is hiding — 0 when Everywhere or nothing is hidden. */
  hiddenByFilter: number;
  /**
   * The free BLOCK the hand is dealt against — the fit term (ADR 0072). `undefined` = Any, the
   * default and the neutral state; a bucket sinks the too-big tasks. EPHEMERAL — it lives in App's
   * React state and resets to Any each session, so this picker always opens on Any after a reload.
   */
  block: Effort | undefined;
  onSelectBlock: (block: Effort | undefined) => void;
  /** The display-only minute thresholds that LABEL the buckets (0072) — client-side, never sent. */
  thresholds: Thresholds;
  /** "When you head out" (ADR 0074) — playable errands at OTHER places, grouped. Empty at Everywhere. */
  headOut: HeadOutGroup[];
  /** "Coming up" (ADR 0074) — the global gated set, soonest-to-unlock first, each with its reason. */
  comingUp: ComingUpItem[];
}

/** A collapsible strip below the hand (ADR 0074): a one-line bar + count, tap to expand. Native
 *  `<details>` for the disclosure — keyboard and screen-reader support come free. Absent when empty. */
function Strip({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <details className="mt-3 rounded-xl bg-subtle ring-1 ring-divider">
      <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-body">
        {title} <span className="text-xs text-faint">({count})</span>
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  );
}

/**
 * "3 waiting — 1 blocked, 2 not yet due" — or "… 2 outside hours" (ADR 0070).
 *
 * The reasons are worth splitting because they call for different things: blocked means go
 * and do the other task; not-yet-due means do nothing until its day; outside-hours means do
 * nothing until its window opens ("outside hours" is invariant — never pluralised). The
 * parts sum to the total by construction (precedence, each task counted once — see
 * waitingBreakdown), but if they ever do not, the total is shown alone rather than an
 * equation that does not add up.
 */
function waitingLine(w: Waiting): string {
  const tasks = `${w.total} ${w.total === 1 ? 'task' : 'tasks'} waiting`;
  if (w.blocked + w.notYetDue + w.outsideHours !== w.total) return tasks;

  const parts: string[] = [];
  if (w.blocked > 0) parts.push(`${w.blocked} blocked`);
  if (w.notYetDue > 0) parts.push(`${w.notYetDue} not yet due`);
  if (w.outsideHours > 0) parts.push(`${w.outsideHours} outside hours`);
  return parts.length > 0 ? `${tasks} — ${parts.join(', ')}` : tasks;
}

/**
 * The free-block picker (ADR 0072) — Any · Quick · Medium · Long, at the TOP of Today. Any is the
 * default and the neutral state (fit off); choosing a bucket sinks the too-big tasks in the hand.
 * The bucket labels come from the client thresholds; the ordinal is all that is sent to re-rank.
 *
 * Rendered above BOTH the empty state and the list, so the owner can change the block even when
 * the current one leaves nothing playable — the picker is context, not part of the list.
 */
function BlockPicker({
  block,
  onSelectBlock,
  thresholds,
}: Pick<TodayViewProps, 'block' | 'onSelectBlock' | 'thresholds'>) {
  return (
    <div className="mb-3 flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">Free block</span>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Free block">
        <button
          type="button"
          onClick={() => onSelectBlock(undefined)}
          aria-label="Free block: Any"
          aria-pressed={block === undefined}
          className={`touch-manipulation rounded-xl px-2 py-1 text-xs font-medium transition ${
            block === undefined
              ? 'bg-primary text-on-primary'
              : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
          }`}
        >
          Any
        </button>
        {EFFORTS.map((e) => {
          const current = block === e;
          return (
            <button
              key={e}
              type="button"
              onClick={() => onSelectBlock(e)}
              aria-label={`Free block: ${bucketLabel(e, thresholds)}`}
              aria-pressed={current}
              title={bucketLabel(e, thresholds)}
              className={`touch-manipulation rounded-xl px-2 py-1 text-xs font-medium capitalize transition ${
                current
                  ? 'bg-primary text-on-primary'
                  : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
              }`}
            >
              {e}
            </button>
          );
        })}
      </div>
      <span className="text-xs text-faint">
        {block === undefined
          ? 'Any — the whole hand, nothing sunk for size.'
          : `${bucketLabel(block, thresholds)} — bigger tasks sink.`}
      </span>
    </div>
  );
}

export default function TodayView({
  hand,
  state,
  onDealAgain,
  canDeal,
  onToggleTick,
  pinTask,
  pinReason,
  onSnoozePin,
  onOpenDetail,
  lists,
  waiting,
  pending,
  tasksById,
  locationName,
  hiddenByFilter,
  block,
  onSelectBlock,
  thresholds,
  headOut,
  comingUp,
}: TodayViewProps) {
  const listName = (id: string) => lists.find((l) => l.id === id)?.name;
  const line = waitingLine(waiting);
  // The client's own day — the same value sent to the server for this read. A task is overdue
  // when its due date is before today; a plain 'YYYY-MM-DD' string compare, no scoring imported.
  const on = localDay();
  const picker = (
    <BlockPicker block={block} onSelectBlock={onSelectBlock} thresholds={thresholds} />
  );
  // Deal again — a top-up, not a re-deal (ADR 0074). Shown when it would do something.
  const dealButton = (
    <button
      type="button"
      onClick={onDealAgain}
      className="touch-manipulation rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-on-primary"
    >
      Deal again
    </button>
  );

  // One hand card — the row rendering, shared so hand/won/nothing states stay visually identical.
  const card = (task: Task, index: number) => {
    const deadline = pending.get(task.id);
    return (
      <li
        key={task.id}
        className="relative flex items-center gap-3 overflow-hidden rounded-xl bg-subtle px-3 py-2 ring-1 ring-divider"
      >
        {/* Play the card FROM the hand (ADR 0074) — the shared tick/undo circle (ADR 0055).
            Completing empties this slot with no auto-fill; the 15s undo restores it. */}
        <TickCircle task={task} pendingUntil={deadline} onToggleTick={onToggleTick} />
        <span className="w-5 shrink-0 text-right text-sm tabular-nums text-faint">{index + 1}</span>
        <span className="min-w-0 flex-1 break-words">
          {task.title}
          {listName(task.listId) && (
            <span className="ml-2 text-xs text-faint">{listName(task.listId)}</span>
          )}
          {/* Needs a hand (ADR 0071) stays IN the hand with its marker — the "waiting on others"
              lane is dropped (ADR 0074): a needsHand task is playable. */}
          {task.needsHand && (
            <span className="ml-2 text-xs text-faint">
              <span aria-hidden="true">🤝</span>
            </span>
          )}
          <UrgencySubtext task={task} tasksById={tasksById} />
        </span>
        {/* Overdue marker (ADR 0058): pinned to the top of the hand, so say why. */}
        {task.due !== null && task.due < on && (
          <span
            aria-label={`Overdue, was due ${task.due}`}
            className="shrink-0 rounded-sm px-1.5 text-xs tabular-nums text-overdue ring-1 ring-overdue-edge"
          >
            overdue
          </span>
        )}
        <span className="shrink-0 text-sm tabular-nums text-muted">{task.rating.toFixed(2)}</span>
        {deadline !== undefined && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0">
            <PendingBar deadline={deadline} />
          </span>
        )}
      </li>
    );
  };

  // The two strips below the hand (ADR 0074), shown in EVERY state — the focus when nothing is
  // playable. "When you head out" = playable errands elsewhere (only when a context is pinned);
  // "Coming up" = the global gated set, soonest-first. This is what retires the old count-strip.
  const strips = (
    <>
      <Strip
        title="When you head out"
        count={headOut.reduce((n, g) => n + g.tasks.length, 0)}
      >
        <ul className="flex flex-col gap-2">
          {headOut.map((group) => (
            <li key={group.name}>
              <p className="text-xs font-medium text-muted">{group.name}</p>
              <ul className="ml-2">
                {group.tasks.map((task) => (
                  <li key={task.id} className="truncate text-sm text-body">
                    {task.title}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Strip>

      <Strip title="Coming up" count={comingUp.length}>
        <ul className="flex flex-col gap-1">
          {comingUp.map(({ task, reason }) => (
            <li key={task.id} className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-body">{task.title}</span>
              <span className="shrink-0 text-xs text-faint">{reason}</span>
            </li>
          ))}
        </ul>
      </Strip>
    </>
  );

  // The impact safety-net pin (ADR 0075) — ONE highlighted card ABOVE the hand, amber-ringed with ⚠️
  // so it reads as a nudge, not a normal card. Actionable with the SAME machinery: the shared
  // TickCircle completes it (completing removes it from the playable set, so it clears next render),
  // and tapping the title opens its detail. It carries no snooze yet (step 6).
  const pinCard = pinTask && (
    <div className="mb-3 flex items-center gap-3 rounded-xl bg-subtle px-3 py-2 ring-1 ring-not-before-edge">
      <TickCircle task={pinTask} pendingUntil={pending.get(pinTask.id)} onToggleTick={onToggleTick} />
      <button
        type="button"
        onClick={() => onOpenDetail(pinTask.id)}
        aria-label={`Open details for ${pinTask.title}`}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block break-words font-medium text-strong">
          <span aria-hidden="true">⚠️ </span>
          {pinTask.title}
        </span>
        <span className="block text-xs text-not-before">{pinReason}</span>
      </button>
      {/* Dismiss for the level's span (ADR 0075) — it returns when the span elapses if still neglected. */}
      <button
        type="button"
        onClick={onSnoozePin}
        aria-label={`Snooze ${pinTask.title}`}
        className="touch-manipulation shrink-0 rounded-xl bg-control-bg px-2 py-1 text-xs font-medium text-body ring-1 ring-field hover:bg-hover"
      >
        Snooze
      </button>
    </div>
  );

  return (
    <section className="rounded-2xl bg-card p-4 shadow-sm ring-1 ring-edge">
      {picker}
      {pinCard}

      {state === 'nothing-playable' ? (
        // Never blank (ADR 0074): nothing is playable now — the strips (step 4) are the focus.
        // The existing nuance stays: filtered-empty vs waiting vs nothing-active.
        <p className="text-muted">
          {locationName && hiddenByFilter > 0
            ? `Nothing playable at ${locationName} — ${hiddenByFilter} ${
                hiddenByFilter === 1 ? 'task is' : 'tasks are'
              } hidden by this filter. Switch to Everywhere to see ${
                hiddenByFilter === 1 ? 'it' : 'them'
              }.`
            : waiting.total > 0
              ? `Nothing playable right now — ${line}.`
              : 'Nothing active — add a task, then duel a few in the Arena to rank them.'}
        </p>
      ) : state === 'won' ? (
        // The win (ADR 0074, CONCEPT §5.6): you cleared the hand — cards remain to deal.
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="font-medium text-strong">
            <span aria-hidden="true">🎉 </span>You beat the deck.
          </p>
          <p className="text-sm text-muted">Cleared the hand. Deal again for the next round.</p>
          {dealButton}
        </div>
      ) : (
        <>
          <h2 className="mb-3 flex items-baseline justify-between gap-2">
            <span className="font-medium">Your hand</span>
            <span className="text-xs text-faint">
              {hand.length} to play, most important first
            </span>
          </h2>

          <ol className="flex flex-col gap-2">{hand.map(card)}</ol>

          {/* Deal again tops up freed slots — MANUAL, never auto (ADR 0074). Shown only when it
              would pull something in. */}
          {canDeal && <div className="mt-3">{dealButton}</div>}
        </>
      )}

      {/* The two strips (ADR 0074), below every state. "Coming up" is what the old gated-counts
          strip (0059) became — a task list, not a count line. */}
      {strips}
    </section>
  );
}
