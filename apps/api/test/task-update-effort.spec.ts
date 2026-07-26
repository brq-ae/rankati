import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Effort, Task } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * PATCH /tasks/:id — editing the effort bucket (ADR 0072), through the SAME endpoint that edits due,
 * tier and the gates: no new route. effort is TRI-STATE like notBefore/availabilityWindow (omitted /
 * null / value): a value sets the bucket, null clears it back to untagged, an absent field leaves it.
 * The load-bearing checks are the SEAMS — that an effort edit leaves the other fields untouched, and
 * that an invalid bucket is REFUSED (400) rather than written.
 */
const PREFIX = '__update_effort__';

describe('PATCH /tasks/:id — effort (0072, real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let listId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;
  const patch = (id: string, body: unknown) =>
    agent.patch(url(`/tasks/${id}`)).send(body as object);

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
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

  for (const bucket of ['quick', 'medium', 'long'] as Effort[]) {
    it(`sets effort to ${bucket}`, async () => {
      const id = await task();
      const res = await patch(id, { effort: bucket }).expect(200);
      expect((res.body as Task).effort).toBe(bucket);
    });
  }

  it('null CLEARS it back to untagged — the only way to un-tag', async () => {
    const id = await task({ effort: 'long' });
    const res = await patch(id, { effort: null }).expect(200);
    expect((res.body as Task).effort).toBeNull();
  });

  it('an invalid bucket is REFUSED (400), not written', async () => {
    const id = await task({ effort: 'medium' });
    await patch(id, { effort: 'huge' }).expect(400);
    // The stored value is untouched — the refusal did not partially apply.
    const back = await prisma.task.findUniqueOrThrow({ where: { id } });
    expect(back.effort).toBe('medium');
  });

  it('an effort edit leaves the other fields untouched (the seam)', async () => {
    const id = await task({ tier: 'critical', due: new Date('2026-08-01') });
    const res = await patch(id, { effort: 'quick' }).expect(200);
    const body = res.body as Task;
    expect(body.effort).toBe('quick');
    expect(body.tier).toBe('critical'); // unrelated field, unchanged
    expect(body.due).toBe('2026-08-01');
  });
});
