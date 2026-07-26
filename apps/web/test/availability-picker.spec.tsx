// @vitest-environment happy-dom
import type { Task } from '@rankati/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskDetail from '../src/TaskDetail';

/**
 * The availability-window picker (ADR 0070): four FIXED presets — Anytime / Working hours /
 * Workdays / Weekend — where Anytime is null (ungated) and the default. One choice from a
 * closed set, edited through the same App-handler pattern as every other gate; the chosen
 * window's meaning is spelled out as subtext because the presets are not editable.
 */
const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal', dependsOn: [],
  locationIds: [], needsHand: false, checklist: [], effort: null, needsDetails: false, impact: 'none', ...over,
});

const noop = vi.fn();
function renderDetail(t: Task, onSetAvailabilityWindow = vi.fn()) {
  render(
    <TaskDetail
      task={t}
      tasks={[t]}
      lists={[{ id: 'l1', name: 'Work', ownerId: 'local' }]}
      onClose={noop}
      onRename={noop}
      onSetList={noop}
      onSetNotBefore={noop}
      onSetDue={noop}
      onSetTier={noop}
      onSetAvailabilityWindow={onSetAvailabilityWindow}
      onSetEffort={noop}
      onSetImpact={noop}
      addListId={null}
      onCreateInList={noop}
      onSetNeedsDetails={noop}
      thresholds={{ quickMax: 15, mediumMax: 60 }}
      onSetNeedsHand={noop}
      onSetDependsOn={noop}
      onCreateRequired={noop}
      onAddChecklistItem={noop}
      onUpdateChecklistItem={noop}
      onDeleteChecklistItem={noop}
      locations={[]}
      onSetLocations={noop}
      onCreateAndTagLocation={noop}
      error={null}
    />,
  );
  return onSetAvailabilityWindow;
}

const picker = () => screen.getByRole('group', { name: 'Availability window' });
const option = (label: string) =>
  within(picker()).getByRole('button', { name: `Set availability: ${label}` });

describe('Availability window picker (ADR 0070)', () => {
  beforeEach(() => {
    // happy-dom has no real modal layer; make showModal actually OPEN the dialog (set `open`) so
    // its content is accessible — a closed <dialog> hides its contents from the a11y tree.
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
  });
  afterEach(cleanup);

  it('renders the four presets with Anytime selected for a windowless task', () => {
    renderDetail(task({ id: 'a', title: 'Alpha' })); // availabilityWindow: null
    const buttons = within(picker()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Anytime',
      'Working hours',
      'Workdays',
      'Weekend',
    ]);
    // null = Anytime is the DEFAULT selection, not an unselected state.
    expect(option('Anytime').getAttribute('aria-pressed')).toBe('true');
    expect(option('Working hours').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the current window selected, with its meaning spelled out', () => {
    renderDetail(task({ id: 'a', title: 'Alpha', availabilityWindow: 'working_hours' }));
    expect(option('Working hours').getAttribute('aria-pressed')).toBe('true');
    expect(option('Anytime').getAttribute('aria-pressed')).toBe('false');
    // The preset is fixed, so what it means must be legible where it is chosen.
    expect(screen.getByText('Mon–Fri, 8:00–14:00')).toBeTruthy();
  });

  it('clicking Working hours sets the preset through the handler', () => {
    const onSet = renderDetail(task({ id: 'a', title: 'Alpha' }));
    fireEvent.click(option('Working hours'));
    expect(onSet).toHaveBeenCalledWith('a', 'working_hours');
  });

  it('clicking Anytime clears back to null — the only way to un-gate', () => {
    const onSet = renderDetail(task({ id: 'a', title: 'Alpha', availabilityWindow: 'weekend' }));
    fireEvent.click(option('Anytime'));
    expect(onSet).toHaveBeenCalledWith('a', null);
  });
});

describe('the live window status beside the picker (0070 catch-up)', () => {
  // happy-dom's dialog shim, same as the sibling describe above — this block is separate so
  // it needs its own copy (that block's beforeEach/afterEach do not reach here).
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
    // Fake timers so localDay()/localTime() answer a chosen instant, exactly as the row
    // marker's own spec does — the status line reads the same wall clock the same way.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('reads "available now" at 13:59, just inside working hours', () => {
    vi.setSystemTime(new Date('2026-07-22T13:59:00.000Z')); // Wednesday — a workday
    renderDetail(task({ id: 'a', title: 'Alpha', availabilityWindow: 'working_hours' }));
    expect(screen.getByText('available now')).toBeTruthy();
    expect(screen.queryByText('outside hours right now')).toBeNull();
  });

  it('reads "outside hours right now" at 14:00 — the end-exclusive boundary', () => {
    vi.setSystemTime(new Date('2026-07-22T14:00:00.000Z')); // same Wednesday, one minute later
    renderDetail(task({ id: 'a', title: 'Alpha', availabilityWindow: 'working_hours' }));
    expect(screen.getByText('outside hours right now')).toBeTruthy();
    expect(screen.queryByText('available now')).toBeNull();
  });

  it('is absent for a windowless task (Anytime) — nothing to report', () => {
    vi.setSystemTime(new Date('2026-07-22T13:59:00.000Z'));
    renderDetail(task({ id: 'a', title: 'Alpha' })); // availabilityWindow: null
    expect(screen.queryByText('available now')).toBeNull();
    expect(screen.queryByText('outside hours right now')).toBeNull();
  });
});
