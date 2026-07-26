import type { TaskTier } from '@rankati/shared';

/**
 * The urgency scoring model (ADR 0057).
 *
 * Today-score = the Arena rating ESCALATED by how near a task's `due` deadline is. The rating is
 * the backbone; urgency only amplifies it, and an undated task escalates by 1 (ranks at its
 * rating). The constants below ARE the model's knobs — retune them by feel, exactly as the Elo
 * K-factors in `elo.ts` are (0047). The worked table in 0057 is the regression target.
 */

/** Peak lift at the due date: `m(0) = 1 + BOOST`. Bigger = urgency dominates the rating harder. */
export const BOOST = 2.0;

/** The multiplier at which a dated task crosses into Today — it enters barely boosted, near its
 *  base rating ("at the bottom"). This IS the Today/Upcoming threshold (ADR 0058). */
export const ENTRY_MULT = 1.02;

/** Per-tier entry windows, in days: how many days before `due` a task of each tier enters Today.
 *  This is the ladder, and it sets each tier's curve steepness. */
export const W_TIER: Readonly<Record<TaskTier, number>> = {
  critical: 14,
  super_important: 7,
  important: 5,
  normal: 3,
};

const DAY_MS = 86_400_000;

/**
 * The urgency multiplier as a pure function of ALL its inputs — no module constants — so the
 * curve's identities can be tested under a retune, not only at the shipped values (ADR 0057).
 *
 * λ is DERIVED so that `m(windowDays) === entryMult` exactly, for ANY (boost, entryMult, window):
 *
 *   λ = ln( boost / (entryMult − 1) ) / windowDays
 *
 * That derivation is the whole reason "d ≤ window" (placement) and "m ≥ entryMult" (the threshold)
 * are the same rule (0058). If it is ever broken — a hardcoded λ, a changed window without λ
 * following — scoring.spec's equivalence test fails, rather than the threshold quietly meaning
 * two different things.
 */
export function multiplierAt(
  days: number,
  windowDays: number,
  boost: number,
  entryMult: number,
): number {
  const lambda = Math.log(boost / (entryMult - 1)) / windowDays;
  return 1 + boost * Math.exp(-lambda * days);
}

/** The urgency multiplier for a tier at `days` from due, using the shipped constants. */
export function urgencyMultiplier(days: number, tier: TaskTier): number {
  return multiplierAt(days, W_TIER[tier], BOOST, ENTRY_MULT);
}

/**
 * Whole calendar days from the client's local day to `due` — both 'YYYY-MM-DD', both anchored at
 * UTC midnight and differenced, so no timezone leaks in (the mapper's discipline, 0052).
 * Positive = future, 0 = due today, negative = overdue.
 */
export function daysUntil(due: string, on: string): number {
  const dueMs = Date.parse(`${due}T00:00:00.000Z`);
  const onMs = Date.parse(`${on}T00:00:00.000Z`);
  return Math.round((dueMs - onMs) / DAY_MS);
}

export type Placement = 'undated' | 'overdue' | 'today' | 'upcoming';

/**
 * Which stratum of the read a task falls in (ADR 0058). The Today/Upcoming split is `d ≤ W_tier`,
 * the integer form of "m ≥ ENTRY_MULT" — equivalent by construction (see multiplierAt), and the
 * integer form is used here to keep the boundary exact rather than float-fragile.
 */
export function placement(due: string | null, tier: TaskTier, on: string): Placement {
  if (due === null) return 'undated';
  const d = daysUntil(due, on);
  if (d < 0) return 'overdue';
  return d <= W_TIER[tier] ? 'today' : 'upcoming';
}

/**
 * The escalated Today-score that ORDERS the non-overdue strata (ADR 0057). Undated → the raw
 * rating (multiplier 1). Overdue is not ordered by this — it is pinned and ordered by rating
 * (0058) — but the function still returns a value for it rather than throwing.
 */
export function todayScore(rating: number, due: string | null, tier: TaskTier, on: string): number {
  if (due === null) return rating;
  return rating * urgencyMultiplier(daysUntil(due, on), tier);
}
