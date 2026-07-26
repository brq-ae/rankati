import { Body, Controller, Delete, HttpCode, Param, Post } from '@nestjs/common';
import type {
  CommitSummary,
  NextPairResult,
  StartSessionDto,
  StartSessionResult,
  SubmitResultDto,
} from '@rankati/shared';
import { ArenaSessionService, MIN_POOL } from './arena-session.service';

/**
 * Served at /api/duel-sessions — the global prefix applies everywhere (ADR 0042).
 *
 * Submitting a tap and undoing one both RETURN THE NEXT PAIR rather than expecting the
 * client to fetch it. The brief's promise is "one tap, next pair appears instantly, no
 * confirm" — two round-trips per tap is where that promise dies.
 *
 * There is deliberately no GET for a session: it lives in this process's memory and a
 * refresh discards it (0048). An endpoint to fetch one would imply a durability the
 * design does not have.
 */
@Controller('duel-sessions')
export class DuelSessionsController {
  constructor(private readonly arena: ArenaSessionService) {}

  /**
   * Start a sitting. Discards whatever was in flight — uncommitted taps are disposable.
   *
   * A pool too small to duel comes back 200 with `status: 'need-more-tasks'`, not a 400:
   * wanting to rank one task is a sensible thing to try, and the answer is "add another"
   * (0047). The client switches on `status` rather than on an error handler.
   */
  @Post()
  @HttpCode(200)
  async start(@Body() dto: StartSessionDto): Promise<StartSessionResult> {
    const outcome = await this.arena.start(dto?.listId ?? null);
    if (outcome.status === 'need-more-tasks') {
      return { status: 'need-more-tasks', activeCount: outcome.activeCount, required: MIN_POOL };
    }

    const next = await this.arena.nextPair(outcome.session.id);
    // start() just proved the pool holds two active tasks, so this is a pair.
    return next.status === 'pair'
      ? { status: 'started', sessionId: outcome.session.id, pair: next.pair }
      : next;
  }

  /**
   * One tap. Held in memory (0048); the next pair comes back in the same response.
   *
   * The tap must carry the `dealId` of the pair it answers, or it is rejected with 409 —
   * see DuelPair.dealId. The response deals a new one, so each deal answers exactly once.
   */
  @Post(':id/results')
  @HttpCode(200)
  async submit(
    @Param('id') id: string,
    @Body() dto: SubmitResultDto,
  ): Promise<NextPairResult> {
    this.arena.submitResult(id, dto.winnerId, dto.loserId, dto.dealId);
    return this.arena.nextPair(id);
  }

  /**
   * Undo the last tap and move on. The mis-tapped pair is NOT re-shown — the point is to
   * erase the mistake, not re-litigate it (0048). Repeatable, newest-first.
   */
  @Delete(':id/results/last')
  @HttpCode(200)
  async undo(@Param('id') id: string): Promise<NextPairResult> {
    this.arena.undoLast(id);
    // Undoing nothing is a no-op, not an error: the button stays pressable at zero taps.
    return this.arena.nextPair(id);
  }

  /** End the sitting: compute once, persist, write history, and report what moved. */
  @Post(':id/commit')
  @HttpCode(200)
  commit(@Param('id') id: string): Promise<CommitSummary> {
    return this.arena.commit(id);
  }
}
