import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import type { CreateLocationDto, Location, MergeLocationsDto, UpdateLocationDto } from '@rankati/shared';
import { LocationsService } from './locations.service';

/** Served at /api/locations — the global prefix applies everywhere (ADR 0042). */
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  findAll(): Promise<Location[]> {
    return this.locations.findAll();
  }

  /**
   * Fold one location into another and delete the source (ADR 0061). Declared BEFORE the `:id`
   * routes so `merge` is never mistaken for a location id — the same ordering discipline the
   * tasks controller uses for `today`/`upcoming`.
   */
  @Post('merge')
  merge(@Body() dto: MergeLocationsDto): Promise<Location[]> {
    return this.locations.merge(dto);
  }

  @Post()
  create(@Body() dto: CreateLocationDto): Promise<Location> {
    return this.locations.create(dto);
  }

  /** Rename. Empty name or a case-insensitive clash -> 400; unknown id -> 404. */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateLocationDto): Promise<Location> {
    return this.locations.update(id, dto);
  }

  /** Delete and untag (cascade). 204, no body. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.locations.remove(id);
  }
}
