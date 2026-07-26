import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Impact, Task } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * PATCH /tasks/:id — the declared impact level (ADR 0075), through the SAME endpoint that edits due,
 * tier, effort: no new route. impact is two-state like tier (omitted / value; non-null with a default,
 * no null). The load-bearing check is the MIGRATION default: every task — existing or freshly created —
 * reads back `none`, so nothing suddenly nags after the upgrade. Then the round-trip and the guard.
 */
const PREFIX = '__update_impact__';

describe('PATCH /tasks/:id — impact (0075, real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let listId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;
  const patch = (id: string, body: unknown) =>
    agent.patch(url(`/tasks/${id}`)).send(body as object);
  const get = async (id: string): Promise<Task> =>
    (await agent.get(url(`/tasks/${id}`)).expect(200)).body as Task;

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
    }
    await cleanup();
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  it('defaults to none — a freshly created task, and the read DTO carries impact', async () => {
    const created = (
      await agent
        .post(url('/tasks'))
        .send({ title: `${PREFIX} new`, listId })
        .expect(201)
    ).body as Task;
    expect(created.impact).toBe('none'); // the migration default, carried on the wire
  });

  it('defaults to none — a task created directly (an existing/pre-upgrade row is unaffected)', async () => {
    const raw = await prisma.task.create({ data: { title: `${PREFIX} raw`, listId, ownerId: LOCAL_OWNER_ID } });
    expect((await get(raw.id)).impact).toBe('none');
  });

  for (const level of ['medium', 'high', 'none'] as Impact[]) {
    it(`sets impact to ${level} and round-trips it`, async () => {
      const id = (await prisma.task.create({ data: { title: `${PREFIX} ${level}`, listId, ownerId: LOCAL_OWNER_ID } })).id;
      expect((await patch(id, { impact: level }).expect(200)).body.impact).toBe(level);
      expect((await get(id)).impact).toBe(level); // persisted
    });
  }

  it('an invalid impact is REFUSED (400), not written', async () => {
    const id = (await prisma.task.create({ data: { title: `${PREFIX} bad`, listId, ownerId: LOCAL_OWNER_ID, impact: 'high' } })).id;
    await patch(id, { impact: 'huge' }).expect(400);
    expect((await get(id)).impact).toBe('high'); // untouched — the refusal did not partially apply
  });

  it('an impact edit leaves the other fields untouched (the seam)', async () => {
    const id = (await prisma.task.create({ data: { title: `${PREFIX} seam`, listId, ownerId: LOCAL_OWNER_ID, tier: 'critical' } })).id;
    const body = (await patch(id, { impact: 'high' }).expect(200)).body as Task;
    expect(body.impact).toBe('high');
    expect(body.tier).toBe('critical'); // unrelated field, unchanged
  });
});
