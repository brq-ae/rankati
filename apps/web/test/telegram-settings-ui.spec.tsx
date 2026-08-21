// @vitest-environment happy-dom
import type { TelegramConfigDto } from '@rankati/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TelegramSettings from '../src/TelegramSettings';

/**
 * Settings → Telegram (Step 8). Fetch is mocked so the self-contained section runs through the real api.ts
 * path. Covers: timezone auto pre-fill + free-typed validation, and the enable-requires-timezone inline
 * error (client-side, before any PUT). Status-badge transitions live in telegram-status.spec.ts.
 */
const CONFIG: TelegramConfigDto = {
  configured: true,
  tokenMask: '••••cjSE',
  bound: false,
  boundChatId: null,
  linkCode: 'ABCD2345',
  digestEnabled: false,
  digestTime: '08:00',
  timezone: null, // unset → the UI must auto-detect
};

let digestPuts: unknown[];
let quietPuts: unknown[];

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

type Quiet = { start: string | null; end: string | null };

function installFetch(
  config: TelegramConfigDto,
  statusVal = 'running',
  quiet: Quiet = { start: null, end: null },
) {
  digestPuts = [];
  quietPuts = [];
  let quietState = quiet;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/telegram/config')) return jsonRes(config);
    if (path.endsWith('/telegram/status')) return jsonRes({ status: statusVal });
    if (path.endsWith('/telegram/digest') && method === 'PUT') {
      digestPuts.push(JSON.parse(String(init?.body)));
      return jsonRes(config);
    }
    if (path.endsWith('/settings/quiet-hours')) {
      if (method === 'PUT') {
        quietState = JSON.parse(String(init?.body)) as Quiet;
        quietPuts.push(quietState);
      }
      return jsonRes(quietState);
    }
    return jsonRes({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Telegram settings UI', () => {
  beforeEach(() => installFetch(CONFIG));

  it('auto-detects and pre-fills the timezone when none is stored', async () => {
    render(<TelegramSettings />);
    const tzInput = (await screen.findByLabelText('Timezone')) as HTMLInputElement;
    const expected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(tzInput.value).toBe(expected);
    expect(tzInput.value).not.toBe('');
  });

  it('refuses to enable the digest without a timezone — inline error, no PUT', async () => {
    render(<TelegramSettings />);
    const tzInput = (await screen.findByLabelText('Timezone')) as HTMLInputElement;

    fireEvent.change(tzInput, { target: { value: '  ' } }); // clear the auto-filled zone
    fireEvent.click(screen.getByLabelText('Enable daily digest'));
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));

    await waitFor(() => expect(screen.getByText(/set a timezone/i)).toBeTruthy());
    expect(digestPuts).toHaveLength(0); // never hit the server
  });

  it('saves the digest when a timezone is present', async () => {
    render(<TelegramSettings />);
    const tzInput = (await screen.findByLabelText('Timezone')) as HTMLInputElement;

    fireEvent.change(tzInput, { target: { value: 'Asia/Dubai' } });
    fireEvent.click(screen.getByLabelText('Enable daily digest'));
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));

    await waitFor(() => expect(digestPuts).toHaveLength(1));
    expect(digestPuts[0]).toMatchObject({ enabled: true, time: '08:00', timezone: 'Asia/Dubai' });
  });

  it('shows the Connected badge once loaded', async () => {
    render(<TelegramSettings />);
    expect(await screen.findByText('Connected')).toBeTruthy();
  });

  it('copy falls back to execCommand in a non-secure context and reports "Copied!"', async () => {
    // Simulate plain-HTTP LAN: navigator.clipboard is undefined, execCommand does the copy on the gesture.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });

    render(<TelegramSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(screen.getByText('Copied!')).toBeTruthy());
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('copy leaves the code selected for manual copy when execCommand also fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: vi.fn().mockReturnValue(false), configurable: true });

    render(<TelegramSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(screen.getByText(/press Ctrl\/Cmd\+C/i)).toBeTruthy());
  });
});

describe('Quiet hours (ADR 0091)', () => {
  const enableDigest = () => fireEvent.click(screen.getByLabelText('Enable daily digest'));
  const setDigestTime = (v: string) => fireEvent.change(screen.getByLabelText('Digest time'), { target: { value: v } });
  const start = () => screen.getByLabelText('Quiet hours start') as HTMLInputElement;
  const end = () => screen.getByLabelText('Quiet hours end') as HTMLInputElement;

  it('loads the stored window into the inputs', async () => {
    installFetch(CONFIG, 'running', { start: '22:00', end: '08:00' });
    render(<TelegramSettings />);
    await waitFor(() => expect(start().value).toBe('22:00'));
    expect(end().value).toBe('08:00');
  });

  it('shows the live "delayed until" notice when the digest time is INSIDE the window (wrap), hidden otherwise', async () => {
    installFetch(CONFIG, 'running', { start: '22:00', end: '08:00' });
    render(<TelegramSettings />);
    await waitFor(() => expect(start().value).toBe('22:00'));
    enableDigest();

    setDigestTime('07:00'); // inside 22:00–08:00 (wrap) → delayed
    await waitFor(() => expect(screen.getByRole('note').textContent).toMatch(/delayed until 08:00/i));

    setDigestTime('09:00'); // outside → no notice
    await waitFor(() => expect(screen.queryByRole('note')).toBeNull());
  });

  it('does not show the notice while the digest is disabled, even if the time is inside the window', async () => {
    installFetch(CONFIG, 'running', { start: '22:00', end: '08:00' });
    render(<TelegramSettings />);
    await waitFor(() => expect(start().value).toBe('22:00'));
    setDigestTime('07:00'); // inside, but digest not enabled
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('saves both ends via PUT and round-trips', async () => {
    installFetch(CONFIG);
    render(<TelegramSettings />);
    await screen.findByLabelText('Quiet hours start');
    fireEvent.change(start(), { target: { value: '23:00' } });
    fireEvent.change(end(), { target: { value: '07:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save quiet hours' }));
    await waitFor(() => expect(quietPuts).toEqual([{ start: '23:00', end: '07:00' }]));
  });

  it('a half-window is blocked client-side — guidance shown, Save disabled, no PUT (avoids the API 400)', async () => {
    installFetch(CONFIG);
    render(<TelegramSettings />);
    await screen.findByLabelText('Quiet hours start');
    fireEvent.change(start(), { target: { value: '22:00' } }); // only one end set
    expect(screen.getByText(/set both a start and end/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save quiet hours' }) as HTMLButtonElement).disabled).toBe(true);
    expect(quietPuts).toEqual([]);
  });

  it('clearing both turns it off (PUT null/null)', async () => {
    installFetch(CONFIG, 'running', { start: '22:00', end: '08:00' });
    render(<TelegramSettings />);
    await waitFor(() => expect((screen.getByLabelText('Quiet hours start') as HTMLInputElement).value).toBe('22:00'));
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save quiet hours' }));
    await waitFor(() => expect(quietPuts).toEqual([{ start: null, end: null }]));
  });
});
