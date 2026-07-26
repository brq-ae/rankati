import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { resetOwner } from '../src/reset-core';

/**
 * "Defined once" (ADRs 0064, 0065): a fresh install and a factory reset land in IDENTICAL states.
 *
 * v0.14 adapts the instrument for relative dates. Two seeds at different wall-clock times would
 * produce different absolute dates, so both seeds are pinned to the SAME injected `now` (the test-only
 * seam, 0065) and the content projection is EXTENDED to include due/notBefore/tier/status/location
 * names/dependency title-pairs — a FULL content identity, dates included, not just titles. The
 * projection is id/timestamp-independent (names and title-pairs, sorted), so only the seed logic being
 * one definition can make the two match.
 *
 * The messy prior state on B is the point: it proves the end state is canonical regardless of what
 * came before. `--wipe` is `resetOwner(factory, keepSampleData)`, so this covers the CLI content too.
 */
const OP = '__freshfactory__';
const owner = () => `${OP}${randomUUID()}`;
const NOW = new Date('2026-06-15T00:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('fresh install == factory reset from a messy prior state (real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  async function cleanup() {
    await prisma.duel.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.task.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.list.deleteMany({ where: { ownerId: { startsWith: OP } } });
    await prisma.location.deleteMany({ where: { ownerId: { startsWith: OP } } });
  }

  /** Seed junk of every kind under `o`, so a factory reset has a real prior state to erase. */
  async function seedMessy(o: string) {
    const list = await prisma.list.create({ data: { name: 'Junk', ownerId: o } });
    const a = await prisma.task.create({
      data: { title: 'Junk A', listId: list.id, ownerId: o, rating: 1500, duelCount: 9, tier: 'critical' },
    });
    const b = await prisma.task.create({ data: { title: 'Junk B', listId: list.id, ownerId: o } });
    await prisma.taskDependency.create({ data: { taskId: b.id, dependsOnId: a.id } });
    const loc = await prisma.location.create({ data: { name: `Junk-${randomUUID()}`, ownerId: o } });
    await prisma.taskLocation.create({ data: { taskId: a.id, locationId: loc.id } });
    await prisma.duel.create({
      data: { winnerId: a.id, loserId: b.id, sessionId: randomUUID(), kWinner: 24, kLoser: 24, ownerId: o },
    });
  }

  /** An id/timestamp-independent content fingerprint over the FULL seeded shape, dates included. */
  async function fingerprint(o: string): Promise<string> {
    const [lists, locations, tasks, tags, deps] = await Promise.all([
      prisma.list.findMany({ where: { ownerId: o }, select: { id: true, name: true } }),
      prisma.location.findMany({ where: { ownerId: o }, select: { id: true, name: true } }),
      prisma.task.findMany({
        where: { ownerId: o },
        select: { id: true, title: true, listId: true, status: true, rating: true, duelCount: true, tier: true, due: true, notBefore: true },
      }),
      prisma.taskLocation.findMany({ where: { task: { ownerId: o } }, select: { taskId: true, locationId: true } }),
      prisma.taskDependency.findMany({ where: { task: { ownerId: o } }, select: { taskId: true, dependsOnId: true } }),
    ]);
    const listName = new Map(lists.map((l) => [l.id, l.name]));
    const locName = new Map(locations.map((l) => [l.id, l.name]));
    const taskTitle = new Map(tasks.map((t) => [t.id, t.title]));
    const parts = [
      ...lists.map((l) => `L:${l.name}`),
      ...locations.map((l) => `P:${l.name}`),
      ...tasks.map(
        (t) =>
          `T:${t.title}|${listName.get(t.listId)}|${t.status}|${t.rating.toFixed(2)}|${t.duelCount}|${t.tier}|${t.due ? iso(t.due) : ''}|${t.notBefore ? iso(t.notBefore) : ''}`,
      ),
      ...tags.map((x) => `TL:${taskTitle.get(x.taskId)}|${locName.get(x.locationId)}`),
      ...deps.map((x) => `TD:${taskTitle.get(x.taskId)}|${taskTitle.get(x.dependsOnId)}`),
    ].sort();
    return createHash('md5').update(parts.join('\n')).digest('hex');
  }

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('the two seeds are byte-identical by content, dates included', async () => {
    const a = owner(); // fresh install
    const b = owner(); // messy -> factory reset

    await resetOwner(prisma, a, 'factory', { keepSampleData: true, now: NOW });
    await seedMessy(b);
    await resetOwner(prisma, b, 'factory', { keepSampleData: true, now: NOW });

    const fpA = await fingerprint(a);
    const fpB = await fingerprint(b);
    expect(fpB).toBe(fpA);
    // Guard the instrument: a same-owner reseed onto DIFFERENT content must NOT match this hash, or
    // the fingerprint would be proving nothing.
    expect(fpA).not.toBe(createHash('md5').update('').digest('hex'));
  });
});
