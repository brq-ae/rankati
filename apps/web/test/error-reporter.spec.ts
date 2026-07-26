// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetReporterForTests,
  installGlobalErrorHandlers,
  reportError,
  setCurrentView,
} from '../src/error-reporter';
import { APP_VERSION } from '../src/version';

/**
 * The client-side error reporter (ADR 0078). The load-bearing parts are the flood control (dedupe + a
 * per-session cap) and the swallow guarantee — a crashing error reporter would be the worst kind of bug.
 */
function fetchCalls(): { url: string; body: Record<string, unknown> }[] {
  return vi.mocked(fetch).mock.calls.map((c) => ({
    url: String(c[0]),
    body: JSON.parse(String((c[1] as RequestInit).body)),
  }));
}

describe('error reporter (ADR 0078)', () => {
  beforeEach(() => {
    __resetReporterForTests();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true }) as unknown as Promise<Response>));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the expected payload shape to /api/client-error', () => {
    setCurrentView('Today');
    reportError(new Error('Cannot read x of undefined'));

    const calls = fetchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/client-error');
    const b = calls[0].body;
    expect(b.message).toBe('Cannot read x of undefined');
    expect(typeof b.stack).toBe('string');
    expect(b.view).toBe('Today'); // from setCurrentView
    expect(b.appVersion).toBe(APP_VERSION);
    expect(typeof b.userAgent).toBe('string');
    expect(String(b.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('a context view overrides the current view; no view set → view omitted', () => {
    reportError(new Error('one'), { view: 'Arena' });
    expect(fetchCalls()[0].body.view).toBe('Arena');

    __resetReporterForTests();
    reportError(new Error('two')); // no current view, no context
    expect('view' in fetchCalls()[1].body).toBe(false);
  });

  it('DEDUPE: the same error reported twice → exactly ONE POST', () => {
    const err = new Error('boom');
    reportError(err);
    reportError(err);
    reportError(err);
    expect(fetchCalls()).toHaveLength(1);
  });

  it('CAP: beyond the session cap, no further POSTs', () => {
    for (let i = 0; i < 25; i++) reportError(new Error(`unique-${i}`)); // 25 distinct errors
    expect(fetchCalls()).toHaveLength(20); // capped at the session max
  });

  it('a failed POST is swallowed — reportError never throws', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('network down'); // synchronous throw from fetch
      }),
    );
    expect(() => reportError(new Error('during an outage'))).not.toThrow();

    // And a rejected promise is swallowed too (no unhandled rejection).
    __resetReporterForTests();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('rejected'))));
    expect(() => reportError(new Error('async fail'))).not.toThrow();
  });

  it('global handlers: a window "error" and an "unhandledrejection" each fire a report', () => {
    installGlobalErrorHandlers();

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('global handler error') }));
    expect(fetchCalls().some((c) => c.body.message === 'global handler error')).toBe(true);

    const rejection = new Event('unhandledrejection');
    (rejection as unknown as { reason: unknown }).reason = new Error('unhandled rejection');
    window.dispatchEvent(rejection);
    expect(fetchCalls().some((c) => c.body.message === 'unhandled rejection')).toBe(true);
  });
});
