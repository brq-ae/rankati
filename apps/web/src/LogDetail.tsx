import type { Log, LogStats } from '@rankati/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteLog, getLog, logDid, logUndo, renameLog } from './api';

/**
 * A Log's detail (ADR 0087) — the on-OPEN reveal. A native <dialog>, like RoutineForm/SettingsModal.
 * This is where the soft cadence hint lives ("usually ~35 days · it's been 40") — never on the list,
 * never a nudge. Shows the dated occurrences newest-first with an undo (remove) each, "✓ did it today",
 * rename, and delete. Every read/mutation carries the client's local day `on` so the stats stay fresh.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' → "8 Mar 2026", formatted from the parts so no timezone can shift the day. */
const fmtDate = (ymd: string): string => {
  const [y, m, d] = ymd.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** The soft cadence hint — pull-only, graceful under 2 occurrences (ADR 0087). */
function hint(stats: LogStats): string {
  if (stats.count === 0) return 'Not logged yet.';
  if (stats.count === 1) return `Logged once on ${fmtDate(stats.lastDoneOn as string)}.`;
  const avg = Math.round(stats.averageGapDays as number);
  return `Usually ~${days(avg)} · it's been ${days(stats.currentGapDays as number)}.`;
}

export default function LogDetail({
  id,
  on,
  onClose,
  onChanged,
}: {
  id: string;
  on: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [name, setName] = useState('');
  const [pastDay, setPastDay] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const load = useCallback(() => {
    getLog(id, on)
      .then((l) => {
        setLog(l);
        setName(l.name);
      })
      .catch((e: Error) => setError(e.message));
  }, [id, on]);
  useEffect(() => load(), [load]);

  // Every mutation refreshes this modal AND tells the parent to reload its list summary.
  const act = async (p: Promise<unknown>) => {
    setError(null);
    try {
      await p;
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onRename = () => {
    const n = name.trim();
    if (!n || !log || n === log.name) return;
    void act(renameLog(id, { name: n }, on));
  };
  const onDelete = () => {
    if (log && window.confirm(`Delete log “${log.name}”? Its history is removed too.`)) {
      deleteLog(id)
        .then(() => {
          onChanged();
          dialogRef.current?.close();
        })
        .catch((e: Error) => setError(e.message));
    }
  };

  // Backdate a forgotten occurrence. The cap is "not future" (today is allowed — idempotent with
  // "Did it today"), enforced CLIENT-side only: `on` is the client's local today, the server stays
  // tz-agnostic (ADR 0052). No min, so a new log can seed past history too. `did` is idempotent per
  // day (0087), so re-logging an existing day is a harmless no-op. String compare is safe for YMD.
  const canLogPast = pastDay !== '' && pastDay <= on;
  const onLogPast = async () => {
    if (!canLogPast) return;
    await act(logDid(id, pastDay)); // reuse the act→load() reload: stats recompute against the real `on`
    setPastDay('');
  };

  const entries = log?.entries ?? [];

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
      aria-label={log ? `Log: ${log.name}` : 'Log'}
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl bg-card p-0 text-fg shadow-lg backdrop:bg-backdrop"
    >
      <div className="flex flex-col gap-4 p-5">
        {error && (
          <p role="alert" className="rounded-xl bg-error-bg px-4 py-3 text-sm text-error ring-1 ring-error-edge">
            {error}
          </p>
        )}

        {log && (
          <>
            {/* Rename inline — commit on blur or Enter. */}
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={onRename}
                onKeyDown={(e) => e.key === 'Enter' && onRename()}
                aria-label="Log name"
                className="rounded-xl border border-field bg-control-bg px-2 py-1 text-sm outline-none focus:border-primary"
              />
            </label>

            {/* The soft cadence hint — the on-open reveal, never a nudge. */}
            <p className="rounded-xl bg-subtle px-4 py-3 text-sm text-body">{hint(log.stats)}</p>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => void act(logDid(id, on))}
                className="touch-manipulation rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-on-primary"
              >
                ✓ Did it today
              </button>
              <button
                type="button"
                onClick={onDelete}
                aria-label={`Delete ${log.name}`}
                className="touch-manipulation rounded-sm px-2 py-1.5 text-xs text-faint hover:text-danger"
              >
                Delete log
              </button>
            </div>

            {/* Forgot a day? — backdate an occurrence via the same idempotent did(id, on) endpoint
                (0087). Secondary to "Did it today" so there is one primary. Capped at today (max), no
                min so a new log can seed past history. */}
            <div className="flex items-center gap-2">
              <label htmlFor="log-past-day" className="shrink-0 text-xs font-medium text-muted">
                Forgot a day?
              </label>
              <input
                id="log-past-day"
                type="date"
                value={pastDay}
                max={on}
                onChange={(e) => setPastDay(e.target.value)}
                aria-label="Log a past day"
                className="min-w-0 flex-1 touch-manipulation rounded-xl border border-field bg-control-bg px-2 py-1 text-sm outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => void onLogPast()}
                disabled={!canLogPast}
                aria-label="Log the chosen past day"
                className="touch-manipulation shrink-0 rounded-xl px-3 py-1.5 text-sm font-medium text-strong ring-1 ring-field hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                Log
              </button>
            </div>

            {/* History — dated occurrences newest-first, each removable (undo a mis-tap). */}
            <div>
              <p className="mb-2 text-xs font-medium text-muted">
                History{log.stats.count > 0 ? ` · ${log.stats.count}` : ''}
              </p>
              {entries.length === 0 ? (
                <p className="text-sm text-faint">No occurrences yet — tap “Did it today”.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {entries.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-center justify-between rounded-xl bg-subtle px-3 py-2 text-sm"
                    >
                      <span>{fmtDate(e.doneOn)}</span>
                      <button
                        type="button"
                        onClick={() => void act(logUndo(id, e.id, on))}
                        aria-label={`Remove ${fmtDate(e.doneOn)}`}
                        className="touch-manipulation rounded-sm px-1.5 py-0.5 text-xs text-faint hover:text-danger"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
