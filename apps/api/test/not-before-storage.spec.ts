import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * How a Postgres DATE survives the trip through Prisma (ADR 0052).
 *
 * This is the foundation the whole not-before gate stands on. `notBefore` is a CALENDAR
 * DAY, and it reaches the client as `.toISOString().slice(0, 10)`. That is only correct if
 * the driver hands back a Date anchored at UTC midnight. If a future Prisma bump ever
 * returns local midnight instead, every gated task shifts by a day — and it shifts
 * SILENTLY, at exactly the boundary the gate exists to police. So the round-trip is
 * asserted rather than assumed.
 *
 * The sweep across timezones is the point. The first version of this check ran with TZ
 * unset on a UTC box, which "proved" the round-trip while actually proving only that the
 * box is UTC. Accidentally correct is not verified. Dubai (+04), New York (-04) and
 * Kiritimati (+14) straddle UTC in both directions and cross the date line, so if the
 * driver ever consulted local time, at least one of them lands on the wrong day.
 */

const PREFIX = '__notbefore_storage__';

/** UTC first: a difference from it is what makes the other zones meaningful. */
const ZONES = ['UTC', 'Asia/Dubai', 'America/New_York', 'Pacific/Kiritimati'] as const;

/** Midsummer, new year's day, and new year's eve — the two most likely to slip a year. */
const DATES = ['2026-07-20', '2026-01-01', '2026-12-31'] as const;

describe('notBefore storage: a DATE is a calendar day, in any timezone (0052)', () => {
  let app: Awaited<ReturnType<typeof build>>['app'];
  let prisma: PrismaService;
  let listId: string;
  const originalTz = process.env.TZ;

  async function build() {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = m.createNestApplication();
    await app.init();
    return { app, prisma: app.get(PrismaService) };
  }

  async function cleanup() {
    await prisma.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.list.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    ({ app, prisma } = await build());
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

  it('the TZ sweep actually changes the process clock', () => {
    // Guards the guard. If runtime TZ mutation silently did nothing, every case below
    // would run in one zone and the sweep would be theatre that always passes.
    const offsets = new Set<number>();
    for (const zone of ZONES) {
      process.env.TZ = zone;
      offsets.add(new Date().getTimezoneOffset());
    }
    expect(offsets.size).toBe(ZONES.length);
  });

  for (const zone of ZONES) {
    describe(`with the server in ${zone}`, () => {
      for (const input of DATES) {
        it(`round-trips ${input} unchanged`, async () => {
          process.env.TZ = zone;

          const task = await prisma.task.create({
            data: {
              title: `${PREFIX} ${zone} ${input}`,
              listId,
              ownerId: LOCAL_OWNER_ID,
              notBefore: new Date(input),
            },
          });
          const back = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });

          expect(back.notBefore).not.toBeNull();
          // UTC midnight exactly — no local-time contamination anywhere in the trip.
          expect(back.notBefore!.getUTCHours()).toBe(0);
          expect(back.notBefore!.getUTCMinutes()).toBe(0);
          expect(back.notBefore!.getUTCSeconds()).toBe(0);
          expect(back.notBefore!.getUTCMilliseconds()).toBe(0);
          // The wire value: what toTaskDto sends, and what the client compares days with.
          expect(back.notBefore!.toISOString().slice(0, 10)).toBe(input);
        });
      }
    });
  }

  it('is stored by Postgres as the plain calendar day, driver uninvolved', async () => {
    process.env.TZ = 'Pacific/Kiritimati'; // the most hostile zone we have (+14)
    const task = await prisma.task.create({
      data: { title: `${PREFIX} raw`, listId, ownerId: LOCAL_OWNER_ID, notBefore: new Date('2026-07-20') },
    });
    const rows = await prisma.$queryRawUnsafe<{ d: string }[]>(
      `select "notBefore"::text as d from "Task" where id = '${task.id}'`,
    );
    expect(rows[0]?.d).toBe('2026-07-20');
  });

  it('NULL means ungated, and stays NULL', async () => {
    const task = await prisma.task.create({
      data: { title: `${PREFIX} ungated`, listId, ownerId: LOCAL_OWNER_ID },
    });
    const back = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(back.notBefore).toBeNull();
  });
});
