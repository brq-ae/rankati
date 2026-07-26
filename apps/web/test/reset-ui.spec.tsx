// @vitest-environment happy-dom
import type { List, Location, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { LOCATION_ID_KEY, LOCATION_PINNED_KEY } from '../src/location-filter';
import { expectUsableEmptyState } from './support/empty-state';

/**
 * The Settings reset UI (v0.13, ADR 0064): two modes behind the typed-DELETE confirmation, wired to
 * POST /api/reset. Verifies the mode/keepSampleData/confirm the client sends, that FACTORY clears the
 * pinned location filter while clear-tasks leaves it (the "clear the pin when its target may not
 * survive" rule), and that factory-reset-without-sample-data lands on the SAME empty state as
 * deleting the last list — proven by calling the shared expectUsableEmptyState, not by eyeballing.
 */
const task = (id: string, title: string, listId = 'l1'): Task => ({
  id,
  title,
  listId,
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
let lastReset: Record<string, unknown> | null = null;

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const method = init?.method ?? 'GET';
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response);
      if (method === 'POST' && url.endsWith('/api/reset')) {
        const dto = JSON.parse(String(init?.body ?? '{}')) as {
          mode?: string;
          keepSampleData?: boolean;
        };
        lastReset = dto;
        if (dto.mode === 'factory') {
          LISTS = dto.keepSampleData ? [{ id: 'sA', name: 'Task List A', ownerId: 'local' }] : [];
          TASKS = dto.keepSampleData ? [task('s1', 'Task 1', 'sA')] : [];
        } else {
          TASKS = []; // clear-tasks: lists survive, tasks go
        }
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
      if (body === undefined) throw new Error(`reset-ui.spec: unstubbed ${url}`);
      return json(body);
    }),
  );
}

const settle = async () => {
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
};
const openSettings = () => fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
const typeConfirm = () =>
  fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });

function pinLocation(id: string) {
  localStorage.setItem(LOCATION_PINNED_KEY, '1');
  localStorage.setItem(LOCATION_ID_KEY, id);
}

beforeEach(() => {
  localStorage.clear();
  LISTS = [{ id: 'l1', name: 'Groceries', ownerId: 'local' }];
  TASKS = [task('t1', 'Milk'), task('t2', 'Eggs'), task('t3', 'Bread')];
  LOCATIONS = [{ id: 'a', name: 'Home', ownerId: 'local' }];
  lastReset = null;
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Settings reset UI (v0.13)', () => {
  it('clear-tasks: typed-gated, POSTs mode clear-tasks, and LEAVES the pinned filter', async () => {
    pinLocation('a');
    render(<App />);
    await settle();

    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Clear tasks' })); // the settings trigger
    // Reset is always typed — the gate must be present.
    expect(screen.queryByLabelText('Type DELETE to confirm')).not.toBeNull();
    typeConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Clear tasks' })); // the dialog's confirm

    await waitFor(() =>
      expect(lastReset).toEqual({ mode: 'clear-tasks', keepSampleData: true, confirm: 'DELETE' }),
    );
    // clear-tasks leaves locations alone, so the pin (target still valid) survives.
    expect(localStorage.getItem(LOCATION_PINNED_KEY)).toBe('1');
    expect(localStorage.getItem(LOCATION_ID_KEY)).toBe('a');
  });

  it('factory reset (keep sample ticked by default) POSTs keepSampleData: true', async () => {
    render(<App />);
    await settle();

    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Factory reset' }));
    typeConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Factory reset' }));

    await waitFor(() =>
      expect(lastReset).toEqual({ mode: 'factory', keepSampleData: true, confirm: 'DELETE' }),
    );
  });

  it('factory reset CLEARS the pinned filter (its target may not survive)', async () => {
    pinLocation('a');
    render(<App />);
    await settle();

    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Factory reset' }));
    typeConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Factory reset' }));

    await waitFor(() => expect(lastReset?.mode).toBe('factory'));
    expect(localStorage.getItem(LOCATION_PINNED_KEY)).toBe('0');
    expect(localStorage.getItem(LOCATION_ID_KEY)).toBeNull();
  });

  it('factory reset with sample data UNTICKED lands on the SAME empty state as deleting the last list', async () => {
    render(<App />);
    await settle();

    openSettings();
    fireEvent.click(screen.getByLabelText('Keep sample data')); // untick
    fireEvent.click(screen.getByRole('button', { name: 'Factory reset' }));
    typeConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Factory reset' }));

    await waitFor(() =>
      expect(lastReset).toEqual({ mode: 'factory', keepSampleData: false, confirm: 'DELETE' }),
    );
    await expectUsableEmptyState(); // the SAME assertion the delete-last-list path uses
  });
});
