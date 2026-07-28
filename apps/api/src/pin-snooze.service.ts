import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { snoozeSpanMs } from '@rankati/shared';
import { CLOCK, type Clock } from './auth/clock';
import { LOCAL_OWNER_ID } from './constants';
import { PrismaService } from './prisma.service';
import { SettingsService } from './settings.service';

/**
 * The impact-pin snooze (ADR 0086) — hide a fired pin for its level's span, stored server-side on
 * `Task.pinSnoozedUntil` so web and the bot share one snooze state. The span comes from the task's impact
 * LEVEL + the stored config; the moment is `clock.now() + span` (an absolute instant — no timezone).
 */
@Injectable()
export class PinSnoozeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Snooze a task's pin. Owner-scoped — a stale/foreign id is a clean 404. A NONE-impact task has no level
   * or span, so it is rejected (400) rather than given a bogus snooze. Returns the snooze instant.
   */
  async snooze(taskId: string): Promise<{ pinSnoozedUntil: Date }> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId: LOCAL_OWNER_ID },
      select: { id: true, impact: true },
    });
    if (!task) {
      throw new NotFoundException(`task ${taskId} not found`);
    }
    if (task.impact !== 'medium' && task.impact !== 'high') {
      throw new BadRequestException('only a Medium- or High-impact task has a pin to snooze');
    }
    const config = await this.settings.getPinConfig();
    const until = new Date(this.clock.now().getTime() + snoozeSpanMs(task.impact, config));
    await this.prisma.task.update({ where: { id: task.id }, data: { pinSnoozedUntil: until } });
    return { pinSnoozedUntil: until };
  }

  /** Clear a task's pin snooze (ADR 0086). Owner-scoped; a stale/foreign id is a clean 404. */
  async unsnooze(taskId: string): Promise<void> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId: LOCAL_OWNER_ID },
      select: { id: true },
    });
    if (!task) {
      throw new NotFoundException(`task ${taskId} not found`);
    }
    await this.prisma.task.update({ where: { id: task.id }, data: { pinSnoozedUntil: null } });
  }
}
