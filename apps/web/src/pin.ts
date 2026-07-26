/**
 * The graded impact pin — pure client-side logic (ADR 0075).
 *
 * Impact is a declared per-task level (None/Medium/High) that NEVER enters `priority_now` (0007/0057
 * hold) — it drives only a safety-net PIN: one highlighted card above the hand for a task that is
 * important, playable, has been sitting past its fuse, and is not already in the hand. The fuse is set
 * by the level itself (High = 7 days, Medium = 30), off the task's created date.
 *
 * Pure: no storage, no wall-clock (the caller passes `now`) — the same shape as hand.ts. This module
 * only READS the snooze map; writing snoozes and the snooze SPANS live client-side, in a later slice.
 */
import type { Impact } from '@rankati/shared';

export type { Impact };

/** Fuse lengths in days, by level (ADR 0075). Editable in Settings; these are the defaults. */
export interface PinConfig {
  highFuseDays: number;
  mediumFuseDays: number;
}

export const DEFAULT_PIN_CONFIG: PinConfig = { highFuseDays: 7, mediumFuseDays: 30 };

/** Snooze spans in days, by level (ADR 0075) — how long dismissing a pin hides it. Editable in
 *  Settings; these are the defaults. High returns sooner (a day) than Medium (three). */
export interface SnoozeConfig {
  highSnoozeDays: number;
  mediumSnoozeDays: number;
}

export const DEFAULT_SNOOZE_CONFIG: SnoozeConfig = { highSnoozeDays: 1, mediumSnoozeDays: 3 };

/** The snooze span in ms for a level (ADR 0075) — used to compute `snoozedUntil = now + span`. */
export function snoozeSpanMs(level: 'medium' | 'high', config: SnoozeConfig = DEFAULT_SNOOZE_CONFIG): number {
  return (level === 'high' ? config.highSnoozeDays : config.mediumSnoozeDays) * DAY_MS;
}

/** What the caller hands over per task — impact + when it was created (epoch ms). */
export interface PinCandidate {
  id: string;
  impact: Impact;
  createdAt: number;
}

/** The single fired pin, or the reason it fired — most-overdue first, one at a time. */
export interface Pin {
  id: string;
  level: 'medium' | 'high';
  ageDays: number;
  overdueByDays: number;
}

const DAY_MS = 86_400_000;

/**
 * Which SINGLE task pins right now (or `null`). A task qualifies iff it is Medium or High, playable
 * now (`playableIds` — the same set the hand is composed from), NOT currently in the hand (`handIds`),
 * not snoozed (`snoozes[id]` absent or `<= now`), and its full-days age is at least its level's fuse
 * (inclusive boundary — exactly 7 days on a High task qualifies). Of the qualifiers, exactly one is
 * returned: High before Medium, then larger `overdueByDays`, then older `createdAt`.
 */
export function computePin(
  candidates: PinCandidate[],
  playableIds: ReadonlySet<string>,
  handIds: string[],
  snoozes: Record<string, number>,
  now: number,
  config: PinConfig = DEFAULT_PIN_CONFIG,
): Pin | null {
  const held = new Set(handIds);
  const createdById = new Map(candidates.map((c) => [c.id, c.createdAt]));
  const qualified: Pin[] = [];

  for (const c of candidates) {
    if (c.impact !== 'medium' && c.impact !== 'high') continue; // None never pins
    if (!playableIds.has(c.id)) continue; // must be playable now
    if (held.has(c.id)) continue; // already in the hand — no need to nag
    const until = snoozes[c.id];
    if (until !== undefined && until > now) continue; // snoozed
    const ageDays = Math.floor((now - c.createdAt) / DAY_MS);
    const fuse = c.impact === 'high' ? config.highFuseDays : config.mediumFuseDays;
    if (ageDays < fuse) continue; // not yet past its fuse
    qualified.push({ id: c.id, level: c.impact, ageDays, overdueByDays: ageDays - fuse });
  }

  if (qualified.length === 0) return null;

  // One at a time: High before Medium; then the more overdue; then the older task.
  qualified.sort(
    (a, b) =>
      (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1) ||
      b.overdueByDays - a.overdueByDays ||
      (createdById.get(a.id) ?? 0) - (createdById.get(b.id) ?? 0),
  );
  return qualified[0]!;
}

// ── Snooze state (localStorage), the heldIds prefs pattern (ADR 0075) ────────────────────────────────

export const SNOOZES_KEY = 'deck.pin.snoozes';

/**
 * The persisted snooze map: `{ [taskId]: snoozedUntil (epoch ms) }`. Missing or garbage → `{}`, and a
 * non-numeric entry is dropped rather than trusted — the same robustness as readHeldIds. Storage can
 * throw (private mode); never crash.
 */
export function readSnoozes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SNOOZES_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Persist the snooze map, PRUNING entries that have already expired (`<= now`) so it self-cleans and
 * cannot grow unbounded — a dismissed pin that has since returned leaves no trace. Returns the pruned
 * map so the caller can keep its state in sync with what was written.
 */
export function storeSnoozes(snoozes: Record<string, number>, now: number): Record<string, number> {
  const pruned: Record<string, number> = {};
  for (const [k, v] of Object.entries(snoozes)) if (v > now) pruned[k] = v;
  try {
    localStorage.setItem(SNOOZES_KEY, JSON.stringify(pruned));
  } catch {
    // Not remembered next session; harmless — the snooze still holds this session.
  }
  return pruned;
}

// ── The four day-knobs (localStorage), the readHandSize pattern (ADR 0075) ───────────────────────────

export const PIN_DAYS_KEY = 'deck.pin.days';

/** All four pin day-values in one object — the two fuses and the two snooze spans, editable in Settings.
 *  Structurally a superset of both PinConfig and SnoozeConfig, so it can be passed to either directly. */
export interface PinDays extends PinConfig, SnoozeConfig {}

export const DEFAULT_PIN_DAYS: PinDays = { ...DEFAULT_PIN_CONFIG, ...DEFAULT_SNOOZE_CONFIG };

/** A single knob: a positive integer, else that field's default. */
function readDay(obj: Record<string, unknown>, key: keyof PinDays): number {
  const v = obj[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : DEFAULT_PIN_DAYS[key];
}

/**
 * The four day-values, EACH validated INDEPENDENTLY (ADR 0075): a garbage or missing whole object → all
 * defaults; one bad field → only that field defaults, the rest stand. Storage can throw; never crash.
 */
export function readPinDays(): PinDays {
  let obj: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(PIN_DAYS_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    }
  } catch {
    obj = {};
  }
  return {
    highFuseDays: readDay(obj, 'highFuseDays'),
    mediumFuseDays: readDay(obj, 'mediumFuseDays'),
    highSnoozeDays: readDay(obj, 'highSnoozeDays'),
    mediumSnoozeDays: readDay(obj, 'mediumSnoozeDays'),
  };
}

export function storePinDays(days: PinDays): void {
  try {
    localStorage.setItem(PIN_DAYS_KEY, JSON.stringify(days));
  } catch {
    // Unstorable (private mode): the knobs still hold this session, just not remembered.
  }
}
