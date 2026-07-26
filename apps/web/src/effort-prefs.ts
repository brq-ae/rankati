import type { Effort } from '@rankati/shared';

/**
 * The fit term's CLIENT-SIDE display prefs (ADR 0072).
 *
 * Two things live here, and both are the client's alone:
 *
 *   - the free BLOCK the Today hand is dealt against is EPHEMERAL — a live React choice that resets
 *     to Any each session (it is NOT persisted here, deliberately, so a reload cannot show a hand
 *     dealt against yesterday's block: a sticky block would be a lying view). Only its ordinal value
 *     ever reaches the server, via getTodayTasks.
 *   - the two minute THRESHOLDS that LABEL the buckets ("Quick: up to 15 min") are persisted, but
 *     they are DISPLAY ONLY. The server ranks on the ordinal bucket alone (0072); minutes never
 *     cross the wire. They shape what the words mean to the owner, nothing more.
 *
 * This is 0060's client-pref posture (location-filter.ts) applied to fit: storage can throw, so
 * every read falls back rather than crashing, and the defaults are a sensible floor.
 */

/** The three buckets, smallest first — the picker's order and the ordinal the server sorts by. */
export const EFFORTS: readonly Effort[] = ['quick', 'medium', 'long'];

/** The two editable minute thresholds. quickMax bounds Quick; mediumMax bounds Medium; Long is
 *  whatever is bigger. DISPLAY ONLY — they never leave the client (0072). */
export interface Thresholds {
  quickMax: number;
  mediumMax: number;
}

/** A sane floor before the owner ever opens Settings: Quick ≤ 15 min, Medium ≤ 60, Long beyond. */
export const DEFAULT_THRESHOLDS: Thresholds = { quickMax: 15, mediumMax: 60 };

export const EFFORT_QUICK_KEY = 'deck.effort.quickMax';
export const EFFORT_MEDIUM_KEY = 'deck.effort.mediumMax';

/** Parse a stored minute count: a positive integer, or null if absent/garbage (fall back). */
function readMinutes(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The persisted thresholds, each falling back to its default independently. If the stored pair is
 * incoherent (quickMax ≥ mediumMax — a Medium that cannot exist), fall the pair back to defaults
 * rather than showing labels that contradict each other.
 */
export function readThresholds(): Thresholds {
  const quickMax = readMinutes(EFFORT_QUICK_KEY) ?? DEFAULT_THRESHOLDS.quickMax;
  const mediumMax = readMinutes(EFFORT_MEDIUM_KEY) ?? DEFAULT_THRESHOLDS.mediumMax;
  if (quickMax >= mediumMax) return { ...DEFAULT_THRESHOLDS };
  return { quickMax, mediumMax };
}

/** Persist the thresholds. Unstorable (private mode) is fine — the labels still work this session. */
export function storeThresholds(t: Thresholds): void {
  try {
    localStorage.setItem(EFFORT_QUICK_KEY, String(t.quickMax));
    localStorage.setItem(EFFORT_MEDIUM_KEY, String(t.mediumMax));
  } catch {
    // Not remembered next session; harmless — nothing here gates.
  }
}

/** The word for a bucket. */
export function bucketName(effort: Effort): string {
  return effort === 'quick' ? 'Quick' : effort === 'medium' ? 'Medium' : 'Long';
}

/**
 * The minute-range label a threshold pair gives a bucket — what the picker and the effort selector
 * show. "Quick: up to 15 min" / "Medium: up to 60 min" / "Long: over 60 min". Purely a display
 * string built from the client thresholds; it is never sent anywhere.
 */
export function bucketLabel(effort: Effort, t: Thresholds): string {
  if (effort === 'quick') return `Quick: up to ${t.quickMax} min`;
  if (effort === 'medium') return `Medium: up to ${t.mediumMax} min`;
  return `Long: over ${t.mediumMax} min`;
}
