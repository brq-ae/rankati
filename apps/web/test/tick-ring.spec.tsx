// @vitest-environment happy-dom
import type { List, Task } from '@rankati/shared';
import { authStatusResponse } from './support/auth';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { TICK_GRACE_MS } from '../src/tick';

/**
 * The tick-undo ring (ADR 0055).
 *
 * Fake timers throughout: the whole feature is "what has NOT been sent yet", and a test that
 * waited fifteen real seconds would be untrue to run and slow enough that nobody would.
 *
 * WHAT THIS CANNOT PROVE: the ring's animation. happy-dom does not paint, so that it winds
 * down visibly is eye-checked, as v0.3's no-flash was. Everything the ring MEANS — when the
 * server is told, when it is not, and what happens on leave — is proven here.
 */

const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];

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
let sent: { url: string; method: string; keepalive: boolean }[] = [];
let failNext = false;

function stubFetch(): void {
  sent = [];
  failNext = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return Promise.resolve(authStatusResponse());
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, keepalive: init?.keepalive === true });
        if (failNext) return Promise.reject(new Error('network is down'));
        const id = url.split('/')[3];
        return Promise.resolve({
          ok: true,
          headers: { get: () => null },
          json: () =>
            Promise.resolve({ ...(TASKS.find((t) => t.id === id) ?? TASKS[0]), status: 'done' }),
        } as unknown as Response);
      }
      const body = url.includes('/api/locations') ? [] : url.includes('/api/lists') ? LISTS : url.includes('/api/tasks') ? TASKS : undefined;
      if (body === undefined) throw new Error(`tick-ring.spec: unstubbed request to ${url}`);
      return Promise.resolve({
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      } as unknown as Response);
    }),
  );
}

/** Only the tick commits — the mount's reads are not interesting here. */
const commits = () => sent.filter((r) => r.url.includes('/complete'));
const ready = () => screen.findByRole('button', { name: /start dueling/i });
// findByROLE, not getByRole: the Arena's "start dueling" (what ready() waits for) renders ABOVE the
// loading gate, so a task ROW may not be painted yet when ready() resolves. Waiting for the button
// here closes that window deterministically — the bug that made this file flake under load.
const tick = async (title: string) =>
  fireEvent.click(await screen.findByRole('button', { name: `Complete ${title}` }));
const undo = async (title: string) =>
  fireEvent.click(await screen.findByRole('button', { name: `Undo completing ${title}` }));
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  localStorage.clear();
  stubFetch();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

describe('a tick is PENDING — nothing is written (0055)', () => {
  it('sends NOTHING when you tap', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    // The task looks done immediately...
    expect(screen.getByRole('button', { name: /Undo completing Alpha/i })).toBeTruthy();
    // ...and the server has not been told a thing.
    expect(commits()).toHaveLength(0);
  });

  it('sends nothing at 14 seconds', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await advance(TICK_GRACE_MS - 1_000);
    expect(commits()).toHaveLength(0);
  });

  it('commits EXACTLY ONCE when the ring empties', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await advance(TICK_GRACE_MS);

    expect(commits()).toHaveLength(1);
    expect(commits()[0]).toMatchObject({ url: '/api/tasks/a/complete', method: 'PATCH' });
    // Not a leave: there is someone looking at it.
    expect(commits()[0]?.keepalive).toBe(false);
  });

  it('does not commit twice if time keeps passing', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await advance(TICK_GRACE_MS * 3);
    expect(commits()).toHaveLength(1);
  });
});

describe('undo — there is nothing to reverse (0055)', () => {
  it('un-ticks, and NO request is ever made', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await advance(10_000);
    await undo('Alpha');

    expect(screen.getByRole('button', { name: `Complete Alpha` })).toBeTruthy();

    // The window passes. Nothing fires, because the timer is gone — not because a
    // cancellation was sent. Nothing was ever written.
    await advance(TICK_GRACE_MS * 2);
    expect(commits()).toHaveLength(0);
  });

  it('a fresh tick after an undo gets a FULL window', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await advance(14_000);
    await undo('Alpha');
    await tick('Alpha');

    await advance(TICK_GRACE_MS - 1_000);
    expect(commits()).toHaveLength(0); // the old 14s did not carry over
    await advance(1_000);
    expect(commits()).toHaveLength(1);
  });
});

describe('rings are independent (0055)', () => {
  it('three ticks are three windows, each committing on its own', async () => {
    TASKS = [task('a', 'Alpha'), task('b', 'Beta'), task('c', 'Gamma')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await advance(5_000);
    await tick('Beta');
    await advance(5_000);
    await tick('Gamma');

    // Alpha is at 10s, Beta at 5s, Gamma at 0.
    expect(commits()).toHaveLength(0);
    await advance(5_000); // Alpha hits 15
    expect(commits().map((r) => r.url)).toEqual(['/api/tasks/a/complete']);
    await advance(5_000); // Beta
    expect(commits()).toHaveLength(2);
    await advance(5_000); // Gamma
    expect(commits().map((r) => r.url).sort()).toEqual([
      '/api/tasks/a/complete',
      '/api/tasks/b/complete',
      '/api/tasks/c/complete',
    ]);
  });

  it('undoing one leaves the others running', async () => {
    TASKS = [task('a', 'Alpha'), task('b', 'Beta')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await tick('Beta');
    await undo('Alpha');
    await advance(TICK_GRACE_MS);

    expect(commits().map((r) => r.url)).toEqual(['/api/tasks/b/complete']);
  });
});

describe('leaving COMMITS — the opposite of an abandoned duel session (0055)', () => {
  it('visibilitychange -> hidden commits immediately, with keepalive', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await advance(3_000); // nowhere near the ring's end

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(commits()).toHaveLength(1);
    // keepalive is what makes this real: a normal fetch during pagehide is likely to be
    // cancelled, and the tick would silently never commit.
    expect(commits()[0]?.keepalive).toBe(true);
  });

  it('does NOT commit when the page merely becomes visible again', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(commits()).toHaveLength(0);
  });

  it('pagehide commits, with keepalive', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(commits()).toHaveLength(1);
    expect(commits()[0]?.keepalive).toBe(true);
  });

  it('commits EVERY pending tick on leave, not just one', async () => {
    // The listener reads a ref, not state. Closing over the first render's Map would find it
    // empty forever and commit nothing — silently.
    TASKS = [task('a', 'Alpha'), task('b', 'Beta'), task('c', 'Gamma')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await tick('Beta');
    await tick('Gamma');
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(commits()).toHaveLength(3);
    expect(commits().every((r) => r.keepalive)).toBe(true);
  });

  it('commits nothing when nothing is pending', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(commits()).toHaveLength(0);
  });

  it('an undone tick is not committed by leaving', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await undo('Alpha');
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(commits()).toHaveLength(0);
  });
});

describe('when the commit fails (0055)', () => {
  it('at ring-end: REVERTS to not-done and shows the error — never a done-but-unsaved ghost', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    failNext = true;
    await advance(TICK_GRACE_MS);

    // The task is genuinely not done — the server never heard. Leaving it ticked would be a
    // lie that a refresh silently corrects.
    //
    // The ENABLED check is what makes this test real. The label alone cannot tell a revert
    // from a ghost: a done task and an untouched one both read "Complete Alpha" — only a
    // PENDING one says "Undo". Asserting the label passed even when the failure path was
    // sabotaged to mark the task done, which is how that was found. `disabled` is the only
    // thing on screen that distinguishes them.
    const circle = screen.getByRole('button', { name: `Complete Alpha` });
    expect(circle.hasAttribute('disabled')).toBe(false); // not done — tappable again
    expect(screen.getByRole('alert').textContent).toMatch(/network is down/i);
  });

  it('does not retry — tapping again is the retry, and it is yours', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    failNext = true;
    await advance(TICK_GRACE_MS);
    expect(commits()).toHaveLength(1);

    // Time passes; nothing tries again on its own.
    await advance(TICK_GRACE_MS * 4);
    expect(commits()).toHaveLength(1);
  });

  it('on leave: fails silently, because there is nobody to tell', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    failNext = true;
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });

    // No error banner: the page is going. The server never recorded it, so the next load
    // honestly shows the task not-done — self-correcting rather than silent-wrong.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the countdown visuals derive from the real deadline, not mount (0055 addendum)', () => {
  /**
   * The bug: the ring's animation was mount-driven, so switching screens restarted it from
   * full while the real commit still fired at the true deadline — it lied about time left.
   * The fix seeks ring AND bar to the deadline via a negative animation-delay. happy-dom does
   * not paint, but it holds the inline style, and that style IS the derivation's output — so
   * "resumed at 13s" vs "restarted at 0" is exactly what we can read here.
   */
  const ring = () => document.querySelector('.deck-ring');
  const bar = () => document.querySelector('.deck-bar');
  const delayMs = (el: Element | null): number => {
    const raw = (el as HTMLElement | null)?.style.animationDelay?.trim() ?? '';
    const m = /^(-?\d+(?:\.\d+)?)ms$/.exec(raw);
    return m ? Number(m[1]) : NaN; // no delay set (the old, buggy ring) -> NaN -> every bound fails
  };
  const show = (name: 'lists' | 'today') =>
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }));

  it('the ring, remounted 13s in after a screen switch, RESUMES — it does not restart full', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    show('today'); // the Lists row and its ring unmount
    await advance(13_000); // the deadline keeps running; the commit has not fired
    show('lists'); // the row remounts, 13s into the window

    // ~13s elapsed -> delay ≈ -13000ms, so only ~2s of ring remains. The bug rendered a fresh
    // full ring here, with no delay at all (delayMs -> NaN, which fails both bounds).
    const d = delayMs(ring());
    expect(d).toBeLessThan(-12_500);
    expect(d).toBeGreaterThan(-13_500);
  });

  it('the bar, MOUNTED 13s into the window, shows ~2s left — same derivation as the ring', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    await advance(13_000);
    show('today'); // Today's bar mounts now, 13s in — and must not start from full either

    const d = delayMs(bar());
    expect(d).toBeLessThan(-12_500);
    expect(d).toBeGreaterThan(-13_500);
  });

  it('ring and bar on one row read the SAME deadline — identical position', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    show('today');
    await advance(7_000);
    show('lists'); // both mount in the same render, at the same instant

    // One deadline in, one position out: they cannot disagree.
    expect(delayMs(ring())).toBe(delayMs(bar()));
    expect(delayMs(ring())).toBeLessThan(0); // and it is a real, non-zero position
  });

  it('commits once at the true 15s even across a screen switch', async () => {
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    await tick('Alpha');
    show('today');
    await advance(10_000);
    show('lists');
    await advance(4_000);
    expect(commits()).toHaveLength(0); // 14s: the remount did not restart the real clock
    await advance(1_000);
    expect(commits()).toHaveLength(1); // 15s: exactly once, screen switches notwithstanding
  });

  it('a tick made in Lists shows a countdown bar in Today — pending is shown, not hidden', async () => {
    // The 0055-addendum framing, made concrete: a pending task is not removed from Today (that
    // would be a client-side second definition of done); it stays, and says it is committing.
    TASKS = [task('a', 'Alpha')];
    render(<App />);
    await ready();

    show('today');
    expect(bar()).toBeNull(); // nothing pending yet
    show('lists');
    await tick('Alpha');
    show('today');

    expect(bar()).not.toBeNull(); // ticked in Lists, still active, so visible AND counting down
    expect(screen.getByText('Alpha')).toBeTruthy(); // still present — not hidden from Today
  });
});
