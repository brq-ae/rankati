// @vitest-environment happy-dom
import type { List, Location, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The location manager (ADRs 0060, 0061): add / rename / delete / merge, the destructive-action
 * warnings computed over the FULL task list (never the filtered view), and the header filter
 * resetting when the location it points at is deleted or merged away.
 */

const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];

const task = (id: string, title: string, locationIds: string[]): Task => ({
  id,
  title,
  listId: 'l1',
  ownerId: 'local',
  status: 'active',
  createdAt: '2026-07-17T12:00:00.000Z',
  completedAt: null,
  rating: 1000,
  notBefore: null,
  due: null,
  availabilityWindow: null,
  tier: 'normal',
  dependsOn: [],
  locationIds,
  needsHand: false,
  checklist: [], effort: null, needsDetails: false, impact: 'none',
  ...({} as Partial<Task>),
});

let TASKS: Task[] = [];
let LOCATIONS: Location[] = [];
let sent: { url: string; method: string; body: unknown }[] = [];

// A STATEFUL stub: delete/merge mutate LOCATIONS so the next GET reflects the change — that is
// what makes the deleted-id reset (Step 5 effect) actually fire in these tests.
function stubFetch(): void {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const method = init?.method ?? 'GET';
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response);

      if (method !== 'GET') {
        const parsed = init?.body ? JSON.parse(String(init.body)) : null;
        sent.push({ url, method, body: parsed });
        const merge = url.match(/\/api\/locations\/merge$/);
        const byId = url.match(/\/api\/locations\/([^/]+)$/);
        if (merge && method === 'POST') {
          LOCATIONS = LOCATIONS.filter((l) => l.id !== parsed.sourceId); // source gone
          return json(LOCATIONS);
        }
        if (url.match(/\/api\/locations$/) && method === 'POST') {
          // Case-insensitive uniqueness (0061): a duplicate is a 400, like the real server.
          if (LOCATIONS.some((l) => l.name.toLowerCase() === String(parsed.name).toLowerCase())) {
            return Promise.resolve({
              ok: false,
              status: 400,
              statusText: 'Bad Request',
              headers: { get: () => null },
              json: () => Promise.resolve({ message: `a location named “${parsed.name}” already exists` }),
            } as unknown as Response);
          }
          const created = { id: `loc-${LOCATIONS.length + 1}`, name: parsed.name, ownerId: 'local' };
          LOCATIONS = [...LOCATIONS, created];
          return json(created);
        }
        if (byId && method === 'PATCH') {
          LOCATIONS = LOCATIONS.map((l) => (l.id === byId[1] ? { ...l, name: parsed.name } : l));
          return json(LOCATIONS.find((l) => l.id === byId[1]));
        }
        if (byId && method === 'DELETE') {
          LOCATIONS = LOCATIONS.filter((l) => l.id !== byId[1]);
          return Promise.resolve({ ok: true, status: 204, headers: { get: () => null } } as unknown as Response);
        }
        return json(TASKS[0]); // task PATCH, etc.
      }

      const body = url.includes('/api/locations')
        ? LOCATIONS
        : url.includes('/api/lists')
          ? LISTS
          : url.includes('/api/tasks')
            ? TASKS
            : undefined;
      if (body === undefined) throw new Error(`location-manager.spec: unstubbed ${url}`);
      return json(body);
    }),
  );
}

const ready = async () => {
  await screen.findByRole('button', { name: /start dueling/i });
  // The Arena's "start dueling" renders ABOVE the loading gate, so waiting for it does NOT mean the
  // task rows have painted. Wait for the data too, or a getBy on a row races the unpainted list
  // (the tick-ring flake, class-fixed across specs).
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
};
const openManager = async () => {
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  return screen.getByRole('dialog', { name: 'Settings' });
};
const dropdown = () => screen.getByLabelText('Filter tasks by location') as HTMLSelectElement;
// happy-dom has no window.confirm, so stub it (returning true = "proceed") and read its calls.
let confirmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  TASKS = [];
  LOCATIONS = [];
  confirmMock = vi.fn(() => true);
  vi.stubGlobal('confirm', confirmMock);
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GARAGE = { id: 'g', name: 'Garage', ownerId: 'local' };
const HOME = { id: 'h', name: 'Home', ownerId: 'local' };

describe('the location manager (0060, 0061)', () => {
  it('adds a location (POST /locations)', async () => {
    LOCATIONS = [GARAGE];
    render(<App />);
    const dialog = await openManager();
    fireEvent.change(within(dialog).getByLabelText('Add a location'), { target: { value: 'Basement' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(sent).toContainEqual({ url: '/api/locations', method: 'POST', body: { name: 'Basement' } });
  });

  it('renames a location (PATCH /locations/:id)', async () => {
    LOCATIONS = [GARAGE];
    render(<App />);
    const dialog = await openManager();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename location Garage' }));
    const input = within(dialog).getByLabelText('Rename location Garage');
    fireEvent.change(input, { target: { value: 'The Garage' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent).toContainEqual({ url: '/api/locations/g', method: 'PATCH', body: { name: 'The Garage' } });
  });

  describe('an error from a modal action is VISIBLE while the modal is open (not behind it)', () => {
    it('a uniqueness 400 on Add shows INSIDE the manager dialog', async () => {
      LOCATIONS = [GARAGE];
      render(<App />);
      const dialog = await openManager();
      fireEvent.change(within(dialog).getByLabelText('Add a location'), { target: { value: 'garage' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

      // The alert lives in the dialog's top layer, over the backdrop — not in a hidden App banner.
      const alert = await within(dialog).findByRole('alert');
      expect(alert.textContent).toMatch(/already exists/i);
    });

    it('shows even from a NON-lists view, where the old App banner was not rendered at all', async () => {
      LOCATIONS = [GARAGE];
      TASKS = [task('x', 'X', [])];
      render(<App />);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: 'today' })); // leave Lists — the old banner lived there
      // Open the manager directly (the gear is in the header, present on every view).
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
      const dialog = screen.getByRole('dialog', { name: 'Settings' });
      fireEvent.change(within(dialog).getByLabelText('Add a location'), { target: { value: 'GARAGE' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
      expect((await within(dialog).findByRole('alert')).textContent).toMatch(/already exists/i);
    });
  });

  it('the Merge button is disabled until two DISTINCT places are chosen', async () => {
    LOCATIONS = [GARAGE, HOME];
    render(<App />);
    const dialog = await openManager();
    const merge = () => within(dialog).getByRole('button', { name: 'Merge' }) as HTMLButtonElement;
    expect(merge().disabled).toBe(true); // nothing chosen
    fireEvent.change(within(dialog).getByLabelText('Merge from'), { target: { value: 'g' } });
    fireEvent.change(within(dialog).getByLabelText('Merge into'), { target: { value: 'g' } });
    expect(merge().disabled).toBe(true); // same source and target
    fireEvent.change(within(dialog).getByLabelText('Merge into'), { target: { value: 'h' } });
    expect(merge().disabled).toBe(false); // distinct
  });

  it('both merge selects paint an OPAQUE surface (control-bg), not the translucent field-bg (ADR 0062)', async () => {
    LOCATIONS = [GARAGE, HOME];
    render(<App />);
    const dialog = await openManager();
    for (const name of ['Merge from', 'Merge into']) {
      const sel = within(dialog).getByLabelText(name) as HTMLSelectElement;
      expect(sel.className).toContain('bg-control-bg');
      expect(sel.className).not.toContain('bg-field-bg');
    }
  });

  describe('the DELETE warning counts the FULL task list, never the filtered view (0061)', () => {
    it('counts a task the ACTIVE FILTER is hiding, and names only-location tasks', async () => {
      // Buy paint = Garage only; Sand door = Garage + Home; Reply = untagged.
      TASKS = [task('paint', 'Buy paint', ['g']), task('sand', 'Sand door', ['g', 'h']), task('mail', 'Reply', [])];
      LOCATIONS = [GARAGE, HOME];
      render(<App />);
      await ready();

      // Filter to HOME — "Buy paint" (Garage-only) is now hidden from every view.
      fireEvent.change(dropdown(), { target: { value: 'h' } });
      const dialog = await openManager();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete location Garage' }));

      // 2 tagged (paint + sand), even though paint is filtered out; 1 loses its ONLY location.
      const msg = String(confirmMock.mock.calls[0]?.[0]);
      expect(msg).toMatch(/2 tasks are tagged/);
      expect(msg).toMatch(/Buy paint/); // only-location task named...
      expect(msg).not.toMatch(/Sand door/); // ...but not the one with a second location
    });

    it('sends the DELETE after the warning is accepted', async () => {
      TASKS = [task('paint', 'Buy paint', ['g'])];
      LOCATIONS = [GARAGE];
      render(<App />);
      const dialog = await openManager();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete location Garage' }));
      await waitFor(() => expect(sent).toContainEqual({ url: '/api/locations/g', method: 'DELETE', body: null }));
    });
  });

  it('the MERGE warning counts the FULL list with a filter active', async () => {
    TASKS = [task('paint', 'Buy paint', ['g']), task('mail', 'Reply', [])];
    LOCATIONS = [GARAGE, HOME];
    render(<App />);
    await ready();
    fireEvent.change(dropdown(), { target: { value: 'h' } }); // hide the Garage task
    const dialog = await openManager();
    fireEvent.change(within(dialog).getByLabelText('Merge from'), { target: { value: 'g' } });
    fireEvent.change(within(dialog).getByLabelText('Merge into'), { target: { value: 'h' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));

    const msg = String(confirmMock.mock.calls[0]?.[0]);
    expect(msg).toMatch(/Move 1 task from “Garage” to “Home”/); // counts the hidden Garage task
    await waitFor(() =>
      expect(sent).toContainEqual({ url: '/api/locations/merge', method: 'POST', body: { sourceId: 'g', targetId: 'h' } }),
    );
  });

  describe('the header filter never points at a location that is gone (Step 5 effect covers it)', () => {
    it('DELETING the selected location resets the filter to Everywhere', async () => {
      TASKS = [task('paint', 'Buy paint', ['g'])];
      LOCATIONS = [GARAGE, HOME];
      render(<App />);
      await ready();
      fireEvent.change(dropdown(), { target: { value: 'g' } }); // filtering to Garage
      expect(dropdown().value).toBe('g');

      const dialog = await openManager();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete location Garage' }));

      await waitFor(() => expect(dropdown().value).toBe('everywhere')); // reset after refresh
    });

    it('merging the selected location AS SOURCE resets; as TARGET it stays', async () => {
      TASKS = [task('paint', 'Buy paint', ['g'])];
      LOCATIONS = [GARAGE, HOME];
      render(<App />);
      await ready();

      // Selected = Garage (the source). After merge, Garage is deleted -> reset.
      fireEvent.change(dropdown(), { target: { value: 'g' } });
      let dialog = await openManager();
      fireEvent.change(within(dialog).getByLabelText('Merge from'), { target: { value: 'g' } });
      fireEvent.change(within(dialog).getByLabelText('Merge into'), { target: { value: 'h' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
      await waitFor(() => expect(dropdown().value).toBe('everywhere'));
    });

    it('merging INTO the selected target leaves the filter on the surviving target', async () => {
      TASKS = [task('paint', 'Buy paint', ['g'])];
      LOCATIONS = [GARAGE, HOME];
      render(<App />);
      await ready();

      fireEvent.change(dropdown(), { target: { value: 'h' } }); // selected = Home (the target)
      const dialog = await openManager();
      fireEvent.change(within(dialog).getByLabelText('Merge from'), { target: { value: 'g' } });
      fireEvent.change(within(dialog).getByLabelText('Merge into'), { target: { value: 'h' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
      // Home survives the merge, so the filter stays on it — no spurious reset.
      await waitFor(() =>
        expect(sent).toContainEqual({ url: '/api/locations/merge', method: 'POST', body: { sourceId: 'g', targetId: 'h' } }),
      );
      expect(dropdown().value).toBe('h');
    });
  });
});
