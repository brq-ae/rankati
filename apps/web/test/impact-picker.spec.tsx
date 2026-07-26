// @vitest-environment happy-dom
import type { Task } from '@rankati/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskDetail from '../src/TaskDetail';

/**
 * The Impact control (ADR 0075) in the task detail modal — the segmented picker that DECLARES the
 * level (None/Medium/High), mirroring the Effort/Tier pickers. It drives only the safety-net pin,
 * never ranking; here we prove the control reflects the current level and sets the new one.
 */
const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, checklist: [], effort: null,
  impact: 'none', ...over,
});

const noop = vi.fn();
function renderDetail(t: Task, onSetImpact = vi.fn()) {
  render(
    <TaskDetail
      task={t}
      addListId={null}
      onCreateInList={noop}
      onSetNeedsDetails={noop}
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
      thresholds={{ quickMax: 15, mediumMax: 60 }}
      onSetImpact={onSetImpact}
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
  return onSetImpact;
}

const picker = () => screen.getByRole('group', { name: 'Impact level' });
const option = (label: string) => within(picker()).getByRole('button', { name: `Set impact: ${label}` });

describe('Impact control (ADR 0075)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
  });
  afterEach(cleanup);

  it('renders None / Medium / High, with None selected for an unset task', () => {
    renderDetail(task({ id: 'a', title: 'Alpha' })); // impact: 'none'
    expect(within(picker()).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'None',
      'Medium',
      'High',
    ]);
    expect(option('None').getAttribute('aria-pressed')).toBe('true');
    expect(option('High').getAttribute('aria-pressed')).toBe('false');
  });

  it('reflects the current level — High selected for a high-impact task', () => {
    renderDetail(task({ id: 'a', title: 'Alpha', impact: 'high' }));
    expect(option('High').getAttribute('aria-pressed')).toBe('true');
    expect(option('None').getAttribute('aria-pressed')).toBe('false');
  });

  it('selecting Medium sets it through the handler', () => {
    const onSet = renderDetail(task({ id: 'a', title: 'Alpha' }));
    fireEvent.click(option('Medium'));
    expect(onSet).toHaveBeenCalledWith('a', 'medium');
  });

  it('selecting High sets it through the handler', () => {
    const onSet = renderDetail(task({ id: 'a', title: 'Alpha' }));
    fireEvent.click(option('High'));
    expect(onSet).toHaveBeenCalledWith('a', 'high');
  });

  it('selecting None sets it back to none', () => {
    const onSet = renderDetail(task({ id: 'a', title: 'Alpha', impact: 'high' }));
    fireEvent.click(option('None'));
    expect(onSet).toHaveBeenCalledWith('a', 'none');
  });
});
