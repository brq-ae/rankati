import type { TelegramBotStatus, TelegramConfigDto, TelegramStatusDto } from '@rankati/shared';
import { useEffect, useRef, useState } from 'react';
import {
  deleteTelegramToken,
  getTelegramStatus,
  regenerateTelegramCode,
  setTelegramDigest,
  setTelegramToken,
  unlinkTelegram,
} from './api';
import { telegramBadge } from './telegram-status';

/** The browser's IANA zone, or '' if unavailable — used to pre-fill so the user rarely picks one. */
function detectedTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** The full IANA zone list for the datalist, dependency-free; [] on older engines (falls back to free text). */
function zoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

const SETTLE_TRIES = 4;
const SETTLE_DELAY_MS = 700;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const badgeTone: Record<string, string> = {
  connected: 'bg-primary/15 text-primary',
  error: 'bg-danger/15 text-danger',
  pending: 'bg-hover text-muted',
  neutral: 'bg-hover text-muted',
};

const inputCls =
  'rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary';
const btnCls =
  'touch-manipulation rounded-xl border border-field px-3 py-1.5 text-sm text-fg hover:bg-hover disabled:opacity-50';

/**
 * Settings → Telegram (ADR 0084, Step 8). Self-contained: it reads the masked config + poller status from
 * the authed endpoints and mutates through them — no client-side bot logic. The raw token never returns; the
 * timezone is auto-detected; the health badge re-polls (capped) after a token change so a rejected token is
 * visible rather than silently dead.
 */
export default function TelegramSettings() {
  const [config, setConfig] = useState<TelegramConfigDto | null>(null);
  const [status, setStatus] = useState<TelegramBotStatus>('stopped');
  const [settling, setSettling] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tokenInput, setTokenInput] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState('08:00');
  const [tz, setTz] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const codeRef = useRef<HTMLInputElement>(null);
  const zones = zoneOptions();

  // Initialise from the server once. Timezone falls back to the browser's zone so enabling "just works".
  // The passive load uses a RAW fetch, not the api.ts seam: a failure here shows an inline error and must
  // NOT trip the app-wide 401→logout — this optional panel failing should never end the session.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [cRes, sRes] = await Promise.all([
          fetch('/api/telegram/config'),
          fetch('/api/telegram/status'),
        ]);
        if (!cRes.ok || !sRes.ok) throw new Error('Could not load Telegram settings.');
        const c = (await cRes.json()) as TelegramConfigDto;
        const s = (await sRes.json()) as TelegramStatusDto;
        if (!live) return;
        setConfig(c);
        setStatus(s.status);
        setEnabled(c.digestEnabled);
        setTime(c.digestTime);
        setTz(c.timezone ?? detectedTimezone());
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : 'Could not load Telegram settings.');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // After a token change the poller starts async — poll status a few times, then land on a DEFINITE badge.
  const settleStatus = async () => {
    setSettling(true);
    try {
      for (let i = 0; i < SETTLE_TRIES; i += 1) {
        try {
          const { status: s } = await getTelegramStatus();
          setStatus(s);
          if (s !== 'stopped') return; // 'running' / 'error' are definite
        } catch {
          /* keep trying */
        }
        if (i < SETTLE_TRIES - 1) await delay(SETTLE_DELAY_MS);
      }
    } finally {
      setSettling(false); // exhausted → whatever the last poll said stands (never stuck on "Checking…")
    }
  };

  const run = async (fn: () => Promise<TelegramConfigDto>, after?: () => void) => {
    setError(null);
    setBusy(true);
    try {
      setConfig(await fn());
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const token = tokenInput.trim();
    if (!token) {
      setError('Paste your bot token first.');
      return;
    }
    await run(() => setTelegramToken(token), () => setTokenInput(''));
    void settleStatus();
  };

  const remove = async () => {
    await run(deleteTelegramToken, () => {
      setConfirmRemove(false);
      setStatus('stopped');
    });
  };

  const saveDigest = async () => {
    const zone = tz.trim();
    if (enabled && !zone) {
      setError('Set a timezone to enable the daily digest.');
      return;
    }
    await run(() => setTelegramDigest({ enabled, time, timezone: zone || null }));
  };

  const copyCode = async () => {
    const code = config?.linkCode;
    if (!code) return;
    setCopyHint(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
        setCopyHint('Copied!');
        return;
      }
    } catch {
      /* fall through to manual selection */
    }
    // Non-secure context (plain-HTTP LAN): navigator.clipboard is undefined. Select the text and use the
    // legacy execCommand('copy') — it works in a non-secure context on a user gesture. Only if THAT fails
    // do we leave it selected for a manual copy.
    codeRef.current?.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    setCopyHint(copied ? 'Copied!' : 'Selected — press Ctrl/Cmd+C to copy');
  };

  if (loadError) {
    return (
      <div className="flex flex-col gap-2 border-t border-divider pt-4">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Telegram</span>
        <span className="text-sm text-danger">{loadError}</span>
      </div>
    );
  }
  if (!config) {
    return (
      <div className="flex flex-col gap-2 border-t border-divider pt-4">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Telegram</span>
        <span className="text-sm text-muted">Loading…</span>
      </div>
    );
  }

  const badge = telegramBadge(config.configured, status, settling);

  return (
    <div className="flex flex-col gap-3 border-t border-divider pt-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Telegram</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badgeTone[badge.tone]}`} role="status">
          {badge.label}
        </span>
      </div>

      {/* Token */}
      {config.configured ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Token</span>
          <span className="font-mono text-fg">{config.tokenMask}</span>
          {confirmRemove ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted">Remove? This unbinds and stops the bot.</span>
              <button type="button" className={btnCls} onClick={remove} disabled={busy}>
                Confirm
              </button>
              <button type="button" className={btnCls} onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className={btnCls} onClick={() => setConfirmRemove(true)}>
              Remove bot
            </button>
          )}
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted">Bot token (from BotFather)</span>
          <span className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="123456:ABC-…"
              aria-label="Bot token"
              className={`${inputCls} min-w-56 flex-1 font-mono`}
            />
            <button type="button" className={btnCls} onClick={connect} disabled={busy}>
              Connect
            </button>
          </span>
        </label>
      )}

      {/* Link code + bound chat */}
      {config.configured && (
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Link code</span>
            <input
              ref={codeRef}
              type="text"
              readOnly
              value={config.linkCode ?? '—'}
              aria-label="Link code"
              className={`${inputCls} w-32 font-mono`}
            />
            <button type="button" className={btnCls} onClick={copyCode} disabled={!config.linkCode}>
              Copy
            </button>
            <button
              type="button"
              className={btnCls}
              onClick={() => run(regenerateTelegramCode)}
              disabled={busy}
            >
              Regenerate
            </button>
            {copyHint && <span className="text-xs text-muted">{copyHint}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Chat</span>
            {config.bound ? (
              <>
                <span className="text-fg">Linked</span>
                {confirmUnlink ? (
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted">Unlink this chat?</span>
                    <button type="button" className={btnCls} onClick={() => run(unlinkTelegram, () => setConfirmUnlink(false))} disabled={busy}>
                      Confirm
                    </button>
                    <button type="button" className={btnCls} onClick={() => setConfirmUnlink(false)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button type="button" className={btnCls} onClick={() => setConfirmUnlink(true)}>
                    Unlink
                  </button>
                )}
              </>
            ) : (
              <span className="text-muted">Not linked — send the code from your Telegram chat.</span>
            )}
          </div>
        </div>
      )}

      {/* Daily digest */}
      <div className="flex flex-col gap-2 text-sm">
        <span className="text-xs font-medium text-muted">Daily digest</span>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} aria-label="Enable daily digest" />
            <span>Send a daily digest</span>
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted">at</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-label="Digest time"
              className={`${inputCls} w-28`}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Timezone</span>
          <input
            type="text"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            list="tz-options"
            placeholder="e.g. Asia/Dubai"
            aria-label="Timezone"
            className={`${inputCls} max-w-64`}
          />
          {zones.length > 0 && (
            <datalist id="tz-options">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          )}
        </label>
        <div>
          <button type="button" className={btnCls} onClick={saveDigest} disabled={busy}>
            Save digest
          </button>
        </div>
      </div>

      {error && <span className="text-sm text-danger">{error}</span>}
    </div>
  );
}
