// @vitest-environment happy-dom
import type { Location, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The location context-filter end to end (ADR 0060): one predicate filtering all three views, the
 * no-location-always-shows rule, empty-because-filtered vs genuinely-empty, the 0059-subtext seam
 * (resolves from the FULL list even when the source is filtered out of view), and persistence.
 */

const LIST = { id: 'l1', name: 'Work', ownerId: 'local' };
const LOCATIONS: Location[] = [
  { id: 'office', name: 'Office', ownerId: 'local' },
  { id: 'home', name: 'Home', ownerId: 'local' },
];

const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
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

// "Fetch W-2" is doable at the Office and is promoted by the Home-bound "File taxes" deadline it
// unblocks (urgencySourceId). "Anywhere" is untagged. An office-tagged Upcoming task too.
const W2 = task({ id: 'w2', title: 'Fetch W-2', locationIds: ['office'], urgencySourceId: 'taxes' });
const TAXES = task({ id: 'taxes', title: 'File taxes', locationIds: ['home'], due: '2099-01-01', tier: 'critical' });
const FREE = task({ id: 'free', title: 'Anywhere task', locationIds: [] });
const UPC = task({ id: 'upc', title: 'Office delivery', locationIds: ['office'], due: '2099-06-01' });

const ALL = [W2, TAXES, FREE]; // getRankedTasks / getTasks — the full board
const TODAY = [W2, FREE]; // W2 carries its inherited-urgency source
const UPCOMING = [UPC];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const body = url.includes('/api/locations')
        ? LOCATIONS
        : url.includes('/api/lists')
          ? [LIST]
          : url.includes('/api/tasks/today')
            ? TODAY
            : url.includes('/api/tasks/upcoming')
              ? UPCOMING
              : url.includes('/api/tasks')
                ? ALL
                : undefined;
      if (body === undefined) throw new Error(`location-filter-ui.spec: unstubbed ${url}`);
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

const dropdown = () => screen.getByLabelText('Filter tasks by location') as HTMLSelectElement;
const selectLocation = (value: string) => fireEvent.change(dropdown(), { target: { value } });
const tab = (name: 'lists' | 'today' | 'upcoming') => screen.getByRole('button', { name });
const pinButton = () => screen.getByRole('button', { name: /pin location/i });

describe('location context-filter (App, ADR 0060)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('filters Lists, Today and Upcoming together through the one predicate', async () => {
    render(<App />);
    await screen.findByText('Fetch W-2'); // Lists, Everywhere: everything shows
    expect(screen.getByText('File taxes')).toBeTruthy();

    selectLocation('home'); // now only Home + untagged
    expect(screen.queryByText('Fetch W-2')).toBeNull(); // office task hidden in Lists
    expect(screen.getByText('File taxes')).toBeTruthy(); // home task stays
    expect(screen.getByText('Anywhere task')).toBeTruthy(); // untagged always shows

    fireEvent.click(tab('today'));
    expect(screen.getByText('Anywhere task')).toBeTruthy(); // untagged is dealt into the hand
    // The office task is not doable HERE, so it leaves the hand and surfaces in "When you head out"
    // (ADR 0074) — playable-elsewhere, not gone. The strip names the place.
    expect(screen.getByText('When you head out')).toBeTruthy();
    expect(screen.getByText('Fetch W-2')).toBeTruthy();

    fireEvent.click(tab('upcoming'));
    expect(screen.queryByText('Office delivery')).toBeNull(); // office upcoming hidden at Home
  });

  it('an untagged task shows under EVERY selection', async () => {
    render(<App />);
    await screen.findByText('Anywhere task');
    for (const where of ['office', 'home', 'everywhere']) {
      selectLocation(where);
      expect(screen.getByText('Anywhere task')).toBeTruthy();
    }
  });

  it('empty BECAUSE filtered reads differently from genuinely empty', async () => {
    render(<App />);
    await screen.findByText('Fetch W-2');
    selectLocation('home'); // Office delivery (the only Upcoming) is now hidden
    fireEvent.click(tab('upcoming'));
    // Names the place and the way out — not the generic "Nothing on the horizon".
    expect(screen.getByText(/Nothing upcoming at Home/)).toBeTruthy();
    expect(screen.getByText(/Switch to Everywhere/)).toBeTruthy();
    expect(screen.queryByText(/Nothing on the horizon/)).toBeNull();
  });

  it('SUBTEXT SEAM: a promoted row still names a source the filter has hidden (0059 × 0060)', async () => {
    render(<App />);
    await screen.findByText('Fetch W-2');
    selectLocation('office'); // "File taxes" (Home) is now filtered OUT of every visible list
    fireEvent.click(tab('today'));
    expect(screen.getByText('Fetch W-2')).toBeTruthy();
    // The source is resolved from the FULL list (tasksById), not the filtered view — so it renders
    // even though "File taxes" is not itself visible anywhere right now.
    expect(screen.getByText(/for: File taxes/)).toBeTruthy();
  });

  describe('persistence', () => {
    it('a PINNED selection survives a remount; UNPINNED resets to Everywhere', async () => {
      const first = render(<App />);
      await screen.findByText('Fetch W-2');
      selectLocation('office');
      fireEvent.click(pinButton()); // pin Office
      expect(dropdown().value).toBe('office');

      first.unmount();
      const second = render(<App />); // reload
      await screen.findByText('Fetch W-2');
      expect(dropdown().value).toBe('office'); // remembered

      fireEvent.click(pinButton()); // unpin
      second.unmount();
      render(<App />);
      await screen.findByText('Fetch W-2');
      expect(dropdown().value).toBe('everywhere'); // reset
    });

    it('changing the place while pinned KEEPS the pin', async () => {
      render(<App />);
      await screen.findByText('Fetch W-2');
      selectLocation('office');
      fireEvent.click(pinButton()); // pinned on Office
      selectLocation('home'); // change while pinned

      cleanup();
      render(<App />); // reload — Home should be remembered, still pinned
      await screen.findByText('Anywhere task'); // untagged, visible at Home (W-2 is filtered out)
      expect(dropdown().value).toBe('home');
    });
  });
});
