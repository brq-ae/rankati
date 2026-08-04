// @vitest-environment happy-dom
import type { Task } from '@rankati/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskDetail from '../src/TaskDetail';

/**
 * The "Requires" picker's aria-activedescendant combobox keyboard nav (v0.18): ↓/↑ move the
 * highlight (exposed to assistive tech via aria-activedescendant), Enter selects the highlighted
 * match. The existing type-to-search and create-inline are untouched.
 */
const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal', dependsOn: [],
  locationIds: [], needsHand: false, checklist: [], effort: null, needsDetails: false, impact: 'none', ...over,
});

const CUR = task({ id: 'cur', title: 'Current' });
const T1 = task({ id: 't1', title: 'Alpha task' });
const T2 = task({ id: 't2', title: 'Beta task' });
const T3 = task({ id: 't3', title: 'Gamma task' });

const noop = vi.fn();
function renderDetail(onSetDependsOn = vi.fn()) {
  render(
    <TaskDetail
      task={CUR}
      tasks={[CUR, T1, T2, T3]}
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
      onSetNeedsHand={noop}
      onSetDependsOn={onSetDependsOn}
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
  return onSetDependsOn;
}

const combobox = () =>
  screen.getByRole('combobox', { name: 'Add something this requires' }) as HTMLInputElement;
const activeDesc = () => combobox().getAttribute('aria-activedescendant');

describe('Requires picker — combobox keyboard nav (v0.18)', () => {
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

  it('↓/↑ move aria-activedescendant across role=option matches; Enter selects the highlighted one', () => {
    const onSetDependsOn = renderDetail();
    fireEvent.focus(combobox()); // browse-first (0089): focus opens the menu
    fireEvent.change(combobox(), { target: { value: 'task' } }); // matches Alpha/Beta/Gamma task

    // Three real options in the picker's listbox, exposed to assistive tech.
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.id)).toEqual(['req-opt-t1', 'req-opt-t2', 'req-opt-t3']);

    // Highlight starts on the first match…
    expect(activeDesc()).toBe('req-opt-t1');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(combobox(), { key: 'ArrowDown' }); // → second
    expect(activeDesc()).toBe('req-opt-t2');
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' }); // → third
    expect(activeDesc()).toBe('req-opt-t3');
    fireEvent.keyDown(combobox(), { key: 'ArrowUp' }); // ← back to second
    expect(activeDesc()).toBe('req-opt-t2');

    // Enter selects the HIGHLIGHTED match (Beta task), not the first typed or last.
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(onSetDependsOn).toHaveBeenCalledWith('cur', ['t2']);
  });

  it('↓ clamps at the last option; Enter on the first selects it', () => {
    const onSetDependsOn = renderDetail();
    fireEvent.focus(combobox()); // browse-first (0089): focus opens the menu
    fireEvent.change(combobox(), { target: { value: 'task' } });
    // Down past the end stays on the last.
    for (let i = 0; i < 5; i++) fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    expect(activeDesc()).toBe('req-opt-t3');
    // Back to top and select the first.
    for (let i = 0; i < 5; i++) fireEvent.keyDown(combobox(), { key: 'ArrowUp' });
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(onSetDependsOn).toHaveBeenCalledWith('cur', ['t1']);
  });
});
