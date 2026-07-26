// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import SettingsModal from '../src/SettingsModal';
import { HAND_SIZE_KEY } from '../src/hand';

/**
 * The Settings hand-size control (ADR 0074) — the `handSize` localStorage pref (default 5, min 1),
 * mirroring the effort-thresholds control. Changing N RE-CAPS the shown hand: fewer with a smaller N,
 * empty slots (for Deal again) with a larger N — never an auto-grow (consistent with no-auto-fill).
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

describe('the Settings hand-size input (ADR 0074)', () => {
  beforeEach(openDialog);
  afterEach(cleanup);

  const renderSettings = (onSetHandSize = vi.fn(), handSize = 5) => {
    render(
      <SettingsModal
        theme="brand"
        mode="light"
        onSelectTheme={noop}
        thresholds={{ quickMax: 15, mediumMax: 60 }}
        onSetThresholds={noop}
        handSize={handSize}
        onSetHandSize={onSetHandSize}
        pinDays={{ highFuseDays: 7, mediumFuseDays: 30, highSnoozeDays: 1, mediumSnoozeDays: 3 }}
        onSetPinDays={noop}
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
    return onSetHandSize;
  };
  const input = () => screen.getByLabelText('Cards per hand') as HTMLInputElement;

  it('renders the current size and commits a valid edit on blur', () => {
    const onSet = renderSettings(vi.fn(), 5);
    expect(input().value).toBe('5');
    fireEvent.change(input(), { target: { value: '3' } });
    fireEvent.blur(input());
    expect(onSet).toHaveBeenCalledWith(3);
  });

  it('refuses < 1 and garbage — snaps back, never written', () => {
    const onSet = renderSettings(vi.fn(), 5);
    fireEvent.change(input(), { target: { value: '0' } });
    fireEvent.blur(input());
    expect(onSet).not.toHaveBeenCalled();
    expect(input().value).toBe('5'); // snapped back

    fireEvent.change(input(), { target: { value: 'abc' } });
    fireEvent.blur(input());
    expect(onSet).not.toHaveBeenCalled();
    expect(input().value).toBe('5');
  });
});

// ── App integration: changing N re-caps the hand ────────────────────────────────────────────────
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];
const mk = (id: string, title: string): Task => ({
  id, title, listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, impact: 'none', checklist: [], effort: null,
});
const ALL = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => mk(n.toLowerCase(), `Task ${n}`));

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const body = url.includes('/api/locations')
        ? []
        : url.includes('/api/lists')
          ? LISTS
          : url.includes('/api/tasks/upcoming')
            ? []
            : url.includes('/api/tasks')
              ? ALL
              : undefined;
      if (body === undefined) throw new Error(`hand-size: unstubbed ${url}`);
      return Promise.resolve({
        ok: true, headers: { get: () => null }, json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}
const handCount = () =>
  screen.getAllByRole('listitem').map((li) => li.textContent ?? '').filter((tx) => tx.includes('Task ')).length;

describe('changing the hand size re-caps the hand (App, ADR 0074)', () => {
  beforeEach(() => {
    localStorage.clear();
    openDialog();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const gotoToday = async () => fireEvent.click(await screen.findByRole('button', { name: /^today$/i }));
  const setSize = (n: string) => {
    // The Settings modal renders OVER the Today hand (both in the DOM), so the re-capped hand is
    // queryable without closing — happy-dom does not paint, and it does not fire the dialog's
    // close event anyway. Committing the size on blur is what re-caps the hand.
    const box = screen.getByLabelText('Cards per hand') as HTMLInputElement;
    fireEvent.change(box, { target: { value: n } });
    fireEvent.blur(box);
  };

  it('smaller N shows fewer; larger N leaves empty slots (no auto-grow); persists', async () => {
    render(<App />);
    await gotoToday();
    await screen.findByText('Task A');
    expect(handCount()).toBe(5); // default N=5, six playable → hand of 5

    fireEvent.click(screen.getByRole('button', { name: 'Settings' })); // open the size control

    setSize('3');
    await waitFor(() => expect(handCount()).toBe(3)); // capped to 3 — behind the open modal
    expect(localStorage.getItem(HAND_SIZE_KEY)).toBe('3'); // persisted

    setSize('8');
    // heldIds is still the 5 dealt (a smaller N only capped the DISPLAY, it did not prune). At N=8
    // all 5 held show again — NOT auto-grown to 6 — and the 3 empty slots offer Deal again.
    await waitFor(() => expect(handCount()).toBe(5));
    expect(screen.getByRole('button', { name: 'Deal again' })).toBeTruthy(); // empty slots to fill
    expect(screen.queryByText('Task F')).toBeNull(); // no auto-grow: the next-best is NOT pulled in
  });
});
