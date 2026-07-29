// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import RoutineForm from '../src/RoutineForm';

/**
 * Native <select> theming (ADR 0087, Part C). RoutineForm's selects were the reported white-popup case:
 * they used the translucent `bg-field-bg` instead of the opaque select token `bg-control-bg` that
 * THEMES.md mandates. This is the DOM guard — every <select> in the form carries `bg-control-bg` and none
 * carries `bg-field-bg`, while the text <input>s keep `bg-field-bg` (they must NOT have been swept up).
 */
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(cleanup);

describe('RoutineForm native <select> theming (Part C)', () => {
  it('every select uses the opaque control token; none uses field-bg', () => {
    render(<RoutineForm routine={null} on="2026-03-20" onSubmit={() => {}} onCancel={() => {}} />);
    // Reveal the fixed-rule selects too, so all select variants are exercised.
    fireEvent.change(screen.getByLabelText('Routine type'), { target: { value: 'interval_fixed' } });

    const selects = Array.from(document.querySelectorAll('select'));
    expect(selects.length).toBeGreaterThanOrEqual(3);
    for (const s of selects) {
      expect(s.className).toContain('bg-control-bg');
      expect(s.className).not.toContain('bg-field-bg');
    }
  });

  it('text inputs keep field-bg (the token swap did not touch inputs)', () => {
    render(<RoutineForm routine={null} on="2026-03-20" onSubmit={() => {}} onCancel={() => {}} />);
    const name = screen.getByLabelText('Routine name');
    expect(name.className).toContain('bg-field-bg');
    expect(name.className).not.toContain('bg-control-bg');
  });
});
