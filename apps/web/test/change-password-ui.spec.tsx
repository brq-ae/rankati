// @vitest-environment happy-dom
import type { List } from '@rankati/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { authStatusResponse } from './support/auth';

/**
 * Change password in Settings (ADR 0076). The form renders in the Account section; a correct change
 * confirms; a confirm mismatch is blocked with no request; a wrong current password shows the error.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];

let changeStatus: number; // the status /api/auth/change-password returns
let calls: { url: string; init?: RequestInit }[];

function res(body: unknown, { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}): Response {
  return { ok, status, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      if (url.includes('/api/auth/change-password')) {
        return changeStatus === 200
          ? Promise.resolve(res({ ok: true }))
          : Promise.resolve(res({ message: 'no' }, { ok: false, status: changeStatus }));
      }
      if (url.includes('/api/locations')) return Promise.resolve(res([]));
      if (url.includes('/api/lists')) return Promise.resolve(res(LISTS));
      if (url.includes('/api/tasks')) return Promise.resolve(res([]));
      throw new Error(`change-password-ui: unstubbed request to ${url}`);
    }),
  );
}

async function openSettings(): Promise<void> {
  render(<App />);
  await screen.findByLabelText('Task title'); // the app shell has loaded
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  await screen.findByLabelText('Current password');
}

describe('change password in Settings (ADR 0076)', () => {
  beforeEach(() => {
    localStorage.clear();
    changeStatus = 200;
    calls = [];
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the change-password form in Settings', async () => {
    await openSettings();
    expect(screen.getByLabelText('Current password')).toBeDefined();
    expect(screen.getByLabelText('New password')).toBeDefined();
    expect(screen.getByLabelText('Confirm new password')).toBeDefined();
  });

  it('a correct change confirms', async () => {
    await openSettings();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-pw' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-pw-123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-pw-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await screen.findByText(/password changed/i);
    const sent = calls.find((c) => c.url.includes('/api/auth/change-password'));
    expect(JSON.parse(String(sent?.init?.body))).toEqual({ currentPassword: 'old-pw', newPassword: 'new-pw-123' });
  });

  it('a confirm mismatch is blocked — no request', async () => {
    await openSettings();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-pw' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-pw-123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'different' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await screen.findByText(/new passwords do not match/i);
    expect(calls.some((c) => c.url.includes('/api/auth/change-password'))).toBe(false);
  });

  it('a wrong current password shows the error', async () => {
    changeStatus = 401;
    await openSettings();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-pw-123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-pw-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await screen.findByText(/current password is incorrect/i);
  });
});
