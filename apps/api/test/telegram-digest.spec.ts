import { beforeEach, describe, expect, it } from 'vitest';
import type { QuietHours } from '@rankati/shared';
import type { Clock } from '../src/auth/clock';
import type { SettingsService } from '../src/settings.service';
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
  let quiet: QuietHours;
  let svc: TelegramDigestService;

  const clock: Clock = { now: () => nowDate };
  const settings = { getQuietHours: async () => quiet } as unknown as SettingsService;
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
  // The nag pass is unit-tested in telegram-nag.spec.ts; here it is a no-op spy so the digest tests stay
  // focused on digest behaviour, while confirming the tick calls it (with local + the bound chat).
  const nagCalls: { date: string; minutes: number; chatId: string }[] = [];
  const nags = {
    evaluate: async (local: { date: string; minutes: number }, chatId: string) => {
      nagCalls.push({ ...local, chatId });
    },
  } as unknown as import('../src/telegram/telegram-nag.service').TelegramNagService;

  // Meeting-reminder pass (ADR 0097) — stubbed; the tick just needs to call it every tick with (now, chat,
  // tz). Its own firing logic is covered by telegram-meeting-reminder.spec.ts.
  const reminderCalls: { chatId: string; tz: string }[] = [];
  const meetingReminders = {
    evaluate: async (_now: Date, chatId: string, tz: string) => {
      reminderCalls.push({ chatId, tz });
    },
  } as unknown as import('../src/telegram/telegram-meeting-reminder.service').TelegramMeetingReminderService;

  const at = (iso: string) => {
    nowDate = new Date(iso);
  };

  beforeEach(() => {
    state = { enabled: true, time: '08:00', timezone: 'UTC', boundChatId: '42', lastSentOn: null };
    marked = [];
    pushResult = 'sent';
    pushCalls = [];
    quiet = { start: null, end: null }; // quiet-hours OFF by default → existing tests unaffected
    nowDate = new Date('2026-07-27T08:05:00Z');
    nagCalls.length = 0;
    reminderCalls.length = 0;
    svc = new TelegramDigestService(clock, config, bot, settings, nags, meetingReminders);
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

  // ── Nag pass (ADR 0091 M2): the tick drives it, independent of the digest toggle ─────────────────
  describe('nag pass integration', () => {
    it('the tick calls the nag evaluate with the local day/minute + the bound chat', async () => {
      at('2026-07-27T08:05:00Z'); // 08:05 UTC → minutes 485
      await svc.tick();
      expect(nagCalls).toEqual([{ date: '2026-07-27', minutes: 485, chatId: '42' }]);
    });

    it('the tick also runs the meeting-reminder pass with the bound chat + tz (ADR 0097)', async () => {
      await svc.tick();
      expect(reminderCalls).toEqual([{ chatId: '42', tz: 'UTC' }]);
    });

    it('no bound chat / no timezone → the meeting-reminder pass does not run either', async () => {
      state = { ...state, boundChatId: null };
      await svc.tick();
      expect(reminderCalls).toEqual([]);
    });

    it('the nag pass runs even when the daily digest is DISABLED (nagging is per-routine)', async () => {
      state = { ...state, enabled: false };
      await svc.tick();
      expect(nagCalls).toHaveLength(1); // nags evaluated
      expect(pushCalls).toEqual([]); // but no digest sent
    });

    it('no bound chat / no timezone → neither the digest nor the nag pass runs', async () => {
      state = { ...state, boundChatId: null };
      await svc.tick();
      expect(nagCalls).toEqual([]);
      state = { enabled: true, time: '08:00', timezone: null, boundChatId: '42', lastSentOn: null };
      await svc.tick();
      expect(nagCalls).toEqual([]);
    });
  });

  // ── Quiet-hours (ADR 0091): delay-not-drop + never-push-while-quiet ──────────────────────────────
  describe('quiet-hours', () => {
    it('does NOT push while currently inside the quiet window, and does not mark sent', async () => {
      // digest 08:00, quiet 22:00–08:00; "now" 07:30 is inside quiet → suppressed, pending (not marked).
      state = { ...state, time: '08:00', lastSentOn: null };
      quiet = { start: '22:00', end: '08:00' };
      at('2026-07-27T07:30:00Z');
      await svc.tick();
      expect(pushCalls).toEqual([]);
      expect(marked).toEqual([]); // stays pending → retries / rolls; no double-send risk
    });

    it('a digest scheduled INSIDE quiet-hours ACTUALLY FIRES at quiet-end (delay, not drop)', async () => {
      // digest 07:00 is inside quiet 22:00–08:00 → effective send time is quiet-end 08:00.
      state = { ...state, time: '07:00', lastSentOn: null };
      quiet = { start: '22:00', end: '08:00' };

      at('2026-07-27T07:00:00Z'); // its own time, but inside quiet → suppressed
      await svc.tick();
      expect(pushCalls).toEqual([]);

      at('2026-07-27T08:00:00Z'); // quiet-end (end-exclusive) → FIRES here
      await svc.tick();
      expect(pushCalls).toEqual(['42']);
      expect(marked).toEqual(['2026-07-27']); // fired once, at quiet-end
    });

    it('fires the delayed digest EXACTLY ONCE (no double-send after quiet-end)', async () => {
      state = { ...state, time: '07:00', lastSentOn: null };
      quiet = { start: '22:00', end: '08:00' };
      at('2026-07-27T08:00:00Z');
      await svc.tick(); // fires + marks
      at('2026-07-27T08:01:00Z');
      await svc.tick(); // already sent today → no second push
      expect(pushCalls).toEqual(['42']);
    });

    it('a normal digest OUTSIDE quiet-hours is unaffected', async () => {
      // digest 09:00, quiet 22:00–08:00; 09:00 is not in quiet → fires at its own time.
      state = { ...state, time: '09:00', lastSentOn: null };
      quiet = { start: '22:00', end: '08:00' };
      at('2026-07-27T09:00:00Z');
      await svc.tick();
      expect(pushCalls).toEqual(['42']);
      expect(marked).toEqual(['2026-07-27']);
    });

    it('a digest AT quiet-end (08:00, end-exclusive) fires normally — not treated as inside quiet', async () => {
      state = { ...state, time: '08:00', lastSentOn: null };
      quiet = { start: '22:00', end: '08:00' };
      at('2026-07-27T08:00:00Z');
      await svc.tick();
      expect(pushCalls).toEqual(['42']);
    });
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
