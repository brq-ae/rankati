import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { buildFreshState } from '../src/fresh-state';
import { PrismaService } from '../src/prisma.service';
import { seedFreshState } from '../src/reset-core';

/**
 * Sample dates are RELATIVE to seed time (ADR 0065) — the seed is dynamic every run, so a factory
 * reset next year yields next-year dates. This proves the dynamism, not merely that dates exist: seed
 * a year apart and the absolute dates must MOVE a year. A seed that computed from a stale constant
 * would pass every other check in this milestone but fail the `not.toBe` guard below.
 *
 * Throwaway owners only (ADR 0064). `now` is the test-only seam (0065) — this is its intended use.
 */
const OP = '__reldate__';
const owner = () => `${OP}${randomUUID()}`;
const NOW_2026 = new Date('2026-03-01T00:00:00Z');
const NOW_2027 = new Date('2027-03-01T00:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('sample dates are relative to seed time (ADR 0065)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const dueOf = async (o: string, title: string) =>
    (await prisma.task.findFirst({ where: { ownerId: o, title }, select: { due: true } }))?.due ?? null;

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.task.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.list.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.location.deleteMany({ where: { ownerId: { startsWith: OP } } });
  });
  afterAll(async () => {
    await prisma.task.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.list.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.location.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await app.close();
  });

  it('buildFreshState resolves due = now + offset — a year later moves it a year', () => {
    const salik26 = buildFreshState(NOW_2026).tasks.find((t) => t.title === 'Renew Salik top-up')!.due!;
    const salik27 = buildFreshState(NOW_2027).tasks.find((t) => t.title === 'Renew Salik top-up')!.due!;
    expect(iso(salik26)).toBe('2026-03-06'); // +5 days
    expect(iso(salik27)).toBe('2027-03-06');
  });

  it('the dynamism holds through the SEED -> DB path, not just the pure function', async () => {
    const a = owner();
    const b = owner();
    await prisma.$transaction((tx) => seedFreshState(tx, a, buildFreshState(NOW_2026)));
    await prisma.$transaction((tx) => seedFreshState(tx, b, buildFreshState(NOW_2027)));

    const dueA = await dueOf(a, 'Renew Salik top-up');
    const dueB = await dueOf(b, 'Renew Salik top-up');
    expect(dueA).not.toBeNull();
    expect(dueB).not.toBeNull();
    expect(iso(dueA!)).toBe('2026-03-06');
    expect(iso(dueB!)).toBe('2027-03-06');
    // The load-bearing guard: a stale-constant seed would make these identical.
    expect(dueA!.getTime()).not.toBe(dueB!.getTime());
    expect(Math.round((dueB!.getTime() - dueA!.getTime()) / 86_400_000)).toBe(365);
  });
});
