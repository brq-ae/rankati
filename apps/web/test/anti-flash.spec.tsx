// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODE_KEY } from '../src/mode';
import { DEFAULT_THEME, PALETTE_KEY, THEMES } from '../src/palette';

/**
 * The pre-paint script in index.html (ADRs 0051, 0062). It now applies BOTH axes — mode (.dark)
 * and theme (data-theme) — before the first paint.
 *
 * WHAT THIS CANNOT DO: prove there is no flash. A flash is a paint, and happy-dom does not
 * paint — no DOM-emulating harness can judge this. Only a real browser can, which is why
 * the flash itself stays a human check.
 *
 * What it CAN do is prove the two things a flash would come from:
 *   1. the script's logic is right (executed here, from the real file), and
 *   2. it runs BEFORE the module that mounts React (its position in the document).
 * If both hold, the class and attribute are on <html> before React exists. That is the mechanism;
 * the pixels remain unverified, and this file says so rather than letting a green tick imply
 * otherwise.
 *
 * The script's SOURCE is read from index.html rather than copied here. A copy would pass
 * forever while the shipped file rotted.
 */

const INDEX_HTML = resolve(__dirname, '../index.html');
const html = readFileSync(INDEX_HTML, 'utf8');

/** The inline script's body — the one without a src attribute. */
function inlineScriptSource(): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error('no inline script found in index.html');
  return match[1];
}

/** Run the real script text against this test's document. */
function runPrePaintScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(inlineScriptSource())();
}

describe('the pre-paint theme script', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.style.colorScheme = '';
    delete document.documentElement.dataset.theme;
  });
  afterEach(() => localStorage.clear());

  it('runs before the module that mounts React', () => {
    // Ordering is the whole point: after main.tsx, the first paint has already happened.
    const inlineAt = html.indexOf('<script>');
    const moduleAt = html.indexOf('src="/src/main.tsx"');
    expect(inlineAt).toBeGreaterThan(-1);
    expect(moduleAt).toBeGreaterThan(-1);
    expect(inlineAt).toBeLessThan(moduleAt);
  });

  it('is inline and synchronous — no defer, no async, no src', () => {
    // Any of those would move it after first paint and reintroduce the flash.
    const tag = /<script(?![^>]*src)[^>]*>/.exec(html)?.[0] ?? '';
    expect(tag).toBe('<script>');
  });

  it('applies dark when nothing is stored', () => {
    runPrePaintScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('applies light when light was chosen', () => {
    localStorage.setItem(MODE_KEY, 'light');
    runPrePaintScript();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('applies the default theme (brand) when nothing is stored', () => {
    runPrePaintScript();
    expect(document.documentElement.dataset.theme).toBe('brand');
  });

  it('applies a stored valid theme', () => {
    localStorage.setItem(PALETTE_KEY, 'warm');
    runPrePaintScript();
    expect(document.documentElement.dataset.theme).toBe('warm');
  });

  it('falls back to the default for an UNKNOWN stored theme — before paint, too (0062)', () => {
    localStorage.setItem(PALETTE_KEY, 'nonsense');
    runPrePaintScript();
    expect(document.documentElement.dataset.theme).toBe('brand'); // never the raw value
  });

  it('sets the browser chrome to the default-theme canvas for the mode', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
    try {
      runPrePaintScript(); // nothing stored -> dark
      expect(meta.getAttribute('content')).toBe('#1a102e'); // brand's dark canvas
      localStorage.setItem(MODE_KEY, 'light');
      runPrePaintScript();
      expect(meta.getAttribute('content')).toBe('#f8fafc'); // brand's light canvas
    } finally {
      meta.remove();
    }
  });

  it('its duplicated constants agree with the modules (drift guard: 0055 mode key + 0062 palette)', () => {
    // The keys / valid set / default are written twice on purpose (the script cannot import). If
    // they ever drift, the app applies one thing before paint and another after — the exact flash
    // this script prevents. This locks BOTH the mode key (0055, previously comment-only) and the
    // palette constants (0062) to their modules.
    const src = inlineScriptSource();
    expect(src).toContain(MODE_KEY);
    expect(src).toContain(PALETTE_KEY);
    expect(src).toContain(DEFAULT_THEME);
    for (const t of THEMES) expect(src).toContain(`'${t}'`);
  });

  it('does not crash when storage throws', () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage is disabled');
      },
    });
    try {
      expect(() => runPrePaintScript()).not.toThrow();
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.dataset.theme).toBe('brand'); // default survives a throw
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: original,
      });
    }
  });
});
