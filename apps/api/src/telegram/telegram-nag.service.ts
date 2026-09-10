import { Inject, Injectable, Logger } from '@nestjs/common';
import { hhmmToMinutes, isWithinQuietMinutes } from '@rankati/shared';
import { CLOCK, type Clock } from '../auth/clock';
import { RoutinesService } from '../routines/routines.service';
import { SettingsService } from '../settings.service';
import type { TelegramReplyMarkup } from './telegram-bot.factory';
import { TelegramBotService } from './telegram-bot.service';
import { encodeNagDid, encodeNagLater, encodeNagSkip } from './telegram-callback';

const MINUTE_MS = 60_000;
// The nag's per-period progress suffix (ADR 0093): "3/7 this week", not a hardcoded "today", for a weekly
// or monthly frequency. Keyed by the routine's periodUnit; falls back to "today" for a daily/absent unit.
const PERIOD_LABEL: Record<string, string> = { day: 'today', week: 'this week', month: 'this month', year: 'this year' };

/**
 * Telegram nag-reminders (ADR 0091 M2) — the per-routine nag EVALUATION + proactive push, driven by the
 * existing per-minute digest tick (NO new timer/infra). For each `telegramNag` routine, `evaluate` pushes a
 * nag iff it is DUE and unsatisfied (nag-due == app-due, via RoutinesService.naggable), outside quiet-hours,
 * not snoozed, not skipped-today, and its cadence (`lastNaggedAt` + `nagIntervalMinutes`) has elapsed. The
 * button ACTIONS live in TelegramNagActionsService (which the bot injects) — split to avoid a DI cycle
 * (this service injects the bot to push; the bot injects the actions service to handle the taps).
 */
@Injectable()
export class TelegramNagService {
  private readonly logger = new Logger('TelegramNag');

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly routines: RoutinesService,
    private readonly settings: SettingsService,
    private readonly bot: TelegramBotService,
  ) {}

  /** Called once per digest tick with the owner's local day/minute + the bound chat. Never throws. */
  async evaluate(local: { date: string; minutes: number }, boundChatId: string): Promise<void> {
    try {
      // Quiet-hours: the same gate the digest uses — no nag pushes while inside the window (ADR 0091 M1).
      const quiet = await this.settings.getQuietHours();
      const qStart = quiet.start === null ? null : hhmmToMinutes(quiet.start);
      const qEnd = quiet.end === null ? null : hhmmToMinutes(quiet.end);
      if (qStart !== null && qEnd !== null && isWithinQuietMinutes(local.minutes, qStart, qEnd)) return;

      const now = this.clock.now();
      const candidates = await this.routines.naggable(local.date);
      for (const { row, shouldNag, progress } of candidates) {
        if (!shouldNag) continue; // not due, or already satisfied this period
        // Did-it-today gate (ADR 0093): a frequency routine has no per-day "done", so without this the nag
        // keeps firing after "Did it" while still under the weekly/monthly target. Silence the rest of the
        // local day; nagging resumes tomorrow (still under target). Redundant-but-harmless for floating/fixed.
        if (row.lastDidOn && row.lastDidOn.toISOString().slice(0, 10) === local.date) continue;
        if (row.snoozedUntil && row.snoozedUntil.getTime() > now.getTime()) continue; // 😴 Later in effect
        if (row.nagSkipUntil && row.nagSkipUntil.getTime() > now.getTime()) continue; // Skip today in effect
        const interval = (row.nagIntervalMinutes ?? 60) * MINUTE_MS;
        if (row.lastNaggedAt && row.lastNaggedAt.getTime() + interval > now.getTime()) continue; // too soon

        const text =
          row.type === 'frequency' && progress
            ? `🔔 ${row.name} — ${progress.count}/${progress.target} ${PERIOD_LABEL[row.periodUnit ?? 'day']}`
            : `🔔 ${row.name}`;
        const keyboard: TelegramReplyMarkup = {
          inline_keyboard: [
            [
              { text: '✓ Did it', callback_data: encodeNagDid(row.id) },
              { text: '😴 Later', callback_data: encodeNagLater(row.id) },
              { text: 'Skip today', callback_data: encodeNagSkip(row.id) },
            ],
          ],
        };
        const result = await this.bot.pushNag(boundChatId, text, keyboard);
        if (result === 'sent') await this.routines.markNagged(row.id, now);
        // 'no-bot' | 'error' → do NOT mark; the next tick retries (same as the digest's non-mark-on-failure).
      }
    } catch (err) {
      this.logger.warn(`nag evaluate failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
