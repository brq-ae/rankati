// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeToggle from '../src/ThemeToggle';
import { MODE_KEY, readStoredMode, useMode } from '../src/mode';

/**
 * The MODE axis's logic (light/dark, ADR 0051). Deliberately small.
 *
 * WHAT THIS CANNOT DO: happy-dom does not compile or compute Tailwind, so nothing here
 * proves the app *looks* dark — only that the class which drives it is applied. That the
 * `dark:` variant compiles to a `.dark` selector at all is proven separately against the
 * built CSS; that it looks right is proven by a human. Both are stated so a green run here
 * is not mistaken for "dark mode works".
 */

/** A host for the hook — testing it through a component is testing how it is used. */
function Harness() {
  const { mode, toggle } = useMode();
  return (
    <>
      <span data-testid="mode">{mode}</span>
      <ThemeToggle mode={mode} onToggle={toggle} />
    </>
  );
}

const htmlIsDark = () => document.documentElement.classList.contains('dark');

describe('mode (light/dark)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.style.colorScheme = '';
  });
  afterEach(cleanup);

  it('defaults to dark when nothing has been chosen', () => {
    expect(readStoredMode()).toBe('dark');
    render(<Harness />);
    expect(screen.getByTestId('mode').textContent).toBe('dark');
    expect(htmlIsDark()).toBe(true);
  });

  it('never consults the OS preference (0051)', () => {
    // 0051 says prefers-color-scheme is ignored ENTIRELY. Asserting "still dark" would not
    // prove that — the default is dark anyway, so such a test passes whether the OS is read
    // or not. The claim is only testable by watching the one API that could read it.
    const matchMedia = vi.fn().mockReturnValue({
      matches: true, // as if the OS were asking for something
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('matchMedia', matchMedia);

    render(<Harness />);

    expect(matchMedia).not.toHaveBeenCalled();
    expect(screen.getByTestId('mode').textContent).toBe('dark');
    vi.unstubAllGlobals();
  });

  it('honours a stored choice of light', () => {
    localStorage.setItem(MODE_KEY, 'light');
    render(<Harness />);
    expect(screen.getByTestId('mode').textContent).toBe('light');
    expect(htmlIsDark()).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('toggles, and writes the choice to storage', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /switch to light theme/i }));

    expect(screen.getByTestId('mode').textContent).toBe('light');
    expect(htmlIsDark()).toBe(false);
    expect(localStorage.getItem(MODE_KEY)).toBe('light');
  });

  it('remembers the choice across a reload', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /switch to light theme/i }));
    cleanup();

    // A reload is a fresh mount reading the same storage.
    document.documentElement.className = '';
    render(<Harness />);
    expect(screen.getByTestId('mode').textContent).toBe('light');
    expect(htmlIsDark()).toBe(false);
  });

  it('toggles back to dark and stores that too', () => {
    localStorage.setItem(MODE_KEY, 'light');
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /switch to dark theme/i }));

    expect(htmlIsDark()).toBe(true);
    expect(localStorage.getItem(MODE_KEY)).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  describe('when localStorage is unavailable (private modes throw)', () => {
    /** Storage that throws on every access, the way a locked-down browser behaves. */
    function breakStorage() {
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('SecurityError: storage is disabled');
        },
        setItem: () => {
          throw new Error('SecurityError: storage is disabled');
        },
        removeItem: () => {
          throw new Error('SecurityError: storage is disabled');
        },
        clear: () => {
          throw new Error('SecurityError: storage is disabled');
        },
      });
    }
    afterEach(() => vi.unstubAllGlobals());

    it('still defaults to dark instead of crashing', () => {
      breakStorage();
      expect(() => readStoredMode()).not.toThrow();
      expect(readStoredMode()).toBe('dark');
      render(<Harness />);
      expect(htmlIsDark()).toBe(true);
    });

    it('still toggles for the session — it just cannot remember', () => {
      breakStorage();
      render(<Harness />);

      // The press must work. Only the persistence is lost.
      expect(() =>
        fireEvent.click(screen.getByRole('button', { name: /switch to light theme/i })),
      ).not.toThrow();
      expect(screen.getByTestId('mode').textContent).toBe('light');
      expect(htmlIsDark()).toBe(false);
    });
  });

  it('names what the press will do, not what the state is', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /switch to light theme/i })).toBeTruthy();
  });
});
