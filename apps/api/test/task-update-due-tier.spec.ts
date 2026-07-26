import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Task } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * PATCH /tasks/:id — editing due and tier (ADR 0056), through the SAME endpoint that already
 * edits title, notBefore and dependsOn (0054): no new route.
 *
 * due is tri-state like notBefore (omitted / null / value); tier is two-state (omitted / value,
 * no null — it is non-null with a default). The load-bearing checks are the SEAMS: that a due
 * or tier edit leaves the other fields — especially notBefore — untouched, and that an invalid
 * tier is refused rather than written.
 */
const PREFIX = '__update_due_tier__';

describe('PATCH /tasks/:id — due and tier (0056, real Postgres)', () => {
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
    (
      await prisma.task.create({
        data: { title: `${PREFIX} t`, listId, ownerId: LOCAL_OWNER_ID, ...data },
      })
    ).id;

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

  describe('due — tri-state, exactly like notBefore', () => {
    it('sets due from a YYYY-MM-DD value', async () => {
      const id = await task();
      const res = await patch(id, { due: '2026-07-25' }).expect(200);
      expect((res.body as Task).due).toBe('2026-07-25');
    });

    it('clears due with null', async () => {
      const id = await task({ due: new Date('2026-07-25') });
      const res = await patch(id, { due: null }).expect(200);
      expect((res.body as Task).due).toBeNull();
    });

    it('leaves due untouched when the field is absent (a title-only edit)', async () => {
      const id = await task({ due: new Date('2026-07-25') });
      const res = await patch(id, { title: `${PREFIX} renamed` }).expect(200);
      expect((res.body as Task).due).toBe('2026-07-25'); // omitted != cleared
    });

    it('400s a due that is not a real date', async () => {
      const id = await task();
      await patch(id, { due: '2026-02-31' }).expect(400);
      await patch(id, { due: '25-07-2026' }).expect(400);
    });
  });

  describe('tier — two-state, enum-validated', () => {
    it('sets a valid tier', async () => {
      const id = await task();
      const res = await patch(id, { tier: 'critical' }).expect(200);
      expect((res.body as Task).tier).toBe('critical');
    });

    it('400s an invalid tier, naming the allowed values', async () => {
      const id = await task();
      const res = await patch(id, { tier: 'urgent' }).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/normal.*important.*super_important.*critical/);
      // ...and nothing was written.
      const back = await prisma.task.findUniqueOrThrow({ where: { id } });
      expect(back.tier).toBe('normal');
    });

    it('leaves tier untouched when the field is absent', async () => {
      const id = await task({ tier: 'important' });
      const res = await patch(id, { title: `${PREFIX} renamed` }).expect(200);
      expect((res.body as Task).tier).toBe('important');
    });
  });

  describe('the seams hold', () => {
    it('sets due and tier together in one edit', async () => {
      const id = await task();
      const res = await patch(id, { due: '2026-08-01', tier: 'super_important' }).expect(200);
      expect((res.body as Task).due).toBe('2026-08-01');
      expect((res.body as Task).tier).toBe('super_important');
    });

    it('a due/tier edit leaves notBefore untouched — the two dates are independent', async () => {
      const id = await task({ notBefore: new Date('2026-07-18') });
      const res = await patch(id, { due: '2026-07-25', tier: 'critical' }).expect(200);
      expect((res.body as Task).notBefore).toBe('2026-07-18'); // the start gate is not the deadline
      expect((res.body as Task).due).toBe('2026-07-25');
    });

    it('400s an empty patch, and the message now names due and tier', async () => {
      const id = await task();
      const res = await patch(id, {}).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/due/);
      expect(JSON.stringify(res.body)).toMatch(/tier/);
    });
  });
});
