import { msElapsed, TICK_GRACE_MS } from './tick';

/**
 * The pending countdown as a bar (ADR 0055 addendum).
 *
 * Rendered wherever a pending task appears — its Lists row AND its Today row — so a tick made
 * in Lists is honestly visible in Today instead of the row sitting there looking untouched for
 * fifteen seconds. It shows the PENDING state that genuinely exists ("committing, leaving
 * soon"); it does not claim the task is done and it removes nothing from Today. That is the
 * line 0055 draws: hiding a pending task from Today would be a second, client-side definition
 * of *done*; displaying real pending is not.
 *
 * The motion is driven by the ONE real deadline, shared with the ring and with the commit
 * timer, via a negative `animation-delay`. Mount this at 13s into the window and it renders
 * two seconds of bar left — never a fresh 15s — because `msElapsed` reads the deadline, not
 * this component's birth. Same reason the ring cannot drift: there is one source of "when".
 *
 * aria-hidden: it is a countdown, not content. The circle's own label already announces that
 * the tick can be undone; a draining bar read aloud on every pending row would be noise.
 */
export default function PendingBar({ deadline }: { deadline: number }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none h-0.5 w-full overflow-hidden rounded-full bg-pending-track"
    >
      <div
        className="deck-bar h-full w-full rounded-full bg-pending"
        style={{
          // Duration from the constant, position from the deadline — JS owns both, so neither
          // the bar's length nor its speed can drift from the timer that actually commits.
          animationDuration: `${TICK_GRACE_MS}ms`,
          animationDelay: `-${msElapsed(deadline, Date.now())}ms`,
        }}
      />
    </div>
  );
}
