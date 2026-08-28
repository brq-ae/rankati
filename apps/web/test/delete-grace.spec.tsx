// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { TICK_GRACE_MS } from '../src/tick';

/**
 * Deleting a task gets the tick's 15s grace (ADR 0092, mirrors 0055). The ✕ starts a client-side grace;
 * the real DELETE fires ONLY at commit (ring-end or on-leave, keepalive), so an undo inside the window
 * writes nothing. Pending-deletes are hidden from the Today hand; a delete supersedes a pending tick.
 * Fake timers throughout, like hand-tick.spec.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];
const mk = (id: string, title: string): Task => ({
  id, title, listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-17T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, impact: 'none', checklist: [], effort: null,
});
let serverTasks: Task[];
const calls: { method: string; url: string }[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        calls.push({ method, url });
        if (method === 'DELETE') {
          const id = url.split('/api/tasks/')[1]?.split(/[/?]/)[0];
          serverTasks = serverTasks.filter((t) => t.id !== id);
        }
        return Promise.resolve({
          ok: true, headers: { get: () => null }, json: () => Promise.resolve({ status: 'done' }),
        } as unknown as Response);
      }
      const body = url.includes('/api/locations')
        ? []
        : url.includes('/api/lists')
          ? LISTS
          : url.includes('/api/tasks/upcoming')
            ? []
            : url.includes('/api/tasks')
              ? serverTasks
              : undefined;
      if (body === undefined) throw new Error(`delete-grace: unstubbed ${url}`);
      return Promise.resolve({
        ok: true, headers: { get: () => null }, json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

const del = (title: string) => screen.findByRole('button', { name: `Delete ${title}` });
const deletes = () => calls.filter((c) => c.method === 'DELETE');
const completes = () => calls.filter((c) => c.url.includes('/complete'));
const gotoToday = async () => fireEvent.click(await screen.findByRole('button', { name: /^today$/i }));
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  localStorage.clear();
  serverTasks = [mk('a', 'Task A'), mk('b', 'Task B'), mk('c', 'Task C')];
  calls.length = 0;
  stubFetch();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

describe('deleting a task with a 15s grace (ADR 0092)', () => {
  it('the ✕ defers — no DELETE at tap; the real DELETE fires only when the ring ends', async () => {
    render(<App />);
    fireEvent.click(await del('Task A'));
    expect(deletes()).toHaveLength(0); // nothing written at tap
    await advance(TICK_GRACE_MS); // ring ends → commit
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0].url).toContain('/api/tasks/a');
  });

  it('undo inside the window writes NOTHING (the ring toggles it back)', async () => {
    render(<App />);
    fireEvent.click(await del('Task A')); // start grace — the ✕ becomes the undo ring
    fireEvent.click(await screen.findByRole('button', { name: 'Undo deleting Task A' })); // undo, nothing written
    await advance(TICK_GRACE_MS * 2); // the reverted delete must NOT commit
    expect(deletes()).toHaveLength(0);
    expect(screen.queryByText('Task A')).not.toBeNull(); // still there
  });

  it('a pending-delete is hidden from the Today hand for the grace', async () => {
    render(<App />);
    fireEvent.click(await del('Task A')); // Lists view, start the grace
    await gotoToday();
    await screen.findByText('Task B');
    expect(screen.queryByText('Task A')).toBeNull(); // excluded from the hand while pending-delete
    expect(deletes()).toHaveLength(0); // still deferred
  });

  it('leaving the page commits the pending delete (keepalive)', async () => {
    render(<App />);
    fireEvent.click(await del('Task A'));
    expect(deletes()).toHaveLength(0);
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(deletes()).toHaveLength(1)); // flushed on leave
    expect(deletes()[0].url).toContain('/api/tasks/a');
  });

  it('deleting a task mid-pending-tick SUPERSEDES the tick — only the delete commits', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete Task A' })); // start pending tick
    fireEvent.click(await del('Task A')); // delete supersedes it
    await advance(TICK_GRACE_MS);
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(completes()).toHaveLength(0); // the tick never committed
  });
});

describe('the pending-delete row affordance (ADR 0092 S2)', () => {
  const titleBtn = (title: string) => screen.getByRole('button', { name: `Open details for ${title}` });

  it('the ✕ becomes the undo ring while pending — accessible name flips', async () => {
    render(<App />);
    fireEvent.click(await del('Task A'));
    expect(screen.queryByRole('button', { name: 'Delete Task A' })).toBeNull(); // ✕ gone
    expect(screen.getByRole('button', { name: 'Undo deleting Task A' })).not.toBeNull(); // ring/undo
  });

  it('the row stays in place, struck/greyed, while pending', async () => {
    render(<App />);
    await del('Task A'); // ensure loaded
    fireEvent.click(await del('Task A'));
    expect(screen.queryByText('Task A')).not.toBeNull(); // in place, title still readable
    expect(titleBtn('Task A').className).toContain('line-through');
  });

  it('tapping the ring restores the row (✕ back, un-struck, nothing deleted)', async () => {
    render(<App />);
    fireEvent.click(await del('Task A'));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo deleting Task A' }));
    expect(screen.getByRole('button', { name: 'Delete Task A' })).not.toBeNull(); // ✕ restored
    expect(titleBtn('Task A').className).not.toContain('line-through'); // un-struck
    expect(deletes()).toHaveLength(0);
  });
});
