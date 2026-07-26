import type { Mode } from './mode';

interface ThemeToggleProps {
  mode: Mode;
  onToggle: () => void;
}

/**
 * The MODE toggle (light/dark) — one button, not a three-way with "system" (ADR 0051: the OS
 * preference is never consulted, so a "system" option would be a lie). The palette is a separate
 * control (the theme picker in Settings, ADR 0062).
 *
 * The label says what pressing it DOES, not what the state is — "Switch to light" is
 * unambiguous where a sun icon alone is a coin flip.
 */
export default function ThemeToggle({ mode, onToggle }: ThemeToggleProps) {
  const next = mode === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="touch-manipulation rounded-sm px-3 py-2 text-sm font-medium text-body ring-1 ring-field hover:bg-hover"
    >
      <span aria-hidden="true">{mode === 'dark' ? '☀' : '☾'}</span>
      <span className="sr-only">{`Switch to ${next} theme`}</span>
    </button>
  );
}
