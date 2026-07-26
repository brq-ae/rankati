// @vitest-environment happy-dom
import type { List, Routine, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The SILO in the served UI (ADR 0066): a routine renders ONLY in the Routines tab — never in Lists,
 * Today or Upcoming, which show tasks. Proven through the real App against a stubbed API.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Groceries', ownerId: 'local' }];
const TASKS: Task[] = [
  {
    id: 't1', title: 'Milk', listId: 'l1', ownerId: 'local', status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null,
    tier: 'normal', dependsOn: [], locationIds: [], needsHand: false, checklist: [], effort: null, needsDetails: false, impact: 'none', ...({} as Partial<Task>),
  },
];
const ROUTINES: Routine[] = [
  {
    id: 'r1', ownerId: 'local', name: 'Water the plants', type: 'frequency', createdAt: '2026-01-01T00:00:00.000Z',
    snoozedUntil: null, periodUnit: 'week', targetCount: 3, periodCount: 1, periodStart: '2026-01-12',
    intervalUnit: null, intervalCount: null, preferredWeekday: null, nextDue: null,
    ruleKind: null, ruleOrdinal: null, ruleWeekday: null, ruleDayOfMonth: null, acknowledgedDate: null,
  },
];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const json = (b: unknown) =>
        Promise.resolve({ ok: true, headers: { get: () => null }, json: () => Promise.resolve(b) } as unknown as Response);
      if ((init?.method ?? 'GET') !== 'GET') return json({});
      if (url.includes('/api/routines')) return json(ROUTINES);
      if (url.includes('/api/locations')) return json([]);
      if (url.includes('/api/lists')) return json(LISTS);
      if (url.includes('/api/tasks/today')) return json([]);
      if (url.includes('/api/tasks/upcoming')) return json([]);
      if (url.includes('/api/tasks')) return json(TASKS);
      throw new Error(`routines-silo.spec: unstubbed ${url}`);
    }),
  );
}
const tab = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  localStorage.clear();
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('routines are siloed to the Routines tab', () => {
  it('the routine is absent from Lists/Today/Upcoming and present only in Routines', async () => {
    render(<App />);
    await screen.findByText('Milk'); // Lists loaded (a task)

    expect(screen.queryByText('Water the plants')).toBeNull(); // not on Lists
    fireEvent.click(tab('today'));
    expect(screen.queryByText('Water the plants')).toBeNull(); // not on Today
    fireEvent.click(tab('upcoming'));
    expect(screen.queryByText('Water the plants')).toBeNull(); // not on Upcoming

    fireEvent.click(tab('routines'));
    await screen.findByText('Water the plants'); // present here, and only here
    expect(screen.queryByText('Milk')).toBeNull(); // and the task is not on the Routines tab
  });
});
