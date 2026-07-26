import { describe, expect, it } from 'vitest';
import type { DuelableCase, Task } from '@rankati/shared';
import { MIN_POOL, isListDuelable } from '../src/duelable';

/**
 * The client's "can this list be dueled?" predicate (v0.12) — the disabled state for a list's VS
 * button. It MUST agree with the server's session guard (`arena.start()` returns `started` vs
 * `need-more-tasks`), or a list disabled here would still duel there.
 *
 * MIRRORED by `apps/api/test/duelable-agreement.spec.ts`, which runs the REAL server `start()`
 * over the SAME `CASES`. The two cannot be one test — 0041 keeps this client function out of the
 * API package — so the fixtures are duplicated here and there, cross-referenced both ways. Their
 * SHAPE is pinned by the shared `DuelableCase` type so they cannot drift in structure; the VALUES
 * are the anti-flash-style duplication — **change a case here, change it there.**
 *
 * On the CLIENT, gate-agnosticism is STRUCTURAL: `isListDuelable` takes only `listId`/`status`, so
 * there is no gate data to filter on — `plain` and `gated` are the same input here. The gated
 * discrimination that could actually regress lives on the SERVER (which has the gate data), and is
 * pinned in that file. The LOCATION case below is WEB-ONLY: the server has no location dimension.
 */
const CASES: readonly DuelableCase[] = [
  { label: 'two plain active tasks', active: ['plain', 'plain'], duelable: true },
  { label: 'two active, one GATED (a dependency) — still duelable (0003)', active: ['plain', 'gated'], duelable: true },
  { label: 'one active task', active: ['plain'], duelable: false },
  { label: 'empty list', active: [], duelable: false },
];

const LIST = 'list-under-test';
/** An active task in the list. Gate state is intentionally NOT represented: the predicate can't
 *  see it (that is the point), so `plain` and `gated` build the same active row. */
const active = (listId: string): Pick<Task, 'listId' | 'status'> => ({ listId, status: 'active' });

describe('isListDuelable — agrees with the server, gate- and location-agnostic (0003)', () => {
  it('MIN_POOL is two', () => {
    expect(MIN_POOL).toBe(2);
  });

  for (const c of CASES) {
    it(`${c.label} -> duelable=${c.duelable}`, () => {
      // The list's active tasks, plus one active task in ANOTHER list to prove list-scoping.
      const tasks = [...c.active.map(() => active(LIST)), active('another-list')];
      expect(isListDuelable(tasks, LIST)).toBe(c.duelable);
    });
  }

  it('ignores DONE tasks — only active count toward the pool (0047)', () => {
    const tasks: Pick<Task, 'listId' | 'status'>[] = [
      { listId: LIST, status: 'active' },
      { listId: LIST, status: 'done' },
    ];
    expect(isListDuelable(tasks, LIST)).toBe(false); // one active, not two
  });

  it('is LOCATION-agnostic — judged over the FULL set, never a location-filtered view (WEB-ONLY)', () => {
    // The server has no location dimension, so this case exists only here. A list with two active
    // tasks that a location filter would reduce to one: duelable must be judged over `full`, or VS
    // would be disabled on a list the server would still duel.
    const full = [active(LIST), active(LIST)];
    const asAlocationFilterWouldPass = [active(LIST)]; // one hidden
    expect(isListDuelable(full, LIST)).toBe(true); // correct: the caller passes the full set
    expect(isListDuelable(asAlocationFilterWouldPass, LIST)).toBe(false); // the trap, documented
    // App must therefore feed getRankedTasks (unfiltered), NOT the location-filtered view — wired
    // and tested in Step 4.
  });
});
