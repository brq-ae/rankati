// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SNOOZES_KEY, readSnoozes, storeSnoozes } from '../src/pin';

/**
 * The impact-pin snooze persistence (ADR 0075) — a `{ taskId: snoozedUntil }` map in localStorage,
 * the heldIds pattern. Robust reads (garbage → {}) and a self-cleaning write (expired entries pruned).
 */
const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

describe('snooze prefs (ADR 0075)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('round-trips a snooze map (only the future entries survive the write)', () => {
    expect(readSnoozes()).toEqual({}); // absent → {}
    const written = storeSnoozes({ a: NOW + DAY, b: NOW + 3 * DAY }, NOW);
    expect(written).toEqual({ a: NOW + DAY, b: NOW + 3 * DAY });
    expect(readSnoozes()).toEqual({ a: NOW + DAY, b: NOW + 3 * DAY });
  });

  it('garbage / non-object / non-numeric entries → {}', () => {
    localStorage.setItem(SNOOZES_KEY, 'not json');
    expect(readSnoozes()).toEqual({});
    localStorage.setItem(SNOOZES_KEY, '[1,2,3]'); // an array is not the map shape
    expect(readSnoozes()).toEqual({});
    localStorage.setItem(SNOOZES_KEY, JSON.stringify({ a: 'soon', b: NOW + DAY }));
    expect(readSnoozes()).toEqual({ b: NOW + DAY }); // the non-numeric entry is dropped, not trusted
  });

  it('writing PRUNES already-expired entries so the map cannot grow unbounded', () => {
    const written = storeSnoozes({ past: NOW - DAY, exact: NOW, future: NOW + DAY }, NOW);
    expect(written).toEqual({ future: NOW + DAY }); // <= now dropped (past AND exact)
    expect(readSnoozes()).toEqual({ future: NOW + DAY });
  });
});
