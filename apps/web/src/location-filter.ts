/**
 * The client-side location context-filter (ADR 0060).
 *
 * Location is the odd gate: unlike not-before and dependency it filters ALL views, its per-task
 * data is already on the wire (`locationIds`), and its safe default is SHOW MORE — so it lives
 * here, on the client, not on the server (0060's divergence from 0052). This module is the ONE
 * definition of "does this task belong in the current context", used by Lists, Today and Upcoming
 * alike — the same single-predicate discipline as isGated (0059). Three inline copies would drift.
 */

/** "Everywhere" — the filter off. A sentinel, never a real location id. */
export const EVERYWHERE = 'everywhere';

/** localStorage keys for the pinned context. Persistence is client-only (0060). */
export const LOCATION_PINNED_KEY = 'deck.location.pinned';
export const LOCATION_ID_KEY = 'deck.location.id';

/**
 * The one predicate. A task shows in a context when the filter is off, when it is doable ANYWHERE
 * (no tags), or when it carries the selected location. The untagged-always-shows clause is the
 * one 0060 rests on: a task doable anywhere is doable here.
 */
export function matchesLocation(task: { locationIds: string[] }, selected: string): boolean {
  if (selected === EVERYWHERE) return true;
  if (task.locationIds.length === 0) return true;
  return task.locationIds.includes(selected);
}

export const filterByLocation = <T extends { locationIds: string[] }>(
  tasks: T[],
  selected: string,
): T[] => tasks.filter((t) => matchesLocation(t, selected));

/** The persisted selection at load: the pinned id, or Everywhere. Storage can throw; never crash. */
export function readStoredLocation(): { location: string; pinned: boolean } {
  try {
    const pinned = localStorage.getItem(LOCATION_PINNED_KEY) === '1';
    const id = localStorage.getItem(LOCATION_ID_KEY);
    return pinned && id ? { location: id, pinned: true } : { location: EVERYWHERE, pinned: false };
  } catch {
    return { location: EVERYWHERE, pinned: false };
  }
}

/**
 * Pinned persists both the flag and the id; unpinned clears them, so next load resets to
 * Everywhere. A silently-stale filter is a lying view (0060) — reset-by-default is the safe floor.
 */
export function storeLocation(location: string, pinned: boolean): void {
  try {
    if (pinned) {
      localStorage.setItem(LOCATION_PINNED_KEY, '1');
      localStorage.setItem(LOCATION_ID_KEY, location);
    } else {
      localStorage.setItem(LOCATION_PINNED_KEY, '0');
      localStorage.removeItem(LOCATION_ID_KEY);
    }
  } catch {
    // Unstorable (private mode): the filter still works this session, it just is not remembered.
  }
}
