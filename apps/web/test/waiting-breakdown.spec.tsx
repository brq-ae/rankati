// @vitest-environment happy-dom
import type { AvailabilityWindow } from '@rankati/shared';
import { describe, expect, it } from 'vitest';
import { isWindowOpen, waitingBreakdown } from '../src/local-day';

/**
 * The "N waiting" arithmetic (ADRs 0052, 0053, 0070).
 *
 * The case that matters is a task gated for SEVERAL reasons at once. Naive counting reports
 * "2 waiting — 1 blocked, 2 not yet due", where the parts exceed the whole; the precedence
 * **blocked > not-yet-due > outside-hours** is what keeps the line readable as a literal
 * sentence — each task counted once, named by its most actionable reason.
 *
 * Every date, time and status here is a literal. Nothing reads the clock.
 */

const DAY = '2026-07-20'; // a Monday
const SATURDAY = '2026-07-25';
const TOMORROW = '2026-07-21';
const YESTERDAY = '2026-07-19';
const AT = '10:00';

type T = {
  id: string;
  status: string;
  notBefore: string | null;
  dependsOn: string[];
  availabilityWindow: AvailabilityWindow | null;
};
const t = (id: string, over: Partial<T> = {}): T => ({
  id,
  status: 'active',
  notBefore: null,
  dependsOn: [],
  availabilityWindow: null,
  ...over,
});

describe('waitingBreakdown', () => {
  it('counts nothing when everything is playable', () => {
    const all = [t('a'), t('b')];
    expect(waitingBreakdown(all, new Set(['a', 'b']), DAY, AT)).toEqual({
      total: 0,
      blocked: 0,
      notYetDue: 0,
      outsideHours: 0,
    });
  });

  it('counts a task waiting on an unfinished prerequisite as blocked', () => {
    const all = [t('blocker'), t('blocked', { dependsOn: ['blocker'] })];
    expect(waitingBreakdown(all, new Set(['blocker']), DAY, AT)).toEqual({
      total: 1,
      blocked: 1,
      notYetDue: 0,
      outsideHours: 0,
    });
  });

  it('counts a later-dated task as not yet due', () => {
    const all = [t('a'), t('later', { notBefore: TOMORROW })];
    expect(waitingBreakdown(all, new Set(['a']), DAY, AT)).toEqual({
      total: 1,
      blocked: 0,
      notYetDue: 1,
      outsideHours: 0,
    });
  });

  it('THE WRINKLE: a task blocked AND not-yet-due is counted ONCE, as blocked', () => {
    // Naive counting says total 1, blocked 1, notYetDue 1 — parts exceeding the whole.
    // Blocked wins because it is the actionable reason: go and do the blocker.
    const all = [
      t('blocker'),
      t('both', { dependsOn: ['blocker'], notBefore: TOMORROW }),
    ];
    const w = waitingBreakdown(all, new Set(['blocker']), DAY, AT);
    expect(w).toEqual({ total: 1, blocked: 1, notYetDue: 0, outsideHours: 0 });
    expect(w.blocked + w.notYetDue + w.outsideHours).toBe(w.total);
  });

  it('the parts always sum to the total across a mixed set', () => {
    const all = [
      t('playable'),
      t('blocker'),
      t('blocked', { dependsOn: ['blocker'] }),
      t('later', { notBefore: TOMORROW }),
      t('both', { dependsOn: ['blocker'], notBefore: TOMORROW }),
    ];
    const w = waitingBreakdown(all, new Set(['playable', 'blocker']), DAY, AT);
    expect(w).toEqual({ total: 3, blocked: 2, notYetDue: 1, outsideHours: 0 });
    expect(w.blocked + w.notYetDue + w.outsideHours).toBe(w.total); // read literally
  });

  it('a done prerequisite does not block', () => {
    const all = [t('blocker', { status: 'done' }), t('was blocked', { dependsOn: ['blocker'] })];
    // The server would return it; if it did, it is not waiting.
    expect(waitingBreakdown(all, new Set(['was blocked']), DAY, AT)).toEqual({
      total: 0,
      blocked: 0,
      notYetDue: 0,
      outsideHours: 0,
    });
  });

  it('ANY unfinished prerequisite blocks, even with others done', () => {
    const all = [
      t('done one', { status: 'done' }),
      t('open one'),
      t('blocked', { dependsOn: ['done one', 'open one'] }),
    ];
    expect(waitingBreakdown(all, new Set(['open one']), DAY, AT)).toMatchObject({ total: 1, blocked: 1 });
  });

  it('a past date is not waiting', () => {
    const all = [t('past', { notBefore: YESTERDAY })];
    expect(waitingBreakdown(all, new Set(['past']), DAY, AT)).toEqual({
      total: 0,
      blocked: 0,
      notYetDue: 0,
      outsideHours: 0,
    });
  });

  it('ignores completed tasks — they retired, they are not waiting', () => {
    const all = [t('done', { status: 'done', notBefore: TOMORROW })];
    expect(waitingBreakdown(all, new Set(), DAY, AT)).toEqual({ total: 0, blocked: 0, notYetDue: 0, outsideHours: 0 });
  });

  it('treats a prerequisite it cannot find as unfinished, never as done', () => {
    // Cascade means this should not happen (0053). If it somehow does, guessing "done"
    // would silently unblock a task; guessing "unfinished" merely keeps it waiting.
    const all = [t('orphan', { dependsOn: ['no-such-task'] })];
    expect(waitingBreakdown(all, new Set(), DAY, AT)).toMatchObject({ total: 1, blocked: 1 });
  });

  it('counts a windowed-out task as outside hours — a NAMED part, not the degradation case (0070)', () => {
    // Weekend window on a Monday: hidden by the server, and now the strip can say why.
    const all = [t('a'), t('weekender', { availabilityWindow: 'weekend' })];
    const w = waitingBreakdown(all, new Set(['a']), DAY, AT);
    expect(w).toEqual({ total: 1, blocked: 0, notYetDue: 0, outsideHours: 1 });
    expect(w.blocked + w.notYetDue + w.outsideHours).toBe(w.total); // parts sum — no bare total
  });

  it('an OPEN window is not waiting at all', () => {
    // Same task, Saturday: the window is open, so the server returned it — it is in todayIds.
    const all = [t('weekender', { availabilityWindow: 'weekend' })];
    expect(waitingBreakdown(all, new Set(['weekender']), SATURDAY, AT)).toEqual({
      total: 0,
      blocked: 0,
      notYetDue: 0,
      outsideHours: 0,
    });
  });

  it('PRECEDENCE: blocked AND outside hours counts once, as blocked', () => {
    // Blocked is the actionable reason — go and do the blocker; the window is just a clock.
    const all = [
      t('blocker'),
      t('both', { dependsOn: ['blocker'], availabilityWindow: 'weekend' }),
    ];
    const w = waitingBreakdown(all, new Set(['blocker']), DAY, AT);
    expect(w).toEqual({ total: 1, blocked: 1, notYetDue: 0, outsideHours: 0 });
  });

  it('PRECEDENCE: not-yet-due AND outside hours counts once, as not yet due', () => {
    // The date is the longer wait: the window reopens within a week, the day may be months out.
    const all = [t('both', { notBefore: TOMORROW, availabilityWindow: 'weekend' })];
    const w = waitingBreakdown(all, new Set(), DAY, AT);
    expect(w).toEqual({ total: 1, blocked: 0, notYetDue: 1, outsideHours: 0 });
  });

  it('all three reasons across a mixed set, each task in exactly one part', () => {
    const all = [
      t('playable'),
      t('blocker'),
      t('blocked', { dependsOn: ['blocker'] }),
      t('later', { notBefore: TOMORROW }),
      t('weekender', { availabilityWindow: 'weekend' }),
      t('everything', { dependsOn: ['blocker'], notBefore: TOMORROW, availabilityWindow: 'weekend' }),
    ];
    const w = waitingBreakdown(all, new Set(['playable', 'blocker']), DAY, AT);
    expect(w).toEqual({ total: 4, blocked: 2, notYetDue: 1, outsideHours: 1 });
    expect(w.blocked + w.notYetDue + w.outsideHours).toBe(w.total);
  });
});

describe('isWindowOpen — the client display mirror of the server predicate (0070)', () => {
  it('the working-hours boundary ladder on a weekday: END-EXCLUSIVE at 14:00', () => {
    // Pinned to the SAME values the server spec pins, so the two cannot drift silently:
    // a drift here mis-labels a strip count, and this ladder is where it fails first.
    expect(isWindowOpen('working_hours', DAY, '07:59')).toBe(false);
    expect(isWindowOpen('working_hours', DAY, '08:00')).toBe(true); // start-inclusive
    expect(isWindowOpen('working_hours', DAY, '13:59')).toBe(true);
    expect(isWindowOpen('working_hours', DAY, '14:00')).toBe(false); // end-EXCLUSIVE
    expect(isWindowOpen('working_hours', DAY, '15:00')).toBe(false);
  });

  it('Monday vs Saturday for all three presets', () => {
    expect(isWindowOpen('working_hours', SATURDAY, '10:00')).toBe(false); // right hours, wrong day
    expect(isWindowOpen('workdays', DAY, '03:00')).toBe(true); // any hour of a workday
    expect(isWindowOpen('workdays', SATURDAY, '10:00')).toBe(false);
    expect(isWindowOpen('weekend', SATURDAY, '10:00')).toBe(true);
    expect(isWindowOpen('weekend', DAY, '10:00')).toBe(false);
  });
});
