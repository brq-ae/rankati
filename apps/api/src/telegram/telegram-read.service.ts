import { Injectable } from '@nestjs/common';
import type { Task } from '@rankati/shared';
import { LOCAL_OWNER_ID } from '../constants';
import { PrismaService } from '../prisma.service';
import { TasksService } from '../tasks.service';
import { TelegramConfigService } from './telegram-config.service';

export type HandResult = { status: 'no-timezone' } | { status: 'ok'; cards: Task[] };
export type CompleteResult = { status: 'done'; title: string } | { status: 'gone' };

/**
 * The bot's read commands (ADR 0084 / 0085, Step 6) — HAND-ONLY (no impact pin; deferred by 0085).
 *
 * The bot has no browser, so it derives the client clock the Today read requires (`on`/`at`) from the
 * configured IANA `timezone` and reads the server wall clock. With no timezone set there is no honest way to
 * know "today", so the reads report `no-timezone` rather than guess. The hand is a FRESH top-N of the
 * server's already-ranked Today read; completion reuses the existing owner-scoped complete path.
 */
@Injectable()
export class TelegramReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TelegramConfigService,
    private readonly tasks: TasksService,
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
    }).formatToParts(new Date());
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
