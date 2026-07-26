import { PrismaPg } from '@prisma/adapter-pg';
import { LOCAL_OWNER_ID } from './constants';
import { PrismaClient } from './generated/prisma/client';
import { resetOwner } from './reset-core';

/**
 * Wipe every row and seed the shipped sample data — the operator CLI.
 *
 * A THIN CALLER of `resetOwner` (reset-core.ts), the same code the reset endpoint runs (ADR 0064):
 * `--wipe` is exactly a FACTORY RESET with sample data. There is no second wipe implementation, so
 * redesigning the sample data can never fix one path and leave this one seeding the old junk. Note
 * this now also resets LOCATIONS to the four defaults (regenerating their ids) — a deliberate change
 * from the old script, which left them alone; the canonical fresh state is what a fresh install and
 * a factory reset both land on.
 *
 * Guarded behind an explicit flag. A destructive script that runs on a bare invocation is one
 * tab-completion away from an outage, and this ships inside the image where an operator can reach
 * it (`docker compose exec api node dist/seed.js --wipe`). This `--wipe` guard is the CLI's half of
 * the two-defence contract; the HTTP endpoint's half is its `confirm: "DELETE"` check (ADR 0064).
 *
 * It runs through the SAME Prisma client the app uses, not hand-written SQL, so it cannot drift from
 * the schema. Ratings and duel counts are never set here: they come from the schema defaults
 * (1000, 0), so "a sample task starts fresh" is the same statement as "a new task starts fresh".
 */
async function main(): Promise<void> {
  if (!process.argv.includes('--wipe')) {
    console.error(
      'refusing to run without --wipe.\n\n' +
        'This DELETES every list, task, duel and location, then seeds sample data.\n' +
        '  node dist/seed.js --wipe',
    );
    process.exitCode = 1;
    return;
  }

  // Prisma 7 is Rust-free and reaches Postgres through a driver adapter (ADR 0033), the same one
  // PrismaService uses. DATABASE_URL is read straight from the environment: in the container it is
  // already set by compose, which is where this runs in the container.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set — refusing to guess at a database to wipe.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const summary = await resetOwner(prisma, LOCAL_OWNER_ID, 'factory', { keepSampleData: true });
    console.log(
      `wiped: ${summary.deleted.duels} duels, ${summary.deleted.tasks} tasks, ` +
        `${summary.deleted.lists} lists, ${summary.deleted.locations} locations, ` +
        `${summary.deleted.routines} routines`,
    );
    console.log(
      `seeded: ${summary.seeded.locations} locations, ${summary.seeded.lists} lists, ` +
        `${summary.seeded.tasks} tasks`,
    );

    // Report the state rather than claim it: this script's whole promise is "fresh".
    const seeded = await prisma.task.findMany({
      where: { ownerId: LOCAL_OWNER_ID },
      orderBy: { title: 'asc' },
      select: { title: true, rating: true, duelCount: true, status: true },
    });
    for (const t of seeded) {
      console.log(`  ${t.title}  rating=${t.rating.toFixed(2)}  duels=${t.duelCount}  ${t.status}`);
    }
    const stale = seeded.filter((t) => !t.rating.equals(1000) || t.duelCount !== 0);
    if (stale.length > 0) {
      throw new Error(`seed produced non-fresh tasks: ${stale.map((t) => t.title).join(', ')}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
