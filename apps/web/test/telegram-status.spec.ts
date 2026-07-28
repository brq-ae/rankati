import { describe, expect, it } from 'vitest';
import { telegramBadge } from '../src/telegram-status';

/** The bot-health badge transitions (Step 8) — the (configured, status, settling) → badge mapping. */
describe('telegramBadge', () => {
  it('shows a definite "Checking…" while settling, whatever the status', () => {
    expect(telegramBadge(true, 'running', true)).toMatchObject({ tone: 'pending', label: 'Checking…' });
    expect(telegramBadge(false, 'stopped', true).tone).toBe('pending');
  });

  it('is neutral "No bot connected" when no token is configured', () => {
    expect(telegramBadge(false, 'stopped', false)).toMatchObject({ tone: 'neutral', label: 'No bot connected' });
  });

  it('is "Connected" when configured and running', () => {
    expect(telegramBadge(true, 'running', false)).toMatchObject({ tone: 'connected', label: 'Connected' });
  });

  it('is a "token rejected" error when configured but the poller errored', () => {
    const b = telegramBadge(true, 'error', false);
    expect(b.tone).toBe('error');
    expect(b.label).toMatch(/rejected/i);
  });

  it('is "Not running" when configured but stopped (no live poller)', () => {
    expect(telegramBadge(true, 'stopped', false)).toMatchObject({ tone: 'neutral', label: 'Not running' });
  });
});
