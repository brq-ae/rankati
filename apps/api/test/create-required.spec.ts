import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { CreateRequiredTaskDto, Task } from '@rankati/shared';
import request from 'supertest';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { TasksService } from '../src/tasks.service';

/**
 * POST /tasks/:id/requires — create a prerequisite and link it, atomically (ADR 0054).
 *
 * The load-bearing tests are the rollbacks. Two client calls could create the task and fail
 * the link, stranding an orphan in a list nobody chose; this endpoint exists so that state
 * cannot occur. Proving it means forcing the link to fail AFTER the create and showing no
 * task survives — not asserting that a transaction is a transaction.
 */
const PREFIX = '__requires__';

describe('POST /tasks/:id/requires (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let service: TasksService;
  let listId: string;
  let otherListId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  const task = async (name: string): Promise<string> =>
    (
      await prisma.task.create({
        data: { title: `${PREFIX} ${name}`, listId, ownerId: LOCAL_OWNER_ID },
      })
    ).id;

  const post = (id: string, dto: CreateRequiredTaskDto) =>
    agent.post(url(`/tasks/${id}/requires`)).send(dto satisfies CreateRequiredTaskDto);

  const countTasks = (title: string) => prisma.task.count({ where: { title } });

  beforeEach(async () => {
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix(API_PREFIX);
      await app.init();
      agent = await loginAgent(app);
      prisma = app.get(PrismaService);
      service = app.get(TasksService);
    }
    await cleanup();
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
    otherListId = (await prisma.list.create({ data: { name: `${PREFIX} other`, ownerId: LOCAL_OWNER_ID } }))
      .id;
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  describe('it creates the task AND the link', () => {
    it('creates a normal task and links it, returning the blocked task', async () => {
      const a = await task('A');
      const res = await post(a, { title: `${PREFIX} new prereq`, listId }).expect(201);

      const body = res.body as Task;
      expect(body.id).toBe(a); // the blocked task — the caller asked what A now requires
      expect(body.dependsOn).toHaveLength(1);

      const made = await prisma.task.findUniqueOrThrow({ where: { id: body.dependsOn[0]! } });
      expect(made.title).toBe(`${PREFIX} new prereq`);
      expect(made.ownerId).toBe(LOCAL_OWNER_ID); // stamped by the server (0039)
      expect(made.rating.toFixed(2)).toBe('1000.00'); // a normal task (0047)
      expect(made.status).toBe('active');
      expect(made.notBefore).toBeNull();
      expect(made.listId).toBe(listId);
    });

    it('puts the new task in the list that was CHOSEN, not the blocked task’s', async () => {
      // Nothing can move a task between lists yet, so the choice is made up front.
      const a = await task('A');
      const res = await post(a, { title: `${PREFIX} elsewhere`, listId: otherListId }).expect(201);
      const made = await prisma.task.findUniqueOrThrow({
        where: { id: (res.body as Task).dependsOn[0]! },
      });
      expect(made.listId).toBe(otherListId);
    });

    it('ADDS to existing dependencies rather than replacing them', async () => {
      const a = await task('A');
      const b = await task('B');
      await agent.patch(url(`/tasks/${a}`)).send({ dependsOn: [b] }).expect(200);

      const res = await post(a, { title: `${PREFIX} second`, listId }).expect(201);
      expect((res.body as Task).dependsOn).toHaveLength(2);
      expect((res.body as Task).dependsOn).toContain(b);
    });

    it('the new prerequisite gates the blocked task immediately', async () => {
      const a = await task('A');
      await post(a, { title: `${PREFIX} blocker`, listId }).expect(201);

      // Post-0070 the suite reads the real `local` owner, whose data may carry windows, so
      // the clock is required (fail-closed, owner-data-dependent).
      const today = await agent
        .get(url('/tasks/today?on=2026-07-20&at=12:00'))
        .expect(200);
      expect((today.body as Task[]).map((t) => t.id)).not.toContain(a);
    });

    it('trims the title', async () => {
      const a = await task('A');
      const res = await post(a, { title: `   ${PREFIX} trimmed   `, listId }).expect(201);
      const made = await prisma.task.findUniqueOrThrow({
        where: { id: (res.body as Task).dependsOn[0]! },
      });
      expect(made.title).toBe(`${PREFIX} trimmed`);
    });
  });

  describe('THE LOAD-BEARING ONE: all-or-nothing', () => {
    /**
     * FIRST, THE HONEST PART: the guard cannot currently refuse this link at all.
     *
     *   self-dependency — the new id is never the blocked id
     *   unknown id      — it exists; the transaction is passed in so the guard can see it
     *   a cycle         — the new task has no dependencies, so nothing is reachable from it
     *
     * So "force the link to fail with a cycle and watch the create roll back" is a test that
     * cannot be written: the path is unreachable through this endpoint. Claiming otherwise
     * would be a test whose name promises more than it does.
     *
     * The transaction is still worth having and worth proving. It is defence for the day a
     * guard CAN refuse — a new gate, a constraint, a future rule — and the only honest way
     * to prove a rollback whose trigger does not exist yet is to make the guard throw on
     * purpose. That is what these do.
     */
    it('rolls the CREATE back when the guard refuses — the orphan cannot survive', async () => {
      const a = await task('A');
      const before = await prisma.task.count();

      // Throw from inside the transaction, AFTER the task has been created. Without a real
      // transaction the task would survive with no link: the exact orphan this endpoint
      // exists to make impossible.
      const spy = vi
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .spyOn(service as any, 'assertDependenciesAreLegal')
        .mockRejectedValue(new BadRequestException('forced: pretend a future guard refused'));

      await expect(service.createRequired(a, { title: `${PREFIX} orphan`, listId })).rejects.toThrow(
        /forced/,
      );

      expect(spy).toHaveBeenCalled(); // the guard really did run, after the create
      expect(await countTasks(`${PREFIX} orphan`)).toBe(0); // ...and the task is GONE
      expect(await prisma.task.count()).toBe(before);
      expect(await prisma.taskDependency.count({ where: { taskId: a } })).toBe(0);
      spy.mockRestore();
    });

    // NOT TESTED, and worth saying why rather than leaving a gap: "the link write itself
    // fails" cannot be forced from here. Spying on `prisma.taskDependency.createMany` does
    // not work — inside the transaction the code calls `tx.taskDependency.createMany`, a
    // DIFFERENT object, so the spy never fires and the call simply succeeds. That attempt is
    // gone rather than left in place looking like coverage.
    //
    // Both directions are covered anyway: the test above proves a throw AFTER the create
    // rolls the create back, and the test below proves a refused list creates nothing. A
    // failed create leaves no link trivially — there is no id to link.

    it('creates nothing when the list is refused', async () => {
      // Reachable through the API, unlike the two above: the list check runs inside the
      // transaction, before the create. Proves ordering rather than rollback.
      const a = await task('A');
      await post(a, { title: `${PREFIX} nolist`, listId: '00000000-0000-0000-0000-000000000000' }).expect(
        400,
      );
      expect(await countTasks(`${PREFIX} nolist`)).toBe(0);
      expect(await prisma.taskDependency.count({ where: { taskId: a } })).toBe(0);
    });
  });

  describe('the guards still apply', () => {
    it('400s an empty title', async () => {
      const a = await task('A');
      await post(a, { title: '   ', listId }).expect(400);
    });

    it('400s a missing listId', async () => {
      const a = await task('A');
      await agent.post(url(`/tasks/${a}/requires`)).send({ title: 'x' }).expect(400);
    });

    it('400s a list that does not exist', async () => {
      const a = await task('A');
      await post(a, { title: `${PREFIX} x`, listId: '00000000-0000-0000-0000-000000000000' }).expect(400);
    });

    it('404s an unknown blocked task', async () => {
      await post('00000000-0000-0000-0000-000000000000', { title: `${PREFIX} x`, listId }).expect(404);
      expect(await countTasks(`${PREFIX} x`)).toBe(0); // and creates nothing
    });
  });
});
