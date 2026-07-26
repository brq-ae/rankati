import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * How an AvailabilityWindow survives the trip through Prisma (ADR 0070).
 *
 * The window is a nullable Postgres enum — a plain string on both sides, so unlike
 * notBefore there is no driver conversion to police and no timezone to get wrong. What
 * this asserts instead is the column's two load-bearing facts:
 *
 *   - each of the three FIXED presets round-trips unchanged — the closed set the gate
 *     will switch on is exactly the set the database accepts and returns;
 *   - a task created without one is NULL — Anytime, ungated, which is also every task
 *     that existed before the column (additive, no backfill).
 *
 * In this slice the column is inert storage: stored and mapped, gating nothing. The
 * gate clause lands with the predicate, and stands on what is proven here.
 */

const PREFIX = '__availwindow_storage__';

/** The whole closed set (ADR 0070). Anytime is NULL on the column, not a member. */
const WINDOWS = ['working_hours', 'workdays', 'weekend'] as const;

describe('availabilityWindow storage: a fixed preset or NULL = Anytime (0070)', () => {
  let app: Awaited<ReturnType<typeof build>>['app'];
  let prisma: PrismaService;
  let listId: string;

  async function build() {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = m.createNestApplication();
    await app.init();
    return { app, prisma: app.get(PrismaService) };
  }

  async function cleanup() {
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    ({ app, prisma } = await build());
    await cleanup();
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  for (const window of WINDOWS) {
    it(`round-trips ${window} unchanged`, async () => {
      const task = await prisma.task.create({
        data: {
          title: `${PREFIX} ${window}`,
          listId,
          ownerId: LOCAL_OWNER_ID,
          availabilityWindow: window,
        },
      });
      const back = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(back.availabilityWindow).toBe(window);
    });
  }

  it('NULL means Anytime — an untouched task defaults to it', async () => {
    const task = await prisma.task.create({
      data: { title: `${PREFIX} anytime`, listId, ownerId: LOCAL_OWNER_ID },
    });
    const back = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(back.availabilityWindow).toBeNull();
  });
});
