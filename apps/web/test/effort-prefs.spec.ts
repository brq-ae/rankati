// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  EFFORT_MEDIUM_KEY,
  EFFORT_QUICK_KEY,
  bucketLabel,
  bucketName,
  readThresholds,
  storeThresholds,
} from '../src/effort-prefs';

/**
 * The fit term's client-side display prefs (ADR 0072). The load-bearing properties: the thresholds
 * round-trip through localStorage, a MISSING or INCOHERENT store falls back rather than crashing or
 * showing labels that contradict each other, and the labels are built purely client-side. There is
 * deliberately NO block persistence here — the free block is ephemeral (App state), which is what
 * makes it reset to Any each session; a test that stored a block would be testing a bug.
 */
describe('effort-prefs — thresholds persist; labels are client-only (0072)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults when nothing is stored', () => {
    expect(readThresholds()).toEqual(DEFAULT_THRESHOLDS);
  });

  it('round-trips a stored pair', () => {
    storeThresholds({ quickMax: 10, mediumMax: 45 });
    expect(readThresholds()).toEqual({ quickMax: 10, mediumMax: 45 });
    // Stored as plain minute strings — no structure the server could ever consume.
    expect(localStorage.getItem(EFFORT_QUICK_KEY)).toBe('10');
    expect(localStorage.getItem(EFFORT_MEDIUM_KEY)).toBe('45');
  });

  it('falls back on an incoherent pair (quick ≥ medium — a Medium that cannot exist)', () => {
    localStorage.setItem(EFFORT_QUICK_KEY, '60');
    localStorage.setItem(EFFORT_MEDIUM_KEY, '30');
    expect(readThresholds()).toEqual(DEFAULT_THRESHOLDS);
  });

  it('falls back a single garbage value independently', () => {
    localStorage.setItem(EFFORT_QUICK_KEY, 'abc'); // → default quickMax 15
    localStorage.setItem(EFFORT_MEDIUM_KEY, '90');
    expect(readThresholds()).toEqual({ quickMax: DEFAULT_THRESHOLDS.quickMax, mediumMax: 90 });
  });

  it('labels are built from the thresholds — the words the pickers show', () => {
    const t = { quickMax: 15, mediumMax: 60 };
    expect(bucketLabel('quick', t)).toBe('Quick: up to 15 min');
    expect(bucketLabel('medium', t)).toBe('Medium: up to 60 min');
    expect(bucketLabel('long', t)).toBe('Long: over 60 min');
    expect([bucketName('quick'), bucketName('medium'), bucketName('long')]).toEqual([
      'Quick',
      'Medium',
      'Long',
    ]);
  });
});
