import type { Mode } from './mode';
import { THEMES, THEME_LABELS, type Theme } from './palette';

interface ThemePickerProps {
  /** The active theme (the palette axis, ADR 0062). */
  theme: Theme;
  /** The active mode, so each swatch can preview its theme in light OR dark. */
  mode: Mode;
  onSelect: (theme: Theme) => void;
}

/**
 * The theme picker — a button group, one pressed at a time, matching the tier picker's idiom
 * (ADR 0056): colour is the affordance but never the only signal, so each button carries its
 * name in text and aria-label, and the active one is aria-pressed.
 */
export default function ThemePicker({ theme, mode, onSelect }: ThemePickerProps) {
  return (
    <div role="group" aria-label="Theme" className="flex flex-wrap gap-2">
      {THEMES.map((t) => {
        const current = t === theme;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onSelect(t)}
            aria-pressed={current}
            aria-label={`Theme: ${THEME_LABELS[t]}`}
            className={`flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium ring-1 transition ${
              current ? 'text-fg ring-primary' : 'text-body ring-field hover:bg-hover'
            }`}
          >
            {/* A live preview of the theme in the CURRENT mode — the tokens themselves, never a
                copied hex (so it can't drift from the CSS). `data-theme` re-points the palette for
                this swatch's subtree; in dark mode it also carries `.dark` so the theme's
                `[data-theme=…].dark` block matches it (ADR 0062). */}
            <span
              data-theme={t}
              className={`${mode === 'dark' ? 'dark ' : ''}flex size-4 items-center justify-center rounded-full border border-edge bg-canvas`}
              aria-hidden="true"
            >
              <span className="size-2 rounded-full bg-primary" />
            </span>
            {THEME_LABELS[t]}
          </button>
        );
      })}
    </div>
  );
}
