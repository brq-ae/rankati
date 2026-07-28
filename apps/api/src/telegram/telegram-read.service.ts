import { Inject, Injectable } from '@nestjs/common';
import { computePin, type Task } from '@rankati/shared';
import { CLOCK, type Clock } from '../auth/clock';
import { LOCAL_OWNER_ID } from '../constants';
import { PrismaService } from '../prisma.service';
import { SettingsService } from '../settings.service';
import { TasksService } from '../tasks.service';
import { TelegramConfigService } from './telegram-config.service';

/** How many cards the bot's Today hand deals — the pin excludes these (ADR 0086). */
const HAND_SIZE = 5;

export interface PinInfo {
  task: Task;
  reason: string; // e.g. "high-impact · 8 days"
}
export type HandResult = { status: 'no-timezone' } | { status: 'ok'; cards: Task[] };
export type TodayResult = { status: 'no-timezone' } | { status: 'ok'; cards: Task[]; pin: PinInfo | null };
export type CompleteResult = { status: 'done'; title: string } | { status: 'gone' };

/**
 * The bot's read commands (ADRs 0084, 0086). The bot has no browser, so it derives the client clock the
 * Today read requires (`on`/`at`) from the configured IANA `timezone` and the injected clock; with no
 * timezone set it reports `no-timezone` rather than guess. `/today` and the digest also surface the ⚠️
 * impact pin (0086, un-deferring 0085) via the SHARED computePin — computed against the same Today read: the
 * playable set, the top-5 hand, each task's server-side snooze (`pinSnoozedUntil`), and the server config.
 */
@Injectable()
export class TelegramReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TelegramConfigService,
    private readonly tasks: TasksService,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The configured timezone turned into the read's `on` (YYYY-MM-DD) + `at` (HH:MM), or null if unset. */
  private async resolveClock(): Promise<{ on: string; at: string } | null> {
    const tz = (await this.config.getConfig()).timezone;
    if (!tz) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(this.clock.now());
    const g: Record<string, string> = {};
    for (const p of parts) g[p.type] = p.value;
    const hour = g.hour === '24' ? '00' : g.hour; // hour12:false can render midnight as "24"
    return { on: `${g.year}-${g.month}-${g.day}`, at: `${hour}:${g.minute}` };
  }

  /** The top `limit` of today's ranked, playable hand — or `no-timezone` when the clock cannot be derived. */
  async deal(limit: number): Promise<HandResult> {
    const clock = await this.resolveClock();
    if (!clock) return { status: 'no-timezone' };
    const today = await this.tasks.findToday(LOCAL_OWNER_ID, clock.on, clock.at);
    return { status: 'ok', cards: today.slice(0, limit) };
  }

  /**
   * Today's hand (top-5) + the ⚠️ impact pin (ADRs 0075, 0086) — the one Medium/High task that is playable,
   * past its fuse, NOT in the hand, and not snoozed, via the shared computePin against the server config +
   * each task's pinSnoozedUntil + the injected clock. Everything is derived from the ONE Today read.
   */
  async dealToday(): Promise<TodayResult> {
    const clock = await this.resolveClock();
    if (!clock) return { status: 'no-timezone' };
    const today = await this.tasks.findToday(LOCAL_OWNER_ID, clock.on, clock.at);
    const cards = today.slice(0, HAND_SIZE);

    const config = await this.settings.getPinConfig();
    const snoozes: Record<string, number> = {};
    for (const t of today) if (t.pinSnoozedUntil) snoozes[t.id] = Date.parse(t.pinSnoozedUntil);
    const p = computePin(
      today.map((t) => ({ id: t.id, impact: t.impact, createdAt: Date.parse(t.createdAt) })),
      new Set(today.map((t) => t.id)),
      cards.map((t) => t.id),
      snoozes,
      this.clock.now().getTime(),
      config,
    );
    const task = p ? (today.find((t) => t.id === p.id) ?? null) : null;
    const pin: PinInfo | null =
      p && task ? { task, reason: `${p.level}-impact · ${p.ageDays} ${p.ageDays === 1 ? 'day' : 'days'}` } : null;
    return { status: 'ok', cards, pin };
  }

  /** Complete a task after verifying it is the owner's — a deleted/foreign id answers `gone`, never throws. */
  async complete(taskId: string): Promise<CompleteResult> {
    const owned = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId: LOCAL_OWNER_ID },
      select: { id: true },
    });
    if (!owned) return { status: 'gone' };
    const done = await this.tasks.complete(taskId);
    return { status: 'done', title: done.title };
  }
}
