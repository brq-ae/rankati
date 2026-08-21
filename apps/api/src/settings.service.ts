import { BadRequestException, Injectable } from '@nestjs/common';
import { DEFAULT_PIN_DAYS, type PinDays, type QuietHours, hhmmToMinutes } from '@rankati/shared';
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

  /** Global quiet-hours (ADR 0091). Both null = off. */
  async getQuietHours(): Promise<QuietHours> {
    const s = await this.getOrCreate();
    return { start: s.quietStart, end: s.quietEnd };
  }

  /**
   * Save quiet-hours (ADR 0091). Unlike the pin knobs (each field defaults independently), quiet-hours is
   * BOTH-OR-NEITHER and rejects a malformed value — an ambiguous window would silently mute or fail to mute
   * Telegram push, so a bad request is a clean 400, never a coerced default:
   *   { start: null,   end: null   } -> off
   *   { start: "HH:MM", end: "HH:MM" } -> the window (each validated strict 24h; start==end allowed = off)
   *   one set + one null, or any malformed time -> 400
   */
  async setQuietHours(raw: unknown): Promise<QuietHours> {
    const body = (raw ?? {}) as { start?: unknown; end?: unknown };
    const startRaw = body.start ?? null;
    const endRaw = body.end ?? null;

    if (startRaw === null && endRaw === null) {
      return this.writeQuietHours(null, null); // off
    }
    if (startRaw === null || endRaw === null) {
      throw new BadRequestException('quiet-hours start and end must both be set or both be null');
    }
    if (typeof startRaw !== 'string' || hhmmToMinutes(startRaw) === null) {
      throw new BadRequestException('quiet-hours start must be "HH:MM" (24h) or null');
    }
    if (typeof endRaw !== 'string' || hhmmToMinutes(endRaw) === null) {
      throw new BadRequestException('quiet-hours end must be "HH:MM" (24h) or null');
    }
    return this.writeQuietHours(startRaw, endRaw);
  }

  private async writeQuietHours(start: string | null, end: string | null): Promise<QuietHours> {
    const current = await this.getOrCreate();
    const updated = await this.prisma.settings.update({
      where: { id: current.id },
      data: { quietStart: start, quietEnd: end },
    });
    return { start: updated.quietStart, end: updated.quietEnd };
  }
}
