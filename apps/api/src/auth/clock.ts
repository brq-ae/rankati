/**
 * An injectable clock (ADR 0076) — the auth service reads "now" through this, never `new Date()`
 * directly, so the lockout tiers can be tested by ADVANCING a fake clock rather than by real waiting
 * (the same philosophy as the pure lockout module). Production binds the SystemClock.
 */
export interface Clock {
  now(): Date;
}

/** DI token for the clock (a string token — no @types coupling). */
export const CLOCK = 'AUTH_CLOCK';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
