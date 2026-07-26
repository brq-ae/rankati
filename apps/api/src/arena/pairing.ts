/**
 * Matchmaking (ADRs 0004, 0006, 0047). Pure functions — the randomness is injected, so
 * the tests can pin a sequence instead of hoping.
 *
 * Two rules, and the order between them is the whole design:
 *   1. A provisional task jumps the queue and gets a TARGETED opponent (0006).
 *   2. Everyone else is drawn randomly, weighted toward the least-dueled (0004).
 *
 * Rule 1 is the ONLY place targeted pairing is allowed to live. 0004 is explicit that the
 * steady state stays pure random — we deliberately do not over-sample uncertain pairs.
 */
import { Prisma } from '../generated/prisma/client';
import { PLACEMENT_DUELS } from './elo';

type Decimal = Prisma.Decimal;

export interface Contender {
  id: string;
  rating: Decimal;
  duelCount: number;
}

/** A source of randomness in [0, 1). Injected so tests are deterministic. */
export type Rng = () => number;

/**
 * How strongly balanced-random favours the least-dueled task.
 *
 * 0004 says "weighted toward the least-dueled" and fixes no function — the same gap the
 * Elo constants had before 0047. This is inverse-frequency weighting: a task with 0 duels
 * is drawn 5x as often as one with 4. It is a GUESS, like the Elo constants, and it is
 * cheap to change: exposure is observable in `duelCount`, so if it skews we will see it.
 */
function fairWeight(duelCount: number): number {
  return 1 / (1 + duelCount);
}

/** Weighted draw. Returns the picked index. */
function weightedPick(weights: number[], rng: Rng): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) return i;
  }
  // Only reachable through floating-point slack at the very top of the range.
  return weights.length - 1;
}

/** Uniform pick among ties, so equal candidates do not resolve to "whichever sorted first". */
function pickAmong<T>(items: T[], rng: Rng): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]!;
}

/**
 * The opponent for a task placing itself: the one whose rating is CLOSEST (0047).
 *
 * Win and it climbs to meet someone tougher; lose and it drops. That is the ladder-climb
 * that converges in about log2(pool) steps — the *effect* 0006 asks for by "binary-search
 * style", not a literal bisection with stored bounds.
 */
function nearestRating(target: Contender, others: Contender[], rng: Rng): Contender {
  const first = others[0]!;
  let best = first.rating.minus(target.rating).abs();
  let ties: Contender[] = [first];

  for (const other of others.slice(1)) {
    const gap = other.rating.minus(target.rating).abs();
    const cmp = gap.comparedTo(best);
    if (cmp < 0) {
      best = gap;
      ties = [other];
    } else if (cmp === 0) {
      ties.push(other);
    }
  }
  // On a fresh install every rating is exactly 1000, so everything ties. Breaking that
  // randomly is what stops the first sitting dealing the same pair over and over.
  return pickAmong(ties, rng);
}

/**
 * Draw the next duel. The two are always DISTINCT — a task never duels itself.
 *
 * `pool` must hold at least two contenders; callers check that and surface an empty state
 * rather than an error (0047).
 */
export function pickPair(pool: Contender[], rng: Rng): [Contender, Contender] {
  if (pool.length < 2) {
    throw new Error(`pickPair needs at least 2 contenders, got ${pool.length}`);
  }

  const provisional = pool.filter((c) => c.duelCount < PLACEMENT_DUELS);

  if (provisional.length > 0) {
    // Cold start (0006): the least-dueled provisional task jumps the queue, so a new task
    // finds its slot instead of waiting for random pairing to notice it.
    const fewest = Math.min(...provisional.map((c) => c.duelCount));
    const first = pickAmong(
      provisional.filter((c) => c.duelCount === fewest),
      rng,
    );
    const rest = pool.filter((c) => c.id !== first.id);
    return [first, nearestRating(first, rest, rng)];
  }

  // Steady state (0004): pure random, weighted toward the least-dueled. No cleverness.
  const first = pool[weightedPick(pool.map((c) => fairWeight(c.duelCount)), rng)]!;
  const rest = pool.filter((c) => c.id !== first.id);
  const second = rest[weightedPick(rest.map((c) => fairWeight(c.duelCount)), rng)]!;
  return [first, second];
}
