/**
 * The graded impact pin — pure logic (ADR 0075), SHARED by every client (ADR 0086).
 *
 * Impact is a declared per-task level (None/Medium/High) that NEVER enters `priority_now` (0007/0057) — it
 * drives only a safety-net PIN: one highlighted card above the hand for a task that is important, playable,
 * has sat past its fuse, and is not already in the hand. The fuse is set by the level (High = 7 days,
 * Medium = 30), off the task's created date.
 *
 * Pure: no storage, no wall-clock (the caller passes `now`). It lives in `@rankati/shared` so the web
 * (which bundles this source) and the api/bot (which run the built `dist`) compute the IDENTICAL pin — the
 * web against its curated hand, the bot against its top-5, via this same function (ADR 0086).
 */
import type { Impact } from './index';

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

const DAY_MS = 86_400_000;

/** The snooze span in ms for a level (ADR 0075) — used to compute `snoozedUntil = now + span`. */
export function snoozeSpanMs(level: 'medium' | 'high', config: SnoozeConfig = DEFAULT_SNOOZE_CONFIG): number {
  return (level === 'high' ? config.highSnoozeDays : config.mediumSnoozeDays) * DAY_MS;
}

/** All four pin day-values in one object — the two fuses and the two snooze spans, editable in Settings.
 *  Structurally a superset of both PinConfig and SnoozeConfig, so it can be passed to either directly. */
export interface PinDays extends PinConfig, SnoozeConfig {}

export const DEFAULT_PIN_DAYS: PinDays = { ...DEFAULT_PIN_CONFIG, ...DEFAULT_SNOOZE_CONFIG };

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
