import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Task, TaskTier } from '@rankati/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * Backward urgency propagation in the reads (ADR 0059), over HTTP against real Postgres. Every
 * date is INJECTED. `X <- Y` (X blocked by Y) is written as a TaskDependency {taskId: X,
 * dependsOnId: Y}: X depends on Y, so Y's descendants carry X's urgency backward.
 */
const PREFIX = '__prop__';
const ON = '2026-07-19';
const dueIn = (n: number): string =>
  new Date(Date.parse(`${ON}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('propagation in Today/Upcoming (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let listId: string;
  const url = (p: string) => `/${API_PREFIX}${p}`;

  async function cleanup() {
    if (!prisma) return;
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  const task = async (
    name: string,
    o: { due?: string | null; tier?: TaskTier; rating?: number } = {},
  ): Promise<string> =>
    (
      await prisma.task.create({
        data: {
          title: `${PREFIX} ${name}`,
          listId,
          ownerId: LOCAL_OWNER_ID,
          rating: o.rating ?? 1000,
          tier: o.tier ?? 'normal',
          due: o.due ? new Date(o.due) : null,
        },
      })
    ).id;
  /** `blocked` is blocked by `by` (blocked.dependsOn = [by]). */
  const block = (blocked: string, by: string) =>
    prisma.taskDependency.create({ data: { taskId: blocked, dependsOnId: by } });

  // Post-0070 the suite reads the real `local` owner, whose data may carry windows, so the
  // clock is required (fail-closed, owner-data-dependent).
  const read = async (tab: 'today' | 'upcoming'): Promise<Task[]> => {
    const res = await agent.get(url(`/tasks/${tab}?on=${ON}&at=12:00`)).expect(200);
    return (res.body as Task[]).filter((t) => t.title.startsWith(PREFIX));
  };
  const ids = async (tab: 'today' | 'upcoming') => (await read(tab)).map((t) => t.id);

  beforeEach(async () => {
    if (!app) {
      const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = m.createNestApplication();
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

  it('pulls a blocker from Upcoming INTO Today by inherited urgency, and names the source', async () => {
    const B = await task('B', { due: dueIn(20), tier: 'super_important' }); // own place: Upcoming (20 > 7)
    const A = await task('A', { due: dueIn(2), tier: 'critical' }); // the deadline
    await block(A, B); // A blocked by B → B carries A's urgency; A is hidden

    const today = await read('today');
    const b = today.find((t) => t.id === B);
    expect(b).toBeTruthy(); // B is in Today, not Upcoming...
    expect(b?.urgencySourceId).toBe(A); // ...and it names the deadline A
    expect(await ids('upcoming')).not.toContain(B);
    expect(await ids('today')).not.toContain(A); // A stays hidden (blocked)
  });

  it('the actionable end of a chain rises, carrying the ULTIMATE deadline as source', async () => {
    const A = await task('A', { due: dueIn(2), tier: 'critical' });
    const B = await task('B');
    const C = await task('C', { rating: 900 });
    await block(A, B); // A <- B
    await block(B, C); // B <- C ; C is actionable
    const today = await read('today');
    const c = today.find((t) => t.id === C);
    expect(c?.urgencySourceId).toBe(A); // the source is A, through B
    expect(await ids('today')).not.toContain(A);
    expect(await ids('today')).not.toContain(B);
  });

  it('highest wins: a blocker of two deadlines ranks by the nearer one', async () => {
    const A = await task('A', { due: dueIn(2), tier: 'critical' });
    const X = await task('X', { due: dueIn(1), tier: 'critical' }); // nearer
    const C = await task('C');
    await block(A, C);
    await block(X, C);
    const c = (await read('today')).find((t) => t.id === C);
    expect(c?.urgencySourceId).toBe(X); // the nearer deadline, not A, not both
  });

  describe('inheritance vanishes when the source goes (0059)', () => {
    // A <- B <- C; C inherits A. Then remove A three ways and confirm C drops back to plain.
    async function chain() {
      const A = await task('A', { due: dueIn(2), tier: 'critical' });
      const B = await task('B');
      const C = await task('C');
      await block(A, B);
      await block(B, C);
      return { A, B, C };
    }
    const sourceOf = async (id: string) =>
      (await read('today')).find((t) => t.id === id)?.urgencySourceId;

    it('source COMPLETED', async () => {
      const { A, C } = await chain();
      expect(await sourceOf(C)).toBe(A);
      await prisma.task.update({ where: { id: A }, data: { status: 'done' } });
      expect(await sourceOf(C)).toBeUndefined();
    });
    it('source DELETED', async () => {
      const { A, C } = await chain();
      await prisma.task.delete({ where: { id: A } });
      expect(await sourceOf(C)).toBeUndefined();
    });
    it('source DUE CLEARED', async () => {
      const { A, C } = await chain();
      await prisma.task.update({ where: { id: A }, data: { due: null } });
      expect(await sourceOf(C)).toBeUndefined();
    });
  });

  it('AGREEMENT: completing a middle blocker severs inheritance AND ungates upstream, together', async () => {
    // A <- B <- C. Completing B must (via the SAME active-set both consumers read) drop B from
    // propagation (C stops inheriting) and from the gate (A becomes ungated) — in one act, so the
    // walk and isGated cannot silently disagree about "still blocking". One task can't be both the
    // conduit and the ungated one (a DAG forbids it), so it is two effects of one completion.
    const A = await task('A', { due: dueIn(2), tier: 'critical' });
    const B = await task('B');
    const C = await task('C');
    await block(A, B);
    await block(B, C);
    expect((await read('today')).find((t) => t.id === C)?.urgencySourceId).toBe(A);
    expect(await ids('today')).not.toContain(A); // A hidden

    await prisma.task.update({ where: { id: B }, data: { status: 'done' } }); // complete the middle

    expect((await read('today')).find((t) => t.id === C)?.urgencySourceId).toBeUndefined(); // (a) severed
    expect(await ids('today')).toContain(A); // (b) A now ungated and surfaces
  });

  it('blocked tasks still do NOT surface — in either tab', async () => {
    const A = await task('A', { due: dueIn(2), tier: 'critical' });
    const B = await task('B'); // A blocked by B
    await block(A, B);
    expect(await ids('today')).not.toContain(A);
    expect(await ids('upcoming')).not.toContain(A);
  });

  it('a NON-scored read (GET /tasks) carries no urgencySourceId — the mapper never sets it', async () => {
    const A = await task('A', { due: dueIn(2), tier: 'critical' });
    const B = await task('B');
    const C = await task('C');
    await block(A, B);
    await block(B, C); // C inherits on the scored reads — but not here
    const res = await agent.get(url('/tasks?sort=rating')).expect(200);
    const ours = (res.body as Task[]).filter((t) => t.title.startsWith(PREFIX));
    for (const t of ours) expect(t.urgencySourceId).toBeUndefined();
  });
});
