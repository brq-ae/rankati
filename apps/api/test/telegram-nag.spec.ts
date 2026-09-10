import { beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../src/auth/clock';
import type { NaggableRoutine, RoutinesService } from '../src/routines/routines.service';
import type { SettingsService } from '../src/settings.service';
import type { TelegramBotService } from '../src/telegram/telegram-bot.service';
import type { TelegramReplyMarkup } from '../src/telegram/telegram-bot.factory';
import { TelegramNagService } from '../src/telegram/telegram-nag.service';

/**
 * The nag evaluation (ADR 0091 M2), as a pure unit test: mocked routines/settings/bot + a fake clock. The
 * per-type "due & unsatisfied" (shouldNag) is asserted in routines-nag.spec against real Postgres; here we
 * fix `shouldNag`/`progress` and drive the GATES — quiet-hours, snooze, skip-today, cadence — and the push.
 */
describe('TelegramNagService.evaluate (fake clock)', () => {
  let candidates: NaggableRoutine[];
  let quiet: { start: string | null; end: string | null };
  let nowDate: Date;
  let pushResult: 'sent' | 'no-bot' | 'error';
  let pushed: { chatId: string; text: string; keyboard: TelegramReplyMarkup }[];
  let marked: { id: string; at: Date }[];
  let svc: TelegramNagService;

  const clock: Clock = { now: () => nowDate };
  const settings = { getQuietHours: async () => quiet } as unknown as SettingsService;
  const routines = {
    naggable: async () => candidates,
    markNagged: async (id: string, at: Date) => {
      marked.push({ id, at });
    },
  } as unknown as RoutinesService;
  const bot = {
    pushNag: async (chatId: string, text: string, keyboard: TelegramReplyMarkup) => {
      pushed.push({ chatId, text, keyboard });
      return pushResult;
    },
  } as unknown as TelegramBotService;

  const NOW = '2026-08-21T18:00:00Z';
  const local = { date: '2026-08-21', minutes: 18 * 60 };

  /** A naggable candidate with sane defaults (due, no snooze/skip, hourly cadence, never nagged). */
  const cand = (over: Partial<NaggableRoutine['row']> & { id: string; name: string; type: string }, extra?: Partial<NaggableRoutine>): NaggableRoutine =>
    ({
      row: {
        snoozedUntil: null,
        nagSkipUntil: null,
        nagIntervalMinutes: 60,
        lastNaggedAt: null,
        ...over,
      },
      shouldNag: true,
      progress: null,
      ...extra,
    }) as unknown as NaggableRoutine;

  beforeEach(() => {
    candidates = [];
    quiet = { start: null, end: null };
    nowDate = new Date(NOW);
    pushResult = 'sent';
    pushed = [];
    marked = [];
    svc = new TelegramNagService(clock, routines, settings, bot);
  });

  it('pushes a nag for a due, unsatisfied, un-snoozed, cadence-ready routine, and marks it', async () => {
    candidates = [cand({ id: 'r1', name: 'Walk', type: 'interval_floating' })];
    await svc.evaluate(local, '42');
    expect(pushed).toHaveLength(1);
    expect(pushed[0].chatId).toBe('42');
    expect(pushed[0].text).toBe('🔔 Walk');
    const buttons = pushed[0].keyboard.inline_keyboard[0];
    expect(buttons.map((b) => b.text)).toEqual(['✓ Did it', '😴 Later', 'Skip today']);
    expect(buttons[0].callback_data.startsWith('g:')).toBe(true);
    expect(buttons[1].callback_data.startsWith('w:')).toBe(true);
    expect(buttons[2].callback_data.startsWith('k:')).toBe(true);
    expect(marked).toEqual([{ id: 'r1', at: nowDate }]);
  });

  it('renders frequency progress "count/target today"', async () => {
    candidates = [cand({ id: 'r2', name: 'Water', type: 'frequency' }, { progress: { count: 2, target: 4 } })];
    await svc.evaluate(local, '42');
    expect(pushed[0].text).toBe('🔔 Water — 2/4 today');
  });

  it('a WEEKLY frequency nag says "this week", not "today" (ADR 0093)', async () => {
    candidates = [
      cand({ id: 'r3', name: 'Walk – 5000 Steps', type: 'frequency', periodUnit: 'week' }, { progress: { count: 3, target: 7 } }),
    ];
    await svc.evaluate(local, '42');
    expect(pushed[0].text).toBe('🔔 Walk – 5000 Steps — 3/7 this week');
  });

  it('is suppressed for the rest of the day once done today (lastDidOn == local.date), ADR 0093', async () => {
    // The frequency bug: 3/7 < 7 so shouldNag is still true, but "Did it" today must silence the nag.
    candidates = [
      cand(
        { id: 'r1', name: 'Walk', type: 'frequency', periodUnit: 'week', lastDidOn: new Date('2026-08-21T00:00:00Z') },
        { progress: { count: 3, target: 7 } },
      ),
    ];
    await svc.evaluate(local, '42');
    expect(pushed).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('resumes nagging the next day (lastDidOn is yesterday), ADR 0093', async () => {
    candidates = [
      cand(
        { id: 'r1', name: 'Walk', type: 'frequency', periodUnit: 'week', lastDidOn: new Date('2026-08-20T00:00:00Z') },
        { progress: { count: 3, target: 7 } },
      ),
    ];
    await svc.evaluate(local, '42');
    expect(pushed).toHaveLength(1); // a new day, still under target → nag again
  });

  it('does NOT push a routine that is not due / already satisfied (shouldNag false)', async () => {
    candidates = [cand({ id: 'r1', name: 'Walk', type: 'interval_floating' }, { shouldNag: false })];
    await svc.evaluate(local, '42');
    expect(pushed).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('is suppressed while snoozed (snoozedUntil in the future)', async () => {
    candidates = [cand({ id: 'r1', name: 'Walk', type: 'interval_floating', snoozedUntil: new Date('2026-08-21T20:00:00Z') })];
    await svc.evaluate(local, '42');
    expect(pushed).toEqual([]);
  });

  it('is suppressed when skipped today (nagSkipUntil in the future)', async () => {
    candidates = [cand({ id: 'r1', name: 'Walk', type: 'interval_floating', nagSkipUntil: new Date('2026-08-22T00:00:00Z') })];
    await svc.evaluate(local, '42');
    expect(pushed).toEqual([]);
  });

  it('respects the cadence: too-soon since lastNaggedAt is suppressed; elapsed fires', async () => {
    // hourly cadence, last nagged 30 min ago → too soon
    candidates = [cand({ id: 'r1', name: 'Walk', type: 'interval_floating', lastNaggedAt: new Date('2026-08-21T17:30:00Z') })];
    await svc.evaluate(local, '42');
    expect(pushed).toEqual([]);
    // last nagged 61 min ago → elapsed → fires
    candidates = [cand({ id: 'r1', name: 'Walk', type: 'interval_floating', lastNaggedAt: new Date('2026-08-21T16:59:00Z') })];
    await svc.evaluate(local, '42');
    expect(pushed).toHaveLength(1);
  });

  it('pushes NOTHING while inside quiet-hours, even for a due routine', async () => {
    quiet = { start: '17:00', end: '19:00' }; // now 18:00 is inside
    candidates = [cand({ id: 'r1', name: 'Walk', type: 'interval_floating' })];
    await svc.evaluate(local, '42');
    expect(pushed).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('does NOT mark when the push fails (retries next tick)', async () => {
    pushResult = 'error';
    candidates = [cand({ id: 'r1', name: 'Walk', type: 'interval_floating' })];
    await svc.evaluate(local, '42');
    expect(pushed).toHaveLength(1);
    expect(marked).toEqual([]); // not marked → next tick retries
  });
});
