// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { HELD_IDS_KEY } from '../src/hand';

/**
 * The dealt hand wired into Today (ADR 0074), proved at the fetch boundary — App composes the hand
 * over `findToday`'s output. RE-PROVES the two load-bearing invariants through the wiring (not just
 * the pure module): NO AUTO-FILL (a completed card empties its slot, nothing new appears) and
 * TOP-UP-NOT-RE-DEAL (Deal again keeps held cards and fills only the freed slots). "Completing" a
 * card = the server dropping it from the Today read; App re-reads on focus, and the hand reflects it.
 *
 * Overdue pinning, inherited-urgency subtexts, and the block picker staying are covered by
 * today-view.spec (which now renders the hand) and today-block.spec.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];
const mk = (id: string, title: string): Task => ({
  id, title, listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, impact: 'none', checklist: [], effort: null,
});
// Seven playable cards, ranked A..G (the order the server hands them over).
const ALL = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => mk(n.toLowerCase(), `Task ${n}`));
const card = (letter: string) => `Task ${letter}`;

let todayTasks: Task[];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      let body: unknown;
      if (url.includes('/api/locations')) body = [];
      else if (url.includes('/api/lists')) body = LISTS;
      else if (url.includes('/api/tasks/today')) body = todayTasks;
      else if (url.includes('/api/tasks/upcoming')) body = [];
      else if (url.includes('/api/tasks')) body = todayTasks; // ranked Lists read
      else body = undefined;
      if (body === undefined) throw new Error(`hand-integration: unstubbed ${url}`);
      return Promise.resolve({
        ok: true, headers: { get: () => null }, json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

/** Simulate a completion: the server drops the card from the Today read; App re-reads on focus. */
const completeAndRefresh = async (id: string): Promise<void> => {
  todayTasks = todayTasks.filter((t) => t.id !== id);
  fireEvent(window, new Event('focus'));
};

const handTitles = (): string[] =>
  screen.getAllByRole('listitem').map((li) => li.textContent ?? '').filter((tx) => tx.includes('Task '));
const shows = (letter: string) => screen.queryByText(card(letter)) !== null;
/** App opens on Lists; the hand lives on the Today tab. */
const gotoToday = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: /^today$/i }));
};

describe('the dealt hand, wired (ADR 0074)', () => {
  beforeEach(() => {
    localStorage.clear();
    todayTasks = ALL.slice();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('auto-deals the first hand — the top-N (5), not the whole ranked list', async () => {
    render(<App />);
    await gotoToday();
    await screen.findByText(card('A'));
    for (const l of ['A', 'B', 'C', 'D', 'E']) expect(shows(l)).toBe(true);
    expect(shows('F')).toBe(false); // capped at N=5
    expect(shows('G')).toBe(false);
  });

  it('NO AUTO-FILL: completing a card empties its slot — N−1 shows, nothing new appears', async () => {
    render(<App />);
    await gotoToday();
    await screen.findByText(card('A')); // hand = A..E
    await completeAndRefresh('a'); // Task A completes
    await waitFor(() => expect(shows('A')).toBe(false));
    // Four cards remain; the next-best (F) is NOT pulled in.
    for (const l of ['B', 'C', 'D', 'E']) expect(shows(l)).toBe(true);
    expect(shows('F')).toBe(false);
    expect(handTitles()).toHaveLength(4);
  });

  it('TOP-UP-NOT-RE-DEAL: Deal again keeps held cards (even out-of-top-N) and fills only freed slots', async () => {
    // Hold C, D, and F — F is rank 6, OUTSIDE the current top-5. A fresh re-deal (top-5) would be
    // A,B,C,D,E: it would DROP the held F and add E. Top-up must keep F and add the next-best (A,B).
    localStorage.setItem(HELD_IDS_KEY, JSON.stringify(['c', 'd', 'f']));
    render(<App />);
    await gotoToday();
    await screen.findByText(card('C'));
    expect(handTitles()).toHaveLength(3); // C, D, F held; 2 empty slots

    fireEvent.click(screen.getByRole('button', { name: 'Deal again' }));

    await waitFor(() => expect(shows('A')).toBe(true)); // top-up pulled in the next-best not-held
    expect(shows('B')).toBe(true);
    expect(shows('F')).toBe(true); // the held out-of-top-N card SURVIVES...
    expect(shows('E')).toBe(false); // ...and the re-deal's pick (E) is NOT force-swapped in
    expect(handTitles()).toHaveLength(5);
  });

  it('WIN: clearing the hand shows "beat the deck"; Deal again starts the next round', async () => {
    localStorage.setItem(HELD_IDS_KEY, JSON.stringify(['a'])); // hold just Task A
    todayTasks = [ALL[0]!, ALL[1]!]; // A and B playable
    render(<App />);
    await gotoToday();
    await screen.findByText(card('A'));
    await completeAndRefresh('a'); // clear the held hand
    // Playable cards remain (B), so it is the WIN, not nothing-playable.
    expect(await screen.findByText(/beat the deck/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deal again' }));
    expect(await screen.findByText(card('B'))).toBeTruthy(); // next round dealt
  });

  it('NOTHING-PLAYABLE: no playable cards → the never-blank state, not a win', async () => {
    todayTasks = [];
    render(<App />);
    await gotoToday();
    expect(await screen.findByText(/Nothing active|Nothing playable/i)).toBeTruthy();
    expect(screen.queryByText(/beat the deck/i)).toBeNull();
  });
});
