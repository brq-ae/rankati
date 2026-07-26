import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * The needsDetails flag stores and round-trips (ADR 0073), and defaults to FALSE:
 *   - a task created without it is `false` — unflagged, which is also every task that existed
 *     before this column (the flag is a creation-time stamp; backfilling it would lie);
 *   - both true and false round-trip unchanged.
 * This slice is INERT storage: no set-on-create / clear-on-edit lifecycle is exercised here (that
 * lands with the server slice); this proves only that the column holds and returns the value.
 */
const PREFIX = '__needsdetailstest__';

describe('needsDetails storage: a boolean, default false (ADR 0073)', () => {
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

  it('defaults to false — an untouched task is unflagged (also every pre-existing task)', async () => {
    const task = await prisma.task.create({
      data: { title: `${PREFIX} default`, listId, ownerId: LOCAL_OWNER_ID },
    });
    const back = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(back.needsDetails).toBe(false);
  });

  for (const value of [true, false]) {
    it(`round-trips ${value} unchanged`, async () => {
      const task = await prisma.task.create({
        data: { title: `${PREFIX} ${value}`, listId, ownerId: LOCAL_OWNER_ID, needsDetails: value },
      });
      const back = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(back.needsDetails).toBe(value);
    });
  }
});
