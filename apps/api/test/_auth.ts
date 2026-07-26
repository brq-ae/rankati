import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API_PREFIX } from '../src/constants';
import type { PrismaService } from '../src/prisma.service';

/**
 * Shared login helper for the integration tests (ADR 0076). Now that every route sits behind the
 * global session guard, a test that hits a protected route must present a valid session. This returns
 * a supertest *agent* whose cookie jar already holds the session cookie, so callers just swap
 * `request(app.getHttpServer())` for this agent and every request rides authenticated — no per-call
 * cookie plumbing.
 *
 * It creates the single account on first use (setup) and logs in on subsequent files (setup is closed
 * → 409 → login). The auth-specific specs, which assert on account emptiness, wipe accounts in their
 * own hooks, so they do not depend on this shared account's presence.
 */
const TEST_USER = '__deck_test__';
const TEST_PASS = 'test-password-8f3a2b';

export type AuthedAgent = ReturnType<typeof request.agent>;

export async function loginAgent(app: INestApplication): Promise<AuthedAgent> {
  const agent = request.agent(app.getHttpServer());
  const url = (path: string): string => `/${API_PREFIX}${path}`;

  const setup = await agent.post(url('/auth/setup')).send({ username: TEST_USER, password: TEST_PASS });
  if (setup.status !== 200) {
    // Account already exists (setup is closed, 409) → log in to seed the agent's session cookie.
    await agent.post(url('/auth/login')).send({ username: TEST_USER, password: TEST_PASS, trusted: true });
  }
  return agent;
}

/** Remove every account (cascading its sessions) — used by the auth specs to reach a true first-run. */
export async function wipeAccounts(prisma: PrismaService): Promise<void> {
  await prisma.account.deleteMany({});
}
