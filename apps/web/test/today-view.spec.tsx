// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import TodayView from '../src/TodayView';

/**
 * The Today view (ADR 0050).
 *
 * WHAT THIS DOES NOT TEST: the ordering rule itself. `rating desc, createdAt desc` lives in
 * the query behind getRankedTasks, and arena-api.spec.ts proves it against real Postgres.
 * Asserting it here would test a sort this component deliberately does not perform — it
 * renders what it is given, in the order given, precisely so the rule has ONE definition.
 * What IS tested: that the component preserves that order, drops what must be dropped, and
 * renders the position, the rating, and the owning list.
 */

const list = (id: string, name: string): List => ({ id, name, ownerId: 'local' });

/** Tasks as the API hands them over: already ranked. */
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

const LISTS = [list('l1', 'Work'), list('l2', 'Home')];
/**
 * The server already filtered; the component is handed the result plus what is being held
 * back and why. `blocked`/`notYetDue` default so existing cases read unchanged; the
 * breakdown's own arithmetic lives in waiting-breakdown.spec.tsx.
 */
const view = (
  tasks: Task[],
  total = 0,
  blocked = 0,
  notYetDue = total - blocked,
  outsideHours = 0,
  pending: Map<string, number> = new Map(),
  tasksById: ReadonlyMap<string, Task> = new Map(),
  locationName: string | null = null,
  hiddenByFilter = 0,
) => (
  <TodayView
    hand={tasks}
    state={tasks.length > 0 ? 'hand' : 'nothing-playable'}
    onDealAgain={() => {}}
    canDeal={false}
    onToggleTick={() => {}}
    pinTask={null}
    pinReason=""
    onSnoozePin={() => {}}
    onOpenDetail={() => {}}
    lists={LISTS}
    waiting={{ total, blocked, notYetDue, outsideHours }}
    pending={pending}
    tasksById={tasksById}
    locationName={locationName}
    hiddenByFilter={hiddenByFilter}
    block={undefined}
    onSelectBlock={() => {}}
    thresholds={{ quickMax: 15, mediumMax: 60 }}
    headOut={[]}
    comingUp={[]}
  />
);
const rows = () => screen.getAllByRole('listitem');
/** Which titles are rendered, in render order. Row text also carries rank, list and rating,
 *  so this asks "which task is this row about?" rather than trying to strip the rest out. */
const orderOf = (expected: string[]) =>
  rows().map((row) => expected.find((t) => row.textContent?.includes(t)) ?? '?');

describe('TodayView', () => {
  afterEach(cleanup);

  it('renders active tasks in the order it was given', () => {
    // Pre-ranked, as the API returns them. The component must not reorder.
    render(view([
          task('a', 'Top', { rating: 1200 }),
          task('b', 'Middle', { rating: 1100 }),
          task('c', 'Bottom', { rating: 900 }),
        ]),
    );
    expect(orderOf(['Top', 'Middle', 'Bottom'])).toEqual(['Top', 'Middle', 'Bottom']);
  });

  it('does NOT re-sort — a caller order that disagrees with rating is still honoured', () => {
    // Proves the absence of a second sort. If this component ever grew one, this flips red
    // and the drift between it and the SQL would be caught here rather than on screen.
    render(view([task('a', 'First given', { rating: 100 }), task('b', 'Second given', { rating: 9999 })]),
    );
    expect(orderOf(['First given', 'Second given'])).toEqual(['First given', 'Second given']);
  });

  it('renders exactly what the server handed it — it does not filter', () => {
    // v0.3 filtered `status` here. v0.4 moved every filter into the query (0052), so this
    // component must NOT re-derive one: two definitions of "playable" drift apart.
    // tasks-today.spec.ts proves the server excludes completed AND gated tasks.
    render(view([task('a', 'One'), task('b', 'Two')]));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows the position AND the rating', () => {
    // The Arena hides the number to force a blind call; this screen is the payoff, so the
    // number explains the order. Different screen, different purpose.
    render(view([task('a', 'Only', { rating: 1234.56 })]));
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('1')).toBeTruthy();
    expect(within(row).getByText('1234.56')).toBeTruthy();
  });

  it('renders the rating to two decimals, so small moves are visible', () => {
    // An expected win shifts a rating by well under a point (0047). Whole points would
    // render that as no movement at all, which is the opposite of the reason it is shown.
    render(view([task('a', 'Trailing zero', { rating: 1032.2 }), task('b', 'Whole', { rating: 1000 })]),
    );
    expect(within(rows()[0]!).getByText('1032.20')).toBeTruthy();
    expect(within(rows()[1]!).getByText('1000.00')).toBeTruthy();
  });

  it('names the list a task belongs to', () => {
    render(view([task('a', 'Fix tap', { listId: 'l2' })]));
    expect(within(screen.getByRole('listitem')).getByText('Home')).toBeTruthy();
  });

  it('counts what it renders', () => {
    render(view([task('a', 'One'), task('b', 'Two')]));
    expect(screen.getByText(/2 to play, most important first/)).toBeTruthy();
  });

  it('marks an overdue task (due before today), and only that one (0058)', () => {
    // Wall-clock-robust: 2020 is before any plausible run date, 2099 after it — so which row is
    // overdue does not depend on when the suite runs, only on due < today.
    render(
      view([
        task('a', 'Overdue', { due: '2020-01-01' }),
        task('b', 'Future', { due: '2099-01-01' }),
        task('c', 'Undated'),
      ]),
    );
    const listitems = rows();
    expect(within(listitems[0]!).queryByText('overdue')).toBeTruthy(); // due 2020 → overdue
    expect(within(listitems[1]!).queryByText('overdue')).toBeNull(); // due 2099 → not
    expect(within(listitems[2]!).queryByText('overdue')).toBeNull(); // undated → not
  });

  it('renders the inherited-urgency subtext on a row that names a source (0059 wiring)', () => {
    // Proves the view actually threads tasksById into UrgencySubtext — the resolve/suppress logic
    // itself is covered in urgency-subtext.spec.tsx. Here: a row pulled up by a deadline it
    // unblocks says which, resolving the source from the full map (the source is not in `tasks`).
    const source = task('src', 'Ship the release', { due: '2099-01-01', tier: 'critical' });
    const row = task('a', 'Write the migration', { urgencySourceId: 'src' });
    render(view([row], 0, 0, 0, 0, new Map(), new Map([['src', source]])));
    expect(within(rows()[0]!).getByText(/for: Ship the release \(2099-01-01\)/)).toBeTruthy();
  });

  it('shows a pending countdown bar on a ticked task, and only on that one (0055 addendum)', () => {
    // A task ticked in Lists is still active, so still here — its row shows the same draining
    // bar rather than sitting untouched. Driven by the shared deadline in the pending map.
    const pending = new Map([['a', 1_000_000]]);
    render(view([task('a', 'Ticked'), task('b', 'Untouched')], 0, 0, 0, 0, pending));
    expect(rows()[0]!.querySelector('.deck-bar')).toBeTruthy();
    expect(rows()[1]!.querySelector('.deck-bar')).toBeNull();
  });

  it('a hand card CAN be played (ADR 0074) — the tick/undo control is on it; the bar stays non-interactive', () => {
    // ADR 0074 supersedes 0055's "Today is display-only": the hand IS the playable set, so the same
    // tick/undo ring lives on the card. A pending card shows the Undo control; the pending BAR itself
    // still opts out of pointer events — the tick circle is the control, not the bar.
    const pending = new Map([['a', 1_000_000]]);
    render(view([task('a', 'Ticked')], 0, 0, 0, 0, pending));
    const row = rows()[0]!;
    expect(within(row).getByRole('button', { name: 'Undo completing Ticked' })).toBeTruthy(); // playable
    expect(row.querySelector('.deck-bar')).toBeTruthy(); // the bar is there...
    // ...but the bar's own container opts out of pointer events, so the bar is not a hit target.
    expect(row.querySelector('.deck-bar')!.closest('[class*="pointer-events-none"]')).toBeTruthy();
  });

  describe('the two empty states are different facts (0052, CONCEPT §5.5)', () => {
    it('says "nothing active" only when there is genuinely nothing', () => {
      render(view([], 0));
      expect(screen.queryByRole('listitem')).toBeNull();
      expect(screen.getByText(/Nothing active/)).toBeTruthy();
      expect(screen.queryByText(/waiting/)).toBeNull();
    });

    it('says the tasks are WAITING when they are all gated — never "nothing active"', () => {
      // Reporting "nothing active" here would be false: there are three tasks, and none of
      // them is playable yet. That is a different state and the user must be able to tell.
      render(view([], 3));
      expect(screen.getByText(/Nothing playable right now — 3 tasks waiting — 3 not yet due\./)).toBeTruthy();
      expect(screen.queryByText(/Nothing active/)).toBeNull();
    });

    it('says "task", singular, for one', () => {
      render(view([], 1));
      expect(screen.getByText(/1 task waiting/)).toBeTruthy();
    });

    it('is an empty state, not an error — same voice as the Arena', () => {
      render(view([]));
      // The Arena answers a too-small pool with a state, never an alert (0047). Today agrees.
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText(/add a task, then duel a few/i)).toBeTruthy();
    });

    it('says WHY it is empty when a LOCATION FILTER is the reason (0060), not the idle copy', () => {
      // A third empty state: not idle, not all-gated, but filtered. It must name the place and
      // the way out, and it TAKES PRECEDENCE — a filter that silently empties Today is a lying
      // view. (locationName='Garage', hiddenByFilter=3.)
      render(view([], 0, 0, 0, 0, new Map(), new Map(), 'Garage', 3));
      expect(screen.getByText(/Nothing playable at Garage — 3 tasks are hidden/)).toBeTruthy();
      expect(screen.getByText(/Switch to Everywhere/)).toBeTruthy();
      expect(screen.queryByText(/Nothing active/)).toBeNull(); // not the genuine-empty copy
    });

    it('singular filtered-empty reads "task is … see it"', () => {
      render(view([], 0, 0, 0, 0, new Map(), new Map(), 'Garage', 1));
      expect(screen.getByText(/1 task is hidden by this filter\. Switch to Everywhere to see it\./)).toBeTruthy();
    });
  });

  // NOTE (ADR 0074): the in-hand gated-COUNTS strip was RETIRED — "Coming up" replaced it with a
  // task LIST (each labeled by reason), tested in coming-up.spec.ts. The waiting breakdown still
  // names the reasons in the NOTHING-PLAYABLE message, covered by the empty-state block above.
});
