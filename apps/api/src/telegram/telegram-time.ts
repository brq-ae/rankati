/**
 * Local-time helpers for the Telegram scheduler (ADR 0084/0091). Pure, no I/O — a neutral module so the
 * digest tick and the nag pass/handlers can share `localNow` without a circular import.
 */

/** The local date + minute-of-day of a moment in an IANA timezone (DST handled by Intl). */
export function localNow(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const g: Record<string, string> = {};
  for (const p of parts) g[p.type] = p.value;
  const hour = g.hour === '24' ? 0 : Number(g.hour); // hour12:false can render midnight as "24"
  return { date: `${g.year}-${g.month}-${g.day}`, minutes: hour * 60 + Number(g.minute) };
}
