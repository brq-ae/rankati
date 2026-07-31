// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ComponentProps } from 'react';
import SettingsModal from '../src/SettingsModal';

/**
 * The Settings accordion (v0.35.0) — a pure re-layout into six collapsible <details> rows. Guards the
 * three invariants recorded in the component's JSDoc: (a) every row collapsed on open, (b) Reset is the
 * last row and red, (c) the Locations row force-opens whenever the App-level `error` is set.
 */
const openDialog = () => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
};
const noop = vi.fn();
const ROWS = ['Appearance', 'Today & pins', 'Locations', 'Telegram', 'Account', 'Reset'];

function renderModal(over: Partial<ComponentProps<typeof SettingsModal>> = {}) {
  render(
    <SettingsModal
      theme="brand"
      mode="light"
      onSelectTheme={noop}
      thresholds={{ quickMax: 15, mediumMax: 60 }}
      onSetThresholds={noop}
      handSize={5}
      onSetHandSize={noop}
      pinDays={{ highFuseDays: 7, mediumFuseDays: 30, highSnoozeDays: 1, mediumSnoozeDays: 3 }}
      onSetPinDays={noop}
      locations={[]}
      error={null}
      onClose={noop}
      onCreate={noop}
      onRename={noop}
      onDelete={noop}
      onMerge={noop}
      onClearTasks={noop}
      onFactoryReset={noop}
      onLogout={noop}
      {...over}
    />,
  );
}
const summarySpan = (name: string) => screen.getByText(name, { selector: 'summary span' });
const detailsOf = (name: string) => summarySpan(name).closest('details') as HTMLDetailsElement;

describe('the Settings accordion (v0.35.0)', () => {
  beforeEach(openDialog);
  afterEach(cleanup);

  it('(a) shows the six rows, in order, all collapsed on open', () => {
    renderModal();
    const titles = Array.from(document.querySelectorAll('details > summary > span:first-child')).map(
      (s) => s.textContent,
    );
    expect(titles).toEqual(ROWS);
    for (const r of ROWS) expect(detailsOf(r).open).toBe(false);
  });

  it('a row toggles open when its summary is clicked', () => {
    renderModal();
    const d = detailsOf('Today & pins');
    expect(d.open).toBe(false);
    fireEvent.click(d.querySelector('summary') as HTMLElement);
    expect(d.open).toBe(true);
  });

  it('(b) Reset is the LAST row and its summary is red', () => {
    renderModal();
    const all = Array.from(document.querySelectorAll('details'));
    const last = all[all.length - 1];
    expect(last.querySelector('summary span')?.textContent).toBe('Reset');
    expect(last.querySelector('summary span')?.className).toContain('text-danger');
  });

  it('(c) the Locations row force-opens when an error is set — the banner is never hidden', () => {
    renderModal({ error: 'A location with that name already exists.' });
    expect(detailsOf('Locations').open).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('already exists');
    expect(detailsOf('Appearance').open).toBe(false); // others stay collapsed
  });
});
