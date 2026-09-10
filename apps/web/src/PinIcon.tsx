/**
 * A pin icon that actually reflects state (ADR 0095, S4). The 📌 emoji is a COLOR glyph — it ignores CSS
 * `color`, so `text-primary`/`text-faint` were a no-op and pinned looked identical to unpinned. An SVG driven
 * by `currentColor` fixes that: `filled` → solid accent (pinned); otherwise a thin outline (unpinned), and the
 * button's color class now shows through. Decorative (`aria-hidden`); the button carries the label/pressed state.
 */
export function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {/* A map-pin teardrop: solid when pinned, outline when not. */}
      <path d="M12 22s6.5-6 6.5-11.5a6.5 6.5 0 1 0-13 0C5.5 16 12 22 12 22z" />
      {!filled && <circle cx="12" cy="10.5" r="2.2" />}
    </svg>
  );
}
