import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ConvertIdeaDto,
  CreateIdeaDto,
  Idea as IdeaDto,
  Task as TaskDto,
  UpdateIdeaDto,
} from '@rankati/shared';
import { LOCAL_OWNER_ID } from './constants';
import type { Idea } from './generated/prisma/client';
import { PrismaService } from './prisma.service';
import { TASK_INCLUDE, toTaskDto } from './task-mapper';

/**
 * Free text → its stored form (ADR 0090), the tri-state/trim shared by `Idea.body` and `Task.notes`: a
 * string is trimmed of OUTER whitespace with internal newlines preserved, and an empty/whitespace-only
 * value (or an explicit null/absent) becomes null. A non-string, non-null value is the caller's bug (400).
 */
function parseBody(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new BadRequestException('body must be a string or null');
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Ideas (ADR 0090) — a pre-decision capture space, the OPPOSITE of a decided task: wholly outside the
 * engine (never ranked, gated, dealt to Today, or in the Arena), the Logs (0087) sibling-entity pattern.
 * Every method is OWNER-SCOPED (0026, 0039) — a foreign/stale id reads as 404, never a silent success.
 * Promotion (`convert`) copies the idea into a Task in a list the owner PICKS and deletes the idea, in one
 * transaction; there is no Inbox and no list auto-creation (0090).
 */
@Injectable()
export class IdeasService {
  constructor(private readonly prisma: PrismaService) {}

  private toDto(row: Idea): IdeaDto {
    return {
      id: row.id,
      ownerId: row.ownerId,
      title: row.title,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Owner-scoped lookup — an id that isn't this owner's reads as 404. */
  private async own(id: string): Promise<Idea> {
    const row = await this.prisma.idea.findFirst({ where: { id, ownerId: LOCAL_OWNER_ID } });
    if (!row) throw new NotFoundException(`idea ${id} not found`);
    return row;
  }

  /** How many ideas the owner has — the teach-not-nag footer gate (0090): the Telegram capture tip shows
   *  only while this is zero, then retires. */
  async count(): Promise<number> {
    return this.prisma.idea.count({ where: { ownerId: LOCAL_OWNER_ID } });
  }

  /** Newest-first (createdAt desc) — an idea inbox reads most-recent-first (0090), unlike Logs' asc. */
  async findAll(): Promise<IdeaDto[]> {
    const rows = await this.prisma.idea.findMany({
      where: { ownerId: LOCAL_OWNER_ID },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(dto: CreateIdeaDto): Promise<IdeaDto> {
    const title = typeof dto?.title === 'string' ? dto.title.trim() : '';
    if (!title) throw new BadRequestException('title is required');
    const row = await this.prisma.idea.create({
      data: { title, body: parseBody(dto?.body), ownerId: LOCAL_OWNER_ID },
    });
    return this.toDto(row);
  }

  async update(id: string, dto: UpdateIdeaDto): Promise<IdeaDto> {
    await this.own(id); // 404 if foreign/stale
    const data: { title?: string; body?: string | null } = {};
    if ('title' in dto) {
      const title = typeof dto.title === 'string' ? dto.title.trim() : '';
      if (!title) throw new BadRequestException('title is required'); // an idea always has a title
      data.title = title;
    }
    if ('body' in dto) {
      // The 0090 tri-state: null/empty clears, a string sets (trimmed outer, newlines kept).
      data.body = parseBody(dto.body);
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('nothing to update: send title, body, or both');
    }
    const row = await this.prisma.idea.update({ where: { id }, data }); // @updatedAt bumps
    return this.toDto(row);
  }

  async remove(id: string): Promise<void> {
    await this.own(id); // 404 if foreign/stale
    await this.prisma.idea.delete({ where: { id } });
  }

  /**
   * Promote an idea to a Task (ADR 0090). The owner PICKS the destination list — required; there is no
   * Inbox and no auto-creation. ONE transaction: verify the idea and the picked list are the owner's (404 /
   * 400 before any write), create the Task with `title -> title`, `body -> notes`, `needsDetails: true`
   * (a create, so the freshly promoted task keeps the flag — it is not an edit), and delete the idea (no
   * history kept). Atomic: any failure rolls the whole thing back, so a promotion never orphans a task or
   * loses the idea. Returns the created Task.
   */
  async convert(id: string, dto: ConvertIdeaDto): Promise<TaskDto> {
    const listId = typeof dto?.listId === 'string' ? dto.listId : '';
    if (!listId) throw new BadRequestException('listId is required');
    return this.prisma.$transaction(async (tx) => {
      const idea = await tx.idea.findFirst({ where: { id, ownerId: LOCAL_OWNER_ID } });
      if (!idea) throw new NotFoundException(`idea ${id} not found`);
      const list = await tx.list.findFirst({
        where: { id: listId, ownerId: LOCAL_OWNER_ID },
        select: { id: true },
      });
      if (!list) throw new BadRequestException(`list ${listId} does not exist`);
      const task = await tx.task.create({
        include: TASK_INCLUDE,
        data: {
          title: idea.title,
          notes: idea.body, // body -> notes; already stored trimmed/null (0090)
          needsDetails: true, // a create, not an edit — the promoted task is a fresh capture (0073)
          listId: list.id,
          ownerId: LOCAL_OWNER_ID,
        },
      });
      await tx.idea.delete({ where: { id } });
      return toTaskDto(task);
    });
  }
}
