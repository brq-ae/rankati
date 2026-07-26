import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  CommitSummary,
  NextPairResult,
  SessionStarted,
  StartSessionResult,
  SubmitResultDto,
  Task,
} from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { ArenaSessionService } from '../src/arena/arena-session.service';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * The Arena over HTTP (ADRs 0047, 0048), against the REAL dev Postgres —
 * `pnpm db:up` must be running.
 */
const PREFIX = '__arenaapi__';

describe('Arena API (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let arena: ArenaSessionService;
  let listId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  /**
   * Seeds `count` tasks and returns their ids.
   *
   * Overloaded per arity so destructuring yields plain strings. Indexed access is checked
   * (noUncheckedIndexedAccess), and `seed(2)` provably returns two ids — the overloads say
   * so to the compiler instead of every call site casting or asserting.
   */
  async function seed(count: 1, duelCount?: number): Promise<[string]>;
  async function seed(count: 2, duelCount?: number): Promise<[string, string]>;
  async function seed(count: 3, duelCount?: number): Promise<[string, string, string]>;
  async function seed(count: 4, duelCount?: number): Promise<[string, string, string, string]>;
  async function seed(count: number, duelCount?: number): Promise<string[]>;
  async function seed(count: number, duelCount = 0): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = await prisma.task.create({
        data: { title: `${PREFIX} task ${i}`, listId, ownerId: LOCAL_OWNER_ID, duelCount },
      });
      ids.push(t.id);
    }
    return ids;
  }

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
    const list = await prisma.list.create({
      data: { name: `${PREFIX} list`, ownerId: LOCAL_OWNER_ID },
    });
    listId = list.id;
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  /** The token for the pair currently on the table, from a start or next-pair body. */
  function dealIdOf(body: SessionStarted | NextPairResult): string {
    const pair = 'pair' in body ? body.pair : undefined;
    if (!pair) throw new Error('no pair on the table');
    return pair.dealId;
  }

  /**
   * Tap over HTTP, answering the deal on the table (ADR 0049), and hand back the response
   * so the caller can chain the next tap's token.
   *
   * `satisfies SubmitResultDto` is load-bearing: supertest's .send() takes `any`, so when
   * dealId joined the contract every tap here still compiled while failing at runtime.
   * This makes the compiler answerable for the request body.
   */
  async function tapHttp(
    sid: string,
    dealId: string,
    winnerId: string,
    loserId: string,
  ): Promise<NextPairResult> {
    const res = await agent
      .post(url(`/duel-sessions/${sid}/results`))
      .send({ winnerId, loserId, dealId } satisfies SubmitResultDto)
      .expect(200);
    return res.body as NextPairResult;
  }

  describe('task edit and delete — what the Arena needs', () => {
    it('PATCH /tasks/:id renames', async () => {
      const [id] = await seed(1);
      const res = await agent
        .patch(url(`/tasks/${id}`))
        .send({ title: `${PREFIX} renamed` })
        .expect(200);
      expect((res.body as Task).title).toBe(`${PREFIX} renamed`);
    });

    it('PATCH /tasks/:id rejects an empty title and 404s an unknown task', async () => {
      const [id] = await seed(1);
      await agent.patch(url(`/tasks/${id}`)).send({ title: '   ' }).expect(400);
      await agent
        .patch(url('/tasks/00000000-0000-0000-0000-000000000000'))
        .send({ title: 'x' })
        .expect(404);
    });

    it('DELETE /tasks/:id removes it, and 404s an unknown task', async () => {
      const [id] = await seed(1);
      await agent.delete(url(`/tasks/${id}`)).expect(204);
      await agent.get(url(`/tasks/${id}`)).expect(404);
      await agent.delete(url(`/tasks/${id}`)).expect(404);
    });

    it('DELETE cascades the task’s duels — both sides (ADR 0048)', async () => {
      const [a, b] = await seed(2);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      const afterFirst = await tapHttp(sid, dealIdOf(started.body as SessionStarted), a, b);
      await tapHttp(sid, dealIdOf(afterFirst), b, a);
      await agent.post(url(`/duel-sessions/${sid}/commit`)).expect(200);
      expect(await prisma.duel.count({ where: { OR: [{ winnerId: a }, { loserId: a }] } })).toBe(2);

      await agent.delete(url(`/tasks/${a}`)).expect(204);
      // `a` was winner in one and loser in the other: both must be gone.
      expect(await prisma.duel.count({ where: { OR: [{ winnerId: a }, { loserId: a }] } })).toBe(0);
    });

    it('GET /tasks?sort=rating ranks by rating, with a stable tie-break', async () => {
      const [a, b] = await seed(2);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      await tapHttp(sid, dealIdOf(started.body as SessionStarted), b, a);
      await agent.post(url(`/duel-sessions/${sid}/commit`)).expect(200);

      const res = await agent.get(url('/tasks?sort=rating')).expect(200);
      const ranked = (res.body as Task[]).filter((t) => t.title.startsWith(PREFIX));
      expect(ranked[0]!.id).toBe(b);
      expect(ranked[0]!.rating).toBe(1032);
      expect(ranked[1]!.id).toBe(a);
      expect(ranked[1]!.rating).toBe(968);
    });
  });

  describe('the ranked read — what the Today view renders (ADR 0050)', () => {
    it('breaks ties NEWEST-first when ratings are genuinely equal', async () => {
      // The tie-break only exists because ties are the COMMON case early on: every task
      // starts at 1000 (0047), so this is the ordinary path, not an edge.
      //
      // createdAt is set EXPLICITLY rather than relying on insertion timing. Three rows
      // created in a loop land microseconds apart, and a test that depends on the clock
      // separating them passes by luck and fails on a fast machine.
      const base = new Date('2026-07-16T10:00:00.000Z');
      const made: string[] = [];
      for (let i = 0; i < 3; i++) {
        const t = await prisma.task.create({
          data: {
            title: `${PREFIX} tie ${i}`,
            listId,
            ownerId: LOCAL_OWNER_ID,
            createdAt: new Date(base.getTime() + i * 60_000), // i=2 is the newest
          },
        });
        made.push(t.id);
      }

      const res = await agent.get(url('/tasks?sort=rating')).expect(200);
      const ranked = (res.body as Task[]).filter((t) => t.title.startsWith(`${PREFIX} tie`));

      // Guard the guard: if these ratings ever stop being equal, this test would be
      // asserting the rating sort and quietly proving nothing about the tie-break.
      expect(new Set(ranked.map((t) => t.rating))).toEqual(new Set([1000]));

      expect(ranked.map((t) => t.id)).toEqual([made[2], made[1], made[0]]);
    });

    it('rating still outranks recency — the tie-break is only for ties', async () => {
      // Otherwise "newest first" would quietly become the whole sort order.
      const old = await prisma.task.create({
        data: {
          title: `${PREFIX} old but important`,
          listId,
          ownerId: LOCAL_OWNER_ID,
          rating: 1200,
          createdAt: new Date('2026-07-01T10:00:00.000Z'),
        },
      });
      const recent = await prisma.task.create({
        data: {
          title: `${PREFIX} new but unranked`,
          listId,
          ownerId: LOCAL_OWNER_ID,
          rating: 1000,
          createdAt: new Date('2026-07-16T10:00:00.000Z'),
        },
      });

      const res = await agent.get(url('/tasks?sort=rating')).expect(200);
      const ranked = (res.body as Task[]).filter((t) => t.title.startsWith(PREFIX));
      expect(ranked.map((t) => t.id).slice(0, 2)).toEqual([old.id, recent.id]);
    });
  });

  describe('duel sessions over HTTP', () => {
    it('POST /duel-sessions returns an id and the first pair, with full tasks', async () => {
      await seed(3);
      const res = await agent.post(url('/duel-sessions')).send({ listId }).expect(200);
      const body = res.body as SessionStarted;
      expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      // Full task objects, not ids — the duel screen renders titles.
      expect(body.pair.a.title).toContain(PREFIX);
      expect(body.pair.b.title).toContain(PREFIX);
      expect(body.pair.a.id).not.toBe(body.pair.b.id);
    });

    it('reports a small pool as a STATE at 200, never an error (0047)', async () => {
      // Wanting to rank one task is a sensible thing to try. The answer is "add another",
      // which the UI renders as an empty state — not an error handler.
      await seed(1);
      const res = await agent
        .post(url('/duel-sessions'))
        .send({ listId })
        .expect(200);
      const body = res.body as StartSessionResult;
      expect(body.status).toBe('need-more-tasks');
      if (body.status === 'need-more-tasks') {
        expect(body.activeCount).toBe(1);
        expect(body.required).toBe(2);
      }
    });

    it('POST results returns the NEXT pair in the same response — no second round-trip', async () => {
      const [a, b] = await seed(4);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;

      const next = await tapHttp(sid, dealIdOf(started.body as SessionStarted), a, b);
      expect(next.status).toBe('pair');
      if (next.status === 'pair') expect(next.pair.a.id).not.toBe(next.pair.b.id);
    });

    it('never deals a completed task — it retires from the pool immediately (0047)', async () => {
      // Three tasks; complete one MID-SITTING. It must vanish from pair selection at
      // once, not merely be skipped at commit: a duel screen showing a task you just
      // finished is nonsense, whatever commit later does with the tap.
      const [a, b, c] = await seed(3);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;

      await agent.patch(url(`/tasks/${c}/complete`)).expect(200);

      // Draw many pairs: `c` must never appear in any of them.
      for (let i = 0; i < 40; i++) {
        const res = await agent
          .delete(url(`/duel-sessions/${sid}/results/last`))
          .expect(200);
        const next = res.body as NextPairResult;
        expect(next.status).toBe('pair');
        if (next.status !== 'pair') throw new Error('expected a pair');
        expect([next.pair.a.id, next.pair.b.id]).not.toContain(c);
        expect([next.pair.a.id, next.pair.b.id].sort()).toEqual([a, b].sort());
      }
    });

    it('a stale session id 404s — a refreshed tab’s session is genuinely gone (0048)', async () => {
      await seed(2);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      arena.discard(); // simulate the process forgetting, exactly as a restart would

      await agent
        .post(url(`/duel-sessions/${sid}/results`))
        .send({ winnerId: 'x', loserId: 'y', dealId: 'x' } satisfies SubmitResultDto)
        .expect(404);
    });

    it('starting a session discards the one in flight (0048)', async () => {
      const [a, b] = await seed(2);
      const first = await agent.post(url('/duel-sessions')).send({ listId });
      const firstId = (first.body as SessionStarted).sessionId;
      await tapHttp(firstId, dealIdOf(first.body as SessionStarted), a, b);

      const second = await agent.post(url('/duel-sessions')).send({ listId }).expect(200);
      const secondId = (second.body as SessionStarted).sessionId;
      expect(secondId).not.toBe(firstId);
      // The old id is gone.
      await agent
        .post(url(`/duel-sessions/${firstId}/results`))
        .send({ winnerId: a, loserId: b, dealId: 'whatever' } satisfies SubmitResultDto)
        .expect(404);

      const done = await agent.post(url(`/duel-sessions/${secondId}/commit`)).expect(200);
      // The discarded tap never happened.
      expect((done.body as CommitSummary).committed).toBe(0);
    });

    it('DELETE results/last undoes and deals a FRESH pair, never the mis-tapped one', async () => {
      const [a, b] = await seed(2);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      await tapHttp(sid, dealIdOf(started.body as SessionStarted), a, b);

      const res = await agent.delete(url(`/duel-sessions/${sid}/results/last`)).expect(200);
      expect((res.body as NextPairResult).status).toBe('pair');

      const done = await agent.post(url(`/duel-sessions/${sid}/commit`)).expect(200);
      expect((done.body as CommitSummary).committed).toBe(0);
    });

    it('undo with nothing to undo is a no-op, not an error', async () => {
      await seed(2);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      await agent.delete(url(`/duel-sessions/${sid}/results/last`)).expect(200);
    });

    it('rejects a STALE tap with 409 — the pair is no longer on the table (0049)', async () => {
      const [a, b] = await seed(2);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      const stale = dealIdOf(started.body as SessionStarted);

      await tapHttp(sid, stale, a, b); // consumes the deal

      // The same tap arriving twice — a double-tap, or a retry. The second one answers a
      // pair that has already been judged, so it must not become a second duel.
      await agent
        .post(url(`/duel-sessions/${sid}/results`))
        .send({ winnerId: a, loserId: b, dealId: stale } satisfies SubmitResultDto)
        .expect(409);

      const done = await agent.post(url(`/duel-sessions/${sid}/commit`)).expect(200);
      expect((done.body as CommitSummary).committed).toBe(1);
    });

    it('rejects a tap with no dealId at all with 400 (0049)', async () => {
      const [a, b] = await seed(2);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      await agent
        .post(url(`/duel-sessions/${sid}/results`))
        .send({ winnerId: a, loserId: b })
        .expect(400);
    });

    it('every response deals a NEW token, so each pair is answerable once (0049)', async () => {
      const [a, b] = await seed(4);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      const first = dealIdOf(started.body as SessionStarted);
      const next = await tapHttp(sid, first, a, b);
      expect(dealIdOf(next)).not.toBe(first);
      expect(dealIdOf(next)).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('undo supersedes the token, so a tap racing it is refused (0049)', async () => {
      const [a, b] = await seed(2);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      const stale = dealIdOf(started.body as SessionStarted);
      await tapHttp(sid, stale, a, b);

      const undone = await agent
        .delete(url(`/duel-sessions/${sid}/results/last`))
        .expect(200);
      expect(dealIdOf(undone.body as NextPairResult)).not.toBe(stale);

      // The tap that was already in flight when undo landed.
      await agent
        .post(url(`/duel-sessions/${sid}/results`))
        .send({ winnerId: a, loserId: b, dealId: stale } satisfies SubmitResultDto)
        .expect(409);

      const done = await agent.post(url(`/duel-sessions/${sid}/commit`)).expect(200);
      expect((done.body as CommitSummary).committed).toBe(0); // undo stands
    });

    it('rejects a self-duel', async () => {
      const [a] = await seed(2);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      await agent
        .post(url(`/duel-sessions/${sid}/results`))
        .send({
          winnerId: a,
          loserId: a,
          dealId: dealIdOf(started.body as SessionStarted),
        } satisfies SubmitResultDto)
        .expect(400);
    });
  });

  describe('commit summary — the payoff view', () => {
    it('reports what moved and by how much, biggest climber first', async () => {
      const [a, b] = await seed(2);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      await tapHttp(sid, dealIdOf(started.body as SessionStarted), a, b);

      const res = await agent.post(url(`/duel-sessions/${sid}/commit`)).expect(200);
      const summary = res.body as CommitSummary;

      expect(summary.sessionId).toBe(sid);
      expect(summary.committed).toBe(1);
      expect(summary.skipped).toBe(0);
      expect(summary.moved).toHaveLength(2);

      // Biggest climber first.
      const [up, down] = summary.moved;
      expect(up!.task.id).toBe(a);
      expect(up!.before).toBe(1000);
      expect(up!.after).toBe(1032);
      expect(up!.delta).toBe(32);

      expect(down!.task.id).toBe(b);
      expect(down!.before).toBe(1000);
      expect(down!.after).toBe(968);
      expect(down!.delta).toBe(-32);
    });

    it('reports skipped taps when a task is completed mid-sitting (0048)', async () => {
      const [a, b, c] = await seed(3);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      const afterFirst = await tapHttp(sid, dealIdOf(started.body as SessionStarted), a, b);
      await tapHttp(sid, dealIdOf(afterFirst), a, c);
      await agent.patch(url(`/tasks/${c}/complete`)).expect(200);

      const res = await agent.post(url(`/duel-sessions/${sid}/commit`)).expect(200);
      const summary = res.body as CommitSummary;
      expect(summary.committed).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(summary.moved.map((m) => m.task.id).sort()).toEqual([a, b].sort());
    });

    it('deleting mid-sitting drops that task’s pending taps, so undo stays honest', async () => {
      const [a, b, c] = await seed(3);
      const started = await agent.post(url('/duel-sessions')).send({ listId });
      const sid = (started.body as SessionStarted).sessionId;
      await tapHttp(sid, dealIdOf(started.body as SessionStarted), a, b);
      await agent.post(url(`/duel-sessions/${sid}/results`)).send({ winnerId: a, loserId: c });

      await agent.delete(url(`/tasks/${c}`)).expect(204);
      // The c tap is gone, not merely doomed: undo now pops the a-beats-b tap.
      await agent.delete(url(`/duel-sessions/${sid}/results/last`)).expect(200);

      const res = await agent.post(url(`/duel-sessions/${sid}/commit`)).expect(200);
      const summary = res.body as CommitSummary;
      expect(summary.committed).toBe(0);
      expect(summary.skipped).toBe(0);
    });
  });
});
