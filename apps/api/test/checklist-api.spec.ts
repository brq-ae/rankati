import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChecklistItem, SessionStarted, Task } from '@rankati/shared';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { ArenaSessionService } from '../src/arena/arena-session.service';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { TasksService } from '../src/tasks.service';

/**
 * The checklist routes + `needsHand` write (ADR 0071), over real Postgres.
 *
 * Both are SOFT — never a gate. This suite's centre of gravity is the negative space: proving
 * that nothing they touch (Today, Upcoming, Lists, the Arena, `complete`) reacts to them at all.
 * The bite-tests companion to this file (run manually, not part of `vitest run`) sabotage each of
 * those never-gates clauses in turn and watch the relevant test below go red.
 */
const PREFIX = '__checklist_api__';
const OPREFIX = '__ownertest__';

describe('Checklist API + needsHand (real Postgres, ADR 0071)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let service: TasksService;
  let arena: ArenaSessionService;
  let listId: string;
  const url = (p: string) => `/${API_PREFIX}${p}`;

  async function cleanup() {
    if (!prisma) return;
    await prisma.checklistItem.deleteMany({ where: { task: { title: { startsWith: PREFIX } } } });
    await prisma.duel.deleteMany({ where: { winner: { title: { startsWith: PREFIX } } } });
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.task.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
  }

  /** A throwaway owner with its own list — the 0067 whole-tab pattern for service-direct reads. */
  async function freshOwner(): Promise<{ owner: string; ownList: string }> {
    const owner = `${OPREFIX}${randomUUID()}`;
    const ownList = (await prisma.list.create({ data: { name: 'l', ownerId: owner } })).id;
    return { owner, ownList };
  }

  /** A `local` task, ALWAYS prefix-titled so cleanup owns it, undated so it is always Today-eligible. */
  const mkTask = async (title: string, opts: { needsHand?: boolean; inList?: string } = {}): Promise<string> =>
    (
      await prisma.task.create({
        data: {
          title: `${PREFIX} ${title}`,
          listId: opts.inList ?? listId,
          ownerId: LOCAL_OWNER_ID,
          needsHand: opts.needsHand ?? false,
        },
      })
    ).id;

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    agent = await loginAgent(app);
    prisma = app.get(PrismaService);
    service = app.get(TasksService);
    arena = app.get(ArenaSessionService);
    await cleanup();
  });

  beforeEach(async () => {
    arena.discard();
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
  });

  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  // ── a. CRUD round-trip over HTTP ────────────────────────────────────────────────────────────
  describe('CRUD round-trip over HTTP', () => {
    it('add three (append 1,2,3), rename one, tick one, move one, delete one — the task DTO reflects it all, ordered', async () => {
      const taskId = await mkTask('crud');

      const a = (
        await agent.post(url(`/tasks/${taskId}/checklist`)).send({ text: 'first' }).expect(201)
      ).body as ChecklistItem;
      const b = (
        await agent.post(url(`/tasks/${taskId}/checklist`)).send({ text: 'second' }).expect(201)
      ).body as ChecklistItem;
      const c = (
        await agent.post(url(`/tasks/${taskId}/checklist`)).send({ text: 'third' }).expect(201)
      ).body as ChecklistItem;
      expect([a.position, b.position, c.position]).toEqual([1, 2, 3]); // append order

      const renamed = (
        await agent.patch(url(`/checklist/${a.id}`)).send({ text: 'first, renamed' }).expect(200)
      ).body as ChecklistItem;
      expect(renamed.text).toBe('first, renamed');

      const ticked = (
        await agent.patch(url(`/checklist/${b.id}`)).send({ done: true }).expect(200)
      ).body as ChecklistItem;
      expect(ticked.done).toBe(true);

      // Move c to the front — position sets ONLY this item, no sibling renumbering.
      const moved = (
        await agent.patch(url(`/checklist/${c.id}`)).send({ position: 0 }).expect(200)
      ).body as ChecklistItem;
      expect(moved.position).toBe(0);

      await agent.delete(url(`/checklist/${a.id}`)).expect(204);

      const task = (await agent.get(url(`/tasks/${taskId}`)).expect(200)).body as Task;
      // Remaining, ordered by position asc: c (0), then b (2). a is gone.
      expect(task.checklist.map((i) => i.id)).toEqual([c.id, b.id]);
      expect(task.checklist.find((i) => i.id === b.id)?.done).toBe(true);
      expect(task.checklist.find((i) => i.id === c.id)?.position).toBe(0);
      expect(task.checklist).toHaveLength(2);
    });
  });

  // ── b. Validation ────────────────────────────────────────────────────────────────────────────
  describe('validation', () => {
    it('empty/whitespace text -> 400 on create and update', async () => {
      const taskId = await mkTask('validate-text');
      await agent.post(url(`/tasks/${taskId}/checklist`)).send({ text: '' }).expect(400);
      await agent.post(url(`/tasks/${taskId}/checklist`)).send({ text: '   ' }).expect(400);

      const item = (
        await agent.post(url(`/tasks/${taskId}/checklist`)).send({ text: 'ok' }).expect(201)
      ).body as ChecklistItem;
      await agent.patch(url(`/checklist/${item.id}`)).send({ text: '   ' }).expect(400);
    });

    it('non-boolean done -> 400', async () => {
      const taskId = await mkTask('validate-done');
      const item = (
        await agent.post(url(`/tasks/${taskId}/checklist`)).send({ text: 'ok' }).expect(201)
      ).body as ChecklistItem;
      await agent.patch(url(`/checklist/${item.id}`)).send({ done: 'yes' }).expect(400);
    });

    it('unknown item -> 404 on update and delete; unknown task -> 404 on create', async () => {
      await agent.patch(url(`/checklist/${randomUUID()}`)).send({ done: true }).expect(404);
      await agent.delete(url(`/checklist/${randomUUID()}`)).expect(404);
      await agent.post(url(`/tasks/${randomUUID()}/checklist`)).send({ text: 'x' }).expect(404);
    });

    it('an item under a THROWAWAY owner\'s task -> 404 (the owner boundary, sabotage-worthy)', async () => {
      const { owner, ownList } = await freshOwner();
      const otherTask = await prisma.task.create({ data: { title: 'other', listId: ownList, ownerId: owner } });
      const otherItem = await prisma.checklistItem.create({
        data: { taskId: otherTask.id, text: 'x', position: 1 },
      });

      await agent.patch(url(`/checklist/${otherItem.id}`)).send({ done: true }).expect(404);
      await agent.delete(url(`/checklist/${otherItem.id}`)).expect(404);
      // Survives — the boundary held, not a silent success.
      expect(await prisma.checklistItem.findUnique({ where: { id: otherItem.id } })).not.toBeNull();

      // Creating against a task owned by someone else also 404s — LOCAL_OWNER_ID-only.
      await agent.post(url(`/tasks/${otherTask.id}/checklist`)).send({ text: 'x' }).expect(404);
    });
  });

  // ── c. Ticks persist ─────────────────────────────────────────────────────────────────────────
  describe('ticks persist, permanently', () => {
    it('tick an item, complete the task -> item still exists, still ticked; further unrelated PATCHes do not reset it', async () => {
      const taskId = await mkTask('ticks-persist');
      const item = (
        await agent
          .post(url(`/tasks/${taskId}/checklist`))
          .send({ text: 'call the plumber' })
          .expect(201)
      ).body as ChecklistItem;
      await agent.patch(url(`/checklist/${item.id}`)).send({ done: true }).expect(200);

      await agent.patch(url(`/tasks/${taskId}/complete`)).expect(200);

      let task = (await agent.get(url(`/tasks/${taskId}`)).expect(200)).body as Task;
      expect(task.checklist).toHaveLength(1);
      expect(task.checklist[0]!.done).toBe(true);

      // An unrelated PATCH (rename) afterwards — nothing here resets it either.
      await agent
        .patch(url(`/tasks/${taskId}`))
        .send({ title: `${PREFIX} ticks-persist renamed` })
        .expect(200);
      task = (await agent.get(url(`/tasks/${taskId}`)).expect(200)).body as Task;
      expect(task.checklist[0]!.done).toBe(true);
    });
  });

  // ── d. Completable unticked ──────────────────────────────────────────────────────────────────
  describe('completable unticked', () => {
    it('a task with unticked items completes (200, status done) — no interference', async () => {
      const taskId = await mkTask('completable-unticked');
      await agent
        .post(url(`/tasks/${taskId}/checklist`))
        .send({ text: 'not done yet' })
        .expect(201);

      const completed = (
        await agent.patch(url(`/tasks/${taskId}/complete`)).expect(200)
      ).body as Task;
      expect(completed.status).toBe('done');
      expect(completed.checklist[0]!.done).toBe(false); // still unticked — completion did not touch it
    });
  });

  // ── e. Soft-never-gates: the core battery ────────────────────────────────────────────────────
  describe('soft-never-gates: the core battery (ADR 0071)', () => {
    it('needsHand:true and unticked-checklist tasks both stay in Today; ticking/unticking does not move membership', async () => {
      const { owner, ownList } = await freshOwner();
      const ON = '2026-07-23';

      const handTask = (
        await prisma.task.create({ data: { title: 'hand', listId: ownList, ownerId: owner, needsHand: true } })
      ).id;
      const checklistTask = (
        await prisma.task.create({ data: { title: 'checklist', listId: ownList, ownerId: owner } })
      ).id;
      await prisma.checklistItem.create({ data: { taskId: checklistTask, text: 'unticked', position: 1 } });

      const before = (await service.findToday(owner, ON)).map((t) => t.id).sort();
      expect(before).toEqual(expect.arrayContaining([handTask, checklistTask]));

      // Ticking the item does NOT change Today membership.
      const item = await prisma.checklistItem.findFirstOrThrow({ where: { taskId: checklistTask } });
      await prisma.checklistItem.update({ where: { id: item.id }, data: { done: true } });
      expect((await service.findToday(owner, ON)).map((t) => t.id).sort()).toEqual(before);

      // ...and unticking it back does not either.
      await prisma.checklistItem.update({ where: { id: item.id }, data: { done: false } });
      expect((await service.findToday(owner, ON)).map((t) => t.id).sort()).toEqual(before);
    });

    it('both appear in GET /api/tasks (prefixed local rows)', async () => {
      const localHand = await mkTask('local-hand', { needsHand: true });
      const localChecklistTaskId = await mkTask('local-checklist');
      await agent
        .post(url(`/tasks/${localChecklistTaskId}/checklist`))
        .send({ text: 'unticked' })
        .expect(201);

      const all = (await agent.get(url('/tasks')).expect(200)).body as Task[];
      const allIds = all.map((t) => t.id);
      expect(allIds).toContain(localHand);
      expect(allIds).toContain(localChecklistTaskId);
    });

    it('the needsHand task is still served by the Arena pool (0009/0052\'s invariant, inherited by 0071)', async () => {
      const arenaList = (await prisma.list.create({ data: { name: `${PREFIX} arena-l`, ownerId: LOCAL_OWNER_ID } })).id;
      const flagged = await mkTask('arena-flagged', { needsHand: true, inList: arenaList });
      const plain = await mkTask('arena-plain', { inList: arenaList });

      const started = (
        await agent.post(url('/duel-sessions')).send({ listId: arenaList }).expect(200)
      ).body as SessionStarted;
      expect([started.pair.a.id, started.pair.b.id].sort()).toEqual([flagged, plain].sort());
    });
  });

  // ── f. Live inert re-check: the real `local` owner's scored read is untouched by this slice ──
  describe('live inert re-check (ADR 0071)', () => {
    it('the real local owner carries zero checklist rows and zero needsHand=true — this slice adds routes only, no data', async () => {
      const localChecklistCount = await prisma.checklistItem.count({
        where: { task: { ownerId: LOCAL_OWNER_ID, title: { not: { startsWith: PREFIX } } } },
      });
      const localNeedsHandCount = await prisma.task.count({
        where: { ownerId: LOCAL_OWNER_ID, needsHand: true, title: { not: { startsWith: PREFIX } } },
      });
      expect(localChecklistCount).toBe(0);
      expect(localNeedsHandCount).toBe(0);
    });
  });
});
