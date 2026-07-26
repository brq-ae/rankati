// @vitest-environment happy-dom
import type { Location, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The Blocked filter on the Lists tab (ADR 0069): the [ All | Blocked ] toggle swaps the grid for a
 * flat, cross-list read of tasks with an unfinished direct prerequisite; the location filter still
 * applies; All restores the grid. Against the real App with a stubbed API.
 */
const LISTS = [
  { id: 'l1', name: 'Work', ownerId: 'local' },
  { id: 'l2', name: 'Home', ownerId: 'local' },
];
const LOCATIONS: Location[] = [
  { id: 'office', name: 'Office', ownerId: 'local' },
  { id: 'house', name: 'House', ownerId: 'local' },
];
const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal', dependsOn: [],
  locationIds: [], needsHand: false, checklist: [], effort: null, needsDetails: false, impact: 'none', ...over,
});

// "Ship it" (Work, Office) waits on "Write draft" (Home) — a CROSS-LIST block. "Buy milk" is free.
const SHIP = task({ id: 'blk', title: 'Ship it', listId: 'l1', dependsOn: ['pre'], locationIds: ['office'] });
const DRAFT = task({ id: 'pre', title: 'Write draft', listId: 'l2', locationIds: ['house'] });
const MILK = task({ id: 'free', title: 'Buy milk', listId: 'l1' });
const ALL = [SHIP, DRAFT, MILK];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const body = url.includes('/api/locations')
        ? LOCATIONS
        : url.includes('/api/lists')
          ? LISTS
          : url.includes('/api/tasks/today') || url.includes('/api/tasks/upcoming')
            ? []
            : url.includes('/api/tasks')
              ? ALL
              : undefined;
      if (body === undefined) throw new Error(`blocked-filter-ui.spec: unstubbed ${url}`);
      return Promise.resolve({
        ok: true, headers: { get: () => null }, json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

const blockedTab = () => screen.getByRole('button', { name: /^Blocked/ });
const allTab = () => screen.getByRole('button', { name: /^All$/ });
const selectLocation = (value: string) =>
  fireEvent.change(screen.getByLabelText('Filter tasks by location'), { target: { value } });

describe('Blocked filter (App, ADR 0069)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('Blocked shows exactly the blocked task with its cross-list prerequisite; All restores the grid', async () => {
    render(<App />);
    await screen.findByText('Buy milk'); // Lists/All loaded — everything shows in the grid

    fireEvent.click(blockedTab());
    const row = screen.getByText('Ship it').closest('li'); // the blocked task shows
    expect(row?.textContent).toContain('waiting on'); //   with its waiting-on line...
    expect(row?.textContent).toContain('Write draft'); //   ...naming the cross-list (l2) prerequisite
    expect(screen.queryByText('Buy milk')).toBeNull(); // the unblocked task is gone from Blocked

    fireEvent.click(allTab());
    expect(screen.getByText('Buy milk')).toBeTruthy(); // the grid is back
    expect(screen.getByText('Ship it')).toBeTruthy();
  });

  it('a set location narrows Blocked — an office-tagged block hidden when viewing the House', async () => {
    render(<App />);
    await screen.findByText('Buy milk');

    fireEvent.click(blockedTab());
    expect(screen.getByText('Ship it')).toBeTruthy(); // blocked, at Everywhere

    selectLocation('house'); // "Ship it" is Office-tagged → hidden at the House
    expect(screen.queryByText('Ship it')).toBeNull();
    expect(screen.getByText(/Nothing is blocked/)).toBeTruthy();
  });
});
