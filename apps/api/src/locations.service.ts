import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateLocationDto,
  Location as LocationDto,
  MergeLocationsDto,
  UpdateLocationDto,
} from '@rankati/shared';
import { LOCAL_OWNER_ID } from './constants';
import type { Location } from './generated/prisma/client';
import { PrismaService } from './prisma.service';

/** Maps a stored row to the wire contract (@rankati/shared) — explicit, like toListDto (ADR 0041). */
function toLocationDto(location: Location): LocationDto {
  return {
    id: location.id,
    name: location.name,
    ownerId: location.ownerId,
  };
}

/**
 * The managed location set (ADRs 0060, 0061).
 *
 * Every method is OWNER-SCOPED — the lookup filters by ownerId rather than trusting an id
 * alone (0026, 0039). Inert today (one local owner) but load-bearing the day auth lands: a
 * location id belonging to someone else must not be tag-able, renamable, deletable or mergeable
 * here, and the scoping is what makes that true rather than a check someone must remember.
 */
@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<LocationDto[]> {
    const locations = await this.prisma.location.findMany({
      where: { ownerId: LOCAL_OWNER_ID },
      orderBy: { name: 'asc' },
    });
    return locations.map(toLocationDto);
  }

  /**
   * Reject a name that already exists for this owner, case-insensitively (ADR 0061) — the
   * friendly 400. The `lower(name)` unique index is the race-proof floor behind this; the
   * read-then-write gap between them is the single-user race 0053 accepts by name (one user,
   * two writers needed to hit it). `exceptId` lets a rename keep its own name unchanged.
   */
  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const clash = await this.prisma.location.findFirst({
      where: {
        ownerId: LOCAL_OWNER_ID,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true, name: true },
    });
    if (clash) {
      throw new BadRequestException(`a location named "${clash.name}" already exists`);
    }
  }

  async create(dto: CreateLocationDto): Promise<LocationDto> {
    const name = typeof dto?.name === 'string' ? dto.name.trim() : '';
    if (!name) {
      throw new BadRequestException('name is required');
    }
    await this.assertNameFree(name);
    const location = await this.prisma.location.create({
      // The client never sends ownerId; the server stamps it (ADR 0039).
      data: { name, ownerId: LOCAL_OWNER_ID },
    });
    return toLocationDto(location);
  }

  /** Rename. Empty -> 400; a case-insensitive clash -> 400; an id that isn't the owner's -> 404. */
  async update(id: string, dto: UpdateLocationDto): Promise<LocationDto> {
    const name = typeof dto?.name === 'string' ? dto.name.trim() : '';
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const location = await this.prisma.location.findFirst({ where: { id, ownerId: LOCAL_OWNER_ID } });
    if (!location) {
      throw new NotFoundException(`location ${id} not found`);
    }
    await this.assertNameFree(name, id);
    const updated = await this.prisma.location.update({ where: { id: location.id }, data: { name } });
    return toLocationDto(updated);
  }

  /**
   * Delete the location; `onDelete: Cascade` untags every task, which survive (ADR 0061). The
   * warning (which tasks lose their only location) is computed client-side over the full task
   * list — the server just removes the row.
   */
  async remove(id: string): Promise<void> {
    const location = await this.prisma.location.findFirst({
      where: { id, ownerId: LOCAL_OWNER_ID },
      select: { id: true },
    });
    if (!location) {
      throw new NotFoundException(`location ${id} not found`);
    }
    await this.prisma.location.delete({ where: { id: location.id } });
  }

  /**
   * Fold source into target, then delete source — ATOMICALLY (ADR 0061). One transaction, or
   * none of it: a half-move would leave tasks tagged a location that no longer exists, or a
   * source lingering with its tasks already gone. Both ids must be the owner's (400 otherwise),
   * and they must differ.
   */
  async merge(dto: MergeLocationsDto): Promise<LocationDto[]> {
    const sourceId = typeof dto?.sourceId === 'string' ? dto.sourceId : '';
    const targetId = typeof dto?.targetId === 'string' ? dto.targetId : '';
    if (!sourceId || !targetId) {
      throw new BadRequestException('sourceId and targetId are required');
    }
    if (sourceId === targetId) {
      throw new BadRequestException('sourceId and targetId must be different locations');
    }
    // Owner-scoped existence — a body id belonging to another owner reads as "no such location",
    // not a silent success (the leak this test-guards against the day auth lands).
    const [source, target] = await Promise.all([
      this.prisma.location.findFirst({ where: { id: sourceId, ownerId: LOCAL_OWNER_ID }, select: { id: true } }),
      this.prisma.location.findFirst({ where: { id: targetId, ownerId: LOCAL_OWNER_ID }, select: { id: true } }),
    ]);
    if (!source) {
      throw new BadRequestException(`no such location: ${sourceId}`);
    }
    if (!target) {
      throw new BadRequestException(`no such location: ${targetId}`);
    }

    await this.prisma.$transaction(async (tx) => {
      const tagged = await tx.taskLocation.findMany({
        where: { locationId: sourceId },
        select: { taskId: true },
      });
      if (tagged.length > 0) {
        // skipDuplicates makes the BOTH-tagged task correct by construction: a task already
        // tagged target keeps its single link rather than throwing on the duplicate primary key.
        await tx.taskLocation.createMany({
          data: tagged.map(({ taskId }) => ({ taskId, locationId: targetId })),
          skipDuplicates: true,
        });
      }
      await tx.taskLocation.deleteMany({ where: { locationId: sourceId } });
      await tx.location.delete({ where: { id: sourceId } });
    });
    return this.findAll();
  }
}
