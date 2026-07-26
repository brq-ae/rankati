// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConfirmDestructive from '../src/ConfirmDestructive';

/**
 * ConfirmDestructive (ADR 0064) — the one confirmation both reset modes and list-delete depend on.
 * The typed-DELETE match is the last thing between a misclick and everything gone, so the near-miss
 * edges are tested explicitly: it must be EXACTLY "DELETE" — case-sensitive, no trimming.
 */
afterEach(cleanup);

function setup(props: Partial<React.ComponentProps<typeof ConfirmDestructive>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const confirmLabel = props.confirmLabel ?? 'Delete list';
  render(
    <ConfirmDestructive
      title="Delete list"
      confirmLabel={confirmLabel}
      requireTyped
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    >
      This deletes 12 tasks.
    </ConfirmDestructive>,
  );
  const confirmBtn = screen.getByRole('button', { name: confirmLabel }) as HTMLButtonElement;
  const type = (value: string) =>
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value } });
  return { onConfirm, onCancel, confirmBtn, type };
}

describe('ConfirmDestructive — typed match', () => {
  it('renders the blast radius it is handed', () => {
    setup();
    expect(screen.queryByText('This deletes 12 tasks.')).not.toBeNull();
  });

  it('is disabled before anything is typed', () => {
    const { confirmBtn } = setup();
    expect(confirmBtn.disabled).toBe(true);
  });

  // The near-misses — every one must leave the button DISABLED. A confirmation that accepts "delete"
  // is measurably weaker friction than one that does not.
  it.each([
    ['empty', ''],
    ['lowercase', 'delete'],
    ['title case', 'Delete'],
    ['partial', 'DELET'],
    ['trailing space', 'DELETE '],
    ['leading space', ' DELETE'],
    ['both spaces', ' DELETE '],
    ['extra char', 'DELETEE'],
  ])('near-miss %s (%j) does NOT enable confirm', (_label, value) => {
    const { confirmBtn, type, onConfirm } = setup();
    type(value);
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.click(confirmBtn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('exactly "DELETE" enables confirm, and clicking fires onConfirm once', () => {
    const { confirmBtn, type, onConfirm } = setup();
    type('DELETE');
    expect(confirmBtn.disabled).toBe(false);
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('is live: a correct value then a stray space disables it again', () => {
    const { confirmBtn, type } = setup();
    type('DELETE');
    expect(confirmBtn.disabled).toBe(false);
    type('DELETE ');
    expect(confirmBtn.disabled).toBe(true);
  });
});

describe('ConfirmDestructive — plain (requireTyped: false)', () => {
  it('shows no typed input and enables confirm immediately', () => {
    const { confirmBtn, onConfirm } = setup({ requireTyped: false, confirmLabel: 'Clear tasks' });
    expect(screen.queryByLabelText('Type DELETE to confirm')).toBeNull();
    expect(confirmBtn.disabled).toBe(false);
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('ConfirmDestructive — cancel paths', () => {
  it('Cancel closes and calls onCancel, not onConfirm', () => {
    const { onCancel, onConfirm } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
