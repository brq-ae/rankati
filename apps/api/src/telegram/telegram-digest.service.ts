import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CLOCK, type Clock } from '../auth/clock';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramConfigService } from './telegram-config.service';

/** How long after digestTime a missed digest may still fire (Step 7) — a boot at 08:15 delivers; noon skips. */
const GRACE_MINUTES = 120;
const TICK_MS = 60_000;

/** The local date + minute-of-day of a moment in an IANA timezone (DST handled by Intl). */
export function localNow(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const g: Record<string, string> = {};
  for (const p of parts) g[p.type] = p.value;
  const hour = g.hour === '24' ? 0 : Number(g.hour); // hour12:false can render midnight as "24"
  return { date: `${g.year}-${g.month}-${g.day}`, minutes: hour * 60 + Number(g.minute) };
}

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
      if (!s.enabled || !s.boundChatId || !s.timezone) return;

      const local = localNow(this.clock.now(), s.timezone);
      if (s.lastSentOn === local.date) return; // already sent today

      const target = parseHhMm(s.time);
      if (target === null) return; // malformed (validated on write; defensive)
      if (local.minutes < target || local.minutes >= target + GRACE_MINUTES) return; // outside the window

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
