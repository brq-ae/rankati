import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { firstHeader, type HttpRequestLike } from './cookie';

/** Reads/idempotent methods never mutate state, so they are not a CSRF concern. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie auth (ADR 0076), by same-origin enforcement. Because the SPA and API share
 * one origin (ADR 0042), a legitimate state-changing request always carries a matching Origin; a
 * forged cross-site request carries a foreign one (browsers always send Origin on such requests). A
 * mismatch is rejected. A request with NO Origin is a non-browser client (curl, a native app, the test
 * runner) — not a CSRF vector, since CSRF depends on a browser silently attaching the session cookie —
 * so it is allowed. SameSite=Lax on the cookie is the belt to this braces.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequestLike>();
    if (SAFE_METHODS.has(req.method)) return true;

    const origin = firstHeader(req.headers.origin);
    if (origin === undefined) return true; // no Origin → not a browser-driven request → not CSRF

    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new ForbiddenException('Malformed Origin.');
    }
    const host = firstHeader(req.headers['x-forwarded-host']) ?? firstHeader(req.headers.host);
    if (originHost !== host) {
      throw new ForbiddenException('Cross-origin state-changing request rejected.');
    }
    return true;
  }
}
