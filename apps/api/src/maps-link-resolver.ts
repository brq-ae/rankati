import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Server-side Google-Maps link resolver (ADR 0096, Venue). The browser can't read a cross-origin redirect
 * (CORS), so the api expands a pasted Maps link to coordinates for the Waze button. The pasted link itself
 * always drives the G-Maps button with NO server call; this resolver is ONLY for extracting coords/name.
 *
 * SSRF hardening (the input is hostile by assumption — multi-tenant SaaS posture):
 *  - EXACT host allowlist, re-checked at EVERY redirect hop, BEFORE any packet. Two shapes, both anchored,
 *    never a `endsWith`/suffix test (which `maps.google.com.evil.com` defeats): the goo.gl shorteners are
 *    exact Set members, and the Google host is an ANCHORED regex over Google's regional-TLD family
 *    (`^(www\.|maps\.)?google\.(com|<cc>|co.<cc>|com.<cc>)$`) — so `www.google.ae` / `maps.google.co.uk`
 *    resolve, while `google.ae.evil.com` / `evilgoogle.ae` / `notgoogle.com` are rejected.
 *  - Per-hop DNS resolution with a private/loopback/link-local/CGNAT/metadata IP block.
 *  - Manual redirect following, capped; a short per-hop timeout.
 *  - Returns coords/name ONLY — NEVER the fetched content (no proxy/oracle). Any failure → {} (best-effort;
 *    the caller still stores the pasted URL, so G-Maps always works and Waze just falls back or hides).
 *
 * Residual (ADR 0096): a DNS rebind between the lookup-check and the connect (TOCTOU) is not closed by
 * lookup-checking alone — but we only ever connect to Google-owned hostnames (the allowlist), which an
 * attacker can't rebind. The true multi-tenant answer is Google's official Geocoding API (fixed endpoint,
 * no user-redirect-following → zero SSRF surface); noted as the SaaS switch. (That switch is also the only
 * answer for an EU consent-gated link, which redirect-following can never resolve — it lands on the
 * consent interstitial, not the coords behind it.)
 */
const ALLOWED_EXACT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl']);
/**
 * Google's host family, ANCHORED and exact — NOT a suffix match. Optional `www.`/`maps.` prefix, then
 * `google.` and a constrained TLD tail: `com`, any 2-letter ccTLD (e.g. `ae`, `uk`), `co.<cc>` (`co.uk`),
 * or `com.<cc>` (`com.au`). The `^…$` anchors mean an extra label on either side fails — `google.ae.evil.com`
 * (trailing labels), `evilgoogle.ae` / `notgoogle.com` (leading text before `google.`) are all rejected.
 * `[a-z]{2}` admits any 2-letter TLD rather than an exhaustive ccTLD list: still anchored/exact, and even a
 * hypothetical non-Google `google.<xx>` stays bounded by the per-hop DNS private-IP block + body-not-read +
 * coords-or-null, so it can never become an internal-SSRF or a content oracle (ADR 0096).
 */
const GOOGLE_HOST_RE = /^(www\.|maps\.)?google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const MAX_HOPS = 5;
const TIMEOUT_MS = 4000;

/** True iff `host` is one we are willing to fetch: a goo.gl shortener, or Google's anchored regional family. */
export function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED_EXACT_HOSTS.has(h) || GOOGLE_HOST_RE.test(h);
}

export interface VenueResolved {
  lat?: number;
  lng?: number;
  name?: string;
}

/** Injectable seams so tests never touch the real network or DNS. */
export interface ResolverDeps {
  fetchFn?: typeof fetch;
  lookupFn?: (host: string) => Promise<{ address: string }[]>;
}

/** True if an IP literal is one we must never connect to (private/loopback/link-local/CGNAT/metadata/etc.). */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number); // isIP already guaranteed 4 octets; defaults satisfy tsc
    if (a === 0 || a === 127) return true; // unspecified / loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  if (kind === 6) {
    const lc = ip.toLowerCase();
    if (lc === '::' || lc === '::1') return true; // unspecified / loopback
    if (lc.startsWith('fe80')) return true; // link-local
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true; // unique-local
    const mapped = lc.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/); // IPv4-mapped
    if (mapped) return isBlockedIp(mapped[1]!);
    return false;
  }
  return true; // not a valid IP → block
}

async function hostConnectsSafely(host: string, lookupFn: NonNullable<ResolverDeps['lookupFn']>): Promise<boolean> {
  if (isIP(host)) return !isBlockedIp(host); // a raw IP literal in the URL
  let addrs: { address: string }[];
  try {
    addrs = await lookupFn(host);
  } catch {
    return false;
  }
  return addrs.length > 0 && addrs.every((a) => !isBlockedIp(a.address));
}

const parseCoord = (s: string | undefined, min: number, max: number): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

/** Pull coords + place-name out of a RESOLVED Google-Maps URL (never from response content). */
export function extractVenue(url: URL): VenueResolved {
  const href = url.href;
  const out: VenueResolved = {};

  // Coordinate forms, most specific first: !3dLAT!4dLNG, @lat,lng, ?q/query/ll = lat,lng.
  let lat: number | undefined;
  let lng: number | undefined;
  const bang = href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  const at = href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const qParam = url.searchParams.get('q') ?? url.searchParams.get('query') ?? url.searchParams.get('ll');
  const qPair = qParam?.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (bang) {
    lat = parseCoord(bang[1], -90, 90);
    lng = parseCoord(bang[2], -180, 180);
  } else if (at) {
    lat = parseCoord(at[1], -90, 90);
    lng = parseCoord(at[2], -180, 180);
  } else if (qPair) {
    lat = parseCoord(qPair[1], -90, 90);
    lng = parseCoord(qPair[2], -180, 180);
  }
  if (lat !== undefined && lng !== undefined) {
    out.lat = lat;
    out.lng = lng;
  }

  // Place name for the Waze search fallback: /place/<name>/…
  const place = url.pathname.match(/\/place\/([^/]+)/);
  if (place?.[1]) {
    const name = decodeURIComponent(place[1].replace(/\+/g, ' ')).trim();
    if (name && !/^@?-?\d/.test(name)) out.name = name; // ignore a coord-looking "name"
  }
  return out;
}

/**
 * Expand a pasted Google-Maps link and return { lat?, lng?, name? } — coords-or-empty. Best-effort: ANY
 * failure (bad URL, disallowed host, blocked IP, timeout, too many hops, non-coord result) returns {}.
 */
export async function resolveVenue(rawUrl: string, deps: ResolverDeps = {}): Promise<VenueResolved> {
  const fetchFn = deps.fetchFn ?? fetch;
  const lookupFn = deps.lookupFn ?? ((h: string) => lookup(h, { all: true }));

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return {};
  }

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') return {};
    if (!isAllowedHost(current.hostname)) return {}; // anchored host allowlist (goo.gl + Google family), every hop
    if (!(await hostConnectsSafely(current.hostname, lookupFn))) return {}; // private-IP block, every hop

    let res: Response;
    try {
      res = await fetchFn(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'Rankati-VenueResolver/1.0', accept: 'text/html' },
      });
    } catch {
      return {};
    }
    // Never read the body — the resolved URL carries the coords; not reading it means no content oracle.
    void res.body?.cancel?.();

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return extractVenue(current); // a 3xx with no Location → treat this URL as final
      try {
        current = new URL(loc, current); // resolve relative Locations against the current URL
      } catch {
        return {};
      }
      continue; // re-validate the new host at the top of the loop
    }
    return extractVenue(current); // 2xx / final
  }
  return {}; // hop cap exceeded
}
