import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { SessionStarted, Task, TaskTier } from '@rankati/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { ArenaSessionService } from '../src/arena/arena-session.service';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { TasksService } from '../src/tasks.service';
import { dayOfWeekOf, windowOpen } from '../src/today/availability-window';

/**
 * The availability-window gate (ADR 0070) — the fourth gate, 0052's shape exactly.
 *
 * EVERY CLOCK VALUE IS INJECTED. `on` and `at` are fixed strings; nothing reads the wall
 * clock, so "Monday" and "10:00" mean the same on every day this suite ever runs.
 *
 * Three layers, mirroring how the gate is built:
 *   - the PURE check (windowOpen/dayOfWeekOf), including the end-EXCLUSIVE 14:00 boundary —
 *     the ladder a sabotaged `<` vs `<=` fails loudest on;
 *   - MEMBERSHIP under a throwaway owner (the 0067 pattern), whole-tab exact, proving the
 *     window clause rides isGated into BOTH scored reads;
 *   - the HTTP contract under `local`: fail-closed 400 without `at` (0052's template), and
 *     the 0052 invariants — Lists still shows a closed-window task, the Arena still deals it.
 *
 * Every `local` row here carries the title PREFIX and afterEach deletes by that prefix, so
 * a failing test cannot strand a windowed local task — which would 400 the live app's Today
 * read until the web client learns to send `at` (next slice).
 */
const PREFIX = '__availwindow_gate__';
const OPREFIX = '__ownertest__';

/** Fixed local days — the weekday facts the membership rows stand on. */
const MON = '2026-07-20'; // getUTCDay 1
const SAT = '2026-07-25'; // getUTCDay 6

const dueAtDays = (d: number): string =>
  new Date(Date.parse(`${MON}T00:00:00.000Z`) + d * 86_400_000).toISOString().slice(0, 10);

describe('windowOpen — the pure, clock-free check (0070)', () => {
  const DOW_MON = 1;
  const DOW_SAT = 6;

  it('working_hours boundary ladder on a weekday: END-EXCLUSIVE at 14:00', () => {
    expect(windowOpen('working_hours', DOW_MON, '07:59')).toBe(false);
    expect(windowOpen('working_hours', DOW_MON, '08:00')).toBe(true); // start-inclusive
    expect(windowOpen('working_hours', DOW_MON, '13:59')).toBe(true);
    // The stroke of two is CLOSED — "until 14:00" does not include 14:00 (0070).
    expect(windowOpen('working_hours', DOW_MON, '14:00')).toBe(false);
    expect(windowOpen('working_hours', DOW_MON, '15:00')).toBe(false);
  });

  it('Monday vs Saturday for all three presets', () => {
    expect(windowOpen('working_hours', DOW_MON, '10:00')).toBe(true);
    expect(windowOpen('working_hours', DOW_SAT, '10:00')).toBe(false); // right hours, wrong day
    expect(windowOpen('workdays', DOW_MON, '03:00')).toBe(true); // any time of a workday
    expect(windowOpen('workdays', DOW_SAT, '10:00')).toBe(false);
    expect(windowOpen('weekend', DOW_SAT, '10:00')).toBe(true);
    expect(windowOpen('weekend', DOW_MON, '10:00')).toBe(false);
  });

  it('dayOfWeekOf derives the weekday from the day string, UTC-anchored', () => {
    expect(dayOfWeekOf(MON)).toBe(1); // Monday
    expect(dayOfWeekOf(SAT)).toBe(6); // Saturday
    expect(dayOfWeekOf('2026-07-26')).toBe(0); // Sunday — weekend's other half
  });
});

describe('the availability-window gate (real Postgres, ADR 0070)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let service: TasksService;
  let arena: ArenaSessionService;
  let listId: string;
  const url = (path: string) => `/${API_PREFIX}${path}`;

  /**
   * Deletes every row this file can create, keyed by prefix — safe against real data, and
   * run afterEach so even a FAILING test cannot leave a windowed `local` task behind.
   */
  async function cleanup() {
    if (!prisma) return;
    await prisma.duel.deleteMany({ where: { winner: { title: { startsWith: PREFIX } } } });
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.task.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { ownerId: { startsWith: OPREFIX } } });
  }

  /** A throwaway owner with its own list — whole-tab assertions, the 0067 pattern. */
  async function freshOwner(): Promise<{ owner: string; ownList: string }> {
    const owner = `${OPREFIX}${randomUUID()}`;
    const ownList = (await prisma.list.create({ data: { name: 'l', ownerId: owner } })).id;
    return { owner, ownList };
  }

  const mk = async (
    owner: string,
    inList: string,
    name: string,
    o: { window?: Task['availabilityWindow']; due?: string; tier?: TaskTier } = {},
  ): Promise<string> =>
    (
      await prisma.task.create({
        data: {
          title: name,
          listId: inList,
          ownerId: owner,
          availabilityWindow: o.window ?? null,
          due: o.due ? new Date(o.due) : null,
          tier: o.tier ?? 'normal',
        },
      })
    ).id;

  /** A `local` task, ALWAYS prefix-titled so cleanup owns it. */
  const localTask = (name: string, window: Task['availabilityWindow']): Promise<string> =>
    mk(LOCAL_OWNER_ID, listId, `${PREFIX} ${name}`, { window });

  const todayIds = async (owner: string, on: string, at?: string): Promise<string[]> =>
    (await service.findToday(owner, on, at)).map((t) => t.id);
  const upcomingIds = async (owner: string, on: string, at?: string): Promise<string[]> =>
    (await service.findUpcoming(owner, on, at)).map((t) => t.id);

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

  describe('membership — the window clause rides isGated into both reads (0059, 0070)', () => {
    it('working_hours: in Today inside the window; out at 14:00, after, and on Saturday', async () => {
      const { owner, ownList } = await freshOwner();
      const anytime = await mk(owner, ownList, 'anytime'); // NULL window — the control
      const wh = await mk(owner, ownList, 'wh', { window: 'working_hours' });

      // Monday 10:00 — open. Both shown; wh is newer, so ties break to it first (0050).
      expect(await todayIds(owner, MON, '10:00')).toEqual([wh, anytime]);
      // Monday 14:00 — CLOSED, end-exclusive: at the stroke of two the task is hidden.
      expect(await todayIds(owner, MON, '14:00')).toEqual([anytime]);
      expect(await todayIds(owner, MON, '15:00')).toEqual([anytime]);
      // Saturday 10:00 — right hours, wrong day.
      expect(await todayIds(owner, SAT, '10:00')).toEqual([anytime]);
    });

    it('workdays: any time Mon–Fri, never on Saturday', async () => {
      const { owner, ownList } = await freshOwner();
      const wd = await mk(owner, ownList, 'wd', { window: 'workdays' });

      expect(await todayIds(owner, MON, '03:00')).toEqual([wd]); // any hour counts
      expect(await todayIds(owner, SAT, '12:00')).toEqual([]);
    });

    it('weekend: Saturday yes, Monday no', async () => {
      const { owner, ownList } = await freshOwner();
      const we = await mk(owner, ownList, 'we', { window: 'weekend' });

      expect(await todayIds(owner, SAT, '12:00')).toEqual([we]);
      expect(await todayIds(owner, MON, '12:00')).toEqual([]);
    });

    it('a NULL window is Anytime: ungated in every combination, at optional', async () => {
      const { owner, ownList } = await freshOwner();
      const anytime = await mk(owner, ownList, 'anytime');

      expect(await todayIds(owner, MON, '10:00')).toEqual([anytime]);
      expect(await todayIds(owner, SAT, '02:00')).toEqual([anytime]);
      // No windowed task under this owner — `at` stays optional, exactly as before the gate.
      expect(await todayIds(owner, MON)).toEqual([anytime]);
    });

    it('a DATED out-of-window task is absent from Upcoming too — one gate, both tabs', async () => {
      const { owner, ownList } = await freshOwner();
      // Both due 20 days out (> critical's 14-day window) → Upcoming when ungated.
      const control = await mk(owner, ownList, 'control', { due: dueAtDays(20), tier: 'critical' });
      const gated = await mk(owner, ownList, 'gated', {
        due: dueAtDays(20),
        tier: 'critical',
        window: 'weekend',
      });

      // Monday: the weekend window is shut → gone from BOTH tabs, not demoted to Upcoming.
      expect(await todayIds(owner, MON, '10:00')).toEqual([]);
      expect(await upcomingIds(owner, MON, '10:00')).toEqual([control]);
      // Saturday: the window opens and the same dated task is simply back in Upcoming.
      expect(await upcomingIds(owner, SAT, '10:00')).toEqual([gated, control]);
    });
  });

  describe('required context — the gate fails closed and loud over HTTP (0052, 0070)', () => {
    it('a windowed task makes `at` required: 400 without it, on BOTH scored reads', async () => {
      const windowed = await localTask('windowed', 'weekend');

      await agent.get(url(`/tasks/today?on=${MON}`)).expect(400);
      await agent.get(url(`/tasks/upcoming?on=${MON}`)).expect(400);

      // With the clock, the read serves — and the Monday-closed weekend task is filtered.
      const res = await agent
        .get(url(`/tasks/today?on=${MON}&at=10:00`))
        .expect(200);
      expect((res.body as Task[]).map((t) => t.id)).not.toContain(windowed);
    });

    it('rejects a time whose meaning is negotiable', async () => {
      await localTask('windowed', 'weekend');
      // Un-zero-padded compares wrong as a string; 24:00 is not a time of day; the rest are
      // simply not HH:MM. All refused whether or not they would have mattered.
      for (const bad of ['9:5', '24:00', '9:30', '10:60', 'noon', '10:00:00']) {
        await agent
          .get(url(`/tasks/today?on=${MON}&at=${encodeURIComponent(bad)}`))
          .expect(400);
      }
    });

    it('with NO windowed tasks, `at` stays optional — the owner pays nothing new', async () => {
      // Service-direct under a throwaway owner (the 0067 pattern), not the shared `local`
      // owner over HTTP: post-0070 `local` may carry windowed tasks of its own (it does, in
      // this dev DB), so "this owner has no windowed tasks" has to be a fact this test
      // controls, not an assumption about live data.
      const { owner, ownList } = await freshOwner();
      const plain = await mk(owner, ownList, 'plain');
      expect(await todayIds(owner, MON)).toEqual([plain]); // no `at` — did not fail closed
      expect(await upcomingIds(owner, MON)).toEqual([]);
    });
  });

  describe('a closed window hides from Today ONLY (0052, 0070)', () => {
    it('the task stays in Lists and is still dealt by the Arena', async () => {
      // Monday morning: the weekend window is shut.
      const windowed = await localTask('weekend-only', 'weekend');
      const plain = await localTask('plain', null);

      // Hidden from Today...
      const today = await agent
        .get(url(`/tasks/today?on=${MON}&at=10:00`))
        .expect(200);
      expect((today.body as Task[]).map((t) => t.id)).not.toContain(windowed);

      // ...but Lists shows everything...
      const all = await agent.get(url('/tasks')).expect(200);
      expect((all.body as Task[]).map((t) => t.id)).toContain(windowed);

      // ...and the Arena still deals it: the pool is exactly these two tasks (0052's
      // load-bearing invariant, inherited whole — importance matures while the window waits).
      const started = await agent
        .post(url('/duel-sessions'))
        .send({ listId })
        .expect(200);
      const pair = (started.body as SessionStarted).pair;
      expect([pair.a.id, pair.b.id].sort()).toEqual([windowed, plain].sort());
    });
  });

  describe('PATCH — the three states (0070)', () => {
    it('sets each preset, clears with null, rejects anything outside the closed set', async () => {
      const id = await localTask('patch-me', null);

      for (const window of ['working_hours', 'workdays', 'weekend'] as const) {
        const res = await agent
          .patch(url(`/tasks/${id}`))
          .send({ availabilityWindow: window })
          .expect(200);
        expect((res.body as Task).availabilityWindow).toBe(window);
      }

      // null clears back to Anytime — un-gates the task.
      const cleared = await agent
        .patch(url(`/tasks/${id}`))
        .send({ availabilityWindow: null })
        .expect(200);
      expect((cleared.body as Task).availabilityWindow).toBeNull();

      // Outside the preset set: the caller's typo, refused naming the members.
      await agent
        .patch(url(`/tasks/${id}`))
        .send({ availabilityWindow: 'sundays' })
        .expect(400);
    });
  });
});
