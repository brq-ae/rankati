import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import type { ConvertIdeaDto, CreateIdeaDto, Idea, Task, UpdateIdeaDto } from '@rankati/shared';
import { IdeasService } from './ideas.service';

/**
 * Served at /api/ideas (ADR 0090). Behind the global session + CSRF guard, like the rest of the authed API
 * — no `@Public`. Ideas are wholly outside the engine (the Logs 0087 pattern) — nothing here touches the
 * Arena or the Today/Upcoming reads. Reads carry no `on` (an idea has no day-relative state, unlike a Log).
 * `convert` is the one bridge INTO the engine: it promotes an idea to a Task in a list the owner picks.
 */
@Controller('ideas')
export class IdeasController {
  constructor(private readonly ideas: IdeasService) {}

  @Get()
  findAll(): Promise<Idea[]> {
    return this.ideas.findAll();
  }

  @Post()
  create(@Body() dto: CreateIdeaDto): Promise<Idea> {
    return this.ideas.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateIdeaDto): Promise<Idea> {
    return this.ideas.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): Promise<void> {
    return this.ideas.remove(id);
  }

  @Post(':id/convert')
  convert(@Param('id') id: string, @Body() dto: ConvertIdeaDto): Promise<Task> {
    return this.ideas.convert(id, dto);
  }
}
