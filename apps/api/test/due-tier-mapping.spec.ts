import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { TasksService } from '../src/tasks.service';

/**
 * How due and tier reach the wire (ADR 0056), asserted through the REAL mapper (toTaskDto,
 * via findOne) against real Postgres.
 *
 * due is a calendar DAY and must serialize as 'YYYY-MM-DD' — never a full ISO instant, the
 * same day-early trap the not-before gate polices (0052/0056). The check runs under
 * Kiritimati (+14), the zone most likely to slip a day, so a future change to local-time
 * extraction in the mapper would show here rather than silently ship. tier is a plain enum
 * string: it passes through unchanged and defaults to normal.
 */
const PREFIX = '__due_tier_mapping__';

describe('due and tier on the wire (0056)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: TasksService;
  let listId: string;
  const originalTz = process.env.TZ;

  async function cleanup() {
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    service = app.get(TasksService);
    await cleanup();
    listId = (await prisma.list.create({ data: { name: `${PREFIX} l`, ownerId: LOCAL_OWNER_ID } })).id;
  });

  afterAll(async () => {
    // Restore, or every test file after this one inherits Kiritimati.
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    await cleanup();
    await app?.close();
  });

  it('serializes due as YYYY-MM-DD, never an ISO instant — even in a hostile timezone', async () => {
    process.env.TZ = 'Pacific/Kiritimati'; // +14 — the most likely to slip a day
    const created = await prisma.task.create({
      data: { title: `${PREFIX} due`, listId, ownerId: LOCAL_OWNER_ID, due: new Date('2026-07-20') },
    });

    const dto = await service.findOne(created.id);
    expect(dto.due).toBe('2026-07-20'); // exactly the calendar day...
    expect(dto.due).not.toMatch(/[TZ]/); // ...not '2026-07-20T00:00:00.000Z'
  });

  it('serializes due as null when there is no deadline', async () => {
    const created = await prisma.task.create({
      data: { title: `${PREFIX} nodue`, listId, ownerId: LOCAL_OWNER_ID },
    });
    expect((await service.findOne(created.id)).due).toBeNull();
  });

  it('due and not-before are independent — both, on different days, round-trip', async () => {
    const created = await prisma.task.create({
      data: {
        title: `${PREFIX} both`,
        listId,
        ownerId: LOCAL_OWNER_ID,
        notBefore: new Date('2026-07-18'),
        due: new Date('2026-07-25'),
      },
    });
    const dto = await service.findOne(created.id);
    expect(dto.notBefore).toBe('2026-07-18');
    expect(dto.due).toBe('2026-07-25');
  });

  it('passes tier through as its enum string, defaulting to normal', async () => {
    const def = await prisma.task.create({
      data: { title: `${PREFIX} deftier`, listId, ownerId: LOCAL_OWNER_ID },
    });
    expect((await service.findOne(def.id)).tier).toBe('normal'); // server/DB default (0056)

    const crit = await prisma.task.create({
      data: { title: `${PREFIX} crit`, listId, ownerId: LOCAL_OWNER_ID, tier: 'critical' },
    });
    expect((await service.findOne(crit.id)).tier).toBe('critical'); // round-trips unchanged
  });
});
