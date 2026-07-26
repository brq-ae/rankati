import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Location, StartSessionResult, Task } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * Tagging a task with locations (ADR 0060): a full-set REPLACE on PATCH /tasks/:id, exactly like
 * dependsOn (0053). Plus the milestone's HEADLINE regression guard — location must never reach the
 * Arena — framed honestly as a guard, not a load-bearing filter test.
 */
const PREFIX = '__task_loc__';

describe('Tagging tasks with locations (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let listId: string;
  const url = (p: string) => `/${API_PREFIX}${p}`;

  async function cleanup() {
    await prisma.taskLocation.deleteMany({ where: { location: { name: { startsWith: PREFIX } } } });
    await prisma.location.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { ownerId: { startsWith: PREFIX } } });
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  const patch = (p: string, body: object) => agent.patch(url(p)).send(body);
  const createLoc = async (name: string): Promise<Location> =>
    (await agent.post(url('/locations')).send({ name: `${PREFIX}${name}` }).expect(201))
      .body;
  const createTask = async (name: string): Promise<string> =>
    (await prisma.task.create({ data: { title: `${PREFIX}${name}`, listId, ownerId: LOCAL_OWNER_ID } })).id;
  const locationsOf = async (taskId: string): Promise<string[]> => {
    const res = await agent.get(url('/tasks')).expect(200);
    return (res.body as Task[]).find((t) => t.id === taskId)!.locationIds;
  };

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    agent = await loginAgent(app);
    prisma = app.get(PrismaService);
  });
  beforeEach(async () => {
    await cleanup();
    listId = (await prisma.list.create({ data: { name: `${PREFIX}l`, ownerId: LOCAL_OWNER_ID } })).id;
  });
  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  it('REPLACES the whole set — the three states of locationIds (0060)', async () => {
    const a = await createLoc('A');
    const b = await createLoc('B');
    const t = await createTask('t');

    await patch(`/tasks/${t}`, { locationIds: [a.id] }).expect(200);
    expect(await locationsOf(t)).toEqual([a.id]);

    await patch(`/tasks/${t}`, { locationIds: [a.id, b.id] }).expect(200); // add b
    expect((await locationsOf(t)).sort()).toEqual([a.id, b.id].sort());

    await patch(`/tasks/${t}`, { locationIds: [b.id] }).expect(200); // replace -> just b
    expect(await locationsOf(t)).toEqual([b.id]);

    // An absent locationIds leaves the tags untouched (only the title changes).
    await patch(`/tasks/${t}`, { title: `${PREFIX}renamed` }).expect(200);
    expect(await locationsOf(t)).toEqual([b.id]);

    await patch(`/tasks/${t}`, { locationIds: [] }).expect(200); // clear
    expect(await locationsOf(t)).toEqual([]);
  });

  it('de-dupes a repeated id (the same tag twice is one tag)', async () => {
    const a = await createLoc('A');
    const t = await createTask('t');
    await patch(`/tasks/${t}`, { locationIds: [a.id, a.id] }).expect(200);
    expect(await locationsOf(t)).toEqual([a.id]);
  });

  it('an unknown location id is 400 (naming it), and changes nothing', async () => {
    const a = await createLoc('A');
    const t = await createTask('t');
    await patch(`/tasks/${t}`, { locationIds: [a.id] }).expect(200);
    await patch(`/tasks/${t}`, { locationIds: [a.id, 'no-such'] }).expect(400);
    expect(await locationsOf(t)).toEqual([a.id]); // unchanged
  });

  it('OWNER-SCOPED: tagging with ANOTHER owner’s location id is 400, not a silent success', async () => {
    // The leak this guards against the day auth lands (0026, 0039). assertLocationsExist filters
    // by ownerId, so a foreign id is "no such location" rather than a tag that quietly works.
    const theirs = await prisma.location.create({
      data: { name: `${PREFIX}Foreign`, ownerId: `${PREFIX}other` },
    });
    const t = await createTask('t');
    await patch(`/tasks/${t}`, { locationIds: [theirs.id] }).expect(400);
    expect(await locationsOf(t)).toEqual([]);
  });

  it('the wire carries locationIds on every task read', async () => {
    const a = await createLoc('A');
    const t = await createTask('t');
    await patch(`/tasks/${t}`, { locationIds: [a.id] }).expect(200);
    const res = await agent.get(url('/tasks')).expect(200);
    for (const task of res.body as Task[]) {
      expect(Array.isArray(task.locationIds)).toBe(true);
    }
  });

  it('REGRESSION GUARD: tagging a location does NOT remove a task from the Arena pool', async () => {
    // This cannot fail today: the location filter is CLIENT-SIDE (0060), so it never reaches the
    // server and eligibleWhere() has no location clause — the Arena is unfiltered BY CONSTRUCTION.
    // The test exists to go RED the day someone adds a location filter to the duel pool. With
    // exactly two active tasks in a fresh list, a session must still deal a pair; if tagging
    // excluded the tagged task, the pool would drop to one and return need-more-tasks.
    const garage = await createLoc('Garage');
    const t1 = await createTask('duel one');
    await createTask('duel two');
    await patch(`/tasks/${t1}`, { locationIds: [garage.id] }).expect(200);

    const res = await agent
      .post(url('/duel-sessions'))
      .send({ listId })
      .expect(200);
    const body = res.body as StartSessionResult;
    expect(body.status).toBe('started'); // a pair was dealt — the tagged task is still eligible
  });
});
