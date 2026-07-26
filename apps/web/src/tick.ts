/**
 * The tick's grace period (ADR 0055).
 *
 * ONE source. The ring's animation duration is set from this constant inline rather than
 * written again in CSS: two places holding "15 seconds" would drift, and the drift is
 * invisible — a ring that finishes before the commit fires looks like a frozen ring, and one
 * that finishes after looks like a tick that undid itself.
 */
export const TICK_GRACE_MS = 15_000;

/** The ring's geometry. r=10 in a 24-unit box; the dash length must equal the circumference
 *  or the wind-down would not reach empty. */
export const RING_RADIUS = 10;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * The pending countdown, derived from the ONE real deadline — never from when a component
 * mounted (ADR 0055 addendum).
 *
 * A pending tick has a single deadline (the timestamp in App's pending Map). Every countdown
 * visual — the ring around the circle, the bar on each row — is a pure function of that
 * deadline and the current time. So a re-render, or a remount after a screen switch, recomputes
 * the SAME position instead of restarting from full. This is the fix for the ring that used to
 * animate a fresh 15s on every mount while the commit still fired at the true deadline: the
 * visual was lying about time remaining. It cannot now, because it reads the deadline the
 * commit reads.
 *
 * `msRemaining` is the one derived quantity, clamped to [0, TICK_GRACE_MS] so a past deadline
 * reads as spent rather than negative and a future one never exceeds the window.
 */
export function msRemaining(deadline: number, now: number): number {
  return Math.max(0, Math.min(TICK_GRACE_MS, deadline - now));
}

/**
 * How far the grace period has run, in ms. Drives the CSS `animation-delay: -msElapsed(...)`
 * that re-syncs ring and bar to the real deadline: mount at 13s in and the animation seeks to
 * 13s, not to zero.
 */
export function msElapsed(deadline: number, now: number): number {
  return TICK_GRACE_MS - msRemaining(deadline, now);
}

/** Fraction still remaining, 1 → 0 — the static position for reduced-motion, where the bar
 *  and ring hold rather than animate. */
export function fractionRemaining(deadline: number, now: number): number {
  return msRemaining(deadline, now) / TICK_GRACE_MS;
}
