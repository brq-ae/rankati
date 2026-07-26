// @vitest-environment happy-dom
import type { List, Location, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The VS button's duelable state must be judged over the FULL task set, never the location-filtered
 * `visibleTasks` (v0.12). The unit test (`duelable.spec`) proves `isListDuelable` ignores location;
 * THIS proves App actually feeds it the unfiltered set — which is where the mistake would really
 * happen: `visibleTasks` is right there, named plausibly, and used everywhere else in that render.
 *
 * The load-bearing assertion is the one under an active filter: swap `tasks` for `visibleTasks` in
 * App's VS `disabled=` and this test reds (a filter would then disable a list the server would still
 * duel). Verified by sabotaging exactly that.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Groceries', ownerId: 'local' }];

const task = (id: string, title: string, locationIds: string[]): Task => ({
  id,
  title,
  listId: 'l1',
  ownerId: 'local',
  status: 'active',
  createdAt: '2026-07-21T12:00:00.000Z',
  completedAt: null,
  rating: 1000,
  notBefore: null,
  due: null,
  availabilityWindow: null,
  tier: 'normal',
  dependsOn: [],
  locationIds,
  needsHand: false,
  checklist: [], effort: null, needsDetails: false, impact: 'none',
  ...({} as Partial<Task>),
});

let TASKS: Task[] = [];
let LOCATIONS: Location[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response);
      if ((init?.method ?? 'GET') !== 'GET') return json(TASKS[0]);
      const body = url.includes('/api/locations')
        ? LOCATIONS
        : url.includes('/api/lists')
          ? LISTS
          : url.includes('/api/tasks')
            ? TASKS
            : undefined;
      if (body === undefined) throw new Error(`vs-location.spec: unstubbed ${url}`);
      return json(body);
    }),
  );
}

const ready = async () => {
  await screen.findByRole('button', { name: /start dueling/i });
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
};
const dropdown = () => screen.getByLabelText('Filter tasks by location') as HTMLSelectElement;
const vs = () => screen.getByRole('button', { name: 'Duel Groceries' }) as HTMLButtonElement;

const HOME = { id: 'a', name: 'Home', ownerId: 'local' };
const OFFICE = { id: 'b', name: 'Office', ownerId: 'local' };

beforeEach(() => {
  localStorage.clear();
  TASKS = [];
  LOCATIONS = [];
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('VS duelability is judged over the FULL task set, not the location-filtered view (v0.12)', () => {
  it('stays ENABLED when a location filter hides a duelable list’s tasks', async () => {
    LOCATIONS = [HOME, OFFICE];
    TASKS = [task('t1', 'Milk', ['a']), task('t2', 'Eggs', ['a'])]; // two active in Groceries, both tagged Home
    render(<App />);
    await ready();

    expect(vs().disabled).toBe(false); // Everywhere: two active -> duelable

    // Filter to Office: both tasks (tagged Home) vanish from the Lists view...
    fireEvent.change(dropdown(), { target: { value: 'b' } });
    // ...but the Arena is location-agnostic, so the server would still duel them. VS must STAY
    // enabled. If App fed `visibleTasks` here, it would now be disabled (0 visible) — the sabotage.
    expect(vs().disabled).toBe(false);
  });

  it('is DISABLED only when the list truly has fewer than two active tasks', async () => {
    LOCATIONS = [HOME];
    TASKS = [task('t1', 'Milk', [])]; // one active task
    render(<App />);
    await ready();
    expect(vs().disabled).toBe(true);
  });
});
