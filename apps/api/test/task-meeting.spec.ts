import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Task } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { loginAgent } from './_auth';

/**
 * PATCH /tasks/:id — meeting time (ADR 0097, meetings epic Build 3, S1a: MODEL + WIRING only; the Today-gate
 * and the overlap advisory are S1b, reminder FIRING is S2). Through the same endpoint as every field edit.
 * The load-bearing behaviours: eventAt is a real instant kept off the day-based engine; the reminder is a
 * child-row LIST (v1 exposes one) that auto-arms with a 1h default and re-arms on reschedule; clearing
 * eventAt cascades to its satellites; bounds are enforced.
 */
const PREFIX = '__meeting__';

describe('PATCH /tasks/:id — meeting time (0097 S1a, real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let listId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;
  const patch = (id: string, body: unknown) => agent.patch(url(`/tasks/${id}`)).send(body as object);

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  const task = async (data: Record<string, unknown> = {}): Promise<string> =>
    (await prisma.task.create({ data: { title: `${PREFIX} t`, listId, ownerId: LOCAL_OWNER_ID, ...data } })).id;
  const reminders = (id: string) =>
    prisma.taskReminder.findMany({ where: { taskId: id }, orderBy: { leadMinutes: 'asc' } });

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

  const AT = '2026-09-20T14:00:00.000Z';

  it('setting eventAt stores the instant and auto-creates a DEFAULT 1h reminder', async () => {
    const id = await task();
    const body = (await patch(id, { eventAt: AT }).expect(200)).body as Task;
    expect(body.eventAt).toBe(AT);
    expect(body.reminders).toHaveLength(1);
    expect(body.reminders[0]!.leadMinutes).toBe(60);
    expect(body.reminders[0]!.sentAt).toBeNull();
  });

  it('an explicit reminderLeadMinutes wins over the default (no extra row)', async () => {
    const id = await task();
    const body = (await patch(id, { eventAt: AT, reminderLeadMinutes: 1440 }).expect(200)).body as Task;
    expect(body.reminders).toHaveLength(1);
    expect(body.reminders[0]!.leadMinutes).toBe(1440); // 1 day, allowed (> the 1440 nag cap, ≤ 43200)
  });

  it('stores durationMinutes + surfaceLeadDays; rejects out-of-range', async () => {
    const id = await task();
    const body = (await patch(id, { eventAt: AT, durationMinutes: 180, surfaceLeadDays: 2 }).expect(200)).body as Task;
    expect(body.durationMinutes).toBe(180);
    expect(body.surfaceLeadDays).toBe(2);
    await patch(id, { durationMinutes: 0 }).expect(400); // < 1
    await patch(id, { durationMinutes: 5000 }).expect(400); // > 1440
    await patch(id, { surfaceLeadDays: 0 }).expect(400); // < 1
    await patch(id, { reminderLeadMinutes: 50000 }).expect(400); // > 43200
  });

  it('a reminder with no meeting time is refused (400)', async () => {
    const id = await task(); // untimed
    await patch(id, { reminderLeadMinutes: 30 }).expect(400);
    expect(await reminders(id)).toHaveLength(0);
  });

  it('reminderLeadMinutes on an already-timed task updates the single reminder', async () => {
    const id = await task({ eventAt: new Date(AT) });
    await patch(id, { reminderLeadMinutes: 15 }).expect(200); // no eventAt in this PATCH — uses the stored one
    const rows = await reminders(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.leadMinutes).toBe(15);
  });

  it('reminderLeadMinutes:null clears the reminder', async () => {
    const id = await task();
    await patch(id, { eventAt: AT }).expect(200); // default 1h created
    const body = (await patch(id, { reminderLeadMinutes: null }).expect(200)).body as Task;
    expect(body.reminders).toHaveLength(0);
  });

  it('rescheduling eventAt RE-ARMS the reminder (sentAt resets to null)', async () => {
    const id = await task();
    await patch(id, { eventAt: AT }).expect(200);
    const [r] = await reminders(id);
    await prisma.taskReminder.update({ where: { id: r!.id }, data: { sentAt: new Date() } }); // pretend it fired
    const body = (await patch(id, { eventAt: '2026-09-21T09:00:00.000Z' }).expect(200)).body as Task;
    expect(body.reminders).toHaveLength(1);
    expect(body.reminders[0]!.sentAt).toBeNull(); // re-armed
    expect(body.reminders[0]!.leadMinutes).toBe(60); // lead preserved
  });

  it('clearing eventAt (null) cascades — wipes duration, surfaceLeadDays, and reminders', async () => {
    const id = await task();
    await patch(id, { eventAt: AT, durationMinutes: 90, surfaceLeadDays: 3 }).expect(200);
    const body = (await patch(id, { eventAt: null }).expect(200)).body as Task;
    expect(body.eventAt).toBeNull();
    expect(body.durationMinutes).toBeNull();
    expect(body.surfaceLeadDays).toBeNull();
    expect(body.reminders).toHaveLength(0);
  });

  it('an invalid eventAt is refused (400)', async () => {
    const id = await task();
    await patch(id, { eventAt: 'not a date' }).expect(400);
    expect((await prisma.task.findUnique({ where: { id } }))!.eventAt).toBeNull();
  });

  it('deleting the task cascades its reminders away (no orphans)', async () => {
    const id = await task();
    await patch(id, { eventAt: AT }).expect(200);
    expect(await reminders(id)).toHaveLength(1);
    await agent.delete(url(`/tasks/${id}`)).expect(204);
    expect(await reminders(id)).toHaveLength(0);
  });
});
