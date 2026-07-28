import { BadRequestException, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type {
  TelegramConfigDto,
  UpdateTelegramDigestDto,
} from '@rankati/shared';
import { LOCAL_OWNER_ID } from '../constants';
import type { TelegramConfig } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * The single-user Telegram bot config store (ADR 0084) — Rankati's first server-side persistent setting.
 *
 * ONE owner-scoped row, lazily found-or-created. The RAW bot token lives here and is exposed to the network
 * ONLY toward Telegram (Step 3's transport, via `getRawToken`) — never by an endpoint: every method that
 * returns to a caller returns the MASKED `TelegramConfigDto`. This step is storage + the authed Settings
 * endpoints only; the transport, binding, and scheduler land in later steps.
 */

// A safe, human-typeable alphabet for the link code — no 0/O/1/I/L ambiguity.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "••••1234" — the last four chars of the token, or null. Never the raw token (ADR 0084). */
function maskToken(token: string | null): string | null {
  if (!token) return null;
  return `••••${token.slice(-4)}`;
}

/** A fresh one-time binding code (crypto-random over the unambiguous alphabet). */
function generateLinkCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** True when `tz` is a valid IANA timezone name — Intl throws a RangeError for an unknown one. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The stored row → the browser-safe masked contract (@rankati/shared). The raw token never crosses here. */
function toDto(c: TelegramConfig): TelegramConfigDto {
  return {
    configured: c.botToken != null,
    tokenMask: maskToken(c.botToken),
    bound: c.boundChatId != null,
    boundChatId: c.boundChatId,
    linkCode: c.linkCode,
    digestEnabled: c.digestEnabled,
    digestTime: c.digestTime,
    timezone: c.timezone,
  };
}

/** The internal digest fields the scheduler reads (Step 7) — server-side only, never returned to a client. */
export interface DigestState {
  enabled: boolean;
  time: string;
  timezone: string | null;
  boundChatId: string | null;
  lastSentOn: string | null;
}

@Injectable()
export class TelegramConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The single owner-scoped row, lazily created on first touch (find-or-create). Internal: it carries the
   * RAW token, so it is never returned to a caller — only `toDto` output is.
   */
  private async getOrCreate(): Promise<TelegramConfig> {
    // Atomic find-or-create on the unique ownerId — no find-then-create race.
    return this.prisma.telegramConfig.upsert({
      where: { ownerId: LOCAL_OWNER_ID },
      create: { ownerId: LOCAL_OWNER_ID },
      update: {},
    });
  }

  /** The masked, browser-safe config (never the raw token). */
  async getConfig(): Promise<TelegramConfigDto> {
    return toDto(await this.getOrCreate());
  }

  /**
   * The RAW token — server-side only, for the Telegram transport (Step 3). NOT reachable from any endpoint.
   */
  async getRawToken(): Promise<string | null> {
    return (await this.getOrCreate()).botToken;
  }

  /**
   * The current binding + active link code — server-side only, for the transport's message handler (Step 4).
   * The handler gates on `boundChatId` to serve only the linked chat.
   */
  async getBinding(): Promise<{ boundChatId: string | null; linkCode: string | null }> {
    const c = await this.getOrCreate();
    return { boundChatId: c.boundChatId, linkCode: c.linkCode };
  }

  /**
   * Bind a chat with the code it sent (Step 4). Called only while UNBOUND (the handler gates on that). The
   * code is matched TRIMMED + CASE-INSENSITIVELY — it is shown uppercase, but a paste may carry whitespace or
   * lowercasing. A match CONSUMES the code (one-time): the chat is bound and the link code cleared, so no one
   * else can reuse it. Returns why it did or didn't bind.
   */
  async bindChat(chatId: string, code: string): Promise<'bound' | 'bad-code' | 'no-code'> {
    const current = await this.getOrCreate();
    if (current.boundChatId) return 'bad-code'; // defensive — already bound, never re-bind
    if (!current.linkCode) return 'no-code';
    const supplied = code.trim().toUpperCase();
    if (!supplied || supplied !== current.linkCode.trim().toUpperCase()) return 'bad-code';
    await this.prisma.telegramConfig.update({
      where: { id: current.id },
      data: { boundChatId: chatId, linkCode: null },
    });
    return 'bound';
  }

  /**
   * Set/replace the bot token. A CHANGED token is a different bot, so it unbinds the old chat and issues a
   * fresh link code; re-saving the same token leaves the binding alone.
   */
  async setToken(raw: unknown): Promise<TelegramConfigDto> {
    const token = typeof raw === 'string' ? raw.trim() : '';
    if (!token) {
      throw new BadRequestException('token is required');
    }
    // A loose sanity check — a BotFather token is "<bot id>:<auth token>". Kept loose so a future format
    // change does not reject a valid token.
    if (!/^\d+:[\w-]{20,}$/.test(token)) {
      throw new BadRequestException('that does not look like a Telegram bot token');
    }
    const current = await this.getOrCreate();
    const changed = current.botToken !== token;
    const updated = await this.prisma.telegramConfig.update({
      where: { id: current.id },
      data: changed ? { botToken: token, boundChatId: null, linkCode: generateLinkCode() } : { botToken: token },
    });
    return toDto(updated);
  }

  /** Issue a fresh link code (requires a token). Does not change the binding. */
  async regenerateCode(): Promise<TelegramConfigDto> {
    const current = await this.getOrCreate();
    if (!current.botToken) {
      throw new BadRequestException('set a bot token first');
    }
    const updated = await this.prisma.telegramConfig.update({
      where: { id: current.id },
      data: { linkCode: generateLinkCode() },
    });
    return toDto(updated);
  }

  /** Remove the bot token — disables the bot and unbinds it. The poller stops (no token left). */
  async clearToken(): Promise<TelegramConfigDto> {
    const current = await this.getOrCreate();
    const updated = await this.prisma.telegramConfig.update({
      where: { id: current.id },
      data: { botToken: null, boundChatId: null, linkCode: null },
    });
    return toDto(updated);
  }

  /** Unbind the chat and issue a fresh code (when a token exists) so a new chat can link. */
  async unlink(): Promise<TelegramConfigDto> {
    const current = await this.getOrCreate();
    const updated = await this.prisma.telegramConfig.update({
      where: { id: current.id },
      data: { boundChatId: null, linkCode: current.botToken ? generateLinkCode() : null },
    });
    return toDto(updated);
  }

  /** The digest scheduler's view of the config (Step 7) — server-side only, includes the fire-once guard. */
  async getDigestState(): Promise<DigestState> {
    const c = await this.getOrCreate();
    return {
      enabled: c.digestEnabled,
      time: c.digestTime,
      timezone: c.timezone,
      boundChatId: c.boundChatId,
      lastSentOn: c.lastDigestSentOn,
    };
  }

  /** Record that the digest fired for a local date (YYYY-MM-DD) — called ONLY after a successful send. */
  async markDigestSent(localDate: string): Promise<void> {
    const current = await this.getOrCreate();
    await this.prisma.telegramConfig.update({
      where: { id: current.id },
      data: { lastDigestSentOn: localDate },
    });
  }

  /** Update the daily-digest preferences. Enabling requires a valid IANA timezone the scheduler fires on. */
  async setDigest(dto: UpdateTelegramDigestDto): Promise<TelegramConfigDto> {
    const time = typeof dto?.time === 'string' ? dto.time.trim() : '';
    if (!TIME_RE.test(time)) {
      throw new BadRequestException('time must be HH:MM (00:00–23:59)');
    }
    const enabled = dto?.enabled === true;
    let tz: string | null = null;
    if (dto?.timezone != null && dto.timezone !== '') {
      if (typeof dto.timezone !== 'string' || !isValidTimezone(dto.timezone)) {
        throw new BadRequestException('timezone must be a valid IANA name, e.g. Asia/Dubai');
      }
      tz = dto.timezone;
    }
    if (enabled && !tz) {
      throw new BadRequestException('a timezone is required to schedule the digest');
    }
    const current = await this.getOrCreate();
    const updated = await this.prisma.telegramConfig.update({
      where: { id: current.id },
      data: { digestEnabled: enabled, digestTime: time, timezone: tz },
    });
    return toDto(updated);
  }
}
