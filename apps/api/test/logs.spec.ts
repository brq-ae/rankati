import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Log } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { loginAgent } from './_auth';

/**
 * The Logs endpoints (ADR 0087) — pull-based cadence trackers. Behind the global session guard + CSRF,
 * like the rest of the authed API. Covers CRUD + did + undo, server-derived stats against the client's
 * local day `on`, idempotent same-day did (@@unique, no 500), the <2-entry null average, cascade delete,
 * owner-scoped 404s, and the 401-without-session guard on every route.
 */
describe('Logs endpoints (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  const url = (p: string) => `/${API_PREFIX}${p}`;
  const ON = '2026-03-20';
  const make = (name: string) => agent.post(url('/logs')).send({ name });

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
    }
    await prisma.log.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } }); // cascades entries
  });

  afterAll(async () => {
    await prisma.log.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
    await app?.close();
  });

  it('POST /logs creates a Log with empty stats and no occurrences', async () => {
    const res = await make('Haircut').expect(201);
    const log = res.body as Log;
    expect(log.name).toBe('Haircut');
    expect(log.stats).toEqual({ lastDoneOn: null, count: 0, averageGapDays: null, currentGapDays: null });
    expect(log.entries).toEqual([]);
  });

  it('POST /logs trims and rejects a blank name', async () => {
    expect(((await make('  Nails  ').expect(201)).body as Log).name).toBe('Nails');
    await make('   ').expect(400);
  });

  it('GET /logs?on= lists the owner logs with stats (no full history)', async () => {
    await make('Haircut').expect(201);
    await make('Pedicure').expect(201);
    const res = await agent.get(url('/logs')).query({ on: ON }).expect(200);
    const logs = res.body as Log[];
    expect(logs.map((l) => l.name).sort()).toEqual(['Haircut', 'Pedicure']);
    expect(logs[0]).toHaveProperty('stats');
    expect(logs[0]).not.toHaveProperty('entries'); // list is light
  });

  it('POST /logs/:id/did stamps the day; a single occurrence has NO average (<2)', async () => {
    const id = ((await make('Haircut').expect(201)).body as Log).id;
    const res = await agent.post(url(`/logs/${id}/did`)).send({ on: ON }).expect(201);
    const log = res.body as Log;
    expect(log.stats).toMatchObject({ lastDoneOn: ON, count: 1, averageGapDays: null, currentGapDays: 0 });
    expect(log.entries).toHaveLength(1);
    expect(log.entries?.[0].doneOn).toBe(ON);
  });

  it('did is idempotent per day — a second tap on the same day is a no-op success, not a 500', async () => {
    const id = ((await make('Haircut').expect(201)).body as Log).id;
    await agent.post(url(`/logs/${id}/did`)).send({ on: ON }).expect(201);
    const res = await agent.post(url(`/logs/${id}/did`)).send({ on: ON }).expect(201);
    expect((res.body as Log).stats.count).toBe(1); // still one occurrence
  });

  it('two occurrences → count 2 and the average gap (against `on`)', async () => {
    const id = ((await make('Haircut').expect(201)).body as Log).id;
    await agent.post(url(`/logs/${id}/did`)).send({ on: '2026-03-01' }).expect(201);
    await agent.post(url(`/logs/${id}/did`)).send({ on: '2026-03-08' }).expect(201);
    const res = await agent.get(url(`/logs/${id}`)).query({ on: '2026-03-18' }).expect(200);
    expect((res.body as Log).stats).toEqual({
      lastDoneOn: '2026-03-08',
      count: 2,
      averageGapDays: 7,
      currentGapDays: 10,
    });
  });

  it('PATCH /logs/:id?on= renames and keeps the history', async () => {
    const id = ((await make('Haircut').expect(201)).body as Log).id;
    await agent.post(url(`/logs/${id}/did`)).send({ on: ON }).expect(201);
    const res = await agent.patch(url(`/logs/${id}`)).query({ on: ON }).send({ name: 'Barber' }).expect(200);
    const log = res.body as Log;
    expect(log.name).toBe('Barber');
    expect(log.stats.count).toBe(1);
  });

  it('DELETE /logs/:id/entries/:entryId undoes one occurrence', async () => {
    const id = ((await make('Haircut').expect(201)).body as Log).id;
    const did = (await agent.post(url(`/logs/${id}/did`)).send({ on: ON }).expect(201)).body as Log;
    const entryId = did.entries![0].id;
    const res = await agent.delete(url(`/logs/${id}/entries/${entryId}`)).query({ on: ON }).expect(200);
    expect((res.body as Log).stats.count).toBe(0);
  });

  it('DELETE /logs/:id cascade-drops its occurrences', async () => {
    const id = ((await make('Haircut').expect(201)).body as Log).id;
    await agent.post(url(`/logs/${id}/did`)).send({ on: ON }).expect(201);
    await agent.delete(url(`/logs/${id}`)).expect(204);
    expect(await prisma.logEntry.count({ where: { logId: id } })).toBe(0);
    await agent.get(url(`/logs/${id}`)).query({ on: ON }).expect(404); // gone
  });

  it('foreign/stale ids are a clean 404, never a silent success', async () => {
    const ghost = '00000000-0000-0000-0000-000000000000';
    await agent.get(url(`/logs/${ghost}`)).query({ on: ON }).expect(404);
    await agent.patch(url(`/logs/${ghost}`)).query({ on: ON }).send({ name: 'x' }).expect(404);
    await agent.delete(url(`/logs/${ghost}`)).expect(404);
    await agent.post(url(`/logs/${ghost}/did`)).send({ on: ON }).expect(404);
    // an entry that doesn't belong to the log is 404 too
    const id = ((await make('Haircut').expect(201)).body as Log).id;
    await agent.delete(url(`/logs/${id}/entries/${ghost}`)).query({ on: ON }).expect(404);
  });

  it('every endpoint is behind the session guard (401 without a session)', async () => {
    const anon = request(app.getHttpServer());
    await anon.get(url('/logs')).query({ on: ON }).expect(401);
    await anon.post(url('/logs')).send({ name: 'x' }).expect(401);
    await anon.get(url('/logs/some-id')).query({ on: ON }).expect(401);
    await anon.patch(url('/logs/some-id')).query({ on: ON }).send({ name: 'x' }).expect(401);
    await anon.delete(url('/logs/some-id')).expect(401);
    await anon.post(url('/logs/some-id/did')).send({ on: ON }).expect(401);
    await anon.delete(url('/logs/some-id/entries/e')).query({ on: ON }).expect(401);
  });
});
