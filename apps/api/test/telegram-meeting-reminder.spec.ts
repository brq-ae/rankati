import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import {
  TelegramMeetingReminderService,
  formatReminder,
} from '../src/telegram/telegram-meeting-reminder.service';

/**
 * ADR 0097 S2 — the meeting-reminder firing pass. Driven off the per-minute tick (no new timer). The bot is
 * a FAKE (no real Telegram); the service is constructed with the real Prisma + the fake, and `evaluate` is
 * called with an injected `now`, so firing is tested by advancing that clock. The tick already guarantees a
 * bound chat + tz before calling evaluate — the graceful skip when either is missing lives there.
 */
const PREFIX = '__mremind__';
const CHAT = '99';
const TZ = 'Asia/Dubai';

class FakeBot {
  sends: string[] = [];
  result: 'sent' | 'no-bot' | 'error' = 'sent';
  pushReminder = vi.fn(async (_chatId: string, text: string) => {
    if (this.result === 'sent') this.sends.push(text);
    return this.result;
  });
}

describe('meeting reminder firing (0097 S2, real Postgres, fake bot)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bot: FakeBot;
  let svc: TelegramMeetingReminderService;
  let listId: string;

  const AT = new Date('2026-09-20T14:00:00.000Z'); // the meeting instant
  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }
  const meeting = async (leadMinutes: number, over: Record<string, unknown> = {}): Promise<string> => {
    const t = await prisma.task.create({
      data: { title: `${PREFIX} standup`, listId, ownerId: LOCAL_OWNER_ID, eventAt: AT, ...over },
    });
    await prisma.taskReminder.create({ data: { taskId: t.id, leadMinutes } });
    return t.id;
  };
  const sentAtOf = async (taskId: string) =>
    (await prisma.taskReminder.findFirst({ where: { taskId } }))!.sentAt;

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
    }
    bot = new FakeBot();
    svc = new TelegramMeetingReminderService(prisma, bot as never);
    await cleanup();
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  it('fires once at eventAt − lead, and stamps sentAt', async () => {
    const id = await meeting(60); // fires at 13:00Z
    await svc.evaluate(new Date('2026-09-20T13:00:00.000Z'), CHAT, TZ);
    expect(bot.sends).toHaveLength(1);
    expect(await sentAtOf(id)).not.toBeNull();
  });

  it('does NOT re-fire on a later tick once sentAt is set', async () => {
    await meeting(60);
    await svc.evaluate(new Date('2026-09-20T13:00:00.000Z'), CHAT, TZ);
    await svc.evaluate(new Date('2026-09-20T13:30:00.000Z'), CHAT, TZ);
    expect(bot.sends).toHaveLength(1); // still just the one
  });

  it('does NOT fire before eventAt − lead', async () => {
    const id = await meeting(60);
    await svc.evaluate(new Date('2026-09-20T12:59:00.000Z'), CHAT, TZ); // one minute early
    expect(bot.sends).toHaveLength(0);
    expect(await sentAtOf(id)).toBeNull();
  });

  it('a send failure (no bot) leaves sentAt null so the next tick retries', async () => {
    const id = await meeting(60);
    bot.result = 'no-bot';
    await svc.evaluate(new Date('2026-09-20T13:00:00.000Z'), CHAT, TZ);
    expect(await sentAtOf(id)).toBeNull(); // not marked
    bot.result = 'sent';
    await svc.evaluate(new Date('2026-09-20T13:05:00.000Z'), CHAT, TZ);
    expect(bot.sends).toHaveLength(1); // retried and sent
    expect(await sentAtOf(id)).not.toBeNull();
  });

  it('fires even inside quiet-hours — the reminder path is quiet-hours EXEMPT (no quiet gate at all)', async () => {
    // The service takes no quiet config and never consults it; firing depends ONLY on now ≥ eventAt−lead.
    await meeting(0); // fire AT the meeting instant
    await svc.evaluate(AT, CHAT, TZ);
    expect(bot.sends).toHaveLength(1);
  });

  it('a re-armed (rescheduled) reminder fires again', async () => {
    const id = await meeting(60);
    await svc.evaluate(new Date('2026-09-20T13:00:00.000Z'), CHAT, TZ); // first fire
    expect(bot.sends).toHaveLength(1);
    // S1a re-arms sentAt→null on reschedule; simulate that + a new eventAt.
    const newAt = new Date('2026-09-21T09:00:00.000Z');
    await prisma.task.update({ where: { id }, data: { eventAt: newAt } });
    await prisma.taskReminder.updateMany({ where: { taskId: id }, data: { sentAt: null } });
    await svc.evaluate(new Date('2026-09-21T08:00:00.000Z'), CHAT, TZ); // fires again for the new time
    expect(bot.sends).toHaveLength(2);
  });

  it('does not fire for a reminder whose task was completed (only active tasks)', async () => {
    await meeting(60, { status: 'done' });
    await svc.evaluate(new Date('2026-09-20T13:00:00.000Z'), CHAT, TZ);
    expect(bot.sends).toHaveLength(0);
  });
});

describe('formatReminder (0097)', () => {
  const AT = new Date('2026-09-20T14:00:00.000Z');
  it('renders the local time and a human lead phrase', () => {
    const s = formatReminder('Team sync', AT, 60, 'Asia/Dubai'); // 14:00Z = 18:00 Dubai
    expect(s).toContain('Team sync');
    expect(s).toContain('06:00 PM');
    expect(s).toContain('in 1 hour');
  });
  it('pluralizes and picks the largest whole unit; 0 lead reads "now"', () => {
    expect(formatReminder('X', AT, 1440, 'UTC')).toContain('in 1 day');
    expect(formatReminder('X', AT, 30, 'UTC')).toContain('in 30 minutes');
    expect(formatReminder('X', AT, 0, 'UTC')).toContain('(now)');
  });
});
