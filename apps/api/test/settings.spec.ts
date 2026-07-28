import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEFAULT_PIN_DAYS } from '@rankati/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { SettingsService } from '../src/settings.service';

/**
 * The shared-settings store's first tenant — the pin day-knobs (ADR 0086). Per-field validation mirrors the
 * client's readDay (0075): a positive integer >= 1 is kept, anything else defaults to its own default.
 */
describe('SettingsService — pin config (real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let settings: SettingsService;

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      settings = app.get(SettingsService);
    }
    await prisma.settings.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
  });

  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
    await app?.close();
  });

  it('lazily creates the single row and returns the defaults on first read', async () => {
    expect(await settings.getPinConfig()).toEqual(DEFAULT_PIN_DAYS);
    expect(await prisma.settings.count({ where: { ownerId: LOCAL_OWNER_ID } })).toBe(1);
  });

  it('saves valid knobs and reads them back', async () => {
    const saved = await settings.setPinConfig({
      highFuseDays: 5,
      mediumFuseDays: 20,
      highSnoozeDays: 2,
      mediumSnoozeDays: 4,
    });
    expect(saved).toEqual({ highFuseDays: 5, mediumFuseDays: 20, highSnoozeDays: 2, mediumSnoozeDays: 4 });
    expect(await settings.getPinConfig()).toEqual(saved);
  });

  it('validates each field INDEPENDENTLY — one bad field defaults, the rest stand', async () => {
    const saved = await settings.setPinConfig({
      highFuseDays: 10, // valid → kept
      mediumFuseDays: 0, // < 1 → its default (30)
      highSnoozeDays: 2.5, // non-integer → its default (1)
      mediumSnoozeDays: -1, // negative → its default (3)
    });
    expect(saved).toEqual({
      highFuseDays: 10,
      mediumFuseDays: DEFAULT_PIN_DAYS.mediumFuseDays,
      highSnoozeDays: DEFAULT_PIN_DAYS.highSnoozeDays,
      mediumSnoozeDays: DEFAULT_PIN_DAYS.mediumSnoozeDays,
    });
  });

  it('a garbage payload → all defaults, never a throw', async () => {
    expect(await settings.setPinConfig(null)).toEqual(DEFAULT_PIN_DAYS);
    expect(await settings.setPinConfig('nope')).toEqual(DEFAULT_PIN_DAYS);
    expect(await settings.setPinConfig({ highFuseDays: 'x', mediumFuseDays: [] })).toEqual(DEFAULT_PIN_DAYS);
  });
});
