import { PrismaPg } from '@prisma/adapter-pg';
import { resetToFirstRun, unlockAccount } from './auth/admin';
import { PrismaClient } from './generated/prisma/client';

/**
 * The auth admin CLI (ADR 0076) — the operator's escapes, run on the box:
 *   docker compose exec api node dist/auth-admin.js --reset-to-first-run
 *   docker compose exec api node dist/auth-admin.js --unlock
 *
 * A THIN CALLER of auth/admin.ts (the same functions the tests exercise), mirroring seed.ts's --wipe
 * guard: it refuses a bare invocation and dispatches on exactly one flag. Server access is the guard —
 * neither command needs a typed-DELETE, because reset-to-first-run preserves all data (only the
 * credential is cleared) and unlock is harmless.
 */
const RESET_FLAG = '--reset-to-first-run';
const UNLOCK_FLAG = '--unlock';

const USAGE =
  'the auth admin CLI — run exactly one command:\n\n' +
  `  node dist/auth-admin.js ${RESET_FLAG}   forgot-password: delete the account so the next\n` +
  '                                              visit shows create-account. DATA IS PRESERVED.\n' +
  `  node dist/auth-admin.js ${UNLOCK_FLAG}                lockout escape: clear failed attempts and\n` +
  '                                              the lock. Does not change the password.';

async function main(): Promise<void> {
  const reset = process.argv.includes(RESET_FLAG);
  const unlock = process.argv.includes(UNLOCK_FLAG);
  if (reset === unlock) {
    // Neither flag, or both — refuse rather than guess (the --wipe guard's shape).
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // The same driver adapter PrismaService uses (ADR 0033); DATABASE_URL comes from the container env.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set — refusing to guess at a database.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    if (reset) {
      const { deletedAccounts } = await resetToFirstRun(prisma);
      console.log(
        `reset to first run: removed ${deletedAccounts} account(s); all tasks, lists and other data ` +
          'preserved. The next visit shows the create-account screen.',
      );
    } else {
      const { unlocked } = await unlockAccount(prisma);
      console.log(`unlocked ${unlocked} account(s): failed attempts cleared, lockout removed. Password unchanged.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
