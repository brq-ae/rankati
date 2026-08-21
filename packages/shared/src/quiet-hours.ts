import type { QuietHours } from './index';

/**
 * Quiet-hours window logic (ADR 0091) — pure, shared web + api/bot so the rule lives in ONE place (the
 * digest scheduler evaluates it; the Settings UI shows the live "will be delayed" notice from the same
 * function, never recomputing it). A runtime export, like computePin/computeLogStats/sortRoutines (0086).
 */

/** Strict "HH:MM" (24h, zero-padded) → minutes since midnight [0,1440), or null if malformed. */
export function hhmmToMinutes(value: string): number | null {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

/** minutes since midnight → "HH:MM" (zero-padded). Assumes [0,1440). */
export function minutesToHhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Is `nowMinutes` inside the quiet window `[startMinutes, endMinutes)` — END-EXCLUSIVE (matches the 0070
 * availability ladder), and MIDNIGHT-WRAP-aware. `start === end` is a zero-width window = never quiet.
 * All three are minutes-since-midnight; callers resolve "now" against the configured timezone first.
 */
export function isWithinQuietMinutes(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) return false; // zero-width = off
  return startMinutes < endMinutes
    ? nowMinutes >= startMinutes && nowMinutes < endMinutes // same-day window
    : nowMinutes >= startMinutes || nowMinutes < endMinutes; // wraps midnight
}

/**
 * Is the local "HH:MM" time `nowHhmm` inside the configured quiet window? Off (false) unless BOTH ends are
 * set to valid times. The one entry point the scheduler and the UI both call.
 */
export function isWithinQuietHours(nowHhmm: string, quiet: QuietHours): boolean {
  if (quiet.start == null || quiet.end == null) return false; // unset = off
  const now = hhmmToMinutes(nowHhmm);
  const start = hhmmToMinutes(quiet.start);
  const end = hhmmToMinutes(quiet.end);
  if (now == null || start == null || end == null) return false; // malformed stored value = treat as off
  return isWithinQuietMinutes(now, start, end);
}
