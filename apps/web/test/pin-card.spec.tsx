// @vitest-environment happy-dom
import type { Impact, List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { TICK_GRACE_MS } from '../src/tick';

/**
 * The impact safety-net pin card above the hand (ADRs 0075, 0086), wired end to end at the fetch boundary.
 * The pin is computed client-side from the playable set + declared impact + created date, minus the ids in
 * the hand, plus the SERVER's config (fuses) and snooze (each task's pinSnoozedUntil). Proves: it fires for
 * a qualifying not-in-hand task; None / too-new / already-in-hand don't; completion clears it; and snooze
 * hits the API optimistically (hides now), persists across a re-mount, returns after its span, and surfaces
 * the next-most-overdue.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];
const DAY = 86_400_000;
const DEFAULT_CONFIG = { highFuseDays: 7, mediumFuseDays: 30, highSnoozeDays: 1, mediumSnoozeDays: 3 };
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
const mk = (id: string, title: string, impact: Impact = 'none', daysAgo = 0): Task => ({
  id, title, listId: 'l1', ownerId: 'local', status: 'active', createdAt: iso(daysAgo),
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, checklist: [], effort: null,
  pinSnoozedUntil: null, impact,
});
// Five filler cards (impact none) — they fill the hand of 5, so a sixth playable task is NOT in it.
const FILLERS = ['a', 'b', 'c', 'd', 'e'].map((n) => mk(n, `Task ${n.toUpperCase()}`));

let todayTasks: Task[];
const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response);

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
          return okJson({ status: 'done' });
        }
        if (url.includes('/pin-snooze')) {
          // POST snoozes (server sets pinSnoozedUntil = now + span), DELETE clears it. Mutated in place so
          // it persists in the subsequent reads — the server-side snooze store, faked.
          const id = url.split('/')[3];
          const t = todayTasks.find((x) => x.id === id);
          if (t) {
            const span = t.impact === 'high' ? DEFAULT_CONFIG.highSnoozeDays : DEFAULT_CONFIG.mediumSnoozeDays;
            t.pinSnoozedUntil = method === 'POST' ? new Date(Date.now() + span * DAY).toISOString() : null;
            return okJson(t);
          }
        }
        return okJson({ status: 'done' });
      }
      if (url.includes('/api/settings/pin')) return okJson(DEFAULT_CONFIG);
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
      return okJson(body);
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
    todayTasks = [...FILLERS, mk('p', 'Task P', 'high', 10)];
    render(<App />);
    await gotoToday();
    expect(await screen.findByText('Task P')).toBeTruthy();
    expect(screen.getByText('high-impact · 10 days')).toBeTruthy();
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
    expect(screen.getByRole('button', { name: 'Complete Task P' })).toBeTruthy();
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
      vi.advanceTimersByTime(TICK_GRACE_MS);
    });
    await waitFor(() => expect(screen.queryByText('high-impact · 10 days')).toBeNull());
  });
});

describe('snoozing the pin — server-backed, optimistic (ADRs 0075, 0086)', () => {
  const NOW = Date.parse('2026-08-01T12:00:00.000Z');
  const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
  const withCreated = (t: Task, createdAt: string): Task => ({ ...t, createdAt });
  const snoozedUntil = (id: string): number | undefined => {
    const t = todayTasks.find((x) => x.id === id);
    return t?.pinSnoozedUntil ? Date.parse(t.pinSnoozedUntil) : undefined;
  };

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

  it('snoozing a HIGH pin hides it immediately and POSTs snoozedUntil = now + 1 day', async () => {
    todayTasks = [...FILLERS, withCreated(mk('p', 'Task P', 'high'), at(10))];
    render(<App />);
    await gotoTodayF();
    await screen.findByText('high-impact · 10 days');

    fireEvent.click(screen.getByRole('button', { name: 'Snooze Task P' }));
    await waitFor(() => expect(screen.queryByText(/high-impact ·/)).toBeNull());
    await waitFor(() => {
      const su = snoozedUntil('p') ?? 0;
      expect(su).toBeGreaterThanOrEqual(NOW + 1 * DAY); // High span = 1 day, server-set (± test-clock ms)
      expect(su).toBeLessThan(NOW + 1 * DAY + 60_000);
    });
  });

  it('snoozing a MEDIUM pin POSTs snoozedUntil = now + 3 days', async () => {
    todayTasks = [...FILLERS, withCreated(mk('m', 'Task M', 'medium'), at(40))];
    render(<App />);
    await gotoTodayF();
    await screen.findByText('medium-impact · 40 days');
    fireEvent.click(screen.getByRole('button', { name: 'Snooze Task M' }));
    await waitFor(() => expect(screen.queryByText(/medium-impact ·/)).toBeNull());
    await waitFor(() => {
      const su = snoozedUntil('m') ?? 0;
      expect(su).toBeGreaterThanOrEqual(NOW + 3 * DAY); // Medium span = 3 days (± test-clock ms)
      expect(su).toBeLessThan(NOW + 3 * DAY + 60_000);
    });
  });

  it('the snooze persists across a re-mount within its span (server state, not localStorage)', async () => {
    todayTasks = [...FILLERS, withCreated(mk('p', 'Task P', 'high'), at(10))];
    const first = render(<App />);
    await gotoTodayF();
    fireEvent.click(await screen.findByRole('button', { name: 'Snooze Task P' }));
    await waitFor(() => expect(screen.queryByText(/high-impact ·/)).toBeNull());

    first.unmount(); // a reload: App re-fetches; the task now carries pinSnoozedUntil from the server
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

    vi.setSystemTime(NOW + 2 * DAY); // past the 1-day span; the stored pinSnoozedUntil is now in the past
    fireEvent(window, new Event('focus')); // a refocus re-fetches + re-renders
    expect(await screen.findByText(/high-impact ·/)).toBeTruthy();
  });

  it('with two qualifiers, snoozing the shown one surfaces the next-most-overdue', async () => {
    todayTasks = [
      ...FILLERS,
      withCreated(mk('p1', 'Task P1', 'high'), at(20)),
      withCreated(mk('p2', 'Task P2', 'high'), at(10)),
    ];
    render(<App />);
    await gotoTodayF();
    await screen.findByText('high-impact · 20 days');
    fireEvent.click(screen.getByRole('button', { name: 'Snooze Task P1' }));
    expect(await screen.findByText('high-impact · 10 days')).toBeTruthy();
  });
});
