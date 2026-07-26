import type { PrismaClient } from '../generated/prisma/client';

/**
 * The auth admin operations (ADR 0076) — the operator's escapes, run on the box. Each is a small
 * function the CLI invokes, so it is testable directly against real Postgres (the reset-core pattern).
 * Server access is the guard; there is no typed-DELETE ceremony because the blast radius is only the
 * credential, never the data.
 */

/**
 * RESET TO FIRST RUN — the forgot-password escape. Delete the Account (its sessions cascade away), so
 * GET /api/auth/status returns needsSetup:true again and the next visit shows the create-account
 * screen. DATA IS PRESERVED: tasks, lists, locations, checklists, routines are NEVER touched here.
 * Owner scoping is a constant (LOCAL_OWNER_ID), not the Account row, so the newly-created account sees
 * every bit of the old data. That is the whole point.
 */
export async function resetToFirstRun(prisma: PrismaClient): Promise<{ deletedAccounts: number }> {
  const { count } = await prisma.account.deleteMany({});
  return { deletedAccounts: count };
}

/**
 * UNLOCK — the lockout escape. Clear the brute-force state (failedAttempts → 0, lockedUntil → null) so
 * login is no longer blocked. Does NOT change the password; harmless, so no confirmation is needed.
 */
export async function unlockAccount(prisma: PrismaClient): Promise<{ unlocked: number }> {
  const { count } = await prisma.account.updateMany({ data: { failedAttempts: 0, lockedUntil: null } });
  return { unlocked: count };
}
