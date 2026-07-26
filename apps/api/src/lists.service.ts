import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateListDto, List as ListDto, UpdateListDto } from '@rankati/shared';
import { LOCAL_OWNER_ID } from './constants';
import type { List } from './generated/prisma/client';
import { PrismaService } from './prisma.service';

/**
 * Maps a stored row to the wire contract (@rankati/shared).
 *
 * Explicit rather than automatic: this is the only place the DB shape and the API
 * contract meet, and a silent divergence here is invisible to TypeScript because
 * serialisation happens after our types stop looking (ADR 0041).
 */
function toListDto(list: List): ListDto {
  return {
    id: list.id,
    name: list.name,
    ownerId: list.ownerId,
  };
}

@Injectable()
export class ListsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<ListDto[]> {
    // Scoped by owner from day one, so auth needs no retrofit (ADRs 0026, 0039).
    const lists = await this.prisma.list.findMany({
      where: { ownerId: LOCAL_OWNER_ID },
      orderBy: { name: 'asc' },
    });
    return lists.map(toListDto);
  }

  /**
   * Rename a list — the gap v0.1 left: tasks could be renamed, lists could not.
   *
   * Same shape as renaming a task: trim, refuse empty, 404 an unknown id. Scoped by owner
   * in the lookup rather than trusting the id alone (0026, 0039).
   */
  async update(id: string, dto: UpdateListDto): Promise<ListDto> {
    const name = typeof dto?.name === 'string' ? dto.name.trim() : '';
    if (!name) {
      throw new BadRequestException('name is required');
    }

    const list = await this.prisma.list.findFirst({ where: { id, ownerId: LOCAL_OWNER_ID } });
    if (!list) {
      throw new NotFoundException(`list ${id} not found`);
    }

    const updated = await this.prisma.list.update({ where: { id: list.id }, data: { name } });
    return toListDto(updated);
  }

  async create(dto: CreateListDto): Promise<ListDto> {
    const name = typeof dto?.name === 'string' ? dto.name.trim() : '';
    if (!name) {
      throw new BadRequestException('name is required');
    }

    const list = await this.prisma.list.create({
      // The client never sends ownerId; the server stamps it (ADR 0039).
      data: { name, ownerId: LOCAL_OWNER_ID },
    });
    return toListDto(list);
  }

  /**
   * Delete a list — the verb v0.1 never had (Get/Post/Patch only), added in v0.13 (ADR 0064).
   *
   * OWNER-SCOPED in the lookup (0026, 0039): a list id that isn't this owner's reads as a 404, not a
   * silent success — the same boundary the reset deletes rest on, in a per-row endpoint. The tasks go
   * with it: `Task -> List` is `onDelete: Cascade`, and that chains on — each deleted task takes its
   * dependency links and location tags (and duels) with it. No count guard here: deleting the LAST
   * list is allowed (the client lands on an empty state), and deletion never fails for a reason on a
   * screen you are not looking at (0053/0061's cascade philosophy). The client warns with the task
   * count first, graduated by size.
   */
  async remove(id: string): Promise<void> {
    const list = await this.prisma.list.findFirst({
      where: { id, ownerId: LOCAL_OWNER_ID },
      select: { id: true },
    });
    if (!list) {
      throw new NotFoundException(`list ${id} not found`);
    }
    await this.prisma.list.delete({ where: { id: list.id } });
  }
}
