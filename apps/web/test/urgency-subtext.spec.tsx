// @vitest-environment happy-dom
import type { Task } from '@rankati/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import UrgencySubtext from '../src/UrgencySubtext';

/**
 * The inherited-urgency subtext (ADR 0059): "for: <deadline> (<due>)". Ids-only on the wire
 * (0053) — the row carries `urgencySourceId`, and this resolves the title and due from the
 * client's full task list. The whole point of this component is what it does when it CANNOT, so
 * most of these tests are the graceful paths, each written so the guard that makes it graceful
 * bites if removed:
 *   - remove the `source.status === 'done'` check → the "source completed" case renders and fails;
 *   - remove the `!source` guard (or print the id) → the "unresolvable" case shows the id and fails.
 */

const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({
  id,
  title,
  listId: 'l1',
  ownerId: 'local',
  status: 'active',
  createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null,
  rating: 1000,
  notBefore: null,
  due: null,
  availabilityWindow: null,
  tier: 'normal',
  dependsOn: [],
  locationIds: [],
  needsHand: false,
  checklist: [], effort: null, needsDetails: false, impact: 'none',
  ...over,
});

const mapOf = (...ts: Task[]): ReadonlyMap<string, Task> => new Map(ts.map((t) => [t.id, t]));

describe('UrgencySubtext', () => {
  afterEach(cleanup);

  it('names the source deadline and its due date when resolvable and active', () => {
    const source = task('src', 'Submit the grant', { due: '2026-08-01', tier: 'critical' });
    const row = task('row', 'Draft the budget', { urgencySourceId: 'src' });
    render(<UrgencySubtext task={row} tasksById={mapOf(source, row)} />);
    expect(screen.getByText(/for: Submit the grant \(2026-08-01\)/)).toBeTruthy();
  });

  it('shows the title without parentheses when the source has no due date', () => {
    // Belt-and-braces: a source with inherited urgency should have a due, but if it somehow
    // does not, render "for: <title>" rather than "for: <title> ()".
    const source = task('src', 'Undated goal', { due: null });
    const row = task('row', 'Prerequisite', { urgencySourceId: 'src' });
    render(<UrgencySubtext task={row} tasksById={mapOf(source, row)} />);
    expect(screen.getByText('for: Undated goal')).toBeTruthy();
    expect(screen.queryByText(/\(\)/)).toBeNull();
  });

  it('renders NOTHING when the task carries no urgencySourceId', () => {
    const row = task('row', 'Just a task'); // no urgencySourceId
    const { container } = render(<UrgencySubtext task={row} tasksById={mapOf(row)} />);
    expect(container.textContent).toBe('');
  });

  it('GRACEFUL — unresolvable source: no subtext, and the id never leaks to the screen', () => {
    // The source is BLOCKED and absent from every read the client currently holds. Show no
    // subtext — never a dangling id. (Remove the `!source` guard and this shows "src-42".)
    const row = task('row', 'Orphaned prerequisite', { urgencySourceId: 'src-42' });
    const { container } = render(<UrgencySubtext task={row} tasksById={mapOf(row)} />);
    expect(container.textContent).toBe('');
    expect(container.textContent).not.toContain('src-42');
  });

  it('GRACEFUL — source COMPLETED: no subtext, never points at a finished task (decision 8)', () => {
    // The realistic race. Completing the deadline runs setTasks(source → done) THEN refresh(), so
    // for one render the client holds this row's stale urgencySourceId while the task list already
    // shows the source done — resolvable, but finished. Suppress it; the next read drops the id.
    // (Remove the `status === 'done'` check and this renders "for: Submit the grant".)
    const source = task('src', 'Submit the grant', { due: '2026-08-01', status: 'done' });
    const row = task('row', 'Draft the budget', { urgencySourceId: 'src' });
    const { container } = render(<UrgencySubtext task={row} tasksById={mapOf(source, row)} />);
    expect(container.textContent).toBe('');
    expect(container.textContent).not.toContain('Submit the grant');
  });
});
