import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  TELEGRAM_BOT_FACTORY,
  type TelegramBot,
  type TelegramBotFactory,
  type TelegramContext,
  type TelegramInlineButton,
  type TelegramReplyMarkup,
} from './telegram-bot.factory';
import type { Task, TelegramBotStatus } from '@rankati/shared';
import {
  decodeDiscard,
  decodeDone,
  decodePinSnooze,
  decodeRefile,
  DISCARD_TRIGGER,
  DONE_TRIGGER,
  encodeDiscard,
  encodeDone,
  encodePinSnooze,
  encodeRefile,
  PIN_SNOOZE_TRIGGER,
  REFILE_TRIGGER,
} from './telegram-callback';
import { TelegramCaptureService, type CaptureResult } from './telegram-capture.service';
import { TelegramConfigService } from './telegram-config.service';
import { TelegramReadService, type PinInfo } from './telegram-read.service';
import { PinSnoozeService } from '../pin-snooze.service';

/** Read-command replies (Step 6). */
const NEEDS_TZ =
  'I need your timezone to know when "today" is. Set it in Settings → Telegram, then try again.';
const NOTHING_PLAYABLE = 'Nothing playable right now. 🎉';
const READ_FAILED = 'Could not read your tasks — please try again in a moment.';

/** Trim a title for an inline-button label. */
function truncateLabel(s: string, max = 24): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The "/" menu registered via setMyCommands (ADR 0084). The handlers land in Steps 4–6. */
const COMMANDS = [
  { command: 'start', description: 'Welcome + link this chat' },
  { command: 'help', description: 'Show the commands' },
  { command: 'today', description: "Today's hand" },
  { command: 'now', description: 'The top card' },
  { command: 'add', description: 'Capture a task' },
];

/**
 * The Telegram long-poll transport (ADR 0084). It keeps a single grammy poller running IFF a token is
 * stored — so a chat can send the binding code (Step 4) while the bot is up — and stops it when the token
 * is cleared or on app shutdown. It does NOT stop on unlink: unbinding keeps the token, so re-binding still
 * works. grammy retries transient network errors with its own backoff, so an outage never hot-loops here.
 *
 * The token is NEVER logged: it lives only in the created bot and in the getUpdates URL grammy builds
 * internally; every error this service logs is scrubbed of the running token first.
 */
@Injectable()
export class TelegramBotService implements OnModuleDestroy {
  private readonly logger = new Logger('TelegramBot');
  private bot: TelegramBot | null = null;
  private runningToken: string | null = null;
  private syncing = false;
  /** Health for Settings (Step 8): 'running' after a good start, 'error' if the token was rejected at
   *  setMyCommands, 'stopped' when there is no token. A stored-but-invalid token reads 'error', not dead. */
  private botStatus: TelegramBotStatus = 'stopped';

  constructor(
    private readonly config: TelegramConfigService,
    private readonly capture: TelegramCaptureService,
    private readonly read: TelegramReadService,
    private readonly pinSnooze: PinSnoozeService,
    @Inject(TELEGRAM_BOT_FACTORY) private readonly createBot: TelegramBotFactory,
  ) {}

  /**
   * Reconcile the poller with the stored token. Called once on boot (main.ts) and after a token change
   * (the controller). Serialised — overlapping calls can't double-start the poller.
   */
  async syncFromConfig(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const token = await this.config.getRawToken();
      if (!token) {
        await this.stop(); // token cleared → no poller
        return;
      }
      if (this.bot && token === this.runningToken) return; // already polling this token
      await this.start(token); // first token, or a changed one
    } finally {
      this.syncing = false;
    }
  }

  private async start(token: string): Promise<void> {
    await this.stop(); // replace any running poller
    const bot = this.createBot(token);
    this.bot = bot;
    this.runningToken = token;

    bot.catch((err) => this.logError('update handler error', err));

    this.registerHandlers(bot);

    // Register the "/" menu. This also serves as an early token check: a bad token 401s here, before the
    // poll loop, so we never start polling a dead bot.
    try {
      await bot.api.setMyCommands(COMMANDS);
    } catch (err) {
      this.logError('could not register commands (bad token?)', err);
      this.bot = null;
      this.runningToken = null;
      this.botStatus = 'error'; // token set but rejected by Telegram — surfaced in Settings, not silently dead
      return;
    }

    this.botStatus = 'running';
    // Fire the poll loop WITHOUT awaiting — it resolves only when stop() is called. Its rejection is a
    // fatal poll error (not a transient one — grammy retries those internally with backoff).
    void bot
      .start({ onStart: (me) => this.logger.log(`poller started as @${me.username}`) })
      .catch((err) => this.logError('poll loop ended with an error', err));
  }

  /**
   * Wire the command + message + callback handlers (ADR 0084, Steps 4–5).
   *
   * Binding (Step 4): while UNBOUND, the first chat to send the current link code (trimmed + case-insensitive)
   * binds — its chat id is stored and the code consumed. Once bound, ONLY that chat is served; every other
   * chat is turned away, so a stranger with no code can never bind.
   *
   * Capture (Step 5): from the bound chat, free text or "/add <text>" becomes a needsDetails task in the
   * Inbox, offered with re-file buttons. A button tap re-files it (Option B). /today and /now stay gated
   * stubs until Step 6.
   */
  private registerHandlers(bot: TelegramBot): void {
    const NOT_LINKED =
      "This chat isn't linked. Open Settings → Telegram in Rankati and paste your link code here.";

    bot.command('start', async (ctx) => {
      const chatId = String(ctx.chat?.id ?? '');
      const { boundChatId } = await this.config.getBinding();
      if (!boundChatId) {
        await ctx.reply(
          '👋 Welcome to Rankati. To connect this chat, open Settings → Telegram in the app and paste your link code here.',
        );
      } else if (chatId === boundChatId) {
        await ctx.reply("👋 You're linked. Send me anything to capture it, or /help for the commands.");
      } else {
        await ctx.reply('This bot is already linked to another chat.');
      }
    });

    bot.command('help', async (ctx) => {
      await ctx.reply(
        [
          'Send me any message to capture it as a task.',
          '',
          '/add <text> — capture a task',
          '/today — your hand for today',
          '/now — the top card',
          '',
          '(/today and /now arrive in the next update.)',
        ].join('\n'),
      );
    });

    bot.command('add', async (ctx) => {
      if (!(await this.isBoundChat(ctx))) {
        await ctx.reply(NOT_LINKED);
        return;
      }
      const text = (ctx.match ?? '').trim();
      if (!text) {
        await ctx.reply('Send /add followed by what to capture — e.g. “/add call the plumber”. Or just send me the text.');
        return;
      }
      await this.captureAndReply(ctx, text);
    });

    // /today — the fresh top-5 hand, each card with a ✓ Done button (Step 6). Served only to the linked chat.
    bot.command('today', async (ctx) => {
      if (!(await this.isBoundChat(ctx))) {
        await ctx.reply(NOT_LINKED);
        return;
      }
      const dealt = await this.todayMessage();
      if (dealt.kind === 'today') {
        await ctx.reply(dealt.text, { reply_markup: dealt.keyboard });
      } else {
        await ctx.reply(dealt.text);
      }
    });

    // /now — just the top card, with a ✓ Done button.
    bot.command('now', async (ctx) => {
      if (!(await this.isBoundChat(ctx))) {
        await ctx.reply(NOT_LINKED);
        return;
      }
      let result;
      try {
        result = await this.read.deal(1);
      } catch (err) {
        this.logError('/now failed', err);
        await ctx.reply(READ_FAILED);
        return;
      }
      if (result.status === 'no-timezone') {
        await ctx.reply(NEEDS_TZ);
        return;
      }
      const card = result.cards[0];
      if (!card) {
        await ctx.reply(NOTHING_PLAYABLE);
        return;
      }
      await ctx.reply(this.renderNow(card), { reply_markup: this.doneKeyboard(card, 'now') });
    });

    // A ✓ Done tap. Gated on the bound chat; ownership is verified before completing (a stale/foreign id
    // answers cleanly). /today re-renders the fresh hand in place; /now edits to a done confirmation.
    bot.callbackQuery(DONE_TRIGGER, async (ctx) => {
      const chatId = String(ctx.chat?.id ?? '');
      const { boundChatId } = await this.config.getBinding();
      if (!boundChatId || chatId !== boundChatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const decoded = decodeDone(ctx.callbackQuery?.data ?? '');
      if (!decoded) {
        await ctx.answerCallbackQuery('That button is no longer valid.');
        return;
      }
      let outcome: Awaited<ReturnType<TelegramReadService['complete']>>;
      try {
        outcome = await this.read.complete(decoded.taskId);
      } catch (err) {
        this.logError('complete failed', err);
        await ctx.answerCallbackQuery('Could not complete it — please try again.');
        return;
      }
      if (outcome.status === 'gone') {
        await ctx.answerCallbackQuery('That task is no longer available.');
        return;
      }
      await ctx.answerCallbackQuery(`✓ ${outcome.title}`);
      if (decoded.mode === 'now') {
        await ctx.editMessageText(`✓ Done: ${outcome.title}`, { reply_markup: { inline_keyboard: [] } });
      } else {
        const dealt = await this.todayMessage();
        await ctx.editMessageText(dealt.text, {
          reply_markup: dealt.kind === 'today' ? dealt.keyboard : { inline_keyboard: [] },
        });
      }
    });

    // A 😴 Snooze tap on the impact pin (ADR 0086). Gated on the bound chat; PinSnoozeService is owner-scoped
    // and derives the level + span server-side. After snoozing, re-render so the pin recomputes (the snoozed
    // task drops; the next-most-overdue may surface, or none).
    bot.callbackQuery(PIN_SNOOZE_TRIGGER, async (ctx) => {
      const chatId = String(ctx.chat?.id ?? '');
      const { boundChatId } = await this.config.getBinding();
      if (!boundChatId || chatId !== boundChatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const taskId = decodePinSnooze(ctx.callbackQuery?.data ?? '');
      if (!taskId) {
        await ctx.answerCallbackQuery('That button is no longer valid.');
        return;
      }
      try {
        await this.pinSnooze.snooze(taskId);
      } catch (err) {
        // NotFound (stale/foreign) or a None-impact task, or a transient error — answer cleanly, don't crash.
        this.logError('pin snooze failed', err);
        await ctx.answerCallbackQuery('That pin is no longer available.');
        return;
      }
      await ctx.answerCallbackQuery('😴 Snoozed');
      const dealt = await this.todayMessage();
      await ctx.editMessageText(dealt.text, {
        reply_markup: dealt.kind === 'today' ? dealt.keyboard : { inline_keyboard: [] },
      });
    });

    // A re-file button tap. Gated on the bound chat; the payload is verified against live rows before moving.
    bot.callbackQuery(REFILE_TRIGGER, async (ctx) => {
      const chatId = String(ctx.chat?.id ?? '');
      const { boundChatId } = await this.config.getBinding();
      if (!boundChatId || chatId !== boundChatId) {
        await ctx.answerCallbackQuery(); // clear the spinner for anyone else, do nothing
        return;
      }
      const decoded = decodeRefile(ctx.callbackQuery?.data ?? '');
      if (!decoded) {
        await ctx.answerCallbackQuery('That button is no longer valid.');
        return;
      }
      let outcome: Awaited<ReturnType<TelegramCaptureService['refile']>>;
      try {
        outcome = await this.capture.refile(decoded.taskId, decoded.listId);
      } catch (err) {
        this.logError('refile failed', err);
        await ctx.answerCallbackQuery('Could not move it — please try again.');
        return;
      }
      if (outcome.status === 'moved') {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`✅ Moved to ${outcome.listName}`); // also drops the keyboard
      } else {
        await ctx.answerCallbackQuery('That task or list is no longer available.');
      }
    });

    // A 🗑 Discard tap — delete the just-captured task (the undo for a mistake). Gated on the bound chat;
    // ownership is verified before deleting; a stale/foreign id answers cleanly.
    bot.callbackQuery(DISCARD_TRIGGER, async (ctx) => {
      const chatId = String(ctx.chat?.id ?? '');
      const { boundChatId } = await this.config.getBinding();
      if (!boundChatId || chatId !== boundChatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const taskId = decodeDiscard(ctx.callbackQuery?.data ?? '');
      if (!taskId) {
        await ctx.answerCallbackQuery('That button is no longer valid.');
        return;
      }
      let outcome: Awaited<ReturnType<TelegramCaptureService['discard']>>;
      try {
        outcome = await this.capture.discard(taskId);
      } catch (err) {
        this.logError('discard failed', err);
        await ctx.answerCallbackQuery('Could not discard it — please try again.');
        return;
      }
      if (outcome.status === 'discarded') {
        await ctx.answerCallbackQuery('Discarded');
        await ctx.editMessageText('🗑 Discarded', { reply_markup: { inline_keyboard: [] } });
      } else {
        await ctx.answerCallbackQuery('That task is no longer available.');
      }
    });

    // Free text (not a command). While unbound it's a link-code attempt; once bound, the linked chat's text
    // is captured and everyone else is turned away.
    bot.on('message', async (ctx) => {
      const chatId = String(ctx.chat?.id ?? '');
      if (!chatId) return;
      const text = (ctx.message?.text ?? '').trim();
      const { boundChatId } = await this.config.getBinding();
      if (boundChatId) {
        if (chatId === boundChatId) {
          await this.captureAndReply(ctx, ctx.message?.text ?? '');
        } else {
          await ctx.reply('This bot is linked to another chat.');
        }
        return;
      }
      const outcome = await this.config.bindChat(chatId, text);
      if (outcome === 'bound') {
        await ctx.reply('✅ Linked! This chat is now connected to Rankati. Send me anything to capture it.');
      } else if (outcome === 'no-code') {
        await ctx.reply(
          "There's no active link code right now. Generate one in Settings → Telegram, then paste it here.",
        );
      } else {
        await ctx.reply(NOT_LINKED);
      }
    });
  }

  /** Capture text into the Inbox and reply with the re-file buttons. Any failure is a friendly reply, not a throw. */
  private async captureAndReply(ctx: TelegramContext, rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text) {
      await ctx.reply("There's nothing to capture — send me a few words and I'll save it.");
      return;
    }
    let result: CaptureResult;
    try {
      result = await this.capture.capture(text);
    } catch (err) {
      this.logError('capture failed', err);
      await ctx.reply('Something went wrong saving that — please try again in a moment.');
      return;
    }
    const lines = [`✅ Captured: ${result.task.title}`];
    if (result.truncated) lines.push('(shortened to fit a task title)');
    if (result.refileLists.length) {
      lines.push('File it into a list:');
      if (result.overflow > 0) {
        const total = result.refileLists.length + result.overflow;
        lines.push(`(showing ${result.refileLists.length} of ${total} lists — file the rest in the app)`);
      }
    } else {
      lines.push(`It's in ${result.inboxName}. Make lists in the app to file captures from here.`);
    }
    await ctx.reply(lines.join('\n'), {
      reply_markup: this.captureKeyboard(result.task.id, result.refileLists),
    });
  }

  /** The capture keyboard: re-file list buttons (2 per row), then a 🗑 Discard button on its OWN row so it
   *  is not fat-fingered. The Discard row is always present — it is the undo even when there are no lists. */
  private captureKeyboard(taskId: string, lists: { id: string; name: string }[]): TelegramReplyMarkup {
    const rows: TelegramInlineButton[][] = [];
    for (let i = 0; i < lists.length; i += 2) {
      rows.push(
        lists.slice(i, i + 2).map((l) => ({ text: l.name, callback_data: encodeRefile(taskId, l.id) })),
      );
    }
    rows.push([{ text: '🗑 Discard', callback_data: encodeDiscard(taskId) }]);
    return { inline_keyboard: rows };
  }

  /** Today's hand + pin, ready to send: a rendered message (pin line above the hand), or a plain message
   *  (no timezone / empty / error). Used by /today, the ✓ Done / 😴 Snooze re-render, and the digest. */
  private async todayMessage(): Promise<
    { kind: 'message'; text: string } | { kind: 'today'; text: string; keyboard: TelegramReplyMarkup }
  > {
    let result;
    try {
      result = await this.read.dealToday();
    } catch (err) {
      this.logError('/today failed', err);
      return { kind: 'message', text: READ_FAILED };
    }
    if (result.status === 'no-timezone') return { kind: 'message', text: NEEDS_TZ };
    if (!result.cards.length) return { kind: 'message', text: NOTHING_PLAYABLE };
    const { text, keyboard } = this.renderToday(result.cards, result.pin);
    return { kind: 'today', text, keyboard };
  }

  /**
   * The ⚠️ impact-pin line (ADR 0086) ABOVE the numbered hand — the pin gets a ✓ Done AND a 😴 Snooze;
   * each hand card gets a ✓ Done. No pin → no line (as before).
   */
  private renderToday(cards: Task[], pin: PinInfo | null): { text: string; keyboard: TelegramReplyMarkup } {
    const lines: string[] = [];
    const rows: TelegramInlineButton[][] = [];
    if (pin) {
      lines.push(`⚠️ ${pin.reason} — ${pin.task.title}`, '');
      rows.push([
        { text: `✓ Done · ${truncateLabel(pin.task.title, 14)}`, callback_data: encodeDone(pin.task.id, 'today') },
        { text: '😴 Snooze', callback_data: encodePinSnooze(pin.task.id) },
      ]);
    }
    lines.push(`Today — your top ${cards.length}:`);
    cards.forEach((c, i) => lines.push(`${i + 1}. ${c.title}`));
    lines.push('', 'Tap ✓ to mark one done.');
    cards.forEach((c, i) =>
      rows.push([{ text: `✓ ${i + 1}. ${truncateLabel(c.title)}`, callback_data: encodeDone(c.id, 'today') }]),
    );
    return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
  }

  private renderNow(card: Task): string {
    return `Now:\n${card.title}`;
  }

  private doneKeyboard(card: Task, mode: 'today' | 'now'): TelegramReplyMarkup {
    return { inline_keyboard: [[{ text: '✓ Done', callback_data: encodeDone(card.id, mode) }]] };
  }

  /**
   * Push the current hand to a chat — the daily digest (Step 7). Reuses the /today renderer verbatim.
   * Reports WHY it did or didn't send so the scheduler knows whether to mark the day done: only 'sent' is
   * recorded; 'empty' / 'no-bot' / 'no-timezone' / 'error' all skip without marking, so the next tick retries.
   */
  async pushHand(chatId: string): Promise<'sent' | 'empty' | 'no-bot' | 'no-timezone' | 'error'> {
    const bot = this.bot;
    if (!bot) return 'no-bot';
    let dealt;
    try {
      dealt = await this.read.dealToday();
    } catch (err) {
      this.logError('digest deal failed', err);
      return 'error';
    }
    if (dealt.status === 'no-timezone') return 'no-timezone';
    if (!dealt.cards.length) return 'empty';
    const { text, keyboard } = this.renderToday(dealt.cards, dealt.pin);
    try {
      await bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
    } catch (err) {
      this.logError('digest send failed', err);
      return 'error';
    }
    return 'sent';
  }

  /** True when this update comes from the single linked chat. */
  private async isBoundChat(ctx: TelegramContext): Promise<boolean> {
    const chatId = String(ctx.chat?.id ?? '');
    const { boundChatId } = await this.config.getBinding();
    return boundChatId != null && chatId === boundChatId;
  }

  private async stop(): Promise<void> {
    const bot = this.bot;
    this.bot = null;
    this.runningToken = null;
    this.botStatus = 'stopped';
    if (!bot) return;
    try {
      await bot.stop();
      this.logger.log('poller stopped');
    } catch (err) {
      this.logError('stop failed', err);
    }
  }

  /** Graceful shutdown — enabled by app.enableShutdownHooks() in main.ts, and by app.close() in tests. */
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** The poller's health for Settings (Step 8): 'running' | 'error' (token rejected) | 'stopped' (no token). */
  getStatus(): TelegramBotStatus {
    return this.botStatus;
  }

  /**
   * Log an error, SCRUBBING the running token first (ADR 0084) — even if some error string carried the
   * getUpdates URL that embeds it, the token never reaches the logs.
   */
  private logError(context: string, err: unknown): void {
    const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const safe = this.runningToken ? raw.split(this.runningToken).join('••••') : raw;
    this.logger.warn(`${context}: ${safe}`);
  }
}
