import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { CLOCK } from '../src/auth/clock';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PinSnoozeService } from '../src/pin-snooze.service';
import { PrismaService } from '../src/prisma.service';
import { SettingsService } from '../src/settings.service';

/**
 * The pin snooze (ADR 0086) — `pinSnoozedUntil = now + snoozeSpanMs(level, config)`, level from the task's
 * impact, `now` from the INJECTED clock (faked here for exact assertions). Owner-scoped; None-impact and
 * stale ids answer cleanly.
 */
const DAY = 86_400_000;
const NOW = new Date('2026-07-28T12:00:00.000Z');

describe('PinSnoozeService (real Postgres, fake clock)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let pin: PinSnoozeService;
  let settings: SettingsService;
  let listId: string;
  const madeListIds: string[] = [];

  const makeTask = (impact: 'none' | 'medium' | 'high') =>
    prisma.task.create({ data: { title: `t-${impact}`, listId, ownerId: LOCAL_OWNER_ID, impact } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue({ now: () => NOW })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    pin = app.get(PinSnoozeService);
    settings = app.get(SettingsService);
    const list = await prisma.list.create({ data: { name: 'Zzz Pin Snooze', ownerId: LOCAL_OWNER_ID } });
    listId = list.id;
    madeListIds.push(list.id);
  });

  afterAll(async () => {
    for (const id of madeListIds) await prisma.list.deleteMany({ where: { id } });
    await prisma.settings.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
    await app?.close();
  });

  beforeEach(async () => {
    await prisma.settings.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } }); // → default config (high 1 / medium 3)
  });

  it('snoozes a High task for the High span (1 day) at the clock now', async () => {
    const t = await makeTask('high');
    const { pinSnoozedUntil } = await pin.snooze(t.id);
    expect(pinSnoozedUntil.getTime()).toBe(NOW.getTime() + 1 * DAY);
    expect((await prisma.task.findFirstOrThrow({ where: { id: t.id } })).pinSnoozedUntil?.getTime()).toBe(
      NOW.getTime() + 1 * DAY,
    );
  });

  it('snoozes a Medium task for the Medium span (3 days)', async () => {
    const t = await makeTask('medium');
    const { pinSnoozedUntil } = await pin.snooze(t.id);
    expect(pinSnoozedUntil.getTime()).toBe(NOW.getTime() + 3 * DAY);
  });

  it('the span comes from the CONFIG, not a hardcoded default', async () => {
    await settings.setPinConfig({ highFuseDays: 7, mediumFuseDays: 30, highSnoozeDays: 5, mediumSnoozeDays: 3 });
    const t = await makeTask('high');
    const { pinSnoozedUntil } = await pin.snooze(t.id);
    expect(pinSnoozedUntil.getTime()).toBe(NOW.getTime() + 5 * DAY);
  });

  it('un-snooze clears it back to null', async () => {
    const t = await makeTask('high');
    await pin.snooze(t.id);
    await pin.unsnooze(t.id);
    expect((await prisma.task.findFirstOrThrow({ where: { id: t.id } })).pinSnoozedUntil).toBeNull();
  });

  it('rejects a NONE-impact task cleanly — no bogus snooze written', async () => {
    const t = await makeTask('none');
    await expect(pin.snooze(t.id)).rejects.toThrow(/impact/i);
    expect((await prisma.task.findFirstOrThrow({ where: { id: t.id } })).pinSnoozedUntil).toBeNull();
  });

  it('a stale/foreign id is a clean not-found — snooze and un-snooze', async () => {
    const gone = '00000000-0000-0000-0000-000000000000';
    await expect(pin.snooze(gone)).rejects.toThrow(/not found/i);
    await expect(pin.unsnooze(gone)).rejects.toThrow(/not found/i);
  });
});
