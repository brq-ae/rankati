// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The three tabs — Lists, Today, Upcoming (ADR 0058). The scoring and the ordering are the
 * server's (0057); these tests prove the web renders what it is handed, in the order handed, and
 * routes the Upcoming read to its own tab.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];

const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({
  id,
  title,
  listId: 'l1',
  ownerId: 'local',
  status: 'active',
  createdAt: '2026-07-17T12:00:00.000Z',
  completedAt: null,
  rating: 1000,
  notBefore: null,
  due: null,
  availabilityWindow: null,
  tier: 'normal',
  dependsOn: [],
  locationIds: [],
  needsHand: false,
  checklist: [], effort: null, needsDetails: false, impact: 'none',
  ...over,
});

// Today deliberately NOT in rating order — Beta (900) before Alpha (1200) — so the test proves
// the view keeps the server's order rather than re-sorting by rating.
const TODAY: Task[] = [task('b', 'Beta', { rating: 900 }), task('a', 'Alpha', { rating: 1200 })];
const UPCOMING: Task[] = [task('u', 'Horizon task', { due: '2026-08-01', tier: 'super_important' })];

function stub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const body = url.includes('/api/locations') ? [] : url.includes('/api/lists')
        ? LISTS
        : url.includes('/api/tasks/today')
          ? TODAY
          : url.includes('/api/tasks/upcoming')
            ? UPCOMING
            : url.includes('/api/tasks')
              ? [...TODAY, ...UPCOMING]
              : undefined;
      if (body === undefined) throw new Error(`tabs-upcoming.spec: unstubbed ${url}`);
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

const ready = async () => {
  await screen.findByRole('button', { name: /start dueling/i });
  // The Arena's "start dueling" renders ABOVE the loading gate, so waiting for it does NOT mean the
  // task rows have painted. Wait for the data too, or a getBy on a row races the unpainted list
  // (the tick-ring flake, class-fixed across specs).
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
};
const tab = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }));

beforeEach(() => {
  localStorage.clear();
  stub();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('three tabs (0058)', () => {
  it('offers Lists, Today and Upcoming', async () => {
    render(<App />);
    await ready();
    expect(screen.getByRole('button', { name: /^lists$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^today$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^upcoming$/i })).toBeTruthy();
  });

  it('Today renders the server order as-is — it does not re-sort by rating', async () => {
    render(<App />);
    await ready();
    tab('today');

    const items = screen.getAllByRole('listitem');
    // Server sent Beta (900) before Alpha (1200); a client rating-sort would flip them.
    expect(within(items[0]!).getByText('Beta')).toBeTruthy();
    expect(within(items[1]!).getByText('Alpha')).toBeTruthy();
  });

  it('Upcoming shows the dated tasks, leading with the due date and the tier', async () => {
    render(<App />);
    await ready();
    tab('upcoming');

    const item = screen.getByRole('listitem');
    expect(within(item).getByText('Horizon task')).toBeTruthy();
    expect(within(item).getByText('2026-08-01')).toBeTruthy(); // the due date, the scannable field
    expect(within(item).getByText('Super Important')).toBeTruthy(); // the tier, explaining its distance
  });

  it('Today and Upcoming are different reads — a Today task is not in Upcoming', async () => {
    render(<App />);
    await ready();
    tab('upcoming');
    expect(screen.queryByText('Beta')).toBeNull(); // Beta is a Today task, not here
    expect(screen.getByText('Horizon task')).toBeTruthy();
  });
});
