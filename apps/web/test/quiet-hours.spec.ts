import { describe, expect, it } from 'vitest';
import { hhmmToMinutes, isWithinQuietHours, isWithinQuietMinutes, minutesToHhmm } from '@rankati/shared';

/**
 * Quiet-hours window logic (ADR 0091). Pure, shared web + api. Covers the strict HH:MM parse, the
 * END-EXCLUSIVE same-day window, the MIDNIGHT-WRAP branch, start==end = off, and null = off.
 */
describe('hhmmToMinutes', () => {
  it('parses valid zero-padded 24h times', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('08:00')).toBe(480);
    expect(hhmmToMinutes('22:00')).toBe(1320);
    expect(hhmmToMinutes('23:59')).toBe(1439);
  });
  it('rejects malformed times as null', () => {
    for (const bad of ['24:00', '8:05', '08:5', '7:60', '9:99', '', '0800', 'ab:cd', '23:60']) {
      expect(hhmmToMinutes(bad)).toBeNull();
    }
  });
  it('round-trips with minutesToHhmm', () => {
    expect(minutesToHhmm(1320)).toBe('22:00');
    expect(minutesToHhmm(0)).toBe('00:00');
    expect(minutesToHhmm(479)).toBe('07:59');
  });
});

describe('isWithinQuietMinutes — end-exclusive, midnight-wrap', () => {
  it('same-day window [08:00, 22:00): start inclusive, end exclusive', () => {
    const s = 480,
      e = 1320;
    expect(isWithinQuietMinutes(480, s, e)).toBe(true); // 08:00 in
    expect(isWithinQuietMinutes(1319, s, e)).toBe(true); // 21:59 in
    expect(isWithinQuietMinutes(1320, s, e)).toBe(false); // 22:00 out (exclusive)
    expect(isWithinQuietMinutes(479, s, e)).toBe(false); // 07:59 out
  });
  it('midnight-wrap window [22:00, 08:00): spans the day boundary', () => {
    const s = 1320,
      e = 480;
    expect(isWithinQuietMinutes(1320, s, e)).toBe(true); // 22:00 in
    expect(isWithinQuietMinutes(1439, s, e)).toBe(true); // 23:59 in
    expect(isWithinQuietMinutes(0, s, e)).toBe(true); // 00:00 in
    expect(isWithinQuietMinutes(479, s, e)).toBe(true); // 07:59 in
    expect(isWithinQuietMinutes(480, s, e)).toBe(false); // 08:00 out (exclusive → digest at 08:00 fires)
    expect(isWithinQuietMinutes(720, s, e)).toBe(false); // 12:00 out
  });
  it('start == end is a zero-width window = never quiet', () => {
    expect(isWithinQuietMinutes(600, 600, 600)).toBe(false);
    expect(isWithinQuietMinutes(0, 600, 600)).toBe(false);
  });
});

describe('isWithinQuietHours — the HH:MM + QuietHours entry point', () => {
  it('is off unless both ends are set', () => {
    expect(isWithinQuietHours('23:00', { start: null, end: null })).toBe(false);
    expect(isWithinQuietHours('23:00', { start: '22:00', end: null })).toBe(false);
    expect(isWithinQuietHours('23:00', { start: null, end: '08:00' })).toBe(false);
  });
  it('evaluates a wrap window in local HH:MM', () => {
    const q = { start: '22:00', end: '08:00' };
    expect(isWithinQuietHours('23:00', q)).toBe(true);
    expect(isWithinQuietHours('07:59', q)).toBe(true);
    expect(isWithinQuietHours('08:00', q)).toBe(false); // digest at quiet-end fires
    expect(isWithinQuietHours('12:00', q)).toBe(false);
  });
  it('treats a malformed stored value as off (defensive)', () => {
    expect(isWithinQuietHours('23:00', { start: '25:00', end: '08:00' })).toBe(false);
  });
});
