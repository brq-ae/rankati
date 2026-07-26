import { useCallback, useEffect, useState } from 'react';

/**
 * The THEME axis — the palette (ADR 0062), attribute-driven and defaulting to brand.
 *
 * Independent of the MODE axis (light/dark, see mode.ts): a theme sets `data-theme` on <html>, a
 * mode sets `.dark`, and the 4 themes × 2 modes = 8 combinations are all reachable. A theme only
 * re-points palette tokens; meaning tokens (tier heat, overdue…) stay fixed across themes (0062).
 *
 * `slate` IS the base layer, so its `data-theme="slate"` matches no CSS block and the base shows
 * through — that is intentional, not a missing block (0062 Step C).
 */

export type Theme = 'slate' | 'brand' | 'warm' | 'clear';

/** The picker's order; brand (the default) leads. */
export const THEMES: readonly Theme[] = ['brand', 'slate', 'warm', 'clear'];

/** Human labels for the picker and any UI — distinct from the slug used in `data-theme`. */
export const THEME_LABELS: Record<Theme, string> = {
  brand: 'Brand',
  slate: 'Slate',
  warm: 'Warm',
  clear: 'Clear',
};

/** Nothing stored → brand. Also the landing spot for an invalid stored value (below). */
export const DEFAULT_THEME: Theme = 'brand';

/**
 * DUPLICATED in index.html's inline script, which cannot import this (it runs before any module).
 * The key, the valid set, and the default all live in both places; the anti-flash spec's drift
 * guard fails if they diverge (ADR 0062).
 */
export const PALETTE_KEY = 'deck.palette';

const isTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme);

/**
 * The stored theme, or brand. A value that is not one of the four — a stale name from a downgrade,
 * a typo, anything — resolves to the DEFAULT rather than being applied, so the app can never render
 * with an unknown (untokenised) `data-theme` (0062's fallback decision). Missing is just one case
 * of invalid; a wrong-but-present value is the one that actually needs guarding.
 */
export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(PALETTE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    // Storage can throw in private modes. A theme is not worth a crash.
    return DEFAULT_THEME;
  }
}

/** The single place `data-theme` is written. Always one of the four — never a raw stored value. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(PALETTE_KEY, theme);
  } catch {
    // Unstorable: the choice still applies for this session, it just will not be remembered.
  }
}

/**
 * Reads the theme the inline script already applied, rather than deciding again — the two must
 * not race. Writing to storage happens on change only.
 */
export function usePalette(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  // Re-asserts what the inline script did; a no-op on first paint, so the attribute follows
  // `theme` on every later change.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    storeTheme(next);
    setThemeState(next);
  }, []);

  return { theme, setTheme };
}
