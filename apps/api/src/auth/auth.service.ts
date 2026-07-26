import { randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Session } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from './clock';
import { LockedException } from './locked.exception';
import { isLocked, lockoutFor } from './lockout';
import { hashPassword, verifyPassword } from './password';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Trusted sessions live 30 days; an untrusted session cookie dies on browser close, but the row still
 *  needs a server-side backstop so an abandoned session cannot be resurrected forever. */
const TRUSTED_TTL_MS = 30 * DAY_MS;
const UNTRUSTED_TTL_MS = DAY_MS;

export interface SessionGrant {
  token: string;
  trusted: boolean;
}

/**
 * The single-account auth flows (ADR 0076): first-run setup, login (with the escalating brute-force
 * lockout wired in — step 4), logout, and session validation. One account, one dataset — owner scoping
 * is untouched (LOCAL_OWNER_ID stays constant).
 *
 * Time is read through the injected Clock, never `new Date()`, so the lockout tiers are tested by
 * advancing a fake clock rather than by waiting.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** First-run signal: no account has been created yet, so the web app shows the create-account screen. */
  async needsSetup(): Promise<boolean> {
    return (await this.prisma.account.count()) === 0;
  }

  /** A session is valid iff its row exists and has not passed its server-side expiry. */
  async validateSession(token: string | undefined): Promise<Session | null> {
    if (!token) return null;
    const session = await this.prisma.session.findUnique({ where: { id: token } });
    if (session === null) return null;
    if (session.expiresAt.getTime() <= this.clock.now().getTime()) return null;
    return session;
  }

  /**
   * Create the ONE account and auto-login. Works only on a first run; once an account exists, setup is
   * closed forever (409). Recovery is a deliberate server-side reset, never a second setup (ADR 0076).
   */
  async setup(username: string, password: string, trusted: boolean): Promise<SessionGrant> {
    if (!(await this.needsSetup())) {
      throw new ConflictException('Setup is closed — an account already exists.');
    }
    const passwordHash = await hashPassword(password);
    const account = await this.prisma.account.create({ data: { username, passwordHash } });
    // Auto-login honoring "trust this device", exactly like login: trusted → 30-day persistent session.
    return this.createSession(account.id, trusted);
  }

  /**
   * Verify credentials against the single account, enforcing the escalating lockout (ADR 0076):
   *   1. If the account is currently locked → 429 immediately; the password is NOT checked and the
   *      counter does NOT advance. Locked is locked — a CORRECT password still fails during a lockout.
   *   2. Otherwise verify. A failed attempt (wrong username OR password — both count against the one
   *      account) increments failedAttempts; if that reaches a lockout tier the account locks (429),
   *      else 401. A correct attempt resets the counter and opens a session.
   */
  async login(username: string, password: string, trusted: boolean): Promise<SessionGrant> {
    const now = this.clock.now();
    const account = await this.prisma.account.findFirst(); // the single account (ADR 0076)
    if (account === null) {
      await hashPassword(password); // constant-time-ish; there is nothing to log into
      throw new UnauthorizedException('Invalid username or password.');
    }

    // 1. Locked is locked.
    if (isLocked(account.lockedUntil, now)) {
      throw this.lockedError(account.lockedUntil, now);
    }

    // 2. Verify — always run the hash comparison so a wrong username leaks no timing signal. The
    // username match is CASE-INSENSITIVE (ADR 0080): "Alice" logs into the account stored as
    // "alice". Comparison-only — the stored value keeps its original case.
    const passwordOk = await verifyPassword(account.passwordHash, password);
    if (username.toLowerCase() === account.username.toLowerCase() && passwordOk) {
      await this.prisma.account.update({
        where: { id: account.id },
        data: { failedAttempts: 0, lockedUntil: null }, // the reset rule
      });
      return this.createSession(account.id, trusted);
    }

    // Failed: advance the counter and lock if this attempt crossed a tier.
    const failedAttempts = account.failedAttempts + 1;
    const duration = lockoutFor(failedAttempts);
    const updated = await this.prisma.account.update({
      where: { id: account.id },
      data: {
        failedAttempts,
        ...(duration > 0 ? { lockedUntil: new Date(now.getTime() + duration) } : {}),
      },
    });
    if (duration > 0) throw this.lockedError(updated.lockedUntil, now); // just became locked → 429
    throw new UnauthorizedException('Invalid username or password.'); // → 401
  }

  /** Revoke the current session by deleting its row; a no-op if the token is absent or already gone. */
  async logout(token: string | undefined): Promise<void> {
    if (token) await this.prisma.session.deleteMany({ where: { id: token } });
  }

  /**
   * Change the password (ADR 0076). Verify the current password (wrong → 401, nothing changes), then
   * hash and store the new one and REVOKE EVERY OTHER SESSION — keep only the caller's current one, so
   * you stay logged in here while every other device is logged out. `currentToken` is the caller's
   * session id (the cookie value), guaranteed present since this route is behind the session guard.
   */
  async changePassword(currentToken: string, currentPassword: string, newPassword: string): Promise<void> {
    const account = await this.prisma.account.findFirst();
    if (account === null) throw new UnauthorizedException(); // unreachable behind the guard
    if (!(await verifyPassword(account.passwordHash, currentPassword))) {
      throw new UnauthorizedException('Current password is incorrect.');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.account.update({ where: { id: account.id }, data: { passwordHash } });
    await this.prisma.session.deleteMany({
      where: { accountId: account.id, id: { not: currentToken } },
    });
  }

  private async createSession(accountId: string, trusted: boolean): Promise<SessionGrant> {
    const token = randomBytes(32).toString('base64url'); // opaque, cryptographically random cookie value
    const ttl = trusted ? TRUSTED_TTL_MS : UNTRUSTED_TTL_MS;
    const expiresAt = new Date(this.clock.now().getTime() + ttl);
    await this.prisma.session.create({ data: { id: token, accountId, expiresAt, trusted } });
    return { token, trusted };
  }

  private lockedError(lockedUntil: Date | null, now: Date): LockedException {
    const remainingMs = lockedUntil === null ? 0 : lockedUntil.getTime() - now.getTime();
    return new LockedException(Math.max(1, Math.ceil(remainingMs / 1000)));
  }
}
