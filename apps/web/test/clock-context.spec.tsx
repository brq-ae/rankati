// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The clock context the app owes the scored reads (ADRs 0052, 0070).
 *
 * `fetch` is stubbed at the boundary, like navigation.spec: App reaches the network through
 * api.ts, so asserting the URLs it ACTUALLY requested is what proves the contract — both
 * scored reads carry `on` (the local day, 0052) AND `at` (the local time, 0070), well-formed.
 *
 * The `at` assertion is deliberately shape-strict (zero-padded 24h HH:MM): the server's
 * parser refuses anything looser, and the moment ANY windowed task exists a read without
 * `at` is a 400 — the app sending it on every read is what makes creating the first
 * windowed task safe. This is the spec a dropped `at` param must fail.
 */

const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];
const TASKS: Task[] = [
  {
    id: 't1',
    title: 'Only task',
    listId: 'l1',
    ownerId: 'local',
    status: 'active',
    createdAt: '2026-07-16T12:00:00.000Z',
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
  },
];

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
          : url.includes('/api/tasks')
            ? TASKS // today/upcoming/ranked alike — membership is not what this spec is about
            : undefined;
      if (body === undefined) throw new Error(`clock-context.spec: unstubbed request to ${url}`);
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

/** Every URL the app requested that contains the given path. */
const requested = (path: string): string[] =>
  vi
    .mocked(fetch)
    .mock.calls.map((c) => String(c[0]))
    .filter((u) => u.includes(path));

describe('the scored reads carry the full clock context (0052, 0070)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('today and upcoming are fetched with on= AND a well-formed at=', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /start dueling/i }); // mount fetches settled

    for (const path of ['/api/tasks/today', '/api/tasks/upcoming']) {
      const urls = requested(path);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        // The local day (0052) …
        expect(url).toMatch(/[?&]on=\d{4}-\d{2}-\d{2}/);
        // … and the local time (0070), zero-padded 24h — the only form the server accepts.
        expect(url).toMatch(/[?&]at=([01]\d|2[0-3])%3A[0-5]\d/);
      }
    }
  });
});
