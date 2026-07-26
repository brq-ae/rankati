import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { ArenaSessionService } from '../src/arena/arena-session.service';
import { applyDuel, roundForStorage, K_PROVISIONAL, K_SETTLED } from '../src/arena/elo';
import { LOCAL_OWNER_ID } from '../src/constants';
import { Prisma } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma.service';

const D = Prisma.Decimal;

/**
 * Duel sessions (ADRs 0047, 0048), against the REAL dev Postgres — `pnpm db:up` must be
 * running. Commit is a transaction and rating is a Decimal column; a mocked database
 * would go green while proving neither.
 */
const PREFIX = '__arenatest__';

describe('ArenaSession (real Postgres)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let arena: ArenaSessionService;
  let prisma: PrismaService;
  let listId: string;

  async function buildApp() {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return { app, arena: app.get(ArenaSessionService), prisma: app.get(PrismaService) };
  }

  async function cleanup() {
    if (!prisma) return;
    await prisma.duel.deleteMany({ where: { ownerId: LOCAL_OWNER_ID, winner: { title: { startsWith: PREFIX } } } });
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

  /** start(), asserting a sitting actually opened. Tests that care about the small-pool
   *  path call arena.start directly and inspect the outcome. */
  async function startOk(id: string) {
    const outcome = await arena.start(id);
    if (outcome.status !== 'started') {
      throw new Error(`expected a session, got ${outcome.status}`);
    }
    return outcome.session;
  }

  /** The token from a freshly dealt pair. */
  function liveDealId(next: Awaited<ReturnType<typeof arena.nextPair>>): string {
    if (next.status !== 'pair') throw new Error(`expected a pair, got ${next.status}`);
    return next.pair.dealId;
  }

  /**
   * Deal a pair, then answer it — what the client does on every tap.
   *
   * A tap must now carry the dealId of the live deal, so a session that has not dealt
   * anything cannot be tapped. These tests name the pair they intend rather than whatever
   * the pairing happened to draw: the token binds a tap to the DEAL it answers, and the
   * task ids are the client's report of what it displayed. That boundary is deliberate
   * (see ADR 0049) — it is what lets these tests exercise the arithmetic on a chosen pair
   * while the protocol itself is covered over HTTP in arena-api.spec.ts.
   */
  async function tap(sessionId: string, winnerId: string, loserId: string): Promise<void> {
    arena.submitResult(sessionId, winnerId, loserId, liveDealId(await arena.nextPair(sessionId)));
  }

  const ratingOf = async (id: string) =>
    (await prisma.task.findUniqueOrThrow({ where: { id } })).rating.toFixed(2);

  beforeEach(async () => {
    if (!app) ({ app, arena, prisma } = await buildApp());
    await cleanup();
    arena.discard();
    const list = await prisma.list.create({ data: { name: `${PREFIX} list`, ownerId: LOCAL_OWNER_ID } });
    listId = list.id;
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  it('reports a small pool as a state, never an exception (0047)', async () => {
    await seed(1);
    const outcome = await arena.start(listId);
    expect(outcome.status).toBe('need-more-tasks');
    if (outcome.status === 'need-more-tasks') {
      expect(outcome.activeCount).toBe(1);
    }
  });

  it('refuses a task dueling itself', async () => {
    const [a] = await seed(2);
    const s = await startOk(listId);
    const dealId = liveDealId(await arena.nextPair(s.id));
    // A self-duel is rejected on its own merits, before the token is even considered.
    expect(() => arena.submitResult(s.id, a, a, dealId)).toThrow(/cannot duel itself/);
  });

  it('writes NOTHING until the session is ended (0048)', async () => {
    const [a, b] = await seed(2);
    const s = await startOk(listId);
    await tap(s.id, a, b);

    // Mid-session: the tap exists only in memory.
    expect(await ratingOf(a)).toBe('1000.00');
    expect(await prisma.duel.count({ where: { sessionId: s.id } })).toBe(0);

    await arena.commit(s.id);
    expect(await ratingOf(a)).toBe('1032.00');
    expect(await prisma.duel.count({ where: { sessionId: s.id } })).toBe(1);
  });

  it('an abandoned session records nothing at all (0048)', async () => {
    const [a, b] = await seed(2);
    const s = await startOk(listId);
    await tap(s.id, a, b);
    arena.discard(); // what a refresh or a container restart does implicitly

    expect(await ratingOf(a)).toBe('1000.00');
    expect(await prisma.duel.count({ where: { sessionId: s.id } })).toBe(0);
  });

  it('commits the worked example: 1032.00 / 968.00, then 1058.17 / 941.83', async () => {
    // Hand-computed in Python, independent of this code (see elo.spec.ts).
    const [a, b] = await seed(2);
    const s = await startOk(listId);
    await tap(s.id, a, b);
    const first = await arena.commit(s.id);
    expect(first.committed).toBe(1);
    expect(await ratingOf(a)).toBe('1032.00');
    expect(await ratingOf(b)).toBe('968.00');

    const s2 = await startOk(listId);
    await tap(s2.id, a, b);
    await arena.commit(s2.id);
    expect(await ratingOf(a)).toBe('1058.17');
    expect(await ratingOf(b)).toBe('941.83');
  });

  it('rounds ONCE at persist, not per duel — the two genuinely differ (0047)', async () => {
    // Eight taps in ONE sitting, A beating B every time, both provisional.
    // Hand-computed in Python:
    //   rounding every duel -> 1150.04 / 849.96
    //   rounding once       -> 1150.05 / 849.95   <- what we do
    // A cent, but it is drift we can decline to introduce, and 0048 requires replay to
    // reproduce storage exactly — so WHERE the rounding happens is part of the contract.
    // This test is the only thing standing between the two strategies: with fewer than
    // eight duels in a sitting they agree, and it would pass either way.
    const [a, b] = await seed(2);
    const s = await startOk(listId);
    for (let i = 0; i < 8; i++) await tap(s.id, a, b);
    await arena.commit(s.id);

    expect(await ratingOf(a)).toBe('1150.05');
    expect(await ratingOf(b)).toBe('849.95');
  });

  it('undo pops the last tap, newest-first, and leaves the rest (0048)', async () => {
    const [a, b] = await seed(2);
    const s = await startOk(listId);
    await tap(s.id, a, b); // keep
    await tap(s.id, b, a); // undo this one
    expect(arena.undoLast(s.id)).toBe(true);
    await arena.commit(s.id);

    // Only the first tap survives: identical to never having tapped the second.
    expect(await ratingOf(a)).toBe('1032.00');
    expect(await prisma.duel.count({ where: { sessionId: s.id } })).toBe(1);
  });

  describe('the deal token — both sides agree which pair is being judged (0049)', () => {
    it('rejects a tap carrying no token at all', async () => {
      const [a, b] = await seed(2);
      const s = await startOk(listId);
      await arena.nextPair(s.id);
      expect(() => arena.submitResult(s.id, a, b, '')).toThrow(/dealId is required/);
    });

    it('rejects a tap on a session that has dealt nothing', async () => {
      const [a, b] = await seed(2);
      const s = await startOk(listId);
      // start() opens a sitting but deals no pair; nothing is on the table to answer.
      expect(() => arena.submitResult(s.id, a, b, randomUUID())).toThrow(/no longer on the table/);
    });

    it('rejects a SECOND tap on the same deal — the double-tap that double-counted', async () => {
      const [a, b] = await seed(2);
      const s = await startOk(listId);
      const dealId = liveDealId(await arena.nextPair(s.id));

      arena.submitResult(s.id, a, b, dealId); // the tap
      // The impatient second press, before the next pair rendered. Previously recorded a
      // second identical duel and committed the same judgement twice.
      expect(() => arena.submitResult(s.id, a, b, dealId)).toThrow(/no longer on the table/);

      const summary = await arena.commit(s.id);
      expect(summary.committed).toBe(1);
      expect(await ratingOf(a)).toBe('1032.00'); // moved once, not twice
    });

    it('rejects a tap that raced an UNDO — the stale-pair desync', async () => {
      const [a, b] = await seed(2);
      const s = await startOk(listId);
      const stale = liveDealId(await arena.nextPair(s.id));
      arena.submitResult(s.id, a, b, stale);

      arena.undoLast(s.id);
      await arena.nextPair(s.id); // undo deals fresh, superseding `stale`

      // A tap that left the client before the undo landed. It answers a pair that is no
      // longer on the table, so it is refused rather than recorded against the new one.
      expect(() => arena.submitResult(s.id, a, b, stale)).toThrow(/no longer on the table/);

      const summary = await arena.commit(s.id);
      expect(summary.committed).toBe(0); // the undo stands; the stale tap never landed
    });

    it('rapid tap-undo-tap stays consistent, and every deal answers exactly once', async () => {
      const [a, b] = await seed(2);
      const s = await startOk(listId);

      // tap
      const d1 = liveDealId(await arena.nextPair(s.id));
      arena.submitResult(s.id, a, b, d1);
      // undo
      expect(arena.undoLast(s.id)).toBe(true);
      const d2 = liveDealId(await arena.nextPair(s.id));
      // tap again, immediately
      arena.submitResult(s.id, a, b, d2);

      expect(d2).not.toBe(d1); // a fresh deal, not the erased one
      expect(() => arena.submitResult(s.id, a, b, d1)).toThrow(/no longer on the table/);
      expect(() => arena.submitResult(s.id, a, b, d2)).toThrow(/no longer on the table/);

      const summary = await arena.commit(s.id);
      expect(summary.committed).toBe(1); // exactly one judgement survived the sequence
      expect(await ratingOf(a)).toBe('1032.00');
    });

    it('issues a distinct token for every deal', async () => {
      await seed(2);
      const s = await startOk(listId);
      const seen = new Set<string>();
      for (let i = 0; i < 5; i++) seen.add(liveDealId(await arena.nextPair(s.id)));
      expect(seen.size).toBe(5);
    });

    it('a dry pool leaves nothing on the table (2b)', async () => {
      const [a, b] = await seed(2);
      const s = await startOk(listId);
      const dealId = liveDealId(await arena.nextPair(s.id));
      arena.submitResult(s.id, a, b, dealId);

      await prisma.task.delete({ where: { id: b } });
      const next = await arena.nextPair(s.id);
      expect(next.status).toBe('need-more-tasks');

      // The session is STILL ALIVE — commit remains reachable, which is the whole point
      // of 2b. It is simply not auto-committed (0048: End is the only commit trigger).
      const summary = await arena.commit(s.id);
      expect(summary.committed).toBe(0); // the tap named a deleted task -> skipped (0048)
    });
  });

  it('a task that nets ZERO is persisted but is not a mover', async () => {
    // Netting zero needs BOTH duels to be even, or the second one moves a different
    // amount than the first (an unequal duel is the whole point of Elo). Hand-computed:
    //   a beats d : both 1000, E=0.5 -> a=1032, d=968
    //   b beats c : both 1000, E=0.5 -> b=1032, c=968
    //   a beats b : both 1032, E=0.5 -> a=1064, b=1000   <- b returns exactly to start
    // b dueled twice and ended where it began.
    const [a, b, c, d] = await seed(4);
    const s = await startOk(listId);
    await tap(s.id, a, d);
    await tap(s.id, b, c);
    await tap(s.id, a, b);

    const summary = await arena.commit(s.id);
    expect(await ratingOf(b)).toBe('1000.00'); // net zero...
    const bTask = await prisma.task.findUniqueOrThrow({ where: { id: b } });
    expect(bTask.duelCount).toBe(2); // ...but the duels are real and persisted

    const movedIds = summary.moved.map((m) => m.task.id);
    expect(movedIds).not.toContain(b); // it is not a MOVER
    expect(movedIds.sort()).toEqual([a, c, d].sort());
    expect(summary.moved.every((m) => m.delta !== 0)).toBe(true);
  });

  it('undo on an empty session is a no-op, not an error', async () => {
    await seed(2);
    const s = await startOk(listId);
    expect(arena.undoLast(s.id)).toBe(false);
  });

  it('freezes K at session start: crossing 5 duels mid-session keeps K=64 (0047)', async () => {
    // Seeded at 4 duels: provisional. The 5th tap would graduate it live, but K is
    // frozen for the whole sitting, so all taps here move at 64.
    const [a, b] = await seed(2, 4);
    const s = await startOk(listId);
    await tap(s.id, a, b);
    await tap(s.id, a, b);
    await arena.commit(s.id);

    const duels = await prisma.duel.findMany({ where: { sessionId: s.id }, orderBy: { seq: 'asc' } });
    expect(duels).toHaveLength(2);
    // Both duels — including the one after `a` reached 5 — recorded K=64.
    expect(duels.map((x) => x.kWinner)).toEqual([K_PROVISIONAL, K_PROVISIONAL]);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: a } });
    expect(task.duelCount).toBe(6);
  });

  it('records the two Ks per duel, because K is per player (0047)', async () => {
    const [prov] = await seed(1); // 0 duels -> provisional
    const [settled] = await seed(1, 10); // 10 duels -> settled
    const s = await startOk(listId);
    await tap(s.id, prov, settled);
    await arena.commit(s.id);

    const duel = await prisma.duel.findFirstOrThrow({ where: { sessionId: s.id } });
    expect(duel.kWinner).toBe(K_PROVISIONAL);
    expect(duel.kLoser).toBe(K_SETTLED);
    expect(await ratingOf(prov)).toBe('1032.00'); // +32 = 64 * 0.5
    expect(await ratingOf(settled)).toBe('988.00'); // -12 = 24 * 0.5
  });

  it('skips taps whose task was completed mid-session, and commits the rest (0048)', async () => {
    const [a, b, c] = await seed(3);
    const s = await startOk(listId);
    await tap(s.id, a, b); // survives
    await tap(s.id, a, c); // c gets completed below -> skipped

    await prisma.task.update({ where: { id: c }, data: { status: 'done', completedAt: new Date() } });

    const summary = await arena.commit(s.id);
    expect(summary.committed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(await ratingOf(a)).toBe('1032.00'); // moved once, not twice
    expect(await ratingOf(c)).toBe('1000.00'); // retired frozen, untouched
  });

  it('skips taps whose task was deleted mid-session', async () => {
    const [a, b, c] = await seed(3);
    const s = await startOk(listId);
    await tap(s.id, a, b);
    await tap(s.id, c, a);
    await prisma.task.delete({ where: { id: c } });

    const summary = await arena.commit(s.id);
    expect(summary.committed).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it('starting a session discards the one in flight (0048)', async () => {
    const [a, b] = await seed(2);
    const first = await startOk(listId);
    await tap(first.id, a, b);

    const second = await startOk(listId);
    expect(second.id).not.toBe(first.id);
    // The old session is gone — its id no longer resolves.
    expect(() => arena.undoLast(first.id)).toThrow(/no live session/);

    await arena.commit(second.id);
    expect(await ratingOf(a)).toBe('1000.00'); // the discarded tap never happened
  });

  it('THE REPLAY INVARIANT: replaying the log reproduces stored ratings exactly (0048)', async () => {
    const [a, b, c] = await seed(3);

    // THREE sittings of SEVERAL duels each — not one duel each. With a single duel per
    // sitting, rounding per-duel and rounding per-session are identical and this test
    // would pass either way, proving nothing about where rounding happens. Multi-duel
    // sittings force the replay to round exactly where commit rounds.
    const sittings = [
      [
        [a, b],
        [a, c],
        [b, c],
        [a, b],
      ],
      [
        [c, a],
        [c, b],
        [a, b],
      ],
      [
        [b, a],
        [b, c],
        [c, a],
        [b, a],
        [c, b],
      ],
    ] as const;

    for (const sitting of sittings) {
      const s = await startOk(listId);
      for (const [w, l] of sitting) await tap(s.id, w, l);
      await arena.commit(s.id);
    }

    const stored = await prisma.task.findMany({
      where: { title: { startsWith: PREFIX } },
      orderBy: { id: 'asc' },
    });
    const duels = await prisma.duel.findMany({
      where: { winner: { title: { startsWith: PREFIX } } },
      orderBy: { seq: 'asc' },
    });
    expect(duels).toHaveLength(12);

    // Replay from scratch: every task at 1000/0, duels grouped by the sitting they
    // belonged to, applied in seq order with the K the log recorded, carrying full
    // precision within a sitting and rounding at its end — which is what sessionId is
    // FOR. Without that column this reconstruction would be impossible (0047, 0048).
    const bySession = new Map<string, typeof duels>();
    for (const duel of duels) {
      const group = bySession.get(duel.sessionId) ?? [];
      group.push(duel);
      bySession.set(duel.sessionId, group);
    }
    expect(bySession.size).toBe(3);
    // Each group has at least one duel by construction (it exists because a duel made it).
    const ordered = [...bySession.values()].sort((x, y) => x[0]!.seq - y[0]!.seq);

    const replay = new Map(stored.map((t) => [t.id, { rating: new D(1000), duelCount: 0 }]));
    for (const sitting of ordered) {
      const touched = new Set<string>();
      for (const duel of sitting) {
        const w = replay.get(duel.winnerId)!;
        const l = replay.get(duel.loserId)!;
        const next = applyDuel(w.rating, l.rating, duel.kWinner, duel.kLoser);
        replay.set(duel.winnerId, { rating: next.winner, duelCount: w.duelCount + 1 });
        replay.set(duel.loserId, { rating: next.loser, duelCount: l.duelCount + 1 });
        touched.add(duel.winnerId);
        touched.add(duel.loserId);
      }
      for (const id of touched) {
        const t = replay.get(id)!;
        replay.set(id, { rating: roundForStorage(t.rating), duelCount: t.duelCount });
      }
    }

    for (const task of stored) {
      const r = replay.get(task.id)!;
      expect(r.rating.toFixed(2), `rating of ${task.title}`).toBe(task.rating.toFixed(2));
      expect(r.duelCount, `duelCount of ${task.title}`).toBe(task.duelCount);
    }
  });
});
