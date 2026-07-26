import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DuelableCase } from '@rankati/shared';
import { AppModule } from '../src/app.module';
import { ArenaSessionService } from '../src/arena/arena-session.service';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * The SERVER half of the duelable agreement (v0.12), against the REAL dev Postgres — `pnpm db:up`
 * must be running. Proves the client's `isListDuelable` (apps/web/src/duelable.ts) agrees with what
 * the server actually accepts: `arena.start(listId)` returns `started` exactly when the list is
 * duelable, `need-more-tasks` otherwise.
 *
 * MIRRORED by `apps/web/test/duelable.spec.ts`. The `CASES` below MUST match that file's — their
 * SHAPE is pinned by the shared `DuelableCase` type; their VALUES are duplicated and cross-
 * referenced (0041 forbids sharing the runtime fixtures). **Change a case there, change it here.**
 *
 * The GATED case is the discriminator: a two-active list with one dependency-gated task must still
 * START — proving the Arena ranks importance gate-agnostically (0003; `eligibleWhere` applies no
 * gate filter). The web-only LOCATION case has no server counterpart: `StartSessionDto` carries
 * only `listId`, so the location filter never reaches the server — its location-agnosticism is
 * structural, not testable.
 */
const CASES: readonly DuelableCase[] = [
  { label: 'two plain active tasks', active: ['plain', 'plain'], duelable: true },
  { label: 'two active, one GATED (a dependency) — still duelable (0003)', active: ['plain', 'gated'], duelable: true },
  { label: 'one active task', active: ['plain'], duelable: false },
  { label: 'empty list', active: [], duelable: false },
];

const PREFIX = '__duelagree__';

describe('duelable agreement — server start() matches the client predicate (real Postgres)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let arena: ArenaSessionService;
  let prisma: PrismaService;
  let prereqId: string; // an active prerequisite, in its own list, to gate tasks against

  async function buildApp() {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return { app, arena: app.get(ArenaSessionService), prisma: app.get(PrismaService) };
  }

  async function cleanup() {
    if (!prisma) return;
    // TaskDependency cascades on task delete (schema onDelete: Cascade), so deleting the tasks
    // clears their gates; then the lists.
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  /** A fresh list holding the case's active tasks; a 'gated' one is blocked by the prereq. */
  async function makeList(active: readonly ('plain' | 'gated')[]): Promise<string> {
    const list = await prisma.list.create({
      data: { name: `${PREFIX} L ${randomUUID()}`, ownerId: LOCAL_OWNER_ID },
    });
    for (const gate of active) {
      const t = await prisma.task.create({
        data: { title: `${PREFIX} t`, listId: list.id, ownerId: LOCAL_OWNER_ID },
      });
      if (gate === 'gated') {
        await prisma.taskDependency.create({ data: { taskId: t.id, dependsOnId: prereqId } });
      }
    }
    return list.id;
  }

  beforeAll(async () => {
    ({ app, arena, prisma } = await buildApp());
    await cleanup();
    const prereqList = await prisma.list.create({
      data: { name: `${PREFIX} prereq`, ownerId: LOCAL_OWNER_ID },
    });
    prereqId = (
      await prisma.task.create({
        data: { title: `${PREFIX} prereq task`, listId: prereqList.id, ownerId: LOCAL_OWNER_ID },
      })
    ).id;
  });

  afterAll(async () => {
    arena.discard();
    await cleanup();
    await app?.close();
  });

  for (const c of CASES) {
    it(`${c.label} -> ${c.duelable ? 'started' : 'need-more-tasks'}`, async () => {
      const listId = await makeList(c.active);
      const outcome = await arena.start(listId);
      expect(outcome.status === 'started').toBe(c.duelable);
    });
  }

  it('the gated fixture is genuinely gated — else the case proves nothing about gate-agnosticism', async () => {
    const listId = await makeList(['plain', 'gated']);
    const gated = await prisma.task.findMany({ where: { listId, blockedBy: { some: {} } } });
    expect(gated.length).toBe(1); // exactly the one 'gated' task carries a dependency
    // ...and start() still opened for it (the case above), so a real gate did not exclude it.
  });
});
