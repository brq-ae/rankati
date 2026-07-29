// @vitest-environment happy-dom
import type { List } from '@rankati/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The first-login "Unauthorized" flash (v0.33.2). Two guards:
 *   1. the focus/visibility reread is gated on authed — it must not fire the reads while unauthenticated
 *      (their 401 was the flash's trigger);
 *   2. a 401 is owned by the onUnauthorized seam (routes to login), so it must NOT paint the error banner,
 *      while a genuine (non-401) error still must.
 * We stub fetch, control the auth status and the lists-read HTTP status, and record which endpoints are hit.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];
const PIN = { highFuseDays: 7, mediumFuseDays: 30, highSnoozeDays: 1, mediumSnoozeDays: 3 };

let status: { needsSetup: boolean; authenticated: boolean };
let listsStatus: number; // 200, or 401/500 to force the lists read to fail
let calls: string[];

function res(body: unknown, { ok = true, status = 200 } = {}): Response {
  return { ok, status, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/auth/status')) return Promise.resolve(res(status));
      if (url.includes('/api/settings/pin')) return Promise.resolve(res(PIN));
      if (url.includes('/api/locations')) return Promise.resolve(res([]));
      if (url.includes('/api/tasks')) return Promise.resolve(res([]));
      if (url.includes('/api/lists')) {
        return listsStatus === 200
          ? Promise.resolve(res(LISTS))
          : Promise.resolve(res({ message: `boom-${listsStatus}` }, { ok: false, status: listsStatus }));
      }
      throw new Error(`auth-flash: unstubbed request to ${url}`);
    }),
  );
}

/** The data reads that only `refresh()` triggers — their absence proves the reread didn't fire. */
const reads = () => calls.filter((u) => /\/api\/(lists|tasks|locations)/.test(u));

beforeEach(() => {
  localStorage.clear();
  calls = [];
  listsStatus = 200;
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('focus/visibility reread is auth-gated (v0.33.2, fix 1)', () => {
  it('does NOT reread on a focus/visibility event while UNAUTHENTICATED', async () => {
    status = { needsSetup: false, authenticated: false };
    render(<App />);
    await screen.findByRole('heading', { name: /log in/i });
    expect(reads()).toHaveLength(0);

    calls = [];
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 0));
    expect(reads()).toHaveLength(0); // gated — no reads while unauthed
  });

  it('DOES reread on a focus event once AUTHENTICATED', async () => {
    status = { needsSetup: false, authenticated: true };
    render(<App />);
    await screen.findByLabelText('Task title');
    calls = [];
    window.dispatchEvent(new Event('focus'));
    await screen.findByLabelText('Task title'); // still authed
    expect(reads().length).toBeGreaterThan(0); // the reread fired
  });
});

describe('a 401 must not paint the error banner (v0.33.2, fix 2)', () => {
  it('a genuine (non-401) error DOES paint the banner', async () => {
    status = { needsSetup: false, authenticated: true };
    listsStatus = 500; // the load fails with a real error
    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('boom-500');
  });

  it('a 401 during the load does NOT paint a banner — the seam routes to login', async () => {
    status = { needsSetup: false, authenticated: true };
    listsStatus = 401; // the load 401s → onUnauthorized routes to login
    render(<App />);
    await screen.findByRole('heading', { name: /log in/i }); // landed on login
    expect(screen.queryByRole('alert')).toBeNull(); // no error banner
  });
});
