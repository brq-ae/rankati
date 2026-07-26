/**
 * The dealt hand — pure client-side logic (ADR 0074).
 *
 * Today is a finite, beatable HAND: the top-N playable cards, HELD and MANUAL. The hand's memory is a
 * client-side `heldIds` list; the SHOWN hand is `heldIds ∩ currently-playable`, in the server's ranked
 * order, capped at N. The load-bearing invariant is structural: **`heldIds` is mutated only by Deal
 * again** (`dealAgain` here). `composeHand` never adds to the hand — it only intersects — so completing
 * a card empties its slot and nothing slides in, by construction, not by a guard.
 *
 * All functions are pure (no storage, no wall-clock); the `localStorage` prefs at the bottom are the
 * only I/O, mirroring effort-prefs / location-filter. Generic over `{ id }` so the tests can pass bare
 * ids and App can pass full Tasks.
 */

export const DEFAULT_HAND_SIZE = 5;
export const HAND_SIZE_KEY = 'deck.hand.size';
export const HELD_IDS_KEY = 'deck.hand.held';

/** The three states Today renders (ADR 0074). Exactly one is shown at a time. */
export type HandState = 'hand' | 'won' | 'nothing-playable';

/**
 * The SHOWN hand: `heldIds ∩ playable`, in `playable` order, capped at N.
 *
 * - `heldIds === null` means NEVER DEALT (a fresh session): auto-deal the top-N, and return those ids
 *   in `autoDealt` for the caller to persist. `autoDealt` is null when there is nothing to deal, so a
 *   first load with no playable cards does not prematurely mark the hand "dealt".
 * - `heldIds` an array means DEALT: the hand is exactly the held cards that are still playable, capped
 *   at N. It NEVER tops up — that is Deal again's job alone. This is why "no auto-fill" is by
 *   construction: a completed/gated/deleted held card simply falls out of the intersection.
 */
export function composeHand<T extends { id: string }>(
  heldIds: string[] | null,
  playable: T[],
  n: number,
): { cards: T[]; autoDealt: string[] | null } {
  if (heldIds === null) {
    const cards = playable.slice(0, n);
    return { cards, autoDealt: cards.length > 0 ? cards.map((t) => t.id) : null };
  }
  const held = new Set(heldIds);
  const cards = playable.filter((t) => held.has(t.id)).slice(0, n);
  return { cards, autoDealt: null };
}

/**
 * Deal again — a TOP-UP, not a re-deal (ADR 0074).
 *
 * Keep every still-playable held card (pruning the completed / deleted / newly-gated ones, which have
 * fallen out of `playable`), then fill the empty slots — up to N — with the next-best playable card
 * NOT already held. Held and undone cards STAY; it is not a fresh top-N. Returns the new `heldIds`.
 */
export function dealAgain<T extends { id: string }>(
  heldIds: string[] | null,
  playable: T[],
  n: number,
): string[] {
  const held = new Set(heldIds ?? []);
  const kept = playable.filter((t) => held.has(t.id)); // still-playable held, in ranked order
  const empty = Math.max(0, n - kept.length);
  const topUp = playable.filter((t) => !held.has(t.id)).slice(0, empty);
  return [...kept, ...topUp].map((t) => t.id);
}

/**
 * Which of the three states to render (ADR 0074). NOTHING-PLAYABLE takes precedence: with no playable
 * cards there is nothing to deal, so neither a hand nor a win applies. WON is a cleared hand while
 * cards remain to deal (you beat what you held). Otherwise, the HAND.
 */
export function handState(shownCount: number, playableCount: number): HandState {
  if (playableCount === 0) return 'nothing-playable';
  if (shownCount === 0) return 'won';
  return 'hand';
}

// ── Client-side prefs (localStorage), the effort-prefs pattern ──────────────────────────────────────

/** The hand size N — a positive integer, default 5. Storage can throw; never crash. */
export function readHandSize(): number {
  try {
    const raw = localStorage.getItem(HAND_SIZE_KEY);
    if (raw === null) return DEFAULT_HAND_SIZE;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : DEFAULT_HAND_SIZE;
  } catch {
    return DEFAULT_HAND_SIZE;
  }
}

export function storeHandSize(n: number): void {
  try {
    localStorage.setItem(HAND_SIZE_KEY, String(n));
  } catch {
    // Unstorable (private mode): the hand still works this session, it just is not remembered.
  }
}

/**
 * The held-card memory: `null` = NEVER DEALT (auto-deal the first hand), an array = the dealt/held set
 * (even `[]`, which reads as WON — a cleared hand). Absent storage is null; garbage falls back to null
 * (treat as never dealt) rather than crashing.
 */
export function readHeldIds(): string[] | null {
  try {
    const raw = localStorage.getItem(HELD_IDS_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed as string[];
    return null;
  } catch {
    return null;
  }
}

export function storeHeldIds(ids: string[]): void {
  try {
    localStorage.setItem(HELD_IDS_KEY, JSON.stringify(ids));
  } catch {
    // Not remembered next session; harmless — the hand still works this session.
  }
}
