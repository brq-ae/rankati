import { useState } from 'react';
import LogsView from './LogsView';
import RoutinesView from './RoutinesView';

/**
 * The Routines tab shell (ADR 0087) — two sub-tabs over one silo, both wholly outside the engine:
 *   • Reminders — the recurring routines (ADR 0066), rendered by the UNCHANGED RoutinesView.
 *   • Logs — pull-based cadence trackers.
 * This only switches between the two views; each fetches its own data against the client's local day `on`.
 */
const SUBS = ['reminders', 'logs'] as const;
type Sub = (typeof SUBS)[number];

export default function RoutinesTab({ on }: { on: string }) {
  const [sub, setSub] = useState<Sub>('reminders');
  return (
    <>
      <nav className="mb-4 flex gap-1" aria-label="Routines sections">
        {SUBS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setSub(name)}
            aria-current={sub === name ? 'page' : undefined}
            className={`touch-manipulation rounded-lg px-3 py-1 text-sm font-medium capitalize ${
              sub === name ? 'bg-chip text-fg ring-1 ring-edge' : 'text-muted hover:bg-hover'
            }`}
          >
            {name}
          </button>
        ))}
      </nav>

      {sub === 'reminders' ? <RoutinesView on={on} /> : <LogsView on={on} />}
    </>
  );
}
