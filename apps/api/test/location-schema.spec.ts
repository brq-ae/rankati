import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { LOCAL_OWNER_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';

/**
 * The case-insensitive uniqueness FLOOR for locations (ADRs 0060, 0061).
 *
 * Uniqueness has two guards on purpose: this DB-level `UNIQUE INDEX (ownerId, lower(name))`,
 * and (from v0.9's API step) a service-side pre-check that returns a friendly 400. The index
 * is the floor the pre-check cannot be — it holds under a race and against a second client.
 *
 * The index is an EXPRESSION index, so it lives in the migration, NOT in schema.prisma —
 * which means `prisma migrate` cannot drift-detect its loss. And its loss would be INVISIBLE
 * behaviourally: the service pre-check would keep rejecting ordinary duplicates while the
 * floor silently vanished, leaving only a race-losable check. So this file asserts the index
 * ITSELF exists, separately from asserting that a duplicate is rejected. A future migration
 * that drops or forgets it fails HERE, loudly, instead of degrading quietly.
 */

const PREFIX = '__loc_ci__';

describe('Location uniqueness floor (0060, 0061)', () => {
  let app: Awaited<ReturnType<typeof build>>['app'];
  let prisma: PrismaService;

  async function build() {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = m.createNestApplication();
    await app.init();
    return { app, prisma: app.get(PrismaService) };
  }

  const cleanup = () =>
    prisma.location.deleteMany({ where: { name: { startsWith: PREFIX } } });

  beforeAll(async () => {
    ({ app, prisma } = await build());
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  it('the case-insensitive UNIQUE INDEX on (ownerId, lower(name)) exists', async () => {
    // Structural, not behavioural: this reads the catalog, so it fails the moment the index
    // is missing — even while a service pre-check would still be catching plain duplicates.
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'Location'
        AND indexdef ILIKE '%UNIQUE%'
        AND indexdef ILIKE '%lower(name)%'
    `;
    expect(rows).toHaveLength(1);
    // And it is scoped to the owner, not global — two owners may each have a "Home".
    expect(rows[0]!.indexdef).toMatch(/"ownerId"/);
  });

  it('rejects a case-variant duplicate at the DB floor (behavioural)', async () => {
    await prisma.location.create({ data: { name: `${PREFIX}Garage`, ownerId: LOCAL_OWNER_ID } });
    // Same owner, same name in different case — the index must refuse it. This is what would
    // STILL PASS on a service pre-check alone if the index were dropped; here, with the index
    // as the only guard, it is the index doing the rejecting.
    await expect(
      prisma.location.create({ data: { name: `${PREFIX}garage`, ownerId: LOCAL_OWNER_ID } }),
    ).rejects.toThrow();
  });

  it('allows the SAME name for different owners (the index is owner-scoped)', async () => {
    // Guards against over-tightening the floor into a global unique on lower(name): two people
    // each having a "Home" is correct. Single-owner today (0039), but the scope must be right.
    await prisma.location.create({ data: { name: `${PREFIX}Home`, ownerId: `${PREFIX}owner-a` } });
    await expect(
      prisma.location.create({ data: { name: `${PREFIX}home`, ownerId: `${PREFIX}owner-b` } }),
    ).resolves.toBeTruthy();
  });
});
