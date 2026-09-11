import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { TelegramBotService } from './telegram-bot.service';

const MINUTE_MS = 60_000;

/**
 * Meeting reminders (ADR 0097, Build 3 S2) — the one-shot Telegram ping for a task's `eventAt`. Driven off
 * the SAME per-minute tick as the digest/nag (TelegramDigestService.tick, no new timer). The tick already
 * requires a bound chat + a timezone before it calls anything, so those are guaranteed here.
 *
 * DISTINCT from the recurring nag (ADR 0091) in two ways:
 *  - QUIET-HOURS EXEMPT: a meeting reminder is a user-chosen, one-shot, time-critical ping (a 7am reminder
 *    for an 8am meeting must fire even inside the quiet window). It does NOT consult quiet-hours.
 *  - FIRE-ONCE: it sends only while `sentAt IS NULL`, then stamps `sentAt`. Re-arming (sentAt→null) on a
 *    reschedule is handled at write time (S1a), so a moved meeting pings again.
 *
 * Firing is a comparison of ABSOLUTE instants (`now >= eventAt − leadMinutes`), so it needs no timezone; the
 * tz is used ONLY to render the meeting's local time in the message.
 */
@Injectable()
export class TelegramMeetingReminderService {
  private readonly logger = new Logger('TelegramMeetingReminder');

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
  ) {}

  /** Called once per tick with the injected `now`, the bound chat, and the owner's tz. Never throws. */
  async evaluate(now: Date, boundChatId: string, timeZone: string): Promise<void> {
    try {
      const due = await this.prisma.taskReminder.findMany({
        where: { sentAt: null, task: { status: 'active', eventAt: { not: null } } },
        include: { task: { select: { title: true, eventAt: true } } },
      });
      for (const r of due) {
        const eventAt = r.task.eventAt as Date;
        const fireAt = eventAt.getTime() - r.leadMinutes * MINUTE_MS;
        if (now.getTime() < fireAt) continue; // not yet due

        const text = formatReminder(r.task.title, eventAt, r.leadMinutes, timeZone);
        const result = await this.bot.pushReminder(boundChatId, text);
        // Mark ONLY on a real send, exactly like the nag/digest — a no-bot/error leaves sentAt null so the
        // next tick retries. Fire-once is the sentAt stamp; a reschedule re-armed it at write time.
        if (result === 'sent') {
          await this.prisma.taskReminder.update({ where: { id: r.id }, data: { sentAt: now } });
        }
      }
    } catch (err) {
      this.logger.warn(`meeting reminder evaluate failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** "🕒 {title} — {local when}, in {lead}". The lead phrase is 0 → "now", else the largest whole unit. */
export function formatReminder(title: string, eventAt: Date, leadMinutes: number, timeZone: string): string {
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(eventAt);
  return `🕒 ${title} — ${when}${leadMinutes === 0 ? ' (now)' : `, in ${leadPhrase(leadMinutes)}`}`;
}

function leadPhrase(mins: number): string {
  if (mins % 1440 === 0) return plural(mins / 1440, 'day');
  if (mins % 60 === 0) return plural(mins / 60, 'hour');
  return plural(mins, 'minute');
}
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
