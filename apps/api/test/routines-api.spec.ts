import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CreateRoutineDto, Routine } from '@rankati/shared';
import { AppModule } from '../src/app.module';
import { loginAgent } from './_auth';
import { API_PREFIX, LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { RoutinesService } from '../src/routines/routines.service';

/**
 * Routines over real Postgres (ADR 0066): the compute-fresh-per-read behaviour, the schedule math end
 * to end, the SILO (routines never reach the task/Arena reads), and the owner-scope of delete. Actual
 * results asserted against the DB, not predicted. Local rows are prefixed and cleaned; the delete
 * boundary uses a throwaway owner (no destructive owner-wide op here, but consistent with 0064).
 */
const P = '__rtest__';
const OP = '__rtest_own__';

describe('Routines API (real Postgres)', () => {
  let app: INestApplication;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let prisma: PrismaService;
  let svc: RoutinesService;
  const url = (p: string) => `/${API_PREFIX}${p}`;

  async function cleanup() {
    await prisma.routine.deleteMany({ where: { name: { startsWith: P } } });
    await prisma.routine.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.task.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: P } } });
  }
  const create = (dto: Omit<CreateRoutineDto, 'name'>, name = `${P}${randomUUID()}`) =>
    svc.create({ name, ...dto } as CreateRoutineDto);
  const read = async (id: string, on: string): Promise<Routine> =>
    (await svc.findAll(on)).find((r) => r.id === id)!;

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    agent = await loginAgent(app);
    prisma = app.get(PrismaService);
    svc = app.get(RoutinesService);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await app.close();
  });
  beforeEach(cleanup);

  // ── Frequency reset across all four boundaries ───────────────────────────────────────────────
  describe('frequency reset', () => {
    it.each([
      ['day', '2026-01-14', '2026-01-15'],
      ['week', '2026-01-14', '2026-01-19'], // Wed (week of Mon 12) → Mon 19 (next week)
      ['month', '2026-01-14', '2026-02-01'],
      ['year', '2026-01-14', '2027-01-01'],
    ] as const)('%s: counts within the period, reads 0 in the next, resets on the next "Did it"', async (unit, d1, d2) => {
      const r = await create({ type: 'frequency', on: d1, periodUnit: unit, targetCount: 3 });
      await svc.did(r.id, d1);
      const after2 = await svc.did(r.id, d1);
      expect(after2.periodCount).toBe(2); // same period tallies
      expect((await read(r.id, d1)).periodCount).toBe(2); // still 2 within the period

      expect((await read(r.id, d2)).periodCount).toBe(0); // ROLLED OVER → fresh period reads 0, no history

      const didInNext = await svc.did(r.id, d2); // a "Did it" in the new period resets then +1, not 3
      expect(didInNext.periodCount).toBe(1);
    });

    it('a stale-period read freshens BOTH periodStart and the count — not just the count (0066 v0.18)', async () => {
      const on1 = '2026-07-08'; // Wed, week of Mon 2026-07-06
      const r = await create({ type: 'frequency', on: on1, periodUnit: 'week', targetCount: 3 });
      await svc.did(r.id, on1);
      await svc.did(r.id, on1); // count 2, stored periodStart = 2026-07-06

      // Same-period read (Thu of that week): nothing rolled — start AND count intact.
      const same = await read(r.id, '2026-07-09');
      expect(same.periodStart).toBe('2026-07-06');
      expect(same.periodCount).toBe(2);

      // A read two weeks on (Sat 07-25, week of Mon 07-20): the period rolled — BOTH freshen. The
      // bug this covers freshened only the count, leaving periodStart at the stale 07-06 so client
      // pace pressure (v0.18) would reckon against a period that already ended.
      const rolled = await read(r.id, '2026-07-25');
      expect(rolled.periodStart).toBe('2026-07-20'); // re-anchored to the current week
      expect(rolled.periodCount).toBe(0); // and reset
    });
  });

  // ── Floating snap-forward, incl. "never earlier" ─────────────────────────────────────────────
  describe('floating "Did it" snaps forward', () => {
    it('every 3 weeks, preferred Sunday, done Tue 6th → +3wk = Tue 27th → next Sun = Feb 1', async () => {
      const r = await create({ type: 'interval_floating', on: '2026-01-01', intervalUnit: 'week', intervalCount: 3, preferredWeekday: 0 });
      const after = await svc.did(r.id, '2026-01-06'); // Tuesday
      expect(after.nextDue).toBe('2026-02-01');
    });
    it('EDGE never-earlier: interval lands ON the preferred weekday → stays, not pushed a week', async () => {
      const r = await create({ type: 'interval_floating', on: '2026-01-01', intervalUnit: 'week', intervalCount: 1, preferredWeekday: 0 });
      const after = await svc.did(r.id, '2026-01-04'); // Sunday + 1wk = Jan 11 (Sunday) → stays Jan 11
      expect(after.nextDue).toBe('2026-01-11');
    });
  });

  // ── Fixed: two consecutive months + recompute after the date passes + persistent dismiss ─────
  describe('fixed calendar rule ("1st Friday")', () => {
    const firstFri = { type: 'interval_fixed', on: '2026-01-01', rule: { kind: 'nth_weekday_of_month', ordinal: 1, weekday: 5 } } as const;
    it('reads this month before it, next month AFTER it passes — a read never writes', async () => {
      const r = await create(firstFri);
      expect((await read(r.id, '2026-01-01')).nextDue).toBe('2026-01-02');
      expect((await read(r.id, '2026-01-03')).nextDue).toBe('2026-02-06'); // Jan's passed → Feb's
      // the row was never mutated by those reads
      expect((await prisma.routine.findUnique({ where: { id: r.id } }))!.nextDue).toBeNull();
    });
    it('dismiss is PERSISTENT — the acknowledged occurrence recedes to the next', async () => {
      const r = await create(firstFri);
      await svc.dismiss(r.id, '2026-01-01'); // acknowledges Jan 2
      expect((await read(r.id, '2026-01-01')).nextDue).toBe('2026-02-06'); // Jan 2 dismissed → shows Feb
    });
  });

  // ── The SILO — a routine never reaches the task/Arena reads ──────────────────────────────────
  describe('silo', () => {
    it('a routine is absent from /tasks, /today, /upcoming — present only in /routines', async () => {
      const list = await prisma.list.create({ data: { name: `${P}L`, ownerId: LOCAL_OWNER_ID } });
      await prisma.task.create({ data: { title: `${P}task`, listId: list.id, ownerId: LOCAL_OWNER_ID } });
      const r = await create({ type: 'frequency', on: '2026-01-14', periodUnit: 'day', targetCount: 1 }, `${P}routine-silo`);

      const has = (arr: { id?: string; name?: string; title?: string }[], v: string) =>
        arr.some((x) => x.id === r.id || x.name === v || x.title === v);
      const on = '2026-01-14';
      const tasks = (await agent.get(url('/tasks')).expect(200)).body;
      // Post-0070 the suite reads the real `local` owner, whose data may carry windows, so
      // the clock is required (fail-closed, owner-data-dependent).
      const today = (await agent.get(url(`/tasks/today?on=${on}&at=12:00`)).expect(200)).body;
      const upcoming = (
        await agent.get(url(`/tasks/upcoming?on=${on}&at=12:00`)).expect(200)
      ).body;
      const routineList = (await agent.get(url(`/routines?on=${on}`)).expect(200)).body;

      expect(has(tasks, `${P}routine-silo`)).toBe(false);
      expect(has(today, `${P}routine-silo`)).toBe(false);
      expect(has(upcoming, `${P}routine-silo`)).toBe(false);
      expect(has(routineList, `${P}routine-silo`)).toBe(true); // it lives here, and only here
      // structural: the Arena's pool is the Task table; a duel-session start can only ever draw tasks.
      expect(await prisma.task.count({ where: { id: r.id } })).toBe(0);
    });
  });

  // ── Delete + owner-scope boundary (the lethal direction is sabotage-bitten separately) ───────
  describe('delete', () => {
    it('removes the routine row (single row, no children)', async () => {
      const r = await create({ type: 'frequency', on: '2026-01-14', periodUnit: 'day', targetCount: 1 });
      await agent.delete(url(`/routines/${r.id}`)).expect(204);
      expect(await prisma.routine.findUnique({ where: { id: r.id } })).toBeNull();
    });
    it('refuses another owner’s routine (404, and it survives) — the boundary the sabotage tests', async () => {
      const other = `${OP}${randomUUID()}`;
      const row = await prisma.routine.create({
        data: { name: 'other', ownerId: other, type: 'frequency', periodUnit: 'day', targetCount: 1, periodCount: 0 },
      });
      await expect(svc.remove(row.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(await prisma.routine.findUnique({ where: { id: row.id } })).not.toBeNull();
    });
  });

  // ── Full editing (ADR 0066, step 3b) — direct edits, with the necessary derived follows ──────
  describe('update', () => {
    it('frequency: changing the target KEEPS the current count (2/3 → 2/4)', async () => {
      const r = await create({ type: 'frequency', on: '2026-01-14', periodUnit: 'day', targetCount: 3 });
      await svc.did(r.id, '2026-01-14');
      await svc.did(r.id, '2026-01-14'); // count 2
      const u = await svc.update(r.id, { on: '2026-01-14', targetCount: 4 });
      expect(u.targetCount).toBe(4);
      expect(u.periodCount).toBe(2);
    });
    it('frequency: changing the period UNIT re-anchors periodStart and RESETS the tally', async () => {
      const r = await create({ type: 'frequency', on: '2026-01-14', periodUnit: 'day', targetCount: 3 });
      await svc.did(r.id, '2026-01-14'); // count 1 under the day period
      const u = await svc.update(r.id, { on: '2026-01-14', periodUnit: 'week' });
      expect(u.periodUnit).toBe('week');
      expect(u.periodStart).toBe('2026-01-12'); // that week's Monday
      expect(u.periodCount).toBe(0);
    });
    it('fixed: changing the rule recomputes nextDue and CLEARS a stale dismiss', async () => {
      const r = await create({ type: 'interval_fixed', on: '2026-01-01', rule: { kind: 'nth_weekday_of_month', ordinal: 1, weekday: 5 } });
      await svc.dismiss(r.id, '2026-01-01'); // dismiss Jan 2
      expect((await read(r.id, '2026-01-01')).nextDue).toBe('2026-02-06');
      const u = await svc.update(r.id, { on: '2026-01-01', rule: { kind: 'day_of_month', day: 15 } });
      expect(u.ruleKind).toBe('day_of_month');
      expect(u.acknowledgedDate).toBeNull(); // stale dismiss cleared
      expect((await read(r.id, '2026-01-01')).nextDue).toBe('2026-01-15'); // derived from the new rule
    });
    it('floating: editing interval/preferred does NOT shift nextDue; nextDue is edited directly (no snap)', async () => {
      const r = await create({ type: 'interval_floating', on: '2026-01-01', intervalUnit: 'week', intervalCount: 3, preferredWeekday: 0, firstDue: '2026-01-20' });
      const u1 = await svc.update(r.id, { on: '2026-01-01', intervalCount: 2, preferredWeekday: 1 });
      expect(u1.intervalCount).toBe(2);
      expect(u1.preferredWeekday).toBe(1);
      expect(u1.nextDue).toBe('2026-01-20'); // unchanged by the interval/weekday edit
      const u2 = await svc.update(r.id, { on: '2026-01-01', nextDue: '2026-02-10' });
      expect(u2.nextDue).toBe('2026-02-10'); // direct edit, as-is
    });
    it('rejects a field foreign to the routine’s type (400)', async () => {
      const r = await create({ type: 'frequency', on: '2026-01-14', periodUnit: 'day', targetCount: 1 });
      await expect(svc.update(r.id, { on: '2026-01-14', rule: { kind: 'day_of_month', day: 1 } })).rejects.toBeInstanceOf(BadRequestException);
    });
    it('refuses another owner’s routine (404)', async () => {
      const other = `${OP}${randomUUID()}`;
      const row = await prisma.routine.create({
        data: { name: 'other', ownerId: other, type: 'frequency', periodUnit: 'day', targetCount: 1, periodCount: 0 },
      });
      await expect(svc.update(row.id, { on: '2026-01-14', name: 'hacked' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
