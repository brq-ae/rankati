import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CommitSummary, MinPool, NextPairResult, RatingChange } from '@rankati/shared';
import { randomUUID } from 'node:crypto';
import { LOCAL_OWNER_ID } from '../constants';
import { Prisma, type Task } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { TASK_INCLUDE, toTaskDto, type TaskWithRelations } from '../task-mapper';
import { applyDuel, kFor, roundForStorage } from './elo';
import { pickPair, type Contender, type Rng } from './pairing';

type Decimal = Prisma.Decimal;

/** A tap, held in memory. Never touches the database unless the session is ended (0048). */
interface PendingResult {
  winnerId: string;
  loserId: string;
  /** The tap time — carried to Duel.createdAt, so history records when you judged, not
   *  when you happened to press END. */
  tappedAt: Date;
}

/**
 * A sitting at the Arena. Lives in this process and nowhere else (0048): abandoning,
 * refreshing, or restarting the container writes nothing. That is the design, not a
 * limitation — in-progress taps are disposable, committed history is not.
 */
export interface ArenaSession {
  /** Stamped onto every duel this session commits. The session object is gone by then;
   *  this is what lets a retune regroup duels and recompute frozen K (0047, 0048). */
  id: string;
  ownerId: string;
  /** Pool filter (0003). null = global (the Arena's own button); a listId scopes the session to
   *  one list — surfaced since v0.12 by each list's VS button, though the API has taken it since
   *  v0.2. */
  listId: string | null;
  /** K per task, frozen (0047). Filled at session start, and at first sight for any task
   *  that appears later — still frozen exactly once per session. */
  frozenK: Map<string, number>;
  /** Ordered: array order IS tap order. Undo pops the tail. */
  pending: PendingResult[];
  /**
   * The deal currently on screen, or null when no pair is dealt (pool below two).
   *
   * This is the server's half of "both sides agree which pair is being judged": a tap is
   * accepted only if it carries this exact token. Reissued on EVERY deal, including the
   * one after an undo — which is what stops a tap that raced the undo from landing on the
   * pair the undo just erased.
   */
  dealId: string | null;
}

/** A task's state with the session's pending taps folded in, but nothing persisted yet. */
export interface Projected {
  rating: Decimal;
  duelCount: number;
}

/**
 * Fewer than two tasks cannot make a pair — an empty state, not an error (0047).
 *
 * Typed against the shared `MinPool` literal (0041): the client's copy in
 * `apps/web/src/duelable.ts` is pinned to the same `2` at compile time. Change one, change the
 * other — the agreement tests pin the behaviour on top of that.
 */
export const MIN_POOL: MinPool = 2;

/** Either a sitting opened, or there was nothing to duel. Never an exception (0047). */
export type StartOutcome =
  | { status: 'started'; session: ArenaSession }
  | { status: 'need-more-tasks'; activeCount: number };

@Injectable()
export class ArenaSessionService {
  /**
   * At most ONE live session per owner (0048). Starting a session replaces any existing
   * one, so this map is bounded by construction: no TTL, no sweeper, nothing to leak.
   */
  private readonly sessions = new Map<string, ArenaSession>();

  /**
   * Injected so tests can pin a sequence rather than hope. Matchmaking randomness is not
   * part of replay — the log records what was dueled, never how it was chosen (0048).
   */
  rng: Rng = Math.random;

  constructor(private readonly prisma: PrismaService) {}

  /** Active tasks only — completed tasks retire from the pool with their rating frozen
   *  (0047). An optional list narrows the pool without changing the rating (0003). */
  private eligibleWhere(listId: string | null): Prisma.TaskWhereInput {
    return {
      ownerId: LOCAL_OWNER_ID,
      status: 'active',
      ...(listId ? { listId } : {}),
    };
  }

  private async eligibleTasks(listId: string | null): Promise<TaskWithRelations[]> {
    // The include is not optional: toTaskDto requires the relation, so a query that
    // omitted it would not compile (0053). Note eligibleWhere applies NO gate filter —
    // blocked and date-gated tasks still duel, deliberately (0052, 0053).
    return this.prisma.task.findMany({
      where: this.eligibleWhere(listId),
      include: TASK_INCLUDE,
    });
  }

  /**
   * Open a sitting. Discards whatever was in flight — an uncommitted session is
   * disposable by design (0048), so this is deliberately not idempotent.
   *
   * Reports a small pool rather than throwing: wanting to rank one task is a sensible
   * thing to try, and the answer is "add another", not an error (0047). Counting and
   * starting in one call also means there is no gap between the two.
   */
  async start(listId: string | null = null): Promise<StartOutcome> {
    const tasks = await this.eligibleTasks(listId);
    if (tasks.length < MIN_POOL) {
      return { status: 'need-more-tasks', activeCount: tasks.length };
    }

    const session: ArenaSession = {
      id: randomUUID(),
      ownerId: LOCAL_OWNER_ID,
      listId,
      frozenK: new Map(tasks.map((t) => [t.id, kFor(t.duelCount)])),
      pending: [],
      dealId: null,
    };
    this.sessions.set(LOCAL_OWNER_ID, session);
    return { status: 'started', session };
  }

  /** The live session, or 404. A stale id (from a refreshed tab) is genuinely gone. */
  private require(sessionId: string): ArenaSession {
    const session = this.sessions.get(LOCAL_OWNER_ID);
    if (!session || session.id !== sessionId) {
      throw new NotFoundException(`no live session ${sessionId}`);
    }
    return session;
  }

  /**
   * K for a task in this session. Frozen at session start; a task that appears later
   * (added in another tab) freezes at first sight — the same rule, applied once (0047).
   */
  private frozenKFor(session: ArenaSession, task: Task): number {
    const existing = session.frozenK.get(task.id);
    if (existing !== undefined) return existing;
    const k = kFor(task.duelCount);
    session.frozenK.set(task.id, k);
    return k;
  }

  /**
   * Record a tap. Held in memory; nothing is written (0048).
   *
   * The tap must name the deal it answers. A token that is absent, stale, or arriving
   * when nothing is dealt is REJECTED, not recorded: a tap whose pair the user is no
   * longer looking at is not a judgement they made. This is the only guard between a
   * double-tap and the same judgement being counted twice.
   */
  submitResult(sessionId: string, winnerId: string, loserId: string, dealId: string): void {
    const session = this.require(sessionId);
    if (winnerId === loserId) {
      throw new BadRequestException('a task cannot duel itself');
    }
    if (typeof dealId !== 'string' || dealId.length === 0) {
      throw new BadRequestException('dealId is required');
    }
    if (session.dealId === null || dealId !== session.dealId) {
      throw new ConflictException('that pair is no longer on the table');
    }
    // Consume the deal. A second tap on the same deal now finds null and is rejected,
    // rather than being waved through because the ids happen to still match.
    session.dealId = null;
    session.pending.push({ winnerId, loserId, tappedAt: new Date() });
  }

  /**
   * Undo: drop the last tap and move on. The mis-tapped pair is NOT re-shown — the point
   * is to erase the mistake, not re-litigate it (0048). Repeatable, newest-first.
   * Returns false when there was nothing to undo.
   */
  undoLast(sessionId: string): boolean {
    const session = this.require(sessionId);
    return session.pending.pop() !== undefined;
  }

  /**
   * Fold the session's taps onto a base, in tap order. Pure: same inputs, same output.
   *
   * This one function serves pairing (so exposure counts pending taps, and the placement
   * ladder can actually climb within a sitting), commit (persist the fold), and undo
   * (pop the tail, fold again). One code path, so they cannot disagree.
   *
   * Carries FULL precision throughout and rounds nothing (0047). The caller rounds once,
   * when it persists. Rounding here would feed each step's error into the next
   * expectation and compound across the sitting.
   */
  project(base: Task[], session: ArenaSession): Map<string, Projected> {
    const state = new Map<string, Projected>(
      base.map((t) => [t.id, { rating: t.rating, duelCount: t.duelCount }]),
    );

    for (const p of session.pending) {
      const winner = state.get(p.winnerId);
      const loser = state.get(p.loserId);
      // A task deleted or completed mid-session simply is not in `base`; its taps are
      // skipped here exactly as they are at commit (0048).
      if (!winner || !loser) continue;

      const kWinner = session.frozenK.get(p.winnerId) ?? kFor(winner.duelCount);
      const kLoser = session.frozenK.get(p.loserId) ?? kFor(loser.duelCount);
      const next = applyDuel(winner.rating, loser.rating, kWinner, kLoser);

      state.set(p.winnerId, { rating: next.winner, duelCount: winner.duelCount + 1 });
      state.set(p.loserId, { rating: next.loser, duelCount: loser.duelCount + 1 });
    }

    return state;
  }

  /** The session's current view, for pairing and for display while dueling. */
  async projectLive(sessionId: string): Promise<Map<string, Projected>> {
    const session = this.require(sessionId);
    return this.project(await this.eligibleTasks(session.listId), session);
  }

  /**
   * Draw the next duel (0004, 0006). Returns null when the pool has dropped below two —
   * an empty state, not an error.
   *
   * The pair carries PROJECTED ratings, not persisted ones: mid-sitting, what the Arena
   * believes is the fold of your taps so far. Rounded here only because it is crossing
   * the wire; the session itself keeps full precision (0047).
   */
  async nextPair(sessionId: string): Promise<NextPairResult> {
    const session = this.require(sessionId);
    const tasks = await this.eligibleTasks(session.listId);
    if (tasks.length < MIN_POOL) {
      // Nothing is on the table, so no tap can be valid until a pair is dealt again.
      session.dealId = null;
      return { status: 'need-more-tasks', activeCount: tasks.length, required: MIN_POOL };
    }

    const projected = this.project(tasks, session);
    const contenders: Contender[] = tasks.map((t) => {
      const p = projected.get(t.id)!;
      return { id: t.id, rating: p.rating, duelCount: p.duelCount };
    });

    const [first, second] = pickPair(contenders, this.rng);
    const asDto = (c: Contender): ReturnType<typeof toTaskDto> => {
      const task = tasks.find((t) => t.id === c.id)!;
      return { ...toTaskDto(task), rating: roundForStorage(c.rating).toNumber() };
    };
    const dealId = randomUUID();
    session.dealId = dealId;
    return { status: 'pair', pair: { dealId, a: asDto(first), b: asDto(second) } };
  }

  /**
   * Drop a deleted task's pending taps from the live sitting.
   *
   * Commit would skip them anyway (0048), so this changes no committed outcome — but it
   * keeps undo honest: without it, undo could pop a tap that was already doomed, and the
   * user would watch a press do nothing.
   */
  dropPendingFor(taskId: string): void {
    const session = this.sessions.get(LOCAL_OWNER_ID);
    if (!session) return;
    session.pending = session.pending.filter(
      (p) => p.winnerId !== taskId && p.loserId !== taskId,
    );
    session.frozenK.delete(taskId);
  }

  /**
   * End the sitting: compute once, persist once, write history — one transaction (0048).
   *
   * Reads the tasks fresh INSIDE the transaction rather than trusting the snapshot taken
   * at session start, so a task edited or completed meanwhile is seen as it now is.
   */
  async commit(sessionId: string): Promise<CommitSummary> {
    const session = this.require(sessionId);

    const summary = await this.prisma.$transaction(async (tx) => {
      const tasks = await tx.task.findMany({
        where: this.eligibleWhere(session.listId),
        include: TASK_INCLUDE,
      });
      const live = new Map(tasks.map((t) => [t.id, t]));

      const state = new Map<string, Projected>(
        tasks.map((t) => [t.id, { rating: t.rating, duelCount: t.duelCount }]),
      );

      const rows: Prisma.DuelCreateManyInput[] = [];
      let skipped = 0;

      for (const p of session.pending) {
        const winner = state.get(p.winnerId);
        const loser = state.get(p.loserId);
        // Deleted or completed since the tap: drop it and keep the rest (0048).
        if (!winner || !loser) {
          skipped += 1;
          continue;
        }

        const kWinner = this.frozenKFor(session, live.get(p.winnerId)!);
        const kLoser = this.frozenKFor(session, live.get(p.loserId)!);
        const next = applyDuel(winner.rating, loser.rating, kWinner, kLoser);

        // Full precision through the sitting; rounded once below, on the way in (0047).
        state.set(p.winnerId, { rating: next.winner, duelCount: winner.duelCount + 1 });
        state.set(p.loserId, { rating: next.loser, duelCount: loser.duelCount + 1 });

        rows.push({
          sessionId: session.id,
          winnerId: p.winnerId,
          loserId: p.loserId,
          kWinner,
          kLoser,
          ownerId: session.ownerId,
          createdAt: p.tappedAt,
        });
      }

      const moved: RatingChange[] = [];
      for (const [id, projected] of state) {
        const before = live.get(id)!;
        // Untouched tasks are not rewritten.
        if (projected.duelCount === before.duelCount) continue;

        // THE one rounding point (0047). Everything upstream is full precision.
        const after = roundForStorage(projected.rating);
        const updated = await tx.task.update({
          include: TASK_INCLUDE,
          where: { id },
          data: { rating: after, duelCount: projected.duelCount },
        });
        const delta = after.minus(before.rating);
        // A task that dueled and ended exactly where it started is not a MOVER.
        //
        // It is still persisted above — its duelCount changed, and that is real. But the
        // summary answers "what moved?", and a row reading "+0.00" answers it with a task
        // that didn't. Net zero is easy to reach: win one, lose one, at even ratings.
        if (delta.isZero()) continue;

        moved.push({
          task: toTaskDto(updated),
          before: before.rating.toNumber(),
          after: after.toNumber(),
          delta: delta.toNumber(),
        });
      }

      if (rows.length > 0) {
        await tx.duel.createMany({ data: rows });
      }

      // Biggest climber first — this is the payoff view, not a log.
      moved.sort((x, y) => y.delta - x.delta);
      return { sessionId: session.id, committed: rows.length, skipped, moved };
    });

    // The sitting is over whether or not it wrote anything.
    this.sessions.delete(LOCAL_OWNER_ID);
    return summary;
  }

  /** Abandon without writing — what a refresh or a restart does implicitly (0048). */
  discard(): void {
    this.sessions.delete(LOCAL_OWNER_ID);
  }
}
