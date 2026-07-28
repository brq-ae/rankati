import { Injectable } from '@nestjs/common';
import { DEFAULT_PIN_DAYS, type PinDays } from '@rankati/shared';
import { LOCAL_OWNER_ID } from './constants';
import type { Settings } from './generated/prisma/client';
import { PrismaService } from './prisma.service';

/**
 * The owner-scoped shared-settings store (ADR 0086) — one lazily-created row per owner. The impact-pin
 * day-knobs are its first tenant, moved off the client's `localStorage`. Future shared settings add methods
 * here against the same row. (Per-device prefs like theme deliberately stay client-side.)
 */

/** One knob → a positive integer >= 1, else that field's default. Mirrors the client's readDay (ADR 0075). */
function knob(raw: unknown, key: keyof PinDays): number {
  const v = (raw as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : DEFAULT_PIN_DAYS[key];
}

/** The stored row's pin columns → the shared PinDays shape the clients speak. */
function toPinDays(s: Settings): PinDays {
  return {
    highFuseDays: s.pinHighFuseDays,
    mediumFuseDays: s.pinMediumFuseDays,
    highSnoozeDays: s.pinHighSnoozeDays,
    mediumSnoozeDays: s.pinMediumSnoozeDays,
  };
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The single owner-scoped settings row, lazily created (find-or-create, like TelegramConfig.getOrCreate). */
  private async getOrCreate(): Promise<Settings> {
    return this.prisma.settings.upsert({
      where: { ownerId: LOCAL_OWNER_ID },
      create: { ownerId: LOCAL_OWNER_ID },
      update: {},
    });
  }

  /** The four impact-pin day-knobs (ADR 0086). Defaults on first read. */
  async getPinConfig(): Promise<PinDays> {
    return toPinDays(await this.getOrCreate());
  }

  /**
   * Save the four knobs (ADR 0086). Each field is validated INDEPENDENTLY (mirrors the client's readDay,
   * ADR 0075): a positive integer >= 1 is kept, anything else defaults to its OWN default — one bad field
   * never rejects the whole save.
   */
  async setPinConfig(raw: unknown): Promise<PinDays> {
    const current = await this.getOrCreate();
    const updated = await this.prisma.settings.update({
      where: { id: current.id },
      data: {
        pinHighFuseDays: knob(raw, 'highFuseDays'),
        pinMediumFuseDays: knob(raw, 'mediumFuseDays'),
        pinHighSnoozeDays: knob(raw, 'highSnoozeDays'),
        pinMediumSnoozeDays: knob(raw, 'mediumSnoozeDays'),
      },
    });
    return toPinDays(updated);
  }
}
