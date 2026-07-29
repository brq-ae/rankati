import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateLogDto, Log as LogDto, LogEntry as LogEntryDto, UpdateLogDto } from '@rankati/shared';
import { computeLogStats } from '@rankati/shared';
import { LOCAL_OWNER_ID } from './constants';
import type { Log, LogEntry } from './generated/prisma/client';
import { PrismaService } from './prisma.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const requireDay = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !DAY.test(v)) throw new BadRequestException(`${field} must be YYYY-MM-DD`);
  return v;
};
/** A `@db.Date` row-value → its `YYYY-MM-DD` day (the column is stored at UTC midnight). */
const dayStr = (d: Date): string => d.toISOString().slice(0, 10);
/** A `YYYY-MM-DD` → the UTC-midnight `Date` a `@db.Date` column expects. */
const toDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

type LogWithEntries = Log & { entries: LogEntry[] };

/**
 * Logs (ADR 0087) — pull-based cadence trackers, the OPPOSITE of a Routine: their occurrences ARE the
 * history, they never climb or nag, and the cadence stats are shown only when opened. Every method is
 * OWNER-SCOPED (0026, 0039) — a foreign/stale id reads as 404, never a silent success. Stats are derived
 * SERVER-SIDE via the shared `computeLogStats` (ADR 0086 lesson) against the client's local day `on`, so
 * every future client shows the identical cadence. Wholly outside the engine — nothing here touches tasks.
 */
@Injectable()
export class LogsService {
  constructor(private readonly prisma: PrismaService) {}

  private entryDto(e: LogEntry): LogEntryDto {
    return { id: e.id, doneOn: dayStr(e.doneOn), createdAt: e.createdAt.toISOString() };
  }

  /** Map a Log row (+ its entries) to the wire DTO, deriving stats against `on`. Entries newest-first. */
  private toDto(row: LogWithEntries, on: string, withEntries: boolean): LogDto {
    const entries = [...row.entries].sort((a, b) => b.doneOn.getTime() - a.doneOn.getTime());
    const stats = computeLogStats(
      entries.map((e) => ({ doneOn: dayStr(e.doneOn) })),
      on,
    );
    const dto: LogDto = {
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      stats,
    };
    if (withEntries) dto.entries = entries.map((e) => this.entryDto(e));
    return dto;
  }

  /** Owner-scoped lookup (with entries) — an id that isn't this owner's reads as 404. */
  private async own(id: string): Promise<LogWithEntries> {
    const row = await this.prisma.log.findFirst({
      where: { id, ownerId: LOCAL_OWNER_ID },
      include: { entries: true },
    });
    if (!row) throw new NotFoundException(`log ${id} not found`);
    return row;
  }

  async findAll(on?: string): Promise<LogDto[]> {
    const onStr = requireDay(on, 'on');
    const rows = await this.prisma.log.findMany({
      where: { ownerId: LOCAL_OWNER_ID },
      include: { entries: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toDto(r, onStr, false)); // list: stats only, no full history
  }

  async findOne(id: string, on?: string): Promise<LogDto> {
    const onStr = requireDay(on, 'on');
    return this.toDto(await this.own(id), onStr, true); // detail: with the dated occurrences
  }

  async create(dto: CreateLogDto): Promise<LogDto> {
    const name = typeof dto?.name === 'string' ? dto.name.trim() : '';
    if (!name) throw new BadRequestException('name is required');
    const row = await this.prisma.log.create({ data: { name, ownerId: LOCAL_OWNER_ID }, include: { entries: true } });
    // A fresh Log has no occurrences → stats are the empty result, independent of the day.
    return this.toDto(row, dayStr(row.createdAt), true);
  }

  async rename(id: string, dto: UpdateLogDto, on?: string): Promise<LogDto> {
    const onStr = requireDay(on, 'on');
    const name = typeof dto?.name === 'string' ? dto.name.trim() : '';
    if (!name) throw new BadRequestException('name is required');
    await this.own(id); // 404 if foreign/stale
    await this.prisma.log.update({ where: { id }, data: { name } });
    return this.findOne(id, onStr);
  }

  async remove(id: string): Promise<void> {
    await this.own(id); // 404 if foreign/stale
    await this.prisma.log.delete({ where: { id } }); // cascade drops its LogEntry rows
  }

  /**
   * Stamp today's occurrence (ADR 0087). Idempotent per calendar day: the `@@unique([logId, doneOn])`
   * makes a second tap on the same day a no-op success (upsert with an empty update), NOT a P2002 500.
   */
  async did(id: string, on?: string): Promise<LogDto> {
    const onStr = requireDay(on, 'on');
    await this.own(id); // 404 if foreign/stale
    await this.prisma.logEntry.upsert({
      where: { logId_doneOn: { logId: id, doneOn: toDate(onStr) } },
      create: { logId: id, doneOn: toDate(onStr) },
      update: {},
    });
    return this.findOne(id, onStr);
  }

  /**
   * Undo — remove one occurrence (ADR 0087): the history "remove" and undoing a mis-tapped did-today.
   * The entry must belong to the OWNER'S log: `own` gates the log (404 if foreign), then the entry must
   * be that log's (404 otherwise) — a foreign entry id can never be deleted through another's log.
   */
  async undo(logId: string, entryId: string, on?: string): Promise<LogDto> {
    const onStr = requireDay(on, 'on');
    await this.own(logId); // 404 if the log isn't this owner's
    const entry = await this.prisma.logEntry.findFirst({ where: { id: entryId, logId } });
    if (!entry) throw new NotFoundException(`log entry ${entryId} not found`);
    await this.prisma.logEntry.delete({ where: { id: entryId } });
    return this.findOne(logId, onStr);
  }
}
