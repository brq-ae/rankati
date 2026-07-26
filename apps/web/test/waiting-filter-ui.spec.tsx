// @vitest-environment happy-dom
import type { Location, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The "Waiting on people" filter on the Lists tab (ADR 0071) — the third segment of the
 * [ All | Blocked | Waiting on people ] toggle: a flat, cross-list read of needsHand-flagged
 * tasks, the same filter-not-lane shape ADR 0069 established for Blocked. needsHand is a SOFT
 * label — this filter's membership is the ONLY thing it decides; it never hides a flagged task
 * from All, Today, Upcoming or the Arena. Mirrors blocked-filter-ui.spec.tsx's harness.
 */
const LISTS = [
  { id: 'l1', name: 'Work', ownerId: 'local' },
  { id: 'l2', name: 'Home', ownerId: 'local' },
];
const LOCATIONS: Location[] = [
  { id: 'office', name: 'Office', ownerId: 'local' },
  { id: 'house', name: 'House', ownerId: 'local' },
  { id: 'garage', name: 'Garage', ownerId: 'local' },
];
const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal', dependsOn: [],
  locationIds: [], needsHand: false, checklist: [], effort: null, needsDetails: false, impact: 'none', ...over,
});

// "Call the plumber" (Work, Office) and "Ask Sam" (Home, House) are flagged — a CROSS-LIST set.
// "Buy milk" is unflagged and must never appear in Waiting on people.
const PLUMBER = task({ id: 'p', title: 'Call the plumber', listId: 'l1', needsHand: true, locationIds: ['office'] });
const SAM = task({ id: 's', title: 'Ask Sam', listId: 'l2', needsHand: true, locationIds: ['house'] });
const MILK = task({ id: 'm', title: 'Buy milk', listId: 'l1', needsHand: false });
// Unflagged and Garage-tagged: exists so the Garage location has visible tasks but NONE flagged.
const OIL = task({ id: 'o', title: 'Change oil', listId: 'l1', needsHand: false, locationIds: ['garage'] });
const ALL = [PLUMBER, SAM, MILK, OIL];

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
      if (body === undefined) throw new Error(`waiting-filter-ui.spec: unstubbed ${url}`);
      return Promise.resolve({
        ok: true, headers: { get: () => null }, json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

const waitingTab = () => screen.getByRole('button', { name: /^Waiting on people/ });
const blockedTab = () => screen.getByRole('button', { name: /^Blocked/ });
const allTab = () => screen.getByRole('button', { name: /^All$/ });
const selectLocation = (value: string) =>
  fireEvent.change(screen.getByLabelText('Filter tasks by location'), { target: { value } });

describe('Waiting on people filter (App, ADR 0071)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('the segment shows a count chip matching the flagged set', async () => {
    render(<App />);
    await screen.findByText('Buy milk');
    expect(waitingTab().textContent).toBe('Waiting on people (2)');
  });

  it('shows exactly the flagged tasks, cross-list; the unflagged task is absent', async () => {
    render(<App />);
    await screen.findByText('Buy milk'); // Lists/All loaded

    fireEvent.click(waitingTab());
    expect(screen.getByText('Call the plumber')).toBeTruthy();
    expect(screen.getByText('Ask Sam')).toBeTruthy(); // cross-list (l2) member included
    expect(screen.queryByText('Buy milk')).toBeNull(); // unflagged, absent

    // Row shape mirrors Blocked's: title + list name, plus the 🤝 marker.
    const row = screen.getByText('Call the plumber').closest('li');
    expect(row?.textContent).toContain('Work');
    expect(row?.textContent).toContain('needs a hand');
  });

  it('All restores the grid, with the flagged tasks still visible (never hidden)', async () => {
    render(<App />);
    await screen.findByText('Buy milk');

    fireEvent.click(waitingTab());
    fireEvent.click(allTab());
    expect(screen.getByText('Buy milk')).toBeTruthy();
    expect(screen.getByText('Call the plumber')).toBeTruthy();
    expect(screen.getByText('Ask Sam')).toBeTruthy();
  });

  it('a set location narrows the set, with the empty state when nothing flagged remains', async () => {
    render(<App />);
    await screen.findByText('Buy milk');

    fireEvent.click(waitingTab());
    selectLocation('office'); // only "Call the plumber" is Office-tagged
    expect(screen.getByText('Call the plumber')).toBeTruthy();
    expect(screen.queryByText('Ask Sam')).toBeNull();

    selectLocation('house'); // neither flagged-and-visible task is House-tagged except Sam
    expect(screen.queryByText('Call the plumber')).toBeNull();
    expect(screen.getByText('Ask Sam')).toBeTruthy();
  });

  it('shows the empty state when no location-visible task is flagged', async () => {
    render(<App />);
    await screen.findByText('Buy milk');

    fireEvent.click(waitingTab());
    selectLocation('garage'); // "Change oil" is Garage-tagged and unflagged — nothing qualifies
    expect(screen.getByText('No tasks are waiting on a person.')).toBeTruthy();
    expect(screen.queryByText('Call the plumber')).toBeNull();
    expect(screen.queryByText('Ask Sam')).toBeNull();
  });

  it('Blocked still works, unaffected by the new segment', async () => {
    render(<App />);
    await screen.findByText('Buy milk');

    fireEvent.click(blockedTab());
    expect(screen.getByText(/Nothing is blocked/)).toBeTruthy();
  });
});
