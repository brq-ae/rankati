import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Location, Task } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * The managed location set over HTTP against real Postgres (ADRs 0060, 0061): create, rename,
 * delete-untag, merge, case-insensitive uniqueness, and OWNER-SCOPING asserted rather than assumed.
 */
const PREFIX = '__loc_api__';

describe('Locations API (real Postgres)', () => {
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

  const post = (p: string, body: object) => agent.post(url(p)).send(body);
  const patch = (p: string, body: object) => agent.patch(url(p)).send(body);
  const del = (p: string) => agent.delete(url(p));
  const locations = async (): Promise<Location[]> =>
    ((await agent.get(url('/locations')).expect(200)).body as Location[]).filter(
      (l) => l.name.startsWith(PREFIX),
    );
  const tasks = async (): Promise<Task[]> =>
    ((await agent.get(url('/tasks')).expect(200)).body as Task[]).filter((t) =>
      t.title.startsWith(PREFIX),
    );
  const createLoc = async (name: string): Promise<Location> =>
    (await post('/locations', { name: `${PREFIX}${name}` }).expect(201)).body;
  const createTask = async (name: string): Promise<string> =>
    (
      await prisma.task.create({ data: { title: `${PREFIX}${name}`, listId, ownerId: LOCAL_OWNER_ID } })
    ).id;
  const tag = (taskId: string, locationIds: string[]) =>
    patch(`/tasks/${taskId}`, { locationIds }).expect(200);

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

  it('creates, lists (name-ordered), and stores the capitalisation as typed', async () => {
    await post('/locations', { name: `${PREFIX}Garage` }).expect(201);
    await post('/locations', { name: `${PREFIX}Attic` }).expect(201);
    const names = (await locations()).map((l) => l.name);
    expect(names).toEqual([`${PREFIX}Attic`, `${PREFIX}Garage`]); // asc
  });

  it('rejects a blank name (400)', async () => {
    await post('/locations', { name: '   ' }).expect(400);
  });

  describe('case-insensitive uniqueness (0061)', () => {
    it('refuses a case-variant duplicate on CREATE (400)', async () => {
      await createLoc('Garage');
      await post('/locations', { name: `${PREFIX}garage` }).expect(400);
      await post('/locations', { name: `${PREFIX}GARAGE` }).expect(400);
      expect(await locations()).toHaveLength(1);
    });

    it('refuses a case-variant duplicate on RENAME (400), but lets a location keep its own name', async () => {
      const garage = await createLoc('Garage');
      await createLoc('Attic');
      // Rename Attic -> "garage" clashes with Garage.
      const attic = (await locations()).find((l) => l.name === `${PREFIX}Attic`)!;
      await patch(`/locations/${attic.id}`, { name: `${PREFIX}garage` }).expect(400);
      // But renaming Garage to its own name in a new case is allowed (excludes self).
      await patch(`/locations/${garage.id}`, { name: `${PREFIX}GARAGE` }).expect(200);
    });

    it('renaming an unknown id is 404', async () => {
      await patch('/locations/no-such-id', { name: `${PREFIX}X` }).expect(404);
    });
  });

  it('DELETE removes the location and untags its tasks — the tasks survive (0061)', async () => {
    const garage = await createLoc('Garage');
    const t = await createTask('fix shelf');
    await tag(t, [garage.id]);
    expect((await tasks()).find((x) => x.id === t)!.locationIds).toEqual([garage.id]);

    await del(`/locations/${garage.id}`).expect(204);

    expect((await locations()).some((l) => l.id === garage.id)).toBe(false);
    const survivor = (await tasks()).find((x) => x.id === t);
    expect(survivor).toBeTruthy(); // task still exists...
    expect(survivor!.locationIds).toEqual([]); // ...just untagged
  });

  describe('merge (0061)', () => {
    it('folds source into target, dedups a both-tagged task, and deletes the source', async () => {
      const source = await createLoc('The Garage');
      const target = await createLoc('Garage');
      const onlySource = await createTask('onlySource');
      const both = await createTask('both');
      await tag(onlySource, [source.id]);
      await tag(both, [source.id, target.id]); // tagged BOTH

      await post('/locations/merge', { sourceId: source.id, targetId: target.id }).expect(201);

      expect((await locations()).some((l) => l.id === source.id)).toBe(false); // source gone
      const after = await tasks();
      expect(after.find((t) => t.id === onlySource)!.locationIds).toEqual([target.id]); // retagged
      // The both-tagged task ends with a SINGLE target link — skipDuplicates, no duplicate PK.
      expect(after.find((t) => t.id === both)!.locationIds).toEqual([target.id]);
    });

    it('refuses same source and target (400)', async () => {
      const g = await createLoc('Garage');
      await post('/locations/merge', { sourceId: g.id, targetId: g.id }).expect(400);
    });

    it('a bad target is 400 and changes NOTHING (no half-move)', async () => {
      const source = await createLoc('The Garage');
      const t = await createTask('x');
      await tag(t, [source.id]);
      await post('/locations/merge', { sourceId: source.id, targetId: 'no-such' }).expect(400);
      // Source still exists, task still tagged source — the transaction never began.
      expect((await locations()).some((l) => l.id === source.id)).toBe(true);
      expect((await tasks()).find((x) => x.id === t)!.locationIds).toEqual([source.id]);
    });
  });

  describe('owner-scoping — asserted, not assumed (0026, 0039)', () => {
    // A location belonging to ANOTHER owner. Inert today (one local owner), but this is exactly
    // what leaks the day auth lands if the scoping is trusted rather than enforced.
    const foreignLoc = () =>
      prisma.location.create({ data: { name: `${PREFIX}Foreign`, ownerId: `${PREFIX}other` } });

    it('merge refuses a SOURCE that is not the owner’s (400)', async () => {
      const mine = await createLoc('Mine');
      const theirs = await foreignLoc();
      await post('/locations/merge', { sourceId: theirs.id, targetId: mine.id }).expect(400);
      expect(await prisma.location.findUnique({ where: { id: theirs.id } })).toBeTruthy(); // untouched
    });

    it('merge refuses a TARGET that is not the owner’s (400)', async () => {
      const mine = await createLoc('Mine');
      const theirs = await foreignLoc();
      await post('/locations/merge', { sourceId: mine.id, targetId: theirs.id }).expect(400);
    });

    it('rename and delete of another owner’s location are 404 (not found under my scope)', async () => {
      const theirs = await foreignLoc();
      await patch(`/locations/${theirs.id}`, { name: `${PREFIX}Renamed` }).expect(404);
      await del(`/locations/${theirs.id}`).expect(404);
      expect(await prisma.location.findUnique({ where: { id: theirs.id } })).toBeTruthy(); // still there
    });
  });
});
