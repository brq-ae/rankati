import { describe, expect, it } from 'vitest';
import { type Impact, type PinCandidate, computePin } from '../src/pin';

/**
 * The graded impact-pin logic (ADR 0075). Pure — the caller passes `now`. Covers: None never pins,
 * the fuse boundaries (High 7d / Medium 30d, inclusive), the in-hand and not-playable exclusions,
 * snooze suppression, the one-at-a-time ordering (level > overdue > older), and no-candidates → null.
 */
const DAY = 86_400_000;
const NOW = 20_000 * DAY; // a fixed instant, so nothing reads the wall clock
/** A candidate created `ageDays` (+ optional extra ms) before NOW. */
const c = (id: string, impact: Impact, ageDays: number, extraMs = 0): PinCandidate => ({
  id,
  impact,
  createdAt: NOW - ageDays * DAY - extraMs,
});
const playable = (...ids: string[]) => new Set(ids);
const pin = (
  cands: PinCandidate[],
  ids: Set<string>,
  hand: string[] = [],
  snoozes: Record<string, number> = {},
) => computePin(cands, ids, hand, snoozes, NOW);

describe('computePin — the graded impact pin (ADR 0075)', () => {
  it("'none' never pins — not even 999 days old, playable, unheld", () => {
    expect(pin([c('x', 'none', 999)], playable('x'))).toBeNull();
  });

  describe('fuse boundaries (inclusive)', () => {
    it('High pins at exactly 7 days, not at 6', () => {
      expect(pin([c('h', 'high', 7)], playable('h'))).toMatchObject({
        id: 'h', level: 'high', ageDays: 7, overdueByDays: 0,
      });
      expect(pin([c('h', 'high', 6)], playable('h'))).toBeNull();
    });
    it('Medium pins at exactly 30 days, not at 29', () => {
      expect(pin([c('m', 'medium', 30)], playable('m'))).toMatchObject({
        id: 'm', level: 'medium', ageDays: 30, overdueByDays: 0,
      });
      expect(pin([c('m', 'medium', 29)], playable('m'))).toBeNull();
    });
  });

  it('in-hand exclusion: a qualifying High whose id is in the hand → null', () => {
    expect(pin([c('h', 'high', 8)], playable('h'), ['h'])).toBeNull();
  });

  it('not-playable exclusion: a qualifying task not in playableIds → null', () => {
    expect(pin([c('h', 'high', 8)], playable() /* empty */)).toBeNull();
  });

  describe('snooze (read-only here)', () => {
    it('a snooze in the future suppresses the pin', () => {
      expect(pin([c('h', 'high', 8)], playable('h'), [], { h: NOW + DAY })).toBeNull();
    });
    it('an expired snooze (<= now) lets it pin again', () => {
      expect(pin([c('h', 'high', 8)], playable('h'), [], { h: NOW - DAY })).toMatchObject({ id: 'h' });
    });
    it('an absent snooze does not suppress', () => {
      expect(pin([c('h', 'high', 8)], playable('h'), [], {})).toMatchObject({ id: 'h' });
    });
  });

  describe('one-at-a-time ordering', () => {
    it('returns exactly one, and High beats Medium', () => {
      const r = pin([c('m', 'medium', 100), c('h', 'high', 8)], playable('m', 'h'));
      expect(r?.id).toBe('h'); // a single object, the High one
    });
    it('within a level, the more overdue wins', () => {
      // h1: 8d → overdue 1; h2: 20d → overdue 13.
      expect(pin([c('h1', 'high', 8), c('h2', 'high', 20)], playable('h1', 'h2'))?.id).toBe('h2');
    });
    it('a tie on overdue → the older createdAt wins', () => {
      // Same ageDays (10, so equal overdue), but `a` was created a few hours earlier than `b`.
      const a = c('a', 'high', 10, 5 * 3_600_000); // older
      const b = c('b', 'high', 10, 1 * 3_600_000); // newer
      expect(pin([b, a], playable('a', 'b'))?.id).toBe('a');
    });
  });

  it('no candidates qualify → null', () => {
    expect(pin([], playable())).toBeNull();
    expect(pin([c('h', 'high', 3)], playable('h'))).toBeNull(); // playable & unheld but under fuse
  });
});
