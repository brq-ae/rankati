// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EVERYWHERE,
  filterByLocation,
  matchesLocation,
  readStoredLocation,
  storeLocation,
} from '../src/location-filter';

/** The ONE location predicate (ADR 0060) and its persistence. The three views all route through
 *  filterByLocation, so these unit cases are what a sabotage there would break app-wide. */

const t = (locationIds: string[]) => ({ locationIds });

describe('matchesLocation (0060)', () => {
  it('Everywhere shows everything — the filter off', () => {
    expect(matchesLocation(t([]), EVERYWHERE)).toBe(true);
    expect(matchesLocation(t(['office']), EVERYWHERE)).toBe(true);
  });

  it('an UNTAGGED task shows in every context — doable anywhere ⇒ doable here', () => {
    expect(matchesLocation(t([]), 'office')).toBe(true);
    expect(matchesLocation(t([]), 'home')).toBe(true);
  });

  it('a tagged task shows only where it is tagged', () => {
    expect(matchesLocation(t(['office']), 'office')).toBe(true);
    expect(matchesLocation(t(['office']), 'home')).toBe(false);
  });

  it('a multi-location task shows in each of its places', () => {
    const both = t(['office', 'home']);
    expect(matchesLocation(both, 'office')).toBe(true);
    expect(matchesLocation(both, 'home')).toBe(true);
    expect(matchesLocation(both, 'garage')).toBe(false);
  });

  it('filterByLocation keeps exactly the matching tasks', () => {
    const tasks = [t(['office']), t([]), t(['home'])];
    expect(filterByLocation(tasks, 'office')).toEqual([t(['office']), t([])]); // tagged + untagged
    expect(filterByLocation(tasks, EVERYWHERE)).toHaveLength(3);
  });
});

describe('persistence (0060)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to Everywhere, unpinned, when nothing is stored', () => {
    expect(readStoredLocation()).toEqual({ location: EVERYWHERE, pinned: false });
  });

  it('a PINNED selection round-trips', () => {
    storeLocation('office', true);
    expect(readStoredLocation()).toEqual({ location: 'office', pinned: true });
  });

  it('UNPINNED forgets the id — next load resets to Everywhere', () => {
    storeLocation('office', true);
    storeLocation('office', false); // unpin
    expect(readStoredLocation()).toEqual({ location: EVERYWHERE, pinned: false });
  });
});
