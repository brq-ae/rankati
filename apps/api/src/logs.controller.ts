import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { CreateLogDto, Log, LogDidDto, UpdateLogDto } from '@rankati/shared';
import { LogsService } from './logs.service';

/**
 * Served at /api/logs (ADR 0087). Behind the global session + CSRF guard, like the rest of the authed
 * API — no `@Public`. Reads and the mutations that return a Log carry `on` (the client's local day, 0052)
 * so the server-derived cadence stats are fresh; `did` carries the day it stamps in its body. Logs are
 * wholly outside the engine — nothing here touches tasks, the Arena, or the Today/Upcoming reads.
 */
@Controller('logs')
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  @Get()
  findAll(@Query('on') on?: string): Promise<Log[]> {
    return this.logs.findAll(on);
  }

  @Post()
  create(@Body() dto: CreateLogDto): Promise<Log> {
    return this.logs.create(dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Query('on') on?: string): Promise<Log> {
    return this.logs.findOne(id, on);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() dto: UpdateLogDto, @Query('on') on?: string): Promise<Log> {
    return this.logs.rename(id, dto, on);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): Promise<void> {
    return this.logs.remove(id);
  }

  @Post(':id/did')
  did(@Param('id') id: string, @Body() dto: LogDidDto): Promise<Log> {
    return this.logs.did(id, dto?.on);
  }

  @Delete(':id/entries/:entryId')
  undo(@Param('id') id: string, @Param('entryId') entryId: string, @Query('on') on?: string): Promise<Log> {
    return this.logs.undo(id, entryId, on);
  }
}
