import { Bot } from 'grammy';

/**
 * The grammy Bot is created through an injected factory (ADR 0084) so the poller lifecycle can be
 * unit-tested with a fake, and so no test ever opens a REAL long-poll against Telegram.
 */
export const TELEGRAM_BOT_FACTORY = Symbol('TELEGRAM_BOT_FACTORY');

/** An inline keyboard button carrying callback_data (ADR 0084) — the re-file buttons. */
export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}
export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

/**
 * The slice of a grammy update Context the handlers read (ADR 0084): who sent it, the text (`message.text`
 * for free text, `match` for a command's argument), the callback payload, and the reply/answer/edit actions.
 */
export interface TelegramContext {
  readonly chat?: { id: number };
  readonly message?: { text?: string };
  /** The text after a command, e.g. "buy milk" for "/add buy milk". */
  readonly match?: string;
  readonly callbackQuery?: { data?: string };
  reply(text: string, extra?: { reply_markup?: TelegramReplyMarkup }): Promise<unknown>;
  /** Acknowledge a button tap (optionally a toast). Telegram shows a spinner until this is called. */
  answerCallbackQuery(text?: string): Promise<unknown>;
  /** Replace the message the tapped button was on. Pass reply_markup to set new buttons (or `[]` to clear). */
  editMessageText(text: string, extra?: { reply_markup?: TelegramReplyMarkup }): Promise<unknown>;
}

/** The narrow slice of grammy's Bot the transport uses — the seam a fake implements in tests. */
export interface TelegramBot {
  readonly api: {
    setMyCommands(commands: { command: string; description: string }[]): Promise<unknown>;
    /** Push a message to a chat (the daily digest) — no incoming ctx, so it goes through the api directly. */
    sendMessage(
      chatId: string | number,
      text: string,
      other?: { reply_markup?: TelegramReplyMarkup },
    ): Promise<unknown>;
  };
  catch(handler: (err: unknown) => void): void;
  command(command: string, handler: (ctx: TelegramContext) => unknown): void;
  on(filter: 'message', handler: (ctx: TelegramContext) => unknown): void;
  callbackQuery(trigger: string | RegExp, handler: (ctx: TelegramContext) => unknown): void;
  /** Long-poll until `stop()`. Validates the token first (getMe), so a bad token rejects here. */
  start(opts?: { onStart?: (me: { username: string }) => void }): Promise<void>;
  stop(): Promise<void>;
}

export type TelegramBotFactory = (token: string) => TelegramBot;

/**
 * The real factory. Under vitest it returns an INERT bot — the lifecycle is exercised with an explicit
 * fake factory in the unit test, and every other spec that boots the app (and so may trigger a sync) must
 * never reach Telegram's network.
 */
export const defaultBotFactory: TelegramBotFactory = (token) => {
  if (process.env.VITEST) {
    return {
      api: { setMyCommands: async () => true, sendMessage: async () => ({}) },
      catch: () => undefined,
      command: () => undefined,
      on: () => undefined,
      callbackQuery: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
    };
  }
  return new Bot(token) as unknown as TelegramBot;
};
