import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from '@nestjs/common';
import type { ChecklistItem, CreateChecklistItemDto, UpdateChecklistItemDto } from '@rankati/shared';
import { ChecklistService } from './checklist.service';

/**
 * Checklist routes (ADR 0071) — a sub-resource, not new Task fields, so this controller declares
 * its own paths rather than nesting under `@Controller('tasks')`: creation is addressed through
 * the parent task (`/tasks/:id/checklist`), but edit/delete are addressed by the item's own id
 * (`/checklist/:itemId`), same as routines address a routine by its own id regardless of what
 * created it. SOFT, NEVER a gate — nothing here touches Today, Upcoming, Lists, or the Arena.
 */
@Controller()
export class ChecklistController {
  constructor(private readonly checklist: ChecklistService) {}

  @Post('tasks/:id/checklist')
  create(@Param('id') id: string, @Body() dto: CreateChecklistItemDto): Promise<ChecklistItem> {
    return this.checklist.create(id, dto);
  }

  @Patch('checklist/:itemId')
  update(@Param('itemId') itemId: string, @Body() dto: UpdateChecklistItemDto): Promise<ChecklistItem> {
    return this.checklist.update(itemId, dto);
  }

  @Delete('checklist/:itemId')
  @HttpCode(204)
  remove(@Param('itemId') itemId: string): Promise<void> {
    return this.checklist.remove(itemId);
  }
}
