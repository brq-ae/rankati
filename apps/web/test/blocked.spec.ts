import type { Task } from '@rankati/shared';
import { describe, expect, it } from 'vitest';
import { blockedTasks } from '../src/blocked';

const task = (over: Partial<Task> & { id: string }): Task => ({
  title: over.id, listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal', dependsOn: [],
  locationIds: [], needsHand: false, checklist: [], effort: null, needsDetails: false, impact: 'none', ...over,
});
const ids = (rows: ReturnType<typeof blockedTasks>) => rows.map((r) => r.task.id);

describe('blockedTasks — the Blocked filter read (ADRs 0053, 0069)', () => {
  it('a task with an active DIRECT prerequisite is blocked; its blocker (cross-list) is named', () => {
    const a = task({ id: 'a', listId: 'l1', dependsOn: ['b'] });
    const b = task({ id: 'b', listId: 'l2' }); // different list, active
    const rows = blockedTasks([a, b]);
    expect(ids(rows)).toEqual(['a']); // b itself is not blocked
    expect(rows[0]!.waitingOn.map((w) => w.id)).toEqual(['b']); // resolved across lists
  });

  it('a prerequisite that is done does NOT block', () => {
    const c = task({ id: 'c', dependsOn: ['d'] });
    const d = task({ id: 'd', status: 'done' });
    expect(blockedTasks([c, d])).toEqual([]);
  });

  it('multiple prerequisites: only the UNFINISHED ones are the waiting-on set', () => {
    const f = task({ id: 'f', dependsOn: ['g', 'h'] });
    const g = task({ id: 'g' }); // active → blocks
    const h = task({ id: 'h', status: 'done' }); // done → does not
    const rows = blockedTasks([f, g, h]);
    expect(ids(rows)).toEqual(['f']);
    expect(rows[0]!.waitingOn.map((w) => w.id)).toEqual(['g']); // h excluded
  });

  it('a DONE task is never itself "blocked", even with an active prerequisite', () => {
    const done = task({ id: 'done', status: 'done', dependsOn: ['x'] });
    const x = task({ id: 'x' });
    expect(blockedTasks([done, x])).toEqual([]);
  });

  it('a dangling prerequisite (deleted, not in the set) does not block', () => {
    const p = task({ id: 'p', dependsOn: ['gone'] });
    expect(blockedTasks([p])).toEqual([]);
  });

  it('only DIRECT prerequisites count — no transitive walk (0054)', () => {
    // a <- b <- c. `a` waits on b (active); it does NOT also list c.
    const a = task({ id: 'a', dependsOn: ['b'] });
    const b = task({ id: 'b', dependsOn: ['c'] });
    const c = task({ id: 'c' });
    const rows = blockedTasks([a, b, c]);
    expect(ids(rows)).toEqual(['a', 'b']); // both a and b are blocked (each by its direct prereq)
    expect(rows.find((r) => r.task.id === 'a')!.waitingOn.map((w) => w.id)).toEqual(['b']); // not c
  });
});
