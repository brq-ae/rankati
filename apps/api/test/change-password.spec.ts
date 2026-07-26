import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { API_PREFIX } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { wipeAccounts } from './_auth';

/**
 * Change password (ADR 0076), over real HTTP + Postgres. The two load-bearing rules: a wrong current
 * password changes nothing (401), and a correct change revokes every OTHER session while the caller's
 * own session survives — you stay logged in here, every other device is logged out.
 */
describe('change password (real HTTP, ADR 0076)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const url = (path: string): string => `/${API_PREFIX}${path}`;
  const USER = 'owner';
  const PASS = 'current-pw-123';
  const NEW = 'brand-new-pw-456';

  /** A fresh account + a logged-in agent (the "current" session, via setup auto-login). */
  async function freshSession(): Promise<ReturnType<typeof request.agent>> {
    const agent = request.agent(app.getHttpServer());
    await agent.post(url('/auth/setup')).send({ username: USER, password: PASS, trusted: true }).expect(200);
    return agent;
  }
  const loginWith = async (password: string): Promise<number> => {
    const res = await request(app.getHttpServer()).post(url('/auth/login')).send({ username: USER, password, trusted: false });
    return res.status;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    prisma = app.get(PrismaService);
  });
  beforeEach(() => wipeAccounts(prisma));
  afterAll(async () => {
    await wipeAccounts(prisma);
    await app?.close();
  });

  it('correct current → 200; old password stops working, new works; other sessions revoked, current survives', async () => {
    const current = await freshSession();
    const other = request.agent(app.getHttpServer());
    await other.post(url('/auth/login')).send({ username: USER, password: PASS, trusted: true }).expect(200);
    await other.get(url('/tasks')).expect(200); // the second device works before the change

    await current
      .post(url('/auth/change-password'))
      .send({ currentPassword: PASS, newPassword: NEW })
      .expect(200);

    // The password actually changed.
    expect(await loginWith(PASS)).toBe(401); // old no longer verifies
    expect(await loginWith(NEW)).toBe(200); // new does

    // Sessions: the caller's own survives; every other one is revoked.
    await current.get(url('/tasks')).expect(200);
    await other.get(url('/tasks')).expect(401);
  });

  it('wrong current → 401, password unchanged, sessions untouched', async () => {
    const current = await freshSession();
    const other = request.agent(app.getHttpServer());
    await other.post(url('/auth/login')).send({ username: USER, password: PASS, trusted: true }).expect(200);

    await current
      .post(url('/auth/change-password'))
      .send({ currentPassword: 'not-the-password', newPassword: NEW })
      .expect(401);

    // Unchanged: original still works, the "new" one never took.
    expect(await loginWith(PASS)).toBe(200);
    expect(await loginWith(NEW)).toBe(401);

    // Both sessions untouched.
    await current.get(url('/tasks')).expect(200);
    await other.get(url('/tasks')).expect(200);
  });

  it('unauthenticated (no session) → 401 (it is behind the guard)', async () => {
    await freshSession(); // an account exists, but this request carries no session cookie
    await request(app.getHttpServer())
      .post(url('/auth/change-password'))
      .send({ currentPassword: PASS, newPassword: NEW })
      .expect(401);
  });
});
