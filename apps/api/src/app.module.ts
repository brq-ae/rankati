import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { resolve } from 'node:path';
import { ArenaSessionService } from './arena/arena-session.service';
import { AccountController } from './auth/account.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CLOCK, SystemClock } from './auth/clock';
import { CsrfGuard } from './auth/csrf.guard';
import { LockedExceptionFilter } from './auth/locked.exception';
import { SessionGuard } from './auth/session.guard';
import { ClientErrorController } from './client-error.controller';
import { CLIENT_ERROR_LIMITER, RateLimiter } from './client-error.ratelimit';
import { DuelSessionsController } from './arena/duel-sessions.controller';
import { ChecklistController } from './checklist/checklist.controller';
import { ChecklistService } from './checklist/checklist.service';
import { HealthController } from './health.controller';
import { ListsController } from './lists.controller';
import { ListsService } from './lists.service';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { PrismaService } from './prisma.service';
import { ResetController } from './reset.controller';
import { ResetService } from './reset.service';
import { RoutinesController } from './routines/routines.controller';
import { RoutinesService } from './routines/routines.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // The one root .env, resolved from this file rather than cwd (ADR 0042).
      // In the container it is absent and Compose supplies the environment directly,
      // so loading is skipped rather than failing (ADR 0036).
      envFilePath: resolve(__dirname, '../../../.env'),
      ignoreEnvFile: process.env.NODE_ENV === 'production',
    }),
  ],
  controllers: [
    AuthController,
    AccountController,
    ClientErrorController,
    HealthController,
    ListsController,
    LocationsController,
    TasksController,
    DuelSessionsController,
    ResetController,
    RoutinesController,
    ChecklistController,
  ],
  providers: [
    PrismaService,
    AuthService,
    { provide: CLOCK, useClass: SystemClock },
    // Emits Retry-After on the 429 when a login hits the escalating lockout (ADR 0076).
    { provide: APP_FILTER, useClass: LockedExceptionFilter },
    // The public client-error endpoint's flood backstop (ADR 0078): a modest per-IP cap.
    { provide: CLIENT_ERROR_LIMITER, useValue: new RateLimiter(30, 60_000) },
    ListsService,
    LocationsService,
    TasksService,
    ArenaSessionService,
    ResetService,
    RoutinesService,
    ChecklistService,
    // Global guards (ADR 0076). CSRF runs first — a forged cross-origin mutation is rejected before
    // any session work — then the session gate puts every non-@Public route behind a valid session.
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
