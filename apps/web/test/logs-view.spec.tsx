// @vitest-environment happy-dom
import type { Log, LogEntry } from '@rankati/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api';
import LogDetail from '../src/LogDetail';
import LogsView from '../src/LogsView';

/**
 * The Logs sub-tab UI (ADR 0087). Covers the light list (name + compact summary, NOT the full hint), the
 * inline create, the optimistic "did it today", and the on-open detail: the soft cadence hint across the
 * 0 / 1 / ≥2-occurrence states, the history, and undo/rename/delete.
 */
vi.mock('../src/api');

const ON = '2026-03-20';
const entry = (id: string, doneOn: string): LogEntry => ({ id, doneOn, createdAt: `${doneOn}T00:00:00.000Z` });
const log = (over: Partial<Log> & { stats: Log['stats'] }): Log => ({
  id: 'l1',
  ownerId: 'local',
  name: 'Haircut',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // happy-dom has no real modal layer; make showModal actually open the dialog so its contents are in the a11y tree.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(cleanup);

describe('LogsView — the light list (ADR 0087)', () => {
  it('shows the empty state when there are no logs', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([]);
    render(<LogsView on={ON} />);
    expect(await screen.findByText(/No logs yet/)).toBeTruthy();
  });

  it('lists name + a compact last-done summary, and never the full cadence hint', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([
      log({ id: 'a', name: 'Haircut', stats: { lastDoneOn: '2026-02-10', count: 3, averageGapDays: 30, currentGapDays: 38 } }),
      log({ id: 'b', name: 'Nails', stats: { lastDoneOn: null, count: 0, averageGapDays: null, currentGapDays: null } }),
      log({ id: 'c', name: 'Pedicure', stats: { lastDoneOn: ON, count: 1, averageGapDays: null, currentGapDays: 0 } }),
    ]);
    render(<LogsView on={ON} />);
    expect(await screen.findByText('Haircut')).toBeTruthy();
    expect(screen.getByText('38 days ago')).toBeTruthy();
    expect(screen.getByText('Not logged yet')).toBeTruthy();
    expect(screen.getByText('Done today')).toBeTruthy();
    // the average/hint must NOT leak onto the list
    expect(screen.queryByText(/Usually/)).toBeNull();
  });

  it('creates a log from the inline input', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([]);
    vi.mocked(api.createLog).mockResolvedValue(log({ name: 'Haircut', stats: { lastDoneOn: null, count: 0, averageGapDays: null, currentGapDays: null } }));
    render(<LogsView on={ON} />);
    await screen.findByText(/No logs yet/);
    fireEvent.change(screen.getByLabelText('New log name'), { target: { value: '  Haircut  ' } });
    fireEvent.click(screen.getByRole('button', { name: '+ New log' }));
    expect(api.createLog).toHaveBeenCalledWith({ name: 'Haircut' });
  });

  it('"did it today" is optimistic (row shows Done today at once) and calls logDid', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([
      log({ id: 'a', name: 'Haircut', stats: { lastDoneOn: '2026-02-10', count: 2, averageGapDays: 30, currentGapDays: 38 } }),
    ]);
    vi.mocked(api.logDid).mockResolvedValue(log({ id: 'a', stats: { lastDoneOn: ON, count: 3, averageGapDays: 20, currentGapDays: 0 } }));
    render(<LogsView on={ON} />);
    await screen.findByText('Haircut');
    expect(screen.getByText('38 days ago')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Did Haircut today' }));
    expect(screen.getByText('Done today')).toBeTruthy(); // optimistic, before the server round-trip
    expect(api.logDid).toHaveBeenCalledWith('a', ON);
  });
});

describe('LogDetail — the on-open reveal (ADR 0087)', () => {
  const open = (l: Log) => {
    vi.mocked(api.getLog).mockResolvedValue(l);
    return render(<LogDetail id={l.id} on={ON} onClose={() => {}} onChanged={() => {}} />);
  };

  it('0 occurrences → "Not logged yet."', async () => {
    open(log({ stats: { lastDoneOn: null, count: 0, averageGapDays: null, currentGapDays: null }, entries: [] }));
    expect(await screen.findByText('Not logged yet.')).toBeTruthy();
  });

  it('1 occurrence → "Logged once on <date>." (no bogus average)', async () => {
    open(log({ stats: { lastDoneOn: '2026-03-08', count: 1, averageGapDays: null, currentGapDays: 12 }, entries: [entry('e1', '2026-03-08')] }));
    expect(await screen.findByText('Logged once on 8 Mar 2026.')).toBeTruthy();
  });

  it('≥2 occurrences → the soft cadence hint', async () => {
    open(log({ stats: { lastDoneOn: '2026-02-10', count: 4, averageGapDays: 35, currentGapDays: 40 }, entries: [entry('e1', '2026-02-10')] }));
    expect(await screen.findByText("Usually ~35 days · it's been 40 days.")).toBeTruthy();
  });

  it('lists the dated occurrences and undoes one', async () => {
    open(log({ stats: { lastDoneOn: '2026-03-08', count: 2, averageGapDays: 7, currentGapDays: 12 }, entries: [entry('e2', '2026-03-08'), entry('e1', '2026-03-01')] }));
    expect(await screen.findByText('8 Mar 2026')).toBeTruthy();
    expect(screen.getByText('1 Mar 2026')).toBeTruthy();
    vi.mocked(api.logUndo).mockResolvedValue(log({ stats: { lastDoneOn: '2026-03-01', count: 1, averageGapDays: null, currentGapDays: 19 }, entries: [entry('e1', '2026-03-01')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 8 Mar 2026' }));
    expect(api.logUndo).toHaveBeenCalledWith('l1', 'e2', ON);
  });

  it('renames on blur and deletes with a confirm', async () => {
    open(log({ name: 'Haircut', stats: { lastDoneOn: null, count: 0, averageGapDays: null, currentGapDays: null }, entries: [] }));
    const input = (await screen.findByLabelText('Log name')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Barber' } });
    vi.mocked(api.renameLog).mockResolvedValue(log({ name: 'Barber', stats: { lastDoneOn: null, count: 0, averageGapDays: null, currentGapDays: null }, entries: [] }));
    fireEvent.blur(input);
    expect(api.renameLog).toHaveBeenCalledWith('l1', { name: 'Barber' }, ON);

    window.confirm = vi.fn(() => true); // happy-dom has no confirm to spy on
    vi.mocked(api.deleteLog).mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Haircut' }));
    await waitFor(() => expect(api.deleteLog).toHaveBeenCalledWith('l1'));
  });
});
