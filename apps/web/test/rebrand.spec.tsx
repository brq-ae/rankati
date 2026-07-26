// @vitest-environment happy-dom
import type { List } from '@rankati/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import TodayView from '../src/TodayView';
import { authStatusResponse } from './support/auth';

/**
 * The Rankati rebrand (ADR 0081): the app's user-facing NAME is Rankati, but the card-game MECHANIC
 * vocabulary ("beat the deck", deck of cards, Arena, duel) stays. This guards both directions — the
 * brand renamed AND the mechanic NOT over-renamed.
 */
const LISTS: List[] = [{ id: 'l1', name: 'Work', ownerId: 'local' }];

let authed: boolean;
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) {
        return Promise.resolve(authStatusResponse({ needsSetup: false, authenticated: authed }));
      }
      const body = url.includes('/api/lists') ? LISTS : [];
      return Promise.resolve({ ok: true, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response);
    }),
  );
}

describe('the Rankati rebrand — app NAME vs card MECHANIC (ADR 0081)', () => {
  beforeEach(() => {
    localStorage.clear();
    authed = true;
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('the app header shows the brand "Rankati", never "Deck"', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Rankati', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Deck' })).toBeNull();
  });

  it('the login screen shows no brand "Deck"', async () => {
    authed = false;
    render(<App />);
    await screen.findByRole('heading', { name: /log in/i });
    expect(screen.queryByText(/Deck/)).toBeNull();
  });

  it('MECHANIC preserved: the win state still reads "beat the deck" (not over-renamed to Rankati)', () => {
    render(
      <TodayView
        hand={[]}
        state="won"
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
        headOut={[]}
        comingUp={[]}
      />,
    );
    expect(screen.getByText(/beat the deck/i)).toBeTruthy();
  });
});
