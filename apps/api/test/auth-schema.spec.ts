import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

/**
 * The auth tables (ADR 0076), against real Postgres: the Account's EXISTENCE is the first-run signal
 * (zero rows), and a Session round-trips and is revocable (a deleted row is gone). Test accounts use a
 * `__authtest__` username prefix and are cleaned up, so the real DB's first-run state is not disturbed.
 */
const PREFIX = '__authtest__';

describe('auth schema (real Postgres, ADR 0076)', () => {
  let app: Awaited<ReturnType<typeof build>>['app'];
  let prisma: PrismaService;

  async function build() {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = m.createNestApplication();
    await app.init();
    return { app, prisma: app.get(PrismaService) };
  }
  async function cleanup() {
    // Wipe ALL accounts (cascading sessions) — other suites' shared login account would otherwise
    // leave the table non-empty and break the first-run (zero-rows) assertion. Files run serially.
    await prisma.account.deleteMany({});
  }

  beforeAll(async () => {
    ({ app, prisma } = await build());
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  it('first-run signal: a fresh DB has ZERO Account rows', async () => {
    // Nothing has claimed the single account yet (auth is unbuilt), and test accounts are cleaned up.
    expect(await prisma.account.count()).toBe(0);
  });

  it('a session round-trips, and a deleted session is gone (revocable)', async () => {
    const account = await prisma.account.create({
      data: { username: `${PREFIX}alice`, passwordHash: 'placeholder' },
    });
    const token = randomBytes(32).toString('base64url'); // the opaque cookie value
    const created = await prisma.session.create({
      data: {
        id: token,
        accountId: account.id,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        trusted: true,
      },
    });
    // Round-trips by its token id.
    const back = await prisma.session.findUnique({ where: { id: token } });
    expect(back?.accountId).toBe(account.id);
    expect(back?.trusted).toBe(true);

    // Revoke = delete the row → gone.
    await prisma.session.delete({ where: { id: token } });
    expect(await prisma.session.findUnique({ where: { id: token } })).toBeNull();
    expect(created.id).toBe(token);
  });

  it('username is unique — the single account cannot be duplicated', async () => {
    await prisma.account.create({ data: { username: `${PREFIX}solo`, passwordHash: 'h' } });
    await expect(
      prisma.account.create({ data: { username: `${PREFIX}solo`, passwordHash: 'h2' } }),
    ).rejects.toThrow();
  });
});
