import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import type {
  SetTelegramTokenDto,
  TelegramConfigDto,
  TelegramStatusDto,
  UpdateTelegramDigestDto,
} from '@rankati/shared';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramConfigService } from './telegram-config.service';

/**
 * Served at /api/telegram (ADR 0084). Behind the GLOBAL session guard + CSRF check (ADR 0076), like the
 * rest of the authenticated API — no `@Public`. The config returned is ALWAYS masked; the raw token never
 * leaves the server. Token changes trigger a poller sync (fire-and-forget — the reply doesn't wait on the
 * transport).
 */
@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly config: TelegramConfigService,
    private readonly bot: TelegramBotService,
  ) {}

  /** The masked config (never the raw token). */
  @Get('config')
  getConfig(): Promise<TelegramConfigDto> {
    return this.config.getConfig();
  }

  /** The poller's live health (Step 8) — so a stored-but-invalid token reads 'error', not silently dead. */
  @Get('status')
  getStatus(): TelegramStatusDto {
    return { status: this.bot.getStatus() };
  }

  /** Paste/replace the bot token → start or restart the poller. */
  @Put('token')
  async setToken(@Body() dto: SetTelegramTokenDto): Promise<TelegramConfigDto> {
    const result = await this.config.setToken(dto?.token);
    void this.bot.syncFromConfig();
    return result;
  }

  /** Remove the bot token → stop the poller. */
  @Delete('token')
  @HttpCode(200)
  async clearToken(): Promise<TelegramConfigDto> {
    const result = await this.config.clearToken();
    void this.bot.syncFromConfig();
    return result;
  }

  /** Issue a fresh one-time link code (token unchanged → poller keeps running). */
  @Post('link-code')
  @HttpCode(200)
  regenerateCode(): Promise<TelegramConfigDto> {
    return this.config.regenerateCode();
  }

  /** Unbind the current chat + re-issue a code. The token is unchanged, so the poller keeps running so a
   *  new chat can link. */
  @Post('unlink')
  @HttpCode(200)
  unlink(): Promise<TelegramConfigDto> {
    return this.config.unlink();
  }

  /** Update the daily-digest preferences (enabled / time / timezone). */
  @Put('digest')
  setDigest(@Body() dto: UpdateTelegramDigestDto): Promise<TelegramConfigDto> {
    return this.config.setDigest(dto);
  }
}
