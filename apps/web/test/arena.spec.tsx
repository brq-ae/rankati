// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@rankati/shared';
import Arena, { type ArenaHandle } from '../src/Arena';
import * as api from '../src/api';

/**
 * The Arena's v0.12 imperative surface: a list session can be started from OUTSIDE (App's VS
 * button), it labels which pool it's ranking, and it keeps NO memory of the last list. The failure
 * mode of "no memory" is silent — a stale `listName` or session id would deal the wrong pool
 * without any error — so it is TESTED here, not just implemented (per the design's insistence).
 */
vi.mock('../src/api');

const task = (id: string, title: string): Task => ({
  id,
  title,
  listId: 'l',
  ownerId: 'local',
  status: 'active',
  createdAt: '2026-07-21T00:00:00.000Z',
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
  ...({} as Partial<Task>),
});

const STARTED = {
  status: 'started' as const,
  sessionId: 's1',
  pair: { dealId: 'd1', a: task('a', 'Alpha'), b: task('b', 'Beta') },
};

describe('Arena — one start path, no memory of the last list (v0.12)', () => {
  beforeEach(() => {
    vi.mocked(api.startSession).mockResolvedValue(STARTED);
    vi.mocked(api.commitSession).mockResolvedValue({ sessionId: 's1', committed: 0, skipped: 0, moved: [] });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('a list session labels its pool; ending then the OWN button reverts to all-tasks', async () => {
    const ref = createRef<ArenaHandle>();
    render(<Arena ref={ref} onCommitted={vi.fn()} />);

    // A list-scoped start via the imperative handle — exactly what App's VS button will do.
    ref.current!.start('list-1', 'Groceries');
    await screen.findByRole('button', { name: 'Pick Alpha' }); // reached the dueling phase
    expect(vi.mocked(api.startSession).mock.calls.at(-1)?.[0]).toEqual({ listId: 'list-1' });
    expect(document.body.textContent).toContain('Dueling: Groceries');

    // End the sitting and dismiss the summary.
    fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));

    // The Arena's OWN button must start ALL-TASKS, never the last list — the failure mode is a
    // stale listName or session id surviving the previous sitting.
    fireEvent.click(await screen.findByRole('button', { name: 'Start dueling' }));
    await screen.findByRole('button', { name: 'Pick Alpha' }); // dueling again
    expect(vi.mocked(api.startSession).mock.calls.at(-1)?.[0]).toEqual({}); // all-tasks, not { listId }
    expect(document.body.textContent).not.toContain('Dueling:'); // no stale pool label
  });

  it('the own button and the handle are the SAME start path — the pool argument is the only difference', async () => {
    const ref = createRef<ArenaHandle>();
    render(<Arena ref={ref} onCommitted={vi.fn()} />);

    // Own button first -> all-tasks (no listId, no label).
    fireEvent.click(screen.getByRole('button', { name: 'Start dueling' }));
    await screen.findByRole('button', { name: 'Pick Alpha' });
    expect(vi.mocked(api.startSession).mock.calls.at(-1)?.[0]).toEqual({});
    expect(document.body.textContent).not.toContain('Dueling:');

    // Then the handle with a list -> same path, now carrying the pool.
    ref.current!.start('list-2', 'Staff');
    await screen.findByRole('button', { name: 'Pick Alpha' });
    expect(vi.mocked(api.startSession).mock.calls.at(-1)?.[0]).toEqual({ listId: 'list-2' });
    expect(document.body.textContent).toContain('Dueling: Staff');
  });
});
