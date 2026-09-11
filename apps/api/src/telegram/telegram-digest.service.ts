import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { hhmmToMinutes, isWithinQuietMinutes } from '@rankati/shared';
import { CLOCK, type Clock } from '../auth/clock';
import { SettingsService } from '../settings.service';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramConfigService } from './telegram-config.service';
import { TelegramMeetingReminderService } from './telegram-meeting-reminder.service';
import { TelegramNagService } from './telegram-nag.service';

/** How long after digestTime a missed digest may still fire (Step 7) — a boot at 08:15 delivers; noon skips. */
const GRACE_MINUTES = 120;
const TICK_MS = 60_000;

// localNow moved to ./telegram-time (shared with the nag pass) — re-exported so existing importers keep working.
export { localNow } from './telegram-time';
import { localNow } from './telegram-time';

/** "HH:MM" → minutes since local midnight, or null if malformed. */
function parseHhMm(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The daily-digest scheduler (ADR 0084, Step 7). A per-minute tick re-reads the config, computes the local
 * time in the configured timezone (so DST and mid-day edits are handled by construction), and fires the
 * digest at most once per local day inside a grace window after digestTime. The tick takes "now" from an
 * injected Clock, so it is tested by advancing a fake clock — the real interval is started from main.ts.
 */
@Injectable()
export class TelegramDigestService implements OnModuleDestroy {
  private readonly logger = new Logger('TelegramDigest');
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: TelegramConfigService,
    private readonly bot: TelegramBotService,
    private readonly settings: SettingsService,
    private readonly nags: TelegramNagService,
    private readonly meetingReminders: TelegramMeetingReminderService,
  ) {}

  /** Start the per-minute loop. Called from main.ts after listen, so the test harness never opens it. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /**
   * One scheduler tick. Fires iff enabled + a chat is bound + a timezone is set + the digest has not already
   * fired for today (local) + now is inside [digestTime, digestTime + grace). It is recorded as sent ONLY on
   * a successful send; an empty hand, no live bot, or a send failure all skip WITHOUT marking, so the next
   * tick retries within the window (and a whole failed window simply rolls to tomorrow).
   */
  async tick(): Promise<void> {
    if (this.ticking) return; // a slow tick must not overlap the next minute
    this.ticking = true;
    try {
      const s = await this.config.getDigestState();
      if (!s.boundChatId || !s.timezone) return; // nothing bound / no tz → no push of any kind

      const local = localNow(this.clock.now(), s.timezone);

      // Nag pass (ADR 0091 M2) — runs EVERY tick regardless of the digest toggle (nagging is per-routine,
      // not tied to the daily digest); it self-gates on quiet-hours and never throws.
      await this.nags.evaluate(local, s.boundChatId);

      // Meeting-reminder pass (ADR 0097) — also every tick, independent of the digest toggle. Fires one-shot
      // pings for tasks whose eventAt−lead has arrived. Uses the absolute clock (tz only for the message);
      // QUIET-HOURS EXEMPT (a meeting ping is time-critical), so it is NOT behind the quiet gate. Never throws.
      await this.meetingReminders.evaluate(this.clock.now(), s.boundChatId, s.timezone);

      // Digest pass — only when the daily digest is enabled.
      if (!s.enabled) return;
      if (s.lastSentOn === local.date) return; // already sent today

      const target = parseHhMm(s.time);
      if (target === null) return; // malformed (validated on write; defensive)

      // Quiet-hours (ADR 0091): the app sends NO Telegram push while inside the window. A digest whose
      // time falls INSIDE quiet-hours is DELAYED to quiet-end, not dropped (owner ruling 2026-08-21) —
      // so the EFFECTIVE send time is `target` normally, else quiet-end. We fire in [effective, +grace),
      // and never while currently quiet (belt-and-suspenders — a grace window that bled into a quiet
      // onset must not push). A suppressed tick returns WITHOUT marking sent, so it retries / rolls.
      const quiet = await this.settings.getQuietHours();
      const qStart = quiet.start === null ? null : hhmmToMinutes(quiet.start);
      const qEnd = quiet.end === null ? null : hhmmToMinutes(quiet.end);
      let effective = target;
      if (qStart !== null && qEnd !== null) {
        if (isWithinQuietMinutes(local.minutes, qStart, qEnd)) return; // currently quiet → no push at all
        if (isWithinQuietMinutes(target, qStart, qEnd)) effective = qEnd; // digest inside quiet → delay to quiet-end
      }
      if (local.minutes < effective || local.minutes >= effective + GRACE_MINUTES) return; // outside the window

      const result = await this.bot.pushHand(s.boundChatId);
      if (result === 'sent') {
        await this.config.markDigestSent(local.date);
        this.logger.log(`digest sent for ${local.date}`);
      }
      // 'empty' | 'no-bot' | 'no-timezone' | 'error' → do NOT mark; retry on the next tick within the window
    } catch (err) {
      this.logger.warn(`digest tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }
}
