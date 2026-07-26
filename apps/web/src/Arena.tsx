import type { CommitSummary, DuelPair, NextPairResult, Task } from '@rankati/shared';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { commitSession, startSession, submitResult, undoLastResult } from './api';

/**
 * The Arena (CONCEPT §4). Two tasks, one pick, the next pair immediately.
 *
 * RATINGS ARE NEVER SHOWN HERE. The mechanic depends on a blind gut call — showing a
 * score invites second-guessing the number instead of answering the question. Movement is
 * revealed once, in the summary, after the sitting ends.
 *
 * A sitting lives in the API's memory and is discarded unless you press End (ADR 0048).
 * That is why nothing here tries to resume: there is nothing to resume to.
 */

/** What the screen is doing. A union, so impossible combinations cannot be represented. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  /** `pool` is the list name for a list-scoped session, or null for all-tasks (v0.12): it drives
   *  the "Dueling: {list}" label, and living in the phase — not a separate state — is what makes
   *  "no memory" fall out (it is gone the moment the phase leaves dueling). */
  | { kind: 'dueling'; sessionId: string; pair: DuelPair; taps: number; pool: string | null }
  /**
   * The pool fell below two DURING a sitting — a task was deleted or completed while
   * dueling. Distinct from `need-more-tasks` because a session is still open and may hold
   * taps worth keeping: it carries `sessionId` so End stays reachable.
   *
   * The session is NOT auto-committed here. "Pool exhausted" is the exact auto-commit
   * reading ADR 0048 rejected — the Arena does not decide you are done (0005). Ending is
   * one tap away instead.
   */
  | {
      kind: 'pool-exhausted';
      sessionId: string;
      taps: number;
      activeCount: number;
      required: number;
      pool: string | null;
    }
  | { kind: 'need-more-tasks'; activeCount: number; required: number }
  | { kind: 'ending'; sessionId: string }
  | { kind: 'summary'; summary: CommitSummary };

interface ArenaProps {
  /** Called after a sitting commits, so the ranked list can reload in its new order. */
  onCommitted: () => void;
}

/**
 * The Arena's imperative surface (v0.12). A list's VS button starts a session from OUTSIDE the
 * Arena, so App holds this handle and calls `start(listId, listName)` then `scrollIntoView()`.
 * `start` is the SAME function the Arena's own "Start dueling" button calls with `null` — ONE code
 * path for all-tasks and list, so the two cannot diverge.
 */
export interface ArenaHandle {
  start: (listId: string | null, listName?: string) => void;
  scrollIntoView: () => void;
}

const Arena = forwardRef<ArenaHandle, ArenaProps>(function Arena({ onCommitted }, ref) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  /** The Arena's own section, so App can scroll to it when a VS button starts a list session. */
  const sectionRef = useRef<HTMLElement>(null);

  /**
   * One request at a time.
   *
   * A ref, not state: a second tap fires from the same render as the first, so a state
   * flag would not have updated yet and both would go out. Both would carry the same
   * dealId — the server rejects the second with 409 — but the guard means an impatient
   * double-tap is simply ignored rather than surfacing an error the user cannot act on.
   */
  const inFlight = useRef(false);

  /**
   * Fold a next-pair response into the phase — both outcomes are 200 (ADR 0047).
   *
   * A pool that ran dry mid-sitting keeps `sessionId`. Dropping it (as this did) stranded
   * the pending taps on the server with no way left to commit them.
   */
  function applyNext(
    sessionId: string,
    next: NextPairResult,
    taps: number,
    pool: string | null,
  ): void {
    setPhase(
      next.status === 'pair'
        ? { kind: 'dueling', sessionId, pair: next.pair, taps, pool }
        : {
            kind: 'pool-exhausted',
            sessionId,
            taps,
            activeCount: next.activeCount,
            required: next.required,
            pool,
          },
    );
  }

  /**
   * THE one start path — all-tasks (`null`) and list (`listId`) both come through here, so they
   * cannot diverge (v0.12). The Arena's own button calls `start(null)`; App's VS button calls the
   * imperative handle below, which calls this SAME function.
   *
   * Start from a user action, never an effect: StrictMode double-invokes effects in dev, and
   * starting a session is a POST that DISCARDS any session in flight — an effect-driven start would
   * silently throw away the first session every time. A press (own button or VS) happens once.
   * `pool` is the list name for the "Dueling: {list}" label, null for all-tasks — nothing persists
   * it beyond the live phase, which is what gives "no memory" (0048).
   */
  const start = useCallback(async (listId: string | null, listName?: string): Promise<void> => {
    setError(null);
    setPhase({ kind: 'starting' });
    try {
      const result = await startSession(listId ? { listId } : {});
      setPhase(
        result.status === 'started'
          ? {
              kind: 'dueling',
              sessionId: result.sessionId,
              pair: result.pair,
              taps: 0,
              pool: listName ?? null,
            }
          : {
              kind: 'need-more-tasks',
              activeCount: result.activeCount,
              required: result.required,
            },
      );
    } catch (e) {
      setError((e as Error).message);
      setPhase({ kind: 'idle' });
    }
  }, []);

  // App drives list-scoped starts through this handle. `start` is the same function the own button
  // uses, so there is no second start path to keep in sync (v0.12).
  useImperativeHandle(
    ref,
    () => ({
      start: (listId, listName) => void start(listId, listName),
      scrollIntoView: () =>
        sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }),
    [start],
  );

  /** A tap. No confirm, no refetch: the response already carries the next pair. */
  const onPick = useCallback(
    async (winner: Task, loser: Task): Promise<void> => {
      if (phase.kind !== 'dueling') return;
      if (inFlight.current) return;
      inFlight.current = true;
      const { sessionId, pair, taps, pool } = phase;
      setError(null);
      try {
        // dealId is read from the pair being RENDERED, so the tap names the pair the user
        // actually looked at — not whatever the session has moved on to.
        const next = await submitResult(sessionId, {
          winnerId: winner.id,
          loserId: loser.id,
          dealId: pair.dealId,
        });
        applyNext(sessionId, next, taps + 1, pool);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        inFlight.current = false;
      }
    },
    [phase],
  );

  /**
   * Undo: the mis-tap is erased and a FRESH pair is dealt — never the same one again.
   *
   * Also reachable once the pool has run dry: the sitting is still open, and a tap you
   * regret should not become permanent just because there is nothing left to deal.
   */
  const onUndo = useCallback(async (): Promise<void> => {
    if (phase.kind !== 'dueling' && phase.kind !== 'pool-exhausted') return;
    if (phase.taps === 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    const { sessionId, taps, pool } = phase;
    setError(null);
    try {
      const next = await undoLastResult(sessionId);
      applyNext(sessionId, next, taps - 1, pool);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
  }, [phase]);

  /** End the sitting. This is where ratings settle and, finally, where numbers appear. */
  async function onEnd(): Promise<void> {
    if (phase.kind !== 'dueling' && phase.kind !== 'pool-exhausted') return;
    const { sessionId } = phase;
    setError(null);
    setPhase({ kind: 'ending', sessionId });
    try {
      const summary = await commitSession(sessionId);
      setPhase({ kind: 'summary', summary });
      onCommitted();
    } catch (e) {
      setError((e as Error).message);
      setPhase({ kind: 'idle' });
    }
  }

  /**
   * Left/right picks a side; U undoes. Rapid dueling on a desktop should not need a mouse.
   *
   * Bound to the window rather than a focused element: there is nothing sensible to focus
   * — the whole screen is the control. Guarded so it cannot fire while a modifier is held
   * or while typing in the rename field on the page below.
   */
  useEffect(() => {
    if (phase.kind !== 'dueling') return;

    function onKey(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return;
      if (phase.kind !== 'dueling') return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void onPick(phase.pair.a, phase.pair.b);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        void onPick(phase.pair.b, phase.pair.a);
      } else if (event.key === 'u' || event.key === 'U') {
        event.preventDefault();
        void onUndo();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, onPick, onUndo]);

  /**
   * Undo + End. Shared by dueling and pool-exhausted so the two states cannot drift apart
   * — the bug being fixed here was precisely End going missing in one of them.
   */
  const controls = (taps: number, showHint: boolean) => (
    <div className="mt-4 flex items-center gap-3">
      <button
        type="button"
        onClick={onUndo}
        disabled={taps === 0}
        className="touch-manipulation rounded-xl px-3 py-2 text-sm font-medium text-strong ring-1 ring-field disabled:opacity-40"
      >
        Undo
      </button>
      <button
        type="button"
        onClick={onEnd}
        className="touch-manipulation rounded-xl bg-primary px-4 py-2 text-sm font-medium text-on-primary"
      >
        End session
      </button>
      {showHint && (
        <span className="hidden text-xs text-faint sm:inline">← / → to pick · U to undo</span>
      )}
    </div>
  );

  return (
    <section ref={sectionRef} className="mb-6 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-edge">
      <h2 className="mb-3 flex items-baseline justify-between gap-2">
        <span className="font-medium">
          Arena
          {/* Which pool this sitting is ranking (v0.12) — only for a list-scoped session; all-tasks
              shows nothing. Without it the ratings feel unmoored to which pool moved. */}
          {(phase.kind === 'dueling' || phase.kind === 'pool-exhausted') && phase.pool && (
            <span className="ml-2 font-normal text-muted">· Dueling: {phase.pool}</span>
          )}
        </span>
        {(phase.kind === 'dueling' || phase.kind === 'pool-exhausted') && (
          // "ready to save", not "pending": it names what is at stake. Nothing here is
          // written until End, and a bare status word does not say so (ADR 0048).
          <span className="text-xs text-faint">
            {phase.taps} {phase.taps === 1 ? 'duel' : 'duels'} ready to save
          </span>
        )}
      </h2>

      {error && (
        <p
          role="alert"
          className="mb-4 rounded-xl bg-error-bg px-4 py-3 text-sm text-error ring-1 ring-error-edge"
        >
          {error}
        </p>
      )}

      {phase.kind === 'idle' && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted">
            Which matters more? Pick one, then the next pair. Nothing is saved until you end
            the session.
          </p>
          <button
            type="button"
            onClick={() => void start(null)}
            className="touch-manipulation rounded-xl bg-primary px-4 py-2 text-base font-medium text-on-primary deck-glow"
          >
            Start dueling
          </button>
        </div>
      )}

      {phase.kind === 'starting' && <p className="text-muted">Starting…</p>}

      {phase.kind === 'need-more-tasks' && (
        <p className="text-muted">
          Add another task to start dueling — a duel needs {phase.required}, and there
          {phase.activeCount === 1 ? ' is 1 active task' : ` are ${phase.activeCount} active tasks`}.
        </p>
      )}

      {phase.kind === 'ending' && <p className="text-muted">Settling ratings…</p>}

      {phase.kind === 'dueling' && (
        <>
          {/* aria-live=polite, not the app's usual role=alert: a pair changes on every tap,
              and an assertive region would interrupt the screen reader constantly. */}
          <div aria-live="polite" className="sr-only">
            {phase.pair.a.title} versus {phase.pair.b.title}
          </div>

          {/* Stacked in portrait, side by side once there is room (ADR 0030). */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[phase.pair.a, phase.pair.b].map((task, index) => {
              const other = index === 0 ? phase.pair.b : phase.pair.a;
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onPick(task, other)}
                  aria-label={`Pick ${task.title}`}
                  className="touch-manipulation min-h-32 rounded-2xl bg-subtle p-4 text-left text-lg ring-1 ring-edge hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:bg-surface-active sm:min-h-40"
                >
                  <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-faint">
                    {index === 0 ? '← Left' : 'Right →'}
                  </span>
                  {task.title}
                </button>
              );
            })}
          </div>

          {controls(phase.taps, true)}
        </>
      )}

      {/* Pool ran dry mid-sitting. The session is STILL OPEN and End is right here — the
          pending taps are one press from being saved, and nothing commits on its own. */}
      {phase.kind === 'pool-exhausted' && (
        <>
          <p className="text-muted" aria-live="polite">
            {phase.taps === 0
              ? 'No pairs left to duel — a duel needs ' + phase.required + ' active tasks.'
              : `No pairs left to duel. End the session to save your ${phase.taps} ${
                  phase.taps === 1 ? 'duel' : 'duels'
                }.`}
          </p>
          {controls(phase.taps, false)}
        </>
      )}

      {phase.kind === 'summary' && (
        <div>
          <p className="mb-3 text-sm text-muted">
            {phase.summary.committed === 0
              ? 'Nothing to record — no duels in that session.'
              : `${phase.summary.committed} ${phase.summary.committed === 1 ? 'duel' : 'duels'} recorded.`}
            {phase.summary.skipped > 0 &&
              ` ${phase.summary.skipped} skipped (a task changed mid-session).`}
          </p>

          {phase.summary.moved.length > 0 && (
            <ul className="mb-4 flex flex-col gap-2">
              {phase.summary.moved.map((change) => (
                <li
                  key={change.task.id}
                  className="flex items-baseline justify-between gap-3 rounded-xl bg-subtle px-3 py-2 ring-1 ring-edge"
                >
                  <span className="min-w-0 truncate">{change.task.title}</span>
                  <span
                    className={`shrink-0 text-sm font-medium tabular-nums ${
                      change.delta > 0
                        ? 'text-positive'
                        : 'text-muted'
                    }`}
                  >
                    {change.delta > 0 ? '+' : ''}
                    {change.delta.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={() => setPhase({ kind: 'idle' })}
            className="touch-manipulation rounded-xl px-3 py-2 text-sm font-medium text-strong ring-1 ring-field"
          >
            Done
          </button>
        </div>
      )}
    </section>
  );
});

export default Arena;
