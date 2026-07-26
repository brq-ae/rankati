// @vitest-environment happy-dom
import type { Task } from '@rankati/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskDetail from '../src/TaskDetail';

/**
 * The "Needs a hand" toggle in TaskDetail (ADR 0071) — a soft label, not a gate. Same harness
 * shape as availability-picker.spec.tsx: TaskDetail is rendered directly and the assertion is
 * on WHAT gets called, not on any network layer.
 */
const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal', dependsOn: [],
  locationIds: [], needsHand: false, checklist: [], effort: null, needsDetails: false, impact: 'none', ...over,
});

const noop = vi.fn();
function renderDetail(t: Task, onSetNeedsHand = vi.fn()) {
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
      onSetAvailabilityWindow={noop}
      onSetEffort={noop}
      onSetImpact={noop}
      addListId={null}
      onCreateInList={noop}
      onSetNeedsDetails={noop}
      thresholds={{ quickMax: 15, mediumMax: 60 }}
      onSetNeedsHand={onSetNeedsHand}
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
  return onSetNeedsHand;
}

const toggle = () => screen.getByRole('button', { name: /Needs a hand/i });

describe('Needs a hand toggle (ADR 0071)', () => {
  beforeEach(() => {
    // happy-dom has no real modal layer; make showModal actually OPEN the dialog (set `open`) so
    // its content is accessible — the same stub the other TaskDetail specs use.
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
  });
  afterEach(cleanup);

  it('reflects an unflagged task as not pressed', () => {
    renderDetail(task({ id: 'a', title: 'Alpha', needsHand: false }));
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('reflects a flagged task as pressed', () => {
    renderDetail(task({ id: 'a', title: 'Alpha', needsHand: true }));
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking an unflagged task calls the handler with true', () => {
    const onSetNeedsHand = renderDetail(task({ id: 'a', title: 'Alpha', needsHand: false }));
    fireEvent.click(toggle());
    expect(onSetNeedsHand).toHaveBeenCalledWith('a', true);
  });

  it('clicking a flagged task calls the handler with false — it inverts, not just sets true', () => {
    const onSetNeedsHand = renderDetail(task({ id: 'a', title: 'Alpha', needsHand: true }));
    fireEvent.click(toggle());
    expect(onSetNeedsHand).toHaveBeenCalledWith('a', false);
  });

  it('shows the muted subtext explaining the label never hides the task', () => {
    renderDetail(task({ id: 'a', title: 'Alpha' }));
    expect(
      screen.getByText('involves or waits on a person — never hides the task'),
    ).toBeTruthy();
  });
});
