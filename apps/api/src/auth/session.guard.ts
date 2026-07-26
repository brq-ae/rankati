import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { type HttpRequestLike, readSessionToken } from './cookie';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * The global gate (ADR 0076): EVERY route requires a valid session, except those marked @Public (the
 * auth endpoints and /api/health). It only asserts "a valid session exists" — it does not touch owner
 * scoping, which stays constant for the single user (ADR 0026/0039).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<HttpRequestLike>();
    const session = await this.auth.validateSession(readSessionToken(req));
    if (session === null) throw new UnauthorizedException();
    return true;
  }
}
