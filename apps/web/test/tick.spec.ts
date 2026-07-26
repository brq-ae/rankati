import { describe, expect, it } from 'vitest';
import { TICK_GRACE_MS, fractionRemaining, msElapsed, msRemaining } from '../src/tick';

/**
 * The pending countdown's derivation (ADR 0055 addendum).
 *
 * The bug these guard against: the ring's animation was driven by component mount, so a screen
 * switch restarted it from full while the real commit still fired at the true deadline — the
 * visual lied about time remaining. The fix makes every countdown visual a pure function of the
 * ONE deadline and the current time. These prove that function: given the same (deadline, now)
 * it always yields the same position, so nothing a remount does can reset it.
 *
 * TICK_GRACE_MS is 15_000; the explicit numbers below are written out rather than derived from
 * it, so a wrong constant OR wrong arithmetic is caught here rather than agreeing with itself.
 */
describe('the pending countdown derives from the deadline, not mount time', () => {
  const D = 1_000_000; // an arbitrary deadline timestamp — the moment the ring empties

  it('at the very start (now = deadline - 15s): full remains, nothing elapsed', () => {
    expect(msRemaining(D, D - 15_000)).toBe(15_000);
    expect(msElapsed(D, D - 15_000)).toBe(0);
    expect(fractionRemaining(D, D - 15_000)).toBe(1);
  });

  it('13s in (2s before the deadline): 2s remain, 13s elapsed — the screen-switch case', () => {
    // Come back to the row here and it must show ~2s of countdown left, not a fresh 15s.
    const now = D - 2_000;
    expect(msRemaining(D, now)).toBe(2_000);
    expect(msElapsed(D, now)).toBe(13_000);
    expect(fractionRemaining(D, now)).toBeCloseTo(2 / 15, 10);
  });

  it('is a pure function of (deadline, now) — there is no mount time to reset', () => {
    const now = D - 6_000; // 9s in
    // The whole point of the addendum: only these two numbers decide the answer.
    expect(msElapsed(D, now)).toBe(9_000);
    expect(msElapsed(D, now)).toBe(msElapsed(D, now));
  });

  it('clamps a deadline already in the past to spent — never negative', () => {
    expect(msRemaining(D, D + 5_000)).toBe(0);
    expect(msElapsed(D, D + 5_000)).toBe(15_000);
    expect(fractionRemaining(D, D + 5_000)).toBe(0);
  });

  it('clamps a deadline further out than one window to full — never over-full', () => {
    const now = D - 15_000 - 9_999; // impossibly early
    expect(msRemaining(D, now)).toBe(15_000);
    expect(msElapsed(D, now)).toBe(0);
    expect(fractionRemaining(D, now)).toBe(1);
  });

  it('the constant is the one the components animate against', () => {
    // If TICK_GRACE_MS ever changes, msElapsed at the start-plus-N must still be N. This ties
    // the derivation to the SAME constant the animation-duration is set from.
    expect(msElapsed(D, D - TICK_GRACE_MS)).toBe(0);
    expect(msElapsed(D, D)).toBe(TICK_GRACE_MS);
  });
});
