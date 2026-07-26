import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionStarted, Task } from '@rankati/shared';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { TasksService } from '../src/tasks.service';

/**
 * The "needs details" flag LIFECYCLE (ADR 0073) over real Postgres: set on create, cleared on any
 * field/checklist edit, the explicit toggle honored, completion exempt — and, like `needsHand`
 * (0071), NEVER a gate. The bite-tests companion (run by hand) sabotages the set and the clear and
 * watches the matching test below go red.
 */
const PREFIX = '__needsdetails_life__';
const OPREFIX = '__ndowner__';
const ON = '2026-07-18';
const dueAtDays = (d: number): string =>
  new Date(Date.parse(`${ON}T00:00:00.000Z`) + d * 86_400_000).toISOString().slice(0, 10);

describe('needsDetails lifecycle (real Postgres, ADR 0073)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let service: TasksService;
  let listId: string;
  const url = (p: string) => `/${API_PREFIX}${p}`;
  const patch = (id: string, body: unknown) =>
    agent.patch(url(`/tasks/${id}`)).send(body as object);
  const get = async (id: string): Promise<Task> =>
    (await agent.get(url(`/tasks/${id}`)).expect(200)).body as Task;

  async function cleanup() {
    if (!prisma) return;
    await prisma.checklistItem.deleteMany({ where: { task: { title: { startsWith: PREFIX } } } });
    await prisma.duel.deleteMany({ where: { winner: { title: { startsWith: PREFIX } } } });
    await prisma.taskDependency.deleteMany({ where: { task: { title: { startsWith: PREFIX } } } });
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.task.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
    await prisma.location.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
  }

  /** A throwaway owner + list — the 0067 pattern for clean service-direct reads. */
  async function freshOwner(): Promise<{ owner: string; ownList: string }> {
    const owner = `${OPREFIX}${randomUUID()}`;
    const ownList = (await prisma.list.create({ data: { name: 'l', ownerId: owner } })).id;
    return { owner, ownList };
  }

  /** Create a task over HTTP in `listId` — the SAME path quick-add AND the (+) use (create()). */
  const post = async (title: string): Promise<Task> =>
    (
      await agent
        .post(url('/tasks'))
        .send({ title: `${PREFIX} ${title}`, listId })
        .expect(201)
    ).body as Task;

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    agent = await loginAgent(app);
    prisma = app.get(PrismaService);
    service = app.get(TasksService);
    await cleanup();
  });

  beforeEach(async () => {
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
  });

  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  // ── SET on create ───────────────────────────────────────────────────────────────────────────
  describe('set on create by every path', () => {
    it('POST /tasks flags it — the path quick-add AND the (+) both use', async () => {
      expect((await post('quick')).needsDetails).toBe(true);
    });

    it('createRequired flags the new prerequisite AND clears the parent (adding a prereq is parent work)', async () => {
      const blocked = await post('blocked'); // created flagged (true)
      const res = await agent
        .post(url(`/tasks/${blocked.id}/requires`))
        .send({ title: `${PREFIX} prereq`, listId })
        .expect(201);
      // The response IS the blocked parent — its dependency set changed, so its flag is now cleared.
      expect((res.body as Task).needsDetails).toBe(false);
      const prereqId = (res.body as Task).dependsOn[0];
      expect(prereqId).toBeTruthy();
      expect((await get(prereqId)).needsDetails).toBe(true); // the new bare prerequisite is flagged
    });

    it('a task created directly (pre-existing, no stamp) is unflagged — false, not backfilled', async () => {
      const raw = await prisma.task.create({
        data: { title: `${PREFIX} raw`, listId, ownerId: LOCAL_OWNER_ID },
      });
      expect((await get(raw.id)).needsDetails).toBe(false);
    });
  });

  // ── CLEAR on any field edit ─────────────────────────────────────────────────────────────────
  describe('cleared by any field edit', () => {
    it('a title edit clears it (a typo-fix counts — the settled rule)', async () => {
      const t = await post('title');
      expect((await patch(t.id, { title: `${PREFIX} renamed` }).expect(200)).body.needsDetails).toBe(false);
    });

    it('a tier edit clears it', async () => {
      const t = await post('tier');
      expect((await patch(t.id, { tier: 'critical' }).expect(200)).body.needsDetails).toBe(false);
    });

    it('a dependency edit clears it (a join-table-only change, no scalar field)', async () => {
      const t = await post('dep');
      const other = await post('dep-target');
      expect((await patch(t.id, { dependsOn: [other.id] }).expect(200)).body.needsDetails).toBe(false);
    });

    it('a location edit clears it', async () => {
      const t = await post('loc');
      const loc = await prisma.location.create({ data: { name: `${PREFIX} here`, ownerId: LOCAL_OWNER_ID } });
      expect((await patch(t.id, { locationIds: [loc.id] }).expect(200)).body.needsDetails).toBe(false);
    });
  });

  // ── The EXPLICIT toggle wins; no stickiness ─────────────────────────────────────────────────
  describe('the explicit toggle is honored (the modal flag icon)', () => {
    it('needsDetails:false alone clears; needsDetails:true alone re-flags (not force-cleared)', async () => {
      const t = await post('toggle');
      expect((await patch(t.id, { needsDetails: false }).expect(200)).body.needsDetails).toBe(false);
      // A PATCH sending needsDetails alone is a real change (clears the nothing-to-update guard)
      // and is HONORED — it is NOT force-cleared to false by the field-edit rule.
      expect((await patch(t.id, { needsDetails: true }).expect(200)).body.needsDetails).toBe(true);
    });

    it('an explicit needsDetails WINS even alongside a field edit', async () => {
      const t = await post('wins');
      const body = (await patch(t.id, { needsDetails: true, title: `${PREFIX} both` }).expect(200)).body as Task;
      expect(body.needsDetails).toBe(true); // explicit wins over the title-edit clear
      expect(body.title).toBe(`${PREFIX} both`); // ...and the title still changed
    });

    it('no stickiness: re-flagged, then a later field edit clears it again', async () => {
      const t = await post('sticky');
      await patch(t.id, { needsDetails: true }).expect(200); // re-flag
      expect((await patch(t.id, { title: `${PREFIX} moved` }).expect(200)).body.needsDetails).toBe(false);
    });

    it('a non-boolean needsDetails is a 400', async () => {
      const t = await post('badtype');
      await patch(t.id, { needsDetails: 'yes' }).expect(400);
    });
  });

  // ── Checklist mutations clear; completion does NOT ──────────────────────────────────────────
  describe('checklist work clears the parent; completion does not', () => {
    const reflag = (id: string) => patch(id, { needsDetails: true }).expect(200);

    it('adding a checklist item clears the parent flag', async () => {
      const t = await post('cl-add');
      await agent.post(url(`/tasks/${t.id}/checklist`)).send({ text: 'x' }).expect(201);
      expect((await get(t.id)).needsDetails).toBe(false);
    });

    it('editing (ticking) a checklist item clears the parent flag', async () => {
      const t = await post('cl-edit');
      const item = (
        await agent.post(url(`/tasks/${t.id}/checklist`)).send({ text: 'x' }).expect(201)
      ).body as { id: string };
      await reflag(t.id); // adding already cleared it; re-flag to isolate the edit
      await agent.patch(url(`/checklist/${item.id}`)).send({ done: true }).expect(200);
      expect((await get(t.id)).needsDetails).toBe(false);
    });

    it('deleting a checklist item clears the parent flag', async () => {
      const t = await post('cl-del');
      const item = (
        await agent.post(url(`/tasks/${t.id}/checklist`)).send({ text: 'x' }).expect(201)
      ).body as { id: string };
      await reflag(t.id);
      await agent.delete(url(`/checklist/${item.id}`)).expect(204);
      expect((await get(t.id)).needsDetails).toBe(false);
    });

    it('completing a task does NOT clear the flag — completion is not detail-entry', async () => {
      const t = await post('complete');
      const done = (await agent.patch(url(`/tasks/${t.id}/complete`)).expect(200)).body as Task;
      expect(done.needsDetails).toBe(true);
    });
  });

  // ── NEVER a gate — soft, not in scoring (like needsHand) ────────────────────────────────────
  describe('the flag never gates (soft, not in scoring)', () => {
    it('a flagged task still appears in Today and Upcoming', async () => {
      const { owner, ownList } = await freshOwner();
      const undated = await prisma.task.create({
        data: { title: `${PREFIX} nd-today`, listId: ownList, ownerId: owner, needsDetails: true },
      });
      const far = await prisma.task.create({
        data: { title: `${PREFIX} nd-up`, listId: ownList, ownerId: owner, needsDetails: true,
          tier: 'critical', due: new Date(dueAtDays(20)) },
      });
      expect((await service.findToday(owner, ON)).map((t) => t.id)).toContain(undated.id);
      expect((await service.findUpcoming(owner, ON)).map((t) => t.id)).toContain(far.id);
    });

    it('a flagged task still appears in the Lists read (ungated)', async () => {
      const flagged = await post('nd-list'); // a local flagged task
      const ids = ((await agent.get(url('/tasks')).expect(200)).body as Task[]).map((t) => t.id);
      expect(ids).toContain(flagged.id);
    });

    it('a flagged task still duels (served by the Arena pool)', async () => {
      const arenaList = (await prisma.list.create({ data: { name: `${PREFIX} arena`, ownerId: LOCAL_OWNER_ID } })).id;
      const a = await prisma.task.create({
        data: { title: `${PREFIX} duel-a`, listId: arenaList, ownerId: LOCAL_OWNER_ID, needsDetails: true },
      });
      const b = await prisma.task.create({
        data: { title: `${PREFIX} duel-b`, listId: arenaList, ownerId: LOCAL_OWNER_ID, needsDetails: true },
      });
      const started = (
        await agent.post(url('/duel-sessions')).send({ listId: arenaList }).expect(200)
      ).body as SessionStarted;
      expect([started.pair.a.id, started.pair.b.id].sort()).toEqual([a.id, b.id].sort());
    });
  });
});
