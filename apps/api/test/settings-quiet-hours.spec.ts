import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { QuietHours } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { loginAgent } from './_auth';

/**
 * The global quiet-hours endpoints (ADR 0091) — GET/PUT /settings/quiet-hours on the Settings singleton,
 * behind the global session guard + CSRF like the pin endpoints. Both null = off; a window is both-or-
 * neither and strict HH:MM, else a clean 400 (an ambiguous window would silently mis-mute Telegram push).
 */
describe('Quiet-hours endpoints (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  const url = (p: string) => `/${API_PREFIX}${p}`;

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
    }
    await prisma.settings.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
  });

  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
    await app?.close();
  });

  it('GET returns off (both null) by default', async () => {
    const res = await agent.get(url('/settings/quiet-hours')).expect(200);
    expect(res.body as QuietHours).toEqual({ start: null, end: null });
  });

  it('PUT a window round-trips (start + end), including a midnight-wrap window', async () => {
    const put = await agent.put(url('/settings/quiet-hours')).send({ start: '22:00', end: '08:00' }).expect(200);
    expect(put.body as QuietHours).toEqual({ start: '22:00', end: '08:00' });
    const get = await agent.get(url('/settings/quiet-hours')).expect(200);
    expect(get.body as QuietHours).toEqual({ start: '22:00', end: '08:00' });
  });

  it('PUT both null clears it to off', async () => {
    await agent.put(url('/settings/quiet-hours')).send({ start: '22:00', end: '08:00' }).expect(200);
    const off = await agent.put(url('/settings/quiet-hours')).send({ start: null, end: null }).expect(200);
    expect(off.body as QuietHours).toEqual({ start: null, end: null });
  });

  it('PUT one-set-one-null is a 400 (both-or-neither), and does not partially save', async () => {
    await agent.put(url('/settings/quiet-hours')).send({ start: '22:00', end: null }).expect(400);
    await agent.put(url('/settings/quiet-hours')).send({ start: null, end: '08:00' }).expect(400);
    // nothing stuck
    expect((await agent.get(url('/settings/quiet-hours')).expect(200)).body as QuietHours).toEqual({
      start: null,
      end: null,
    });
  });

  it('PUT a malformed time is a 400 (strict HH:MM)', async () => {
    for (const bad of [
      { start: '25:00', end: '08:00' },
      { start: '22:00', end: '8:5' },
      { start: '', end: '08:00' },
      { start: '22:00', end: '23:60' },
      { start: 1320, end: 480 },
    ]) {
      await agent.put(url('/settings/quiet-hours')).send(bad).expect(400);
    }
  });

  it('start == end is accepted (a zero-width window = effectively off)', async () => {
    const res = await agent.put(url('/settings/quiet-hours')).send({ start: '09:00', end: '09:00' }).expect(200);
    expect(res.body as QuietHours).toEqual({ start: '09:00', end: '09:00' });
  });
});
