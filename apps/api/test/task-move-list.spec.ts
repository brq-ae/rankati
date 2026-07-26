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
 * PATCH /tasks/:id { listId } — move a task between lists (ADR 0056 follow-on).
 *
 * The load-bearing claim is the INVARIANT: a move changes ONLY the list. Lists are
 * organizational; the rating is earned and the dependencies are logical, so none of them move
 * with the task — and a dependency that crosses lists survives, because the link is between task
 * ids, not lists. Both are proven here against real Postgres, not asserted.
 */
const PREFIX = '__move_list__';

describe('PATCH /tasks/:id — move between lists (0056, real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let list1: string;
  let list2: string;
  let list3: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;
  const patch = (id: string, body: unknown) =>
    agent.patch(url(`/tasks/${id}`)).send(body as object);

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  const list = async (n: string): Promise<string> =>
    (await prisma.list.create({ data: { name: `${PREFIX} ${n}`, ownerId: LOCAL_OWNER_ID } })).id;
  const task = async (listId: string, over: Record<string, unknown> = {}): Promise<string> =>
    (await prisma.task.create({ data: { title: `${PREFIX} t`, listId, ownerId: LOCAL_OWNER_ID, ...over } })).id;

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
    [list1, list2, list3] = [await list('one'), await list('two'), await list('three')];
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  it('moves the task to the target list', async () => {
    const a = await task(list1);
    const res = await patch(a, { listId: list2 }).expect(200);
    expect((res.body as Task).listId).toBe(list2);
  });

  it('400s an unknown target list, and does not move', async () => {
    const a = await task(list1);
    await patch(a, { listId: '00000000-0000-0000-0000-000000000000' }).expect(400);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: a } })).listId).toBe(list1);
  });

  it('changes ONLY listId — rating, duelCount, dates, tier, dependencies all intact', async () => {
    const b = await task(list1); // a prerequisite it will keep
    const a = await task(list1, {
      notBefore: new Date('2026-07-18'),
      due: new Date('2026-07-25'),
      tier: 'critical',
      rating: 1234.56,
      duelCount: 7,
    });
    await prisma.taskDependency.create({ data: { taskId: a, dependsOnId: b } });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: a } });

    await patch(a, { listId: list2 }).expect(200);
    const after = await prisma.task.findUniqueOrThrow({ where: { id: a } });

    expect(after.listId).toBe(list2); // moved...
    // ...and EVERYTHING else is byte-identical.
    const strip = (t: typeof before) => {
      const { listId: _listId, ...rest } = t;
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
    // rating and duelCount called out explicitly — the earned state the move must not disturb.
    expect(after.rating.toString()).toBe('1234.56');
    expect(after.duelCount).toBe(7);
    // the dependency is still there.
    const deps = await prisma.taskDependency.findMany({ where: { taskId: a } });
    expect(deps.map((d) => d.dependsOnId)).toEqual([b]);
  });

  it('a CROSS-LIST dependency survives the move (A in list2 requires B in list1, move A to list3)', async () => {
    const b = await task(list1);
    const a = await task(list2);
    await prisma.taskDependency.create({ data: { taskId: a, dependsOnId: b } });

    await patch(a, { listId: list3 }).expect(200);

    // The link is between task ids, not lists — moving A does not touch it.
    const deps = await prisma.taskDependency.findMany({ where: { taskId: a } });
    expect(deps.map((d) => d.dependsOnId)).toEqual([b]);
    // and B has not moved.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: b } })).listId).toBe(list1);
  });
});
