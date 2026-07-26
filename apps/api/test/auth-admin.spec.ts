import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetToFirstRun, unlockAccount } from '../src/auth/admin';
import { hashPassword } from '../src/auth/password';
import { AppModule } from '../src/app.module';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { wipeAccounts } from './_auth';

/**
 * The auth admin commands (ADR 0076) against real Postgres, invoked exactly as the CLI does — the core
 * functions directly. reset-to-first-run must clear the credential while leaving ALL data intact;
 * unlock must clear the lockout so login works again.
 */
const PREFIX = '__authadmin__';

describe('auth admin commands (real Postgres, ADR 0076)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const url = (path: string): string => `/${API_PREFIX}${path}`;

  async function cleanupData(): Promise<void> {
    await wipeAccounts(prisma);
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    prisma = app.get(PrismaService);
  });
  beforeEach(cleanupData);
  afterEach(cleanupData);
  afterAll(async () => {
    await cleanupData();
    await app?.close();
  });

  /** An account with a live session, plus a list + task under the constant owner (the preserved data). */
  async function seedAccountAndData(): Promise<{ accountId: string; taskTitle: string }> {
    const account = await prisma.account.create({
      data: { username: `${PREFIX}orig`, passwordHash: 'placeholder' },
    });
    await prisma.session.create({
      data: { id: randomBytes(16).toString('base64url'), accountId: account.id, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const list = await prisma.list.create({ data: { name: `${PREFIX} L`, ownerId: LOCAL_OWNER_ID } });
    const taskTitle = `${PREFIX} keep me`;
    await prisma.task.create({ data: { title: taskTitle, listId: list.id, ownerId: LOCAL_OWNER_ID } });
    return { accountId: account.id, taskTitle };
  }

  it('reset-to-first-run removes the account and its sessions (needsSetup returns)', async () => {
    await seedAccountAndData();
    expect(await prisma.account.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);

    const { deletedAccounts } = await resetToFirstRun(prisma);
    expect(deletedAccounts).toBe(1);
    expect(await prisma.account.count()).toBe(0); // first-run signal restored
    expect(await prisma.session.count()).toBe(0); // sessions cascaded away
  });

  it('reset-to-first-run PRESERVES data — a fresh account then reads the old tasks', async () => {
    const { taskTitle } = await seedAccountAndData();
    const tasksBefore = await prisma.task.count({ where: { title: { startsWith: PREFIX } } });
    const listsBefore = await prisma.list.count({ where: { name: { startsWith: PREFIX } } });

    await resetToFirstRun(prisma);

    // Data is untouched.
    expect(await prisma.task.count({ where: { title: { startsWith: PREFIX } } })).toBe(tasksBefore);
    expect(await prisma.list.count({ where: { name: { startsWith: PREFIX } } })).toBe(listsBefore);

    // A fresh account is created (setup works again) and sees the preserved data through the API.
    const agent = request.agent(app.getHttpServer());
    await agent.post(url('/auth/setup')).send({ username: 'new-owner', password: 'new-pw-123' }).expect(200);
    const res = await agent.get(url('/tasks')).expect(200);
    const titles = (res.body as { title: string }[]).map((t) => t.title);
    expect(titles).toContain(taskTitle);
  });

  it('unlock clears the lockout so login is no longer blocked', async () => {
    const password = 'unlock-me-pw-9';
    await prisma.account.create({
      data: {
        username: `${PREFIX}locked`,
        passwordHash: await hashPassword(password),
        failedAttempts: 20,
        lockedUntil: new Date(Date.now() + 60 * 60_000), // locked an hour out
      },
    });
    // Locked: even the correct password is refused with 429.
    await request(app.getHttpServer())
      .post(url('/auth/login'))
      .send({ username: `${PREFIX}locked`, password, trusted: false })
      .expect(429);

    const { unlocked } = await unlockAccount(prisma);
    expect(unlocked).toBe(1);

    const account = await prisma.account.findFirstOrThrow();
    expect(account.failedAttempts).toBe(0);
    expect(account.lockedUntil).toBeNull();

    // The same login now succeeds — the lock is gone, the password unchanged.
    await request(app.getHttpServer())
      .post(url('/auth/login'))
      .send({ username: `${PREFIX}locked`, password, trusted: false })
      .expect(200);
  });
});
