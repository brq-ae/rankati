// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HAND_SIZE,
  HAND_SIZE_KEY,
  HELD_IDS_KEY,
  composeHand,
  dealAgain,
  handState,
  readHandSize,
  readHeldIds,
  storeHandSize,
  storeHeldIds,
} from '../src/hand';

/**
 * The pure dealt-hand logic (ADR 0074). The two load-bearing invariants are proven here directly and
 * bite-tested (companion sabotages, run by hand): NO AUTO-FILL (composeHand only intersects, never
 * tops up) and TOP-UP-NOT-RE-DEAL (dealAgain keeps held + fills empty slots, not a fresh top-N).
 */
const ids = <T extends { id: string }>(cards: T[]): string[] => cards.map((c) => c.id);
const t = (...names: string[]) => names.map((id) => ({ id })); // ranked, highest first

describe('composeHand — held ∩ playable, capped, first-load auto-deal (0074)', () => {
  it('never dealt (null) auto-deals the top-N and reports the ids to persist', () => {
    const { cards, autoDealt } = composeHand(null, t('A', 'B', 'C', 'D', 'E', 'F'), 5);
    expect(ids(cards)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(autoDealt).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('never dealt but nothing playable → no cards, autoDealt null (do not mark dealt)', () => {
    expect(composeHand(null, [], 5)).toEqual({ cards: [], autoDealt: null });
  });

  it('dealt → exactly the held cards still playable, in ranked order, capped at N', () => {
    const { cards, autoDealt } = composeHand(['B', 'D'], t('A', 'B', 'C', 'D', 'E'), 5);
    expect(ids(cards)).toEqual(['B', 'D']);
    expect(autoDealt).toBeNull();
  });

  it('caps the DISPLAY at N without pruning held (a smaller N shows fewer)', () => {
    const { cards } = composeHand(['A', 'B', 'C', 'D', 'E'], t('A', 'B', 'C', 'D', 'E'), 3);
    expect(ids(cards)).toEqual(['A', 'B', 'C']);
  });

  it('NO AUTO-FILL: a completed held card empties its slot and NOTHING is added', () => {
    // Held A–E; A has completed (gone from playable); F is a fresh non-held playable card.
    const { cards, autoDealt } = composeHand(['A', 'B', 'C', 'D', 'E'], t('B', 'C', 'D', 'E', 'F'), 5);
    expect(ids(cards)).toEqual(['B', 'C', 'D', 'E']); // 4, NOT topped up to 5
    expect(ids(cards)).not.toContain('F'); // the non-held card is NOT pulled in
    expect(autoDealt).toBeNull(); // heldIds is not mutated by composing
  });
});

describe('dealAgain — a top-up, not a re-deal (0074)', () => {
  it('TOP-UP-NOT-RE-DEAL: keeps still-held cards and fills only the empty slot', () => {
    // Hold [C,D,E]; C has gone; a fresh re-deal (top-3) would be [A,B,D], dropping E for B.
    const next = dealAgain(['C', 'D', 'E'], t('A', 'B', 'D', 'E'), 3);
    expect(next).toEqual(['D', 'E', 'A']); // kept D,E; topped up with the next-best not-held (A)
    expect(next).toContain('E'); // the held card SURVIVES...
    expect(next).not.toContain('B'); // ...and the re-deal's pick (B) is NOT force-swapped in
  });

  it('fills empty slots up to N with the next-best not-held', () => {
    expect(dealAgain(['A'], t('A', 'B', 'C', 'D', 'E'), 3)).toEqual(['A', 'B', 'C']);
  });

  it('prunes vanished held cards (completed / deleted / gated)', () => {
    // Held X,Y,Z but only Y is still playable; top up from the rest.
    expect(dealAgain(['X', 'Y', 'Z'], t('Y', 'P', 'Q'), 3)).toEqual(['Y', 'P', 'Q']);
  });

  it('a full hand (no empty slots) tops up nothing', () => {
    expect(dealAgain(['A', 'B', 'C'], t('A', 'B', 'C', 'D'), 3)).toEqual(['A', 'B', 'C']);
  });
});

describe('handState — nothing-playable takes precedence (0074)', () => {
  it('nothing-playable when there are no playable cards', () => {
    expect(handState(0, 0)).toBe('nothing-playable');
    expect(handState(3, 0)).toBe('nothing-playable'); // precedence over a held count
  });
  it('won when the hand is cleared but cards remain to deal', () => {
    expect(handState(0, 4)).toBe('won');
  });
  it('hand when cards are shown', () => {
    expect(handState(3, 8)).toBe('hand');
  });
});

describe('reconciliation — held is undo-safe memory (0074)', () => {
  it('a completed held card drops from the shown hand but heldIds is untouched, so undo restores it', () => {
    const held = ['A', 'B', 'C'];
    // A completes → gone from playable → drops from the shown hand.
    expect(ids(composeHand(held, t('B', 'C'), 5).cards)).toEqual(['B', 'C']);
    // heldIds is unchanged (compose does not mutate) — so when A is undone (back in playable) it returns.
    expect(ids(composeHand(held, t('A', 'B', 'C'), 5).cards)).toEqual(['A', 'B', 'C']);
  });
});

describe('prefs — hand size and heldIds (localStorage, 0074)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('hand size defaults to 5, round-trips, and rejects garbage / < 1', () => {
    expect(readHandSize()).toBe(DEFAULT_HAND_SIZE);
    storeHandSize(3);
    expect(readHandSize()).toBe(3);
    localStorage.setItem(HAND_SIZE_KEY, '0');
    expect(readHandSize()).toBe(DEFAULT_HAND_SIZE);
    localStorage.setItem(HAND_SIZE_KEY, 'abc');
    expect(readHandSize()).toBe(DEFAULT_HAND_SIZE);
  });

  it('heldIds: absent = null (never dealt); [] round-trips (dealt/won); array round-trips', () => {
    expect(readHeldIds()).toBeNull();
    storeHeldIds([]);
    expect(readHeldIds()).toEqual([]); // dealt-but-empty is distinct from never-dealt
    storeHeldIds(['A', 'B']);
    expect(readHeldIds()).toEqual(['A', 'B']);
    localStorage.setItem(HELD_IDS_KEY, '{"not":"an array"}');
    expect(readHeldIds()).toBeNull(); // garbage falls back to never-dealt
  });
});
