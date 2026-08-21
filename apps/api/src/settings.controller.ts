import { Body, Controller, Get, Put } from '@nestjs/common';
import type { PinDays, QuietHours } from '@rankati/shared';
import { SettingsService } from './settings.service';

/**
 * Served at /api/settings (ADR 0086). Behind the GLOBAL session guard + CSRF check (ADR 0076) like the rest
 * of the authenticated API — no `@Public`. `PUT` returns the SAVED (validated) config, so the UI reflects
 * exactly what stuck (a bad knob defaulted to its own default, not the whole save rejected).
 */
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** The four impact-pin day-knobs. */
  @Get('pin')
  getPin(): Promise<PinDays> {
    return this.settings.getPinConfig();
  }

  /** Save the four knobs; returns the validated result. */
  @Put('pin')
  setPin(@Body() body: unknown): Promise<PinDays> {
    return this.settings.setPinConfig(body);
  }

  /** Global quiet-hours (ADR 0091) — the window during which no Telegram push is sent. Both null = off. */
  @Get('quiet-hours')
  getQuietHours(): Promise<QuietHours> {
    return this.settings.getQuietHours();
  }

  /** Save quiet-hours; returns the saved window. Both-or-neither + strict HH:MM, else 400. */
  @Put('quiet-hours')
  setQuietHours(@Body() body: unknown): Promise<QuietHours> {
    return this.settings.setQuietHours(body);
  }
}
