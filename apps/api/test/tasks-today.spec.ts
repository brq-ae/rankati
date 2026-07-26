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
 * The not-before gate over HTTP (ADR 0052).
 *
 * EVERY DATE HERE IS INJECTED. Nothing reads the wall clock — not the tasks' notBefore, not
 * the `on` the client sends. A test that asks the real clock what day it is passes today,
 * fails on the 1st of a month, and proves nothing about the boundary either way.
 *
 * The load-bearing test is "a gated task still duels". 0052 records that eligibleWhere()'s
 * plain `status: 'active'` is deliberate, and this is what stops it being "fixed".
 */
const PREFIX = '__today__';

/** Fixed points. TOMORROW is gated relative to TODAY; nothing here depends on the real date. */
const YESTERDAY = '2026-07-19';
const TODAY = '2026-07-20';
const TOMORROW = '2026-07-21';

describe('GET /tasks/today — the gated read (real Postgres)', () => {
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

  /** A task with an explicit gate. `notBefore: null` = ungated. */
  async function task(name: string, notBefore: string | null, rating = 1000): Promise<string> {
    const t = await prisma.task.create({
      data: {
        title: `${PREFIX} ${name}`,
        listId,
        ownerId: LOCAL_OWNER_ID,
        rating,
        notBefore: notBefore ? new Date(notBefore) : null,
      },
    });
    return t.id;
  }

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

  describe('the boundary', () => {
    it('shows ungated, past and TODAY; hides only the future', async () => {
      const ungated = await task('ungated', null);
      const past = await task('yesterday', YESTERDAY);
      const boundary = await task('exactly today', TODAY);
      const future = await task('tomorrow', TOMORROW);

      const shown = await todayIds();

      expect(shown).toContain(ungated);
      expect(shown).toContain(past);
      // The whole point of `lte`: today is not "before" today, so the gate has opened.
      expect(shown).toContain(boundary);
      expect(shown).not.toContain(future);
    });

    it('opens the gate the day it arrives, not a day late', async () => {
      const gated = await task('gated', TOMORROW);

      expect(await todayIds(TODAY)).not.toContain(gated);
      // Same task, same stored date — only the client's day moved on.
      expect(await todayIds(TOMORROW)).toContain(gated);
    });

    it('a far-future gate stays shut', async () => {
      const gated = await task('next year', '2027-01-01');
      expect(await todayIds()).not.toContain(gated);
    });
  });

  describe('the gate is a filter on THIS read, and nothing else (0052)', () => {
    it('a gated task is still returned by GET /tasks — Lists shows everything', async () => {
      const gated = await task('gated', TOMORROW);
      const res = await agent.get(url('/tasks')).expect(200);
      const ids = (res.body as Task[]).map((t) => t.id);
      expect(ids).toContain(gated);
      expect(await todayIds()).not.toContain(gated);
    });

    it('THE LOAD-BEARING ONE: a gated task still appears in the Arena and can be dueled', async () => {
      // 0052: the Arena answers "what matters more?", which is independent of "can I start
      // it?". A task gated until tomorrow still has an importance, and settling it now is
      // why it is already ranked when the gate opens. eligibleWhere() applies NO gate
      // filter — that is deliberate, and this test is what stops it being "fixed".
      const gated = await task('gated', TOMORROW);
      const ungated = await task('ungated', null);

      expect(await todayIds()).not.toContain(gated); // hidden from Today...

      const started = await agent
        .post(url('/duel-sessions'))
        .send({ listId })
        .expect(200);
      const body = started.body as SessionStarted;
      const dealt = [body.pair.a.id, body.pair.b.id];

      // ...and yet dealt by the Arena: the pool is exactly these two tasks.
      expect(dealt.sort()).toEqual([gated, ungated].sort());

      await agent
        .post(url(`/duel-sessions/${body.sessionId}/results`))
        .send({ winnerId: gated, loserId: ungated, dealId: body.pair.dealId } satisfies SubmitResultDto)
        .expect(200);
      const done = await agent
        .post(url(`/duel-sessions/${body.sessionId}/commit`))
        .expect(200);

      // The duel counted. A gated task's rating moves like any other.
      expect((done.body as CommitSummary).committed).toBe(1);
      const after = await prisma.task.findUniqueOrThrow({ where: { id: gated } });
      expect(after.rating.toFixed(2)).toBe('1032.00');
      // Still gated afterwards — dueling does not open a gate.
      expect(after.notBefore).not.toBeNull();
      expect(await todayIds()).not.toContain(gated);
    });

    it('the gate never mutates the task — it is only omitted from a query', async () => {
      const gated = await task('gated', TOMORROW);
      await todayIds(); // the read that hides it
      const row = await prisma.task.findUniqueOrThrow({ where: { id: gated } });
      expect(row.status).toBe('active');
      expect(row.notBefore?.toISOString().slice(0, 10)).toBe(TOMORROW);
    });
  });

  describe('required context — the gate fails closed and loud (0052)', () => {
    it('400s when the client sends no day at all', async () => {
      await task('gated', TOMORROW);
      // Serving an un-gated list here is the failure this rule exists to prevent: every
      // gated task reappears looking like normal operation.
      await agent.get(url('/tasks/today')).expect(400);
    });

    it('400s on an empty day', async () => {
      await agent.get(url('/tasks/today?on=')).expect(400);
    });

    it('400s on a date whose meaning is negotiable', async () => {
      for (const bad of ['20 July 2026', '2026-7-20', '2026-02-31', 'today', '2026-07-20T00:00:00Z']) {
        await agent
          .get(url(`/tasks/today?on=${encodeURIComponent(bad)}`))
          .expect(400);
      }
    });
  });

  describe('it is still the ranked read (0050)', () => {
    it('orders by rating, newest first among ties, and excludes completed', async () => {
      const top = await task('top', null, 1200);
      const mid = await task('mid', YESTERDAY, 1100);
      const low = await task('low', null, 900);
      const done = await task('done', null, 1500);
      await prisma.task.update({ where: { id: done }, data: { status: 'done', completedAt: new Date() } });

      const shown = await todayIds();
      expect(shown).toEqual([top, mid, low]);
      expect(shown).not.toContain(done); // completed retire (0047), gate or no gate
    });

    it('sends notBefore as a plain calendar day, never an instant', async () => {
      await task('gated tomorrow', TOMORROW);
      const res = await agent.get(url(`/tasks/today?on=${TOMORROW}&at=12:00`)).expect(200);
      const t = (res.body as Task[]).find((x) => x.title.endsWith('gated tomorrow'));
      expect(t?.notBefore).toBe(TOMORROW); // exactly '2026-07-21' — no 'T', no 'Z'
    });
  });

  describe('routing', () => {
    it("'today' is not swallowed by GET /tasks/:id", async () => {
      // If @Get('today') were declared after @Get(':id'), Nest would match ':id' first and
      // this would 404 as "task today not found" — a routing bug wearing a 404's clothes.
      const res = await agent.get(url('/tasks/today'));
      expect(res.status).toBe(400); // the missing-`on` error, i.e. it reached findToday
      expect(JSON.stringify(res.body)).not.toContain('not found');
    });
  });
});
