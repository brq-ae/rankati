import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { buildFreshState, type FreshState, type ResolvedTask } from '../src/fresh-state';
import { PrismaService } from '../src/prisma.service';
import { seedFreshState } from '../src/reset-core';

/**
 * The seeder resolves locations BY NAME and dependencies BY TITLE (ADR 0065). A miss must FAIL LOUD —
 * throw, not silently skip — because a skipped reference yields an untagged task or an unlinked chain
 * while the seed still reports success: the sample would look fine on casual inspection and quietly
 * demonstrate nothing. And because it runs inside `resetOwner`'s ONE transaction, a throw rolls back
 * cleanly — a half-seeded set cannot result. Both properties are proven here against real Postgres.
 *
 * Throwaway owners only — no test targets `local` (ADR 0064).
 */
const OP = '__seedfail__';
const owner = () => `${OP}${randomUUID()}`;

const task = (over: Partial<ResolvedTask>): ResolvedTask => ({
  title: 'x',
  list: 'L',
  locations: [],
  due: null,
  notBefore: null,
  tier: 'normal',
  requires: null,
  status: 'active',
  completedAt: null,
  ...over,
});

const base: FreshState = {
  locations: ['Home', 'Garage'],
  lists: ['L'],
  tasks: [task({ title: 'A' }), task({ title: 'B', requires: 'A' })],
};

describe('seedFreshState fails loud on an unresolved reference (real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  async function counts(o: string) {
    const [lists, tasks, locations] = await Promise.all([
      prisma.list.count({ where: { ownerId: o } }),
      prisma.task.count({ where: { ownerId: o } }),
      prisma.location.count({ where: { ownerId: o } }),
    ]);
    return { lists, tasks, locations };
  }
  async function cleanup() {
    await prisma.task.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.list.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.location.deleteMany({ where: { ownerId: { startsWith: OP } } });
  }

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('the REAL sample set resolves without throwing', async () => {
    const o = owner();
    await expect(
      prisma.$transaction((tx) =>
        seedFreshState(tx, o, buildFreshState(new Date('2026-01-15T00:00:00Z'))),
      ),
    ).resolves.toBeTruthy();
    expect((await counts(o)).tasks).toBeGreaterThan(20); // the full set actually landed
    await cleanup();
  });

  it('an unknown LOCATION name throws AND rolls back (no partial set)', async () => {
    const o = owner();
    const bad: FreshState = {
      ...base,
      tasks: [task({ title: 'A', locations: ['Nowhere'] }), base.tasks[1]!],
    };
    await expect(prisma.$transaction((tx) => seedFreshState(tx, o, bad))).rejects.toThrow(
      /unknown location "Nowhere"/,
    );
    // The locations/list/task written before the throw were rolled back with it.
    expect(await counts(o)).toEqual({ lists: 0, tasks: 0, locations: 0 });
  });

  it('an unknown PREREQUISITE title throws AND rolls back (no partial set)', async () => {
    const o = owner();
    const bad: FreshState = {
      ...base,
      tasks: [base.tasks[0]!, task({ title: 'B', requires: 'Ghost' })],
    };
    await expect(prisma.$transaction((tx) => seedFreshState(tx, o, bad))).rejects.toThrow(
      /requires unknown task "Ghost"/,
    );
    expect(await counts(o)).toEqual({ lists: 0, tasks: 0, locations: 0 });
  });
});
