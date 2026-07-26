import type { TaskTier } from '@rankati/shared';
import { describe, expect, it } from 'vitest';
import { type PropagationTask, inheritedUrgency } from '../src/today/propagation';

/**
 * Backward urgency propagation (ADR 0059) — the pure graph walk. Dates INJECTED; no wall clock.
 *
 * `dependsOn` = "blocked by": A.dependsOn=['B'] means A is blocked by B, so B blocks A and A's
 * urgency flows back to B. The deadline sits at the TOP of a chain (it has the due date); the
 * actionable prerequisite sits at the BOTTOM (nothing blocks it).
 */
const ON = '2026-07-19';
const dueIn = (n: number): string =>
  new Date(Date.parse(`${ON}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
const t = (id: string, over: Partial<PropagationTask> = {}): PropagationTask => ({
  id,
  due: null,
  tier: 'normal',
  dependsOn: [],
  ...over,
});

// Reference multipliers (from scoring.ts's curve; see 0057's table).
const M_CRIT_2D = 2.0359; // critical, due in 2 days
const M_CRIT_1D = 2.4394; // critical, due in 1 day
const PEAK = 3.0; // the d=0 ceiling — what an overdue source is clamped to

describe('inheritedUrgency (0059)', () => {
  it('depth 1: a direct blocker inherits the deadline, with the deadline as source', () => {
    const map = inheritedUrgency(
      [t('A', { due: dueIn(2), tier: 'critical', dependsOn: ['B'] }), t('B')],
      ON,
    );
    expect(map.get('B')?.multiplier).toBeCloseTo(M_CRIT_2D, 3);
    expect(map.get('B')?.sourceId).toBe('A');
    expect(map.get('A')).toBeUndefined(); // the source inherits nothing itself
  });

  it('depth 2 (the worked table): the actionable end inherits through the middle', () => {
    // A (due 2d) <- B <- C ; C is actionable.
    const map = inheritedUrgency(
      [
        t('A', { due: dueIn(2), tier: 'critical', dependsOn: ['B'] }),
        t('B', { dependsOn: ['C'] }),
        t('C'),
      ],
      ON,
    );
    expect(map.get('C')?.multiplier).toBeCloseTo(M_CRIT_2D, 3);
    expect(map.get('B')?.multiplier).toBeCloseTo(M_CRIT_2D, 3);
  });

  it('SOURCE ATTRIBUTION: C reports the ultimate deadline A, not the next link B', () => {
    // This is score-invisible — a wrong source leaves every multiplier correct and only the
    // subtext lying — so it gets its own assertion (and its own sabotage).
    const map = inheritedUrgency(
      [
        t('A', { due: dueIn(2), tier: 'critical', dependsOn: ['B'] }),
        t('B', { dependsOn: ['C'] }),
        t('C'),
      ],
      ON,
    );
    expect(map.get('C')?.sourceId).toBe('A'); // NOT 'B'
    expect(map.get('B')?.sourceId).toBe('A');
  });

  it('depth 3+: it reaches the bottom of a long chain', () => {
    const map = inheritedUrgency(
      [
        t('A', { due: dueIn(2), tier: 'critical', dependsOn: ['B'] }),
        t('B', { dependsOn: ['C'] }),
        t('C', { dependsOn: ['D'] }),
        t('D'),
      ],
      ON,
    );
    expect(map.get('D')?.multiplier).toBeCloseTo(M_CRIT_2D, 3);
    expect(map.get('D')?.sourceId).toBe('A');
  });

  it('a diamond: two paths to one prerequisite resolve to the one source (walked once)', () => {
    // A (due 2d) <- B, A <- C, and B <- D, C <- D. D is the single actionable end.
    const map = inheritedUrgency(
      [
        t('A', { due: dueIn(2), tier: 'critical', dependsOn: ['B', 'C'] }),
        t('B', { dependsOn: ['D'] }),
        t('C', { dependsOn: ['D'] }),
        t('D'),
      ],
      ON,
    );
    expect(map.get('D')?.multiplier).toBeCloseTo(M_CRIT_2D, 3);
    expect(map.get('D')?.sourceId).toBe('A');
  });

  it('HIGHEST wins: a blocker of two deadlines takes the more urgent one, and reports IT', () => {
    // C blocks A (due 2d) and X (due 1d, more urgent). C inherits X's urgency, source X.
    const map = inheritedUrgency(
      [
        t('A', { due: dueIn(2), tier: 'critical', dependsOn: ['C'] }),
        t('X', { due: dueIn(1), tier: 'critical', dependsOn: ['C'] }),
        t('C'),
      ],
      ON,
    );
    expect(map.get('C')?.multiplier).toBeCloseTo(M_CRIT_1D, 3); // the higher, not the sum
    expect(map.get('C')?.sourceId).toBe('X');
  });

  it('an OVERDUE source is clamped to the d=0 peak (3×), not the unbounded raw multiplier', () => {
    // S is 30 days overdue — raw m(-30) would be ~1441; it must contribute exactly the peak.
    const map = inheritedUrgency(
      [t('S', { due: dueIn(-30), tier: 'critical', dependsOn: ['T'] }), t('T')],
      ON,
    );
    expect(map.get('T')?.multiplier).toBeCloseTo(PEAK, 6);
    expect(map.get('T')?.sourceId).toBe('S');
  });

  it('an UNDATED source lends nothing — its blocker is not in the map', () => {
    const map = inheritedUrgency([t('D', { dependsOn: ['T'] }), t('T')], ON);
    expect(map.get('T')).toBeUndefined();
  });

  it('the in-progress guard TERMINATES on a cyclic input — impossible via 0053, fed raw here', () => {
    // 0053 refuses cycles at write time, so this can never come from the API. It is constructed
    // ONLY to prove the guard returns rather than looping (a non-terminating walk would hang this
    // test to a timeout). Deliberately exercised, not left looking tested.
    const map = inheritedUrgency(
      [
        t('A', { due: dueIn(2), tier: 'critical', dependsOn: ['B'] }),
        t('B', { dependsOn: ['A'] }),
      ],
      ON,
    );
    expect(map).toBeInstanceOf(Map);
    for (const v of map.values()) expect(Number.isFinite(v.multiplier)).toBe(true);
  });
});
