// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { authStatusResponse } from './support/auth';

/**
 * Clone a task (ADR 0079) — the trigger + scalar seeding. Proven at the fetch boundary: the clone icon
 * opens a seeded add-mode, and committing a title creates the task then PATCHes the seeded scalars. A
 * bail creates nothing (0073's no-orphan). Relations (locations/deps/checklist) are step 3.
 */
const LISTS: List[] = [
  { id: 'l1', name: 'Work', ownerId: 'local' },
  { id: 'l2', name: 'Home', ownerId: 'local' },
];
const base = (id: string, title: string, listId: string, over: Partial<Task> = {}): Task => ({
  id, title, listId, ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, impact: 'none', checklist: [], effort: null,
  ...over,
});
// Distinctive non-default scalars, so "they seed AND carry" is provable. No relations (the scalar cases).
const SOURCE = base('src', 'Weekly report', 'l1', {
  effort: 'medium', tier: 'important', impact: 'high',
  availabilityWindow: 'working_hours', notBefore: '2026-08-01', needsHand: true,
});
const LOCATIONS_API = [{ id: 'loc1', name: 'Office', ownerId: 'local' }];
const DEP = base('dep', 'Prerequisite', 'l1');
// A source WITH relations + a distinctive rating, for the relational cases. One checklist item starts
// DONE, to prove the clone copies items UNTICKED regardless of the source's state.
const SOURCE_REL = base('srcRel', 'Big report', 'l1', {
  rating: 1500,
  locationIds: ['loc1'],
  dependsOn: ['dep'],
  checklist: [
    { id: 'c1', taskId: 'srcRel', text: 'Gather data', done: true, position: 0, createdAt: '2026-07-16T12:00:00.000Z' },
    { id: 'c2', taskId: 'srcRel', text: 'Write intro', done: false, position: 1, createdAt: '2026-07-16T12:00:00.000Z' },
  ],
});

let tasks: Task[];
let created: Array<{ title: string; listId: string }>;
let patched: Array<{ id: string; dto: Record<string, unknown> }>;
let seq: number;
let ciSeq: number;

function stubFetch(): void {
  tasks = [SOURCE, SOURCE_REL, DEP];
  created = [];
  patched = [];
  seq = 0;
  ciSeq = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      let body: unknown;
      const idMatch = url.match(/\/api\/tasks\/([^/?]+)$/);
      const checklistMatch = url.match(/\/api\/tasks\/([^/?]+)\/checklist$/);
      if (method === 'POST' && checklistMatch) {
        const taskId = checklistMatch[1];
        const { text } = JSON.parse(String(init?.body)) as { text: string };
        // Created UNTICKED (done:false), like the real endpoint's default (ADR 0071/0079).
        const item = { id: `ci${++ciSeq}`, taskId, text, done: false, position: ciSeq - 1, createdAt: '2026-07-16T12:00:00.000Z' };
        tasks = tasks.map((t) => (t.id === taskId ? { ...t, checklist: [...t.checklist, item] } : t));
        body = item;
      } else if (method === 'POST' && url.endsWith('/api/tasks')) {
        const dto = JSON.parse(String(init?.body)) as { title: string; listId: string };
        created.push(dto);
        const t = base(`new${++seq}`, dto.title, dto.listId, { needsDetails: true }); // 0073 create-stamp
        tasks = [...tasks, t];
        body = t;
      } else if (method === 'PATCH' && idMatch) {
        const id = idMatch[1];
        const dto = JSON.parse(String(init?.body)) as Record<string, unknown>;
        patched.push({ id, dto });
        tasks = tasks.map((t) => {
          if (t.id !== id) return t;
          const next = { ...t, ...dto } as Task;
          // Server rule (ADR 0073): a field edit that isn't `needsDetails` clears the create-stamp.
          if (!('needsDetails' in dto) && Object.keys(dto).length > 0) next.needsDetails = false;
          return next;
        });
        body = tasks.find((t) => t.id === id);
      } else if (url.includes('/api/locations')) body = LOCATIONS_API;
      else if (url.includes('/api/lists')) body = LISTS;
      else if (url.includes('/api/tasks/today') || url.includes('/api/tasks/upcoming')) body = [];
      else if (url.includes('/api/tasks')) body = tasks;
      else body = undefined;
      if (body === undefined) throw new Error(`clone-task: unstubbed ${method} ${url}`);
      return Promise.resolve({ ok: true, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response);
    }),
  );
}

/** Open a task's detail by title, click Clone, return the clone dialog. */
async function openClone(sourceTitle = 'Weekly report'): Promise<HTMLElement> {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: `Open details for ${sourceTitle}` }));
  const detail = await screen.findByRole('dialog', { name: `Details for ${sourceTitle}` });
  fireEvent.click(within(detail).getByRole('button', { name: 'Clone task' }));
  return screen.findByRole('dialog', { name: 'Clone a task' });
}
const cloneOf = (title: string): Task | undefined => tasks.find((t) => t.title === title && t.id.startsWith('new'));

describe('clone a task — trigger + scalar seeding (ADR 0079)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders a Clone task icon in the detail modal, beside the flag', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Weekly report' }));
    const detail = await screen.findByRole('dialog', { name: 'Details for Weekly report' });
    expect(within(detail).getByRole('button', { name: 'Clone task' })).toBeTruthy();
    expect(within(detail).getByRole('button', { name: 'Flag as needs details' })).toBeTruthy(); // beside the flag
  });

  it('clicking Clone opens add-mode PRE-FILLED from the source, title blank', async () => {
    const clone = await openClone();
    expect((within(clone).getByLabelText('New task title') as HTMLInputElement).value).toBe('');
    expect((within(clone).getByRole('combobox') as HTMLSelectElement).value).toBe('l1'); // list
    expect((within(clone).getByLabelText('Not before') as HTMLInputElement).value).toBe('2026-08-01');

    const pressedIn = (group: string): string | null =>
      within(within(clone).getByRole('group', { name: group })).getByRole('button', { pressed: true }).textContent;
    expect(pressedIn('Effort bucket')).toBe('medium');
    expect(pressedIn('Impact level')).toBe('High');
    expect(pressedIn('Availability window')).toBe('Working hours');
    expect(within(clone).getByRole('button', { name: 'Set importance: Important', pressed: true })).toBeTruthy();
    expect(within(clone).getByRole('button', { name: /Needs a hand/, pressed: true })).toBeTruthy();
  });

  it('committing a title creates a task that CARRIES the seeded scalars', async () => {
    const clone = await openClone();
    const title = within(clone).getByLabelText('New task title');
    fireEvent.change(title, { target: { value: 'Monthly report' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => expect(created).toEqual([{ title: 'Monthly report', listId: 'l1' }]));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0].dto).toMatchObject({
      effort: 'medium',
      tier: 'important',
      impact: 'high',
      availabilityWindow: 'working_hours',
      notBefore: '2026-08-01',
      needsHand: true,
      due: null,
    });
  });

  it('closing the clone with an empty title creates NOTHING — no orphan', async () => {
    const clone = await openClone();
    fireEvent.click(within(clone).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Clone a task' })).toBeNull());
    expect(created).toHaveLength(0);
    expect(patched).toHaveLength(0);
  });

  it('the clone lands NOT flagged needs-details', async () => {
    const clone = await openClone();
    const title = within(clone).getByLabelText('New task title');
    fireEvent.change(title, { target: { value: 'Monthly report' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    // Flips to live-edit on the new task; the flag shows its UNFLAGGED label.
    const edited = await screen.findByRole('dialog', { name: 'Details for Monthly report' });
    expect(within(edited).getByRole('button', { name: 'Flag as needs details' })).toBeTruthy();
    expect(within(edited).queryByRole('button', { name: 'Needs details — tap to clear' })).toBeNull();
  });

  it('carries the SAME locations + dependency, and the checklist COPIED but UNTICKED', async () => {
    const clone = await openClone('Big report'); // the source WITH relations
    const title = within(clone).getByLabelText('New task title');
    fireEvent.change(title, { target: { value: 'Big report v2' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => expect(cloneOf('Big report v2')).toBeDefined());
    const made = cloneOf('Big report v2')!;
    expect(made.locationIds).toEqual(['loc1']); // same location tags
    expect(made.dependsOn).toEqual(['dep']); // same prerequisite link
    // Checklist copied by text, ALL unticked — even the source item that was done.
    expect(made.checklist.map((c) => ({ text: c.text, done: c.done }))).toEqual([
      { text: 'Gather data', done: false },
      { text: 'Write intro', done: false },
    ]);
  });

  it("the clone's rating starts FRESH — it does not inherit the source's", async () => {
    const clone = await openClone('Big report');
    const title = within(clone).getByLabelText('New task title');
    fireEvent.change(title, { target: { value: 'Big report v2' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => expect(cloneOf('Big report v2')).toBeDefined());
    expect(cloneOf('Big report v2')!.rating).toBe(1000); // fresh default
    expect(cloneOf('Big report v2')!.rating).not.toBe(SOURCE_REL.rating); // never the source's 1500
  });

  it('bailing on a relational source creates NOTHING — no task, no relations', async () => {
    const clone = await openClone('Big report');
    fireEvent.click(within(clone).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Clone a task' })).toBeNull());
    expect(created).toHaveLength(0);
    expect(patched).toHaveLength(0);
    expect(ciSeq).toBe(0); // no checklist items created
  });
});
