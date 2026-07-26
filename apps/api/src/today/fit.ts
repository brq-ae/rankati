import type { Effort } from '@rankati/shared';

/**
 * The `fit` term (ADR 0072) — the third factor of `priority_now` after importance and urgency.
 *
 * A task tagged with an effort bucket SINKS in the Today hand when it is too big for the free block
 * the owner has set: its score is multiplied by FIT_PENALTY. A fitting task, an untagged task, or
 * any task when the block is Any (absent) keeps its full score — so with no block, fit contributes
 * nothing and the Today order is byte-identical to before this term existed (the safety property).
 *
 * Pure: no clock, no I/O, no module state beyond the tunable constant — like scoring.ts (0057).
 */

/** The free block a task must fit in — the same ordinal buckets as effort. */
export type Block = 'quick' | 'medium' | 'long';

/** The tunable sink strength (ADR 0072): a too-big task keeps this fraction of its score. Retune by
 *  feel after live use, exactly as scoring's BOOST/ENTRY_MULT (0057) and the Elo K (0047). */
export const FIT_PENALTY = 0.25;

/** Ordinal size, shared by effort and block: quick < medium < long. */
const ORDER: Readonly<Record<Block, number>> = { quick: 1, medium: 2, long: 3 };

/** True when `value` is one of the three buckets — the query-param guard for the free block. */
export function isBlock(value: unknown): value is Block {
  return value === 'quick' || value === 'medium' || value === 'long';
}

/**
 * The multiplier fit applies to a task's Today-hand score. `1` = no effect (keeps its full rank);
 * `FIT_PENALTY` = sinks. It is 1 whenever the block is Any (undefined), the task is untagged
 * (`effort === null`), or the task fits (`effort ≤ block`); it is FIT_PENALTY only when the task is
 * strictly bigger than the block. Ordinal only — the minute thresholds never enter here (they are
 * display-only, client-side).
 */
export function fitPenalty(effort: Effort | null, block: Block | undefined): number {
  if (block === undefined) return 1; // Any — neutral
  if (effort === null) return 1; // untagged fits any block, never sinks
  return ORDER[effort] > ORDER[block] ? FIT_PENALTY : 1;
}
