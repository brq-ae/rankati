import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { CreateRequiredTaskDto, CreateTaskDto, Task, UpdateTaskDto } from '@rankati/shared';
import { LOCAL_OWNER_ID } from './constants';
import { PinSnoozeService } from './pin-snooze.service';
import { TasksService } from './tasks.service';

/** Served at /api/tasks — the global prefix applies everywhere (ADR 0042). */
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly pinSnooze: PinSnoozeService,
  ) {}

  /** `?sort=rating` gives the ranked list the Arena earns (ADRs 0003, 0047). */
  @Get()
  findAll(@Query('sort') sort?: string): Promise<Task[]> {
    return this.tasks.findAll(sort);
  }

  /**
   * The Today read: active tasks whose gates have opened, most important first (ADR 0052).
   *
   * DECLARED BEFORE @Get(':id') AND IT MUST STAY THERE. Nest matches routes in declaration
   * order, so below that route the literal 'today' is captured as an id and this becomes
   * "task today not found" — a 404 that reads like a missing task rather than a routing
   * bug. tasks-today.spec.ts pins the order.
   *
   * `on` is the CLIENT'S local day. It is required, and its absence is a 400 rather than an
   * un-gated list: a gate that silently stops gating is worse than no gate, because every
   * gated task reappears here looking like normal operation (0052).
   *
   * `at` is the client's local TIME, HH:MM — the availability-window gate's clock context
   * (0070). CONDITIONALLY required, judged in the service against the loaded set: the moment
   * any task carries a window, absence is a 400 by the same fail-closed reasoning as `on`.
   *
   * `block` is the free-time block the hand is dealt against — the fit term (0072). OPTIONAL
   * and ephemeral, unlike the two above: absent is Any (the neutral default), and a too-big
   * task sinks only when a block is set. It rides THIS read alone — Upcoming does not take it.
   */
  @Get('today')
  findToday(
    @Query('on') on?: string,
    @Query('at') at?: string,
    @Query('block') block?: string,
  ): Promise<Task[]> {
    return this.tasks.findToday(LOCAL_OWNER_ID, on, at, block);
  }

  /**
   * Dated tasks not yet near enough to be playable (ADR 0058). DECLARED BEFORE @Get(':id') for
   * the same reason `today` is: below it, the literal 'upcoming' is captured as an id. `on` is
   * the client's local day, required exactly as the Today read requires it. `at` is the local
   * time, conditionally required exactly as Today requires it (0070) — the gate is ONE
   * predicate and both reads inherit it whole.
   */
  @Get('upcoming')
  findUpcoming(@Query('on') on?: string, @Query('at') at?: string): Promise<Task[]> {
    return this.tasks.findUpcoming(LOCAL_OWNER_ID, on, at);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Task> {
    return this.tasks.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateTaskDto): Promise<Task> {
    return this.tasks.create(dto);
  }

  /** Rename — edits the title only (edit/delete is a planned addition). */
  /**
   * Create a prerequisite and link it, in one transaction (ADR 0054). All-or-nothing:
   * two calls could strand an orphan task in a list nobody chose.
   *
   * Returns the BLOCKED task — the caller asked what it now requires.
   */
  @Post(':id/requires')
  createRequired(@Param('id') id: string, @Body() dto: CreateRequiredTaskDto): Promise<Task> {
    return this.tasks.createRequired(id, dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto): Promise<Task> {
    return this.tasks.update(id, dto);
  }

  @Patch(':id/complete')
  complete(@Param('id') id: string): Promise<Task> {
    return this.tasks.complete(id);
  }

  /**
   * Snooze the task's impact pin (ADR 0086) — hides the fired pin for its level's span. Returns the updated
   * task so the pin recomputes from the read. 404 a stale/foreign id; 400 a None-impact task (no pin to snooze).
   */
  @Post(':id/pin-snooze')
  @HttpCode(200)
  async snoozePin(@Param('id') id: string): Promise<Task> {
    await this.pinSnooze.snooze(id);
    return this.tasks.findOne(id);
  }

  /** Clear the task's pin snooze (ADR 0086). Returns the updated task. */
  @Delete(':id/pin-snooze')
  @HttpCode(200)
  async unsnoozePin(@Param('id') id: string): Promise<Task> {
    await this.pinSnooze.unsnooze(id);
    return this.tasks.findOne(id);
  }

  /**
   * Delete, cascading the task's duels (ADR 0048).
   *
   * 204 and no body: the cascade's real cost — that a surviving task's rating can no
   * longer be reproduced exactly from the log — is a property of the decision, not news
   * about this request. It belongs in 0048, where it is recorded, not in a response body.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.tasks.remove(id);
  }
}
