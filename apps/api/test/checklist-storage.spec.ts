import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * How a ChecklistItem and Task.needsHand survive the trip through Prisma (ADR 0071).
 *
 * Both are INERT storage in this slice — a real related table for the checklist (the house
 * pattern already set by TaskDependency, 0053, and TaskLocation, 0061), and a plain boolean
 * column for needsHand (like `tier`, 0056). Neither gates anything: nothing here touches
 * Today, Upcoming, Lists, or the Arena. What this asserts is the storage's two load-bearing
 * facts — text/done/position round-trip unchanged, and a task's checklist is gone the moment
 * the task is (cascade), so an item never outlives its task.
 */

const PREFIX = '__checklist_storage__';

describe('checklist storage: items round-trip, and needsHand is a plain boolean (0071)', () => {
  let app: Awaited<ReturnType<typeof build>>['app'];
  let prisma: PrismaService;
  let listId: string;

  async function build() {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = m.createNestApplication();
    await app.init();
    return { app, prisma: app.get(PrismaService) };
  }

  async function cleanup() {
    // ChecklistItem cascades off Task, but delete it explicitly first for any row a
    // failed run left behind without its parent (defensive, not load-bearing here).
    await prisma.checklistItem.deleteMany({ where: { text: { startsWith: PREFIX } } });
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    ({ app, prisma } = await build());
    await cleanup();
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  describe('ChecklistItem', () => {
    it('round-trips text, done and position unchanged', async () => {
      const task = await prisma.task.create({
        data: { title: `${PREFIX} item round-trip`, listId, ownerId: LOCAL_OWNER_ID },
      });
      const item = await prisma.checklistItem.create({
        data: { taskId: task.id, text: `${PREFIX} bring the tripod`, done: true, position: 2 },
      });
      const back = await prisma.checklistItem.findUniqueOrThrow({ where: { id: item.id } });

      expect(back.text).toBe(`${PREFIX} bring the tripod`);
      expect(back.done).toBe(true);
      expect(back.position).toBe(2);
      expect(back.taskId).toBe(task.id);
    });

    it('`done` defaults to false when omitted', async () => {
      const task = await prisma.task.create({
        data: { title: `${PREFIX} item default done`, listId, ownerId: LOCAL_OWNER_ID },
      });
      const item = await prisma.checklistItem.create({
        data: { taskId: task.id, text: `${PREFIX} untouched`, position: 0 },
      });
      const back = await prisma.checklistItem.findUniqueOrThrow({ where: { id: item.id } });

      expect(back.done).toBe(false);
    });

    it('cascade: deleting the task deletes its checklist items with it', async () => {
      const task = await prisma.task.create({
        data: { title: `${PREFIX} item cascade`, listId, ownerId: LOCAL_OWNER_ID },
      });
      await prisma.checklistItem.createMany({
        data: [
          { taskId: task.id, text: `${PREFIX} c1`, position: 0 },
          { taskId: task.id, text: `${PREFIX} c2`, position: 1 },
          { taskId: task.id, text: `${PREFIX} c3`, position: 2 },
        ],
      });
      expect(await prisma.checklistItem.count({ where: { taskId: task.id } })).toBe(3);

      await prisma.task.delete({ where: { id: task.id } });

      expect(await prisma.checklistItem.count({ where: { taskId: task.id } })).toBe(0);
    });
  });

  describe('Task.needsHand', () => {
    it('defaults to false on a task created without it', async () => {
      const task = await prisma.task.create({
        data: { title: `${PREFIX} needsHand default`, listId, ownerId: LOCAL_OWNER_ID },
      });
      const back = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });

      expect(back.needsHand).toBe(false);
    });

    it('round-trips true unchanged', async () => {
      const task = await prisma.task.create({
        data: { title: `${PREFIX} needsHand true`, listId, ownerId: LOCAL_OWNER_ID, needsHand: true },
      });
      const back = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });

      expect(back.needsHand).toBe(true);
    });
  });
});
