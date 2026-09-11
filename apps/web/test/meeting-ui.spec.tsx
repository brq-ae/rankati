// @vitest-environment happy-dom
import type { MeetingOverlap, Task } from '@rankati/shared';
import { meetingSurfaced } from '@rankati/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskDetail from '../src/TaskDetail';

/**
 * Meeting UI (ADR 0097, Build 3 S3) — TaskDetail's meeting-time fields + the reminder-lead control + the
 * soft overlap banner. The server owns placement/firing (S1/S2); here we pin the wire: which keys each
 * control PATCHes through onSetMeeting, and that the banner reflects the returned overlaps[].
 */
const AT = '2026-09-20T14:00:00.000Z';
const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, checklist: [], effort: null, needsDetails: false,
  impact: 'none', notes: null, venueUrl: null, venueLat: null, venueLng: null, venueName: null,
  eventAt: null, durationMinutes: null, surfaceLeadDays: null, reminders: [], ...over,
});
const withMeeting = (over: Partial<Task> = {}): Task =>
  task({
    id: 'a', title: 'Sync', eventAt: AT, durationMinutes: 60,
    reminders: [{ id: 'r1', taskId: 'a', leadMinutes: 60, sentAt: null, createdAt: AT }],
    ...over,
  });

const noop = vi.fn();
function renderDetail(t: Task, onSetMeeting = vi.fn(async (): Promise<MeetingOverlap[]> => [])) {
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
      onSetVenue={noop}
      onSetMeeting={onSetMeeting}
      locations={[]}
      onSetLocations={noop}
      onCreateAndTagLocation={noop}
      error={null}
    />,
  );
  return onSetMeeting;
}

describe('Meeting UI (ADR 0097 S3)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
  });
  afterEach(cleanup);

  it('with no eventAt, only the meeting-time picker shows (no duration/reminder/surface)', () => {
    renderDetail(task({ id: 'a', title: 'Sync' }));
    expect(screen.getByLabelText('Meeting time')).toBeTruthy();
    expect(screen.queryByLabelText('Meeting duration')).toBeNull();
    expect(screen.queryByLabelText('Remind me on Telegram')).toBeNull();
    expect(screen.queryByLabelText('Surface in Today days before')).toBeNull();
  });

  it('setting the meeting time PATCHes eventAt as a UTC ISO instant', () => {
    const onSet = renderDetail(task({ id: 'a', title: 'Sync' }));
    const local = '2026-09-20T18:00';
    fireEvent.change(screen.getByLabelText('Meeting time'), { target: { value: local } });
    expect(onSet).toHaveBeenCalledWith('a', { eventAt: new Date(local).toISOString() });
  });

  it('clearing the meeting time PATCHes eventAt: null (server cascades)', () => {
    const onSet = renderDetail(withMeeting());
    fireEvent.change(screen.getByLabelText('Meeting time'), { target: { value: '' } });
    expect(onSet).toHaveBeenCalledWith('a', { eventAt: null });
  });

  it('when a meeting is set, one reminder row shows, defaulting to 1 hour', () => {
    renderDetail(withMeeting());
    expect((screen.getByLabelText('Remind me on Telegram') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Reminder 1 lead') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('Reminder 1 unit') as HTMLSelectElement).value).toBe('hours');
  });

  it('renders one row per reminder in the list', () => {
    renderDetail(
      withMeeting({
        reminders: [
          { id: 'r1', taskId: 'a', leadMinutes: 1440, sentAt: null, createdAt: AT },
          { id: 'r2', taskId: 'a', leadMinutes: 60, sentAt: null, createdAt: AT },
        ],
      }),
    );
    expect(screen.getByLabelText('Reminder 1 lead')).toBeTruthy();
    expect(screen.getByLabelText('Reminder 2 lead')).toBeTruthy();
    expect(screen.queryByLabelText('Reminder 3 lead')).toBeNull();
  });

  it('changing a row unit to days sends the FULL set as reminderLeadsMinutes', () => {
    const onSet = renderDetail(withMeeting({ reminders: [{ id: 'r1', taskId: 'a', leadMinutes: 120, sentAt: null, createdAt: AT }] }));
    // 120 min shows as 2 hours; switch to days → the set becomes [2 × 1440].
    fireEvent.change(screen.getByLabelText('Reminder 1 unit'), { target: { value: 'days' } });
    expect(onSet).toHaveBeenCalledWith('a', { reminderLeadsMinutes: [2 * 1440] });
  });

  it('"+ Add reminder" appends a distinct lead and sends the grown set', () => {
    const onSet = renderDetail(withMeeting()); // one 1h (60) reminder
    fireEvent.click(screen.getByLabelText('Add reminder'));
    // The next preset after 60 is 1440 (1 day) → set is [60, 1440].
    expect(onSet).toHaveBeenCalledWith('a', { reminderLeadsMinutes: [60, 1440] });
  });

  it('removing a row sends the reduced set', () => {
    const onSet = renderDetail(
      withMeeting({
        reminders: [
          { id: 'r1', taskId: 'a', leadMinutes: 1440, sentAt: null, createdAt: AT },
          { id: 'r2', taskId: 'a', leadMinutes: 60, sentAt: null, createdAt: AT },
        ],
      }),
    );
    fireEvent.click(screen.getByLabelText('Remove reminder 1')); // drop the 1-day row
    expect(onSet).toHaveBeenCalledWith('a', { reminderLeadsMinutes: [60] });
  });

  it('unchecking "Remind me" clears all reminders ([])', () => {
    const onSet = renderDetail(withMeeting());
    fireEvent.click(screen.getByLabelText('Remind me on Telegram'));
    expect(onSet).toHaveBeenCalledWith('a', { reminderLeadsMinutes: [] });
  });

  it('setting a duration PATCHes durationMinutes (capped ≤ 1440)', () => {
    const onSet = renderDetail(withMeeting({ durationMinutes: null }));
    fireEvent.change(screen.getByLabelText('Meeting duration'), { target: { value: '90' } });
    expect(onSet).toHaveBeenCalledWith('a', { durationMinutes: 90 });
  });

  it('setting the Today surface-lead PATCHes surfaceLeadDays', () => {
    const onSet = renderDetail(withMeeting());
    fireEvent.change(screen.getByLabelText('Surface in Today days before'), { target: { value: '2' } });
    expect(onSet).toHaveBeenCalledWith('a', { surfaceLeadDays: 2 });
  });

  it('blanking the surface-lead clears it back to day-of (null)', () => {
    const onSet = renderDetail(withMeeting({ surfaceLeadDays: 2 }));
    fireEvent.change(screen.getByLabelText('Surface in Today days before'), { target: { value: '' } });
    expect(onSet).toHaveBeenCalledWith('a', { surfaceLeadDays: null });
  });

  it('shows the soft overlap banner when a save returns overlaps', async () => {
    const onSet = vi.fn(async (): Promise<MeetingOverlap[]> => [
      { id: 'x', title: 'Training', start: AT, end: '2026-09-20T17:00:00.000Z' },
    ]);
    renderDetail(withMeeting({ durationMinutes: null }), onSet);
    fireEvent.change(screen.getByLabelText('Meeting duration'), { target: { value: '120' } });
    expect(await screen.findByText(/overlaps Training/)).toBeTruthy();
  });
});

describe('meetingSurfaced (ADR 0097) — shared server+client gate', () => {
  it('holds a future meeting until its surfacing day, day-of by default', () => {
    expect(meetingSurfaced('2026-09-18', null, '2026-09-15')).toBe(false); // 3 days out
    expect(meetingSurfaced('2026-09-18', null, '2026-09-18')).toBe(true); // day-of
  });
  it('surfaceLeadDays brings the surfacing day earlier', () => {
    expect(meetingSurfaced('2026-09-18', 3, '2026-09-14')).toBe(false); // 18−3=15, still a day early
    expect(meetingSurfaced('2026-09-18', 3, '2026-09-15')).toBe(true); // boundary
  });
});
