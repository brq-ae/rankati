import { randomUUID } from 'node:crypto';
import { BadRequestException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CreateRoutineDto, Routine } from '@rankati/shared';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { RoutinesService } from '../src/routines/routines.service';

/**
 * Telegram nag-reminder fields on a Routine (ADR 0091 M2): opt-in nagging + cadence, and the name-based
 * reminder→log link (find-or-create, case-insensitive, non-frequency only). Asserted against the DB via
 * the service, matching routines-api.spec's style.
 */
const P = '__rnag__';
const ON = '2026-08-21';

describe('Routine nag fields + log link (real Postgres, ADR 0091 M2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let svc: RoutinesService;

  const create = (dto: Omit<CreateRoutineDto, 'name' | 'on'>, name = `${P}${randomUUID()}`) =>
    svc.create({ name, on: ON, ...dto } as CreateRoutineDto);
  const read = async (id: string): Promise<Routine> => (await svc.findAll(ON)).find((r) => r.id === id)!;

  async function cleanup() {
    await prisma.routine.deleteMany({ where: { name: { startsWith: P } } });
    await prisma.log.deleteMany({ where: { name: { startsWith: P } } });
    await prisma.log.deleteMany({ where: { name: { in: ['Nag Haircut', 'nag haircut'] } } });
  }

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    svc = app.get(RoutinesService);
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  const floating = { type: 'interval_floating' as const, intervalUnit: 'week' as const, intervalCount: 1 };
  const freq = { type: 'frequency' as const, periodUnit: 'day' as const, targetCount: 4 };

  it('carries telegramNag + nagIntervalMinutes on create and read', async () => {
    const r = await create({ ...floating, telegramNag: true, nagIntervalMinutes: 30 });
    expect(r.telegramNag).toBe(true);
    expect(r.nagIntervalMinutes).toBe(30);
    expect((await read(r.id)).nagIntervalMinutes).toBe(30);
  });

  it('enabling nagging without a cadence defaults to 60; disabling clears it', async () => {
    const on = await create({ ...floating, telegramNag: true });
    expect(on.nagIntervalMinutes).toBe(60);
    const off = await svc.update(on.id, { on: ON, telegramNag: false });
    expect(off.telegramNag).toBe(false);
    expect(off.nagIntervalMinutes).toBeNull();
  });

  it('accepts any whole minute in 1..1440 (custom cadence, v0.41.1) — including the old presets', async () => {
    for (const m of [1, 30, 45, 60, 120, 200, 1440]) {
      const r = await create({ ...floating, telegramNag: true, nagIntervalMinutes: m });
      expect(r.nagIntervalMinutes).toBe(m);
    }
  });

  it('rejects a nagIntervalMinutes outside 1..1440 or non-integer (0, 1441, 1.5, negative)', async () => {
    for (const bad of [0, 1441, 1.5, -5]) {
      await expect(
        create({ ...floating, telegramNag: true, nagIntervalMinutes: bad }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('linkLog on a floating routine find-or-creates a Log by the routine name and stores its id', async () => {
    const r = await svc.create({ name: 'Nag Haircut', on: ON, ...floating, linkLog: true } as CreateRoutineDto);
    expect(r.linkedLogId).not.toBeNull();
    const log = await prisma.log.findFirst({ where: { id: r.linkedLogId! } });
    expect(log?.name).toBe('Nag Haircut');
  });

  it('the link reuses an existing same-named Log case-insensitively (no duplicate)', async () => {
    await prisma.log.create({ data: { name: 'nag haircut', ownerId: LOCAL_OWNER_ID } });
    const r = await svc.create({ name: 'Nag Haircut', on: ON, ...floating, linkLog: true } as CreateRoutineDto);
    const logs = await prisma.log.findMany({ where: { name: { in: ['Nag Haircut', 'nag haircut'] } } });
    expect(logs).toHaveLength(1); // reused, not duplicated
    expect(r.linkedLogId).toBe(logs[0]!.id);
  });

  it('unlinking (linkLog:false) clears linkedLogId but keeps the Log', async () => {
    const r = await svc.create({ name: 'Nag Haircut', on: ON, ...floating, linkLog: true } as CreateRoutineDto);
    const logId = r.linkedLogId!;
    const off = await svc.update(r.id, { on: ON, linkLog: false });
    expect(off.linkedLogId).toBeNull();
    expect(await prisma.log.findFirst({ where: { id: logId } })).not.toBeNull(); // Log survives
  });

  it('linkLog on a frequency routine is rejected (400) — on create and on update', async () => {
    await expect(create({ ...freq, linkLog: true })).rejects.toBeInstanceOf(BadRequestException);
    const f = await create(freq);
    await expect(svc.update(f.id, { on: ON, linkLog: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an unrelated edit does NOT rewrite the nag columns (empty-diff guard honored)', async () => {
    const r = await create({ ...floating, telegramNag: true, nagIntervalMinutes: 120 });
    const renamed = await svc.update(r.id, { on: ON, name: `${P}renamed` });
    expect(renamed.telegramNag).toBe(true); // untouched
    expect(renamed.nagIntervalMinutes).toBe(120);
  });

  // naggable() — the scheduler's read: shouldNag = "due AND unsatisfied", per type, nag-due == app-due.
  describe('naggable() per-type due & unsatisfied', () => {
    const find = async (id: string) => (await svc.naggable(ON)).find((n) => n.row.id === id);

    it('only returns telegramNag routines', async () => {
      const on = await create({ ...floating, telegramNag: true });
      await create(floating); // nag OFF
      const ids = (await svc.naggable(ON)).map((n) => n.row.id);
      expect(ids).toContain(on.id);
      expect(ids).toHaveLength(1);
    });

    it('frequency: shouldNag while under target, with progress; goes false once the target is met', async () => {
      const f = await create({ type: 'frequency', periodUnit: 'day', targetCount: 2, telegramNag: true });
      expect((await find(f.id))?.shouldNag).toBe(true);
      expect((await find(f.id))?.progress).toEqual({ count: 0, target: 2 });
      await svc.did(f.id, ON); // 1/2
      expect((await find(f.id))?.shouldNag).toBe(true);
      await svc.did(f.id, ON); // 2/2 → satisfied
      const n = await find(f.id);
      expect(n?.shouldNag).toBe(false);
      expect(n?.progress).toEqual({ count: 2, target: 2 });
    });

    it('interval_floating: shouldNag when nextDue has arrived; false when it is still in the future', async () => {
      const due = await create({ ...floating, firstDue: ON, telegramNag: true }); // due today
      expect((await find(due.id))?.shouldNag).toBe(true);
      const later = await create({ ...floating, firstDue: '2026-12-31', telegramNag: true }); // future
      expect((await find(later.id))?.shouldNag).toBe(false);
    });

    it('interval_fixed: shouldNag on the occurrence day; false once dismissed (acknowledged)', async () => {
      // ON = 2026-08-21 → a day-of-month=21 rule occurs today.
      const fx = await create({ type: 'interval_fixed', rule: { kind: 'day_of_month', day: 21 }, telegramNag: true });
      expect((await find(fx.id))?.shouldNag).toBe(true);
      await svc.dismiss(fx.id, ON);
      expect((await find(fx.id))?.shouldNag).toBe(false);
    });
  });

  // nagDid() — ✓ Did it from a nag: routes did/dismiss by type + the graceful log write.
  describe('nagDid() + setNagSkip()', () => {
    it('frequency → +1; floating → advances nextDue; fixed → dismisses (routes did vs dismiss by type)', async () => {
      const f = await create({ type: 'frequency', periodUnit: 'day', targetCount: 3, telegramNag: true });
      expect((await svc.nagDid(f.id, ON)).periodCount).toBe(1);

      const fl = await create({ ...floating, firstDue: ON, telegramNag: true });
      expect((await svc.nagDid(fl.id, ON)).nextDue! > ON).toBe(true); // advanced past today

      const fx = await create({ type: 'interval_fixed', rule: { kind: 'day_of_month', day: 21 }, telegramNag: true });
      expect((await svc.nagDid(fx.id, ON)).acknowledgedDate).toBe(ON); // dismissed, not did
    });

    it('with a linked Log, records today in the Log (idempotent per day)', async () => {
      const r = await svc.create({ name: 'Nag Haircut', on: ON, ...floating, linkLog: true } as CreateRoutineDto);
      await svc.nagDid(r.id, ON);
      expect(await prisma.logEntry.count({ where: { logId: r.linkedLogId! } })).toBe(1);
      await svc.nagDid(r.id, ON); // second nag same day → still one occurrence (0087 idempotency)
      expect(await prisma.logEntry.count({ where: { logId: r.linkedLogId! } })).toBe(1);
    });

    it('gracefully handles a DELETED linked Log — routine still satisfied, no crash', async () => {
      const r = await svc.create({ name: 'Nag Haircut', on: ON, ...floating, linkLog: true } as CreateRoutineDto);
      await prisma.log.delete({ where: { id: r.linkedLogId! } }); // the linked Log is gone
      const after = await svc.nagDid(r.id, ON); // must NOT throw
      expect(after.nextDue! > ON).toBe(true); // the routine is still satisfied (floating advanced)
    });

    it('setNagSkip stores nagSkipUntil (a nag-only mute, distinct from snooze)', async () => {
      const r = await create({ ...floating, telegramNag: true });
      const until = '2026-08-22T00:00:00.000Z';
      await svc.setNagSkip(r.id, until);
      const row = await prisma.routine.findFirst({ where: { id: r.id } });
      expect(row?.nagSkipUntil?.toISOString()).toBe(until);
      expect(row?.snoozedUntil).toBeNull(); // did NOT touch the display snooze
    });
  });
});
