import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEFAULT_PIN_DAYS, type Task } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { loginAgent } from './_auth';

/**
 * The pin config + snooze endpoints (ADR 0086). Behind the global session guard + CSRF, like the rest of
 * the authed API. PUT returns the validated config; snooze/un-snooze return the updated task.
 */
describe('Pin config + snooze endpoints (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let listId: string;
  const url = (p: string) => `/${API_PREFIX}${p}`;
  const makeTask = (impact: 'none' | 'medium' | 'high') =>
    prisma.task.create({ data: { title: `t-${impact}`, listId, ownerId: LOCAL_OWNER_ID, impact } });

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
      const list = await prisma.list.create({ data: { name: 'Zzz Pin Endpoints', ownerId: LOCAL_OWNER_ID } });
      listId = list.id;
    }
    await prisma.settings.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
  });

  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
    if (listId) await prisma.list.deleteMany({ where: { id: listId } });
    await app?.close();
  });

  it('GET /settings/pin returns the defaults', async () => {
    const res = await agent.get(url('/settings/pin')).expect(200);
    expect(res.body).toEqual(DEFAULT_PIN_DAYS);
  });

  it('PUT /settings/pin returns the SAVED (validated) config — bad field defaulted, not rejected', async () => {
    const res = await agent
      .put(url('/settings/pin'))
      .send({ highFuseDays: 5, mediumFuseDays: 0, highSnoozeDays: 2, mediumSnoozeDays: 4 })
      .expect(200);
    expect(res.body).toEqual({
      highFuseDays: 5,
      mediumFuseDays: DEFAULT_PIN_DAYS.mediumFuseDays, // 0 → default
      highSnoozeDays: 2,
      mediumSnoozeDays: 4,
    });
    expect((await agent.get(url('/settings/pin'))).body).toEqual(res.body);
  });

  it('POST /tasks/:id/pin-snooze snoozes and returns the task with pinSnoozedUntil set', async () => {
    const t = await makeTask('high');
    const res = await agent.post(url(`/tasks/${t.id}/pin-snooze`)).expect(200);
    const dto = res.body as Task;
    expect(dto.id).toBe(t.id);
    expect(dto.pinSnoozedUntil).not.toBeNull();
    expect(Date.parse(dto.pinSnoozedUntil as string)).toBeGreaterThan(Date.now());
  });

  it('DELETE /tasks/:id/pin-snooze clears it back to null', async () => {
    const t = await makeTask('high');
    await agent.post(url(`/tasks/${t.id}/pin-snooze`)).expect(200);
    const res = await agent.delete(url(`/tasks/${t.id}/pin-snooze`)).expect(200);
    expect((res.body as Task).pinSnoozedUntil).toBeNull();
  });

  it('snoozing a None-impact task is 400; a stale id is 404', async () => {
    const none = await makeTask('none');
    await agent.post(url(`/tasks/${none.id}/pin-snooze`)).expect(400);
    await agent.post(url('/tasks/00000000-0000-0000-0000-000000000000/pin-snooze')).expect(404);
  });

  it('the Task DTO carries pinSnoozedUntil on a normal read', async () => {
    const t = await makeTask('medium');
    const res = await agent.get(url(`/tasks/${t.id}`)).expect(200);
    expect(res.body as Task).toHaveProperty('pinSnoozedUntil', null);
  });

  it('all four endpoints are behind the session guard (401 without a session)', async () => {
    const anon = request(app.getHttpServer());
    await anon.get(url('/settings/pin')).expect(401);
    await anon.put(url('/settings/pin')).send({}).expect(401);
    await anon.post(url('/tasks/some-id/pin-snooze')).expect(401);
    await anon.delete(url('/tasks/some-id/pin-snooze')).expect(401);
  });
});
