import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * Smoke test for the v0.1 walking skeleton.
 *
 * Runs against the REAL dev Postgres (ADR 0037) — `pnpm db:up` must be running.
 * A mocked database would go green while never touching the one link this
 * milestone exists to prove.
 */

/** Marks every row this file creates, so stray debris is unambiguous. */
const PREFIX = '__smoketest__';

describe('API smoke (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    agent = await loginAgent(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // Runs even when an assertion above throws, so a failed run leaves no debris.
    // Tasks before lists: the FK would block the parent delete.
    if (prisma) {
      await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
      await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
    }
    await app?.close();
  });

  it('reports the database is actually reachable', async () => {
    const res = await agent.get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('walks the skeleton: create a list, add a task, complete it', async () => {
    const list = await agent
      .post('/api/lists')
      .send({ name: `${PREFIX} Home` })
      .expect(201);
    // The client never sent an owner; the server stamped it (ADR 0039).
    expect(list.body.ownerId).toBe(LOCAL_OWNER_ID);

    const task = await agent
      .post('/api/tasks')
      .send({ title: `${PREFIX} walk`, listId: list.body.id })
      .expect(201);
    expect(task.body.status).toBe('active');
    expect(task.body.completedAt).toBeNull();
    expect(task.body.ownerId).toBe(LOCAL_OWNER_ID);
    // ISO string, not a Date — the contract in @rankati/shared (ADR 0041).
    expect(typeof task.body.createdAt).toBe('string');

    const fetched = await agent
      .get(`/api/tasks/${task.body.id}`)
      .expect(200);
    expect(fetched.body.id).toBe(task.body.id);

    const done = await agent
      .patch(`/api/tasks/${task.body.id}/complete`)
      .expect(200);
    expect(done.body.status).toBe('done');
    expect(typeof done.body.completedAt).toBe('string');

    // Completing twice must not rewrite history.
    const again = await agent
      .patch(`/api/tasks/${task.body.id}/complete`)
      .expect(200);
    expect(again.body.completedAt).toBe(done.body.completedAt);
  });

  it('persists what it created', async () => {
    const list = await agent
      .post('/api/lists')
      .send({ name: `${PREFIX} Persisted` })
      .expect(201);

    const lists = await agent.get('/api/lists').expect(200);
    expect(lists.body.map((l: { id: string }) => l.id)).toContain(list.body.id);
  });

  it('answers client mistakes with 4xx, never a 500', async () => {
    await agent.get('/api/tasks/does-not-exist').expect(404);

    // Nonexistent list -> Prisma FK violation, caught and mapped (not a raw 500).
    await agent
      .post('/api/tasks')
      .send({ title: `${PREFIX} orphan`, listId: '11111111-1111-1111-1111-111111111111' })
      .expect(400);

    await agent.post('/api/lists').send({ name: '   ' }).expect(400);
    await agent.post('/api/lists').send({ name: 123 }).expect(400);
  });

  it('mounts everything under the prefix and nothing outside it', async () => {
    await agent.get('/health').expect(404);
    await agent.get('/api/health').expect(200);
  });
});
