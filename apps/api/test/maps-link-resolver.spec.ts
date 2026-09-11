import { describe, expect, it } from 'vitest';
import { extractVenue, isAllowedHost, isBlockedIp, resolveVenue } from '../src/maps-link-resolver';

/**
 * The SSRF-hardened Venue resolver (ADR 0096). Outbound HTTP + DNS are MOCKED — these tests never touch the
 * real network or Google. The point of every case is a safety property, not a happy path.
 */
type Resp = { status: number; location?: string };
const resp = (r: Resp) =>
  ({
    status: r.status,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? (r.location ?? null) : null) },
    body: { cancel: () => {} },
  }) as unknown as Response;

/** A fetch mock that serves scripted responses by URL and records every URL it was asked to fetch. */
function scriptedFetch(script: Record<string, Resp>) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const hit = script[url];
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    return resp(hit);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const publicLookup = async () => [{ address: '142.250.72.14' }];

describe('resolveVenue — SSRF hardening (mocked network)', () => {
  it('rejects a non-Google host with NO fetch at all', async () => {
    const { fetchFn, calls } = scriptedFetch({});
    const out = await resolveVenue('https://evil.example.com/maps?q=1,2', { fetchFn, lookupFn: publicLookup });
    expect(out).toEqual({});
    expect(calls).toHaveLength(0); // rejected before any packet
  });

  it('rejects a look-alike suffix host (maps.google.com.evil.com) — exact match, not endsWith', async () => {
    const { fetchFn, calls } = scriptedFetch({});
    const out = await resolveVenue('https://maps.google.com.evil.com/@1,2', { fetchFn, lookupFn: publicLookup });
    expect(out).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('extracts coords from a direct maps.google.com URL', async () => {
    const url = 'https://maps.google.com/maps/place/Cafe/@37.42,-122.08,17z';
    const { fetchFn } = scriptedFetch({ [url]: { status: 200 } });
    const out = await resolveVenue(url, { fetchFn, lookupFn: publicLookup });
    expect(out).toEqual({ lat: 37.42, lng: -122.08, name: 'Cafe' });
  });

  it('follows a Google REGIONAL-TLD redirect (the "go" chain) and extracts its coords', async () => {
    // The real bug (ADR 0096 S4): maps.app.goo.gl 302s to www.google.ae — a regional TLD the US-only
    // allowlist rejected, so Waze went missing. The anchored regional-family match now accepts it.
    const short = 'https://maps.app.goo.gl/L8vqhQLyNC5BkU7R8';
    const regional =
      'https://www.google.ae/maps/place/Travelex/@25.2381438,55.3917989,5668m/data=!3m1!1e3!4m6!3m5!1s0x0:0x0!8m2!3d25.2391308!4d55.3874267!16s%2Fg%2F11lz4b3pvx';
    const { fetchFn, calls } = scriptedFetch({
      [short]: { status: 302, location: regional },
      [regional]: { status: 200 },
    });
    const out = await resolveVenue(short, { fetchFn, lookupFn: publicLookup });
    // !3d!4d wins over @lat,lng — the precise place pin, not the viewport centre.
    expect(out).toEqual({ lat: 25.2391308, lng: 55.3874267, name: 'Travelex' });
    expect(calls).toEqual([short, regional]); // the www.google.ae hop is now fetched, not aborted
  });

  it('follows a Google short-link redirect and extracts coords + name', async () => {
    const short = 'https://maps.app.goo.gl/abc123';
    const full = 'https://www.google.com/maps/place/Blue+Bottle/@37.5,-122.1,17z';
    const { fetchFn, calls } = scriptedFetch({
      [short]: { status: 302, location: full },
      [full]: { status: 200 },
    });
    const out = await resolveVenue(short, { fetchFn, lookupFn: publicLookup });
    expect(out).toEqual({ lat: 37.5, lng: -122.1, name: 'Blue Bottle' });
    expect(calls).toEqual([short, full]); // both Google hops fetched
  });

  it('ABORTS when a redirect points off-Google — never fetches the off-Google host', async () => {
    const short = 'https://goo.gl/x';
    const { fetchFn, calls } = scriptedFetch({ [short]: { status: 302, location: 'https://169.254.169.254/latest/meta-data/' } });
    const out = await resolveVenue(short, { fetchFn, lookupFn: publicLookup });
    expect(out).toEqual({});
    expect(calls).toEqual([short]); // the off-Google hop was rejected BEFORE fetching it
  });

  it('blocks a Google host that resolves to a private/metadata IP (no fetch)', async () => {
    const url = 'https://maps.google.com/maps/@1,2';
    const { fetchFn, calls } = scriptedFetch({ [url]: { status: 200 } });
    const metadataLookup = async () => [{ address: '169.254.169.254' }];
    const out = await resolveVenue(url, { fetchFn, lookupFn: metadataLookup });
    expect(out).toEqual({});
    expect(calls).toHaveLength(0); // blocked at the IP check, before the packet
  });

  it('no coords → returns the place-name only (Waze search fallback)', async () => {
    const url = 'https://www.google.com/maps/place/Some+Venue+Hall/';
    const { fetchFn } = scriptedFetch({ [url]: { status: 200 } });
    const out = await resolveVenue(url, { fetchFn, lookupFn: publicLookup });
    expect(out).toEqual({ name: 'Some Venue Hall' }); // no lat/lng
  });

  it('gives up after too many redirect hops', async () => {
    const hop = (n: number) => `https://maps.google.com/r/${n}`;
    const script: Record<string, Resp> = {};
    for (let i = 0; i < 8; i++) script[hop(i)] = { status: 302, location: hop(i + 1) };
    const { fetchFn } = scriptedFetch(script);
    const out = await resolveVenue(hop(0), { fetchFn, lookupFn: publicLookup });
    expect(out).toEqual({}); // hop cap → give up, no coords
  });

  it('a non-http(s) scheme is rejected outright', async () => {
    const { fetchFn, calls } = scriptedFetch({});
    expect(await resolveVenue('file:///etc/passwd', { fetchFn, lookupFn: publicLookup })).toEqual({});
    expect(await resolveVenue('not a url', { fetchFn, lookupFn: publicLookup })).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe('isBlockedIp', () => {
  it('blocks private/loopback/link-local/CGNAT/metadata, allows public', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1'])
      expect(isBlockedIp(ip)).toBe(true);
    for (const ip of ['142.250.72.14', '8.8.8.8', '2607:f8b0::1'])
      expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('isAllowedHost — anchored allowlist (goo.gl + Google regional family)', () => {
  it('ACCEPTS the goo.gl shorteners and the Google regional-TLD family', () => {
    for (const h of [
      'maps.app.goo.gl',
      'goo.gl',
      'google.com',
      'www.google.com',
      'maps.google.com',
      'google.ae',
      'www.google.ae', // the "go" chain host
      'maps.google.co.uk',
      'google.com.au',
      'GOOGLE.AE', // case-insensitive
    ])
      expect(isAllowedHost(h)).toBe(true);
  });

  it('REJECTS look-alikes — leading text, trailing labels, and non-Google hosts (exact, not suffix)', () => {
    for (const h of [
      'google.ae.evil.com', // trailing labels after the TLD
      'google.com.evil.com',
      'maps.google.com.evil.com', // the classic suffix-defeat
      'evilgoogle.ae', // leading text glued to google
      'notgoogle.com',
      'google.evil.com',
      'agoogle.com',
      'goo.gl.evil.com',
      'evil.com',
      'consent.google.com', // a real Google host, but not one we follow (consent interstitial, no coords)
    ])
      expect(isAllowedHost(h)).toBe(false);
  });
});

describe('extractVenue', () => {
  it('reads !3d!4d, @lat,lng, and ?q=lat,lng; rejects out-of-range', () => {
    expect(extractVenue(new URL('https://x/maps/place/A/data=!3d51.5!4d-0.12'))).toMatchObject({ lat: 51.5, lng: -0.12 });
    expect(extractVenue(new URL('https://x/@1.1,2.2,17z'))).toMatchObject({ lat: 1.1, lng: 2.2 });
    expect(extractVenue(new URL('https://x/maps?q=40.7,-74.0'))).toMatchObject({ lat: 40.7, lng: -74.0 });
    expect(extractVenue(new URL('https://x/@200,999'))).toEqual({}); // out of range → dropped
  });
});
