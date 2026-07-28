import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { TelegramCaptureService } from '../src/telegram/telegram-capture.service';

/**
 * Capture rules (ADR 0084, Step 5) against real Postgres. Isolated from the parallel lists/tasks specs by
 * touching only its OWN data: the Inbox list (nothing else creates one) and uniquely-named target lists,
 * cleaned up in the hooks. Cascade drops the tasks in those lists.
 */
const INBOX_FILTER = { ownerId: LOCAL_OWNER_ID, name: { equals: 'Inbox', mode: 'insensitive' as const } };

describe('Telegram capture (real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let capture: TelegramCaptureService;
  const madeListIds: string[] = [];

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      capture = app.get(TelegramCaptureService);
    }
    await prisma.list.deleteMany({ where: INBOX_FILTER }); // clean slate for the Inbox find-or-create
  });

  afterAll(async () => {
    await prisma.list.deleteMany({ where: INBOX_FILTER });
    for (const id of madeListIds) await prisma.list.deleteMany({ where: { id } });
    await app?.close();
  });

  it('creates an Inbox + a needsDetails task, then reuses the Inbox (no duplicate)', async () => {
    const r1 = await capture.capture('  buy milk  ');
    expect(r1.task.title).toBe('buy milk');
    expect(r1.task.needsDetails).toBe(true);
    const inbox = await prisma.list.findFirstOrThrow({ where: { id: r1.task.listId } });
    expect(inbox.name).toBe('Inbox');

    const r2 = await capture.capture('call plumber');
    expect(r2.task.listId).toBe(r1.task.listId);
    expect(await prisma.list.count({ where: INBOX_FILTER })).toBe(1);
  });

  it('reuses a pre-existing lower-case "inbox" (case-insensitive)', async () => {
    const lower = await prisma.list.create({ data: { name: 'inbox', ownerId: LOCAL_OWNER_ID } });
    const r = await capture.capture('a note');
    expect(r.task.listId).toBe(lower.id);
  });

  it('truncates an over-long capture to a sane title, flagged', async () => {
    const r = await capture.capture('x'.repeat(500));
    expect(r.truncated).toBe(true);
    expect(r.task.title.length).toBeLessThanOrEqual(200);
    expect(r.task.title.endsWith('…')).toBe(true);
  });

  it('re-file moves the task and KEEPS needsDetails (Option B)', async () => {
    const target = await prisma.list.create({ data: { name: 'Zzz Capture Target', ownerId: LOCAL_OWNER_ID } });
    madeListIds.push(target.id);
    const r = await capture.capture('file me');
    expect(await capture.refile(r.task.id, target.id)).toEqual({ status: 'moved', listName: 'Zzz Capture Target' });
    const moved = await prisma.task.findFirstOrThrow({ where: { id: r.task.id } });
    expect(moved.listId).toBe(target.id);
    expect(moved.needsDetails).toBe(true);
  });

  it('discard deletes the just-captured task and returns its title; a stale/foreign id answers gone', async () => {
    const r = await capture.capture('oops wrong thing');
    expect(await capture.discard(r.task.id)).toEqual({ status: 'discarded', title: 'oops wrong thing' });
    expect(await prisma.task.findFirst({ where: { id: r.task.id } })).toBeNull(); // gone from the DB

    // discarding again (already deleted) → gone, not a throw
    expect(await capture.discard(r.task.id)).toEqual({ status: 'gone' });
    expect(await capture.discard('00000000-0000-0000-0000-000000000000')).toEqual({ status: 'gone' });
  });

  it('re-file of a deleted task or a missing list answers stale, never throws', async () => {
    const target = await prisma.list.create({ data: { name: 'Zzz Capture Gone', ownerId: LOCAL_OWNER_ID } });
    madeListIds.push(target.id);

    const gone = await capture.capture('temp');
    await prisma.task.delete({ where: { id: gone.task.id } });
    expect(await capture.refile(gone.task.id, target.id)).toEqual({ status: 'stale' });

    const live = await capture.capture('temp2');
    expect(await capture.refile(live.task.id, '00000000-0000-0000-0000-000000000000')).toEqual({ status: 'stale' });
  });
});
