import { describe, expect, it } from 'vitest';
import { isLocked, lockoutFor } from '../src/auth/lockout';

/**
 * The pure lockout state machine (ADR 0076) — the load-bearing brain, no DB, no clock. Tiers cap at
 * one day; a lock arms only at a multiple of 5 consecutive failures.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('lockoutFor — escalating tiers, capped at a day (ADR 0076)', () => {
  it('arms at each multiple of 5, escalating', () => {
    expect(lockoutFor(5)).toBe(MIN);
    expect(lockoutFor(10)).toBe(5 * MIN);
    expect(lockoutFor(15)).toBe(HOUR);
    expect(lockoutFor(20)).toBe(DAY);
  });

  it('caps at one day beyond 20 (25, 30, … stay 1 day)', () => {
    expect(lockoutFor(25)).toBe(DAY);
    expect(lockoutFor(30)).toBe(DAY);
    expect(lockoutFor(100)).toBe(DAY);
  });

  it('adds no new lock when the count is not a multiple of 5', () => {
    for (const n of [1, 2, 3, 4, 6, 9, 11, 14, 19]) expect(lockoutFor(n)).toBe(0);
  });

  it('0 and negatives arm nothing', () => {
    expect(lockoutFor(0)).toBe(0);
    expect(lockoutFor(-5)).toBe(0);
  });
});

describe('isLocked — future vs past vs null (ADR 0076)', () => {
  const now = new Date('2026-08-01T12:00:00.000Z');
  it('a future lockedUntil is locked', () => {
    expect(isLocked(new Date(now.getTime() + 1000), now)).toBe(true);
  });
  it('a past lockedUntil is NOT locked', () => {
    expect(isLocked(new Date(now.getTime() - 1000), now)).toBe(false);
  });
  it('exactly now is NOT locked (boundary is strict >)', () => {
    expect(isLocked(new Date(now.getTime()), now)).toBe(false);
  });
  it('null is NOT locked', () => {
    expect(isLocked(null, now)).toBe(false);
  });
});
