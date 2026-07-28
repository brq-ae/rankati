import { beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../src/auth/clock';
import type { DigestState, TelegramConfigService } from '../src/telegram/telegram-config.service';
import type { TelegramBotService } from '../src/telegram/telegram-bot.service';
import { localNow, TelegramDigestService } from '../src/telegram/telegram-digest.service';

/**
 * The daily-digest scheduler (Step 7), as a PURE unit test: an injected fake Clock, a mocked config, and a
 * mocked bot. Uses tz 'UTC' so a UTC instant IS the local time — the fire window, grace, idempotency, and
 * missed-fire behaviour are all deterministic without real timers.
 */
type PushResult = Awaited<ReturnType<TelegramBotService['pushHand']>>;

describe('TelegramDigestService.tick (fake clock, UTC)', () => {
  let state: DigestState;
  let marked: string[];
  let nowDate: Date;
  let pushResult: PushResult;
  let pushCalls: string[];
  let svc: TelegramDigestService;

  const clock: Clock = { now: () => nowDate };
  const config = {
    getDigestState: async () => state,
    markDigestSent: async (d: string) => {
      marked.push(d);
      state = { ...state, lastSentOn: d };
    },
  } as unknown as TelegramConfigService;
  const bot = {
    pushHand: async (chatId: string) => {
      pushCalls.push(chatId);
      return pushResult;
    },
  } as unknown as TelegramBotService;

  const at = (iso: string) => {
    nowDate = new Date(iso);
  };

  beforeEach(() => {
    state = { enabled: true, time: '08:00', timezone: 'UTC', boundChatId: '42', lastSentOn: null };
    marked = [];
    pushResult = 'sent';
    pushCalls = [];
    nowDate = new Date('2026-07-27T08:05:00Z');
    svc = new TelegramDigestService(clock, config, bot);
  });

  it('fires inside the window and marks the local date on a successful send', async () => {
    await svc.tick();
    expect(pushCalls).toEqual(['42']);
    expect(marked).toEqual(['2026-07-27']);
  });

  it('fires exactly at digestTime (inclusive lower bound)', async () => {
    at('2026-07-27T08:00:00Z');
    await svc.tick();
    expect(pushCalls).toEqual(['42']);
  });

  it('does not fire before digestTime', async () => {
    at('2026-07-27T07:59:00Z');
    await svc.tick();
    expect(pushCalls).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('delivers a late boot inside the 2-hour grace (08:15)', async () => {
    at('2026-07-27T08:15:00Z');
    await svc.tick();
    expect(pushCalls).toEqual(['42']);
    expect(marked).toEqual(['2026-07-27']);
  });

  it('does NOT fire past the grace window — the day is skipped, not sent late at night', async () => {
    at('2026-07-27T10:00:00Z'); // exactly digestTime + 120 → exclusive upper bound
    await svc.tick();
    at('2026-07-27T22:30:00Z');
    await svc.tick();
    expect(pushCalls).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('is idempotent — a second tick the same day does not re-send', async () => {
    await svc.tick();
    await svc.tick();
    expect(pushCalls).toEqual(['42']);
    expect(marked).toEqual(['2026-07-27']);
  });

  it('skips cleanly when disabled, unbound, or missing a timezone', async () => {
    for (const patch of [{ enabled: false }, { boundChatId: null }, { timezone: null }] as Partial<DigestState>[]) {
      state = { enabled: true, time: '08:00', timezone: 'UTC', boundChatId: '42', lastSentOn: null, ...patch };
      pushCalls = [];
      await svc.tick();
      expect(pushCalls).toEqual([]);
    }
  });

  it('empty hand → attempts but does NOT mark, so a task appearing within the window still fires', async () => {
    pushResult = 'empty';
    await svc.tick();
    expect(pushCalls).toEqual(['42']);
    expect(marked).toEqual([]);

    pushResult = 'sent'; // a task becomes playable, still inside the window
    await svc.tick();
    expect(pushCalls).toEqual(['42', '42']);
    expect(marked).toEqual(['2026-07-27']);
  });

  it('no live bot → skip without marking (retries next tick)', async () => {
    pushResult = 'no-bot';
    await svc.tick();
    expect(pushCalls).toEqual(['42']);
    expect(marked).toEqual([]);
  });

  it('send failure → do not mark, so the next tick retries within the window', async () => {
    pushResult = 'error';
    await svc.tick();
    expect(marked).toEqual([]);
  });

  it('start/stop are safe to call repeatedly and leave no live timer', () => {
    svc.start();
    svc.start();
    svc.stop();
    svc.stop();
    expect(() => svc.onModuleDestroy()).not.toThrow();
  });
});

describe('localNow', () => {
  it('reads the local date + minute-of-day in the timezone (DST via Intl)', () => {
    expect(localNow(new Date('2026-07-27T08:05:00Z'), 'UTC')).toEqual({ date: '2026-07-27', minutes: 485 });
    // Asia/Dubai = UTC+4 → 08:05Z is 12:05 local (725 min), same date
    expect(localNow(new Date('2026-07-27T08:05:00Z'), 'Asia/Dubai')).toEqual({ date: '2026-07-27', minutes: 725 });
    // 21:30Z is already 01:30 the NEXT day in Dubai
    expect(localNow(new Date('2026-07-27T21:30:00Z'), 'Asia/Dubai')).toEqual({ date: '2026-07-28', minutes: 90 });
  });
});
