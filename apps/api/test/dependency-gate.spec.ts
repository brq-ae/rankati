import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { CommitSummary, SessionStarted, SubmitResultDto, Task } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { ArenaSessionService } from '../src/arena/arena-session.service';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * The dependency gate over HTTP (ADR 0053).
 *
 * EVERY piece of state here is injected: the links, the statuses, the dates, and the day
 * the client claims it is. Nothing reads the wall clock and nothing depends on what
 * happens to be in the database.
 *
 * The load-bearing test is "a blocked task still duels". 0053 records that
 * eligibleWhere()'s plain `status: 'active'` is deliberate — this is what stops it being
 * "fixed" into filtering gated tasks out of the Arena.
 */
const PREFIX = '__depgate__';

/** Fixed points. Nothing here is relative to today's real date. */
const TODAY = '2026-07-20';
const TOMORROW = '2026-07-21';

describe('the dependency gate (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let arena: ArenaSessionService;
  let listId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;

  async function cleanup() {
    if (!prisma) return;
    await prisma.duel.deleteMany({ where: { winner: { title: { startsWith: PREFIX } } } });
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  async function task(
    name: string,
    over: { status?: 'active' | 'done'; notBefore?: string; rating?: number } = {},
  ): Promise<string> {
    const t = await prisma.task.create({
      data: {
        title: `${PREFIX} ${name}`,
        listId,
        ownerId: LOCAL_OWNER_ID,
        rating: over.rating ?? 1000,
        status: over.status ?? 'active',
        completedAt: over.status === 'done' ? new Date('2026-07-19T00:00:00Z') : null,
        notBefore: over.notBefore ? new Date(over.notBefore) : null,
      },
    });
    return t.id;
  }

  /** A depends on B. */
  const block = (taskId: string, dependsOnId: string) =>
    prisma.taskDependency.create({ data: { taskId, dependsOnId } });

  // Post-0070 the suite reads the real `local` owner, whose data may carry windows, so the
  // clock is required (fail-closed, owner-data-dependent).
  const todayIds = async (on: string = TODAY): Promise<string[]> => {
    const res = await agent.get(url(`/tasks/today?on=${on}&at=12:00`)).expect(200);
    return (res.body as Task[]).filter((t) => t.title.startsWith(PREFIX)).map((t) => t.id);
  };

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
      arena = app.get(ArenaSessionService);
    }
    await cleanup();
    arena.discard();
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  describe('blocked while anything it waits for is not done', () => {
    it('hides a task whose blocker is still active', async () => {
      const blocker = await task('blocker', { status: 'active' });
      const blocked = await task('blocked');
      await block(blocked, blocker);

      const shown = await todayIds();
      expect(shown).not.toContain(blocked);
      expect(shown).toContain(blocker); // the blocker itself is playable — it is the work
    });

    it('shows it the moment its last blocker is done', async () => {
      const b1 = await task('b1');
      const b2 = await task('b2');
      const blocked = await task('blocked');
      await block(blocked, b1);
      await block(blocked, b2);

      expect(await todayIds()).not.toContain(blocked);

      // ANY incomplete blocker gates it: one down, one to go.
      await prisma.task.update({ where: { id: b1 }, data: { status: 'done', completedAt: new Date() } });
      expect(await todayIds()).not.toContain(blocked);

      await prisma.task.update({ where: { id: b2 }, data: { status: 'done', completedAt: new Date() } });
      expect(await todayIds()).toContain(blocked); // nothing left to wait for
    });

    it('a blocker satisfies the gate only once it is done', async () => {
      // HONEST LIMIT: this does NOT prove the query uses `not: 'done'` rather than
      // `status: 'active'`. TaskStatus has exactly two values, so those two filters are
      // logically identical today and no test can separate them — swapping one for the
      // other keeps this suite green. Verified by sabotage, not assumed.
      //
      // `not: 'done'` is chosen anyway, as defence against a third status (archived,
      // say) silently counting as "satisfied" and unblocking a task that is still waiting.
      // That is future-proofing, and it only becomes testable the day the enum grows —
      // at which point THIS is the test to extend.
      const blocker = await task('still active');
      const blocked = await task('blocked');
      await block(blocked, blocker);
      expect(await todayIds()).not.toContain(blocked);

      await prisma.task.update({ where: { id: blocker }, data: { status: 'done', completedAt: new Date() } });
      expect(await todayIds()).toContain(blocked);
    });

    it('leaves a task with no dependencies alone', async () => {
      const free = await task('free');
      expect(await todayIds()).toContain(free);
    });

    it('a task blocking others is not itself blocked', async () => {
      const blocker = await task('blocker');
      await block(await task('a'), blocker);
      await block(await task('b'), blocker);
      expect(await todayIds()).toContain(blocker);
    });
  });

  describe('the two gates compose (0052 + 0053)', () => {
    it('a task gated by BOTH a future date and an incomplete blocker needs both to clear', async () => {
      const blocker = await task('blocker');
      const blocked = await task('blocked', { notBefore: TOMORROW });
      await block(blocked, blocker);

      // Both shut.
      expect(await todayIds(TODAY)).not.toContain(blocked);

      // Only the date clears — still blocked.
      expect(await todayIds(TOMORROW)).not.toContain(blocked);

      // Only the blocker clears — still too early.
      await prisma.task.update({ where: { id: blocker }, data: { status: 'done', completedAt: new Date() } });
      expect(await todayIds(TODAY)).not.toContain(blocked);

      // Both clear.
      expect(await todayIds(TOMORROW)).toContain(blocked);
    });
  });

  describe('the gate filters Today, and nothing else (0053)', () => {
    it('a blocked task is still returned by GET /tasks — Lists shows everything', async () => {
      const blocker = await task('blocker');
      const blocked = await task('blocked');
      await block(blocked, blocker);

      const res = await agent.get(url('/tasks')).expect(200);
      const ids = (res.body as Task[]).map((t) => t.id);
      expect(ids).toContain(blocked);
      expect(await todayIds()).not.toContain(blocked);
    });

    it('THE LOAD-BEARING ONE: a blocked task still appears in the Arena and can be dueled', async () => {
      // 0053: the Arena answers "what matters more?", independent of "can I start it?". A
      // task blocked until Friday still has an importance, and settling it now is why it is
      // already ranked when it unblocks. eligibleWhere() applies NO gate filter — that is
      // deliberate, and this test is what stops it being "fixed".
      const blocker = await task('blocker');
      const blocked = await task('blocked');
      await block(blocked, blocker);

      expect(await todayIds()).not.toContain(blocked); // invisible in Today...

      const started = await agent
        .post(url('/duel-sessions'))
        .send({ listId })
        .expect(200);
      const body = started.body as SessionStarted;
      expect([body.pair.a.id, body.pair.b.id].sort()).toEqual([blocked, blocker].sort());

      await agent
        .post(url(`/duel-sessions/${body.sessionId}/results`))
        .send({
          winnerId: blocked,
          loserId: blocker,
          dealId: body.pair.dealId,
        } satisfies SubmitResultDto)
        .expect(200);
      const done = await agent
        .post(url(`/duel-sessions/${body.sessionId}/commit`))
        .expect(200);

      expect((done.body as CommitSummary).committed).toBe(1);
      const after = await prisma.task.findUniqueOrThrow({ where: { id: blocked } });
      expect(after.rating.toFixed(2)).toBe('1032.00'); // ...and its rating moved anyway
      expect(await todayIds()).not.toContain(blocked); // still blocked; dueling opens no gate
    });

    it('the gate never mutates the task — it is only omitted from a query', async () => {
      const blocker = await task('blocker');
      const blocked = await task('blocked');
      await block(blocked, blocker);
      await todayIds();

      const row = await prisma.task.findUniqueOrThrow({
        where: { id: blocked },
        include: { blockedBy: true },
      });
      expect(row.status).toBe('active');
      expect(row.blockedBy).toHaveLength(1);
    });
  });

  describe('deleting a blocker unblocks its dependents (0053)', () => {
    it('cascade removes the link, and the dependent appears in Today', async () => {
      const blocker = await task('blocker');
      const blocked = await task('blocked');
      await block(blocked, blocker);
      expect(await todayIds()).not.toContain(blocked);

      await agent.delete(url(`/tasks/${blocker}`)).expect(204);

      // A deleted blocker is not an "incomplete" one — the link is gone, so nothing waits.
      expect(await todayIds()).toContain(blocked);
      expect(await prisma.taskDependency.count({ where: { taskId: blocked } })).toBe(0);
    });
  });

  describe('the wire', () => {
    it('carries dependsOn as ids', async () => {
      const blocker = await task('blocker');
      const blocked = await task('blocked');
      await block(blocked, blocker);

      const res = await agent.get(url('/tasks')).expect(200);
      const dto = (res.body as Task[]).find((t) => t.id === blocked);
      expect(dto?.dependsOn).toEqual([blocker]);

      const free = (res.body as Task[]).find((t) => t.id === blocker);
      expect(free?.dependsOn).toEqual([]);
    });
  });
});
