// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The Lists screen's v0.5 additions (ADR 0053): the dependency stopgap, the marker saying
 * it is a stopgap, the unblock heads-up before a delete, and list rename.
 *
 * `fetch` is stubbed at the boundary App really uses, and every endpoint is answered
 * explicitly — an unstubbed request throws rather than quietly returning the wrong body.
 */

const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];

const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({
  id,
  title,
  listId: 'l1',
  ownerId: 'local',
  status: 'active',
  createdAt: '2026-07-17T12:00:00.000Z',
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
  ...over,
});

let TASKS: Task[] = [];
let patched: { url: string; body: unknown }[] = [];

function stubFetch(): void {
  patched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      if (init?.method === 'PATCH' || init?.method === 'DELETE') {
        patched.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
        return Promise.resolve({
          ok: true,
          headers: { get: () => null },
          json: () => Promise.resolve(TASKS[0]),
        } as unknown as Response);
      }
      const body = url.includes('/api/locations') ? [] : url.includes('/api/lists')
        ? LISTS
        : url.includes('/api/tasks')
          ? TASKS.filter((t) => t.status === 'active' && t.dependsOn.length === 0)
          : undefined;
      const full = url.includes('/api/tasks?sort=rating') ? TASKS : body;
      if (full === undefined) throw new Error(`lists-ui.spec: unstubbed request to ${url}`);
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve(full),
      } as unknown as Response);
    }),
  );
}

const ready = async () => {
  await screen.findByRole('button', { name: /start dueling/i });
  // The Arena's "start dueling" renders ABOVE the loading gate, so waiting for it does NOT mean the
  // task rows have painted. Wait for the data too, or a getBy on a row races the unpainted list
  // (the tick-ring flake, class-fixed across specs).
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
};

beforeEach(() => {
  localStorage.clear();
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the row shows what a task requires, read-only (0053, 0054)', () => {
  it('names each prerequisite', async () => {
    // The row still explains a blocked task's absence from Today — 0053's "the
    // disagreement is the feature, if you can tell".
    TASKS = [task('b', 'Blocker'), task('a', 'Alpha', { dependsOn: ['b'] })];
    render(<App />);
    await ready();
    expect(screen.getByText(/Requires: Blocker/)).toBeTruthy();
  });

  it('offers no editing — that moved to the detail view (v0.5.1)', async () => {
    // The v0.5 stopgap dropdown and its per-row remove button are gone. Two edit paths for
    // one thing is what this milestone removed; the detail view is the home (0054).
    TASKS = [task('b', 'Blocker'), task('a', 'Alpha', { dependsOn: ['b'] }), task('c', 'Free')];
    render(<App />);
    await ready();

    expect(screen.queryByRole('button', { name: /requires/i })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Choose what/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop Alpha requiring/i })).toBeNull();
    // ...and the way in is still there.
    expect(screen.getByRole('button', { name: /Open details for Alpha/i })).toBeTruthy();
  });

  it('no longer claims to be a stopgap, because it is not one', async () => {
    // The v0.5 marker promised "they move into the task detail view in v0.5.1". Kept.
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();
    expect(screen.queryByText(/stopgap/i)).toBeNull();
  });
});

describe('deleting a blocker warns first (0053)', () => {
  it('says how many tasks it will unblock, and does nothing if declined', async () => {
    TASKS = [task('b', 'Blocker'), task('a', 'Alpha', { dependsOn: ['b'] }), task('c', 'Gamma', { dependsOn: ['b'] })];
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: /Delete Blocker/i }));

    expect(confirm).toHaveBeenCalledWith('This will unblock 2 tasks. Delete anyway?');
    // Declined means nothing happened at all.
    expect(patched.filter((p) => p.url.includes('/api/tasks/b'))).toHaveLength(0);
  });

  it('says "task", singular, for one', async () => {
    TASKS = [task('b', 'Blocker'), task('a', 'Alpha', { dependsOn: ['b'] })];
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    render(<App />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Delete Blocker/i }));
    expect(confirm).toHaveBeenCalledWith('This will unblock 1 task. Delete anyway?');
  });

  it('does NOT warn when the task blocks nothing', async () => {
    TASKS = [task('a', 'Alpha'), task('b', 'Beta')];
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: /Delete Alpha/i }));
    expect(confirm).not.toHaveBeenCalled();
    expect(patched.some((p) => p.url.includes('/api/tasks/a'))).toBe(true);
  });
});

describe('list rename — the v0.1 gap', () => {
  it('renames a list inline, like a task', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: /Rename list Work/i }));
    const input = screen.getByRole('textbox', { name: /Rename list Work/i });
    fireEvent.change(input, { target: { value: 'Errands' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const call = patched.find((p) => p.url.includes('/api/lists/l1'));
    expect(call?.body).toEqual({ name: 'Errands' });
  });

  it('Escape cancels without saving', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: /Rename list Work/i }));
    const input = screen.getByRole('textbox', { name: /Rename list Work/i });
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(patched.filter((p) => p.url.includes('/api/lists/'))).toHaveLength(0);
  });
});

describe('the availability window is a visible row marker (0070 catch-up)', () => {
  // Fake timers so localDay()/localTime() (read straight off the wall clock, matching the
  // not-before marker's own discipline) answer a chosen instant instead of whenever the
  // suite happens to run. shouldAdvanceTime: true, exactly as tick-ring.spec's fake-timer
  // block — the fetch stub's promises still need real microtask/setTimeout progress to
  // settle, or findByRole/waitFor above (ready()) would hang.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is amber, in the not-before waiting treatment, when the window is shut right now', async () => {
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z')); // Wednesday — a workday
    TASKS = [task('a', 'Alpha', { availabilityWindow: 'weekend' })]; // shut on a workday
    render(<App />);
    await ready();

    const marker = screen.getByLabelText('Availability: Weekend');
    expect(marker.textContent).toContain('Weekend');
    // The SHARED class, not a lookalike — the same treatment the not-before marker uses.
    expect(marker.className).toContain('text-not-before');
    expect(marker.className).toContain('ring-not-before-edge');
  });

  it('is plain when the window is open right now', async () => {
    vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z')); // Saturday — inside the weekend window
    TASKS = [task('a', 'Alpha', { availabilityWindow: 'weekend' })];
    render(<App />);
    await ready();

    const marker = screen.getByLabelText('Availability: Weekend');
    expect(marker.className).toContain('text-faint');
    expect(marker.className).not.toContain('text-not-before');
  });

  it('is absent entirely for a windowless task (Anytime)', async () => {
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'));
    TASKS = [task('a', 'Alpha')]; // availabilityWindow: null
    render(<App />);
    await ready();

    expect(screen.queryByLabelText(/^Availability:/)).toBeNull();
  });
});

describe('the needs-a-hand row marker is a plain label, never amber (ADR 0071)', () => {
  it('shows "🤝 needs a hand" for a flagged task, in the PLAIN treatment', async () => {
    TASKS = [task('a', 'Alpha', { needsHand: true })];
    render(<App />);
    await ready();

    const marker = screen.getByLabelText('Needs a hand');
    expect(marker.textContent).toContain('needs a hand');
    // Plain/muted only — amber (text-not-before) means "currently held back", and this soft
    // label never holds anything back (0071), so it must never carry that class.
    expect(marker.className).toContain('text-faint');
    expect(marker.className).not.toContain('text-not-before');
  });

  it('is absent entirely for an unflagged task', async () => {
    TASKS = [task('a', 'Alpha', { needsHand: false })];
    render(<App />);
    await ready();

    expect(screen.queryByLabelText('Needs a hand')).toBeNull();
  });
});
