// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsModal from '../src/SettingsModal';

/**
 * The effort thresholds editor in Settings (ADR 0072). DISPLAY ONLY: the two minute values shape
 * what "Quick" / "Medium" / "Long" mean to the owner, but only the ordinal bucket is ever ranked
 * on — minutes never leave the client. The load-bearing checks: a valid edit commits through the
 * handler (App persists it), and an INCOHERENT pair (quick ≥ medium — a Medium that cannot exist)
 * is REFUSED by snapping back, never written. The refusal is the guard this slice's bite-test hits.
 */
const noop = vi.fn();
function renderSettings(onSetThresholds = vi.fn(), thresholds = { quickMax: 15, mediumMax: 60 }) {
  render(
    <SettingsModal
      theme="brand"
      mode="light"
      onSelectTheme={noop}
      thresholds={thresholds}
      onSetThresholds={onSetThresholds}
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
    />,
  );
  return onSetThresholds;
}

const quickInput = () => screen.getByLabelText('Quick block, up to how many minutes') as HTMLInputElement;
const mediumInput = () => screen.getByLabelText('Medium block, up to how many minutes') as HTMLInputElement;

describe('Settings effort thresholds (ADR 0072)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
  });
  afterEach(cleanup);

  it('renders the current thresholds', () => {
    renderSettings(vi.fn(), { quickMax: 10, mediumMax: 45 });
    expect(quickInput().value).toBe('10');
    expect(mediumInput().value).toBe('45');
  });

  it('a valid edit commits through the handler on blur (App then persists)', () => {
    const onSet = renderSettings();
    fireEvent.change(quickInput(), { target: { value: '20' } });
    fireEvent.blur(quickInput());
    expect(onSet).toHaveBeenCalledWith({ quickMax: 20, mediumMax: 60 });
  });

  it('an INCOHERENT pair (quick ≥ medium) is REFUSED — snaps back, never written', () => {
    const onSet = renderSettings();
    fireEvent.change(quickInput(), { target: { value: '90' } }); // 90 ≥ 60
    fireEvent.blur(quickInput());
    expect(onSet).not.toHaveBeenCalled();
    expect(quickInput().value).toBe('15'); // snapped back to the stored value
  });

  it('a non-positive value is REFUSED the same way', () => {
    const onSet = renderSettings();
    fireEvent.change(mediumInput(), { target: { value: '0' } });
    fireEvent.blur(mediumInput());
    expect(onSet).not.toHaveBeenCalled();
    expect(mediumInput().value).toBe('60');
  });
});
