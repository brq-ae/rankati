// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Clock from '../src/Clock';
import { formatInZone, offsetLabel, serverSkewMs } from '../src/clock';

/**
 * The diagnostic clock.
 *
 * Every instant here is a literal. Nothing asks the wall clock what time it is — a test
 * that did would pass at 09:00 and fail at midnight, and would prove nothing about the
 * formatting either way.
 *
 * The zone assertions are the point of the whole readout: this box runs UTC, so a test that
 * only checked `formatInZone(instant, 'UTC')` would pass whether the zone argument were
 * honoured or ignored. Every case below pins a zone whose answer DIFFERS from UTC's.
 */

// 05:41:25 UTC — the same instant is 09:41:25 in Dubai, which is the gap the readout exists
// to show, and the exact one ADR 0052 is about.
const INSTANT = Date.parse('2026-07-17T05:41:25.000Z');

afterEach(cleanup);

describe('serverSkewMs', () => {
  it('measures how far ahead the server is', () => {
    const header = 'Fri, 17 Jul 2026 05:41:30 GMT'; // 5s ahead of our 05:41:25
    expect(serverSkewMs(header, INSTANT)).toBe(5_000);
  });

  it('measures a server that is behind', () => {
    expect(serverSkewMs('Fri, 17 Jul 2026 05:41:23 GMT', INSTANT)).toBe(-2_000);
  });

  it('is zero for clocks in step', () => {
    expect(serverSkewMs('Fri, 17 Jul 2026 05:41:25 GMT', INSTANT)).toBe(0);
  });

  it('says "unknown" rather than guessing zero', () => {
    // A missing or broken header must not render a plausible wrong time. null is honest;
    // 0 would silently claim the clocks agree.
    expect(serverSkewMs(null, INSTANT)).toBeNull();
    expect(serverSkewMs('not a date', INSTANT)).toBeNull();
    expect(serverSkewMs('', INSTANT)).toBeNull();
  });
});

describe('formatInZone', () => {
  it('honours the zone it is given — the same instant, different wall clocks', () => {
    // If the zone argument were ignored, these would all read 05:41:25 on this UTC box.
    expect(formatInZone(INSTANT, 'UTC')).toBe('05:41:25');
    expect(formatInZone(INSTANT, 'Asia/Dubai')).toBe('09:41:25'); // +04
    expect(formatInZone(INSTANT, 'America/New_York')).toBe('01:41:25'); // -04
  });

  it('uses a 24-hour clock, so 13:00 is not "1:00"', () => {
    const afternoon = Date.parse('2026-07-17T13:05:09.000Z');
    expect(formatInZone(afternoon, 'UTC')).toBe('13:05:09');
  });

  it('pads to two digits', () => {
    expect(formatInZone(Date.parse('2026-07-17T04:05:06.000Z'), 'UTC')).toBe('04:05:06');
  });

  it('rolls the wall clock past midnight in zones ahead of UTC', () => {
    // 22:00 UTC is 02:00 the NEXT DAY in Dubai — the same rollover that makes the gate's
    // client-supplied date necessary (0052).
    expect(formatInZone(Date.parse('2026-07-17T22:00:00.000Z'), 'Asia/Dubai')).toBe('02:00:00');
  });
});

describe('offsetLabel', () => {
  it('names the offset of the zone it is given', () => {
    // 'GMT+0', not 'GMT' — checked against what Intl actually returns rather than what
    // reads nicely. The test was wrong here first, not the code.
    expect(offsetLabel(INSTANT, 'UTC')).toBe('GMT+0');
    expect(offsetLabel(INSTANT, 'Asia/Dubai')).toBe('GMT+4');
    expect(offsetLabel(INSTANT, 'America/New_York')).toBe('GMT-4');
  });

  it('reads the offset AT the instant, because zones change theirs', () => {
    // New York is -05 in January and -04 in July. An offset computed once and cached would
    // be wrong for half the year.
    const january = Date.parse('2026-01-17T05:41:25.000Z');
    expect(offsetLabel(january, 'America/New_York')).toBe('GMT-5');
    expect(offsetLabel(INSTANT, 'America/New_York')).toBe('GMT-4');
  });
});

describe('<Clock />', () => {
  function stubHealth(dateHeader: string | null) {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          headers: { get: (k: string) => (k.toLowerCase() === 'date' ? dateHeader : null) },
          json: () => Promise.resolve({ status: 'ok' }),
        } as unknown as Response),
      ),
    );
  }
  afterEach(() => vi.unstubAllGlobals());

  it('shows both clocks, labelled', async () => {
    stubHealth('Fri, 17 Jul 2026 05:41:25 GMT');
    render(<Clock />);
    expect(await screen.findByText(/Local/)).toBeTruthy();
    expect(screen.getByText(/Server/)).toBeTruthy();
  });

  it('reads the server time from the Date header — no endpoint of its own', async () => {
    stubHealth('Fri, 17 Jul 2026 05:41:25 GMT');
    render(<Clock />);
    await screen.findByText(/UTC/);
    // One request, to a route that already exists.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/health');
  });

  it('says "unknown" when the server does not tell us, rather than inventing a time', async () => {
    stubHealth(null);
    render(<Clock />);
    expect(await screen.findByText(/unknown/)).toBeTruthy();
  });

  it('survives a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    render(<Clock />);
    // A diagnostic readout must never take the app down with it.
    expect(await screen.findByText(/unknown/)).toBeTruthy();
    expect(screen.getByText(/Local/)).toBeTruthy();
  });
});
