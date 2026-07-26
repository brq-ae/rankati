// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PIN_DAYS, PIN_DAYS_KEY, readPinDays, storePinDays } from '../src/pin';

/**
 * The four impact-pin day-knobs (ADR 0075) — two fuses + two snooze spans, in one localStorage object.
 * Each field is validated INDEPENDENTLY: a bad field falls back to ITS default, the others stand.
 */
describe('pin-days prefs (ADR 0075)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults when nothing is stored (7 / 30 / 1 / 3)', () => {
    expect(readPinDays()).toEqual(DEFAULT_PIN_DAYS);
    expect(DEFAULT_PIN_DAYS).toEqual({
      highFuseDays: 7, mediumFuseDays: 30, highSnoozeDays: 1, mediumSnoozeDays: 3,
    });
  });

  it('round-trips a full set', () => {
    const set = { highFuseDays: 5, mediumFuseDays: 20, highSnoozeDays: 2, mediumSnoozeDays: 4 };
    storePinDays(set);
    expect(readPinDays()).toEqual(set);
  });

  it('each field is validated independently — a bad field defaults, the others stand', () => {
    // highFuseDays non-integer, highSnoozeDays < 1 → both default (7 / 1); the two valid ones stand.
    localStorage.setItem(
      PIN_DAYS_KEY,
      JSON.stringify({ highFuseDays: 'abc', mediumFuseDays: 14, highSnoozeDays: 0, mediumSnoozeDays: 4 }),
    );
    expect(readPinDays()).toEqual({
      highFuseDays: 7, // default (non-integer)
      mediumFuseDays: 14, // valid — stands
      highSnoozeDays: 1, // default (< 1)
      mediumSnoozeDays: 4, // valid — stands
    });
  });

  it('a non-object or garbage store → all defaults', () => {
    localStorage.setItem(PIN_DAYS_KEY, 'not json');
    expect(readPinDays()).toEqual(DEFAULT_PIN_DAYS);
    localStorage.setItem(PIN_DAYS_KEY, '[7,30,1,3]'); // an array is not the object shape
    expect(readPinDays()).toEqual(DEFAULT_PIN_DAYS);
  });
});
