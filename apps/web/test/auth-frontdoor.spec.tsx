// @vitest-environment happy-dom
import type { List } from '@rankati/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The web auth front door (ADR 0076): GET /api/auth/status routes <App/> to the create-account screen,
 * the login screen, or the app, and a mid-session 401 drops back to login. The fetch stub controls the
 * status and the auth endpoints, and records calls so we can assert what the screens send.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];

let status: { needsSetup: boolean; authenticated: boolean };
let loginOutcome: { ok: boolean; status?: number; retryAfter?: string | null };
let tasksHttpStatus: number;
let calls: { url: string; init?: RequestInit }[];

function res(
  body: unknown,
  { ok = true, status = 200, headers = {} }: { ok?: boolean; status?: number; headers?: Record<string, string | null> } = {},
): Response {
  return {
    ok,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/api/auth/status')) return Promise.resolve(res(status));
      if (url.includes('/api/auth/setup')) {
        status = { needsSetup: false, authenticated: true }; // the server auto-logs-in
        return Promise.resolve(res({ ok: true }));
      }
      if (url.includes('/api/auth/login')) {
        if (loginOutcome.ok) return Promise.resolve(res({ ok: true }));
        return Promise.resolve(
          res({ message: 'x' }, { ok: false, status: loginOutcome.status ?? 401, headers: { 'retry-after': loginOutcome.retryAfter ?? null } }),
        );
      }
      if (url.includes('/api/auth/logout')) return Promise.resolve(res({ ok: true }));
      if (url.includes('/api/locations')) return Promise.resolve(res([]));
      if (url.includes('/api/lists')) return Promise.resolve(res(LISTS));
      if (url.includes('/api/tasks')) {
        return tasksHttpStatus === 401
          ? Promise.resolve(res({ message: 'unauthorized' }, { ok: false, status: 401 }))
          : Promise.resolve(res([]));
      }
      throw new Error(`auth-frontdoor: unstubbed request to ${url}`);
    }),
  );
}

/** The JSON body a recorded request carried, parsed. */
const bodyOf = (path: string): unknown => {
  const call = calls.find((c) => c.url.includes(path));
  return call?.init?.body ? JSON.parse(String(call.init.body)) : undefined;
};

describe('the auth front door (ADR 0076)', () => {
  beforeEach(() => {
    localStorage.clear();
    status = { needsSetup: false, authenticated: true };
    loginOutcome = { ok: true };
    tasksHttpStatus = 200;
    calls = [];
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('first run: create-account renders, submit posts setup WITH trusted, and enters the app', async () => {
    status = { needsSetup: true, authenticated: false };
    render(<App />);
    await screen.findByRole('heading', { name: /create your account/i });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByLabelText('Trust this device'));
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await screen.findByLabelText('Task title'); // the app shell — we are in
    expect(bodyOf('/api/auth/setup')).toEqual({ username: 'alice', password: 'pw123456', trusted: true });
  });

  it('create-account blocks a confirm-password mismatch (no setup request)', async () => {
    status = { needsSetup: true, authenticated: false };
    render(<App />);
    await screen.findByRole('heading', { name: /create your account/i });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'nomatch' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await screen.findByText(/passwords do not match/i);
    expect(calls.some((c) => c.url.includes('/api/auth/setup'))).toBe(false);
  });

  it('login: correct credentials enter the app and send trusted', async () => {
    status = { needsSetup: false, authenticated: false };
    render(<App />);
    await screen.findByRole('heading', { name: /log in/i });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByLabelText('Trust this device'));
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    await screen.findByLabelText('Task title');
    expect(bodyOf('/api/auth/login')).toEqual({ username: 'alice', password: 'pw', trusted: true });
  });

  it('login 401: a wrong-credentials message that names no field', async () => {
    status = { needsSetup: false, authenticated: false };
    loginOutcome = { ok: false, status: 401 };
    render(<App />);
    await screen.findByRole('heading', { name: /log in/i });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    const alert = await screen.findByText(/wrong username or password/i);
    expect(alert.textContent?.toLowerCase()).not.toMatch(/username was|password was/); // no field leak
  });

  it('login 429: the lockout countdown comes from the Retry-After header', async () => {
    status = { needsSetup: false, authenticated: false };
    loginOutcome = { ok: false, status: 429, retryAfter: '90' }; // 90s → 1m 30s
    render(<App />);
    await screen.findByRole('heading', { name: /log in/i });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    await screen.findByText(/try again in 1m 30s/i);
  });

  it('the trust-this-device checkbox is present on BOTH screens', async () => {
    status = { needsSetup: true, authenticated: false };
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: /create your account/i });
    expect(screen.getByLabelText('Trust this device')).toBeDefined();
    unmount();

    status = { needsSetup: false, authenticated: false };
    render(<App />);
    await screen.findByRole('heading', { name: /log in/i });
    expect(screen.getByLabelText('Trust this device')).toBeDefined();
  });

  it('logout: the Settings control returns to the login screen', async () => {
    render(<App />); // authed by default
    await screen.findByLabelText('Task title');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: /log out/i }));

    await screen.findByRole('heading', { name: /log in/i });
    expect(calls.some((c) => c.url.includes('/api/auth/logout'))).toBe(true);
  });

  it('a protected fetch returning 401 mid-session routes back to login', async () => {
    render(<App />); // authed, app loads
    await screen.findByLabelText('Task title');

    tasksHttpStatus = 401; // the session has expired/been revoked server-side
    fireEvent(window, new Event('focus')); // App re-reads on focus → the read now 401s

    await screen.findByRole('heading', { name: /log in/i });
  });

  it('login password: a show/hide toggle reveals (password → text) then hides again (ADR 0080)', async () => {
    status = { needsSetup: false, authenticated: false };
    render(<App />);
    await screen.findByRole('heading', { name: /log in/i });

    const pwd = screen.getByLabelText('Password') as HTMLInputElement;
    expect(pwd.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(pwd.type).toBe('text'); // revealed — the actual value is now visible
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(pwd.type).toBe('password'); // hidden again
  });

  it('setup: the password AND confirm fields are each independently revealable (ADR 0080)', async () => {
    status = { needsSetup: true, authenticated: false };
    render(<App />);
    await screen.findByRole('heading', { name: /create your account/i });

    const pwd = screen.getByLabelText('Password') as HTMLInputElement;
    const confirm = screen.getByLabelText('Confirm password') as HTMLInputElement;
    expect(screen.getAllByRole('button', { name: 'Show password' })).toHaveLength(2); // one per field

    fireEvent.click(screen.getAllByRole('button', { name: 'Show password' })[0]); // reveal password only
    expect(pwd.type).toBe('text');
    expect(confirm.type).toBe('password'); // confirm still hidden — independent
    fireEvent.click(screen.getByRole('button', { name: 'Show password' })); // the remaining toggle = confirm's
    expect(confirm.type).toBe('text');
  });

  it('the username input carries autocapitalize=none / autocorrect=off / spellcheck=false on BOTH screens (ADR 0080)', async () => {
    for (const s of [
      { needsSetup: true, authenticated: false },
      { needsSetup: false, authenticated: false },
    ]) {
      cleanup();
      status = s;
      render(<App />);
      await screen.findByRole('heading', { name: s.needsSetup ? /create your account/i : /log in/i });
      const username = screen.getByLabelText('Username');
      expect(username.getAttribute('autocapitalize')).toBe('none');
      expect(username.getAttribute('autocorrect')).toBe('off');
      expect(username.getAttribute('spellcheck')).toBe('false');
    }
  });
});
