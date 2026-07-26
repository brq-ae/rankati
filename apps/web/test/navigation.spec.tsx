// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The tab switch (v0.3). Small on purpose: it proves the two views are reachable and that
 * the app opens on `lists` — nothing about what either view contains, which their own
 * specs cover.
 *
 * `fetch` is stubbed rather than mocked per-module: App reaches the network through api.ts,
 * and stubbing the boundary keeps this honest about what App actually does — it really does
 * call /api/lists and /api/tasks?sort=rating on mount.
 */

const LISTS: List[] = [{ id: 'l1', name: 'Task List A', ownerId: 'local' }];
const TASKS: Task[] = [
  {
    id: 't1',
    title: 'Only task',
    listId: 'l1',
    ownerId: 'local',
    status: 'active',
    createdAt: '2026-07-16T12:00:00.000Z',
    completedAt: null,
    rating: 1000,
    // Absent until v0.5 added the web typecheck that covers this file — the fixture claimed
    // to be a Task while missing fields the component reads (notBefore since v0.4).
    notBefore: null,
    due: null,
    availabilityWindow: null,
    tier: 'normal',
    dependsOn: [],
    locationIds: [],
    needsHand: false,
    checklist: [], effort: null, needsDetails: false, impact: 'none',
  },
];

/**
 * App reads three endpoints on mount: the lists, every task (ungated — Lists shows gates
 * and all), and the gated Today read (ADRs 0052, 0053). The stub answers each explicitly
 * rather than falling through to one body, so a new endpoint shows up as a failing test
 * rather than as whatever the catch-all happened to return.
 */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const body = url.includes('/api/locations') ? [] : url.includes('/api/lists')
        ? LISTS
        : url.includes('/api/tasks/today')
          ? TASKS // nothing is gated in this fixture, so Today is everything
          : url.includes('/api/tasks')
            ? TASKS
            : undefined;
      if (body === undefined) throw new Error(`navigation.spec: unstubbed request to ${url}`);
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

const tab = (name: 'lists' | 'today') => screen.getByRole('button', { name });

describe('navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens on lists, not Today — v0.3 adds a view, it does not move the front door', async () => {
    render(<App />);
    // The Arena lives on the lists screen and never on Today, so it identifies the view.
    expect(await screen.findByRole('button', { name: /start dueling/i })).toBeTruthy();
    expect(tab('lists').getAttribute('aria-current')).toBe('page');
    expect(tab('today').getAttribute('aria-current')).toBeNull();
  });

  it('switches to Today when the tab is pressed', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /start dueling/i });

    fireEvent.click(tab('today'));

    // findByText: "start dueling" (the readiness we awaited) renders above the loading gate, so the
    // Today content may not be painted yet — wait for it (the tick-ring flake, class-fixed).
    expect(await screen.findByText(/most important first/)).toBeTruthy();
    // The Arena and the add-task form belong to the lists screen; Today is a read.
    expect(screen.queryByRole('button', { name: /start dueling/i })).toBeNull();
    expect(tab('today').getAttribute('aria-current')).toBe('page');
  });

  it('switches back to lists', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /start dueling/i });

    fireEvent.click(tab('today'));
    fireEvent.click(tab('lists'));

    expect(screen.getByRole('button', { name: /start dueling/i })).toBeTruthy();
    expect(screen.queryByText(/most important first/)).toBeNull();
  });

  it('marks the current tab for screen readers, not just with colour', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /start dueling/i });
    // Colour alone tells a screen reader nothing about which view you are on.
    fireEvent.click(tab('today'));
    expect(tab('today').getAttribute('aria-current')).toBe('page');
    expect(tab('lists').getAttribute('aria-current')).toBeNull();
  });

  it('shows the same task on Today that the lists screen loaded', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /start dueling/i });
    fireEvent.click(tab('today'));
    // Today renders what App already holds — no second fetch (the client-side filter).
    expect(await screen.findByText('Only task')).toBeTruthy();
  });
});
