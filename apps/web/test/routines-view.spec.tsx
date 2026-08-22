// @vitest-environment happy-dom
import type { Routine } from '@rankati/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RoutinesView from '../src/RoutinesView';
import * as api from '../src/api';

vi.mock('../src/api');

/**
 * The Routines tab (ADR 0066). Climb order, client-clock snooze hiding, and the actions/create/edit/
 * delete flows. Post-effect values (the list after a fetch, the form after opening) are read with
 * findBy* per the release-gate flake rule.
 */
const ON = '2026-01-14';
let seq = 0;
const routine = (over: Partial<Routine>): Routine => ({
  id: `r${seq++}`,
  ownerId: 'local',
  name: 'R',
  type: 'frequency',
  createdAt: '2026-01-01T00:00:00.000Z',
  snoozedUntil: null,
  periodUnit: 'week',
  targetCount: 3,
  periodCount: 0,
  periodStart: '2026-01-12',
  intervalUnit: null,
  intervalCount: null,
  preferredWeekday: null,
  nextDue: null,
  ruleKind: null,
  ruleOrdinal: null,
  ruleWeekday: null,
  ruleDayOfMonth: null,
  acknowledgedDate: null,
  telegramNag: false,
  nagIntervalMinutes: null,
  linkedLogId: null,
  ...over,
});
const floating = (o: Partial<Routine>) => routine({ type: 'interval_floating', intervalUnit: 'week', intervalCount: 1, ...o });
const fixed = (o: Partial<Routine>) => routine({ type: 'interval_fixed', ruleKind: 'day_of_month', ruleDayOfMonth: 15, ...o });
const tgConfig = (over: Partial<import('@rankati/shared').TelegramConfigDto>) => ({
  configured: true,
  tokenMask: '••••1234',
  bound: true,
  boundChatId: '42',
  linkCode: null,
  digestEnabled: false,
  digestTime: '08:00',
  timezone: 'Asia/Dubai',
  ...over,
});

beforeEach(() => {
  seq = 0;
  vi.mocked(api.getRoutines).mockResolvedValue([]);
  vi.mocked(api.routineDid).mockResolvedValue(routine({}));
  vi.mocked(api.routineDismiss).mockResolvedValue(routine({}));
  vi.mocked(api.routineSnooze).mockResolvedValue(routine({}));
  vi.mocked(api.createRoutine).mockResolvedValue(routine({}));
  vi.mocked(api.updateRoutine).mockResolvedValue(routine({}));
  vi.mocked(api.deleteRoutine).mockResolvedValue(undefined);
  vi.mocked(api.getTelegramConfig).mockResolvedValue(tgConfig({})); // default: channel ready (no warning)
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('RoutinesView — climb order', () => {
  it('overdue due-based at top, then soonest; frequency in a band below', async () => {
    vi.mocked(api.getRoutines).mockResolvedValue([
      routine({ id: 'freq', name: 'Freq' }),
      floating({ id: 'overdue', name: 'Overdue', nextDue: '2026-01-10' }), // −4d
      fixed({ id: 'soon', name: 'Soon', nextDue: '2026-01-16' }), // +2d
    ]);
    render(<RoutinesView on={ON} />);
    await screen.findByText('Overdue');
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]!).queryByText('Overdue')).not.toBeNull();
    expect(within(items[1]!).queryByText('Soon')).not.toBeNull();
    expect(within(items[2]!).queryByText('Freq')).not.toBeNull(); // no due date → bottom band
  });
});

describe('RoutinesView — snooze hiding (client clock)', () => {
  it('hidden while snoozedUntil is in the future; shown once it has elapsed', async () => {
    const now = Date.now();
    vi.mocked(api.getRoutines).mockResolvedValue([
      routine({ name: 'SnoozedFuture', snoozedUntil: new Date(now + 3_600_000).toISOString() }),
      routine({ name: 'SnoozedPast', snoozedUntil: new Date(now - 60_000).toISOString() }),
      routine({ name: 'Plain' }),
    ]);
    render(<RoutinesView on={ON} />);
    await screen.findByText('Plain');
    expect(screen.queryByText('SnoozedFuture')).toBeNull(); // still snoozed → hidden
    expect(screen.queryByText('SnoozedPast')).not.toBeNull(); // elapsed → resurfaced
  });
});

describe('RoutinesView — actions', () => {
  it('Did it → routineDid(id, on)', async () => {
    vi.mocked(api.getRoutines).mockResolvedValue([floating({ id: 'r1', name: 'Water plants', nextDue: '2026-01-20' })]);
    render(<RoutinesView on={ON} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Did Water plants' }));
    await waitFor(() => expect(api.routineDid).toHaveBeenCalledWith('r1', ON));
  });
  it('Dismiss (fixed only) → routineDismiss(id, on)', async () => {
    vi.mocked(api.getRoutines).mockResolvedValue([fixed({ id: 'f1', name: 'Pay rent', nextDue: '2026-01-15' })]);
    render(<RoutinesView on={ON} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Pay rent' }));
    await waitFor(() => expect(api.routineDismiss).toHaveBeenCalledWith('f1', ON));
  });
  it('Snooze preset → routineSnooze with a future ISO time', async () => {
    vi.mocked(api.getRoutines).mockResolvedValue([routine({ id: 's1', name: 'Stretch' })]);
    render(<RoutinesView on={ON} />);
    const before = Date.now();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Snooze Stretch' }), { target: { value: '60' } });
    await waitFor(() => expect(api.routineSnooze).toHaveBeenCalled());
    const [, until] = vi.mocked(api.routineSnooze).mock.calls[0]!;
    expect(Date.parse(until)).toBeGreaterThanOrEqual(before + 59 * 60_000); // ~1 hour out
  });
  it('Delete → confirm → deleteRoutine(id)', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.mocked(api.getRoutines).mockResolvedValue([routine({ id: 'd1', name: 'Trash out' })]);
    render(<RoutinesView on={ON} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Trash out' }));
    await waitFor(() => expect(api.deleteRoutine).toHaveBeenCalledWith('d1'));
  });
});

describe('RoutinesView — create & edit', () => {
  it('create a frequency routine → createRoutine with the form values + on', async () => {
    render(<RoutinesView on={ON} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New routine' }));
    fireEvent.change(await screen.findByLabelText('Routine name'), { target: { value: 'Meditate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(api.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Meditate', type: 'frequency', on: ON, periodUnit: 'week', targetCount: 3 }),
      ),
    );
  });
  it('edit sends only the changed field (rename) with on', async () => {
    vi.mocked(api.getRoutines).mockResolvedValue([routine({ id: 'e1', name: 'Old name', periodCount: 1 })]);
    render(<RoutinesView on={ON} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Old name' }));
    const input = await screen.findByLabelText('Routine name');
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateRoutine).toHaveBeenCalledWith('e1', { on: ON, name: 'New name' }));
  });
});

describe('RoutinesView — Telegram nag & log-link (ADR 0091 M2)', () => {
  const openNew = async () => {
    render(<RoutinesView on={ON} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New routine' }));
    await screen.findByLabelText('Routine name');
  };

  it('the nag-frequency picker is hidden until "Remind me on Telegram" is on', async () => {
    await openNew();
    expect(screen.queryByLabelText('Nag frequency')).toBeNull();
    fireEvent.click(screen.getByLabelText('Remind me on Telegram'));
    expect(screen.getByLabelText('Nag frequency')).not.toBeNull(); // revealed
  });

  it('the log-link toggle is hidden for frequency, shown for non-frequency types', async () => {
    await openNew();
    expect(screen.queryByLabelText('Log each completion')).toBeNull(); // default type = frequency
    fireEvent.change(screen.getByLabelText('Routine type'), { target: { value: 'interval_floating' } });
    expect(screen.getByLabelText('Log each completion')).not.toBeNull();
  });

  it('creating a floating routine with nag + link threads telegramNag/nagIntervalMinutes/linkLog', async () => {
    await openNew();
    fireEvent.change(screen.getByLabelText('Routine name'), { target: { value: 'Water plants' } });
    fireEvent.change(screen.getByLabelText('Routine type'), { target: { value: 'interval_floating' } });
    fireEvent.click(screen.getByLabelText('Remind me on Telegram'));
    fireEvent.change(screen.getByLabelText('Nag frequency'), { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText('Log each completion'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(api.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Water plants',
          type: 'interval_floating',
          telegramNag: true,
          nagIntervalMinutes: 30,
          linkLog: true,
        }),
      ),
    );
  });

  it('does NOT send nag/link fields when the toggles stay off (create)', async () => {
    await openNew();
    fireEvent.change(screen.getByLabelText('Routine name'), { target: { value: 'Plain' } });
    fireEvent.change(screen.getByLabelText('Routine type'), { target: { value: 'interval_floating' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.createRoutine).toHaveBeenCalled());
    const dto = vi.mocked(api.createRoutine).mock.calls[0]![0];
    expect(dto).not.toHaveProperty('telegramNag');
    expect(dto).not.toHaveProperty('linkLog');
  });

  it('editing an already-nagging routine sends only the changed cadence', async () => {
    vi.mocked(api.getRoutines).mockResolvedValue([
      floating({ id: 'n1', name: 'Vitamins', nextDue: '2026-01-20', telegramNag: true, nagIntervalMinutes: 60 }),
    ]);
    render(<RoutinesView on={ON} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Vitamins' }));
    await screen.findByLabelText('Nag frequency');
    fireEvent.change(screen.getByLabelText('Nag frequency'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateRoutine).toHaveBeenCalledWith('n1', { on: ON, nagIntervalMinutes: 120 }));
  });

  it('turning nagging OFF in edit sends telegramNag:false (and no cadence)', async () => {
    vi.mocked(api.getRoutines).mockResolvedValue([
      floating({ id: 'n2', name: 'Floss', nextDue: '2026-01-20', telegramNag: true, nagIntervalMinutes: 30 }),
    ]);
    render(<RoutinesView on={ON} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Floss' }));
    fireEvent.click(await screen.findByLabelText('Remind me on Telegram')); // toggle off
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateRoutine).toHaveBeenCalledWith('n2', { on: ON, telegramNag: false }));
  });
});

describe('RoutinesView — nag readiness warning (ADR 0091 M2 addendum)', () => {
  const openNagOn = async () => {
    render(<RoutinesView on={ON} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New routine' }));
    await screen.findByLabelText('Routine name');
    fireEvent.change(screen.getByLabelText('Routine type'), { target: { value: 'interval_floating' } });
    fireEvent.click(screen.getByLabelText('Remind me on Telegram'));
  };

  it('warns to connect the bot AND set a timezone when neither is ready', async () => {
    vi.mocked(api.getTelegramConfig).mockResolvedValue(tgConfig({ bound: false, timezone: null }));
    await openNagOn();
    expect(await screen.findByText(/bot connected and a timezone set/i)).not.toBeNull();
  });

  it('warns only about the timezone when the bot is connected but no tz', async () => {
    vi.mocked(api.getTelegramConfig).mockResolvedValue(tgConfig({ bound: true, timezone: null }));
    await openNagOn();
    expect(await screen.findByText(/need a timezone set/i)).not.toBeNull();
  });

  it('warns only about the bot when a timezone is set but the bot is not connected', async () => {
    vi.mocked(api.getTelegramConfig).mockResolvedValue(tgConfig({ bound: false, timezone: 'Asia/Dubai' }));
    await openNagOn();
    expect(await screen.findByText(/bot connected \(Settings/i)).not.toBeNull();
  });

  it('shows NO warning once the channel is ready (bound + timezone)', async () => {
    vi.mocked(api.getTelegramConfig).mockResolvedValue(tgConfig({ bound: true, timezone: 'Asia/Dubai' }));
    await openNagOn();
    // Initial state is fail-toward-warning; it clears once the (ready) config resolves.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('shows NO warning while nagging is off, even when the channel is not ready', async () => {
    vi.mocked(api.getTelegramConfig).mockResolvedValue(tgConfig({ bound: false, timezone: null }));
    render(<RoutinesView on={ON} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New routine' }));
    await screen.findByLabelText('Routine name');
    fireEvent.change(screen.getByLabelText('Routine type'), { target: { value: 'interval_floating' } });
    // toggle left OFF → no warning regardless of readiness
    expect(screen.queryByText(/Reminders need/i)).toBeNull();
  });
});
