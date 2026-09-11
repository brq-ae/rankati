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
 * ADR 0097 S1b — the meeting Today-gate + the soft overlap advisory.
 *
 * Gate: a task with a FUTURE eventAt is held OUT of the Today hand but stays VISIBLE in Upcoming (the
 * owner's Build-3 decision — NOT `isGated`, which hides from both), surfacing on its local day-of or earlier
 * by surfaceLeadDays. ONLY eventAt tasks are affected. With no owner tz configured the meeting's local day
 * falls back to the instant's UTC day (asserted here); a set tz shifts it (also asserted).
 *
 * Overlap: PATCHing a meeting time returns a NON-BLOCKING `overlaps[]` on the response — never a 400.
 */
const PREFIX = '__mgate__';

describe('meeting Today-gate + overlap advisory (0097 S1b, real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let listId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;
  const patch = (id: string, body: unknown) => agent.patch(url(`/tasks/${id}`)).send(body as object);
  const today = (on: string) => agent.get(url(`/tasks/today?on=${on}&at=12:00`)).expect(200);
  const upcoming = (on: string) => agent.get(url(`/tasks/upcoming?on=${on}&at=12:00`)).expect(200);
  const ids = (res: { body: unknown }) => (res.body as Task[]).map((t) => t.id);

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.telegramConfig.deleteMany({ where: { ownerId: LOCAL_OWNER_ID } });
  }

  const task = async (data: Record<string, unknown> = {}): Promise<string> =>
    (await prisma.task.create({ data: { title: `${PREFIX} t`, listId, ownerId: LOCAL_OWNER_ID, ...data } })).id;

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

  it('a future meeting is held OUT of Today but shows in Upcoming (no surfaceLead → day-of)', async () => {
    const id = await task({ eventAt: new Date('2026-09-18T14:00:00.000Z') });
    expect(ids(await today('2026-09-15'))).not.toContain(id); // 3 days out — not near
    expect(ids(await upcoming('2026-09-15'))).toContain(id); // but visible in Upcoming
  });

  it('surfaces into Today on the day-of', async () => {
    const id = await task({ eventAt: new Date('2026-09-18T14:00:00.000Z') });
    expect(ids(await today('2026-09-18'))).toContain(id);
  });

  it('surfaceLeadDays brings it into Today earlier — exactly on the boundary day', async () => {
    const id = await task({ eventAt: new Date('2026-09-18T14:00:00.000Z'), surfaceLeadDays: 3 });
    expect(ids(await today('2026-09-14'))).not.toContain(id); // 4 days out, lead 3 → still held
    expect(ids(await today('2026-09-15'))).toContain(id); // boundary: 18 − 3 = 15 → surfaces
  });

  it('a plain due-dated task (no eventAt) is NOT touched by the meeting gate', async () => {
    // Undated task with no eventAt is always playable — proves the gate is eventAt-only.
    const id = await task();
    expect(ids(await today('2026-09-15'))).toContain(id);
  });

  it("uses the owner's tz to derive the meeting's local day (vs the UTC fallback)", async () => {
    // 2026-09-16T21:00Z is 2026-09-17 01:00 in Asia/Dubai (UTC+4) → local day 09-17, so on 09-16 it's held.
    // Under the UTC fallback its day would be 09-16 and it would surface — so this pins the tz path.
    const id = await task({ eventAt: new Date('2026-09-16T21:00:00.000Z') });
    await prisma.telegramConfig.create({ data: { ownerId: LOCAL_OWNER_ID, timezone: 'Asia/Dubai' } });
    expect(ids(await today('2026-09-16'))).not.toContain(id); // Dubai-local day is 09-17 → held on 09-16
    expect(ids(await today('2026-09-17'))).toContain(id);
  });

  it('overlap advisory: a PATCH that double-books returns the clash, non-blocking', async () => {
    const a = await task({ eventAt: new Date('2026-09-20T14:00:00.000Z'), durationMinutes: 120 }); // 14:00–16:00
    const b = await task();
    // 15:00 for 60m overlaps A's 14:00–16:00.
    const res = (await patch(b, { eventAt: '2026-09-20T15:00:00.000Z', durationMinutes: 60 }).expect(200)).body as Task;
    expect(res.overlaps).toHaveLength(1);
    expect(res.overlaps![0]!.id).toBe(a);
    expect(res.overlaps![0]!.start).toBe('2026-09-20T14:00:00.000Z');
    expect(res.overlaps![0]!.end).toBe('2026-09-20T16:00:00.000Z');
  });

  it('overlap advisory: a clear slot returns an empty array (still 200, never 400)', async () => {
    await task({ eventAt: new Date('2026-09-20T14:00:00.000Z'), durationMinutes: 60 }); // 14:00–15:00
    const b = await task();
    const res = (await patch(b, { eventAt: '2026-09-20T16:00:00.000Z', durationMinutes: 60 }).expect(200)).body as Task; // 16:00–17:00
    expect(res.overlaps).toEqual([]);
  });

  it('overlap advisory is absent on a save that did not set a meeting time', async () => {
    const id = await task();
    const res = (await patch(id, { title: `${PREFIX} renamed` }).expect(200)).body as Task;
    expect(res.overlaps).toBeUndefined();
  });
});
