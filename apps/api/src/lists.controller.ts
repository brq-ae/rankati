import { Body, Controller, Delete, Get, HttpCode, Post, Param, Patch } from '@nestjs/common';
import type { CreateListDto, List, UpdateListDto } from '@rankati/shared';
import { ListsService } from './lists.service';

/** Served at /api/lists — the global prefix applies everywhere (ADR 0042). */
@Controller('lists')
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  @Get()
  findAll(): Promise<List[]> {
    return this.lists.findAll();
  }

  /** Rename a list. Empty name -> 400; unknown id -> 404. */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateListDto): Promise<List> {
    return this.lists.update(id, dto);
  }

  @Post()
  create(@Body() dto: CreateListDto): Promise<List> {
    return this.lists.create(dto);
  }

  /** Delete a list; its tasks cascade (and their dependency links and location tags). 404 unknown id. */
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): Promise<void> {
    return this.lists.remove(id);
  }
}
