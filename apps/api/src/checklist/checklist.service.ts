import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ChecklistItem as ChecklistItemDto,
  CreateChecklistItemDto,
  UpdateChecklistItemDto,
} from '@rankati/shared';
import { LOCAL_OWNER_ID } from '../constants';
import type { ChecklistItem } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * Checklist items (ADR 0071) — a per-task readiness sub-resource. SOFT, NEVER a gate: nothing
 * here touches Today, Upcoming, Lists, or the Arena, and `done` is never auto-reset by this
 * service or by anything else — an item only leaves the table via `remove` or its task's own
 * deletion (cascade, enforced by the schema, not by code here).
 *
 * Every method is OWNER-SCOPED (0026, 0039), the routines `own()` posture: `create` checks the
 * PARENT TASK's owner (a task under another owner reads as "no such task"); `update`/`remove`
 * check the owner THROUGH the item's task, since a ChecklistItem carries no ownerId of its own
 * (same reasoning as TaskDependency/TaskLocation — it is only ever reached through a task, which
 * already carries the owner).
 */
@Injectable()
export class ChecklistService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Any checklist work is fleshing out the parent task, so it clears the task's "needs details"
   * flag (ADR 0073) — the same "any edit clears it" rule `update()` applies to the task's own
   * fields, extended here because a checklist mutation lives on a different endpoint. Idempotent:
   * setting an already-false flag to false is a harmless no-op, so add/edit/reorder/delete all call it.
   */
  private clearParentNeedsDetails(taskId: string): Promise<unknown> {
    return this.prisma.task.update({ where: { id: taskId }, data: { needsDetails: false } });
  }

  private toDto(item: ChecklistItem): ChecklistItemDto {
    return {
      id: item.id,
      taskId: item.taskId,
      text: item.text,
      done: item.done,
      position: item.position,
      createdAt: item.createdAt.toISOString(),
    };
  }

  /** Trimmed, non-empty, or 400 — whitespace-only is not text (the routines `name` posture). */
  private parseText(value: unknown): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new BadRequestException('text is required');
    return text;
  }

  /**
   * Add an item, appended to the end of this task's list (ADR 0071). `position` is the current
   * max for the task + 1 — 1 for the first item, since an empty list's "current max" reads as 0 —
   * so items always display in add order until a caller explicitly reorders one via `update`.
   */
  async create(taskId: string, dto: CreateChecklistItemDto): Promise<ChecklistItemDto> {
    const text = this.parseText(dto?.text);
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId: LOCAL_OWNER_ID },
      select: { id: true },
    });
    if (!task) {
      throw new NotFoundException(`task ${taskId} not found`);
    }

    const max = await this.prisma.checklistItem.aggregate({
      where: { taskId },
      _max: { position: true },
    });
    const position = (max._max.position ?? 0) + 1;

    const item = await this.prisma.checklistItem.create({ data: { taskId, text, position } });
    await this.clearParentNeedsDetails(taskId); // adding a readiness item flushes the flag (0073)
    return this.toDto(item);
  }

  /** Owner-scoped lookup THROUGH the parent task — an id under another owner reads as 404. */
  private async own(itemId: string): Promise<ChecklistItem> {
    const item = await this.prisma.checklistItem.findFirst({
      where: { id: itemId, task: { ownerId: LOCAL_OWNER_ID } },
    });
    if (!item) {
      throw new NotFoundException(`checklist item ${itemId} not found`);
    }
    return item;
  }

  /**
   * Edit any field directly (ADR 0071), the routines option-(c) pattern: values taken as-is,
   * nothing derived. `position` sets ONLY this item's own value — it does NOT renumber siblings;
   * display order is `position asc` (TASK_INCLUDE already sorts that way), so two items can share
   * a position and a caller wanting a clean resequence sends every item's new value itself.
   */
  async update(itemId: string, dto: UpdateChecklistItemDto): Promise<ChecklistItemDto> {
    const item = await this.own(itemId);
    const data: Record<string, unknown> = {};

    if ('text' in dto) {
      data.text = this.parseText(dto.text);
    }
    if ('done' in dto) {
      if (typeof dto.done !== 'boolean') {
        throw new BadRequestException('done must be a boolean');
      }
      data.done = dto.done;
    }
    if ('position' in dto) {
      if (!Number.isInteger(dto.position) || (dto.position as number) < 0) {
        throw new BadRequestException('position must be a non-negative integer');
      }
      data.position = dto.position;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('nothing to update: send text, done, position, or any combination');
    }

    const updated = await this.prisma.checklistItem.update({ where: { id: item.id }, data });
    await this.clearParentNeedsDetails(item.taskId); // editing/reordering an item flushes the flag (0073)
    return this.toDto(updated);
  }

  async remove(itemId: string): Promise<void> {
    const item = await this.own(itemId);
    await this.prisma.checklistItem.delete({ where: { id: item.id } });
    await this.clearParentNeedsDetails(item.taskId); // removing an item is task work too (0073)
  }
}
