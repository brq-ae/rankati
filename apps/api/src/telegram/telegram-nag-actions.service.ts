import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../auth/clock';
import { RoutinesService } from '../routines/routines.service';
import type { TelegramReplyMarkup } from './telegram-bot.factory';
import { encodeNagSnooze, type NagSnoozeSpan } from './telegram-callback';
import { TelegramConfigService } from './telegram-config.service';
import { localNow } from './telegram-time';

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;
const MORNING_MINUTES = 8 * 60; // "until morning" = the next local 08:00

/**
 * The nag BUTTON actions (ADR 0091 M2) — ✓ Did it / 😴 Later (span) / Skip today. A separate service from
 * the scheduler (TelegramNagService) so the bot can inject it for the callback handlers WITHOUT a DI cycle
 * (the scheduler injects the bot to push; this injects only routines/config/clock, never the bot). All the
 * timing (span → instant, "until morning", next-local-midnight) is computed here against the owner's tz.
 */
@Injectable()
export class TelegramNagActionsService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly routines: RoutinesService,
    private readonly config: TelegramConfigService,
  ) {}

  /** The owner's `now` + local day/minute, or null if no timezone is configured (nags need one, like the digest). */
  private async context(): Promise<{ now: Date; local: { date: string; minutes: number } } | null> {
    const { timezone } = await this.config.getDigestState();
    if (!timezone) return null;
    const now = this.clock.now();
    return { now, local: localNow(now, timezone) };
  }

  /** ✓ Did it — satisfy the routine (+ its linked Log). Returns a confirmation, or null if no timezone. */
  async handleDid(routineId: string): Promise<string | null> {
    const ctx = await this.context();
    if (!ctx) return null;
    const dto = await this.routines.nagDid(routineId, ctx.local.date);
    return dto.type === 'frequency' && dto.targetCount
      ? `✓ ${dto.name} — ${dto.periodCount ?? 0}/${dto.targetCount} today`
      : `✓ ${dto.name} — done`;
  }

  /** The 😴 Later submenu keyboard — 1h / 3h / until-morning span buttons for a routine. */
  laterMenu(routineId: string): TelegramReplyMarkup {
    return {
      inline_keyboard: [
        [
          { text: '1 hour', callback_data: encodeNagSnooze(routineId, 'hour') },
          { text: '3 hours', callback_data: encodeNagSnooze(routineId, 'threeHours') },
          { text: 'Until morning', callback_data: encodeNagSnooze(routineId, 'morning') },
        ],
      ],
    };
  }

  /** 😴 Later — snooze the nags for the chosen span (reuses the routine's `snoozedUntil`). */
  async handleSnooze(routineId: string, span: NagSnoozeSpan): Promise<string | null> {
    const ctx = await this.context();
    if (!ctx) return null;
    const minutes =
      span === 'hour'
        ? 60
        : span === 'threeHours'
          ? 180
          : (MORNING_MINUTES - ctx.local.minutes + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES; // next local 08:00
    await this.routines.snooze(routineId, new Date(ctx.now.getTime() + minutes * MINUTE_MS).toISOString());
    return span === 'hour'
      ? '😴 Snoozed for 1 hour'
      : span === 'threeHours'
        ? '😴 Snoozed for 3 hours'
        : '😴 Snoozed until morning';
  }

  /** Skip today — mute ONLY the nag until the next LOCAL midnight (the rest of today); routine stays in-app. */
  async handleSkip(routineId: string): Promise<string | null> {
    const ctx = await this.context();
    if (!ctx) return null;
    const minutesToMidnight = DAY_MINUTES - ctx.local.minutes;
    await this.routines.setNagSkip(routineId, new Date(ctx.now.getTime() + minutesToMidnight * MINUTE_MS).toISOString());
    return 'Skipped for today';
  }
}
