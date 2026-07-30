import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEFAULT_PIN_DAYS, type PinDays, type Task } from '@rankati/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clock } from '../src/auth/clock';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { ListsService } from '../src/lists.service';
import { LogsService } from '../src/logs.service';
import { PrismaService } from '../src/prisma.service';
import { RoutinesService } from '../src/routines/routines.service';
import type { SettingsService } from '../src/settings.service';
import { TasksService } from '../src/tasks.service';
import { TelegramReadService } from '../src/telegram/telegram-read.service';
import type { TelegramConfigService } from '../src/telegram/telegram-config.service';

/**
 * Read commands (Steps 6 + 0086). deal/complete run against real Postgres (timezone stubbed so no config-row
 * race). dealToday's PIN wiring is tested with a MOCKED findToday so the candidates/hand/snoozes/config/clock
 * feeding the shared computePin are deterministic (the pin ALGORITHM itself is covered by pin.spec.ts).
 */
const DAY = 86_400_000;
const NOW = new Date('2026-08-01T12:00:00.000Z');
const mk = (id: string, impact: 'none' | 'medium' | 'high', daysAgo: number, pinSnoozedUntil: string | null = null): Task =>
  ({
    id, title: id, listId: 'l', ownerId: 'local', status: 'active',
    createdAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
    dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, checklist: [], effort: null,
    pinSnoozedUntil, impact,
  }) as Task;
const FILLERS = ['a', 'b', 'c', 'd', 'e'].map((n) => mk(n, 'none', 0));

describe('Telegram read service (real Postgres + mocked pin inputs)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tasks: TasksService;
  let lists: ListsService;
  let routines: RoutinesService;
  let logs: LogsService;
  const madeListIds: string[] = [];

  const stubSettings = (config: PinDays = DEFAULT_PIN_DAYS) =>
    ({ getPinConfig: async () => config }) as unknown as SettingsService;
  const stubClock = (now: Date = new Date()): Clock => ({ now: () => now });

  // Real tasks/DB (timezone from the stub, not the shared config row).
  const readWithTz = (timezone: string | null, clock: Clock = stubClock()) =>
    new TelegramReadService(
      prisma,
      { getConfig: async () => ({ timezone }) } as unknown as TelegramConfigService,
      tasks,
      stubSettings(),
      lists,
      routines,
      logs,
      clock,
    );

  // Deterministic pin inputs: findToday is mocked, timezone fixed, clock + config controlled.
  const readWithPin = (found: Task[], config: PinDays = DEFAULT_PIN_DAYS) =>
    new TelegramReadService(
      prisma,
      { getConfig: async () => ({ timezone: 'UTC' }) } as unknown as TelegramConfigService,
      { findToday: async () => found } as unknown as TasksService,
      stubSettings(config),
      lists,
      routines,
      logs,
      stubClock(NOW),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    tasks = app.get(TasksService);
    lists = app.get(ListsService);
    routines = app.get(RoutinesService);
    logs = app.get(LogsService);
  });

  afterAll(async () => {
    for (const id of madeListIds) await prisma.list.deleteMany({ where: { id } });
    await prisma.routine.deleteMany({ where: { ownerId: LOCAL_OWNER_ID, name: { startsWith: 'Zzz' } } });
    await prisma.log.deleteMany({ where: { ownerId: LOCAL_OWNER_ID, name: { startsWith: 'Zzz' } } });
    await app?.close();
  });

  // ── deal / complete (real DB) ──────────────────────────────────────────────────────────────────────
  it('no timezone set → reads report no-timezone (never a guessed day)', async () => {
    expect(await readWithTz(null).deal(5)).toEqual({ status: 'no-timezone' });
    expect(await readWithTz(null).dealToday()).toEqual({ status: 'no-timezone' });
  });

  it('with a timezone, deals up to the limit from the ranked Today read', async () => {
    const svc = readWithTz('Asia/Dubai');
    const five = await svc.deal(5);
    expect(five.status).toBe('ok');
    if (five.status === 'ok') expect(five.cards.length).toBeLessThanOrEqual(5);
  });

  it('complete verifies ownership, completes, and answers gone for a foreign/deleted id', async () => {
    const list = await prisma.list.create({ data: { name: 'Zzz Read Target', ownerId: LOCAL_OWNER_ID } });
    madeListIds.push(list.id);
    const task = await prisma.task.create({ data: { title: 'finish me', listId: list.id, ownerId: LOCAL_OWNER_ID } });
    const svc = readWithTz('Asia/Dubai');
    expect(await svc.complete(task.id)).toEqual({ status: 'done', title: 'finish me' });
    expect((await prisma.task.findFirstOrThrow({ where: { id: task.id } })).status).toBe('done');
    expect(await svc.complete('00000000-0000-0000-0000-000000000000')).toEqual({ status: 'gone' });
  });

  // ── dealToday PIN wiring (mocked findToday) ──────────────────────────────────────────────────────────
  it('pins a High task that is playable, past its fuse, and NOT in the top-5 hand', async () => {
    const res = await readWithPin([...FILLERS, mk('p', 'high', 10)]).dealToday();
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.cards.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']); // top-5, pin excluded
    expect(res.pin?.task.id).toBe('p');
    expect(res.pin?.reason).toBe('high-impact · 10 days');
  });

  it('does NOT pin a snoozed task (pinSnoozedUntil in the future)', async () => {
    const snoozed = mk('p', 'high', 10, new Date(NOW.getTime() + 1 * DAY).toISOString());
    const res = await readWithPin([...FILLERS, snoozed]).dealToday();
    expect(res.status === 'ok' && res.pin).toBeNull();
  });

  it('does NOT pin a None task, however old', async () => {
    const res = await readWithPin([...FILLERS, mk('p', 'none', 999)]).dealToday();
    expect(res.status === 'ok' && res.pin).toBeNull();
  });

  it('does NOT pin a qualifier that is already IN the top-5 hand', async () => {
    const res = await readWithPin([mk('p', 'high', 10), ...FILLERS.slice(0, 4)]).dealToday();
    if (res.status !== 'ok') return;
    expect(res.cards.map((c) => c.id)).toContain('p'); // in the hand
    expect(res.pin).toBeNull();
  });

  it('under a raised fuse the pin does not fire; the config drives it', async () => {
    const config: PinDays = { ...DEFAULT_PIN_DAYS, highFuseDays: 100 };
    const res = await readWithPin([...FILLERS, mk('p', 'high', 10)], config).dealToday();
    expect(res.status === 'ok' && res.pin).toBeNull(); // 10 < 100 → no pin
  });

  // ── Display-only read views (ADR 0088) ──────────────────────────────────────────────────────────────
  describe('read views (ADR 0088)', () => {
    it('readLists returns the owner list set; readListTasks is active-only + ownership-verified', async () => {
      const list = await prisma.list.create({ data: { name: 'Zzz Errands', ownerId: LOCAL_OWNER_ID } });
      madeListIds.push(list.id);
      await prisma.task.create({
        data: { title: 'renew passport', listId: list.id, ownerId: LOCAL_OWNER_ID, impact: 'high' },
      });
      await prisma.task.create({
        data: { title: 'old done', listId: list.id, ownerId: LOCAL_OWNER_ID, status: 'done' },
      });

      const svc = readWithTz(null); // /lists needs no timezone
      expect(await svc.readLists()).toContainEqual({ id: list.id, name: 'Zzz Errands' });

      const res = await svc.readListTasks(list.id);
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.name).toBe('Zzz Errands');
        expect(res.tasks).toContainEqual({ title: 'renew passport', impact: 'high' });
        expect(res.tasks.some((t) => t.title === 'old done')).toBe(false); // active only
      }
      expect(await svc.readListTasks('00000000-0000-0000-0000-000000000000')).toEqual({ status: 'gone' });
    });

    it('readRoutines: a timezone yields the climb order; none yields no-timezone (hint)', async () => {
      await routines.create({ name: 'Zzz gym', type: 'frequency', on: '2026-07-30', periodUnit: 'week', targetCount: 3 });

      expect(await readWithTz(null).readRoutines()).toEqual({ status: 'no-timezone' });
      const res = await readWithTz('Asia/Dubai').readRoutines();
      expect(res.status).toBe('ok');
      if (res.status === 'ok') expect(res.routines.some((r) => r.name === 'Zzz gym')).toBe(true);
    });

    it('readLogs partial-degrades: last-done + average always; "days ago" only with a timezone', async () => {
      const log = await prisma.log.create({ data: { name: 'Zzz Haircut', ownerId: LOCAL_OWNER_ID } });
      await prisma.logEntry.create({ data: { logId: log.id, doneOn: new Date('2026-06-20T00:00:00.000Z') } });
      await prisma.logEntry.create({ data: { logId: log.id, doneOn: new Date('2026-07-20T00:00:00.000Z') } });

      const noTz = await readWithTz(null).readLogs();
      expect(noTz.hasTimezone).toBe(false);
      const a = noTz.logs.find((l) => l.name === 'Zzz Haircut')!;
      expect(a.lastDoneOn).toBe('2026-07-20');
      expect(a.averageGapDays).toBe(30); // 20 Jun → 20 Jul
      expect(a.currentGapDays).toBeNull();

      const withTz = await readWithTz('UTC', { now: () => new Date('2026-07-30T12:00:00.000Z') }).readLogs();
      expect(withTz.hasTimezone).toBe(true);
      const b = withTz.logs.find((l) => l.name === 'Zzz Haircut')!;
      expect(b.averageGapDays).toBe(30);
      expect(b.currentGapDays).toBe(10); // 20 Jul → 30 Jul
    });
  });
});
