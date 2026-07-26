import { randomUUID } from 'node:crypto';
import { NotFoundException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { ListsService } from '../src/lists.service';
import { PrismaService } from '../src/prisma.service';

/**
 * DELETE /lists/:id (ADR 0064). Two properties matter and neither is read off the schema:
 *
 *  1. OWNER SCOPING, sabotaged in the LETHAL direction — a list-delete that forgets its scope deletes
 *     more than asked. The boundary test uses a throwaway owner and reds if dropping the scope lets
 *     that owner's list vanish. (No test targets `local` for the owner-boundary work — ADR 0064.)
 *  2. The CASCADE CHAIN actually fires. `Task -> List` is a declared cascade, but whether the
 *     SECOND-ORDER cascades (task -> dependency link, task -> location tag) chain through a LIST
 *     delete is verified against the real database, not trusted.
 *
 * The id-scoped happy path (B) uses a prefixed `local` list — the established pattern for per-row
 * deletes (cf. locations-api.spec's location delete), distinct from the reset's owner-wide wipe: a
 * single id-scoped delete cannot eat unrelated data, so prefix isolation is sufficient here.
 */
const LP = '__listdel__'; // local prefixed rows
const OP = '__listdel_own__'; // throwaway owners

describe('DELETE /lists/:id (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let lists: ListsService;
  const url = (p: string) => `/${API_PREFIX}${p}`;
  const del = (p: string) => agent.delete(url(p));

  async function cleanup(): Promise<void> {
    // Throwaway owners: duels then tasks (cascades deps/tags) then lists/locations.
    await prisma.duel.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.task.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.list.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.location.deleteMany({ where: { ownerId: { startsWith: OP } } });
    // Local prefixed rows (test B): deleting the tasks cascades their duels/deps/tags.
    await prisma.task.deleteMany({ where: { title: { startsWith: LP } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: LP } } });
  }

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    agent = await loginAgent(app);
    prisma = app.get(PrismaService);
    lists = app.get(ListsService);
    await cleanup();
  });

  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('cascades through tasks to their dependency links AND location tags (the location itself survives)', async () => {
    const o = `${OP}${randomUUID()}`;
    const list = await prisma.list.create({ data: { name: 'L', ownerId: o } });
    const t1 = await prisma.task.create({ data: { title: 'T1', listId: list.id, ownerId: o } });
    const t2 = await prisma.task.create({ data: { title: 'T2', listId: list.id, ownerId: o } });
    await prisma.taskDependency.create({ data: { taskId: t2.id, dependsOnId: t1.id } });
    const loc = await prisma.location.create({ data: { name: `P-${randomUUID()}`, ownerId: o } });
    await prisma.taskLocation.create({ data: { taskId: t1.id, locationId: loc.id } });
    await prisma.duel.create({
      data: { winnerId: t1.id, loserId: t2.id, sessionId: randomUUID(), kWinner: 24, kLoser: 24, ownerId: o },
    });

    // The rows exist before, or "gone" would prove nothing.
    expect(await prisma.taskDependency.count({ where: { task: { ownerId: o } } })).toBe(1);
    expect(await prisma.taskLocation.count({ where: { task: { ownerId: o } } })).toBe(1);
    expect(await prisma.duel.count({ where: { ownerId: o } })).toBe(1);

    await prisma.list.delete({ where: { id: list.id } });

    // The chain fired: list -> tasks -> (deps, tags, duels) all gone...
    expect(await prisma.task.count({ where: { ownerId: o } })).toBe(0);
    expect(await prisma.taskDependency.count({ where: { task: { ownerId: o } } })).toBe(0);
    expect(await prisma.taskLocation.count({ where: { task: { ownerId: o } } })).toBe(0);
    expect(await prisma.duel.count({ where: { ownerId: o } })).toBe(0);
    // ...but the LOCATION row survives — a list delete untags, it does not delete places (0061 shape).
    expect(await prisma.location.count({ where: { ownerId: o } })).toBe(1);
  });

  it('owner boundary: the service refuses a list that is not the local owner’s (404, and it survives)', async () => {
    const other = `${OP}${randomUUID()}`;
    const list = await prisma.list.create({ data: { name: 'other-L', ownerId: other } });

    // Sabotage guard: dropping `ownerId` from the service's findFirst makes THIS reject-and-survive
    // become a delete — the lethal over-delete direction. Bite-tested in the step-4 sabotage run.
    await expect(lists.remove(list.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await prisma.list.findUnique({ where: { id: list.id } })).not.toBeNull();
  });

  it('endpoint removes a list and its tasks (id-scoped happy path)', async () => {
    const list = await prisma.list.create({ data: { name: `${LP}L`, ownerId: LOCAL_OWNER_ID } });
    const task = await prisma.task.create({
      data: { title: `${LP}T`, listId: list.id, ownerId: LOCAL_OWNER_ID },
    });

    await del(`/lists/${list.id}`).expect(204);

    expect(await prisma.list.findUnique({ where: { id: list.id } })).toBeNull();
    expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
  });

  it('unknown id -> 404', async () => {
    await del(`/lists/${randomUUID()}`).expect(404);
  });
});
