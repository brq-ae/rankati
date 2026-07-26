import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Task, TaskTier } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * The urgency-scored Today + Upcoming reads (ADRs 0057, 0058), over HTTP against real Postgres.
 *
 * EVERY DATE IS INJECTED. `on` is fixed, and each `due` is computed relative to it — nothing
 * reads the wall clock, so the ladder boundaries mean the same thing on every day of the year.
 */
const PREFIX = '__scored__';
const ON = '2026-07-18';
const dueAtDays = (d: number): string =>
  new Date(Date.parse(`${ON}T00:00:00.000Z`) + d * 86_400_000).toISOString().slice(0, 10);

describe('Today (scored) and Upcoming (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let listId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  async function task(
    name: string,
    opts: { due?: string | null; tier?: TaskTier; rating?: number; notBefore?: string | null } = {},
  ): Promise<string> {
    const t = await prisma.task.create({
      data: {
        title: `${PREFIX} ${name}`,
        listId,
        ownerId: LOCAL_OWNER_ID,
        rating: opts.rating ?? 1000,
        tier: opts.tier ?? 'normal',
        due: opts.due ? new Date(opts.due) : null,
        notBefore: opts.notBefore ? new Date(opts.notBefore) : null,
      },
    });
    return t.id;
  }

  // Post-0070 the suite reads the real `local` owner, whose data may carry windows, so the
  // clock is required (fail-closed, owner-data-dependent).
  const ids = async (tab: 'today' | 'upcoming', on = ON): Promise<string[]> => {
    const res = await agent.get(url(`/tasks/${tab}?on=${on}&at=12:00`)).expect(200);
    return (res.body as Task[]).filter((t) => t.title.startsWith(PREFIX)).map((t) => t.id);
  };
  const names = async (tab: 'today' | 'upcoming', on = ON): Promise<string[]> => {
    const res = await agent.get(url(`/tasks/${tab}?on=${on}&at=12:00`)).expect(200);
    return (res.body as Task[])
      .filter((t) => t.title.startsWith(PREFIX))
      .map((t) => t.title.replace(`${PREFIX} `, ''));
  };

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
    }
    await cleanup();
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  describe('the Today / Upcoming split (0058)', () => {
    it('a far-from-due dated task is in Upcoming, not Today; a near-due one is in Today', async () => {
      const far = await task('far', { due: dueAtDays(20), tier: 'critical' }); // 20 > 14
      const near = await task('near', { due: dueAtDays(7), tier: 'critical' }); // 7 ≤ 14

      expect(await ids('today')).toContain(near);
      expect(await ids('today')).not.toContain(far);
      expect(await ids('upcoming')).toEqual([far]);
    });

    it('the entry ladder: each tier crosses at its window, and one day further out waits', async () => {
      const cases: [TaskTier, number][] = [
        ['critical', 14],
        ['super_important', 7],
        ['important', 5],
        ['normal', 3],
      ];
      for (const [tier, W] of cases) {
        await cleanup();
        listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
        const at = await task('at', { due: dueAtDays(W), tier });
        const beyond = await task('beyond', { due: dueAtDays(W + 1), tier });
        expect(await ids('today')).toEqual([at]); // window edge → Today
        expect(await ids('upcoming')).toEqual([beyond]); // one day further → Upcoming
      }
    });

    it('an UNDATED task is always in Today, never in Upcoming', async () => {
      const u = await task('undated', { due: null, rating: 1200 });
      expect(await ids('today')).toEqual([u]);
      expect(await ids('upcoming')).toEqual([]);
    });
  });

  describe('ordering (0057, 0058)', () => {
    it('overdue is pinned to the top of Today, ordered by RATING — not tier, not how overdue', async () => {
      // The fixture is chosen so rating-order and score-order DISAGREE: overdue-lo is far more
      // overdue AND a higher tier, so by any urgency score it would lead — but it has the lower
      // rating, so by the rule it trails. If overdue were ever ordered by score, this flips.
      await task('undated-1500', { rating: 1500 });
      await task('due-today', { due: dueAtDays(0), tier: 'critical', rating: 1000 });
      await task('overdue-lo', { due: dueAtDays(-30), tier: 'critical', rating: 900 });
      await task('overdue-hi', { due: dueAtDays(-1), tier: 'normal', rating: 1100 });

      const order = await names('today');
      expect(order.slice(0, 2)).toEqual(['overdue-hi', 'overdue-lo']); // pinned top, by rating
    });

    it('a near-due dated task OVERTAKES a higher-rated undated task in Today', async () => {
      const undated = await task('undated-1100', { rating: 1100 }); // score 1100
      const dated = await task('crit-7d', { due: dueAtDays(7), tier: 'critical', rating: 1000 }); // score 1200

      expect(await ids('today')).toEqual([dated, undated]); // 1200 > 1100
    });

    it('Upcoming orders by the same escalated score', async () => {
      // Both far out (Upcoming). The nearer/steeper one scores higher.
      const soonerCrit = await task('crit-16d', { due: dueAtDays(16), tier: 'critical', rating: 1000 });
      const laterCrit = await task('crit-25d', { due: dueAtDays(25), tier: 'critical', rating: 1000 });
      expect(await ids('upcoming')).toEqual([soonerCrit, laterCrit]);
    });
  });

  describe('the gates filter BOTH tabs (0058)', () => {
    it('a dependency-blocked dated task is in neither Today nor Upcoming', async () => {
      const blocker = await task('blocker'); // active, not done
      const blockedNear = await task('blocked-near', { due: dueAtDays(3), tier: 'critical' });
      const blockedFar = await task('blocked-far', { due: dueAtDays(30), tier: 'critical' });
      await prisma.taskDependency.create({ data: { taskId: blockedNear, dependsOnId: blocker } });
      await prisma.taskDependency.create({ data: { taskId: blockedFar, dependsOnId: blocker } });

      expect(await ids('today')).not.toContain(blockedNear);
      expect(await ids('upcoming')).not.toContain(blockedFar);
    });

    it('a not-before-gated dated task is in neither, until its day arrives', async () => {
      const gated = await task('gated', { due: dueAtDays(2), tier: 'critical', notBefore: dueAtDays(1) });
      expect(await ids('today')).not.toContain(gated);
      expect(await ids('upcoming')).not.toContain(gated);
    });
  });

  describe('`on` is required on both reads (0052)', () => {
    it('400s without `on`', async () => {
      await agent.get(url('/tasks/today')).expect(400);
      await agent.get(url('/tasks/upcoming')).expect(400);
    });
  });
});
