/**
 * The diagnostic clock: your time beside the server's, live.
 *
 * It exists to make v0.4's premise visible. The server runs UTC and you do not, so "is this
 * task's day here yet?" has two different answers depending on who is asked — which is why
 * the Today read refuses to guess and makes the client send its own day (ADR 0052). This
 * readout is that gap, on screen, instead of an argument in an ADR.
 *
 * TWO HONEST CAVEATS, because the readout looks more precise than it is:
 *
 * 1. The HTTP `Date` header is ALWAYS GMT by spec, so it tells us the server's INSTANT, not
 *    the server's timezone. That both boxes genuinely run UTC is a separate fact, verified
 *    by hand — do not read this display as evidence of it.
 * 2. That header has ONE-SECOND resolution, and network latency adds more. The skew here is
 *    good to roughly ±1s. It is a diagnostic, not a time source: nothing depends on it, and
 *    the gate never consults it.
 */

/**
 * How far ahead of us the server's clock is, in ms. `null` when unknowable — a header that
 * is missing or unparseable is reported as "we do not know", never silently as zero, which
 * would render a wrong time that looks perfectly plausible.
 */
export function serverSkewMs(dateHeader: string | null, clientNowMs: number): number | null {
  if (!dateHeader) return null;
  const serverMs = Date.parse(dateHeader);
  if (Number.isNaN(serverMs)) return null;
  return serverMs - clientNowMs;
}

/** Wall-clock time in a named zone. The zone is a PARAMETER so tests need no ambient TZ. */
export function formatInZone(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(instantMs));
}

/**
 * A zone's offset as the browser names it — 'GMT+4', 'GMT'.
 *
 * Taken from Intl at the given instant rather than computed, because an offset is not a
 * property of a zone: half the world's zones change theirs twice a year.
 */
export function offsetLabel(instantMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(instantMs));
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/** The browser's own zone, e.g. 'Asia/Dubai'. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Ask the server what time it is, using a header every response already carries.
 *
 * No endpoint, no dependency, no polling: one request at mount, then arithmetic. The
 * midpoint of send and receive is used as "our" time so the round trip is split rather than
 * charged entirely to one side.
 */
export async function fetchServerSkewMs(now: () => number = Date.now): Promise<number | null> {
  const before = now();
  const res = await fetch('/api/health');
  const after = now();
  return serverSkewMs(res.headers.get('date'), (before + after) / 2);
}
