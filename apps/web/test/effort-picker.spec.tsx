// @vitest-environment happy-dom
import type { Task } from '@rankati/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskDetail from '../src/TaskDetail';

/**
 * The effort selector (ADR 0072): Untagged (null, the default) + the three ordinal buckets. NOT a
 * gate — it never hides or moves the task, it only sinks it in the Today hand when a smaller block
 * is set. Edited through the same App-handler pattern as every other field; the chosen bucket's
 * minute range comes from the client thresholds, the same labels the Today block picker shows.
 */
const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, checklist: [], effort: null, needsDetails: false, impact: 'none', ...over,
});

const noop = vi.fn();
function renderDetail(t: Task, onSetEffort = vi.fn()) {
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
      onSetEffort={onSetEffort}
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
  return onSetEffort;
}

const picker = () => screen.getByRole('group', { name: 'Effort bucket' });
const option = (label: string) => within(picker()).getByRole('button', { name: `Set effort: ${label}` });

describe('Effort selector (ADR 0072)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
  });
  afterEach(cleanup);

  it('renders Untagged + three buckets, Untagged selected for an untagged task', () => {
    renderDetail(task({ id: 'a', title: 'Alpha' })); // effort: null
    const buttons = within(picker()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Untagged', 'quick', 'medium', 'long']);
    // null = Untagged is the DEFAULT selection, not an unselected state.
    expect(option('Untagged').getAttribute('aria-pressed')).toBe('true');
    expect(option('Quick: up to 15 min').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the current bucket selected, labelled from the client thresholds', () => {
    renderDetail(task({ id: 'a', title: 'Alpha', effort: 'medium' }));
    expect(option('Medium: up to 60 min').getAttribute('aria-pressed')).toBe('true');
    expect(option('Untagged').getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking a bucket SETS it through the handler (persists)', () => {
    const onSet = renderDetail(task({ id: 'a', title: 'Alpha' }));
    fireEvent.click(option('Quick: up to 15 min'));
    expect(onSet).toHaveBeenCalledWith('a', 'quick');
  });

  it('clicking Untagged CLEARS it back to null — the only way to un-tag', () => {
    const onSet = renderDetail(task({ id: 'a', title: 'Alpha', effort: 'long' }));
    fireEvent.click(option('Untagged'));
    expect(onSet).toHaveBeenCalledWith('a', null);
  });
});
