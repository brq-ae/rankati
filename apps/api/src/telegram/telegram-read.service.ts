import { Inject, Injectable } from '@nestjs/common';
import { computePin, sortRoutines, type Impact, type Routine, type Task } from '@rankati/shared';
import { CLOCK, type Clock } from '../auth/clock';
import { LOCAL_OWNER_ID } from '../constants';
import { ListsService } from '../lists.service';
import { LogsService, type LogSummary } from '../logs.service';
import { PrismaService } from '../prisma.service';
import { RoutinesService } from '../routines/routines.service';
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

// Display-only read views (ADR 0088). /lists needs no timezone; /routines needs the local day (else
// 'no-timezone' → hint); /logs partial-degrades (last-done + average always; "days ago" only with a tz).
export type ListsResult = { id: string; name: string }[];
export type ListTasksResult =
  | { status: 'gone' }
  | { status: 'ok'; name: string; tasks: { title: string; impact: Impact }[] };
export type RoutinesResult = { status: 'no-timezone' } | { status: 'ok'; on: string; routines: Routine[] };
export type LogsResult = { hasTimezone: boolean; logs: LogSummary[] };

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
    private readonly lists: ListsService,
    private readonly routines: RoutinesService,
    private readonly logs: LogsService,
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

  // ── Display-only read views (ADR 0088) — no mutations, no timezone needed for /lists. ──────────────

  /** The list set (id + name) for the /lists picker. Owner-scoped (ListsService); needs no timezone. */
  async readLists(): Promise<ListsResult> {
    return (await this.lists.findAll()).map((l) => ({ id: l.id, name: l.name }));
  }

  /**
   * A picked list's ACTIVE tasks (title + impact, for the ⚠️ marker), most-important first. Ownership is
   * verified — a foreign/stale list id answers `gone`, never another owner's tasks. The caps are applied
   * when rendering (Step 5); this returns the full active set.
   */
  async readListTasks(listId: string): Promise<ListTasksResult> {
    const list = await this.prisma.list.findFirst({
      where: { id: listId, ownerId: LOCAL_OWNER_ID },
      select: { name: true },
    });
    if (!list) return { status: 'gone' };
    const tasks = await this.prisma.task.findMany({
      where: { listId, ownerId: LOCAL_OWNER_ID, status: 'active' },
      orderBy: { rating: 'desc' },
      select: { title: true, impact: true },
    });
    return { status: 'ok', name: list.name, tasks };
  }

  /**
   * The Reminders in climb order via the SHARED sortRoutines (ADRs 0066, 0088), so the bot matches the web
   * tab exactly. The order is day-relative — with no timezone it reports `no-timezone` so the command can
   * hint. Snoozed routines are hidden, like the tab (a display-only hide).
   */
  async readRoutines(): Promise<RoutinesResult> {
    const clock = await this.resolveClock();
    if (!clock) return { status: 'no-timezone' };
    const all = await this.routines.findAll(clock.on);
    const now = this.clock.now().getTime();
    const visible = all.filter((r) => !r.snoozedUntil || now >= Date.parse(r.snoozedUntil));
    return { status: 'ok', on: clock.on, routines: sortRoutines(visible, clock.on) };
  }

  /**
   * All logs with tz-OPTIONAL cadence stats (ADR 0088) via LogsService.readSummaries: last-done + average
   * cadence always, "days ago" (currentGapDays) only when a timezone is set. `hasTimezone` tells the
   * command whether to add a set-a-timezone hint.
   */
  async readLogs(): Promise<LogsResult> {
    const clock = await this.resolveClock();
    return { hasTimezone: clock !== null, logs: await this.logs.readSummaries(clock ? clock.on : null) };
  }
}
