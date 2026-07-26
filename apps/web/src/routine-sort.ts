import type { PeriodUnit, Routine } from '@rankati/shared';

/**
 * The Routines climb order (ADR 0066 + its v0.18 pace extension). Pure and client-only — only the
 * client holds the local day `on` — so it is unit-testable in isolation.
 *
 * TWO BANDS, unchanged from 0066: DUE-BASED routines (floating + fixed) climb by days-until (overdue
 * first, then soonest); FREQUENCY routines form a band strictly BELOW them. Within the frequency band
 * (the v0.18 refinement) they order by PACE PRESSURE — the daily rate you'd now have to hit to finish
 * — most-behind first, goal-met at the bottom. Frequencies never rise into the due-based band.
 */
const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The exclusive end of the period that began on `periodStart` — one unit later, calendar-aware. */
export function periodEnd(periodStart: string, unit: PeriodUnit): string {
  const d = new Date(`${periodStart}T00:00:00Z`);
  if (unit === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (unit === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1); // year
  return d.toISOString().slice(0, 10);
}

/**
 * Pace pressure for a frequency routine: `remaining / daysLeft` — the per-day rate needed to hit the
 * target before the period ends. Higher = more at risk. Goal-met (remaining 0) → 0, so a met routine
 * sinks to the bottom of the band. `daysLeft` is floored at 1 (the last day still counts).
 *
 * It depends only on the DTO's own `periodStart`/`periodUnit`, so it matches the server's period
 * boundary exactly (the server re-anchors a stale `periodStart` on read, ADR 0066 extension) without
 * this code re-deriving where a week or month begins.
 */
export function pacePressure(r: Routine, on: string): number {
  const remaining = Math.max(0, (r.targetCount ?? 0) - (r.periodCount ?? 0));
  if (remaining === 0) return 0;
  const daysLeft = Math.max(1, daysBetween(on, periodEnd(r.periodStart!, r.periodUnit!)));
  return remaining / daysLeft;
}

/** Days from `on` to a due-based routine's next occurrence (negative = overdue). */
const daysUntilDue = (r: Routine, on: string) => daysBetween(on, r.nextDue!);

/** The full climb order. Returns a new array; does not mutate the input. */
export function sortRoutines(routines: Routine[], on: string): Routine[] {
  return [...routines].sort((a, b) => {
    // Band: due-based (finite days-until) above frequency (Infinity).
    const ka = a.type === 'frequency' ? Infinity : daysUntilDue(a, on);
    const kb = b.type === 'frequency' ? Infinity : daysUntilDue(b, on);
    if (ka !== kb) return ka === Infinity ? 1 : kb === Infinity ? -1 : ka - kb;
    // Within the frequency band: most pace pressure first (goal-met, pressure 0, sinks).
    if (a.type === 'frequency' && b.type === 'frequency') {
      const diff = pacePressure(b, on) - pacePressure(a, on);
      if (diff !== 0) return diff;
    }
    return a.name.localeCompare(b.name);
  });
}
