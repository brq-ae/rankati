import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Effort } from '@rankati/shared';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * The effort bucket stores and round-trips (ADR 0072), and defaults to NULL:
 *   - each of quick / medium / long round-trips unchanged;
 *   - a task created without one is NULL — untagged, which fits any block and never sinks,
 *     and is also every task that existed before this column.
 * This slice is INERT storage: no `fit` ranking behaviour is exercised here (that lands with the
 * server slice); this proves only that the column holds and returns the value.
 */
const PREFIX = '__efforttest__';
const EFFORTS: Effort[] = ['quick', 'medium', 'long'];

describe('effort storage: a bucket or NULL = untagged (ADR 0072)', () => {
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

  for (const effort of EFFORTS) {
    it(`round-trips ${effort} unchanged`, async () => {
      const task = await prisma.task.create({
        data: { title: `${PREFIX} ${effort}`, listId, ownerId: LOCAL_OWNER_ID, effort },
      });
      const back = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(back.effort).toBe(effort);
    });
  }

  it('NULL means untagged — an untouched task defaults to it', async () => {
    const task = await prisma.task.create({
      data: { title: `${PREFIX} untagged`, listId, ownerId: LOCAL_OWNER_ID },
    });
    const back = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(back.effort).toBeNull();
  });
});
