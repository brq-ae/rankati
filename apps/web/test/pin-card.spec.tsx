// @vitest-environment happy-dom
import type { Impact, List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { SNOOZES_KEY } from '../src/pin';
import { TICK_GRACE_MS } from '../src/tick';

/**
 * The impact safety-net pin card above the hand (ADR 0075), wired end to end at the fetch boundary.
 * The pin is computed client-side from the playable set + declared impact + created date, minus the
 * ids already in the hand. Proves: it fires for a qualifying not-in-hand task; None / too-new don't
 * fire; a qualifier already IN the hand does not fire; and the card reuses the shared TickCircle +
 * the detail-open path.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
const mk = (id: string, title: string, impact: Impact = 'none', daysAgo = 0): Task => ({
  id, title, listId: 'l1', ownerId: 'local', status: 'active', createdAt: iso(daysAgo),
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, checklist: [], effort: null,
  impact,
});
// Five filler cards (impact none) — they fill the hand of 5, so a sixth playable task is NOT in it.
const FILLERS = ['a', 'b', 'c', 'd', 'e'].map((n) => mk(n, `Task ${n.toUpperCase()}`));

let todayTasks: Task[];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        if (url.includes('/complete')) {
          const id = url.split('/')[3];
          todayTasks = todayTasks.filter((t) => t.id !== id); // completed → dropped from the reads
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
      if (body === undefined) throw new Error(`pin-card: unstubbed ${method} ${url}`);
      return Promise.resolve({
        ok: true, headers: { get: () => null }, json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

const gotoToday = async () => fireEvent.click(await screen.findByRole('button', { name: /^today$/i }));
const hasPin = () => screen.queryByText(/impact ·/) !== null;

describe('the impact pin card (ADR 0075)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('a qualifying High task NOT in the hand pins — one card above the hand, with its reason', async () => {
    // P is the 6th playable card, so the auto-dealt hand (5) does not include it.
    todayTasks = [...FILLERS, mk('p', 'Task P', 'high', 10)];
    render(<App />);
    await gotoToday();
    expect(await screen.findByText('Task P')).toBeTruthy();
    expect(screen.getByText('high-impact · 10 days')).toBeTruthy(); // the reason line
    // The pinned task is NOT one of the hand's list items (it is the card above them).
    const inHand = screen.getAllByRole('listitem').some((li) => li.textContent?.includes('Task P'));
    expect(inHand).toBe(false);
  });

  it("a 'none' task does not pin, however old", async () => {
    todayTasks = [...FILLERS, mk('p', 'Task P', 'none', 999)];
    render(<App />);
    await gotoToday();
    await screen.findByText('Task A');
    expect(hasPin()).toBe(false);
  });

  it('a High task under its fuse (3 days) does not pin', async () => {
    todayTasks = [...FILLERS, mk('p', 'Task P', 'high', 3)];
    render(<App />);
    await gotoToday();
    await screen.findByText('Task A');
    expect(hasPin()).toBe(false);
  });

  it('a qualifier already IN the hand does not pin (the not-in-hand exclusion, live)', async () => {
    // P is FIRST, so it is dealt into the hand of 5 → it must not also pin.
    todayTasks = [mk('p', 'Task P', 'high', 10), ...FILLERS.slice(0, 4)];
    render(<App />);
    await gotoToday();
    await screen.findByText('Task P');
    expect(hasPin()).toBe(false);
    const inHand = screen.getAllByRole('listitem').some((li) => li.textContent?.includes('Task P'));
    expect(inHand).toBe(true);
  });

  it('the pin card reuses TickCircle (Complete) and opens the detail on tap', async () => {
    todayTasks = [...FILLERS, mk('p', 'Task P', 'high', 10)];
    render(<App />);
    await gotoToday();
    await screen.findByText('high-impact · 10 days');
    // The shared completion control — NOT a parallel one.
    expect(screen.getByRole('button', { name: 'Complete Task P' })).toBeTruthy();
    // Tapping the card opens its detail (the same path as elsewhere).
    fireEvent.click(screen.getByRole('button', { name: 'Open details for Task P' }));
    expect(await screen.findByRole('dialog', { name: /Details for Task P/ })).toBeTruthy();
  });
});

describe('completing the pin clears it (ADR 0075 + 0055)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.unstubAllGlobals();
  });

  it('ticking the pin card completes it → no longer playable → the pin clears', async () => {
    todayTasks = [...FILLERS, mk('p', 'Task P', 'high', 10)];
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^today$/i }));
    await screen.findByText('high-impact · 10 days');

    fireEvent.click(await screen.findByRole('button', { name: 'Complete Task P' }));
    await act(async () => {
      vi.advanceTimersByTime(TICK_GRACE_MS); // the ring empties → commit → P dropped from the reads
    });
    await waitFor(() => expect(screen.queryByText('high-impact · 10 days')).toBeNull());
  });
});

describe('snoozing the pin (ADR 0075)', () => {
  const NOW = Date.parse('2026-08-01T12:00:00.000Z');
  const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
  const withCreated = (t: Task, createdAt: string): Task => ({ ...t, createdAt });
  const snoozedUntil = (id: string): number | undefined =>
    JSON.parse(localStorage.getItem(SNOOZES_KEY) ?? '{}')[id];

  beforeEach(() => {
    localStorage.clear();
    stubFetch();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.unstubAllGlobals();
  });

  const gotoTodayF = async () => fireEvent.click(await screen.findByRole('button', { name: /^today$/i }));

  it('snoozing a HIGH pin hides it and persists snoozedUntil ≈ now + 1 day', async () => {
    todayTasks = [...FILLERS, withCreated(mk('p', 'Task P', 'high'), at(10))];
    render(<App />);
    await gotoTodayF();
    await screen.findByText('high-impact · 10 days');

    fireEvent.click(screen.getByRole('button', { name: 'Snooze Task P' }));
    await waitFor(() => expect(screen.queryByText(/high-impact ·/)).toBeNull());
    const su = snoozedUntil('p')!;
    expect(su).toBeGreaterThanOrEqual(NOW + 1 * DAY); // High span = 1 day (± a few ms of test clock)
    expect(su).toBeLessThan(NOW + 1 * DAY + 60_000);
  });

  it('snoozing a MEDIUM pin persists snoozedUntil ≈ now + 3 days', async () => {
    todayTasks = [...FILLERS, withCreated(mk('m', 'Task M', 'medium'), at(40))]; // past the 30d fuse
    render(<App />);
    await gotoTodayF();
    await screen.findByText('medium-impact · 40 days');
    fireEvent.click(screen.getByRole('button', { name: 'Snooze Task M' }));
    await waitFor(() => expect(screen.queryByText(/medium-impact ·/)).toBeNull());
    const su = snoozedUntil('m')!;
    expect(su).toBeGreaterThanOrEqual(NOW + 3 * DAY); // Medium span = 3 days (± a few ms)
    expect(su).toBeLessThan(NOW + 3 * DAY + 60_000);
  });

  it('the snooze persists across a re-mount while still within its span', async () => {
    todayTasks = [...FILLERS, withCreated(mk('p', 'Task P', 'high'), at(10))];
    const first = render(<App />);
    await gotoTodayF();
    fireEvent.click(await screen.findByRole('button', { name: 'Snooze Task P' }));
    await waitFor(() => expect(screen.queryByText(/high-impact ·/)).toBeNull());

    first.unmount(); // a reload: App re-reads the snooze map from localStorage
    render(<App />);
    await gotoTodayF();
    await screen.findByText('Task A');
    expect(screen.queryByText(/high-impact ·/)).toBeNull(); // still snoozed
  });

  it('after the span elapses, the pin RETURNS', async () => {
    todayTasks = [...FILLERS, withCreated(mk('p', 'Task P', 'high'), at(10))];
    render(<App />);
    await gotoTodayF();
    fireEvent.click(await screen.findByRole('button', { name: 'Snooze Task P' }));
    await waitFor(() => expect(screen.queryByText(/high-impact ·/)).toBeNull());

    vi.setSystemTime(NOW + 2 * DAY); // past the 1-day span
    fireEvent(window, new Event('focus')); // a refocus re-reads + re-renders
    expect(await screen.findByText(/high-impact ·/)).toBeTruthy(); // it is back
  });

  it('with two qualifiers, snoozing the shown one surfaces the next-most-overdue', async () => {
    // P1 (20d → overdue 13) shows first; snoozing it must surface P2 (10d → overdue 3).
    todayTasks = [
      ...FILLERS,
      withCreated(mk('p1', 'Task P1', 'high'), at(20)),
      withCreated(mk('p2', 'Task P2', 'high'), at(10)),
    ];
    render(<App />);
    await gotoTodayF();
    await screen.findByText('high-impact · 20 days'); // P1 shown
    fireEvent.click(screen.getByRole('button', { name: 'Snooze Task P1' }));
    expect(await screen.findByText('high-impact · 10 days')).toBeTruthy(); // P2 takes its place
  });
});
