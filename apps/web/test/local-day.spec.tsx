// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { isGated, localDay, localTime } from '../src/local-day';

/**
 * The client's half of the gate contract (ADR 0052).
 *
 * The zone sweep is the whole point. This box runs UTC, so a test that only checked
 * `localDay(someInstant) === '2026-07-20'` would pass identically whether the function used
 * local getters or `toISOString()` — it would prove the box is UTC, not that the code is
 * right. The instants below are chosen to land on DIFFERENT CALENDAR DAYS depending on the
 * zone, so a UTC-based implementation fails at least one.
 */

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('localDay', () => {
  it('the zone sweep actually moves the clock', () => {
    // Guards the guard: if runtime TZ mutation did nothing, every case below would run in
    // one zone and the sweep would be theatre.
    const offsets = new Set<number>();
    for (const tz of ['UTC', 'Asia/Dubai', 'America/New_York']) {
      process.env.TZ = tz;
      offsets.add(new Date().getTimezoneOffset());
    }
    expect(offsets.size).toBe(3);
  });

  it('reports the day it is HERE, not in UTC', () => {
    // 22:00 UTC on the 20th is already the 21st in Dubai (+04) and still the 20th in New
    // York (-04). One instant, three answers — which is exactly why the client must send it.
    const instant = new Date('2026-07-20T22:00:00.000Z');

    process.env.TZ = 'UTC';
    expect(localDay(instant)).toBe('2026-07-20');

    process.env.TZ = 'Asia/Dubai';
    expect(localDay(instant)).toBe('2026-07-21'); // toISOString() would say the 20th

    process.env.TZ = 'America/New_York';
    expect(localDay(instant)).toBe('2026-07-20');
  });

  it('reports yesterday when UTC has already rolled over', () => {
    // 02:00 UTC on the 20th is still the 19th in New York. A UTC-based implementation would
    // hide a task gated until the 19th for five hours of its own evening.
    const instant = new Date('2026-07-20T02:00:00.000Z');
    process.env.TZ = 'America/New_York';
    expect(localDay(instant)).toBe('2026-07-19');
  });

  it('pads months and days to two digits', () => {
    process.env.TZ = 'UTC';
    // '2026-1-5' would be rejected by the server's strict parser — a gate must not accept a
    // date whose meaning is negotiable.
    expect(localDay(new Date('2026-01-05T12:00:00.000Z'))).toBe('2026-01-05');
  });

  it('handles the year boundary', () => {
    const newYearEveUtc = new Date('2026-12-31T21:00:00.000Z');
    process.env.TZ = 'Asia/Dubai'; // +04 -> already next year
    expect(localDay(newYearEveUtc)).toBe('2027-01-01');
    process.env.TZ = 'UTC';
    expect(localDay(newYearEveUtc)).toBe('2026-12-31');
  });
});

describe('localTime', () => {
  it('zero-pads to HH:MM — the only form the server accepts (0070)', () => {
    process.env.TZ = 'UTC';
    // 9:05 — both halves single-digit. '9:5' would be refused by the server's strict
    // parser, and as a string it compares AFTER '14:00', so padding is correctness.
    expect(localTime(new Date('2026-07-20T09:05:00.000Z'))).toBe('09:05');
  });

  it('reports the time it is HERE, not in UTC', () => {
    // 22:30 UTC is 02:30 the next morning in Dubai. A UTC-based implementation would tell
    // the server it is evening when the user's working hours have not begun — the window
    // gate judged against somebody else's clock (0070's version of 0052's bug).
    const instant = new Date('2026-07-20T22:30:00.000Z');
    process.env.TZ = 'UTC';
    expect(localTime(instant)).toBe('22:30');
    process.env.TZ = 'Asia/Dubai';
    expect(localTime(instant)).toBe('02:30');
  });

  it('is a 24-hour clock, so 13:00 is not "1:00"', () => {
    process.env.TZ = 'UTC';
    // The working-hours boundary is '14:00'; a 12-hour "2:00" would compare before '08:00'.
    expect(localTime(new Date('2026-07-20T13:59:00.000Z'))).toBe('13:59');
  });
});

describe('isGated', () => {
  it('is shut only while the day is still ahead', () => {
    expect(isGated('2026-07-21', '2026-07-20')).toBe(true); // tomorrow
    expect(isGated('2026-07-20', '2026-07-20')).toBe(false); // today: the gate has opened
    expect(isGated('2026-07-19', '2026-07-20')).toBe(false); // past
    expect(isGated(null, '2026-07-20')).toBe(false); // ungated
  });

  it('compares dates, not strings that merely look sorted', () => {
    // Across a month and a year boundary, where naive comparison most plausibly breaks.
    expect(isGated('2026-08-01', '2026-07-31')).toBe(true);
    expect(isGated('2027-01-01', '2026-12-31')).toBe(true);
    expect(isGated('2026-07-31', '2026-08-01')).toBe(false);
    expect(isGated('2026-12-31', '2027-01-01')).toBe(false);
  });
});
