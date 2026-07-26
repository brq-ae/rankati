// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import TodayView, { type HeadOutGroup } from '../src/TodayView';
import type { ComingUpItem } from '../src/coming-up';

/**
 * The two strips below the hand (ADR 0074): "When you head out" (playable errands elsewhere, grouped
 * by place) and "Coming up" (the global gated set, soonest-first, each with a reason). Both
 * collapsible. The membership/order of each is proven in coming-up.spec and the App-level filter
 * test; here: the RENDER — grouping, the reason labels, the collapsed bar + count, and expand.
 */
const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({
  id, title, listId: 'l1', ownerId: 'local', status: 'active', createdAt: '2026-07-16T12:00:00.000Z',
  completedAt: null, rating: 1000, notBefore: null, due: null, availabilityWindow: null, tier: 'normal',
  dependsOn: [], locationIds: [], needsHand: false, needsDetails: false, impact: 'none', checklist: [], effort: null, ...over,
});
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];

const view = (headOut: HeadOutGroup[], comingUp: ComingUpItem[]) => (
  <TodayView
    hand={[task('h', 'A hand card')]}
    state="hand"
    onDealAgain={() => {}}
    canDeal={false}
    onToggleTick={() => {}}
    pinTask={null}
    pinReason=""
    onSnoozePin={() => {}}
    onOpenDetail={() => {}}
    lists={LISTS}
    waiting={{ total: 0, blocked: 0, notYetDue: 0, outsideHours: 0 }}
    pending={new Map()}
    tasksById={new Map()}
    locationName={null}
    hiddenByFilter={0}
    block={undefined}
    onSelectBlock={() => {}}
    thresholds={{ quickMax: 15, mediumMax: 60 }}
    headOut={headOut}
    comingUp={comingUp}
  />
);

const strip = (name: RegExp) => screen.getByText(name).closest('details') as HTMLDetailsElement;

describe('the two strips (ADR 0074)', () => {
  afterEach(cleanup);

  it('"When you head out" groups errands by place, with a count', () => {
    render(
      view(
        [
          { name: 'Office', tasks: [task('o1', 'Fetch W-2'), task('o2', 'Sign form')] },
          { name: 'Garage', tasks: [task('g1', 'Get the drill')] },
        ],
        [],
      ),
    );
    const s = strip(/When you head out/);
    expect(within(s).getByText(/When you head out/).textContent).toMatch(/\(3\)/); // 2 + 1 tasks
    expect(within(s).getByText('Office')).toBeTruthy();
    expect(within(s).getByText('Garage')).toBeTruthy();
    expect(within(s).getByText('Fetch W-2')).toBeTruthy();
    expect(within(s).getByText('Get the drill')).toBeTruthy();
  });

  it('"Coming up" lists gated tasks with their reason, in the given (soonest-first) order', () => {
    render(
      view(
        [],
        [
          { task: task('c1', 'Renew visa'), reason: 'outside hours', order: 0.5 },
          { task: task('c2', 'Pay rent'), reason: 'not before 2026-08-01', order: 12 },
          { task: task('c3', 'Submit report'), reason: 'waiting on Draft it', order: Infinity },
        ],
      ),
    );
    const s = strip(/Coming up/);
    expect(within(s).getByText(/Coming up/).textContent).toMatch(/\(3\)/);
    expect(within(s).getByText('outside hours')).toBeTruthy();
    expect(within(s).getByText('not before 2026-08-01')).toBeTruthy();
    expect(within(s).getByText('waiting on Draft it')).toBeTruthy();
    // Rendered in the order given (the caller already sorted soonest-first).
    const order = within(s).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(order[0]).toContain('Renew visa');
    expect(order[2]).toContain('Submit report');
  });

  it('is collapsible: collapsed by default (details not open), a click opens it', () => {
    render(view([{ name: 'Office', tasks: [task('o1', 'Fetch W-2')] }], []));
    const s = strip(/When you head out/);
    expect(s.open).toBe(false); // collapsed — just the bar + count
    fireEvent.click(within(s).getByText(/When you head out/)); // tap the summary
    expect(s.open).toBe(true); // expanded
  });

  it('a strip is absent when it has nothing (no empty bars)', () => {
    render(view([], []));
    expect(screen.queryByText(/When you head out/)).toBeNull();
    expect(screen.queryByText(/Coming up/)).toBeNull();
  });

  it('the old in-hand gated-COUNTS strip is retired — no "N waiting" line in the hand', () => {
    render(view([], [{ task: task('c1', 'Later'), reason: 'not before 2026-08-01', order: 5 }]));
    expect(screen.queryByText(/tasks waiting/)).toBeNull(); // the count-strip is gone
    expect(screen.getByText(/Coming up/)).toBeTruthy(); // replaced by the list
  });
});
