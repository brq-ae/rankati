import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type {
  CreateRoutineDto,
  Routine,
  RoutineActionDto,
  RoutineSnoozeDto,
  UpdateRoutineDto,
} from '@rankati/shared';
import { RoutinesService } from './routines.service';

/**
 * Served at /api/routines (ADR 0066). Reads take the client's local day `on`, like the Today reads
 * (0052), and recompute display state fresh. Routines are wholly outside the engine — nothing here
 * touches tasks, the Arena, or the Today/Upcoming reads.
 */
@Controller('routines')
export class RoutinesController {
  constructor(private readonly routines: RoutinesService) {}

  @Get()
  findAll(@Query('on') on?: string): Promise<Routine[]> {
    return this.routines.findAll(on);
  }

  @Post()
  create(@Body() dto: CreateRoutineDto): Promise<Routine> {
    return this.routines.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRoutineDto): Promise<Routine> {
    return this.routines.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): Promise<void> {
    return this.routines.remove(id);
  }

  @Post(':id/did')
  did(@Param('id') id: string, @Body() dto: RoutineActionDto): Promise<Routine> {
    return this.routines.did(id, dto?.on);
  }

  @Post(':id/dismiss')
  dismiss(@Param('id') id: string, @Body() dto: RoutineActionDto): Promise<Routine> {
    return this.routines.dismiss(id, dto?.on);
  }

  @Post(':id/snooze')
  snooze(@Param('id') id: string, @Body() dto: RoutineSnoozeDto): Promise<Routine> {
    return this.routines.snooze(id, dto?.until);
  }
}
