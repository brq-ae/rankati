// @vitest-environment happy-dom
import type { List, Location, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The list-delete UI (v0.13, ADR 0064). Two properties are load-bearing and tested at the edges:
 *
 *  1. The confirmation is GRADUATED at exactly >5 tasks — 4 and 5 get a plain confirm, 6 gets the
 *     typed-DELETE gate. Off-by-one here means either surprise friction or a twelve-task list gone in
 *     one click, so 4/5/6 are pinned rather than inferred.
 *  2. The count is the FULL task count for the list — `tasks`, never `visibleTasks`. A location filter
 *     that hides tasks must NOT shrink a 6-task list into plain-confirm territory. Sabotage: swap
 *     `tasks` for `visibleTasks` in App's `requireTyped={count > 5}` and the filter test reds.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Groceries', ownerId: 'local' }];
const HOME = { id: 'a', name: 'Home', ownerId: 'local' };
const OFFICE = { id: 'b', name: 'Office', ownerId: 'local' };

const task = (id: string, title: string, locationIds: string[] = []): Task => ({
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
let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(): void {
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response);
    if ((init?.method ?? 'GET') !== 'GET') return json({}); // POST/PATCH/DELETE succeed
    const body = url.includes('/api/locations')
      ? LOCATIONS
      : url.includes('/api/lists')
        ? LISTS
        : url.includes('/api/tasks')
          ? TASKS
          : undefined;
    if (body === undefined) throw new Error(`list-delete-ui.spec: unstubbed ${url}`);
    return json(body);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const ready = async () => {
  await screen.findByRole('button', { name: /start dueling/i });
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
};
const trigger = () => screen.getByRole('button', { name: 'Delete list Groceries' });
const typedInput = () => screen.queryByLabelText('Type DELETE to confirm');
const dropdown = () => screen.getByLabelText('Filter tasks by location') as HTMLSelectElement;

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

describe('list-delete graduated confirmation (v0.13)', () => {
  it.each([
    [4, false],
    [5, false],
    [6, true],
  ])('%i tasks -> typed-confirm required: %s', async (n, requiresTyped) => {
    TASKS = Array.from({ length: n }, (_, i) => task(`t${i}`, `Task ${i}`));
    render(<App />);
    await ready();

    fireEvent.click(trigger());
    if (requiresTyped) {
      expect(typedInput()).not.toBeNull();
    } else {
      expect(typedInput()).toBeNull();
    }
  });

  it('a location filter cannot shrink a 6-task list out of typed-confirm', async () => {
    LOCATIONS = [HOME, OFFICE];
    TASKS = Array.from({ length: 6 }, (_, i) => task(`t${i}`, `Task ${i}`, ['a'])); // all tagged Home
    render(<App />);
    await ready();

    // Filter to Office: all six vanish from the Lists view (visibleTasks for l1 = 0)...
    fireEvent.change(dropdown(), { target: { value: 'b' } });
    fireEvent.click(trigger());
    // ...but the blast radius is the FULL count (6), so the typed gate must still be present. If App
    // used visibleTasks (0), this would be a plain confirm — the undercount sabotage.
    expect(typedInput()).not.toBeNull();
  });

  it('plain confirm (<=5 tasks) deletes the list via the API', async () => {
    TASKS = [task('t0', 'Milk')]; // one task -> plain
    render(<App />);
    await ready();

    fireEvent.click(trigger());
    expect(typedInput()).toBeNull(); // plain: no typed gate
    fireEvent.click(screen.getByRole('button', { name: 'Delete list' })); // the dialog's confirm

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/lists/l1', expect.objectContaining({ method: 'DELETE' })),
    );
  });
});
