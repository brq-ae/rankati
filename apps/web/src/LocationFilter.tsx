import type { Location } from '@rankati/shared';
import { EVERYWHERE } from './location-filter';

/**
 * The header context-filter (ADR 0060): a pin toggle to the LEFT of a location dropdown.
 *
 * The pin is filled and amber when persistence is on, hollow and muted when off; the dropdown
 * wears the SAME amber ring when pinned, so active persistence is unmissable — the visible
 * announcement that stops a remembered filter from becoming a lying view. Changing the place
 * while pinned keeps the pin ("keep my context", not one place); that logic lives in App.
 */
export default function LocationFilter({
  locations,
  value,
  pinned,
  onChange,
  onTogglePin,
}: {
  locations: Location[];
  value: string;
  pinned: boolean;
  onChange: (value: string) => void;
  onTogglePin: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={onTogglePin}
        aria-pressed={pinned}
        aria-label={pinned ? 'Unpin location (reset to Everywhere next time)' : 'Pin location (remember across sessions)'}
        title={pinned ? 'Pinned — this context is remembered across sessions' : 'Not pinned — resets to Everywhere'}
        className={`touch-manipulation rounded-sm p-1.5 ring-1 transition-colors ${
          pinned
            ? 'text-pin ring-pin-edge'
            : 'text-faint ring-divider hover:text-body'
        }`}
      >
        {/* A push-pin: filled when pinned, outline when not. */}
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"
          fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 17v5" />
          <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z" />
        </svg>
      </button>

      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Filter tasks by location"
        className={`touch-manipulation rounded-xl bg-card px-2 py-1.5 text-sm ring-1 ${
          pinned
            ? 'ring-2 ring-pin-edge text-pin-label'
            : 'ring-divider text-strong-hover'
        }`}
      >
        <option value={EVERYWHERE}>Everywhere</option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  );
}
