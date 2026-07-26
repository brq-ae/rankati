import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Task, UpdateTaskDto } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * Setting dependencies, and the guard that makes cycles unrepresentable (ADR 0053).
 *
 * The cycle tests are the point of the milestone. A -> B -> A means neither task can ever
 * reach Today — silently, looking exactly like the gate working — so the check runs before
 * the link is written and the state simply cannot exist through the API.
 *
 * These go through HTTP deliberately. The gate's read tests insert links straight through
 * Prisma, which BYPASSES this check (0053's addendum says so out loud); here the point is
 * the door itself.
 */
const PREFIX = '__depwrite__';

describe('PATCH /tasks/:id { dependsOn } (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let listId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  async function task(name: string): Promise<string> {
    const t = await prisma.task.create({
      data: { title: `${PREFIX} ${name}`, listId, ownerId: LOCAL_OWNER_ID },
    });
    return t.id;
  }

  const patch = (id: string, dto: UpdateTaskDto) =>
    agent.patch(url(`/tasks/${id}`)).send(dto satisfies UpdateTaskDto);

  const linksOf = (taskId: string) =>
    prisma.taskDependency.findMany({ where: { taskId }, select: { dependsOnId: true } });

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

  describe('the set-replace, and its three states (0053)', () => {
    it('[ids] sets exactly that set', async () => {
      const a = await task('a');
      const b = await task('b');
      const c = await task('c');

      const res = await patch(a, { dependsOn: [b, c] }).expect(200);
      expect((res.body as Task).dependsOn.sort()).toEqual([b, c].sort());
      expect((await linksOf(a)).map((l) => l.dependsOnId).sort()).toEqual([b, c].sort());
    });

    it('replaces rather than adds', async () => {
      const a = await task('a');
      const b = await task('b');
      const c = await task('c');

      await patch(a, { dependsOn: [b] }).expect(200);
      const res = await patch(a, { dependsOn: [c] }).expect(200);

      // b is gone: the set was replaced, not extended.
      expect((res.body as Task).dependsOn).toEqual([c]);
    });

    it('[] clears them all', async () => {
      const a = await task('a');
      const b = await task('b');
      await patch(a, { dependsOn: [b] }).expect(200);

      const res = await patch(a, { dependsOn: [] }).expect(200);
      expect((res.body as Task).dependsOn).toEqual([]);
      expect(await linksOf(a)).toHaveLength(0);
    });

    it('ABSENT leaves them exactly as they are', async () => {
      const a = await task('a');
      const b = await task('b');
      await patch(a, { dependsOn: [b] }).expect(200);

      // Renaming must not touch the gate. Absent and null/[] mean different things.
      const res = await patch(a, { title: `${PREFIX} a renamed` }).expect(200);
      expect((res.body as Task).title).toBe(`${PREFIX} a renamed`);
      expect((res.body as Task).dependsOn).toEqual([b]);
    });

    it('an empty PATCH is still a 400', async () => {
      const a = await task('a');
      await patch(a, {}).expect(400);
    });

    it('the same id twice is one link, not an error', async () => {
      const a = await task('a');
      const b = await task('b');
      const res = await patch(a, { dependsOn: [b, b] }).expect(200);
      expect((res.body as Task).dependsOn).toEqual([b]);
    });
  });

  describe('cycles are refused, and the refusal is useful (0053)', () => {
    it('refuses the direct loop A -> B when B already depends on A', async () => {
      const a = await task('a');
      const b = await task('b');
      await patch(b, { dependsOn: [a] }).expect(200); // B waits for A

      const res = await patch(a, { dependsOn: [b] }).expect(400); // A waits for B?

      const message = JSON.stringify(res.body);
      expect(message).toMatch(/loop/i);
      // The path, in titles, so the refusal can be acted on rather than just obeyed.
      expect(message).toContain(`${PREFIX} a`);
      expect(message).toContain(`${PREFIX} b`);
      // And nothing was written.
      expect(await linksOf(a)).toHaveLength(0);
    });

    it('refuses a LONG loop: A -> B -> C -> A', async () => {
      const a = await task('a');
      const b = await task('b');
      const c = await task('c');
      await patch(b, { dependsOn: [c] }).expect(200); // B waits for C
      await patch(c, { dependsOn: [a] }).expect(200); // C waits for A

      // A waiting for B would close the ring — the check must WALK, not just look one hop.
      const res = await patch(a, { dependsOn: [b] }).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/loop/i);
      expect(await linksOf(a)).toHaveLength(0);
    });

    it('names every task in the loop it would close', async () => {
      const a = await task('a');
      const b = await task('b');
      const c = await task('c');
      await patch(b, { dependsOn: [c] }).expect(200);
      await patch(c, { dependsOn: [a] }).expect(200);

      const res = await patch(a, { dependsOn: [b] }).expect(400);
      const message = JSON.stringify(res.body);
      for (const name of ['a', 'b', 'c']) expect(message).toContain(`${PREFIX} ${name}`);
    });

    it('ALLOWS a diamond — two paths to the same task is not a cycle', async () => {
      // A -> B, A -> C, B -> D, C -> D. Reachable twice, looping never.
      const d = await task('d');
      const b = await task('b');
      const c = await task('c');
      const a = await task('a');
      await patch(b, { dependsOn: [d] }).expect(200);
      await patch(c, { dependsOn: [d] }).expect(200);
      await patch(a, { dependsOn: [b, c] }).expect(200);

      expect((await linksOf(a)).map((l) => l.dependsOnId).sort()).toEqual([b, c].sort());
    });

    it('rejects a loop even when the task already has unrelated dependencies', async () => {
      // HONEST LIMIT: this does NOT prove the walk judges the NEW set rather than the old
      // one. It cannot — the stored graph is always acyclic (that is the invariant this
      // check maintains), so a task's existing links can never form a path back to itself.
      // Keeping them or discarding them gives the same verdict, always. Sabotaging the
      // replace into an add leaves this suite green, which is how that was found.
      //
      // What it DOES prove: an unrelated existing link does not mask a real loop.
      const a = await task('a');
      const b = await task('b');
      const c = await task('c');
      await patch(a, { dependsOn: [b] }).expect(200);
      await patch(c, { dependsOn: [a] }).expect(200); // C waits for A — fine so far

      // A waiting for C closes the loop, even though A's CURRENT set has nothing to do with C.
      await patch(a, { dependsOn: [c] }).expect(400);
      expect((await linksOf(a)).map((l) => l.dependsOnId)).toEqual([b]); // untouched
    });
  });

  describe('the other guards', () => {
    it('refuses a task depending on itself', async () => {
      const a = await task('a');
      const res = await patch(a, { dependsOn: [a] }).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/itself/i);
    });

    it('refuses an id that is not a task', async () => {
      const a = await task('a');
      const res = await patch(a, { dependsOn: ['00000000-0000-0000-0000-000000000000'] }).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/no such task/i);
      expect(await linksOf(a)).toHaveLength(0);
    });

    it('refuses a dependsOn that is not an array of ids', async () => {
      const a = await task('a');
      await agent.patch(url(`/tasks/${a}`)).send({ dependsOn: 'nope' }).expect(400);
      await agent.patch(url(`/tasks/${a}`)).send({ dependsOn: [42] }).expect(400);
    });

    it('404s an unknown task', async () => {
      const b = await task('b');
      await agent
        .patch(url('/tasks/00000000-0000-0000-0000-000000000000'))
        .send({ dependsOn: [b] })
        .expect(404);
    });
  });
});
