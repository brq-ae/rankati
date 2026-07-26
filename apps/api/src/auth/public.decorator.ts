import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route (or a whole controller) as PUBLIC — the global session guard lets it through without a
 * session (ADR 0076). Used on the auth endpoints (you cannot have a session before you log in) and on
 * /api/health (the smoke test and the proxy health-check must reach it unauthenticated).
 */
export const IS_PUBLIC_KEY = 'deck:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
