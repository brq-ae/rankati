// @vitest-environment happy-dom
import type { List, Location, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

/**
 * The task detail view (ADR 0054).
 *
 * WHAT THIS CANNOT PROVE, stated up front so a green run is not mistaken for more than it
 * is: happy-dom implements <dialog>'s STATE — showModal(), close(), .open — but not the
 * browser behaviours built on top of it. The FOCUS TRAP and ESCAPE-TO-CLOSE are real-browser
 * behaviours and are eye-checked, exactly as v0.3's no-flash was. What is proven here is
 * everything else: that it opens, what it contains, that it edits through the same handlers
 * the row uses, that clicking the backdrop closes it, and that the row keeps its own actions.
 */

const LISTS: List[] = [
  { id: 'l1', name: 'Work', ownerId: 'local' },
  { id: 'l2', name: 'Home', ownerId: 'local' },
];

const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({
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
  locationIds: [],
  needsHand: false,
  checklist: [], effort: null, needsDetails: false, impact: 'none',
  ...over,
});

let TASKS: Task[] = [];
let LOCATIONS: Location[] = [];
/** Set true to make PATCH /tasks/:id fail — the create-succeeds-tag-fails path (0061). */
let patchTaskFails = false;
let sent: { url: string; method: string; body: unknown }[] = [];

function stubFetch(): void {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        // createLocation returns a Location, not a Task — the two-call create-and-tag flow (0061).
        if (url.includes('/api/locations') && method === 'POST') {
          const name = init?.body ? (JSON.parse(String(init.body)) as { name: string }).name : 'X';
          return Promise.resolve({
            ok: true,
            headers: { get: () => null },
            json: () => Promise.resolve({ id: 'loc-new', name, ownerId: 'local' }),
          } as unknown as Response);
        }
        // createList returns a List — the create-a-list-and-move flow (v0.34.0).
        if (url.includes('/api/lists') && method === 'POST') {
          const name = init?.body ? (JSON.parse(String(init.body)) as { name: string }).name : 'X';
          return Promise.resolve({
            ok: true,
            headers: { get: () => null },
            json: () => Promise.resolve({ id: 'l-new', name, ownerId: 'local' }),
          } as unknown as Response);
        }
        if (url.includes('/api/tasks') && patchTaskFails) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'Internal',
            headers: { get: () => null },
            json: () => Promise.resolve({ message: 'tagging blew up' }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          headers: { get: () => null },
          json: () => Promise.resolve(TASKS[0]),
        } as unknown as Response);
      }
      const body = url.includes('/api/locations')
        ? LOCATIONS
        : url.includes('/api/lists')
          ? LISTS
          : url.includes('/api/tasks')
            ? TASKS
            : undefined;
      if (body === undefined) throw new Error(`task-detail.spec: unstubbed request to ${url}`);
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      } as unknown as Response);
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
const openDetail = async (title: string) => {
  await ready();
  // findByRole, not getByRole: `ready()` waits for the Arena button, which renders above the loading
  // gate, so the task ROW may not be painted yet — wait for it (the tick-ring flake, class-fixed).
  // ANCHORED: a substring match makes "Alpha" ambiguous the moment a fixture contains
  // "Alpha too", and the test then fails for a reason that has nothing to do with its subject.
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^Open details for ${title}$`, 'i') }));
};

beforeEach(() => {
  localStorage.clear();
  LOCATIONS = [];
  patchTaskFails = false;
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('opening', () => {
  it('opens when the task NAME is tapped (0056)', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    expect(document.querySelector('dialog')?.open ?? false).toBe(false);
    // The name is the one route to the modal now — no dedicated ⋯, no inline rename (0056).
    fireEvent.click(screen.getByRole('button', { name: /Open details for Alpha/i }));
    expect(document.querySelector('dialog')?.open).toBe(true);
  });

  it('is not in the document until it is opened', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('shows the task, its list, its date and what it requires', async () => {
    TASKS = [
      task('b', 'Blocker'),
      task('a', 'Alpha', { notBefore: '2026-12-25', dependsOn: ['b'] }),
    ];
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    expect(within(dialog).getByLabelText('Title')).toHaveProperty('value', 'Alpha');
    expect(within(dialog).getByLabelText('Not before')).toHaveProperty('value', '2026-12-25');
    expect(within(dialog).getByText(/Blocker/)).toBeTruthy();
    expect(within(dialog).getByText(/currently.*Work/)).toBeTruthy(); // its list, now a create-or-move combobox
  });

  it('says so plainly when nothing blocks the task', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');
    expect(screen.getByText(/Nothing — this is ready\./)).toBeTruthy();
  });
});

describe('closing', () => {
  it('closes on the close button', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.click(screen.getByRole('button', { name: /Close details/i }));
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('closes when the BACKDROP is clicked, not when the panel is', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');
    const dialog = document.querySelector('dialog')!;

    // A click inside targets a child, and must not close.
    fireEvent.click(within(document.querySelector('dialog')!).getByLabelText('Title'));
    expect(document.querySelector('dialog')).not.toBeNull();

    // The backdrop is not a child, so a click on it lands on the <dialog> itself.
    fireEvent.click(dialog);
    expect(document.querySelector('dialog')).toBeNull();
  });
});

describe('it edits through the SAME endpoints the row uses (0054)', () => {
  it('renames through PATCH /tasks/:id, exactly as the row does', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');

    const input = within(document.querySelector('dialog')!).getByLabelText('Title');
    fireEvent.change(input, { target: { value: 'Renamed in the modal' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(sent).toContainEqual({
      url: '/api/tasks/a',
      method: 'PATCH',
      body: { title: 'Renamed in the modal' },
    });
  });

  it('sets the date through the same PATCH, with the wire format untouched', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.change(within(document.querySelector('dialog')!).getByLabelText('Not before'), { target: { value: '2027-01-01' } });
    expect(sent).toContainEqual({
      url: '/api/tasks/a',
      method: 'PATCH',
      body: { notBefore: '2027-01-01' }, // 'YYYY-MM-DD', never an instant (0052)
    });
  });

  it('clears the date with null — the only way to remove a gate', async () => {
    TASKS = [task('a', 'Alpha', { notBefore: '2026-12-25' })];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.change(within(document.querySelector('dialog')!).getByLabelText('Not before'), { target: { value: '' } });
    expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { notBefore: null } });
  });

  it('sets Due through the same PATCH — a deadline, distinct from the start gate (0056)', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.change(within(document.querySelector('dialog')!).getByLabelText('Due'), {
      target: { value: '2026-08-01' },
    });
    expect(sent).toContainEqual({
      url: '/api/tasks/a',
      method: 'PATCH',
      body: { due: '2026-08-01' }, // 'YYYY-MM-DD', never an instant (0052/0056)
    });
  });

  it('clears Due with null', async () => {
    TASKS = [task('a', 'Alpha', { due: '2026-08-01' })];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.change(within(document.querySelector('dialog')!).getByLabelText('Due'), {
      target: { value: '' },
    });
    expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { due: null } });
  });

  it('Not before and Due are two distinct, independently-labeled date fields', async () => {
    TASKS = [task('a', 'Alpha', { notBefore: '2026-07-18', due: '2026-07-25' })];
    render(<App />);
    await openDetail('Alpha');
    const dialog = document.querySelector('dialog')!;

    expect(within(dialog).getByLabelText('Not before')).toHaveProperty('value', '2026-07-18');
    expect(within(dialog).getByLabelText('Due')).toHaveProperty('value', '2026-07-25'); // not the same field
  });

  it('picks a tier through the same PATCH, by its declared value (0056)', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');

    // The colour is the affordance; the aria-label carries the word, so the click is unambiguous.
    fireEvent.click(
      within(document.querySelector('dialog')!).getByRole('button', {
        name: /Set importance: Critical/i,
      }),
    );
    expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { tier: 'critical' } });
  });

  it('shows the current tier as its word, and marks its swatch pressed — colour is never alone', async () => {
    TASKS = [task('a', 'Alpha', { tier: 'super_important' })];
    render(<App />);
    await openDetail('Alpha');
    const dialog = document.querySelector('dialog')!;

    expect(within(dialog).getByText('Super Important')).toBeTruthy(); // the word, in text
    const pressed = within(dialog).getByRole('button', { name: /Set importance: Super Important/i });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    const other = within(dialog).getByRole('button', { name: /Set importance: Normal/i });
    expect(other.getAttribute('aria-pressed')).toBe('false');
  });

  it('the needs-a-hand toggle PATCHes {needsHand: true}, with no refresh (ADR 0071)', async () => {
    TASKS = [task('a', 'Alpha', { needsHand: false })];
    render(<App />);
    await openDetail('Alpha');

    const callsBefore = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(within(document.querySelector('dialog')!).getByRole('button', { name: /Needs a hand/i }));

    expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { needsHand: true } });
    // A local patch (ADR 0071), not a refresh: exactly ONE new request — the PATCH above. A
    // refresh would fire five parallel GETs (lists, tasks, today, upcoming, locations), which
    // this asserts did NOT happen — unlike onSetAvailabilityWindow, needsHand never gates.
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
  });

  it('filter + pick an existing list moves through the same PATCH — listId only (0056)', async () => {
    TASKS = [task('a', 'Alpha', { listId: 'l1' })];
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    fireEvent.focus(within(dialog).getByLabelText('Move to a list'));
    fireEvent.change(within(dialog).getByLabelText('Move to a list'), { target: { value: 'Hom' } }); // filter
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Home' })); // pick the match

    expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { listId: 'l2' } });
    expect(sent.some((s) => s.url.includes('/api/lists') && s.method === 'POST')).toBe(false); // no new list
  });

  it('browse-first: focus shows ALL lists incl. the current one marked "(current)", sorted A–Z (0089)', async () => {
    TASKS = [task('a', 'Alpha', { listId: 'l1' })]; // l1 = Work; lists are Work, Home
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    const input = within(dialog).getByLabelText('Move to a list');
    expect(within(dialog).queryAllByRole('button', { name: /^Move to / })).toHaveLength(0); // closed until focus
    fireEvent.focus(input);
    // All lists shown with no typing, A–Z (Home before Work); the current list is marked.
    const rows = within(dialog).getAllByRole('button', { name: /^Move to / });
    expect(rows.map((b) => b.textContent)).toEqual(['Home', 'Work (current)']);
  });

  it('Escape closes the list menu (and blur closes it too) (0089)', async () => {
    TASKS = [task('a', 'Alpha', { listId: 'l1' })];
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    const input = within(dialog).getByLabelText('Move to a list');
    fireEvent.focus(input);
    expect(within(dialog).getByRole('button', { name: 'Move to Home' })).toBeTruthy(); // open
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(within(dialog).queryByRole('button', { name: 'Move to Home' })).toBeNull(); // closed

    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(within(dialog).queryByRole('button', { name: 'Move to Home' })).toBeNull();
  });

  it('a NEW name creates the list then moves the task, in one action (v0.34.0)', async () => {
    TASKS = [task('a', 'Alpha', { listId: 'l1' })];
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    fireEvent.focus(within(dialog).getByLabelText('Move to a list'));
    fireEvent.change(within(dialog).getByLabelText('Move to a list'), { target: { value: 'Errands' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Create Errands and move here/ }));

    // create-then-move: the PATCH lands a microtask after the POST resolves
    await waitFor(() => {
      expect(sent).toContainEqual({ url: '/api/lists', method: 'POST', body: { name: 'Errands' } });
      expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { listId: 'l-new' } });
    });
  });

  it('a case-insensitive name match selects the existing list — no duplicate created', async () => {
    TASKS = [task('a', 'Alpha', { listId: 'l1' })];
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    fireEvent.focus(within(dialog).getByLabelText('Move to a list'));
    fireEvent.change(within(dialog).getByLabelText('Move to a list'), { target: { value: 'home' } }); // lower-case
    // no "+ Create" is offered for an exact (case-insensitive) match
    expect(within(dialog).queryByRole('button', { name: /Create home/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Home' }));

    expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { listId: 'l2' } });
    expect(sent.some((s) => s.url.includes('/api/lists') && s.method === 'POST')).toBe(false);
  });

  it('rejects an empty/whitespace name — no create button, no requests', async () => {
    TASKS = [task('a', 'Alpha', { listId: 'l1' })];
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    const combo = within(dialog).getByLabelText('Move to a list');
    fireEvent.focus(combo);
    fireEvent.change(combo, { target: { value: '   ' } });
    expect(within(dialog).queryByRole('button', { name: /Create/ })).toBeNull();
    fireEvent.keyDown(combo, { key: 'Enter' });
    expect(sent.some((s) => s.method !== 'GET')).toBe(false); // nothing sent
  });

  it('removes a dependency by sending the REMAINING set, not the removed one', async () => {
    TASKS = [
      task('b', 'Blocker'),
      task('c', 'Other'),
      task('a', 'Alpha', { dependsOn: ['b', 'c'] }),
    ];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.click(screen.getByRole('button', { name: /Stop requiring Blocker/i }));
    // dependsOn REPLACES the set (0053), so removal means sending what is left.
    expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { dependsOn: ['c'] } });
  });
});

describe('the row has exactly two tap targets — done and the name (0056)', () => {
  it('has done, name-opens-modal and a minor delete — no ⋯, no inline rename, no date input', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    expect(screen.getByRole('button', { name: /Complete Alpha/i })).toBeTruthy(); // done-circle
    expect(screen.getByRole('button', { name: /Delete Alpha/i })).toBeTruthy(); // the small ✕
    // The name is now the ONLY route to the modal — the dedicated ⋯ button is gone.
    expect(screen.getAllByRole('button', { name: /Open details for Alpha/i })).toHaveLength(1);
    // Gone: inline rename (button and input) and any inline date control.
    expect(screen.queryByRole('button', { name: /Rename Alpha/i })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Rename Alpha/i })).toBeNull();
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });

  it('the name opens the modal, where the title field renames (rename is modal-only now)', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: /Open details for Alpha/i }));
    const title = within(document.querySelector('dialog')!).getByLabelText('Title');
    expect(title).toHaveProperty('value', 'Alpha'); // rename happens here, not on the row
  });

  it('the name carries a full-name title tooltip for the desktop peek (0056)', async () => {
    TASKS = [task('a', 'A very long task name that will be truncated on the row')];
    render(<App />);
    await ready();

    const name = screen.getByRole('button', {
      name: /Open details for A very long task name/i,
    });
    expect(name.getAttribute('title')).toBe('A very long task name that will be truncated on the row');
  });
});

describe('the two-line layout (0056)', () => {
  const nameOf = (title: string) =>
    screen.getByRole('button', { name: new RegExp(`Open details for ${title}`, 'i') });

  it('shows a metadata line, and one-line-truncates the name, when the task has dates', async () => {
    TASKS = [task('a', 'Alpha', { due: '2026-08-01', tier: 'critical' })];
    render(<App />);
    await ready();

    expect(screen.getByLabelText(/^Due 2026-08-01/i)).toBeTruthy(); // line 2 present
    expect(screen.getByLabelText('Importance: Critical')).toBeTruthy(); // elevated tier dot
    expect(nameOf('Alpha').className).toMatch(/truncate/); // name stays one line
  });

  it('has NO metadata line, and lets the name wrap, when the task is dateless and normal', async () => {
    TASKS = [task('a', 'Alpha')]; // no notBefore, no due, tier normal
    render(<App />);
    await ready();

    expect(screen.queryByLabelText(/^Due /i)).toBeNull();
    expect(screen.queryByLabelText(/^Not before /i)).toBeNull();
    expect(screen.queryByLabelText(/^Importance:/i)).toBeNull(); // no dot for normal
    expect(nameOf('Alpha').className).toMatch(/line-clamp-2/); // free to wrap to two lines
  });

  it('shows the tier dot ONLY for a non-normal tier — a dot means elevated', async () => {
    TASKS = [task('a', 'Normalish', { tier: 'normal', due: '2026-08-01' }), task('b', 'Loud', { tier: 'important' })];
    render(<App />);
    await ready();

    // 'Normalish' has a due (so line 2 exists) but a normal tier -> no dot.
    expect(screen.queryByLabelText('Importance: Normal')).toBeNull();
    // 'Loud' is important -> a dot, and the tier is machine-readable via data-tier (ADR 0062:
    // the Clear theme shape-codes off this attribute; it also makes the tier legible to the DOM).
    expect(screen.getByLabelText('Importance: Important').getAttribute('data-tier')).toBe('important');
  });
});

describe('native selects paint an OPAQUE surface, not the translucent field-bg (ADR 0062)', () => {
  it('the list move is a combobox INPUT (bg-field-bg), not a native select (v0.34.0)', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');
    const input = within(document.querySelector('dialog')!).getByLabelText('Move to a list');
    expect(input.tagName).toBe('INPUT');
    expect(input.className).toContain('bg-field-bg'); // an input wants field-bg; only native selects need control-bg
  });
});

describe('the row DISPLAYS due and tier read-only (0056)', () => {
  it('shows due with a flag and the tier, when set — and offers no picker', async () => {
    TASKS = [task('a', 'Alpha', { due: '2026-08-01', tier: 'critical' })];
    render(<App />);
    await ready();

    expect(screen.getByLabelText(/^Due 2026-08-01/i)).toBeTruthy(); // the deadline, read-only
    expect(screen.getByLabelText('Importance: Critical')).toBeTruthy(); // tier at a glance
    expect(document.querySelector('input[type="date"]')).toBeNull(); // nothing editable inline
  });

  it('keeps not-before display with its waiting marker — unchanged behaviour', async () => {
    TASKS = [task('a', 'Alpha', { notBefore: '2099-01-01' })]; // far future -> gated
    render(<App />);
    await ready();

    const nb = screen.getByLabelText(/^Not before 2099-01-01/i);
    expect(nb).toBeTruthy();
    expect(nb.className).toMatch(/not-before/); // the "waiting for its day" marker persists (0062 token)
  });

  it('shows no due glyph when there is no deadline — the two dates are independent', async () => {
    TASKS = [task('a', 'Alpha', { notBefore: '2099-01-01' })]; // has not-before, no due
    render(<App />);
    await ready();

    expect(screen.getByLabelText(/^Not before/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^Due /i)).toBeNull();
  });
});

describe('the dependency picker (ADRs 0053, 0054)', () => {
  const search = () =>
    within(document.querySelector('dialog')!).getByLabelText('Add something this requires');

  it('browse-first: focusing shows ALL eligible tasks, sorted A–Z, before any typing (0089)', async () => {
    // Browse-first (0089) reverses the old type-first rule: you no longer have to remember a name.
    // Focus the box and every eligible task drops down at once, alphabetical; the option list is
    // closed until then (so an untouched panel is calm and "+ Create" is not shoved off-screen).
    TASKS = [task('a', 'Alpha'), task('b', 'Buy milk'), task('c', 'Buy bread')];
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    const input = within(dialog).getByLabelText('Add something this requires');
    expect(within(dialog).queryAllByRole('button', { name: /^Require / })).toHaveLength(0); // closed until focus
    fireEvent.focus(input);
    // Alpha is the open task → excluded as self; the other two show with NO query typed, sorted A–Z.
    const rows = within(dialog).getAllByRole('button', { name: /^Require / });
    expect(rows.map((b) => b.textContent)).toEqual(['Buy bread', 'Buy milk']);
  });

  it('a broad match stays in a bounded, scrollable box — never a wall, Create stays reachable', async () => {
    // Twenty matches: all are present and scroll-reachable, but the list is height-capped so it
    // cannot grow unbounded and push "+ Create" out of view.
    TASKS = [task('a', 'Alpha'), ...Array.from({ length: 20 }, (_, i) => task(`b${i}`, `Buy item ${i}`))];
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    const input = within(dialog).getByLabelText('Add something this requires');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'buy' } });

    const options = within(dialog).getAllByRole('button', { name: /^Require Buy item/ });
    expect(options.length).toBe(20); // all present (≤ the 50 cap) — reachable by scrolling inside the box
    const list = options[0]!.closest('ul')!;
    expect(list.className).toMatch(/overflow-y-auto/); // ...but the box scrolls rather than growing
    expect(list.className).toMatch(/max-h-/);
    expect(within(dialog).getByRole('button', { name: /Create buy and require it/i })).toBeTruthy(); // still there
  });

  it('Enter-safe: focusing then pressing Enter with NO query adds no dependency (-1 sentinel, 0089)', async () => {
    // Browse-all shows options, but none is pre-active, so a stray Enter on an untouched box is inert.
    TASKS = [task('a', 'Alpha'), task('b', 'Blocker')];
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    const input = within(dialog).getByLabelText('Add something this requires');
    fireEvent.focus(input);
    expect(within(dialog).getByRole('button', { name: /Require Blocker/i })).toBeTruthy(); // menu IS open
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent.some((s) => s.method !== 'GET')).toBe(false); // nothing sent — no dependency added
  });

  it('Escape closes the menu and clears the query; blur closes it too (0089)', async () => {
    TASKS = [task('a', 'Alpha'), task('b', 'Blocker')];
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    const input = within(dialog).getByLabelText('Add something this requires');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'block' } });
    expect(within(dialog).getByRole('button', { name: /Require Blocker/i })).toBeTruthy(); // open
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(within(dialog).queryByRole('button', { name: /Require Blocker/i })).toBeNull(); // closed
    expect(input).toHaveProperty('value', ''); // query cleared

    // Re-open, then blur: the menu closes (query is left as-is on blur, unlike Escape).
    fireEvent.focus(input);
    expect(within(dialog).getByRole('button', { name: /Require Blocker/i })).toBeTruthy();
    fireEvent.blur(input);
    expect(within(dialog).queryByRole('button', { name: /Require Blocker/i })).toBeNull();
  });

  it('caps the eligible set at 50 with a "keep typing to narrow…" hint — browse-all AND filtered (0089)', async () => {
    // 60 eligible tasks: the rendered set is capped at 50 (alphabetical) so a big backlog never
    // walls the panel; a faint hint row stands in for the remainder, and it is NOT a pickable option.
    TASKS = [task('a', 'Alpha'), ...Array.from({ length: 60 }, (_, i) => task(`b${i}`, `Buy item ${String(i).padStart(2, '0')}`))];
    render(<App />);
    await openDetail('Alpha');

    const dialog = document.querySelector('dialog')!;
    const input = within(dialog).getByLabelText('Add something this requires');
    const rows = () => within(dialog).getAllByRole('button', { name: /^Require Buy item/ });
    fireEvent.focus(input); // browse-all: 60 eligible → 50 shown + hint
    expect(rows()).toHaveLength(50);
    expect(within(dialog).getByText(/keep typing to narrow/i)).toBeTruthy();

    // Filtered wide: 'buy' still matches all 60 → same cap + hint (the guard is on any large set).
    fireEvent.change(input, { target: { value: 'buy' } });
    expect(rows()).toHaveLength(50);
    expect(within(dialog).getByText(/keep typing to narrow/i)).toBeTruthy();

    // Narrow enough to fall under the cap → the hint is gone.
    fireEvent.change(input, { target: { value: 'Buy item 0' } }); // matches 00–09 = 10
    expect(rows()).toHaveLength(10);
    expect(within(dialog).queryByText(/keep typing to narrow/i)).toBeNull();
  });

  it('filters by substring as you type', async () => {
    TASKS = [
      task('a', 'Alpha'),
      task('b', 'Buy milk'),
      task('c', 'Buy bread'),
      task('d', 'Call Ahmed'),
    ];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.focus(search());
    fireEvent.change(search(), { target: { value: 'buy' } });
    const dialog = document.querySelector('dialog')!;
    expect(within(dialog).getByRole('button', { name: /Require Buy milk/i })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Require Buy bread/i })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Require Call Ahmed/i })).toBeNull();
  });

  it('never offers the task itself', async () => {
    TASKS = [task('a', 'Alpha'), task('b', 'Alpha too')];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.focus(search());
    fireEvent.change(search(), { target: { value: 'alpha' } });
    const dialog = document.querySelector('dialog')!;
    // Both titles match the query; only the OTHER task may be offered — the server would
    // refuse a self-dependency, so it is not presented.
    expect(within(dialog).getByRole('button', { name: /Require Alpha too/i })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Require Alpha$/i })).toBeNull();
  });

  it('never offers what the task already requires', async () => {
    TASKS = [task('b', 'Blocker'), task('c', 'Blocker two'), task('a', 'Alpha', { dependsOn: ['b'] })];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.focus(search());
    fireEvent.change(search(), { target: { value: 'blocker' } });
    const dialog = document.querySelector('dialog')!;
    expect(within(dialog).queryByRole('button', { name: /Require Blocker$/i })).toBeNull();
    expect(within(dialog).getByRole('button', { name: /Require Blocker two/i })).toBeTruthy();
  });

  it('picking sends the WHOLE set, not just the new one', async () => {
    TASKS = [task('b', 'Blocker'), task('c', 'Another'), task('a', 'Alpha', { dependsOn: ['b'] })];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.focus(search());
    fireEvent.change(search(), { target: { value: 'another' } });
    fireEvent.click(screen.getByRole('button', { name: /Require Another/i }));

    // dependsOn REPLACES (0053): sending only ['c'] would silently drop 'b'.
    expect(sent).toContainEqual({
      url: '/api/tasks/a',
      method: 'PATCH',
      body: { dependsOn: ['b', 'c'] },
    });
  });

  it('offers Create whenever anything is typed — even when something matches', async () => {
    // Hiding it on a match would make the feature depend on your vocabulary: a new
    // prerequisite may legitimately share a word with an existing task.
    TASKS = [task('a', 'Alpha'), task('b', 'Buy milk')];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.focus(search());
    fireEvent.change(search(), { target: { value: 'Buy' } });
    expect(screen.getByRole('button', { name: /Require Buy milk/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create Buy and require it/i })).toBeTruthy();
  });

  it('offers no Create for an empty or whitespace query', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');
    expect(screen.queryByRole('button', { name: /and require it/i })).toBeNull();

    fireEvent.change(search(), { target: { value: '   ' } });
    expect(screen.queryByRole('button', { name: /and require it/i })).toBeNull();
  });

  it('Create calls the ATOMIC endpoint with the list PREFILLED to this task’s', async () => {
    TASKS = [task('a', 'Alpha', { listId: 'l1' })];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.change(search(), { target: { value: 'Ring the vet' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Ring the vet and require it/i }));

    expect(sent).toContainEqual({
      url: '/api/tasks/a/requires', // one call — create AND link, or neither (0054)
      method: 'POST',
      body: { title: 'Ring the vet', listId: 'l1' },
    });
  });

  it('changing the list changes what is sent', async () => {
    TASKS = [task('a', 'Alpha', { listId: 'l1' })];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.change(search(), { target: { value: 'Elsewhere' } });
    fireEvent.change(screen.getByLabelText('List for the new task'), { target: { value: 'l2' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Elsewhere and require it/i }));

    expect(sent).toContainEqual({
      url: '/api/tasks/a/requires',
      method: 'POST',
      body: { title: 'Elsewhere', listId: 'l2' },
    });
  });

  it('the query resets after picking, so the list is not left filtered', async () => {
    TASKS = [task('a', 'Alpha'), task('b', 'Blocker')];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.focus(search());
    fireEvent.change(search(), { target: { value: 'block' } });
    fireEvent.click(screen.getByRole('button', { name: /Require Blocker/i }));
    expect(search()).toHaveProperty('value', '');
  });
});

describe('the WHERE picker — location tags, and the DIVERGENCE from Requires (0060, 0061)', () => {
  const GARAGE: Location = { id: 'g', name: 'Garage', ownerId: 'local' };
  const HOME: Location = { id: 'h', name: 'Home', ownerId: 'local' };
  const whereSearch = () => screen.getByLabelText('Add a place');

  it('browse-first: focus shows all UNTAGGED places A–Z; a tagged one is excluded; Escape closes (0089)', async () => {
    LOCATIONS = [GARAGE, HOME]; // Garage, Home
    TASKS = [task('a', 'Alpha', { locationIds: ['g'] })]; // Garage already tagged
    render(<App />);
    await openDetail('Alpha');

    const input = whereSearch();
    expect(screen.queryAllByRole('button', { name: /^Add location / })).toHaveLength(0); // closed until focus
    fireEvent.focus(input);
    // Only Home shows (Garage is tagged); browse-all, no typing, and it would be A–Z if more remained.
    const rows = screen.getAllByRole('button', { name: /^Add location / });
    expect(rows.map((b) => b.textContent)).toEqual(['Home']);

    fireEvent.keyDown(input, { key: 'Escape' }); // Escape closes the popup
    expect(screen.queryAllByRole('button', { name: /^Add location / })).toHaveLength(0);
  });

  it('matches locations case-insensitively and tags by REPLACING the set (0060)', async () => {
    LOCATIONS = [GARAGE, HOME];
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.focus(whereSearch());
    fireEvent.change(whereSearch(), { target: { value: 'gar' } }); // lowercase query, 'Garage' value
    fireEvent.click(screen.getByRole('button', { name: /Add location Garage/i }));
    expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { locationIds: ['g'] } });
  });

  it('multi-select APPENDS to the current set', async () => {
    LOCATIONS = [GARAGE, HOME];
    TASKS = [task('a', 'Alpha', { locationIds: ['g'] })];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.focus(whereSearch());
    fireEvent.change(whereSearch(), { target: { value: 'home' } });
    fireEvent.click(screen.getByRole('button', { name: /Add location Home/i }));
    expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { locationIds: ['g', 'h'] } });
  });

  it('does not offer an already-tagged location as a suggestion', async () => {
    LOCATIONS = [GARAGE];
    TASKS = [task('a', 'Alpha', { locationIds: ['g'] })];
    render(<App />);
    await openDetail('Alpha');
    fireEvent.focus(whereSearch());
    fireEvent.change(whereSearch(), { target: { value: 'gar' } });
    expect(screen.queryByRole('button', { name: /Add location Garage/i })).toBeNull();
  });

  it('removes a tag by sending the REMAINING set, not the removed one', async () => {
    LOCATIONS = [GARAGE, HOME];
    TASKS = [task('a', 'Alpha', { locationIds: ['g', 'h'] })];
    render(<App />);
    await openDetail('Alpha');
    fireEvent.click(screen.getByRole('button', { name: /Remove location Garage/i }));
    expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { locationIds: ['h'] } });
  });

  it('offers Create ONLY when NOTHING matches — the MIRROR IMAGE of the Requires picker (0061)', async () => {
    // Requires (above) offers Create even when something matches; here a match SUPPRESSES it,
    // because a matching location is almost certainly the one you want and near-duplicates are
    // the failure mode. The two tests sit together on purpose.
    LOCATIONS = [GARAGE];
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.focus(whereSearch());
    fireEvent.change(whereSearch(), { target: { value: 'gar' } }); // matches 'Garage'
    expect(screen.getByRole('button', { name: /Add location Garage/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /and tag it/i })).toBeNull(); // NO Create on a match

    fireEvent.change(whereSearch(), { target: { value: 'Basement' } }); // matches nothing
    expect(screen.getByRole('button', { name: /Create Basement and tag it/i })).toBeTruthy();
  });

  it('Create is a TWO-CALL create-and-tag: POST /locations, then PATCH the task (0061)', async () => {
    LOCATIONS = [];
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await openDetail('Alpha');

    fireEvent.change(whereSearch(), { target: { value: 'Basement' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Basement and tag it/i }));

    await waitFor(() =>
      expect(sent).toContainEqual({ url: '/api/locations', method: 'POST', body: { name: 'Basement' } }),
    );
    // The tag uses the id the create returned ('loc-new' from the stub).
    expect(sent).toContainEqual({ url: '/api/tasks/a', method: 'PATCH', body: { locationIds: ['loc-new'] } });
  });

  it('PARTIAL FAILURE — create ok, tag fails: SURFACES the error, never a silent no-op (0061)', async () => {
    // The two-call asymmetry with the atomic Requires endpoint. The orphan is an empty location
    // (deletable in the manager); the failure must be visible, not swallowed.
    LOCATIONS = [];
    TASKS = [task('a', 'Alpha')];
    patchTaskFails = true;
    render(<App />);
    await openDetail('Alpha');

    fireEvent.change(whereSearch(), { target: { value: 'Basement' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Basement and tag it/i }));

    // The location WAS created (the first call went through)...
    await waitFor(() =>
      expect(sent).toContainEqual({ url: '/api/locations', method: 'POST', body: { name: 'Basement' } }),
    );
    // ...and the failed tag is announced INSIDE the modal — a banner behind a showModal() dialog
    // would be invisible, which would make "surfaced, not silent" a lie (0061 error-routing).
    const alert = await within(document.querySelector('dialog')!).findByRole('alert');
    expect(alert.textContent).toMatch(/tagging the task failed/i);
  });
});
