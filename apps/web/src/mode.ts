import { useCallback, useEffect, useState } from 'react';

/**
 * Light/dark — the MODE axis, class-driven and defaulting to dark (ADR 0051).
 *
 * "Mode" (light/dark), not "theme": since ADR 0062 a THEME is the palette (slate/brand/warm/clear,
 * see palette.ts) and the two are independent axes. This file was `theme.ts` before v0.10; it was
 * renamed so the code stops calling light/dark a "theme" where the docs call the palette that.
 *
 * The class lives on <html> — one element above every screen — so "applies app-wide" is
 * structural rather than something each new component has to remember.
 */

export type Mode = 'light' | 'dark';

/**
 * DUPLICATED in index.html's inline script, which must run before any module loads and so
 * cannot import this. If you change the key, change it there too — the anti-flash spec's drift
 * guard fails if they diverge (ADR 0055, 0062).
 */
export const MODE_KEY = 'deck.theme';

/** Dark unless light was explicitly chosen. The OS preference is never consulted (0051). */
export function readStoredMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    // Storage can throw in private modes. A mode is not worth a crash.
    return 'dark';
  }
}

/** The single place the DOM is touched, so the class and color-scheme cannot disagree. */
export function applyMode(mode: Mode): void {
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  root.style.colorScheme = mode;
}

function storeMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Unstorable: the toggle still works for this session, it just will not be remembered.
  }
}

/**
 * Reads the mode the inline script already applied, rather than deciding again — the two
 * must not race. Writing to storage happens on change only.
 */
export function useMode(): { mode: Mode; toggle: () => void } {
  const [mode, setMode] = useState<Mode>(readStoredMode);

  // Re-asserts what the inline script did. A no-op on first paint, which is the point:
  // this exists so the class follows `mode` on every later change.
  useEffect(() => {
    applyMode(mode);
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((current) => {
      const next: Mode = current === 'dark' ? 'light' : 'dark';
      storeMode(next);
      return next;
    });
  }, []);

  return { mode, toggle };
}
