import type { Location } from '@rankati/shared';
import { useEffect, useRef, useState } from 'react';
import ChangePasswordForm from './ChangePasswordForm';
import TelegramSettings from './TelegramSettings';
import { DEFAULT_THRESHOLDS, type Thresholds } from './effort-prefs';
import type { PinDays } from './pin';
import type { Mode } from './mode';
import type { Theme } from './palette';
import ThemePicker from './ThemePicker';

/**
 * Settings — two unrelated concerns behind the one gear: the THEME picker (the palette axis, ADR
 * 0062) and the LOCATION set (add/rename/delete/merge, ADRs 0060, 0061). A native <dialog> with
 * showModal(), same as TaskDetail — the focus trap, Escape and backdrop come with it.
 *
 * This modal is CONTROLS ONLY. The destructive warnings (how many tasks a delete or merge touches,
 * which would lose their only location) are computed in App from the FULL task list and confirmed
 * there — one source, so a filter can never shrink the blast radius (0061). No per-row task count
 * lives here for the same reason: a second place computing "how many are here" would drift.
 *
 * The light/dark MODE toggle is deliberately NOT here — it lives in the header (a frequent quick
 * action), while the theme is a set-and-forget choice that belongs with the other settings.
 */
export default function SettingsModal({
  theme,
  mode,
  onSelectTheme,
  thresholds,
  onSetThresholds,
  handSize,
  onSetHandSize,
  pinDays,
  onSetPinDays,
  locations,
  error,
  onClose,
  onCreate,
  onRename,
  onDelete,
  onMerge,
  onClearTasks,
  onFactoryReset,
  onLogout,
}: {
  theme: Theme;
  mode: Mode;
  onSelectTheme: (theme: Theme) => void;
  /** The display-only effort thresholds (ADR 0072) — edited here, persisted client-side, used only
   *  to LABEL the block picker. NEVER sent to the server: only the ordinal block crosses the wire. */
  thresholds: Thresholds;
  onSetThresholds: (t: Thresholds) => void;
  /** The dealt-hand size N (ADR 0074) — how many cards Today deals. Client-side, default 5, min 1. */
  handSize: number;
  onSetHandSize: (n: number) => void;
  /** The four impact-pin day-knobs (ADR 0075) — the two fuses + two snooze spans, client-side. */
  pinDays: PinDays;
  onSetPinDays: (days: PinDays) => void;
  locations: Location[];
  /** The App-level error from a manager action (a uniqueness 400, a failed merge). Shown HERE, in
   *  the dialog's top layer — a banner behind this modal would be invisible (0061). */
  error: string | null;
  onClose: () => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onMerge: (sourceId: string, targetId: string) => void;
  /** The reset triggers (ADR 0064). CONTROLS ONLY — the typed-DELETE confirmation is App's, shown
   *  over this modal, so this stays "controls only" like the location warnings (0061). */
  onClearTasks: () => void;
  onFactoryReset: (keepSampleData: boolean) => void;
  /** End the session and return to the login screen (ADR 0076). Change-password joins it here in step 6. */
  onLogout: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [addName, setAddName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [mergeSource, setMergeSource] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [keepSample, setKeepSample] = useState(true);
  // The threshold inputs are edited as strings so a half-typed value does not fight the user, then
  // committed on blur/Enter. An incoherent pair (non-integer, ≤0, or quick ≥ medium — a Medium that
  // cannot exist) is REFUSED by snapping back to the last good pair, never written.
  const [quickStr, setQuickStr] = useState(String(thresholds.quickMax));
  const [mediumStr, setMediumStr] = useState(String(thresholds.mediumMax));
  // The hand-size input — a string while typing, committed on blur/Enter. A non-integer or < 1 is
  // REFUSED by snapping back to the stored value (min 1 enforced).
  const [sizeStr, setSizeStr] = useState(String(handSize));

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const commitHandSize = () => {
    const n = Number(sizeStr);
    if (Number.isInteger(n) && n >= 1) onSetHandSize(n);
    else setSizeStr(String(handSize)); // snap back — never keep a size the hand cannot honour
  };

  // The four impact-pin knobs — edited as strings, committed on blur/Enter. Each is INDEPENDENT: an
  // invalid value snaps that one field back to its stored value, the others stand (ADR 0075).
  const [dayStr, setDayStr] = useState<Record<keyof PinDays, string>>({
    highFuseDays: String(pinDays.highFuseDays),
    mediumFuseDays: String(pinDays.mediumFuseDays),
    highSnoozeDays: String(pinDays.highSnoozeDays),
    mediumSnoozeDays: String(pinDays.mediumSnoozeDays),
  });
  const commitPinDay = (field: keyof PinDays) => {
    const n = Number(dayStr[field]);
    if (Number.isInteger(n) && n >= 1) onSetPinDays({ ...pinDays, [field]: n });
    else setDayStr((prev) => ({ ...prev, [field]: String(pinDays[field]) })); // snap back
  };

  const commitThresholds = () => {
    const quickMax = Number(quickStr);
    const mediumMax = Number(mediumStr);
    const ok =
      Number.isInteger(quickMax) &&
      Number.isInteger(mediumMax) &&
      quickMax > 0 &&
      mediumMax > quickMax;
    if (ok) {
      onSetThresholds({ quickMax, mediumMax });
    } else {
      // Snap back to what is stored — never keep a value the picker cannot honestly label.
      setQuickStr(String(thresholds.quickMax));
      setMediumStr(String(thresholds.mediumMax));
    }
  };

  const add = () => {
    const name = addName.trim();
    if (!name) return;
    onCreate(name);
    setAddName('');
  };

  const commitRename = (id: string) => {
    const name = editName.trim();
    if (name) onRename(id, name);
    setEditingId(null);
  };

  const canMerge = mergeSource !== '' && mergeTarget !== '' && mergeSource !== mergeTarget;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
      aria-label="Settings"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl bg-card p-0 text-fg shadow-lg backdrop:bg-backdrop"
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-faint">Settings</h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close settings"
            className="touch-manipulation shrink-0 rounded-sm px-2 py-1 text-sm text-faint hover:bg-hover hover:text-strong-hover"
          >
            ✕
          </button>
        </div>

        {/* Theme (the palette axis, 0062). Set-and-forget, so it leads. Mode stays in the header. */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">Theme</span>
          <ThemePicker theme={theme} mode={mode} onSelect={onSelectTheme} />
        </div>

        {/* Effort blocks (ADR 0072) — the two minute thresholds that LABEL the Today block picker.
            DISPLAY ONLY: they shape what "Quick" / "Medium" / "Long" mean to you, but only the
            ordinal bucket is ever sent to the server. Long is whatever is bigger than Medium. */}
        <div className="flex flex-col gap-2 border-t border-divider pt-4">
          <span className="text-xs font-medium uppercase tracking-wide text-faint">Effort blocks</span>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">Quick: up to</span>
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={quickStr}
                  onChange={(e) => setQuickStr(e.target.value)}
                  onBlur={commitThresholds}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitThresholds();
                  }}
                  aria-label="Quick block, up to how many minutes"
                  className="w-16 rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
                />
                <span className="text-muted">min</span>
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">Medium: up to</span>
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={mediumStr}
                  onChange={(e) => setMediumStr(e.target.value)}
                  onBlur={commitThresholds}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitThresholds();
                  }}
                  aria-label="Medium block, up to how many minutes"
                  className="w-16 rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
                />
                <span className="text-muted">min</span>
              </span>
            </label>
          </div>
          <span className="text-xs text-faint">
            Long is anything over {mediumStr || DEFAULT_THRESHOLDS.mediumMax} min. These labels are
            yours alone — the ranking uses the bucket, never the minutes.
          </span>
        </div>

        {/* The dealt-hand size (ADR 0074) — how many cards Today deals. Changing it re-caps the shown
            hand: fewer with a smaller N, empty slots (for Deal again) with a larger N — no auto-grow. */}
        <div className="flex flex-col gap-2 border-t border-divider pt-4">
          <span className="text-xs font-medium uppercase tracking-wide text-faint">Today hand</span>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-xs font-medium text-muted">Cards per hand</span>
            <input
              type="number"
              min={1}
              inputMode="numeric"
              value={sizeStr}
              onChange={(e) => setSizeStr(e.target.value)}
              onBlur={commitHandSize}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitHandSize();
              }}
              aria-label="Cards per hand"
              className="w-16 rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
            />
          </label>
          <span className="text-xs text-faint">
            How many cards Today deals. A smaller hand shows fewer; a larger one leaves empty slots for
            Deal again — it never pulls new cards in on its own.
          </span>
        </div>

        {/* Impact pin (ADR 0075) — the two FUSES (when a nag fires) and the two SNOOZE spans (how long
            a dismissal lasts). Same string-while-typing / commit-on-blur / snap-back as the hand size. */}
        <div className="flex flex-col gap-2 border-t border-divider pt-4">
          <span className="text-xs font-medium uppercase tracking-wide text-faint">Impact pin</span>
          {(
            [
              { field: 'highFuseDays', label: 'High impact nags after' },
              { field: 'mediumFuseDays', label: 'Medium impact nags after' },
              { field: 'highSnoozeDays', label: 'Snooze a high-impact nudge for' },
              { field: 'mediumSnoozeDays', label: 'Snooze a medium-impact nudge for' },
            ] as const
          ).map(({ field, label }) => (
            <label key={field} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 text-xs font-medium text-muted">{label}</span>
              <input
                type="number"
                min={1}
                inputMode="numeric"
                value={dayStr[field]}
                onChange={(e) => setDayStr((prev) => ({ ...prev, [field]: e.target.value }))}
                onBlur={() => commitPinDay(field)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitPinDay(field);
                }}
                aria-label={label}
                className="w-16 shrink-0 rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
              />
              <span className="shrink-0 text-xs text-muted">days</span>
            </label>
          ))}
          <span className="text-xs text-faint">
            A nudge fires when a Medium/High task sits unfinished past its "nags after" days; Snooze hides
            it for the set days, then it returns if still neglected.
          </span>
        </div>

        <div className="flex flex-col gap-4 border-t border-divider pt-4">
          <span className="text-xs font-medium uppercase tracking-wide text-faint">Locations</span>

          {/* Add */}
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-muted">Add a location</span>
              <input
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add();
                }}
                placeholder="e.g. Basement"
                className="rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
              />
            </label>
            <button
              type="button"
              onClick={add}
              className="touch-manipulation rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-on-primary "
            >
              Add
            </button>
          </div>

          {/* Errors from add / rename / delete / merge surface HERE, beside the controls that raised
              them — never in the App banner behind this modal (0061). */}
          {error && (
            <p
              role="alert"
              className="rounded-xl bg-error-bg px-3 py-2 text-sm text-error ring-1 ring-error-edge"
            >
              {error}
            </p>
          )}

          {/* The set */}
          {locations.length === 0 ? (
            <p className="text-sm text-faint">No locations yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {locations.map((l) => (
                <li key={l.id} className="flex items-center gap-2">
                  {editingId === l.id ? (
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={() => commitRename(l.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(l.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      aria-label={`Rename location ${l.name}`}
                      autoFocus
                      className="min-w-0 flex-1 rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(l.id);
                        setEditName(l.name);
                      }}
                      aria-label={`Rename location ${l.name}`}
                      className="min-w-0 flex-1 truncate rounded-xl px-1 py-1 text-left text-sm hover:bg-hover"
                    >
                      {l.name}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDelete(l.id)}
                    aria-label={`Delete location ${l.name}`}
                    className="touch-manipulation shrink-0 rounded-xl px-2 py-1 text-xs text-faint hover:text-danger"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Merge — direction is explicit (source into target), and the App warns with the count
              before it commits (0061). Disabled until two distinct places are chosen. */}
          {locations.length >= 2 && (
            <div className="flex flex-col gap-1 border-t border-divider pt-3">
              <span className="text-xs font-medium text-muted">Merge</span>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <select
                  value={mergeSource}
                  onChange={(e) => setMergeSource(e.target.value)}
                  aria-label="Merge from"
                  className="rounded-xl border border-field bg-control-bg px-1.5 py-1"
                >
                  <option value="">from…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <span className="text-muted">into</span>
                <select
                  value={mergeTarget}
                  onChange={(e) => setMergeTarget(e.target.value)}
                  aria-label="Merge into"
                  className="rounded-xl border border-field bg-control-bg px-1.5 py-1"
                >
                  <option value="">into…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!canMerge}
                  onClick={() => {
                    onMerge(mergeSource, mergeTarget);
                    setMergeSource('');
                    setMergeTarget('');
                  }}
                  className="touch-manipulation rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:cursor-not-allowed disabled:opacity-40 "
                >
                  Merge
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Telegram bot (ADR 0084) — self-contained: reads/writes the authed endpoints itself, so it needs
            no props threaded through App. */}
        <TelegramSettings />

        {/* Reset (ADR 0064). Two named intents, not a checkbox matrix — "Keep sample data" is one
            clearly-labelled option on the one mode it applies to. These are TRIGGERS ONLY: each hands
            off to App, which shows the typed-DELETE confirmation over this modal (the friction, and
            the blast-radius count from the full task list, live there). */}
        <div className="flex flex-col gap-3 border-t border-divider pt-4">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Account</span>
          <ChangePasswordForm />
          <button
            type="button"
            onClick={onLogout}
            className="touch-manipulation self-start rounded-xl px-3 py-1.5 text-sm font-medium text-strong ring-1 ring-field hover:bg-hover"
          >
            Log out
          </button>
        </div>

        <div className="flex flex-col gap-3 border-t border-divider pt-4">
          <span className="text-xs font-medium uppercase tracking-wide text-danger">Reset</span>

          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={onClearTasks}
              className="touch-manipulation self-start rounded-xl px-3 py-1.5 text-sm font-medium text-danger ring-1 ring-danger hover:bg-danger-bg"
            >
              Clear tasks
            </button>
            <p className="text-xs text-faint">
              Deletes every task and its duel history. Your lists and locations stay.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={keepSample}
                onChange={(e) => setKeepSample(e.target.checked)}
              />
              Keep sample data
            </label>
            <button
              type="button"
              onClick={() => onFactoryReset(keepSample)}
              className="touch-manipulation self-start rounded-xl px-3 py-1.5 text-sm font-medium text-danger ring-1 ring-danger hover:bg-danger-bg"
            >
              Factory reset
            </button>
            <p className="text-xs text-faint">
              Back to a fresh install: lists and locations reset to defaults
              {keepSample ? ', with the sample lists and tasks' : ', with no lists or tasks'}. Your
              theme is kept.
            </p>
          </div>
        </div>
      </div>
    </dialog>
  );
}
