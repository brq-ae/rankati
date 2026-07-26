import type { CreateRoutineDto, Routine, UpdateRoutineDto } from '@rankati/shared';
import { useCallback, useEffect, useState } from 'react';
import {
  createRoutine,
  deleteRoutine,
  getRoutines,
  routineDid,
  routineDismiss,
  routineSnooze,
  updateRoutine,
} from './api';
import RoutineForm from './RoutineForm';
import { sortRoutines } from './routine-sort';

/**
 * The Routines tab (ADR 0066) — a silo. It never shows a task and nothing here reaches the engine.
 * Self-managing: it fetches its own list against the client's local day `on`, and recomputes the
 * climbing order and the snooze-hiding fresh on every render (0059-style, on the CLIENT because only
 * the client holds the exact `now`).
 *
 * Climb order lives in `routine-sort.ts` (pure, unit-tested): DUE-BASED routines climb by days-until
 * (overdue first), FREQUENCY routines form a band below them ordered by pace pressure (ADR 0066 + its
 * v0.18 extension).
 */
const SNOOZE_PRESETS: [string, number][] = [
  ['5 minutes', 5],
  ['1 hour', 60],
  ['6 hours', 360],
  ['1 day', 1440],
];
const daysUntil = (day: string, on: string) =>
  Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${on}T00:00:00Z`)) / 86_400_000);
const relative = (d: number) => (d < 0 ? `overdue ${-d}d` : d === 0 ? 'today' : `in ${d}d`);

export default function RoutinesView({ on }: { on: string }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [form, setForm] = useState<{ routine: Routine | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getRoutines(on)
      .then(setRoutines)
      .catch((e: Error) => setError(e.message));
  }, [on]);
  useEffect(() => load(), [load]);
  // Re-tick so a snooze resurfaces when it elapses (only the client knows the exact time).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, []);

  const act = async (p: Promise<unknown>) => {
    setError(null);
    try {
      await p;
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const onSubmit = (dto: CreateRoutineDto | UpdateRoutineDto, id: string | null) => {
    setForm(null);
    void act(id === null ? createRoutine(dto as CreateRoutineDto) : updateRoutine(id, dto as UpdateRoutineDto));
  };
  const onDelete = (r: Routine) => {
    if (window.confirm(`Delete routine “${r.name}”?`)) void act(deleteRoutine(r.id));
  };
  const onSnooze = (r: Routine, minutes: number) =>
    void act(routineSnooze(r.id, new Date(now + minutes * 60_000).toISOString()));

  const visible = routines.filter((r) => !r.snoozedUntil || now >= Date.parse(r.snoozedUntil));
  const sorted = sortRoutines(visible, on);

  const status = (r: Routine): string => {
    if (r.type === 'frequency') return `${r.periodCount}/${r.targetCount} this ${r.periodUnit}`;
    return `${r.type === 'interval_fixed' ? 'Next' : 'Due'} ${r.nextDue} — ${relative(daysUntil(r.nextDue!, on))}`;
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted">Rhythms you keep — separate from the ranked tasks.</p>
        <button
          type="button"
          onClick={() => setForm({ routine: null })}
          className="touch-manipulation rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-on-primary"
        >
          + New routine
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-error-bg px-4 py-3 text-sm text-error ring-1 ring-error-edge">
          {error}
        </p>
      )}

      {sorted.length === 0 ? (
        <p className="text-sm text-faint">No routines yet — add one to start keeping a rhythm.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((r) => {
            const overdue = r.type !== 'frequency' && daysUntil(r.nextDue!, on) < 0;
            return (
              <li
                key={r.id}
                className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-card p-3 ring-1 ${
                  overdue ? 'ring-danger' : 'ring-edge'
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.name}</p>
                  <p className={`text-xs ${overdue ? 'text-danger' : 'text-faint'}`}>{status(r)}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  {(r.type === 'frequency' || r.type === 'interval_floating') && (
                    <button
                      type="button"
                      onClick={() => void act(routineDid(r.id, on))}
                      aria-label={`Did ${r.name}`}
                      className="touch-manipulation rounded-sm bg-primary px-2 py-1 text-xs font-semibold text-on-primary"
                    >
                      Did it
                    </button>
                  )}
                  {r.type === 'interval_fixed' && (
                    <button
                      type="button"
                      onClick={() => void act(routineDismiss(r.id, on))}
                      aria-label={`Dismiss ${r.name}`}
                      className="touch-manipulation rounded-sm px-2 py-1 text-xs font-medium text-body ring-1 ring-field hover:bg-hover"
                    >
                      Dismiss
                    </button>
                  )}
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) onSnooze(r, Number(e.target.value));
                      e.target.value = '';
                    }}
                    aria-label={`Snooze ${r.name}`}
                    className="rounded-sm border border-field bg-control-bg px-1 py-1 text-xs text-muted"
                  >
                    <option value="">Snooze…</option>
                    {SNOOZE_PRESETS.map(([label, m]) => (
                      <option key={m} value={m}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setForm({ routine: r })}
                    aria-label={`Edit ${r.name}`}
                    className="touch-manipulation rounded-sm px-1.5 py-1 text-xs text-faint hover:text-body"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(r)}
                    aria-label={`Delete ${r.name}`}
                    className="touch-manipulation rounded-sm px-1.5 py-1 text-xs text-faint hover:text-danger"
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {form && <RoutineForm routine={form.routine} on={on} onSubmit={onSubmit} onCancel={() => setForm(null)} />}
    </>
  );
}
