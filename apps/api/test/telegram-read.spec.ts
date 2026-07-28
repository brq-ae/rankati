import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { TasksService } from '../src/tasks.service';
import { TelegramReadService } from '../src/telegram/telegram-read.service';
import type { TelegramConfigService } from '../src/telegram/telegram-config.service';

/**
 * Read commands (Step 6) against real Postgres. The TIMEZONE source is a stub (so this never touches the
 * shared owner-scoped config row — no race with telegram-config.spec), but tasks + completion run against
 * the real DB. It owns only uniquely-named lists, cleaned up in the hooks; `deal` reads (no mutation).
 */
describe('Telegram read service (real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tasks: TasksService;
  const madeListIds: string[] = [];

  // A read service whose timezone comes from the stub, not the shared config row.
  const readWithTz = (timezone: string | null) =>
    new TelegramReadService(
      prisma,
      { getConfig: async () => ({ timezone }) } as unknown as TelegramConfigService,
      tasks,
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    tasks = app.get(TasksService);
  });

  afterAll(async () => {
    for (const id of madeListIds) await prisma.list.deleteMany({ where: { id } });
    await app?.close();
  });

  it('no timezone set → reads report no-timezone (never a guessed day)', async () => {
    expect(await readWithTz(null).deal(5)).toEqual({ status: 'no-timezone' });
  });

  it('with a timezone, deals up to the limit from the ranked Today read', async () => {
    const svc = readWithTz('Asia/Dubai');
    const five = await svc.deal(5);
    expect(five.status).toBe('ok');
    if (five.status === 'ok') expect(five.cards.length).toBeLessThanOrEqual(5);
    const one = await svc.deal(1);
    expect(one.status).toBe('ok');
    if (one.status === 'ok') expect(one.cards.length).toBeLessThanOrEqual(1);
  });

  it('complete verifies ownership, completes, and answers gone for a foreign/deleted id', async () => {
    const list = await prisma.list.create({ data: { name: 'Zzz Read Target', ownerId: LOCAL_OWNER_ID } });
    madeListIds.push(list.id);
    const task = await prisma.task.create({
      data: { title: 'finish me', listId: list.id, ownerId: LOCAL_OWNER_ID },
    });
    const svc = readWithTz('Asia/Dubai');

    expect(await svc.complete(task.id)).toEqual({ status: 'done', title: 'finish me' });
    expect((await prisma.task.findFirstOrThrow({ where: { id: task.id } })).status).toBe('done');

    expect(await svc.complete('00000000-0000-0000-0000-000000000000')).toEqual({ status: 'gone' });
  });
});
