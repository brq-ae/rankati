import { beforeEach, describe, expect, it } from 'vitest';
import type { Routine as RoutineDto } from '@rankati/shared';
import type { Clock } from '../src/auth/clock';
import type { RoutinesService } from '../src/routines/routines.service';
import type { TelegramConfigService } from '../src/telegram/telegram-config.service';
import { TelegramNagActionsService } from '../src/telegram/telegram-nag-actions.service';

/**
 * The nag button ACTIONS (ADR 0091 M2), unit-tested with a fake clock + mocked routines/config. tz 'UTC'
 * so a UTC instant IS local time — the span→instant math (1h / 3h / until-morning) and next-local-midnight
 * for Skip are deterministic. Routing (did/dismiss + log) is asserted in routines-nag.spec over Postgres.
 */
describe('TelegramNagActionsService (fake clock, UTC)', () => {
  let timezone: string | null;
  let nowDate: Date;
  let didDto: RoutineDto;
  let snoozeCalls: { id: string; until: string }[];
  let skipCalls: { id: string; until: string }[];
  let svc: TelegramNagActionsService;

  const clock: Clock = { now: () => nowDate };
  const config = { getDigestState: async () => ({ timezone }) } as unknown as TelegramConfigService;
  const routines = {
    nagDid: async () => didDto,
    snooze: async (id: string, until: string) => {
      snoozeCalls.push({ id, until });
      return didDto;
    },
    setNagSkip: async (id: string, until: string) => {
      skipCalls.push({ id, until });
    },
  } as unknown as RoutinesService;

  const R = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dto = (over: Partial<RoutineDto>): RoutineDto => ({ name: 'Walk', type: 'interval_floating', ...over }) as RoutineDto;

  beforeEach(() => {
    timezone = 'UTC';
    nowDate = new Date('2026-08-21T18:00:00Z'); // 18:00 local
    didDto = dto({});
    snoozeCalls = [];
    skipCalls = [];
    svc = new TelegramNagActionsService(clock, routines, config);
  });

  it('handleDid returns "done" for an interval routine, and "count/target today" for frequency', async () => {
    didDto = dto({ name: 'Walk', type: 'interval_floating' });
    expect(await svc.handleDid(R)).toBe('✓ Walk — done');
    didDto = dto({ name: 'Water', type: 'frequency', periodCount: 2, targetCount: 4 });
    expect(await svc.handleDid(R)).toBe('✓ Water — 2/4 today');
  });

  it('returns null (→ the handler tells the owner) when no timezone is set', async () => {
    timezone = null;
    expect(await svc.handleDid(R)).toBeNull();
    expect(await svc.handleSnooze(R, 'hour')).toBeNull();
    expect(await svc.handleSkip(R)).toBeNull();
  });

  it('handleSnooze sets snoozedUntil now+1h / now+3h for the fixed spans', async () => {
    await svc.handleSnooze(R, 'hour');
    expect(snoozeCalls[0]).toEqual({ id: R, until: '2026-08-21T19:00:00.000Z' });
    snoozeCalls = [];
    await svc.handleSnooze(R, 'threeHours');
    expect(snoozeCalls[0].until).toBe('2026-08-21T21:00:00.000Z');
  });

  it('handleSnooze "morning" snoozes to the NEXT local 08:00 (past today\'s → tomorrow)', async () => {
    await svc.handleSnooze(R, 'morning'); // now 18:00 → next 08:00 is tomorrow
    expect(snoozeCalls[0].until).toBe('2026-08-22T08:00:00.000Z');
  });

  it('handleSkip mutes until the NEXT local midnight (rest of today)', async () => {
    await svc.handleSkip(R); // now 18:00 → next midnight
    expect(skipCalls[0]).toEqual({ id: R, until: '2026-08-22T00:00:00.000Z' });
  });

  it('laterMenu offers exactly the three spans', () => {
    const rows = svc.laterMenu(R).inline_keyboard;
    expect(rows[0].map((b) => b.text)).toEqual(['1 hour', '3 hours', 'Until morning']);
    expect(rows[0].every((b) => b.callback_data.startsWith('y:'))).toBe(true);
  });
});
