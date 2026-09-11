// @vitest-environment happy-dom
import type { Task } from '@rankati/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskDetail from '../src/TaskDetail';

/**
 * The Venue field + G-Maps/Waze buttons (ADR 0096, meetings epic Build 2). Venue is a per-task PLACE,
 * DISTINCT from context-Location (0060). The owner pastes a Google-Maps link; after save the task shows
 * G-Maps (opens the saved url verbatim — NO server call) and Waze (server-resolved coords, else a name
 * search, else hidden). These tests pin the button wiring against the SAVED task state and the paste→save
 * edit flow — the SSRF resolve is server-side (unit-tested in the api) and never touched here.
 */
const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, checklist: [], effort: null, needsDetails: false,
  impact: 'none', notes: null, venueUrl: null, venueLat: null, venueLng: null, venueName: null, ...over,
});

const noop = vi.fn();
function renderDetail(t: Task, onSetVenue = vi.fn()) {
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
      onAddChecklistItem={noop}
      onUpdateChecklistItem={noop}
      onDeleteChecklistItem={noop}
      onSetNotes={noop}
      onSetVenue={onSetVenue}
      locations={[]}
      onSetLocations={noop}
      onCreateAndTagLocation={noop}
      error={null}
    />,
  );
  return onSetVenue;
}

const gmaps = () => screen.queryByRole('link', { name: 'Open in Google Maps' });
const waze = () => screen.queryByRole('link', { name: 'Navigate in Waze' });

describe('Venue field + buttons (ADR 0096)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
  });
  afterEach(cleanup);

  it('with no venue, shows neither button and prompts to paste a link', () => {
    renderDetail(task({ id: 'a', title: 'Alpha' }));
    expect(gmaps()).toBeNull();
    expect(waze()).toBeNull();
    expect(screen.getByText('Paste a Google Maps link…')).toBeTruthy();
  });

  it('G-Maps opens the saved url verbatim, safely, in a new tab', () => {
    const url = 'https://maps.app.goo.gl/abc123';
    renderDetail(task({ id: 'a', title: 'Alpha', venueUrl: url }));
    const link = gmaps() as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe(url); // verbatim — no server round-trip
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('Waze uses coords (?ll&navigate) when the server resolved them', () => {
    renderDetail(task({ id: 'a', title: 'Alpha', venueUrl: 'https://maps.google.com/x', venueLat: 37.5, venueLng: -122.1 }));
    expect((waze() as HTMLAnchorElement).getAttribute('href')).toBe('https://waze.com/ul?ll=37.5,-122.1&navigate=yes');
  });

  it('Waze falls back to a name search (?q=) when there are no coords', () => {
    renderDetail(task({ id: 'a', title: 'Alpha', venueUrl: 'https://maps.google.com/x', venueName: 'Blue Bottle Café' }));
    expect((waze() as HTMLAnchorElement).getAttribute('href')).toBe('https://waze.com/ul?q=Blue%20Bottle%20Caf%C3%A9');
  });

  it('Waze is HIDDEN when there are neither coords nor a name (G-Maps still shows)', () => {
    renderDetail(task({ id: 'a', title: 'Alpha', venueUrl: 'https://maps.google.com/x' }));
    expect(gmaps()).not.toBeNull(); // G-Maps only needs the url
    expect(waze()).toBeNull(); // nothing to route to
  });

  it('pasting a link and blurring saves it via onSetVenue (trimmed)', () => {
    const onSetVenue = renderDetail(task({ id: 'a', title: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit venue' }));
    const input = screen.getByRole('textbox', { name: 'Venue' });
    fireEvent.change(input, { target: { value: '  https://maps.app.goo.gl/xyz  ' } });
    fireEvent.blur(input);
    expect(onSetVenue).toHaveBeenCalledWith('a', 'https://maps.app.goo.gl/xyz');
  });

  it('Enter commits the pasted link too', () => {
    const onSetVenue = renderDetail(task({ id: 'a', title: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit venue' }));
    const input = screen.getByRole('textbox', { name: 'Venue' });
    fireEvent.change(input, { target: { value: 'https://maps.google.com/@1,2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSetVenue).toHaveBeenCalledWith('a', 'https://maps.google.com/@1,2');
  });

  it('clearing the field to empty saves the clear (server → null incl. coords)', () => {
    const onSetVenue = renderDetail(task({ id: 'a', title: 'Alpha', venueUrl: 'https://maps.google.com/x', venueLat: 1, venueLng: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit venue' }));
    const input = screen.getByRole('textbox', { name: 'Venue' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onSetVenue).toHaveBeenCalledWith('a', '');
  });

  it('an unchanged blur does NOT re-save (avoids a needless server re-resolve)', () => {
    const url = 'https://maps.google.com/x';
    const onSetVenue = renderDetail(task({ id: 'a', title: 'Alpha', venueUrl: url }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit venue' }));
    const input = screen.getByRole('textbox', { name: 'Venue' });
    fireEvent.blur(input); // no edit
    expect(onSetVenue).not.toHaveBeenCalled();
  });
});
