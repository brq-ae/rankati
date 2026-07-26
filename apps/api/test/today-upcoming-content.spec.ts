import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TaskTier } from '@rankati/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { TasksService } from '../src/tasks.service';

/**
 * Today/Upcoming CONTENT, asserted whole-tab under an ISOLATED owner (ADR 0067).
 *
 * This is the read-layer test that was impossible before the owner parameter. The other scored
 * specs seed into `local` behind a title prefix and can only assert prefix-SUBSETS — real `local`
 * tasks are always mixed in, so `toEqual([...])` over an entire tab could never be written. Here
 * every test owns a THROWAWAY `__ownertest__<uuid>` (never `local`, ADR 0064) and calls the service
 * read directly with that owner, so the read returns ONLY this test's tasks and the FULL shape of
 * each tab is assertable exactly.
 *
 * EVERY DATE IS INJECTED. `on` is fixed and each `due`/`notBefore` is computed relative to it —
 * nothing reads the wall clock, so the ladder boundaries mean the same on every day of the year.
 */
const OPREFIX = '__ownertest__';
const ON = '2026-07-20';
const dueAtDays = (d: number): string =>
  new Date(Date.parse(`${ON}T00:00:00.000Z`) + d * 86_400_000).toISOString().slice(0, 10);

describe('Today/Upcoming content under an isolated owner (real Postgres, ADR 0067)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: TasksService;

  /** A brand-new throwaway owner with its own list — full isolation per test. */
  async function freshOwner(): Promise<{ owner: string; listId: string }> {
    const owner = `${OPREFIX}${randomUUID()}`;
    const listId = (await prisma.list.create({ data: { name: 'l', ownerId: owner } })).id;
    return { owner, listId };
  }

  const mk = async (
    owner: string,
    listId: string,
    name: string,
    o: { due?: string | null; tier?: TaskTier; rating?: number; notBefore?: string | null } = {},
  ): Promise<string> =>
    (
      await prisma.task.create({
        data: {
          title: name,
          listId,
          ownerId: owner,
          rating: o.rating ?? 1000,
          tier: o.tier ?? 'normal',
          due: o.due ? new Date(o.due) : null,
          notBefore: o.notBefore ? new Date(o.notBefore) : null,
        },
      })
    ).id;

  /** `blocked` depends on `by` (blocked.dependsOn = [by]) — so `by` carries `blocked`'s urgency. */
  const block = (blocked: string, by: string) =>
    prisma.taskDependency.create({ data: { taskId: blocked, dependsOnId: by } });

  const todayIds = async (owner: string, on = ON): Promise<string[]> =>
    (await service.findToday(owner, on)).map((t) => t.id);
  const upcomingIds = async (owner: string, on = ON): Promise<string[]> =>
    (await service.findUpcoming(owner, on)).map((t) => t.id);

  async function wipe() {
    if (!prisma) return;
    await prisma.taskDependency.deleteMany({ where: { task: { ownerId: { startsWith: OPREFIX } } } });
    await prisma.task.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
    await prisma.list.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
  }

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    service = app.get(TasksService);
    await wipe();
  });
  afterEach(wipe);
  afterAll(async () => {
    await wipe();
    await app?.close();
  });

  it('Today membership: undated, dated-within-threshold, and overdue (overdue pinned first)', async () => {
    const { owner, listId } = await freshOwner();
    const overdue = await mk(owner, listId, 'overdue', { due: dueAtDays(-1), rating: 900 });
    const dated = await mk(owner, listId, 'dated-near', { due: dueAtDays(7), tier: 'critical', rating: 1000 });
    const undated = await mk(owner, listId, 'undated', { due: null, rating: 1000 });

    // Whole tab, exact: overdue pinned top (by rating); then the rest by escalated score —
    // the dated critical-at-7 escalates above its rating, so it leads the undated (score 1000).
    expect(await todayIds(owner)).toEqual([overdue, dated, undated]);
    expect(await upcomingIds(owner)).toEqual([]);
  });

  it('Upcoming membership: a dated task beyond its threshold (the shape local lacks)', async () => {
    const { owner, listId } = await freshOwner();
    const undated = await mk(owner, listId, 'undated', { due: null });
    const far = await mk(owner, listId, 'far', { due: dueAtDays(20), tier: 'critical' }); // 20 > 14

    expect(await todayIds(owner)).toEqual([undated]);
    expect(await upcomingIds(owner)).toEqual([far]); // whole Upcoming tab, exact
  });

  it('Gating: a not-before task is in neither tab until its day arrives', async () => {
    const { owner, listId } = await freshOwner();
    const gated = await mk(owner, listId, 'gated', {
      due: dueAtDays(2),
      tier: 'critical',
      notBefore: dueAtDays(1),
    });

    // On ON: notBefore (ON+1) is in the future → hidden from BOTH tabs.
    expect(await todayIds(owner)).toEqual([]);
    expect(await upcomingIds(owner)).toEqual([]);
    // On its notBefore day: the gate opens and it surfaces in Today (critical, 1 day out).
    expect(await todayIds(owner, dueAtDays(1))).toEqual([gated]);
  });

  it('Gating: a dependency-blocked task is in neither tab; its blocker shows', async () => {
    const { owner, listId } = await freshOwner();
    const blocker = await mk(owner, listId, 'blocker', { due: null });
    const blocked = await mk(owner, listId, 'blocked', { due: dueAtDays(3), tier: 'critical' });
    await block(blocked, blocker); // blocked depends on the still-active blocker → blocked hidden

    expect(await todayIds(owner)).toEqual([blocker]); // only the blocker (undated → Today)
    expect(await upcomingIds(owner)).toEqual([]);
  });

  it('Inherited urgency: a blocker is pulled into Today carrying the deadline as urgencySourceId', async () => {
    const { owner, listId } = await freshOwner();
    const B = await mk(owner, listId, 'B', { due: dueAtDays(20), tier: 'super_important' }); // own: Upcoming
    const A = await mk(owner, listId, 'A', { due: dueAtDays(2), tier: 'critical' }); // the deadline
    await block(A, B); // A depends on B → B carries A's urgency; A is hidden (blocked)

    const today = await service.findToday(owner, ON);
    expect(today.map((t) => t.id)).toEqual([B]); // B pulled OUT of Upcoming, INTO Today
    expect(today[0].urgencySourceId).toBe(A); // and it names the deadline it is unblocking
    expect(await upcomingIds(owner)).toEqual([]); // B left Upcoming; A stays hidden
  });
});
