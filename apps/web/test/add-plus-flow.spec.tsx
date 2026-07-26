// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The per-list `(+)` full-detail add (ADR 0073), proved end to end at the fetch boundary — App
 * reaches the network through api.ts, so the request it makes is the contract. The `(+)` opens the
 * detail modal in ADD MODE for a list; the first non-empty title POSTs `createTask({title, listId})`
 * and the modal flips to live-edit on the new id; an empty-title close creates NOTHING.
 */
const LISTS: List[] = [
  { id: 'l1', name: 'Work', ownerId: 'local' },
  { id: 'l2', name: 'Home', ownerId: 'local' },
];
const mk = (id: string, title: string, listId: string): Task => ({
  id, title, listId, ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, impact: 'none', checklist: [], effort: null,
});

let tasks: Task[];
let created: Array<{ title: string; listId: string }>;
let seq: number;

function stubFetch(): void {
  tasks = [mk('t1', 'Existing', 'l1')];
  created = [];
  seq = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const method = init?.method ?? 'GET';
      let body: unknown;
      if (method === 'POST' && url.includes('/api/tasks')) {
        const dto = JSON.parse(String(init?.body)) as { title: string; listId: string };
        created.push(dto);
        const t = { ...mk(`new${++seq}`, dto.title, dto.listId), needsDetails: true };
        tasks = [...tasks, t];
        body = t;
      } else if (url.includes('/api/locations')) body = [];
      else if (url.includes('/api/lists')) body = LISTS;
      else if (url.includes('/api/tasks/today') || url.includes('/api/tasks/upcoming')) body = [];
      else if (url.includes('/api/tasks')) body = tasks; // ranked / plain lists read
      else body = undefined;
      if (body === undefined) throw new Error(`add-plus-flow: unstubbed ${method} ${url}`);
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

const posts = (): Array<{ title: string; listId: string }> => created;

describe('the per-list (+) full-detail add (ADR 0073)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens add mode for the CLICKED list, creates on first title, and flips to live-edit', async () => {
    render(<App />);
    // The (+) for the "Home" list (l2), NOT "Work".
    const plus = await screen.findByRole('button', { name: 'Add a task to Home' });
    fireEvent.click(plus);

    // Add mode: the modal is open with a title field and no task yet.
    const dialog = await screen.findByRole('dialog', { name: 'Add a task' });
    const title = within(dialog).getByLabelText('New task title');
    // Nothing created just by opening.
    expect(posts()).toHaveLength(0);

    fireEvent.change(title, { target: { value: 'Buy milk' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    // It POSTed once, to the CLICKED list (l2 = Home).
    await waitFor(() => expect(posts()).toEqual([{ title: 'Buy milk', listId: 'l2' }]));

    // ...and flipped to live-edit: the full editor is now shown (the Importance tier group appears,
    // which add mode never renders). findBy* for the post-effect re-mount (release-gate flake rule).
    expect(await screen.findByRole('group', { name: 'Importance tier' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Add a task' })).toBeNull(); // no longer add mode
  });

  it('closed with an empty title creates NOTHING — no orphan', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a task to Work' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a task' });
    // Close via the Cancel button without typing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a task' })).toBeNull());
    expect(posts()).toHaveLength(0);
  });

  it('the top quick-add form still creates via its own path (untouched)', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /start dueling/i });
    // The quick-add form's own input + Add button — the fast path, unchanged by (+).
    const quick = screen.getByPlaceholderText(/what needs doing|add a task|task title/i);
    fireEvent.change(quick, { target: { value: 'Quick one' } });
    fireEvent.submit(quick.closest('form') as HTMLFormElement);
    await waitFor(() => expect(posts().some((p) => p.title === 'Quick one')).toBe(true));
  });
});
