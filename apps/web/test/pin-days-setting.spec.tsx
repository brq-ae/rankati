// @vitest-environment happy-dom
import type { Impact, List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import SettingsModal from '../src/SettingsModal';

/**
 * The impact-pin Settings knobs (ADRs 0075, 0086) — the two fuses + two snooze spans. The component tests
 * the four inputs; the integration proves the knobs DRIVE behaviour end to end, now SERVER-backed: a fuse
 * change (PUT /settings/pin) flips whether a task pins, and a snooze-span change changes the snoozed instant.
 */
const openDialog = () => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
};
const noop = vi.fn();
const DEFAULTS = { highFuseDays: 7, mediumFuseDays: 30, highSnoozeDays: 1, mediumSnoozeDays: 3 };

describe('the impact-pin Settings inputs (ADR 0075)', () => {
  beforeEach(openDialog);
  afterEach(cleanup);

  const renderSettings = (onSetPinDays = vi.fn(), pinDays = DEFAULTS) => {
    render(
      <SettingsModal
        theme="brand"
        mode="light"
        onSelectTheme={noop}
        thresholds={{ quickMax: 15, mediumMax: 60 }}
        onSetThresholds={noop}
        handSize={5}
        onSetHandSize={noop}
        pinDays={pinDays}
        onSetPinDays={onSetPinDays}
        locations={[]}
        error={null}
        onClose={noop}
        onCreate={noop}
        onRename={noop}
        onDelete={noop}
        onMerge={noop}
        onClearTasks={noop}
        onFactoryReset={noop}
        onLogout={noop}
      />,
    );
    return onSetPinDays;
  };
  const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

  it('the four inputs render the current values', () => {
    renderSettings(vi.fn(), { highFuseDays: 5, mediumFuseDays: 20, highSnoozeDays: 2, mediumSnoozeDays: 4 });
    expect(box('High impact nags after').value).toBe('5');
    expect(box('Medium impact nags after').value).toBe('20');
    expect(box('Snooze a high-impact nudge for').value).toBe('2');
    expect(box('Snooze a medium-impact nudge for').value).toBe('4');
  });

  it('editing a field commits the whole set with that one field changed', () => {
    const onSet = renderSettings();
    fireEvent.change(box('High impact nags after'), { target: { value: '10' } });
    fireEvent.blur(box('High impact nags after'));
    expect(onSet).toHaveBeenCalledWith({ ...DEFAULTS, highFuseDays: 10 });
  });

  it('an invalid value snaps back and is never written', () => {
    const onSet = renderSettings();
    fireEvent.change(box('Medium impact nags after'), { target: { value: '0' } });
    fireEvent.blur(box('Medium impact nags after'));
    expect(onSet).not.toHaveBeenCalled();
    expect(box('Medium impact nags after').value).toBe('30');
  });
});

// ── Integration: the knobs drive behaviour, server-backed ──────────────────────────────────────────
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];
const DAY = 86_400_000;
const mk = (id: string, title: string, impact: Impact, createdAt: string): Task => ({
  id, title, listId: 'l1', ownerId: 'local', status: 'active', createdAt,
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, checklist: [], effort: null,
  pinSnoozedUntil: null, impact,
});
let todayTasks: Task[];
let config: typeof DEFAULTS;
const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response);

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      if (url.includes('/api/settings/pin')) {
        if (method === 'PUT') config = { ...config, ...(JSON.parse(String(init?.body)) as typeof DEFAULTS) };
        return okJson(config);
      }
      if (url.includes('/pin-snooze') && method === 'POST') {
        const id = url.split('/')[3];
        const t = todayTasks.find((x) => x.id === id);
        if (t) {
          const span = t.impact === 'high' ? config.highSnoozeDays : config.mediumSnoozeDays;
          t.pinSnoozedUntil = new Date(Date.now() + span * DAY).toISOString();
          return okJson(t);
        }
      }
      if (method !== 'GET') return okJson({ status: 'done' });
      if (url.includes('/api/telegram/status')) return okJson({ status: 'stopped' });
      if (url.includes('/api/telegram'))
        return okJson({ configured: false, tokenMask: null, bound: false, boundChatId: null, linkCode: null, digestEnabled: false, digestTime: '08:00', timezone: null });
      const body = url.includes('/api/locations')
        ? []
        : url.includes('/api/lists')
          ? LISTS
          : url.includes('/api/tasks/upcoming')
            ? []
            : url.includes('/api/tasks')
              ? todayTasks
              : undefined;
      if (body === undefined) throw new Error(`pin-days: unstubbed ${method} ${url}`);
      return okJson(body);
    }),
  );
}
const gotoToday = async () => fireEvent.click(await screen.findByRole('button', { name: /^today$/i }));
const setKnob = (label: string, n: string) => {
  const b = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.change(b, { target: { value: n } });
  fireEvent.blur(b);
};

describe('the knobs drive the pin (App, ADRs 0075, 0086)', () => {
  const NOW = Date.parse('2026-08-01T12:00:00.000Z');
  const FILLERS = ['a', 'b', 'c', 'd', 'e'].map((n) =>
    mk(n, `Task ${n.toUpperCase()}`, 'none', new Date(NOW).toISOString()),
  );

  beforeEach(() => {
    localStorage.clear();
    config = { ...DEFAULTS };
    openDialog();
    stubFetch();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lowering the High fuse (PUT) makes a not-yet-pinning task pin; raising it stops', async () => {
    // Task P is High but only 4 days old — under the default fuse of 7, so it does NOT pin.
    todayTasks = [...FILLERS, mk('p', 'Task P', 'high', new Date(NOW - 4 * DAY).toISOString())];
    render(<App />);
    await gotoToday();
    await screen.findByText('Task A');
    expect(screen.queryByText(/impact ·/)).toBeNull(); // 4 < 7 → no pin

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    setKnob('High impact nags after', '3'); // fuse 3 → 4 >= 3 → pins
    expect(await screen.findByText('high-impact · 4 days')).toBeTruthy();
    expect(config.highFuseDays).toBe(3); // persisted server-side

    setKnob('High impact nags after', '100'); // fuse 100 → 4 < 100 → no longer pins
    await waitFor(() => expect(screen.queryByText(/impact ·/)).toBeNull());
  });

  it('the configured High snooze span drives the snoozed instant', async () => {
    todayTasks = [...FILLERS, mk('p', 'Task P', 'high', new Date(NOW - 10 * DAY).toISOString())];
    render(<App />);
    await gotoToday();
    await screen.findByText('high-impact · 10 days');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    setKnob('Snooze a high-impact nudge for', '5');
    fireEvent.click(screen.getByRole('button', { name: 'Snooze Task P' }));

    await waitFor(() => {
      const t = todayTasks.find((x) => x.id === 'p');
      const su = t?.pinSnoozedUntil ? Date.parse(t.pinSnoozedUntil) : 0;
      expect(su).toBeGreaterThanOrEqual(NOW + 5 * DAY); // the NEW span, not the default 1 day (± test-clock ms)
      expect(su).toBeLessThan(NOW + 5 * DAY + 60_000);
    });
  });
});
