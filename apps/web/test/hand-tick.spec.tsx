// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { TICK_GRACE_MS } from '../src/tick';

/**
 * Playing a card FROM the hand (ADR 0074 + 0055) — the same tick/undo ring Lists uses, now on the
 * hand card. Completing empties the slot with NO auto-fill (structural), and the 15s undo restores
 * it (the id stays in heldIds). Fake timers throughout, like tick-ring.spec.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];
const mk = (id: string, title: string): Task => ({
  id, title, listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-17T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, impact: 'none', checklist: [], effort: null,
});
const ALL = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => mk(n.toLowerCase(), `Task ${n}`));
const card = (l: string) => `Task ${l}`;

let todayTasks: Task[];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        // A commit (PATCH /complete): the task is now done, so the server drops it from the reads.
        if (url.includes('/complete')) {
          const id = url.split('/')[3];
          todayTasks = todayTasks.filter((t) => t.id !== id);
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
              ? todayTasks
              : undefined;
      if (body === undefined) throw new Error(`hand-tick: unstubbed ${url}`);
      return Promise.resolve({
        ok: true, headers: { get: () => null }, json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

const gotoToday = async () => fireEvent.click(await screen.findByRole('button', { name: /^today$/i }));
const shows = (l: string) => screen.queryByText(card(l)) !== null;
const handCount = () =>
  screen.getAllByRole('listitem').map((li) => li.textContent ?? '').filter((tx) => tx.includes('Task ')).length;
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  localStorage.clear();
  todayTasks = ALL.slice();
  stubFetch();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

describe('completing a card from the hand (ADR 0074 + 0055)', () => {
  it('tick a hand card → after the ring commits, the slot empties (N−1) and nothing refills', async () => {
    render(<App />);
    await gotoToday();
    await screen.findByText(card('A')); // hand = A..E (5)
    expect(handCount()).toBe(5);

    // Play Task A from the hand — the same "Complete X" control as Lists.
    fireEvent.click(await screen.findByRole('button', { name: 'Complete Task A' }));
    await advance(TICK_GRACE_MS); // the ring empties → commit → server drops A → App re-reads

    await waitFor(() => expect(shows('A')).toBe(false));
    expect(handCount()).toBe(4); // N−1, its slot empty
    expect(shows('F')).toBe(false); // the next-best is NOT auto-filled
    for (const l of ['B', 'C', 'D', 'E']) expect(shows(l)).toBe(true);
  });

  it('the 15s undo restores the card to its slot (id stays in heldIds)', async () => {
    render(<App />);
    await gotoToday();
    await screen.findByText(card('A'));

    fireEvent.click(await screen.findByRole('button', { name: 'Complete Task A' }));
    // Undo BEFORE the ring empties — nothing is committed, the card stays.
    fireEvent.click(await screen.findByRole('button', { name: 'Undo completing Task A' }));
    await advance(TICK_GRACE_MS * 2); // time passes; the reverted tick must NOT commit

    expect(shows('A')).toBe(true); // restored to its slot
    expect(handCount()).toBe(5);
  });
});
