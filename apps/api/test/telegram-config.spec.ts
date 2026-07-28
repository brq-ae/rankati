import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TelegramConfigDto } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { TelegramConfigService } from '../src/telegram/telegram-config.service';

/**
 * Step 2 of the Telegram milestone (ADR 0084): the config store + the authed Settings endpoints. No
 * transport yet. The load-bearing guardrail: the raw token is NEVER returned to a client — only "••••1234".
 */
const RAW_TOKEN = '987654321:AAG-demo-token_abcdefghijklmnop1234';

describe('Telegram config endpoints (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let config: TelegramConfigService;
  const url = (path: string) => `/${API_PREFIX}${path}`;

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
      config = app.get(TelegramConfigService);
    }
    await prisma.telegramConfig.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
  });

  afterAll(async () => {
    await prisma.telegramConfig.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
    await app?.close();
  });

  it('GET config lazily creates a single row with the defaults', async () => {
    const res = await agent.get(url('/telegram/config')).expect(200);
    const dto = res.body as TelegramConfigDto;
    expect(dto).toMatchObject({
      configured: false,
      tokenMask: null,
      bound: false,
      boundChatId: null,
      linkCode: null,
      digestEnabled: false,
      digestTime: '08:00',
      timezone: null,
    });
    expect(await prisma.telegramConfig.count({ where: { ownerId: LOCAL_OWNER_ID } })).toBe(1);
  });

  it('PUT token stores it, returns ONLY the mask, and issues a link code — never the raw token', async () => {
    const res = await agent.put(url('/telegram/token')).send({ token: RAW_TOKEN }).expect(200);
    const dto = res.body as TelegramConfigDto;
    expect(dto.configured).toBe(true);
    expect(dto.tokenMask).toBe('••••1234');
    expect(dto.linkCode).toMatch(/^[A-Z2-9]{8}$/);
    // The raw token must appear NOWHERE in the response.
    expect(JSON.stringify(res.body)).not.toContain(RAW_TOKEN);

    // ...and GET never leaks it either, though it IS stored.
    const got = await agent.get(url('/telegram/config')).expect(200);
    expect(JSON.stringify(got.body)).not.toContain(RAW_TOKEN);
    expect((got.body as TelegramConfigDto).tokenMask).toBe('••••1234');
    expect((await prisma.telegramConfig.findFirstOrThrow()).botToken).toBe(RAW_TOKEN); // stored raw
  });

  it('DELETE token clears it and unbinds (disables the bot)', async () => {
    await agent.put(url('/telegram/token')).send({ token: RAW_TOKEN }).expect(200);
    const res = await agent.delete(url('/telegram/token')).expect(200);
    const dto = res.body as TelegramConfigDto;
    expect(dto.configured).toBe(false);
    expect(dto.tokenMask).toBeNull();
    expect(dto.linkCode).toBeNull();
    expect((await prisma.telegramConfig.findFirstOrThrow()).botToken).toBeNull();
  });

  it('bindChat: the current code binds the chat, case-insensitive + trimmed, and CONSUMES the code', async () => {
    const dto = (await agent.put(url('/telegram/token')).send({ token: RAW_TOKEN }).expect(200))
      .body as TelegramConfigDto;
    const code = dto.linkCode as string;
    expect(code).toMatch(/^[A-Z2-9]{8}$/);

    // sent lowercased with surrounding whitespace — still binds
    expect(await config.bindChat('98765', `  ${code.toLowerCase()}  `)).toBe('bound');
    const row = await prisma.telegramConfig.findFirstOrThrow();
    expect(row.boundChatId).toBe('98765');
    expect(row.linkCode).toBeNull(); // one-time: consumed

    // a second chat cannot reuse the consumed code, and the original binding stands
    expect(await config.bindChat('11111', code)).toBe('bad-code');
    expect((await prisma.telegramConfig.findFirstOrThrow()).boundChatId).toBe('98765');
  });

  it('bindChat: a wrong code does not bind', async () => {
    await agent.put(url('/telegram/token')).send({ token: RAW_TOKEN }).expect(200);
    expect(await config.bindChat('98765', 'WRONGXYZ')).toBe('bad-code');
    expect((await prisma.telegramConfig.findFirstOrThrow()).boundChatId).toBeNull();
  });

  it('bindChat: no active code → no-code (nothing to match)', async () => {
    await agent.put(url('/telegram/token')).send({ token: RAW_TOKEN }).expect(200);
    await prisma.telegramConfig.updateMany({ where: { ownerId: LOCAL_OWNER_ID }, data: { linkCode: null } });
    expect(await config.bindChat('98765', 'ANYTHING')).toBe('no-code');
  });

  it('getBinding reflects the stored binding + active code', async () => {
    const dto = (await agent.put(url('/telegram/token')).send({ token: RAW_TOKEN }).expect(200))
      .body as TelegramConfigDto;
    expect(await config.getBinding()).toEqual({ boundChatId: null, linkCode: dto.linkCode });
    await config.bindChat('42', dto.linkCode as string);
    expect(await config.getBinding()).toEqual({ boundChatId: '42', linkCode: null });
  });

  it('PUT token rejects a non-token string (400)', async () => {
    await agent.put(url('/telegram/token')).send({ token: 'not-a-token' }).expect(400);
    await agent.put(url('/telegram/token')).send({ token: '' }).expect(400);
  });

  it('POST link-code needs a token, then rotates the code', async () => {
    await agent.post(url('/telegram/link-code')).expect(400); // no token yet
    await agent.put(url('/telegram/token')).send({ token: RAW_TOKEN }).expect(200);
    const first = (await agent.get(url('/telegram/config')).expect(200)).body as TelegramConfigDto;
    const second = (await agent.post(url('/telegram/link-code')).expect(200)).body as TelegramConfigDto;
    expect(second.linkCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(second.linkCode).not.toBe(first.linkCode);
  });

  it('POST unlink clears the bound chat', async () => {
    await agent.put(url('/telegram/token')).send({ token: RAW_TOKEN }).expect(200);
    await prisma.telegramConfig.updateMany({ where: { ownerId: LOCAL_OWNER_ID }, data: { boundChatId: '55501' } });
    expect((await agent.get(url('/telegram/config'))).body.bound).toBe(true);
    const res = await agent.post(url('/telegram/unlink')).expect(200);
    const dto = res.body as TelegramConfigDto;
    expect(dto.bound).toBe(false);
    expect(dto.boundChatId).toBeNull();
    expect(dto.linkCode).toMatch(/^[A-Z2-9]{8}$/); // a fresh code so a new chat can bind
  });

  it('PUT digest stores enabled/time/timezone and validates them', async () => {
    const ok = await agent
      .put(url('/telegram/digest'))
      .send({ enabled: true, time: '09:30', timezone: 'Asia/Dubai' })
      .expect(200);
    expect(ok.body).toMatchObject({ digestEnabled: true, digestTime: '09:30', timezone: 'Asia/Dubai' });

    await agent.put(url('/telegram/digest')).send({ enabled: false, time: '25:61', timezone: null }).expect(400);
    await agent.put(url('/telegram/digest')).send({ enabled: false, time: '08:00', timezone: 'Nowhere/Nope' }).expect(400);
    // enabling without a timezone is refused — the scheduler needs one (ADR 0084)
    await agent.put(url('/telegram/digest')).send({ enabled: true, time: '08:00', timezone: null }).expect(400);
  });

  it('getDigestState + markDigestSent round-trip the fire-once guard', async () => {
    await agent
      .put(url('/telegram/digest'))
      .send({ enabled: true, time: '08:00', timezone: 'Asia/Dubai' })
      .expect(200);
    const s0 = await config.getDigestState();
    expect(s0).toMatchObject({ enabled: true, time: '08:00', timezone: 'Asia/Dubai', lastSentOn: null });

    await config.markDigestSent('2026-07-27');
    expect((await config.getDigestState()).lastSentOn).toBe('2026-07-27');
    // the guard is never exposed to a client — the masked DTO has no such field
    const dto = (await agent.get(url('/telegram/config')).expect(200)).body as Record<string, unknown>;
    expect('lastDigestSentOn' in dto).toBe(false);
    expect('lastSentOn' in dto).toBe(false);
  });

  it('GET status is behind auth and reports the poller health', async () => {
    await request(app.getHttpServer()).get(url('/telegram/status')).expect(401);
    const res = await agent.get(url('/telegram/status')).expect(200);
    expect(['running', 'error', 'stopped']).toContain((res.body as { status: string }).status);
  });

  it('every endpoint is behind the session guard (401 without a session)', async () => {
    const anon = request(app.getHttpServer());
    await anon.get(url('/telegram/config')).expect(401);
    await anon.get(url('/telegram/status')).expect(401);
    await anon.put(url('/telegram/token')).send({ token: RAW_TOKEN }).expect(401);
    await anon.post(url('/telegram/unlink')).expect(401);
  });
});
