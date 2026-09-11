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

  it('an explicit reminderLeadsMinutes wins over the default (no extra row)', async () => {
    const id = await task();
    const body = (await patch(id, { eventAt: AT, reminderLeadsMinutes: [1440] }).expect(200)).body as Task;
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
    await patch(id, { reminderLeadsMinutes: [50000] }).expect(400); // > 43200
  });

  it('a reminder with no meeting time is refused (400)', async () => {
    const id = await task(); // untimed
    await patch(id, { reminderLeadsMinutes: [30] }).expect(400);
    expect(await reminders(id)).toHaveLength(0);
  });

  it('reminderLeadsMinutes on an already-timed task sets the reminder', async () => {
    const id = await task({ eventAt: new Date(AT) });
    await patch(id, { reminderLeadsMinutes: [15] }).expect(200); // no eventAt in this PATCH — uses the stored one
    const rows = await reminders(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.leadMinutes).toBe(15);
  });

  it('reminderLeadsMinutes:[] clears the reminders', async () => {
    const id = await task();
    await patch(id, { eventAt: AT }).expect(200); // default 1h created
    const body = (await patch(id, { reminderLeadsMinutes: [] }).expect(200)).body as Task;
    expect(body.reminders).toHaveLength(0);
  });

  // Build 3.5 — multiple reminders (reconcile-by-lead).
  it('sets several reminders at once; the wire carries them all', async () => {
    const id = await task();
    const body = (await patch(id, { eventAt: AT, reminderLeadsMinutes: [1440, 60, 10] }).expect(200)).body as Task;
    expect(body.reminders.map((r) => r.leadMinutes).sort((a, b) => a - b)).toEqual([10, 60, 1440]);
  });

  it('adding a reminder PRESERVES the already-fired one’s sentAt (reconcile, not replace-all)', async () => {
    const id = await task();
    await patch(id, { eventAt: AT, reminderLeadsMinutes: [60] }).expect(200);
    const [first] = await reminders(id);
    const firedAt = new Date();
    await prisma.taskReminder.update({ where: { id: first!.id }, data: { sentAt: firedAt } }); // pretend it fired
    // Add a 1-day reminder alongside the 1-hour one.
    await patch(id, { reminderLeadsMinutes: [60, 1440] }).expect(200);
    const rows = await reminders(id);
    expect(rows).toHaveLength(2);
    const hour = rows.find((r) => r.leadMinutes === 60)!;
    const day = rows.find((r) => r.leadMinutes === 1440)!;
    expect(hour.id).toBe(first!.id); // same row — NOT recreated
    expect(hour.sentAt).not.toBeNull(); // its fire-once survived
    expect(day.sentAt).toBeNull(); // the new one is un-sent
  });

  it('removing a lead from the set drops only that row', async () => {
    const id = await task();
    await patch(id, { eventAt: AT, reminderLeadsMinutes: [10, 60, 1440] }).expect(200);
    await patch(id, { reminderLeadsMinutes: [60] }).expect(200);
    expect((await reminders(id)).map((r) => r.leadMinutes)).toEqual([60]);
  });

  it('deduplicates equal leads to one row', async () => {
    const id = await task();
    const body = (await patch(id, { eventAt: AT, reminderLeadsMinutes: [60, 60, 60] }).expect(200)).body as Task;
    expect(body.reminders).toHaveLength(1);
  });

  it('refuses more than 5 reminders (400)', async () => {
    const id = await task({ eventAt: new Date(AT) });
    await patch(id, { reminderLeadsMinutes: [1, 2, 3, 4, 5, 6] }).expect(400);
    expect(await reminders(id)).toHaveLength(0);
  });

  it('rescheduling re-arms ALL reminders (every sentAt resets)', async () => {
    const id = await task();
    await patch(id, { eventAt: AT, reminderLeadsMinutes: [60, 1440] }).expect(200);
    await prisma.taskReminder.updateMany({ where: { taskId: id }, data: { sentAt: new Date() } }); // both fired
    await patch(id, { eventAt: '2026-09-25T09:00:00.000Z' }).expect(200); // reschedule
    const rows = await reminders(id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sentAt === null)).toBe(true);
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
