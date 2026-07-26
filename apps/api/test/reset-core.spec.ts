import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { DEFAULT_LOCATIONS, SAMPLE_LISTS, buildFreshState } from '../src/fresh-state';
import { PrismaService } from '../src/prisma.service';
import { resetOwner } from '../src/reset-core';

/**
 * The destructive core (ADR 0064) against real Postgres — `pnpm db:up` must be running.
 *
 * NO TEST HERE TARGETS `ownerId` "local" (the standing rule, ADR 0064): every owner is a throwaway
 * `__resettest__<uuid>`, and the OWNER BOUNDARY is proven FIRST and sabotaged in the dangerous
 * direction, because every other assertion in this milestone is safe only while that boundary holds.
 */
const OPREFIX = '__resettest__';
const owner = () => `${OPREFIX}${randomUUID()}`;

// The sample's shape, computed from the definition so these track the content (ADR 0065): a fixed
// `now` keeps it deterministic; counts don't depend on the dates anyway.
const FRESH = buildFreshState(new Date('2026-01-15T00:00:00Z'));
const FRESH_TASKS = FRESH.tasks.length;
const FRESH_DEPS = FRESH.tasks.filter((t) => t.requires !== null).length;
const FRESH_TAGS = FRESH.tasks.reduce((n, t) => n + t.locations.length, 0);

interface Snapshot {
  lists: number;
  tasks: number;
  duels: number;
  deps: number;
  tags: number;
  locations: number;
  routines: number;
}

describe('reset core (real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  /** A full data spread for one owner: lists, a rated task, a duel, a dependency link, a location tag. */
  async function seedFullOwner(ownerId: string): Promise<void> {
    const listA = await prisma.list.create({ data: { name: 'L-A', ownerId } });
    const listB = await prisma.list.create({ data: { name: 'L-B', ownerId } });
    const a = await prisma.task.create({
      data: { title: 'T-A', listId: listA.id, ownerId, rating: 1234.56, duelCount: 3 },
    });
    const b = await prisma.task.create({ data: { title: 'T-B', listId: listA.id, ownerId } });
    const c = await prisma.task.create({ data: { title: 'T-C', listId: listB.id, ownerId } });
    // C depends on A (a dependency link — an ownerless join row, reachable only through its tasks).
    await prisma.taskDependency.create({ data: { taskId: c.id, dependsOnId: a.id } });
    // A committed duel (A beat B).
    await prisma.duel.create({
      data: { winnerId: a.id, loserId: b.id, sessionId: randomUUID(), kWinner: 24, kLoser: 24, ownerId },
    });
    // A location and a tag on A (the tag is an ownerless join row; the location is owner-scoped).
    const loc = await prisma.location.create({ data: { name: `P-${randomUUID()}`, ownerId } });
    await prisma.taskLocation.create({ data: { taskId: a.id, locationId: loc.id } });
    // A routine — wholly outside the engine (ADR 0066). Factory reset removes it; clear-tasks keeps it.
    await prisma.routine.create({
      data: { name: 'R-A', ownerId, type: 'frequency', periodUnit: 'day', targetCount: 1, periodCount: 0 },
    });
  }

  async function snapshot(ownerId: string): Promise<Snapshot> {
    const [lists, tasks, duels, deps, tags, locations, routines] = await Promise.all([
      prisma.list.count({ where: { ownerId } }),
      prisma.task.count({ where: { ownerId } }),
      prisma.duel.count({ where: { ownerId } }),
      // The ownerless join tables are counted THROUGH their owner-scoped task.
      prisma.taskDependency.count({ where: { task: { ownerId } } }),
      prisma.taskLocation.count({ where: { task: { ownerId } } }),
      prisma.location.count({ where: { ownerId } }),
      prisma.routine.count({ where: { ownerId } }),
    ]);
    return { lists, tasks, duels, deps, tags, locations, routines };
  }

  async function cleanupAll(): Promise<void> {
    await prisma.duel.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
    await prisma.task.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
    await prisma.list.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
    await prisma.location.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
    await prisma.routine.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
  }

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    await cleanupAll();
  });

  afterAll(async () => {
    await cleanupAll();
    await app.close();
  });

  // ── THE BOUNDARY — proven first, everything else rests on it ─────────────────────────────────
  describe('owner boundary (the load-bearing invariant)', () => {
    it('resetting owner A leaves EVERY table of owner B untouched', async () => {
      const a = owner();
      const b = owner();
      await seedFullOwner(a);
      await seedFullOwner(b);

      const bBefore = await snapshot(b);
      // Sanity: B really does have a row in every table, or "untouched" would prove nothing.
      expect(bBefore).toEqual({ lists: 2, tasks: 3, duels: 1, deps: 1, tags: 1, locations: 1, routines: 1 });

      await resetOwner(prisma, a, 'factory', { keepSampleData: true });

      // B: identical in every table. A: actually reset (guards against a no-op passing this test).
      expect(await snapshot(b)).toEqual(bBefore);
      const aAfter = await snapshot(a);
      expect(aAfter).toMatchObject({ tasks: FRESH_TASKS, duels: 0, deps: FRESH_DEPS, tags: FRESH_TAGS, routines: 0 });
    });
  });

  describe('clear-tasks — content dies, structure survives', () => {
    it('deletes tasks and everything downstream, keeps lists (empty) and locations (untouched)', async () => {
      const a = owner();
      await seedFullOwner(a);
      const listsBefore = await prisma.list.findMany({ where: { ownerId: a }, select: { id: true } });
      const locsBefore = await prisma.location.findMany({ where: { ownerId: a }, select: { id: true } });

      await resetOwner(prisma, a, 'clear-tasks');

      const after = await snapshot(a);
      // clear-tasks LEAVES routines (not task-derived, ADR 0066) — like lists and locations.
      expect(after).toMatchObject({ tasks: 0, duels: 0, deps: 0, tags: 0, routines: 1 });
      // Lists and locations survive — same ids, not deleted-and-recreated (so a pin stays valid).
      const listsAfter = await prisma.list.findMany({ where: { ownerId: a }, select: { id: true } });
      const locsAfter = await prisma.location.findMany({ where: { ownerId: a }, select: { id: true } });
      expect(listsAfter.map((l) => l.id).sort()).toEqual(listsBefore.map((l) => l.id).sort());
      expect(locsAfter.map((l) => l.id).sort()).toEqual(locsBefore.map((l) => l.id).sort());
    });
  });

  describe('factory — back to the shipped state', () => {
    it('keepSampleData: true seeds the sample lists/tasks and the four default locations', async () => {
      const a = owner();
      await seedFullOwner(a);
      await resetOwner(prisma, a, 'factory', { keepSampleData: true });

      const lists = await prisma.list.findMany({ where: { ownerId: a }, select: { name: true } });
      const locs = await prisma.location.findMany({ where: { ownerId: a }, select: { name: true } });
      expect(lists.map((l) => l.name).sort()).toEqual([...SAMPLE_LISTS].sort());
      expect(locs.map((l) => l.name).sort()).toEqual([...DEFAULT_LOCATIONS].sort());
      expect(await snapshot(a)).toMatchObject({
        tasks: FRESH_TASKS,
        duels: 0,
        deps: FRESH_DEPS,
        tags: FRESH_TAGS,
        routines: 0, // factory removes routines — a fresh install has none
      });
    });

    it('keepSampleData: false yields no lists and no tasks — but STILL the four default locations', async () => {
      const a = owner();
      await seedFullOwner(a);
      await resetOwner(prisma, a, 'factory', { keepSampleData: false });

      const locs = await prisma.location.findMany({ where: { ownerId: a }, select: { name: true } });
      expect(await snapshot(a)).toMatchObject({ lists: 0, tasks: 0, locations: DEFAULT_LOCATIONS.length, routines: 0 });
      expect(locs.map((l) => l.name).sort()).toEqual([...DEFAULT_LOCATIONS].sort());
    });
  });

  describe('atomicity — a failed reset changes nothing', () => {
    it('a throw anywhere in the transaction rolls back every delete AND the reseed', async () => {
      const a = owner();
      await seedFullOwner(a);
      const before = await snapshot(a);

      // Inject a failure AFTER all reset work, inside the same transaction: if the deletes were not
      // wrapped in it, they would NOT roll back and `before` would not be restored. Proving the
      // restore proves the whole reset is one transaction.
      const failing = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === '$transaction') {
            return (fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
              (target.$transaction as (f: unknown, o?: unknown) => Promise<unknown>)(async (tx: unknown) => {
                await fn(tx);
                throw new Error('injected failure after all reset work');
              }, options);
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as PrismaService;

      await expect(resetOwner(failing, a, 'factory', { keepSampleData: true })).rejects.toThrow(
        'injected failure',
      );
      expect(await snapshot(a)).toEqual(before);
    });
  });
});
