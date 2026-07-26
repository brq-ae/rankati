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
  ...over,
});
const floating = (o: Partial<Routine>) => routine({ type: 'interval_floating', intervalUnit: 'week', intervalCount: 1, ...o });
const fixed = (o: Partial<Routine>) => routine({ type: 'interval_fixed', ruleKind: 'day_of_month', ruleDayOfMonth: 15, ...o });

beforeEach(() => {
  seq = 0;
  vi.mocked(api.getRoutines).mockResolvedValue([]);
  vi.mocked(api.routineDid).mockResolvedValue(routine({}));
  vi.mocked(api.routineDismiss).mockResolvedValue(routine({}));
  vi.mocked(api.routineSnooze).mockResolvedValue(routine({}));
  vi.mocked(api.createRoutine).mockResolvedValue(routine({}));
  vi.mocked(api.updateRoutine).mockResolvedValue(routine({}));
  vi.mocked(api.deleteRoutine).mockResolvedValue(undefined);
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
