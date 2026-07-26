// @vitest-environment happy-dom
import type { Task } from '@rankati/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskDetail from '../src/TaskDetail';

/**
 * The modal "needs details" flag icon (ADR 0073) — the manual "revisit later" toggle beside the
 * "Task" header. Filled 🚩 = flagged, outline ⚐ = not; tapping calls onSetNeedsDetails with the
 * toggled value. (The set-on-create / clear-on-edit lifecycle is server-side and proven there; this
 * is only the manual control's wiring and state reflection.)
 */
const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, impact: 'none', checklist: [], effort: null, ...over,
});

const noop = vi.fn();
function renderDetail(t: Task, onSetNeedsDetails = vi.fn()) {
  render(
    <TaskDetail
      task={t}
      addListId={null}
      onCreateInList={noop}
      onSetNeedsDetails={onSetNeedsDetails}
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
  return onSetNeedsDetails;
}

describe('the needs-details flag icon (ADR 0073)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
  });
  afterEach(cleanup);

  it('reflects unflagged state — outline, not pressed — and tapping SETS the flag', async () => {
    const onSet = renderDetail(task({ id: 'a', title: 'Alpha', needsDetails: false }));
    const flag = screen.getByRole('button', { name: 'Flag as needs details' });
    expect(flag.getAttribute('aria-pressed')).toBe('false');
    expect(flag.textContent).toBe('⚐'); // outline
    fireEvent.click(flag);
    expect(onSet).toHaveBeenCalledWith('a', true);
  });

  it('reflects flagged state — filled, pressed — and tapping CLEARS the flag', async () => {
    const onSet = renderDetail(task({ id: 'a', title: 'Alpha', needsDetails: true }));
    const flag = screen.getByRole('button', { name: 'Needs details — tap to clear' });
    expect(flag.getAttribute('aria-pressed')).toBe('true');
    expect(flag.textContent).toBe('🚩'); // filled
    fireEvent.click(flag);
    expect(onSet).toHaveBeenCalledWith('a', false);
  });

  it('add mode shows no flag icon (nothing to flag yet) — only the title', async () => {
    render(
      <TaskDetail
        task={null}
        addListId="l1"
        onCreateInList={noop}
        onSetNeedsDetails={noop}
        tasks={[]}
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
    expect(screen.getByLabelText('New task title')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /needs details/i })).toBeNull();
  });

  it('add mode: first non-empty title creates in the list; empty does not', async () => {
    const onCreate = vi.fn();
    const render1 = (): void => {
      render(
        <TaskDetail
          task={null}
          addListId="l2"
          onCreateInList={onCreate}
          onSetNeedsDetails={noop}
          tasks={[]}
          lists={[{ id: 'l2', name: 'Home', ownerId: 'local' }]}
          onClose={noop}
          onRename={noop}
          onSetList={noop}
          onSetNotBefore={noop}
          onSetDue={noop}
          onSetTier={noop}
          onSetAvailabilityWindow={noop}
          onSetEffort={noop}
      onSetImpact={noop}
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
    };
    render1();
    const title = screen.getByLabelText('New task title');
    // Empty Enter → nothing.
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(onCreate).not.toHaveBeenCalled();
    // A title → create in the given list.
    fireEvent.change(title, { target: { value: 'Wash car' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith('Wash car', 'l2');
    // Guarded against a double-create (the Enter's following blur must not fire a second POST).
    fireEvent.blur(title);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
