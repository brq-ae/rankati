import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import type { ResetRequestDto } from '@rankati/shared';
import { ResetService } from './reset.service';
import type { ResetSummary } from './reset-core';

/**
 * Served at /api/reset (ADR 0064). The GUARD lives here, at the HTTP boundary: the endpoint refuses
 * without `confirm: "DELETE"`, the machine floor beneath the UI's typed-DELETE box. Two independent
 * defences — a UI can be bypassed, a `curl` can be typo'd — so the check is enforced server-side and
 * not only in the client. The mode is validated too: an unknown mode is a 400, never a silent no-op.
 */
@Controller('reset')
export class ResetController {
  constructor(private readonly reset: ResetService) {}

  @Post()
  run(@Body() dto: ResetRequestDto): Promise<ResetSummary> {
    if (dto?.confirm !== 'DELETE') {
      throw new BadRequestException('confirm must be the literal "DELETE"');
    }
    if (dto.mode !== 'clear-tasks' && dto.mode !== 'factory') {
      throw new BadRequestException('mode must be "clear-tasks" or "factory"');
    }
    return this.reset.run(dto.mode, { keepSampleData: dto.keepSampleData });
  }
}
