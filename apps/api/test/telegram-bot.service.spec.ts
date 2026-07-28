import type { Task } from '@rankati/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  TelegramBot,
  TelegramBotFactory,
  TelegramContext,
  TelegramReplyMarkup,
} from '../src/telegram/telegram-bot.factory';
import { encodeDiscard, encodeDone, encodePinSnooze, encodeRefile } from '../src/telegram/telegram-callback';
import type {
  CaptureResult,
  DiscardResult,
  RefileResult,
  TelegramCaptureService,
} from '../src/telegram/telegram-capture.service';
import type {
  CompleteResult,
  HandResult,
  PinInfo,
  TodayResult,
  TelegramReadService,
} from '../src/telegram/telegram-read.service';
import { TelegramBotService } from '../src/telegram/telegram-bot.service';
import type { TelegramConfigService } from '../src/telegram/telegram-config.service';
import type { PinSnoozeService } from '../src/pin-snooze.service';

/**
 * Transport LIFECYCLE (3), binding/command WIRING (4), capture/re-file (5), and read commands (6), as PURE
 * unit tests: config/capture/read are mocked and a fake bot factory stands in for grammy — no DB, no network.
 * The fake bot captures the handlers the service registers (routing callbacks by their trigger, as grammy
 * does) so they can be fired with a synthetic update. The rules themselves are tested against real Postgres
 * (telegram-config/-capture/-read specs) and the codec in telegram-callback.spec.
 */
interface FakeBot extends TelegramBot {
  token: string;
  setCommandsCalls: number;
  startCalls: number;
  stopCalls: number;
  sendMessageCalls: { chatId: string | number; text: string; markup?: TelegramReplyMarkup }[];
  messageHandler?: (ctx: TelegramContext) => unknown;
  callbackHandlers: { trigger: string | RegExp; handler: (ctx: TelegramContext) => unknown }[];
  commandHandlers: Record<string, (ctx: TelegramContext) => unknown>;
}

const TOKEN_A = '111111111:AAA-token-a_abcdefghijklmnopqrst';
const TOKEN_B = '222222222:BBB-token-b_abcdefghijklmnopqrst';
const TASK_ID = '11111111-2222-3333-4444-555555555555';
const LIST_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('TelegramBotService (mocked config/capture/read, fake bot)', () => {
  let created: FakeBot[];
  let storedToken: string | null;
  let binding: { boundChatId: string | null; linkCode: string | null };
  let bindOutcome: 'bound' | 'bad-code' | 'no-code';
  let bindCalls: { chatId: string; code: string }[];
  let captureResult: CaptureResult;
  let captureCalls: string[];
  let captureThrows: boolean;
  let refileResult: RefileResult;
  let refileCalls: { taskId: string; listId: string }[];
  let discardResult: DiscardResult;
  let discardCalls: string[];
  let dealResult: HandResult;
  let dealCalls: number[];
  let dealTodayResult: TodayResult;
  let dealTodayCalls: number;
  let snoozeCalls: string[];
  let snoozeThrows: boolean;
  let completeResult: CompleteResult;
  let completeCalls: string[];
  let setCommandsThrows: boolean;
  let service: TelegramBotService;

  const factory: TelegramBotFactory = (token) => {
    const b: FakeBot = {
      token,
      setCommandsCalls: 0,
      startCalls: 0,
      stopCalls: 0,
      commandHandlers: {},
      callbackHandlers: [],
      sendMessageCalls: [],
      api: {
        setMyCommands: async () => {
          b.setCommandsCalls += 1;
          if (setCommandsThrows) throw new Error('401: Unauthorized');
          return true;
        },
        sendMessage: async (chatId: string | number, text: string, other?: { reply_markup?: TelegramReplyMarkup }) => {
          b.sendMessageCalls.push({ chatId, text, markup: other?.reply_markup });
          return {};
        },
      },
      catch: () => undefined,
      command: (cmd, h) => {
        b.commandHandlers[cmd] = h;
      },
      on: (_filter, h) => {
        b.messageHandler = h;
      },
      callbackQuery: (trigger, h) => {
        b.callbackHandlers.push({ trigger, handler: h });
      },
      start: async () => {
        b.startCalls += 1;
      },
      stop: async () => {
        b.stopCalls += 1;
      },
    };
    created.push(b);
    return b;
  };

  const mockConfig = {
    getRawToken: async () => storedToken,
    getBinding: async () => binding,
    bindChat: async (chatId: string, code: string) => {
      bindCalls.push({ chatId, code });
      return bindOutcome;
    },
  } as unknown as TelegramConfigService;

  const mockCapture = {
    capture: async (text: string) => {
      captureCalls.push(text);
      if (captureThrows) throw new Error('boom');
      return captureResult;
    },
    refile: async (taskId: string, listId: string) => {
      refileCalls.push({ taskId, listId });
      return refileResult;
    },
    discard: async (taskId: string) => {
      discardCalls.push(taskId);
      return discardResult;
    },
  } as unknown as TelegramCaptureService;

  const mockRead = {
    deal: async (limit: number) => {
      dealCalls.push(limit);
      return dealResult;
    },
    dealToday: async () => {
      dealTodayCalls += 1;
      return dealTodayResult;
    },
    complete: async (taskId: string) => {
      completeCalls.push(taskId);
      return completeResult;
    },
  } as unknown as TelegramReadService;

  const mockPinSnooze = {
    snooze: async (taskId: string) => {
      snoozeCalls.push(taskId);
      if (snoozeThrows) throw new Error('nope');
      return { pinSnoozedUntil: new Date() };
    },
  } as unknown as PinSnoozeService;

  const aTask = (title: string): CaptureResult['task'] =>
    ({ id: TASK_ID, title, listId: 'inbox', needsDetails: true }) as unknown as CaptureResult['task'];
  const card = (id: string, title: string): Task =>
    ({ id, title, listId: 'l', needsDetails: false }) as unknown as Task;
  const pinInfo = (id: string, title: string, reason: string): PinInfo => ({ task: card(id, title), reason });

  beforeEach(() => {
    created = [];
    storedToken = null;
    binding = { boundChatId: null, linkCode: null };
    bindOutcome = 'bad-code';
    bindCalls = [];
    captureResult = { task: aTask('x'), inboxName: 'Inbox', truncated: false, refileLists: [], overflow: 0 };
    captureCalls = [];
    captureThrows = false;
    refileResult = { status: 'moved', listName: 'Work' };
    refileCalls = [];
    discardResult = { status: 'discarded', title: 'X' };
    discardCalls = [];
    dealResult = { status: 'ok', cards: [] };
    dealCalls = [];
    dealTodayResult = { status: 'ok', cards: [], pin: null };
    dealTodayCalls = 0;
    snoozeCalls = [];
    snoozeThrows = false;
    completeResult = { status: 'done', title: 'X' };
    completeCalls = [];
    setCommandsThrows = false;
    service = new TelegramBotService(mockConfig, mockCapture, mockRead, mockPinSnooze, factory);
  });

  // --- fire a captured handler with a synthetic update; collect every outbound effect ---
  interface Rec {
    replies: { text: string; markup?: TelegramReplyMarkup }[];
    edits: string[];
    answers: (string | undefined)[];
  }
  function makeCtx(
    chatId: number,
    opts: { text?: string; match?: string; data?: string } = {},
  ): { ctx: TelegramContext; rec: Rec } {
    const rec: Rec = { replies: [], edits: [], answers: [] };
    const ctx: TelegramContext = {
      chat: { id: chatId },
      message: opts.text !== undefined ? { text: opts.text } : undefined,
      match: opts.match,
      callbackQuery: opts.data !== undefined ? { data: opts.data } : undefined,
      reply: async (text, extra) => {
        rec.replies.push({ text, markup: extra?.reply_markup });
        return true;
      },
      answerCallbackQuery: async (text) => {
        rec.answers.push(text);
        return true;
      },
      editMessageText: async (text) => {
        rec.edits.push(text);
        return true;
      },
    };
    return { ctx, rec };
  }
  async function fire(handler: ((ctx: TelegramContext) => unknown) | undefined, chatId: number, text: string) {
    const { rec } = await fireCtx(handler, makeCtx(chatId, { text }));
    return rec.replies.map((r) => r.text);
  }
  async function fireCtx(
    handler: ((ctx: TelegramContext) => unknown) | undefined,
    made: { ctx: TelegramContext; rec: Rec },
  ) {
    await handler?.(made.ctx);
    return made;
  }
  // Route a callback to the handler whose trigger matches its data — the fake's stand-in for grammy routing.
  async function fireCallback(bot: FakeBot, chatId: number, data: string) {
    const made = makeCtx(chatId, { data });
    const match = bot.callbackHandlers.find(({ trigger }) =>
      trigger instanceof RegExp ? trigger.test(data) : data.startsWith(String(trigger)),
    );
    await match?.handler(made.ctx);
    return made;
  }
  const startedBot = async () => {
    storedToken = TOKEN_A;
    await service.syncFromConfig();
    return created[0];
  };

  // ---------------------------------------------------------------- lifecycle (Step 3)
  it('does nothing when no token is stored', async () => {
    await service.syncFromConfig();
    expect(created).toHaveLength(0);
  });

  it('starts the poller and registers the "/" menu when a token exists', async () => {
    const bot = await startedBot();
    expect(created).toHaveLength(1);
    expect(bot.token).toBe(TOKEN_A);
    expect(bot.setCommandsCalls).toBe(1);
    expect(bot.startCalls).toBe(1);
  });

  it('is idempotent — the same token does not re-create the poller', async () => {
    await startedBot();
    await service.syncFromConfig();
    expect(created).toHaveLength(1);
  });

  it('restarts on a changed token — old stopped, new started', async () => {
    await startedBot();
    storedToken = TOKEN_B;
    await service.syncFromConfig();
    expect(created).toHaveLength(2);
    expect(created[0].stopCalls).toBe(1);
    expect(created[1].token).toBe(TOKEN_B);
    expect(created[1].startCalls).toBe(1);
  });

  it('stops the poller when the token is cleared', async () => {
    await startedBot();
    storedToken = null;
    await service.syncFromConfig();
    expect(created[0].stopCalls).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('stops the poller on shutdown (onModuleDestroy)', async () => {
    await startedBot();
    await service.onModuleDestroy();
    expect(created[0].stopCalls).toBe(1);
  });

  // ---------------------------------------------------------------- poller health (Step 8)
  it('status is stopped with no token, running after a good start, stopped again when cleared', async () => {
    expect(service.getStatus()).toBe('stopped');
    await startedBot();
    expect(service.getStatus()).toBe('running');
    storedToken = null;
    await service.syncFromConfig();
    expect(service.getStatus()).toBe('stopped');
  });

  it('status is error when Telegram rejects the token (setMyCommands throws) — not silently dead', async () => {
    setCommandsThrows = true;
    storedToken = TOKEN_A;
    await service.syncFromConfig();
    expect(service.getStatus()).toBe('error');
    expect(created[0].startCalls).toBe(0); // never begins polling a rejected token
    expect(await service.pushHand('42')).toBe('no-bot'); // and nothing is running to push through
  });

  // ---------------------------------------------------------------- binding (Step 4)
  it('unbound: free text is forwarded (trimmed) to bindChat; a match confirms the link', async () => {
    binding = { boundChatId: null, linkCode: 'ABCD1234' };
    bindOutcome = 'bound';
    const bot = await startedBot();
    const replies = await fire(bot.messageHandler, 42, '  abcd1234 ');
    expect(bindCalls).toEqual([{ chatId: '42', code: 'abcd1234' }]);
    expect(replies[0]).toContain('Linked');
  });

  it('unbound: a wrong code is turned away as not linked', async () => {
    binding = { boundChatId: null, linkCode: 'ABCD1234' };
    bindOutcome = 'bad-code';
    const bot = await startedBot();
    expect((await fire(bot.messageHandler, 42, 'nope'))[0]).toContain("isn't linked");
  });

  it('/start: unbound points to the link code; bound-self welcomes; a stranger is refused', async () => {
    const bot = await startedBot();
    binding = { boundChatId: null, linkCode: 'X' };
    expect((await fire(bot.commandHandlers.start, 42, '/start'))[0]).toContain('link code');
    binding = { boundChatId: '42', linkCode: null };
    expect((await fire(bot.commandHandlers.start, 42, '/start'))[0]).toContain("You're linked");
    expect((await fire(bot.commandHandlers.start, 999, '/start'))[0]).toContain('another chat');
  });

  it('/help lists the commands', async () => {
    const bot = await startedBot();
    const replies = await fire(bot.commandHandlers.help, 42, '/help');
    expect(replies[0]).toContain('/add');
    expect(replies[0]).toContain('/today');
    expect(replies[0]).toContain('/now');
  });

  // ---------------------------------------------------------------- capture + re-file (Step 5)
  it('bound free text is captured and offered as 2-per-row re-file buttons', async () => {
    binding = { boundChatId: '42', linkCode: null };
    captureResult = {
      task: aTask('buy milk'),
      inboxName: 'Inbox',
      truncated: false,
      refileLists: [
        { id: 'l1', name: 'Work' },
        { id: 'l2', name: 'Home' },
        { id: 'l3', name: 'Errands' },
      ] as unknown as CaptureResult['refileLists'],
      overflow: 0,
    };
    const bot = await startedBot();
    const { rec } = await fireCtx(bot.messageHandler, makeCtx(42, { text: 'buy milk' }));
    expect(captureCalls).toEqual(['buy milk']);
    expect(rec.replies[0].text).toContain('Captured: buy milk');
    const rows = rec.replies[0].markup?.inline_keyboard ?? [];
    // 3 list buttons, 2-per-row, then a 🗑 Discard button on its own row
    expect(rows.map((r) => r.length)).toEqual([2, 1, 1]);
    expect(rows.flat().map((b) => b.text)).toEqual(['Work', 'Home', 'Errands', '🗑 Discard']);
    expect(rows[0][0].callback_data.startsWith('m:')).toBe(true);
    expect(rows[2][0].callback_data.startsWith('x:')).toBe(true);
  });

  it('/add <text> captures; /add alone hints and captures nothing', async () => {
    binding = { boundChatId: '42', linkCode: null };
    const bot = await startedBot();
    await fireCtx(bot.commandHandlers.add, makeCtx(42, { match: 'call plumber' }));
    expect(captureCalls).toEqual(['call plumber']);
    captureCalls = [];
    const { rec } = await fireCtx(bot.commandHandlers.add, makeCtx(42, { match: '   ' }));
    expect(captureCalls).toEqual([]);
    expect(rec.replies[0].text).toContain('/add');
  });

  it('a capture failure replies friendly, not a throw', async () => {
    binding = { boundChatId: '42', linkCode: null };
    captureThrows = true;
    const bot = await startedBot();
    const { rec } = await fireCtx(bot.messageHandler, makeCtx(42, { text: 'boom' }));
    expect(rec.replies[0].text).toContain('went wrong');
  });

  it('a re-file callback from the bound chat moves the task and edits the message', async () => {
    binding = { boundChatId: '42', linkCode: null };
    refileResult = { status: 'moved', listName: 'Work' };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, encodeRefile(TASK_ID, LIST_ID));
    expect(refileCalls).toEqual([{ taskId: TASK_ID, listId: LIST_ID }]);
    expect(rec.edits[0]).toContain('Moved to Work');
  });

  it('a re-file callback from a stranger chat is ignored — answered, no move, no edit', async () => {
    binding = { boundChatId: '42', linkCode: null };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 999, encodeRefile(TASK_ID, LIST_ID));
    expect(refileCalls).toHaveLength(0);
    expect(rec.answers).toHaveLength(1);
    expect(rec.edits).toHaveLength(0);
  });

  it('a re-file callback with malformed data answers cleanly, no move', async () => {
    binding = { boundChatId: '42', linkCode: null };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, 'm:garbage');
    expect(refileCalls).toHaveLength(0);
    expect(rec.answers[0]).toContain('no longer valid');
  });

  it('a bound capture with no other lists still gets a lone 🗑 Discard button', async () => {
    binding = { boundChatId: '42', linkCode: null };
    captureResult = { task: aTask('lone'), inboxName: 'Inbox', truncated: false, refileLists: [], overflow: 0 };
    const bot = await startedBot();
    const { rec } = await fireCtx(bot.messageHandler, makeCtx(42, { text: 'lone' }));
    const rows = rec.replies[0].markup?.inline_keyboard ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0][0].text).toBe('🗑 Discard');
    expect(rec.replies[0].text).toContain('Make lists in the app');
  });

  it('a 🗑 Discard tap from the bound chat deletes the task and edits the message', async () => {
    binding = { boundChatId: '42', linkCode: null };
    discardResult = { status: 'discarded', title: 'oops' };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, encodeDiscard(TASK_ID));
    expect(discardCalls).toEqual([TASK_ID]);
    expect(rec.edits[0]).toContain('🗑 Discarded');
  });

  it('a 🗑 Discard from a stranger is ignored — no delete, no edit', async () => {
    binding = { boundChatId: '42', linkCode: null };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 999, encodeDiscard(TASK_ID));
    expect(discardCalls).toHaveLength(0);
    expect(rec.edits).toHaveLength(0);
    expect(rec.answers).toHaveLength(1);
  });

  it('a 🗑 Discard of a stale/foreign task answers cleanly, no edit', async () => {
    binding = { boundChatId: '42', linkCode: null };
    discardResult = { status: 'gone' };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, encodeDiscard(TASK_ID));
    expect(rec.edits).toHaveLength(0);
    expect(rec.answers[0]).toContain('no longer available');
  });

  it('a malformed 🗑 Discard payload answers cleanly, no delete', async () => {
    binding = { boundChatId: '42', linkCode: null };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, 'x:short');
    expect(discardCalls).toHaveLength(0);
    expect(rec.answers[0]).toContain('no longer valid');
  });

  // ---------------------------------------------------------------- read commands (Step 6)
  it('/today is gated to the bound chat', async () => {
    binding = { boundChatId: '42', linkCode: null };
    const bot = await startedBot();
    expect((await fire(bot.commandHandlers.today, 999, '/today'))[0]).toContain("isn't linked");
  });

  it('/today with no timezone tells you to set it', async () => {
    binding = { boundChatId: '42', linkCode: null };
    dealTodayResult = { status: 'no-timezone' };
    const bot = await startedBot();
    const { rec } = await fireCtx(bot.commandHandlers.today, makeCtx(42, { text: '/today' }));
    expect(rec.replies[0].text).toContain('timezone');
    expect(rec.replies[0].markup).toBeUndefined();
  });

  it('/today with an empty hand says nothing playable', async () => {
    binding = { boundChatId: '42', linkCode: null };
    dealTodayResult = { status: 'ok', cards: [], pin: null };
    const bot = await startedBot();
    const { rec } = await fireCtx(bot.commandHandlers.today, makeCtx(42, { text: '/today' }));
    expect(rec.replies[0].text).toContain('Nothing playable');
    expect(rec.replies[0].markup).toBeUndefined();
  });

  it('/today renders the hand with a ✓ Done button per card (today mode), no pin line when none', async () => {
    binding = { boundChatId: '42', linkCode: null };
    dealTodayResult = { status: 'ok', cards: [card(TASK_ID, 'A'), card(LIST_ID, 'B')], pin: null };
    const bot = await startedBot();
    const { rec } = await fireCtx(bot.commandHandlers.today, makeCtx(42, { text: '/today' }));
    expect(dealTodayCalls).toBeGreaterThan(0);
    expect(rec.replies[0].text).not.toContain('⚠️');
    const rows = rec.replies[0].markup?.inline_keyboard ?? [];
    expect(rows).toHaveLength(2); // one button per card, no pin row
    expect(rows[0][0].callback_data.startsWith('d:t')).toBe(true);
  });

  it('/today surfaces the ⚠️ impact pin ABOVE the hand, with ✓ Done AND 😴 Snooze', async () => {
    binding = { boundChatId: '42', linkCode: null };
    dealTodayResult = {
      status: 'ok',
      cards: [card(LIST_ID, 'B')],
      pin: pinInfo(TASK_ID, 'Renew passport', 'high-impact · 8 days'),
    };
    const bot = await startedBot();
    const { rec } = await fireCtx(bot.commandHandlers.today, makeCtx(42, { text: '/today' }));
    // The pin line is above the hand header.
    expect(rec.replies[0].text.indexOf('⚠️ high-impact · 8 days — Renew passport')).toBeLessThan(
      rec.replies[0].text.indexOf('Today — your top'),
    );
    const rows = rec.replies[0].markup?.inline_keyboard ?? [];
    // First row is the pin's [✓ Done][😴 Snooze]; then the hand card row.
    expect(rows[0][0].callback_data.startsWith('d:t')).toBe(true); // pin Done
    expect(rows[0][1].callback_data.startsWith('s:')).toBe(true); // pin Snooze
    expect(rows[0][1].text).toContain('😴');
    expect(rows[1][0].callback_data.startsWith('d:t')).toBe(true); // hand card Done
  });

  it('/now shows the top card with a ✓ Done button (now mode)', async () => {
    binding = { boundChatId: '42', linkCode: null };
    dealResult = { status: 'ok', cards: [card(TASK_ID, 'Top card')] };
    const bot = await startedBot();
    const { rec } = await fireCtx(bot.commandHandlers.now, makeCtx(42, { text: '/now' }));
    expect(dealCalls).toContain(1);
    expect(rec.replies[0].text).toContain('Top card');
    expect(rec.replies[0].markup?.inline_keyboard[0][0].callback_data.startsWith('d:n')).toBe(true);
  });

  it('/now with an empty hand says nothing playable', async () => {
    binding = { boundChatId: '42', linkCode: null };
    dealResult = { status: 'ok', cards: [] };
    const bot = await startedBot();
    const { rec } = await fireCtx(bot.commandHandlers.now, makeCtx(42, { text: '/now' }));
    expect(rec.replies[0].text).toContain('Nothing playable');
  });

  it('a ✓ Done tap (today) completes then re-renders the fresh hand in place', async () => {
    binding = { boundChatId: '42', linkCode: null };
    completeResult = { status: 'done', title: 'A' };
    dealTodayResult = { status: 'ok', cards: [card(LIST_ID, 'B')], pin: null };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, encodeDone(TASK_ID, 'today'));
    expect(completeCalls).toEqual([TASK_ID]);
    expect(rec.edits[0]).toContain('Today — your top');
  });

  it('a ✓ Done tap (now) completes then edits to a done confirmation', async () => {
    binding = { boundChatId: '42', linkCode: null };
    completeResult = { status: 'done', title: 'Top card' };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, encodeDone(TASK_ID, 'now'));
    expect(completeCalls).toEqual([TASK_ID]);
    expect(rec.edits[0]).toContain('✓ Done: Top card');
  });

  it('a ✓ Done tap for a gone task answers cleanly, no edit', async () => {
    binding = { boundChatId: '42', linkCode: null };
    completeResult = { status: 'gone' };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, encodeDone(TASK_ID, 'now'));
    expect(rec.edits).toHaveLength(0);
    expect(rec.answers[0]).toContain('no longer available');
  });

  it('a ✓ Done tap from a stranger is ignored — no completion', async () => {
    binding = { boundChatId: '42', linkCode: null };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 999, encodeDone(TASK_ID, 'today'));
    expect(completeCalls).toHaveLength(0);
    expect(rec.edits).toHaveLength(0);
  });

  it('a malformed ✓ Done payload answers cleanly, no completion', async () => {
    binding = { boundChatId: '42', linkCode: null };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, 'd:zBADMODE');
    expect(completeCalls).toHaveLength(0);
    expect(rec.answers[0]).toContain('no longer valid');
  });

  // ---------------------------------------------------------------- digest push (Step 7)
  it('pushHand sends the /today-rendered hand + pin (with ✓/😴 buttons) to the chat', async () => {
    dealTodayResult = {
      status: 'ok',
      cards: [card(LIST_ID, 'B')],
      pin: pinInfo(TASK_ID, 'Renew passport', 'high-impact · 8 days'),
    };
    const bot = await startedBot();
    expect(await service.pushHand('55')).toBe('sent');
    expect(bot.sendMessageCalls).toHaveLength(1);
    expect(bot.sendMessageCalls[0].chatId).toBe('55');
    expect(bot.sendMessageCalls[0].text).toContain('⚠️ high-impact · 8 days — Renew passport'); // pin in the digest
    expect(bot.sendMessageCalls[0].text).toContain('Today — your top');
    expect(bot.sendMessageCalls[0].markup?.inline_keyboard[0][1].callback_data.startsWith('s:')).toBe(true); // pin Snooze
  });

  it('pushHand returns no-bot when the poller is not running (no send)', async () => {
    // no token → syncFromConfig starts no bot
    await service.syncFromConfig();
    expect(await service.pushHand('55')).toBe('no-bot');
  });

  it('pushHand returns empty (and sends nothing) when the hand is empty', async () => {
    dealTodayResult = { status: 'ok', cards: [], pin: null };
    const bot = await startedBot();
    expect(await service.pushHand('55')).toBe('empty');
    expect(bot.sendMessageCalls).toHaveLength(0);
  });

  it('pushHand returns no-timezone when the clock cannot be derived', async () => {
    dealTodayResult = { status: 'no-timezone' };
    const bot = await startedBot();
    expect(await service.pushHand('55')).toBe('no-timezone');
    expect(bot.sendMessageCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------- pin snooze callback (Step 6, ADR 0086)
  it('a 😴 Snooze tap from the bound chat snoozes the task and re-renders (pin recomputes)', async () => {
    binding = { boundChatId: '42', linkCode: null };
    dealTodayResult = { status: 'ok', cards: [card(LIST_ID, 'B')], pin: null }; // after snooze: no pin
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, encodePinSnooze(TASK_ID));
    expect(snoozeCalls).toEqual([TASK_ID]);
    expect(rec.answers[0]).toContain('Snoozed');
    expect(rec.edits[0]).toContain('Today — your top'); // re-rendered
    expect(rec.edits[0]).not.toContain('⚠️'); // the snoozed pin is gone on recompute
  });

  it('a 😴 Snooze tap from a stranger is ignored — no snooze, no edit', async () => {
    binding = { boundChatId: '42', linkCode: null };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 999, encodePinSnooze(TASK_ID));
    expect(snoozeCalls).toHaveLength(0);
    expect(rec.edits).toHaveLength(0);
  });

  it('a 😴 Snooze of a stale/None task answers cleanly, no edit', async () => {
    binding = { boundChatId: '42', linkCode: null };
    snoozeThrows = true; // PinSnoozeService throws NotFound / BadRequest
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, encodePinSnooze(TASK_ID));
    expect(snoozeCalls).toEqual([TASK_ID]);
    expect(rec.edits).toHaveLength(0);
    expect(rec.answers[0]).toContain('no longer available');
  });

  it('a malformed 😴 Snooze payload answers cleanly, no snooze', async () => {
    binding = { boundChatId: '42', linkCode: null };
    const bot = await startedBot();
    const { rec } = await fireCallback(bot, 42, 's:short');
    expect(snoozeCalls).toHaveLength(0);
    expect(rec.answers[0]).toContain('no longer valid');
  });
});
