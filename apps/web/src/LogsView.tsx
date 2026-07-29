import type { Log } from '@rankati/shared';
import { useCallback, useEffect, useState } from 'react';
import { createLog, getLogs, logDid } from './api';
import LogDetail from './LogDetail';

/**
 * The Logs sub-tab (ADR 0087) — pull-based cadence trackers, a sibling of Reminders and, like it, wholly
 * outside the engine. Deliberately LIGHT: the list shows only a name and a compact last-done summary; the
 * soft cadence hint and the history are the on-OPEN reveal (LogDetail), never a nudge. Fetches against the
 * client's local day `on`.
 */
const summary = (l: Log): string => {
  const { count, currentGapDays } = l.stats;
  if (count === 0) return 'Not logged yet';
  if (currentGapDays === 0) return 'Done today';
  return `${currentGapDays} ${currentGapDays === 1 ? 'day' : 'days'} ago`;
};

export default function LogsView({ on }: { on: string }) {
  const [logs, setLogs] = useState<Log[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getLogs(on)
      .then(setLogs)
      .catch((e: Error) => setError(e.message));
  }, [on]);
  useEffect(() => load(), [load]);

  const act = async (p: Promise<unknown>) => {
    setError(null);
    try {
      await p;
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onCreate = () => {
    const n = newName.trim();
    if (!n) return;
    setNewName('');
    void act(createLog({ name: n }));
  };

  // Optimistic did-today (ADR 0087): mark the row done instantly. The server is idempotent per day, so a
  // double-tap is safe; on failure we surface the error and reload the truth.
  const onDid = (log: Log) => {
    setError(null);
    setLogs((prev) =>
      prev.map((l) => (l.id === log.id ? { ...l, stats: { ...l.stats, currentGapDays: 0, lastDoneOn: on } } : l)),
    );
    logDid(log.id, on)
      .then(load)
      .catch((e: Error) => {
        setError(e.message);
        load();
      });
  };

  return (
    <>
      <p className="mb-3 text-sm text-muted">Things you track the cadence of — open one for its rhythm.</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate();
        }}
        className="mb-4 flex gap-2"
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New log — e.g. Haircut"
          aria-label="New log name"
          className="min-w-0 flex-1 rounded-xl border border-field bg-control-bg px-3 py-1.5 text-sm outline-none focus:border-primary"
        />
        <button
          type="submit"
          className="shrink-0 touch-manipulation rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-on-primary"
        >
          + New log
        </button>
      </form>

      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-error-bg px-4 py-3 text-sm text-error ring-1 ring-error-edge">
          {error}
        </p>
      )}

      {logs.length === 0 ? (
        <p className="text-sm text-faint">No logs yet — add one to start tracking a cadence.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {logs.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-card p-3 ring-1 ring-edge"
            >
              <button
                type="button"
                onClick={() => setOpenId(l.id)}
                aria-label={`Open ${l.name}`}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate font-medium">{l.name}</p>
                <p className="text-xs text-faint">{summary(l)}</p>
              </button>
              <button
                type="button"
                onClick={() => onDid(l)}
                aria-label={`Did ${l.name} today`}
                className="shrink-0 touch-manipulation rounded-sm bg-primary px-2 py-1 text-xs font-semibold text-on-primary"
              >
                ✓ Did it today
              </button>
            </li>
          ))}
        </ul>
      )}

      {openId && <LogDetail id={openId} on={on} onClose={() => setOpenId(null)} onChanged={load} />}
    </>
  );
}
