/**
 * The escalating brute-force lockout — a PURE state machine (ADR 0076). No DB, no clock: the caller
 * passes the consecutive failed-attempt count and the current time. This is the load-bearing brain,
 * unit-tested in isolation; step 4 wires it into the login flow and persists `failedAttempts` /
 * `lockedUntil` on the Account row so a lock survives a restart.
 *
 * THE RESET RULE (wired in step 4, documented here): a SUCCESSFUL login resets `failedAttempts` to 0
 * and clears `lockedUntil`. The counter only escalates across *consecutive* failures.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The lockout DURATION (ms) to apply for a failed attempt, given the NEW consecutive `failedCount`.
 * A lock is armed only when the count reaches a multiple of 5; otherwise this attempt adds no lock (0).
 * Tiers, capped at one day:
 *   5  → 1 minute      10 → 5 minutes      15 → 1 hour      20, 25, 30, … → 1 day (the cap)
 *   1–4, 6–9, …        → 0 (not a multiple of 5, so no NEW lock this attempt)
 */
export function lockoutFor(failedCount: number): number {
  if (failedCount <= 0 || failedCount % 5 !== 0) return 0;
  const tier = failedCount / 5; // 1, 2, 3, 4, …
  if (tier === 1) return MINUTE;
  if (tier === 2) return 5 * MINUTE;
  if (tier === 3) return HOUR;
  return DAY; // tier ≥ 4 (count 20 and beyond) — capped at one day
}

/** Locked iff `lockedUntil` is set and still in the future. Past or `null` → not locked. */
export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}
