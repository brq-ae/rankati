import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator';
import { PrismaService } from './prisma.service';

/**
 * Served at /api/health — the global prefix applies with no exceptions (ADR 0042). @Public so the
 * smoke test and the reverse-proxy health-check reach it without a session (ADR 0076).
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<{ status: string; database: string }> {
    // A health check that never touches the database would report "ok" while the
    // walking skeleton's whole point — reaching Postgres — is broken.
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', database: 'up' };
  }
}
