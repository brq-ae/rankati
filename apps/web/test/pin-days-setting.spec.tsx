// @vitest-environment happy-dom
import type { Impact, List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import SettingsModal from '../src/SettingsModal';
import { PIN_DAYS_KEY, SNOOZES_KEY } from '../src/pin';

/**
 * The impact-pin Settings knobs (ADR 0075) — the two fuses + two snooze spans, editable and persisted,
 * mirroring the hand-size control. The component tests the four inputs; the integration proves the knobs
 * DRIVE behaviour: a fuse change flips whether a task pins, and a snooze-span change changes how long it hides.
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
    expect(box('Medium impact nags after').value).toBe('30'); // snapped back to the stored default
  });
});

// ── Integration: the knobs drive behaviour ─────────────────────────────────────────────────────────
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];
const DAY = 86_400_000;
const mk = (id: string, title: string, impact: Impact, createdAt: string): Task => ({
  id, title, listId: 'l1', ownerId: 'local', status: 'active', createdAt,
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, checklist: [], effort: null, impact,
});
let todayTasks: Task[];
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const body = url.includes('/api/telegram/status')
        ? { status: 'stopped' }
        : url.includes('/api/telegram')
        ? { configured: false, tokenMask: null, bound: false, boundChatId: null, linkCode: null, digestEnabled: false, digestTime: '08:00', timezone: null }
        : url.includes('/api/locations')
        ? []
        : url.includes('/api/lists')
          ? LISTS
          : url.includes('/api/tasks/upcoming')
            ? []
            : url.includes('/api/tasks')
              ? todayTasks
              : undefined;
      if (body === undefined) throw new Error(`pin-days: unstubbed ${url}`);
      return Promise.resolve({
        ok: true, headers: { get: () => null }, json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}
const gotoToday = async () => fireEvent.click(await screen.findByRole('button', { name: /^today$/i }));
const setKnob = (label: string, n: string) => {
  const b = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.change(b, { target: { value: n } });
  fireEvent.blur(b);
};

describe('the knobs drive the pin (App, ADR 0075)', () => {
  const NOW = Date.parse('2026-08-01T12:00:00.000Z');
  const FILLERS = ['a', 'b', 'c', 'd', 'e'].map((n) =>
    mk(n, `Task ${n.toUpperCase()}`, 'none', new Date(NOW).toISOString()),
  );

  beforeEach(() => {
    localStorage.clear();
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

  it('lowering the High fuse makes a not-yet-pinning task pin; raising it stops', async () => {
    // Task P is High but only 4 days old — under the default fuse of 7, so it does NOT pin.
    todayTasks = [...FILLERS, mk('p', 'Task P', 'high', new Date(NOW - 4 * DAY).toISOString())];
    render(<App />);
    await gotoToday();
    await screen.findByText('Task A');
    expect(screen.queryByText(/impact ·/)).toBeNull(); // 4 < 7 → no pin

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    setKnob('High impact nags after', '3'); // fuse 3 → 4 >= 3 → pins
    expect(await screen.findByText('high-impact · 4 days')).toBeTruthy();
    expect(localStorage.getItem(PIN_DAYS_KEY)).toContain('"highFuseDays":3'); // persisted

    setKnob('High impact nags after', '100'); // fuse 100 → 4 < 100 → no longer pins
    await waitFor(() => expect(screen.queryByText(/impact ·/)).toBeNull());
  });

  it('the configured High snooze span drives the persisted snoozedUntil', async () => {
    todayTasks = [...FILLERS, mk('p', 'Task P', 'high', new Date(NOW - 10 * DAY).toISOString())];
    render(<App />);
    await gotoToday();
    await screen.findByText('high-impact · 10 days');

    // Set the high snooze span to 5 days, then snooze the pin.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    setKnob('Snooze a high-impact nudge for', '5');
    fireEvent.click(screen.getByRole('button', { name: 'Snooze Task P' }));

    const until = JSON.parse(localStorage.getItem(SNOOZES_KEY) ?? '{}').p as number;
    expect(until).toBeGreaterThanOrEqual(NOW + 5 * DAY); // the NEW span, not the default 1 day
    expect(until).toBeLessThan(NOW + 5 * DAY + 60_000);
  });
});
