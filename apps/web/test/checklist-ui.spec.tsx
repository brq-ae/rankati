// @vitest-environment happy-dom
import type { ChecklistItem, Task } from '@rankati/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskDetail from '../src/TaskDetail';

/**
 * The Checklist section in TaskDetail (ADR 0071) — soft readiness, never a gate. The three
 * handlers (add/update/delete) are mocked here, the same harness shape as the dependency-picker
 * and availability-picker specs: TaskDetail is rendered directly, and the assertion is on WHAT
 * gets called, not on any network layer.
 */
const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal', dependsOn: [],
  locationIds: [], needsHand: false, checklist: [], effort: null, needsDetails: false, impact: 'none', ...over,
});

const item = (over: Partial<ChecklistItem> & { id: string; text: string; position: number }): ChecklistItem => ({
  taskId: 'cur',
  done: false,
  createdAt: '2026-07-16T12:00:00.000Z',
  ...over,
});

const noop = vi.fn();

function renderDetail(
  t: Task,
  handlers: {
    onAddChecklistItem?: ReturnType<typeof vi.fn>;
    onUpdateChecklistItem?: ReturnType<typeof vi.fn>;
    onDeleteChecklistItem?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onAddChecklistItem = handlers.onAddChecklistItem ?? vi.fn();
  const onUpdateChecklistItem = handlers.onUpdateChecklistItem ?? vi.fn();
  const onDeleteChecklistItem = handlers.onDeleteChecklistItem ?? vi.fn();
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
      onSetNeedsHand={noop}
      onSetDependsOn={noop}
      onCreateRequired={noop}
      onAddChecklistItem={onAddChecklistItem}
      onUpdateChecklistItem={onUpdateChecklistItem}
      onDeleteChecklistItem={onDeleteChecklistItem}
      locations={[]}
      onSetLocations={noop}
      onCreateAndTagLocation={noop}
      error={null}
    />,
  );
  return { onAddChecklistItem, onUpdateChecklistItem, onDeleteChecklistItem };
}

// Deliberately NOT inserted in position order, so "renders in position order" is a real assertion.
const SECOND = item({ id: 'i2', text: 'Second', position: 1, done: true });
const FIRST = item({ id: 'i1', text: 'First', position: 0, done: false });
const THIRD = item({ id: 'i3', text: 'Third', position: 2, done: false });

const CUR = task({ id: 'cur', title: 'Current', checklist: [SECOND, FIRST, THIRD] });

const heading = () => screen.getByText(/\d+ of \d+ done/);
const checkboxFor = (text: string) => screen.getByRole('checkbox', { name: new RegExp(`"${text}"`) });
const textboxFor = (text: string) => screen.getByLabelText(`Checklist item: ${text}`);
// Items are display-by-default now (ADR 0095); ✎ enters edit and reveals the input.
const editFor = (text: string) => screen.getByRole('button', { name: `Edit ${text}` });
const removeFor = (text: string) => screen.getByRole('button', { name: `Remove "${text}"` });
const upFor = (text: string) => screen.getByRole('button', { name: `Move "${text}" up` });
const downFor = (text: string) => screen.getByRole('button', { name: `Move "${text}" down` });
const addInput = () => screen.getByLabelText('Add a checklist item');
const addButton = () => screen.getByRole('button', { name: 'Add checklist item' });

describe('Checklist section (ADR 0071)', () => {
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

  it('renders items in POSITION order (not array order), with an "N of M done" count', () => {
    renderDetail(CUR);
    const rows = screen.getAllByRole('listitem');
    const texts = rows.map((r) => within(r).getByRole('checkbox').getAttribute('aria-label'));
    expect(texts).toEqual([
      'Mark "First" done',
      'Mark "Second" not done',
      'Mark "Third" done',
    ]);
    expect(heading().textContent).toBe('1 of 3 done');
  });

  it('ticking an undone item sends {done: true}; unticking a done item sends {done: false}', () => {
    const { onUpdateChecklistItem } = renderDetail(CUR);
    fireEvent.click(checkboxFor('First')); // undone -> tick
    expect(onUpdateChecklistItem).toHaveBeenCalledWith('cur', 'i1', { done: true });
    fireEvent.click(checkboxFor('Second')); // done -> untick
    expect(onUpdateChecklistItem).toHaveBeenCalledWith('cur', 'i2', { done: false });
  });

  it('add posts trimmed text and clears the box; rejects empty/whitespace', () => {
    const { onAddChecklistItem } = renderDetail(CUR);
    // Whitespace-only: the Add button stays disabled, and nothing is sent.
    fireEvent.change(addInput(), { target: { value: '   ' } });
    expect(addButton()).toHaveProperty('disabled', true);
    fireEvent.click(addButton());
    expect(onAddChecklistItem).not.toHaveBeenCalled();

    fireEvent.change(addInput(), { target: { value: '  Buy milk  ' } });
    fireEvent.click(addButton());
    expect(onAddChecklistItem).toHaveBeenCalledWith('cur', 'Buy milk'); // trimmed
    expect(addInput()).toHaveProperty('value', ''); // cleared after add
  });

  it('add also commits on Enter', () => {
    const { onAddChecklistItem } = renderDetail(CUR);
    fireEvent.change(addInput(), { target: { value: 'Call the plumber' } });
    fireEvent.keyDown(addInput(), { key: 'Enter' });
    expect(onAddChecklistItem).toHaveBeenCalledWith('cur', 'Call the plumber');
  });

  it('rename commits on blur', () => {
    // The input's accessible name is bound to the item's STORED text, not the live draft — it
    // does not relabel itself mid-edit — so the lookup stays keyed on the original text throughout.
    const { onUpdateChecklistItem } = renderDetail(CUR);
    fireEvent.click(editFor('First')); // ✎ → enter edit
    fireEvent.change(textboxFor('First'), { target: { value: 'Renamed' } });
    fireEvent.blur(textboxFor('First'));
    expect(onUpdateChecklistItem).toHaveBeenCalledWith('cur', 'i1', { text: 'Renamed' });
  });

  it('rename commits on Enter', () => {
    const { onUpdateChecklistItem } = renderDetail(CUR);
    fireEvent.click(editFor('Third')); // ✎ → enter edit
    fireEvent.change(textboxFor('Third'), { target: { value: 'Renamed third' } });
    fireEvent.keyDown(textboxFor('Third'), { key: 'Enter' });
    expect(onUpdateChecklistItem).toHaveBeenCalledWith('cur', 'i3', { text: 'Renamed third' });
  });

  it('Escape cancels the draft — exits edit back to display, no call made', () => {
    const { onUpdateChecklistItem } = renderDetail(CUR);
    fireEvent.click(editFor('First')); // ✎ → enter edit
    fireEvent.change(textboxFor('First'), { target: { value: 'Discard me' } });
    fireEvent.keyDown(textboxFor('First'), { key: 'Escape' });
    expect(screen.queryByLabelText('Checklist item: First')).toBeNull(); // edit exited → back to display
    expect(editFor('First')).toBeTruthy(); // ✎ is back
    expect(onUpdateChecklistItem).not.toHaveBeenCalled(); // draft discarded, nothing sent
  });

  it('a URL in an item is a clickable link in display mode; ✎ still edits an all-link item (ADR 0095)', () => {
    const linkItem = item({ id: 'lk', text: 'https://rankati.com/x', position: 3, done: false });
    const { onUpdateChecklistItem } = renderDetail(task({ id: 'cur', title: 'Current', checklist: [linkItem] }));
    // Display: the whole item is a real anchor (new-tab, noopener).
    const a = screen.getByRole('link', { name: 'https://rankati.com/x' });
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    // The all-link case still edits via ✎ (the reason we chose an explicit affordance over tap-to-edit).
    fireEvent.click(editFor('https://rankati.com/x'));
    fireEvent.change(textboxFor('https://rankati.com/x'), { target: { value: 'https://rankati.com/y' } });
    fireEvent.blur(textboxFor('https://rankati.com/x'));
    expect(onUpdateChecklistItem).toHaveBeenCalledWith('cur', 'lk', { text: 'https://rankati.com/y' });
  });

  it('remove calls delete with the task and item id', () => {
    const { onDeleteChecklistItem } = renderDetail(CUR);
    fireEvent.click(removeFor('Second'));
    expect(onDeleteChecklistItem).toHaveBeenCalledWith('cur', 'i2');
  });

  it('▲/▼ swap the two items’ positions via two PATCHes', () => {
    const { onUpdateChecklistItem } = renderDetail(CUR);
    fireEvent.click(downFor('First')); // First (pos 0) <-> Second (pos 1)
    expect(onUpdateChecklistItem).toHaveBeenNthCalledWith(1, 'cur', 'i1', { position: 1 });
    expect(onUpdateChecklistItem).toHaveBeenNthCalledWith(2, 'cur', 'i2', { position: 0 });
  });

  it('▲ is disabled on the first item, ▼ disabled on the last — the ends of the order', () => {
    renderDetail(CUR);
    expect(upFor('First')).toHaveProperty('disabled', true);
    expect(downFor('First')).toHaveProperty('disabled', false);
    expect(upFor('Third')).toHaveProperty('disabled', false);
    expect(downFor('Third')).toHaveProperty('disabled', true);
  });

  it('shows "Nothing yet." and 0 of 0 done for an empty checklist', () => {
    renderDetail(task({ id: 'x', title: 'Empty', checklist: [] }));
    expect(screen.getByText('Nothing yet.')).toBeTruthy();
    expect(heading().textContent).toBe('0 of 0 done');
  });
});
