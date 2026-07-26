// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The free-block picker wired through the whole app (ADR 0072), proved at the fetch boundary like
 * clock-context.spec — App reaches the network through api.ts, so the URLs it ACTUALLY requests are
 * the contract. Three properties:
 *
 *   - DEFAULT-NEUTRAL: on mount the Today read carries NO block (Any) — the safety property, so a
 *     fresh session ranks exactly as before the term existed.
 *   - RE-RANK: choosing a block re-fetches Today with the ordinal and renders the server's new order
 *     (here the stub sinks the too-big task), and ONLY the ordinal crosses the wire — never minutes.
 *   - NOT STICKY: the block lives in ephemeral state, so a remount (a reload) is back on Any and the
 *     Today read again carries no block. A sticky block would be a lying view — the property 0072 names.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];
const mk = (id: string, title: string, effort: Task['effort']): Task => ({
  id, title, listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, impact: 'none', checklist: [], effort,
});
// Big leads Small with no block; a Quick block sinks Big below Small (what the server does — 0072).
const BIG = mk('big', 'Alpha big', 'long');
const SMALL = mk('small', 'Beta small', 'quick');
const DEFAULT_ORDER = [BIG, SMALL];
const BLOCKED_ORDER = [SMALL, BIG];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const body = url.includes('/api/locations')
        ? []
        : url.includes('/api/lists')
          ? LISTS
          : url.includes('/api/tasks/today')
            ? url.includes('block=') // the server re-ranks when a block is set
              ? BLOCKED_ORDER
              : DEFAULT_ORDER
            : url.includes('/api/tasks/upcoming')
              ? []
              : url.includes('/api/tasks')
                ? DEFAULT_ORDER // Lists (ranked)
                : undefined;
      if (body === undefined) throw new Error(`today-block.spec: unstubbed request to ${url}`);
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

const todayUrls = (): string[] =>
  vi.mocked(fetch).mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/tasks/today'));
const allUrls = (): string[] => vi.mocked(fetch).mock.calls.map((c) => String(c[0]));

/** The rendered Today order, by which fixture title each listitem is about. */
const order = (): string[] =>
  screen.getAllByRole('listitem').map((li) =>
    [BIG, SMALL].map((t) => t.title).find((t) => li.textContent?.includes(t)) ?? '?',
  );

const gotoToday = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /^today$/i }));
};
const blockButton = (name: string) =>
  within(screen.getByRole('group', { name: 'Free block' })).getByRole('button', {
    name: `Free block: ${name}`,
  });

describe('the free-block picker, end to end (ADR 0072)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('mounts on Any — the first Today read carries NO block (default-neutral)', async () => {
    render(<App />);
    await gotoToday();
    await screen.findByText('Alpha big');
    // Every Today read so far is un-blocked, and Any is the pressed choice.
    expect(todayUrls().length).toBeGreaterThan(0);
    for (const u of todayUrls()) expect(u).not.toContain('block=');
    expect(blockButton('Any').getAttribute('aria-pressed')).toBe('true');
    expect(order()).toEqual(['Alpha big', 'Beta small']);
  });

  it('choosing a block re-ranks the hand and sends ONLY the ordinal — never minutes', async () => {
    render(<App />);
    await gotoToday();
    await screen.findByText('Alpha big');

    fireEvent.click(blockButton('Quick: up to 15 min'));

    // findBy* for the post-effect order (the release-gate flake rule): the too-big task sinks.
    await screen.findByText('Beta small');
    expect(order()).toEqual(['Beta small', 'Alpha big']);
    expect(blockButton('Quick: up to 15 min').getAttribute('aria-pressed')).toBe('true');

    // The block request carries the ORDINAL bucket, and nothing else about size.
    const blocked = todayUrls().filter((u) => u.includes('block='));
    expect(blocked.length).toBeGreaterThan(0);
    for (const u of blocked) expect(u).toContain('block=quick');
    // No minutes anywhere on the wire — thresholds are display-only (0072).
    for (const u of allUrls()) {
      expect(u).not.toMatch(/block=\d/); // never a minute count as the block
      expect(u).not.toContain('quickMax');
      expect(u).not.toContain('mediumMax');
    }
  });

  it('is NOT sticky: a remount is back on Any, no block sent (not a lying view)', async () => {
    const first = render(<App />);
    await gotoToday();
    await screen.findByText('Alpha big');
    fireEvent.click(blockButton('Quick: up to 15 min'));
    await screen.findByText('Beta small'); // a block is set this session

    // Simulate a reload: unmount, forget the calls, mount fresh. Ephemeral state resets to Any.
    first.unmount();
    vi.mocked(fetch).mockClear();
    render(<App />);
    await gotoToday();
    await screen.findByText('Alpha big');

    for (const u of todayUrls()) expect(u).not.toContain('block=');
    expect(blockButton('Any').getAttribute('aria-pressed')).toBe('true');
    expect(order()).toEqual(['Alpha big', 'Beta small']); // full hand again, nothing sunk
  });
});
