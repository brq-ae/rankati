import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { SESSION_COOKIE } from '../src/auth/cookie';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { wipeAccounts } from './_auth';

/**
 * The auth endpoints + the global session guard + CSRF, over real HTTP and Postgres (ADR 0076). Each
 * test starts from a true first run (all accounts wiped), then exercises status / setup / login /
 * logout / the guard / the Origin CSRF check. Setup-closes and the guard are the load-bearing ones.
 */
describe('auth endpoints + session guard (real HTTP, ADR 0076)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const url = (path: string): string => `/${API_PREFIX}${path}`;
  const USER = 'owner';
  const PASS = 'a-good-password-123';

  // Grab the session cookie(s) off a Set-Cookie response so a later request can present them.
  const cookiesOf = (res: request.Response): string[] => {
    const raw = res.headers['set-cookie'];
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
  };
  const sessionCookie = (res: request.Response): string | undefined =>
    cookiesOf(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    prisma = app.get(PrismaService);
  });
  beforeEach(async () => {
    await wipeAccounts(prisma); // a true first run for every test
    await prisma.list.deleteMany({ where: { name: { startsWith: '__authep__' } } });
  });
  afterAll(async () => {
    await wipeAccounts(prisma);
    await app?.close();
  });

  it('status: fresh DB → needsSetup true; after setup → needsSetup false', async () => {
    const fresh = await request(app.getHttpServer()).get(url('/auth/status')).expect(200);
    expect(fresh.body).toEqual({ needsSetup: true, authenticated: false });

    await request(app.getHttpServer()).post(url('/auth/setup')).send({ username: USER, password: PASS }).expect(200);

    const after = await request(app.getHttpServer()).get(url('/auth/status')).expect(200);
    expect(after.body.needsSetup).toBe(false);
  });

  it('setup: stores a HASHED password (never plaintext) and a SECOND setup → 409 (closed forever)', async () => {
    const first = await request(app.getHttpServer())
      .post(url('/auth/setup'))
      .send({ username: USER, password: PASS })
      .expect(200);
    expect(sessionCookie(first)).toBeDefined(); // auto-login sets the cookie

    const account = await prisma.account.findUniqueOrThrow({ where: { username: USER } });
    expect(account.passwordHash).not.toContain(PASS);
    expect(account.passwordHash.startsWith('$argon2id$')).toBe(true);

    await request(app.getHttpServer())
      .post(url('/auth/setup'))
      .send({ username: 'intruder', password: 'another' })
      .expect(409);
    expect(await prisma.account.count()).toBe(1); // no second account created
  });

  it('setup honors trust-this-device: trusted:true → ~30-day Max-Age cookie and a 30-day session expiry', async () => {
    const res = await request(app.getHttpServer())
      .post(url('/auth/setup'))
      .send({ username: USER, password: PASS, trusted: true })
      .expect(200);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(sessionCookie(res) ?? '')?.[1]);
    expect(maxAge).toBeGreaterThan(29 * 86_400); // ~30 days, in seconds
    expect(maxAge).toBeLessThanOrEqual(30 * 86_400);

    const session = await prisma.session.findFirstOrThrow();
    const daysOut = (session.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(29);
    expect(daysOut).toBeLessThanOrEqual(30.1);
  });

  it('setup honors trust-this-device: trusted:false → a session cookie (no Max-Age)', async () => {
    const res = await request(app.getHttpServer())
      .post(url('/auth/setup'))
      .send({ username: USER, password: PASS, trusted: false })
      .expect(200);
    expect(sessionCookie(res) ?? '').not.toMatch(/Max-Age/i);
  });

  it('login: correct creds → 200 + Set-Cookie; Secure follows X-Forwarded-Proto; Max-Age follows trusted', async () => {
    await request(app.getHttpServer()).post(url('/auth/setup')).send({ username: USER, password: PASS }).expect(200);

    // untrusted, plain HTTP → cookie present, HttpOnly, no Secure, no Max-Age (session cookie)
    const untrusted = await request(app.getHttpServer())
      .post(url('/auth/login'))
      .send({ username: USER, password: PASS, trusted: false })
      .expect(200);
    const uCookie = sessionCookie(untrusted) ?? '';
    expect(uCookie).toContain('HttpOnly');
    expect(uCookie).not.toMatch(/Secure/i);
    expect(uCookie).not.toMatch(/Max-Age/i);

    // trusted, X-Forwarded-Proto: https → Secure present, Max-Age present (persistent)
    const trusted = await request(app.getHttpServer())
      .post(url('/auth/login'))
      .set('X-Forwarded-Proto', 'https')
      .send({ username: USER, password: PASS, trusted: true })
      .expect(200);
    const tCookie = sessionCookie(trusted) ?? '';
    expect(tCookie).toMatch(/Secure/i);
    expect(tCookie).toMatch(/Max-Age/i);
  });

  it('login: wrong password → 401, no cookie', async () => {
    await request(app.getHttpServer()).post(url('/auth/setup')).send({ username: USER, password: PASS }).expect(200);
    const res = await request(app.getHttpServer())
      .post(url('/auth/login'))
      .send({ username: USER, password: 'wrong', trusted: false })
      .expect(401);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('login: username is CASE-INSENSITIVE — every case variant + correct password → 200 (ADR 0080)', async () => {
    await request(app.getHttpServer()).post(url('/auth/setup')).send({ username: 'testuser', password: PASS }).expect(200);
    for (const variant of ['testuser', 'Testuser', 'TESTUSER']) {
      await request(app.getHttpServer())
        .post(url('/auth/login'))
        .send({ username: variant, password: PASS, trusted: false })
        .expect(200);
    }
  });

  it('login: correct-case username + WRONG password → 401 (the password is still enforced)', async () => {
    await request(app.getHttpServer()).post(url('/auth/setup')).send({ username: 'testuser', password: PASS }).expect(200);
    await request(app.getHttpServer())
      .post(url('/auth/login'))
      .send({ username: 'testuser', password: 'not-the-password', trusted: false })
      .expect(401);
  });

  it('login: a genuinely DIFFERENT username (not a case variant) + correct password → 401, and it counts toward the lockout', async () => {
    await request(app.getHttpServer()).post(url('/auth/setup')).send({ username: 'testuser', password: PASS }).expect(200);
    await request(app.getHttpServer())
      .post(url('/auth/login'))
      .send({ username: 'someone-else', password: PASS, trusted: false })
      .expect(401);
    // findFirst() still fetched the one account, so the failed attempt is counted (lockout intact).
    expect((await prisma.account.findFirstOrThrow()).failedAttempts).toBe(1);
  });

  it('login: the stored username keeps its ORIGINAL case — only the comparison normalizes (ADR 0080)', async () => {
    await request(app.getHttpServer()).post(url('/auth/setup')).send({ username: 'TestUser', password: PASS }).expect(200);
    // Stored exactly as entered, NOT lowercased.
    expect((await prisma.account.findFirstOrThrow()).username).toBe('TestUser');
    // ...and a lowercase login still matches it (case-insensitive both directions).
    await request(app.getHttpServer())
      .post(url('/auth/login'))
      .send({ username: 'testuser', password: PASS, trusted: false })
      .expect(200);
  });

  it('guard: /api/tasks needs a session — 401 without, 200 with; /api/health stays public', async () => {
    await request(app.getHttpServer()).post(url('/auth/setup')).send({ username: USER, password: PASS }).expect(200);

    // No session → 401.
    await request(app.getHttpServer()).get(url('/tasks')).expect(401);

    // Health is public regardless.
    await request(app.getHttpServer()).get(url('/health')).expect(200);

    // With a session (via the logged-in agent) → 200.
    const agent = request.agent(app.getHttpServer());
    await agent.post(url('/auth/login')).send({ username: USER, password: PASS, trusted: true }).expect(200);
    await agent.get(url('/tasks')).expect(200);
  });

  it('logout: after logout the same cookie is revoked → 401', async () => {
    await request(app.getHttpServer()).post(url('/auth/setup')).send({ username: USER, password: PASS }).expect(200);
    const agent = request.agent(app.getHttpServer());
    await agent.post(url('/auth/login')).send({ username: USER, password: PASS, trusted: true }).expect(200);
    await agent.get(url('/tasks')).expect(200); // proves the session works first

    await agent.post(url('/auth/logout')).expect(200);
    await agent.get(url('/tasks')).expect(401); // the row is deleted → the cookie is now worthless
  });

  it('csrf: a state-changing request from a foreign Origin is rejected (403); same-origin passes', async () => {
    await request(app.getHttpServer()).post(url('/auth/setup')).send({ username: USER, password: PASS }).expect(200);
    const agent = request.agent(app.getHttpServer());
    await agent.post(url('/auth/login')).send({ username: USER, password: PASS, trusted: true }).expect(200);

    const list = await prisma.list.create({ data: { name: '__authep__ csrf', ownerId: LOCAL_OWNER_ID } });

    // Foreign Origin (host mismatch) → blocked before it can mutate.
    await agent
      .post(url('/tasks'))
      .set('Origin', 'https://evil.example.com')
      .send({ title: 'x', listId: list.id })
      .expect(403);

    // Matching Origin → allowed (201). Host defaults to 127.0.0.1:<port> under supertest.
    const created = await agent
      .post(url('/tasks'))
      .set('Origin', 'http://127.0.0.1')
      .set('X-Forwarded-Host', '127.0.0.1')
      .send({ title: '__authep__ ok', listId: list.id })
      .expect(201);
    await prisma.task.delete({ where: { id: created.body.id } });
    await prisma.list.delete({ where: { id: list.id } });
  });
});
