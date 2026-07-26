import { useEffect, useState } from 'react';
import { fetchServerSkewMs, formatInZone, localZone, offsetLabel } from './clock';

/**
 * A diagnostic readout, not a feature: small, muted, in the footer of every screen.
 *
 * It shows the gap that ADR 0052 is about — the server on UTC, you on something else — so
 * "the gate sends a client-supplied date" is a thing you can SEE rather than take on faith.
 * See clock.ts for what this is and is not precise about.
 */
export default function Clock() {
  // null = we have not asked yet, or the server did not tell us. It is never guessed at:
  // showing a plausible wrong time is worse than showing none.
  const [skewMs, setSkewMs] = useState<number | null>(null);
  const [asked, setAsked] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Once, at mount. The two clocks are NTP-synced; re-asking every second would be traffic
  // spent re-measuring a number that does not move.
  useEffect(() => {
    fetchServerSkewMs()
      .then(setSkewMs)
      .catch(() => setSkewMs(null))
      .finally(() => setAsked(true));
  }, []);

  // The tick is pure arithmetic on a number we already have — no request per second.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const zone = localZone();

  return (
    <footer className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-faint">
      <span>
        <span className="text-muted">Local</span>{' '}
        {formatInZone(nowMs, zone)} {offsetLabel(nowMs, zone)}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        <span className="text-muted">Server</span>{' '}
        {skewMs === null ? (asked ? 'unknown' : '…') : `${formatInZone(nowMs + skewMs, 'UTC')} UTC`}
      </span>
    </footer>
  );
}
