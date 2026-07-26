import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { CLOCK } from '../src/auth/clock';
import { API_PREFIX } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { wipeAccounts } from './_auth';

/**
 * The escalating brute-force lockout wired into login (ADR 0076), proven by ADVANCING an injected fake
 * clock — never by waiting. Every scenario runs against real HTTP + Postgres, on the single account.
 *
 * The load-bearing rule: a CORRECT password during a lockout still fails (429). Locked is locked.
 */
const BASE_MS = Date.UTC(2026, 7, 1, 12, 0, 0);
let nowMs = BASE_MS;
const clock = { now: (): Date => new Date(nowMs) };
const advance = (ms: number): void => {
  nowMs += ms;
};

describe('login lockout (real HTTP, injected clock, ADR 0076)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const url = (path: string): string => `/${API_PREFIX}${path}`;
  const USER = 'owner';
  const PASS = 'the-right-password-1';

  const wrong = () => request(app.getHttpServer()).post(url('/auth/login')).send({ username: USER, password: 'nope' });
  const right = () =>
    request(app.getHttpServer()).post(url('/auth/login')).send({ username: USER, password: PASS, trusted: false });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    prisma = app.get(PrismaService);
  });
  beforeEach(async () => {
    nowMs = BASE_MS;
    await wipeAccounts(prisma);
    await request(app.getHttpServer()).post(url('/auth/setup')).send({ username: USER, password: PASS }).expect(200);
  });
  afterAll(async () => {
    await wipeAccounts(prisma);
    await app?.close();
  });

  it('attempts 1–4 wrong → 401, not locked', async () => {
    for (let i = 1; i <= 4; i++) await wrong().expect(401);
  });

  it('the 5th wrong locks (429 ~1min); a CORRECT password while locked STILL fails (429, unchecked)', async () => {
    for (let i = 1; i <= 4; i++) await wrong().expect(401);
    const locked = await wrong().expect(429);
    expect(Number(locked.headers['retry-after'])).toBe(60); // exactly one minute (fake clock is still)

    // The key rule: right password, but locked → 429, and the counter did NOT advance past 5.
    await right().expect(429);
    const account = await prisma.account.findFirstOrThrow();
    expect(account.failedAttempts).toBe(5);
  });

  it('escalates 5→1m, 10→5m, 15→1h, 20→1d, 25→1d (capped), advancing the clock each tier', async () => {
    const tiers = [
      { at: 5, secs: 60 },
      { at: 10, secs: 5 * 60 },
      { at: 15, secs: 60 * 60 },
      { at: 20, secs: 24 * 60 * 60 },
      { at: 25, secs: 24 * 60 * 60 }, // the cap holds
    ];
    let done = 0;
    for (const tier of tiers) {
      while (done < tier.at - 1) {
        await wrong().expect(401); // below the tier boundary
        done++;
      }
      const res = await wrong().expect(429); // the boundary attempt locks
      done++;
      expect(Number(res.headers['retry-after'])).toBe(tier.secs);
      advance(tier.secs * 1000 + 1000); // step past this lock so the next tier's attempts are allowed
    }
  });

  it('a correct login in an unlocked window resets the counter — the tier restarts from zero', async () => {
    await wrong().expect(401);
    await wrong().expect(401);
    await wrong().expect(401); // 3 failures banked
    await right().expect(200); // correct → reset

    // Four more wrongs are all 401 (not 429): the counter restarted, so the 5th is what locks.
    for (let i = 1; i <= 4; i++) await wrong().expect(401);
    await wrong().expect(429); // the fresh 5th
  });

  it('the locked state is persisted — re-reading the account row still shows it locked', async () => {
    for (let i = 1; i <= 5; i++) await wrong().expect(i === 5 ? 429 : 401);
    const account = await prisma.account.findFirstOrThrow();
    expect(account.failedAttempts).toBe(5);
    expect(account.lockedUntil).not.toBeNull();
    expect((account.lockedUntil as Date).getTime()).toBe(nowMs + 60_000); // now + 1 minute, from the DB
  });
});
