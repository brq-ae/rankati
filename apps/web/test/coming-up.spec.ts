import type { Task } from '@rankati/shared';
import { describe, expect, it } from 'vitest';
import { comingUp } from '../src/coming-up';

/**
 * "Coming up" (ADR 0074) — the global gated set (active ∉ today∪upcoming), soonest-to-unlock first,
 * each labeled with the most actionable reason. Membership is a set difference; the reason and order
 * are the client's derivation (waitingBreakdown's precedence: blocked > not-before > hours).
 */
const t = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, impact: 'none', checklist: [], effort: null, ...over,
});
const DAY = '2026-07-20';
const AT = '20:00'; // outside working_hours, and a weekday
const run = (tasks: Task[], today: string[] = [], upcoming: string[] = []) =>
  comingUp(tasks, new Set(today), new Set(upcoming), DAY, AT);

describe('comingUp — the global gated set (ADR 0074)', () => {
  it('is exactly active tasks in NEITHER today nor upcoming (a set difference)', () => {
    const tasks = [
      t('inToday', { notBefore: '2026-07-25' }),
      t('inUpcoming', { notBefore: '2026-07-25' }),
      t('gated', { notBefore: '2026-07-25' }),
      t('done', { notBefore: '2026-07-25', status: 'done' }),
    ];
    expect(run(tasks, ['inToday'], ['inUpcoming']).map((i) => i.task.id)).toEqual(['gated']);
  });

  it('excludes Upcoming — those are playable-later-ungated, not gated', () => {
    const tasks = [t('up', { notBefore: '2026-07-25' })];
    expect(run(tasks, [], ['up'])).toEqual([]);
  });

  it('labels each with its reason (blocked > not-before > hours precedence)', () => {
    const tasks = [
      t('nb', { notBefore: '2026-07-25' }),
      t('win', { availabilityWindow: 'working_hours' }), // shut at 20:00
      t('blk', { dependsOn: ['dep'] }),
      t('dep', { status: 'active' }),
    ];
    const byId = Object.fromEntries(run(tasks, ['dep']).map((i) => [i.task.id, i.reason]));
    expect(byId.nb).toBe('not before 2026-07-25');
    expect(byId.win).toBe('outside hours');
    expect(byId.blk).toBe('waiting on dep'); // named by its unfinished prerequisite
  });

  it('a task both blocked AND dated is named by the more actionable reason (blocked)', () => {
    const tasks = [t('x', { dependsOn: ['d'], notBefore: '2026-07-25' }), t('d')];
    expect(run(tasks, ['d'])[0]!.reason).toMatch(/waiting on/);
  });

  it('sorts soonest-to-unlock first: near not-before, then hours, then far not-before, then blocked', () => {
    const tasks = [
      t('blocked', { dependsOn: ['d'] }),
      t('farDate', { notBefore: '2026-08-15' }),
      t('window', { availabilityWindow: 'working_hours' }),
      t('nearDate', { notBefore: '2026-07-21' }),
      t('d'),
    ];
    // nearDate (1 day) < window (~0.5? no) ... window order 0.5 < nearDate 1 < farDate 26 < blocked ∞.
    expect(run(tasks, ['d']).map((i) => i.task.id)).toEqual(['window', 'nearDate', 'farDate', 'blocked']);
  });
});
