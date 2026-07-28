import type { TelegramBotStatus } from '@rankati/shared';

export type BadgeTone = 'connected' | 'error' | 'neutral' | 'pending';
export interface TelegramBadge {
  tone: BadgeTone;
  label: string;
}

/**
 * The bot-health badge (Step 8) from (configured, status, settling). While the poller settles after a token
 * change we show a definite "Checking…" (capped by the caller), never a stale value; once settled every
 * state resolves to a definite badge — a stored-but-rejected token reads "Token rejected", not silently dead.
 */
export function telegramBadge(
  configured: boolean,
  status: TelegramBotStatus,
  settling: boolean,
): TelegramBadge {
  if (settling) return { tone: 'pending', label: 'Checking…' };
  if (!configured) return { tone: 'neutral', label: 'No bot connected' };
  if (status === 'running') return { tone: 'connected', label: 'Connected' };
  if (status === 'error') return { tone: 'error', label: 'Token rejected — the bot is not running' };
  return { tone: 'neutral', label: 'Not running' }; // configured but stopped
}
