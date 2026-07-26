import { Injectable } from '@nestjs/common';
import { LOCAL_OWNER_ID } from './constants';
import { PrismaService } from './prisma.service';
import { resetOwner, type ResetOptions, type ResetSummary } from './reset-core';
import type { ResetMode } from '@rankati/shared';

/**
 * The reset endpoint's thin server wrapper (ADR 0064). The destructive logic lives in `resetOwner`
 * (reset-core.ts), shared with the `--wipe` CLI; this only binds it to the single local owner and
 * to Nest DI. The `confirm: "DELETE"` guard lives in the CONTROLLER, before this is ever reached —
 * this method assumes the request already cleared it.
 */
@Injectable()
export class ResetService {
  constructor(private readonly prisma: PrismaService) {}

  run(mode: ResetMode, opts: ResetOptions): Promise<ResetSummary> {
    return resetOwner(this.prisma, LOCAL_OWNER_ID, mode, opts);
  }
}
