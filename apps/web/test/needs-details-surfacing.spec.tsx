// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The "needs details" surfacing (ADR 0073): a header count-badge over the GLOBAL active flagged set,
 * and — on tapping it — a flat cross-list read of exactly those tasks (the 0069 pattern). Proved at
 * the fetch boundary; the stub mimics the server's clear-on-edit (any field PATCH clears the flag,
 * an explicit needsDetails is honored) so "a task leaves the view the moment it's edited" is real.
 */
const LISTS: List[] = [
  { id: 'l1', name: 'Work', ownerId: 'local' },
  { id: 'l2', name: 'Home', ownerId: 'local' },
];
const mk = (id: string, title: string, listId: string, needsDetails: boolean): Task => ({
  id, title, listId, ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails, checklist: [], effort: null, impact: 'none',
});

let tasks: Task[];

function stubFetch(initial: Task[]): void {
  tasks = initial.map((t) => ({ ...t }));
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const method = init?.method ?? 'GET';
      let body: unknown;
      if (method === 'PATCH' && /\/api\/tasks\/[^/]+$/.test(url)) {
        const id = url.split('/').pop() as string;
        const dto = JSON.parse(String(init?.body)) as Partial<Task>;
        tasks = tasks.map((t) =>
          t.id === id
            ? {
                ...t,
                ...dto,
                // Server rule (0073): an explicit needsDetails wins; ANY other field edit clears it.
                needsDetails: 'needsDetails' in dto ? (dto.needsDetails as boolean) : false,
              }
            : t,
        );
        body = tasks.find((t) => t.id === id);
      } else if (url.includes('/api/locations')) body = [];
      else if (url.includes('/api/lists')) body = LISTS;
      else if (url.includes('/api/tasks/today') || url.includes('/api/tasks/upcoming')) body = [];
      else if (url.includes('/api/tasks')) body = tasks;
      else body = undefined;
      if (body === undefined) throw new Error(`surfacing: unstubbed ${method} ${url}`);
      return Promise.resolve({
        ok: true, headers: { get: () => null }, json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

// Two flagged tasks in DIFFERENT lists (cross-list), one unflagged.
const FLAGGED_A = mk('t1', 'Flagged A', 'l1', true);
const PLAIN_B = mk('t2', 'Plain B', 'l1', false);
const FLAGGED_C = mk('t3', 'Flagged C', 'l2', true);

const badge = () => screen.queryByRole('button', { name: /needs? details$/ });

describe('needs-details surfacing (ADR 0073)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('the badge shows only when N>0, with the count of the flagged ACTIVE set', async () => {
    stubFetch([FLAGGED_A, PLAIN_B, FLAGGED_C]);
    render(<App />);
    const b = await screen.findByRole('button', { name: '2 tasks need details' }); // 2 flagged
    expect(b.textContent).toContain('✎ 2');
  });

  it('no badge when nothing is flagged', async () => {
    stubFetch([PLAIN_B, mk('t4', 'Plain D', 'l2', false)]);
    render(<App />);
    await screen.findByRole('button', { name: /start dueling/i }); // mount settled
    expect(badge()).toBeNull();
  });

  it('tapping the badge lists EXACTLY the flagged tasks, cross-list (not the unflagged)', async () => {
    stubFetch([FLAGGED_A, PLAIN_B, FLAGGED_C]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '2 tasks need details' }));
    // Both flagged, from both lists.
    expect(await screen.findByRole('button', { name: 'Add details to Flagged A' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add details to Flagged C' })).toBeTruthy();
    // The unflagged one is NOT here.
    expect(screen.queryByRole('button', { name: 'Add details to Plain B' })).toBeNull();
  });

  it('a task LEAVES the view the moment it is edited (flag cleared) — live', async () => {
    stubFetch([FLAGGED_A, FLAGGED_C]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '2 tasks need details' }));
    // Open Flagged A, rename it (a field edit → the server clears its flag).
    fireEvent.click(await screen.findByRole('button', { name: 'Add details to Flagged A' }));
    const dialog = await screen.findByRole('dialog', { name: /Details for/ });
    const title = within(dialog).getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'Flagged A — fleshed out' } });
    fireEvent.blur(title);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close details' }));

    // It is gone from the flat read; the badge count dropped to 1.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Add details to Flagged A' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Add details to Flagged C' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '1 task needs details' })).toBeTruthy();
  });

  it('any toggle segment exits back to the normal grid', async () => {
    stubFetch([FLAGGED_A, PLAIN_B, FLAGGED_C]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '2 tasks need details' }));
    await screen.findByRole('button', { name: 'Add details to Flagged A' });
    // Click "All" → the normal per-list grid returns (its (+) buttons appear), flat read gone.
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByRole('button', { name: 'Add a task to Work' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add details to Flagged A' })).toBeNull();
  });
});
