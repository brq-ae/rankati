// @vitest-environment happy-dom
import type { List, Location, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import App from '../src/App';
import { expectUsableEmptyState } from './support/empty-state';

/**
 * The zero-lists empty state (v0.13, ADR 0064). It is ONE state, keyed on `lists.length === 0`,
 * reached both by deleting the last list and by factory-reset-without-sample-data (step 8) — not two
 * per-route states that could drift. Both tests here assert the SAME two things, so "behaves
 * identically however reached" is the assertion, not a hope.
 *
 * FINDING this pins: list creation is only reachable through the add-task form's "+ New list…", and
 * `listId` was reset only on mount — so deleting the SELECTED (or last) list stranded the form at a
 * deleted id (the new-list-name input stayed hidden, and Add would POST to a dead list). The
 * deleted-list reset fixes it; test B reds without it.
 */
const task = (id: string, title: string): Task => ({
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
  locationIds: [],
  needsHand: false,
  checklist: [], effort: null, needsDetails: false, impact: 'none',
  ...({} as Partial<Task>),
});

let LISTS: List[] = [];
let TASKS: Task[] = [];
let LOCATIONS: Location[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const method = init?.method ?? 'GET';
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response);
      if (method === 'DELETE' && url.includes('/api/lists/')) {
        const id = url.split('/api/lists/')[1];
        LISTS = LISTS.filter((l) => l.id !== id);
        TASKS = TASKS.filter((t) => t.listId !== id); // the server cascade, mirrored
        return json({});
      }
      if (method !== 'GET') return json({});
      const body = url.includes('/api/locations')
        ? LOCATIONS
        : url.includes('/api/lists')
          ? LISTS
          : url.includes('/api/tasks')
            ? TASKS
            : undefined;
      if (body === undefined) throw new Error(`list-empty-state.spec: unstubbed ${url}`);
      return json(body);
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  LISTS = [];
  TASKS = [];
  LOCATIONS = [];
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('zero-lists empty state (v0.13)', () => {
  it('reached from a fresh load (zero lists): prompts, and list creation is reachable', async () => {
    render(<App />);
    await expectUsableEmptyState();
  });

  it('reached by deleting the last list: the SAME usable empty state', async () => {
    LISTS = [{ id: 'l1', name: 'Groceries', ownerId: 'local' }];
    TASKS = [task('t1', 'Milk'), task('t2', 'Eggs')]; // 2 tasks -> plain confirm
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete list Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete list' })); // the dialog's confirm

    // The finding-catcher: without the deleted-list reset, `listId` is still 'l1', the new-list-name
    // input is hidden, and this reds.
    await expectUsableEmptyState();
  });
});
