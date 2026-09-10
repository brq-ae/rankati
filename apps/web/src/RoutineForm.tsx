import type {
  CreateRoutineDto,
  FixedRule,
  FixedRuleKind,
  IntervalUnit,
  PeriodUnit,
  Routine,
  RoutineType,
  UpdateRoutineDto,
} from '@rankati/shared';
import { useEffect, useRef, useState } from 'react';

/**
 * Create or edit a routine (ADR 0066). A native <dialog>, like SettingsModal/TaskDetail. On CREATE the
 * type is chosen; on EDIT the type is fixed and only CHANGED fields are sent (proper PATCH semantics —
 * so a rename never trips the rule-change-clears-dismiss follow). Every submit carries the client's
 * local day `on`.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const field = 'rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary';
// Native <select>s use the OPAQUE select token, not the (translucent) field-bg — the THEMES.md contract
// so the option popup themes instead of rendering white (ADR 0087, Part C). Inputs keep `field`.
const control = 'rounded-xl border border-field bg-control-bg px-2 py-1 text-sm outline-none focus:border-primary';

export default function RoutineForm({
  routine,
  on,
  telegramBound,
  serverTimezone,
  onSubmit,
  onCancel,
}: {
  routine: Routine | null; // null = create
  on: string;
  telegramBound: boolean; // a Telegram chat is bound (the nag scheduler's floor, with a timezone)
  serverTimezone: string | null; // the digest/nag timezone, or null when unset
  onSubmit: (dto: CreateRoutineDto | UpdateRoutineDto, id: string | null) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);
  const editing = routine !== null;

  const [name, setName] = useState(routine?.name ?? '');
  const [type, setType] = useState<RoutineType>(routine?.type ?? 'frequency');
  // frequency
  const [periodUnit, setPeriodUnit] = useState<PeriodUnit>(routine?.periodUnit ?? 'week');
  const [targetCount, setTargetCount] = useState(routine?.targetCount ?? 3);
  // floating
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>((routine?.intervalUnit as IntervalUnit) ?? 'week');
  const [intervalCount, setIntervalCount] = useState(routine?.intervalCount ?? 1);
  const [preferredWeekday, setPreferredWeekday] = useState<number | null>(routine?.preferredWeekday ?? null);
  const [due, setDue] = useState(routine?.nextDue ?? ''); // firstDue on create, nextDue on edit
  // fixed
  const [ruleKind, setRuleKind] = useState<FixedRuleKind>(routine?.ruleKind ?? 'nth_weekday_of_month');
  const [ordinal, setOrdinal] = useState(routine?.ruleOrdinal ?? 1);
  const [ruleWeekday, setRuleWeekday] = useState(routine?.ruleWeekday ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(routine?.ruleDayOfMonth ?? 1);
  // Telegram nag-reminders (ADR 0091 M2). The nag toggle applies to ANY type; the log-link is
  // non-frequency only (a multi-per-day frequency can't map to a single dated Log entry).
  const [telegramNag, setTelegramNag] = useState(routine?.telegramNag ?? false);
  // Custom nag cadence (v0.41.1): a count + minutes/hours unit, mirroring the frequency "Times per" control.
  // Init from the stored minutes — an exact ≥60 multiple of 60 shows as hours, else minutes (90 → "90 minutes").
  const initialNagMinutes = routine?.nagIntervalMinutes ?? 60; // default: 1 hour
  const initialNagUnit: 'minutes' | 'hours' =
    initialNagMinutes >= 60 && initialNagMinutes % 60 === 0 ? 'hours' : 'minutes';
  const [nagCount, setNagCount] = useState(initialNagUnit === 'hours' ? initialNagMinutes / 60 : initialNagMinutes);
  const [nagUnit, setNagUnit] = useState<'minutes' | 'hours'>(initialNagUnit);
  // Belt: derived minutes always clamped to the server's 1..1440 range regardless of the raw count.
  const nagIntervalMinutes = Math.min(1440, Math.max(1, nagUnit === 'hours' ? nagCount * 60 : nagCount));
  const [linkLog, setLinkLog] = useState(routine?.linkedLogId != null);

  const buildRule = (): FixedRule => {
    if (ruleKind === 'nth_weekday_of_month') return { kind: 'nth_weekday_of_month', ordinal, weekday: ruleWeekday };
    if (ruleKind === 'day_of_month') return { kind: 'day_of_month', day: dayOfMonth };
    return { kind: 'last_weekday_of_month', weekday: ruleWeekday };
  };
  const sameRule = (r: Routine): boolean =>
    r.ruleKind === ruleKind &&
    (ruleKind === 'day_of_month'
      ? r.ruleDayOfMonth === dayOfMonth
      : ruleKind === 'last_weekday_of_month'
        ? r.ruleWeekday === ruleWeekday
        : r.ruleOrdinal === ordinal && r.ruleWeekday === ruleWeekday);

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    // Nag fields ride onto both create and edit; the log-link is available on ANY type now (ADR 0093).
    const nag = telegramNag ? { telegramNag: true, nagIntervalMinutes } : {};
    const link = linkLog ? { linkLog: true } : {};
    if (!editing) {
      const base = { name: n, type, on, ...nag, ...link };
      const dto: CreateRoutineDto =
        type === 'frequency'
          ? { ...base, periodUnit, targetCount }
          : type === 'interval_floating'
            ? { ...base, intervalUnit, intervalCount, preferredWeekday, firstDue: due || undefined }
            : { ...base, rule: buildRule() };
      onSubmit(dto, null);
      return;
    }
    // EDIT — only changed fields
    const r = routine!;
    const dto: UpdateRoutineDto = { on };
    if (n !== r.name) dto.name = n;
    if (r.type === 'frequency') {
      if (targetCount !== r.targetCount) dto.targetCount = targetCount;
      if (periodUnit !== r.periodUnit) dto.periodUnit = periodUnit;
    } else if (r.type === 'interval_floating') {
      if (intervalUnit !== r.intervalUnit) dto.intervalUnit = intervalUnit;
      if (intervalCount !== r.intervalCount) dto.intervalCount = intervalCount;
      if (preferredWeekday !== r.preferredWeekday) dto.preferredWeekday = preferredWeekday;
      if (due && due !== r.nextDue) dto.nextDue = due;
    } else if (!sameRule(r)) {
      dto.rule = buildRule();
    }
    // Nag toggle (any type); only send the cadence while nagging is on.
    if (telegramNag !== (r.telegramNag ?? false)) dto.telegramNag = telegramNag;
    if (telegramNag && nagIntervalMinutes !== r.nagIntervalMinutes) dto.nagIntervalMinutes = nagIntervalMinutes;
    // Log-link (non-frequency only) — compare intent to the current linked state.
    if (linkLog !== (r.linkedLogId != null)) dto.linkLog = linkLog; // link available on any type (ADR 0093)
    onSubmit(dto, r.id);
  };

  const num = (v: string, min: number) => Math.max(min, Number(v) || min);

  // A nag fires only when a Telegram chat is bound AND a timezone is set (the scheduler's gate, ADR
  // 0091 M2). If the toggle is on but either is missing, the reminder silently never fires — so warn,
  // naming exactly what's missing.
  const nagBlocked = telegramNag && (!telegramBound || !serverTimezone);
  const nagWarning =
    !telegramBound && !serverTimezone
      ? 'Reminders need your Telegram bot connected and a timezone set (Settings → Telegram).'
      : !telegramBound
        ? 'Reminders need your Telegram bot connected (Settings → Telegram).'
        : 'Reminders need a timezone set (Settings → Telegram).';

  return (
    <dialog
      ref={dialogRef}
      onClose={onCancel}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
      aria-label={editing ? 'Edit routine' : 'New routine'}
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl bg-card p-0 text-fg shadow-lg backdrop:bg-backdrop"
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-sm font-semibold">{editing ? 'Edit routine' : 'New routine'}</h2>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Routine name" className={field} />
        </label>

        {!editing && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Type</span>
            <select value={type} onChange={(e) => setType(e.target.value as RoutineType)} aria-label="Routine type" className={control}>
              <option value="frequency">Frequency — N times per period</option>
              <option value="interval_floating">Every N — floating from completion</option>
              <option value="interval_fixed">Fixed — a calendar date</option>
            </select>
          </label>
        )}

        {type === 'frequency' && (
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">Times</span>
              <input type="number" min={1} value={targetCount} onChange={(e) => setTargetCount(num(e.target.value, 1))} aria-label="Target count" className={`${field} w-20`} />
            </label>
            <span className="pb-1 text-sm text-muted">per</span>
            <select value={periodUnit} onChange={(e) => setPeriodUnit(e.target.value as PeriodUnit)} aria-label="Period unit" className={control}>
              {(['day', 'week', 'month', 'year'] as const).map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        )}

        {type === 'interval_floating' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
              <span className="pb-1 text-sm text-muted">every</span>
              <input type="number" min={1} value={intervalCount} onChange={(e) => setIntervalCount(num(e.target.value, 1))} aria-label="Interval count" className={`${field} w-20`} />
              <select value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)} aria-label="Interval unit" className={control}>
                {(['day', 'week', 'month'] as const).map((u) => <option key={u} value={u}>{u}(s)</option>)}
              </select>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">Preferred weekday (optional)</span>
              <select
                value={preferredWeekday ?? ''}
                onChange={(e) => setPreferredWeekday(e.target.value === '' ? null : Number(e.target.value))}
                aria-label="Preferred weekday"
                className={control}
              >
                <option value="">None</option>
                {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">{editing ? 'Next due' : 'First due (defaults to one interval out)'}</span>
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" className={field} />
            </label>
          </div>
        )}

        {type === 'interval_fixed' && (
          <div className="flex flex-col gap-2">
            <select value={ruleKind} onChange={(e) => setRuleKind(e.target.value as FixedRuleKind)} aria-label="Rule kind" className={control}>
              <option value="nth_weekday_of_month">Nth weekday of the month</option>
              <option value="day_of_month">A day of the month</option>
              <option value="last_weekday_of_month">Last weekday of the month</option>
            </select>
            {ruleKind === 'nth_weekday_of_month' && (
              <div className="flex items-center gap-2">
                <select value={ordinal} onChange={(e) => setOrdinal(Number(e.target.value))} aria-label="Ordinal" className={control}>
                  {[1, 2, 3, 4, 5].map((o) => <option key={o} value={o}>{['1st', '2nd', '3rd', '4th', '5th'][o - 1]}</option>)}
                </select>
                <select value={ruleWeekday} onChange={(e) => setRuleWeekday(Number(e.target.value))} aria-label="Weekday" className={control}>
                  {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
                </select>
              </div>
            )}
            {ruleKind === 'day_of_month' && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Day (1–31; clamps to the month’s end)</span>
                <input type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(Math.min(31, num(e.target.value, 1)))} aria-label="Day of month" className={`${field} w-20`} />
              </label>
            )}
            {ruleKind === 'last_weekday_of_month' && (
              <select value={ruleWeekday} onChange={(e) => setRuleWeekday(Number(e.target.value))} aria-label="Weekday" className={control}>
                {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
              </select>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-field pt-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={telegramNag}
              onChange={(e) => setTelegramNag(e.target.checked)}
              aria-label="Remind me on Telegram"
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm">Remind me on Telegram</span>
          </label>
          {telegramNag && (
            <div className="ml-6 flex items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Nag me every</span>
                <input
                  type="number"
                  min={1}
                  max={nagUnit === 'hours' ? 24 : 1440}
                  value={nagCount}
                  onChange={(e) => setNagCount(Math.min(nagUnit === 'hours' ? 24 : 1440, num(e.target.value, 1)))}
                  aria-label="Nag interval"
                  className={`${field} w-20`}
                />
              </label>
              <select
                value={nagUnit}
                onChange={(e) => {
                  const u = e.target.value as 'minutes' | 'hours';
                  setNagUnit(u);
                  // Re-cap the count to the new unit's max so the derived minutes stays ≤ 1440.
                  setNagCount((c) => Math.min(u === 'hours' ? 24 : 1440, Math.max(1, c)));
                }}
                aria-label="Nag interval unit"
                className={control}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </div>
          )}
          {nagBlocked && (
            <p role="alert" className="ml-6 text-xs text-error">
              ⚠️ {nagWarning}
            </p>
          )}
          {/* The log link is available on ANY type now (ADR 0093) — a linked frequency records ≤1 entry/day. */}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={linkLog}
              onChange={(e) => setLinkLog(e.target.checked)}
              aria-label="Log each completion"
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm">Log each completion (to a Log named after this routine)</span>
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => dialogRef.current?.close()} className="touch-manipulation rounded-xl px-3 py-1.5 text-sm text-muted hover:bg-hover">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={!name.trim()} className="touch-manipulation rounded-xl bg-primary px-3 py-1.5 text-sm font-semibold text-on-primary disabled:opacity-40">
            {editing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
