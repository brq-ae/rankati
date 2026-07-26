// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThemePicker from '../src/ThemePicker';
import { DEFAULT_THEME, PALETTE_KEY, applyTheme, readStoredTheme, usePalette } from '../src/palette';
import { MODE_KEY } from '../src/mode';

/**
 * The THEME axis's logic (the palette, ADR 0062). Like mode.spec, this proves the mechanism
 * (which attribute is applied, what is stored, how it falls back) — NOT that a theme looks right,
 * which happa-dom cannot compute and a human verifies.
 */

/** A host wiring the hook to the real picker — testing it the way it is used. */
function Harness() {
  const { theme, setTheme } = usePalette();
  return (
    <>
      <span data-testid="theme">{theme}</span>
      <ThemePicker theme={theme} mode="dark" onSelect={setTheme} />
    </>
  );
}

const dataTheme = () => document.documentElement.dataset.theme;

describe('theme (the palette axis)', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });
  afterEach(cleanup);

  describe('readStoredTheme falls back to the default — invalid, not just missing', () => {
    it('returns brand when nothing is stored (the default)', () => {
      expect(readStoredTheme()).toBe('brand');
      expect(DEFAULT_THEME).toBe('brand');
    });

    it('returns brand for an UNKNOWN stored value — the stale-name / typo case (0062)', () => {
      // The case that actually needs guarding: a present-but-wrong value from a downgrade or a
      // hand-edit. Missing-key is the easy path; this is the one 0062 specified.
      localStorage.setItem(PALETTE_KEY, 'nonsense');
      expect(readStoredTheme()).toBe('brand');
    });

    it('returns each valid theme unchanged', () => {
      for (const t of ['slate', 'brand', 'warm', 'clear'] as const) {
        localStorage.setItem(PALETTE_KEY, t);
        expect(readStoredTheme()).toBe(t);
      }
    });

    it('never crashes and defaults to brand when storage throws', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('SecurityError');
        },
      });
      expect(() => readStoredTheme()).not.toThrow();
      expect(readStoredTheme()).toBe('brand');
      vi.unstubAllGlobals();
    });
  });

  it('applyTheme writes data-theme on <html> (always a real theme, never a raw value)', () => {
    applyTheme('warm');
    expect(dataTheme()).toBe('warm');
  });

  it('an invalid stored theme renders the default, never the unknown value (0062)', () => {
    localStorage.setItem(PALETTE_KEY, 'nonsense');
    render(<Harness />);
    expect(screen.getByTestId('theme').textContent).toBe('brand');
    expect(dataTheme()).toBe('brand'); // not 'nonsense' — never untokenised
  });

  it('picks a theme: applies data-theme, persists, and marks it pressed', () => {
    render(<Harness />);
    expect(dataTheme()).toBe('brand'); // the default on mount

    fireEvent.click(screen.getByRole('button', { name: 'Theme: Warm' }));

    expect(screen.getByTestId('theme').textContent).toBe('warm');
    expect(dataTheme()).toBe('warm');
    expect(localStorage.getItem(PALETTE_KEY)).toBe('warm');
    expect(screen.getByRole('button', { name: 'Theme: Warm' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('remembers the theme across a reload', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme: Clear' }));
    cleanup();
    delete document.documentElement.dataset.theme;

    render(<Harness />); // a reload = fresh mount reading the same storage
    expect(screen.getByTestId('theme').textContent).toBe('clear');
    expect(dataTheme()).toBe('clear');
  });

  it('is INDEPENDENT of the mode axis — picking a theme never touches the mode key', () => {
    localStorage.setItem(MODE_KEY, 'light');
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme: Slate' }));

    expect(localStorage.getItem(PALETTE_KEY)).toBe('slate');
    expect(localStorage.getItem(MODE_KEY)).toBe('light'); // untouched
  });

  it('offers exactly the four themes', () => {
    render(<Harness />);
    for (const name of ['Brand', 'Slate', 'Warm', 'Clear']) {
      expect(screen.getByRole('button', { name: `Theme: ${name}` })).toBeTruthy();
    }
  });
});
