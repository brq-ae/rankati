import type {
  AvailabilityWindow,
  Effort,
  Impact,
  List,
  Location,
  ResetMode,
  Task,
  TaskTier,
  UpdateChecklistItemDto,
} from '@rankati/shared';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Arena, { type ArenaHandle } from './Arena';
import ConfirmDestructive from './ConfirmDestructive';
import CreateAccount from './CreateAccount';
import Login from './Login';
import { setCurrentView } from './error-reporter';
import { isListDuelable } from './duelable';
import Clock from './Clock';
import LocationFilter from './LocationFilter';
import SettingsModal from './SettingsModal';
import TaskDetail, { type CloneCommit, type CloneSeed } from './TaskDetail';
import TaskRow from './TaskRow';
import { blockedTasks } from './blocked';
import ThemeToggle from './ThemeToggle';
import TodayView from './TodayView';
import UpcomingView from './UpcomingView';
import RoutinesView from './RoutinesView';
import { useMode } from './mode';
import { usePalette } from './palette';
import { localDay, localTime, waitingBreakdown } from './local-day';
import {
  EVERYWHERE,
  filterByLocation,
  readStoredLocation,
  storeLocation,
} from './location-filter';
import { type Thresholds, readThresholds, storeThresholds } from './effort-prefs';
import {
  composeHand,
  dealAgain,
  handState,
  readHandSize,
  readHeldIds,
  storeHandSize,
  storeHeldIds,
} from './hand';
import { comingUp } from './coming-up';
import { type PinDays, computePin, snoozeSpanMs, DEFAULT_PIN_DAYS } from './pin';
import type { HeadOutGroup } from './TodayView';
import { TICK_GRACE_MS } from './tick';
import {
  addChecklistItem,
  completeTask,
  getAuthStatus,
  logout,
  setUnauthorizedHandler,
  createList,
  createLocation,
  createRequiredTask,
  createTask,
  deleteChecklistItem,
  deleteList,
  deleteLocation,
  deleteTask,
  getLists,
  getLocations,
  getPinConfig,
  getRankedTasks,
  getTodayTasks,
  getUpcomingTasks,
  mergeLocations,
  resetApp,
  setPinConfig,
  snoozePin,
  unsnoozePin,
  updateChecklistItem,
  updateList,
  updateLocation,
  updateTask,
} from './api';

/** Sentinel for the "create a new list" option in the picker. */
const NEW_LIST = '__new__';

export default function App() {
  const [lists, setLists] = useState<List[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  /** The managed location set — the dropdown's options and the filter's name resolver (0060). */
  const [locations, setLocations] = useState<Location[]>([]);
  /**
   * The selected context and whether it is pinned (ADR 0060). Initialised FROM storage, not to
   * Everywhere then corrected, so a pinned filter is live on the very first paint. If the pinned
   * id no longer exists it is reset once locations load (the effect below) — a deleted location
   * must not leave a stale filter.
   */
  const initialLocation = readStoredLocation();
  const [location, setLocation] = useState<string>(initialLocation.location);
  const [pinnedLocation, setPinnedLocation] = useState<boolean>(initialLocation.pinned);
  /** Whether the Settings modal (theme picker + locations) is open (ADRs 0061, 0062). */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The gated read (0052). A separate request because it answers a different question. */
  const [today, setToday] = useState<Task[]>([]);
  /** Dated tasks not yet near enough for Today — the Upcoming tab (ADR 0058). */
  const [upcoming, setUpcoming] = useState<Task[]>([]);
  /**
   * The free BLOCK the Today hand is dealt against — the fit term (ADR 0072). EPHEMERAL by design:
   * plain React state, `undefined` (Any) at mount, NEVER read from storage — so a reload always
   * resets to Any and can never show a hand dealt against a block the owner is no longer in. Only
   * its ordinal reaches the server (getTodayTasks). `blockRef` mirrors it so the focus/visibility
   * refetch (registered once) re-reads the CURRENT block rather than the first render's `undefined`.
   */
  const [block, setBlock] = useState<Effort | undefined>(undefined);
  const blockRef = useRef<Effort | undefined>(undefined);
  /** The display-only minute thresholds that LABEL the block picker (0072). Persisted client-side;
   *  never sent to the server — only the ordinal block crosses the wire. */
  const [thresholds, setThresholds] = useState<Thresholds>(() => readThresholds());
  /**
   * The dealt hand's held set (ADR 0074) — client-side memory. `null` = never dealt (auto-deal the
   * first hand); an array = the held ids (even `[]`, which reads as WON). MUTATED ONLY by the auto-deal
   * effect and Deal again — never by a refresh or a completion — which is what makes "no auto-fill"
   * structural. The hand size N is a localStorage pref, edited in Settings ("Cards per hand").
   */
  const [heldIds, setHeldIds] = useState<string[] | null>(() => readHeldIds());
  const [handSize, setHandSize] = useState<number>(() => readHandSize());
  /** The four impact-pin day-knobs (ADRs 0075, 0086) — the two fuses + two snooze spans, now SERVER-side.
   *  Fetched with the Today data (defaults until it arrives / on a failed fetch); passed to computePin
   *  (fuses) + the snooze span. The snooze STATE is no longer a separate client map — it is derived from
   *  each task's `pinSnoozedUntil`, which rides on every task read. */
  const [pinDays, setPinDays] = useState<PinDays>(DEFAULT_PIN_DAYS);
  const [title, setTitle] = useState('');
  const [listId, setListId] = useState('');
  const [newListName, setNewListName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * The auth gate (ADR 0076). On load we ask GET /api/auth/status and land in one of four states:
   * 'loading' (deciding), 'setup' (first run → create account), 'login' (has an account, no session),
   * or 'authed' (the app). A 401 mid-use drops us back to 'login' via the api.ts seam.
   */
  const [authState, setAuthState] = useState<'loading' | 'setup' | 'login' | 'authed'>('loading');
  const enterApp = (): void => {
    setLoading(true); // the main data load runs on the transition into 'authed'
    setAuthState('authed');
  };
  const [busy, setBusy] = useState(false);
  /**
   * Which task's detail view is open, and what to give focus back to when it closes.
   *
   * The trigger is remembered rather than assumed: closing a modal should return you to the
   * control you opened it from, and after a re-render React cannot be relied on to have kept
   * that element focused (ADR 0054).
   */
  const [detailId, setDetailId] = useState<string | null>(null);
  /**
   * The list the per-list `(+)` is adding to (ADR 0073), or null. When set, the detail modal opens
   * in ADD MODE for that list — create-on-first-title. Distinct from `detailId` (editing an
   * existing task); the two are never both set. Cleared on close and on the flip to live-edit.
   */
  const [addingToList, setAddingToList] = useState<string | null>(null);
  /**
   * When set, the detail modal opens as a CLONE (ADR 0079): add-mode seeded from a source task's
   * scalars (title blank). Nothing is created until a title is committed — a bail leaves no orphan.
   */
  const [cloneSeed, setCloneSeed] = useState<CloneSeed | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  /**
   * The source task's relations captured when a clone opens (ADR 0079), applied on commit after the
   * new task is created. Not editable pre-commit (unlike the scalar seed), so they live in a ref, not
   * form state. Checklist texts only — items are recreated fresh (unticked), never their ids/done.
   */
  const cloneRelations = useRef<{ locationIds: string[]; dependsOn: string[]; checklistTexts: string[] } | null>(null);

  /**
   * Ticks waiting out their grace period: task id -> the moment the ring empties (ADR 0055).
   *
   * In App rather than the row, because commit-on-leave must commit ALL pending ticks from
   * ONE handler, and a handler cannot reach into five rows' private state.
   *
   * State for rendering, and MIRRORED INTO A REF for the listeners. That is not belt and
   * braces: a `visibilitychange` listener registered once closes over the FIRST render's
   * state and would see an empty Map forever — it would fire, find nothing, and commit
   * nothing, silently. Commit-on-leave would be dead code that looks alive.
   */
  const [pending, setPending] = useState<Map<string, number>>(() => new Map());
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [editListName, setEditListName] = useState('');
  /** Which list is pending deletion — drives the ConfirmDestructive dialog (v0.13, ADR 0064). */
  const [deletingListId, setDeletingListId] = useState<string | null>(null);
  /** A pending reset (clear-tasks / factory) — drives its own typed-DELETE dialog (v0.13, ADR 0064). */
  const [resetPending, setResetPending] = useState<{ mode: ResetMode; keepSampleData: boolean } | null>(
    null,
  );
  const { mode, toggle } = useMode();
  const { theme, setTheme } = usePalette();
  /** The app root, read by the meta[theme-color] sync so the browser chrome matches the canvas. */
  const appRef = useRef<HTMLDivElement>(null);
  /** The Arena's imperative handle, so a list's VS button can start a scoped session (v0.12). */
  const arenaRef = useRef<ArenaHandle>(null);
  // Keep the browser chrome (mobile address bar) matching the active canvas — theme AND mode
  // aware (ADR 0062). Read from the LIVE token via the rendered root, so there is no colour map
  // to drift from the CSS; the inline script set a first-paint default and this corrects it on
  // every change. Runs after useMode/usePalette have applied .dark / data-theme (declared above),
  // so the computed canvas is already the new one.
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const canvas = appRef.current && getComputedStyle(appRef.current).backgroundColor;
    if (meta && canvas) meta.setAttribute('content', canvas);
  }, [mode, theme]);
  /**
   * Which screen. A `useState`, not a router: two views do not justify the dependency, and
   * nothing here needs URLs, history, or deep links yet. Revisit when a third view or a
   * shareable link appears.
   *
   * Opens on 'lists' — v0.3 ADDS a view, it does not move where the app starts.
   */
  const [view, setView] = useState<'lists' | 'today' | 'upcoming' | 'routines'>('lists');
  // Best-effort "current screen" for the error reporter's context (ADR 0078).
  useEffect(() => setCurrentView(view), [view]);
  /**
   * The Lists-tab filter (ADR 0069, extended by 0071): All (the grid), Blocked (a flat
   * cross-list read of gated tasks), or Waiting on people (a flat cross-list read of
   * needsHand-flagged tasks — the same filter-not-lane shape, for a soft label rather than a
   * gate).
   */
  const [listFilter, setListFilter] = useState<'all' | 'blocked' | 'waiting' | 'needs-details'>('all');

  /**
   * TWO reads, because there are two questions (0052).
   *
   *   getRankedTasks — everything, ungated: what Lists shows, gates and all.
   *   getTodayTasks  — only what is playable, gated by the server against OUR local day.
   *
   * The gate is applied in exactly one of them, which is what keeps 0052 structural rather
   * than something a component remembers. Both come back ranked (0050).
   */
  async function refresh(): Promise<List[]> {
    const [nextLists, nextTasks, nextToday, nextUpcoming, nextLocations, nextPinConfig] = await Promise.all([
      getLists(),
      getRankedTasks(),
      // Day AND time: the full clock context both scored reads owe the server (0052, 0070) —
      // the window gate is judged by OUR clock, and the server fail-closes without it. The Today
      // read also carries the current free block (0072) via the ref, so a focus/overnight refetch
      // keeps the hand dealt against the block the owner set — Upcoming never takes it.
      getTodayTasks(localDay(), localTime(), blockRef.current),
      getUpcomingTasks(localDay(), localTime()),
      getLocations(),
      // Server-side pin config (ADR 0086), fetched in the same pass so the pin computes with it. A failed
      // fetch falls back to the DEFAULTS so the pin still works rather than the whole load breaking.
      getPinConfig().catch(() => DEFAULT_PIN_DAYS),
    ]);
    setLists(nextLists);
    setTasks(nextTasks);
    setToday(nextToday);
    setUpcoming(nextUpcoming);
    setLocations(nextLocations);
    setPinDays(nextPinConfig);
    return nextLists;
  }

  // Decide the auth gate on load (ADR 0076): status routes to setup / login / the app.
  useEffect(() => {
    getAuthStatus()
      .then((s) => setAuthState(s.needsSetup ? 'setup' : s.authenticated ? 'authed' : 'login'))
      .catch(() => setAuthState('login')); // if status itself fails, the login screen is the safe landing
  }, []);

  // Session expiry (ADR 0076): any request that 401s mid-use drops us back to login rather than a
  // broken app. Registered once; api.ts fires it, so no per-call site has to know.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setLoading(true);
      setAuthState('login');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // The main data load runs only once authenticated — before that the reads would 401. It re-runs on
  // every entry into 'authed' (first login, or after a mid-use 401 and re-login).
  useEffect(() => {
    if (authState !== 'authed') return;
    refresh()
      .then((nextLists) => setListId(nextLists[0]?.id ?? NEW_LIST))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [authState]);

  /**
   * A deleted (or merged-away) location must not leave a stale filter (ADR 0060): once locations
   * load, if the selected id is no longer among them, fall back to Everywhere and forget it. This
   * is the same "no silently-stale filter" principle as reset-by-default, applied to the pinned id.
   */
  useEffect(() => {
    if (location === EVERYWHERE) return;
    if (locations.length > 0 && !locations.some((l) => l.id === location)) {
      setLocation(EVERYWHERE);
      setPinnedLocation(false);
      storeLocation(EVERYWHERE, false);
    }
  }, [locations, location]);

  /**
   * A deleted list must not leave the add-task form pointing at an id that no longer exists (v0.13,
   * ADR 0064) — the same "no silently-stale reference" principle as the location filter above. If the
   * selected list is gone, fall back to the first remaining list, or to "+ New list…" when there are
   * NONE — which IS the zero-lists empty state, where creating a list is the only next move. Without
   * this, deleting the selected (or last) list strands the form: the new-list-name input stays hidden
   * and Add would POST a task to a list that no longer exists.
   */
  useEffect(() => {
    if (loading) return;
    if (listId === NEW_LIST) return;
    if (!lists.some((l) => l.id === listId)) {
      setListId(lists[0]?.id ?? NEW_LIST);
    }
  }, [lists, listId, loading]);

  /** Change context. If pinned, the new place is remembered too — the pin holds "keep my context". */
  const onChangeLocation = (next: string) => {
    setLocation(next);
    if (pinnedLocation) storeLocation(next, true);
  };

  /** Toggle persistence. Pinning remembers the current place; unpinning forgets it (next load resets). */
  const onTogglePin = () => {
    setPinnedLocation((wasPinned) => {
      const nowPinned = !wasPinned;
      storeLocation(location, nowPinned);
      return nowPinned;
    });
  };

  /**
   * Commit any pending tick when the page goes away (ADR 0055).
   *
   * `visibilitychange -> hidden` is what actually fires when a phone locks or a tab is
   * switched; `pagehide` is the close. Both commit, because leaving without undoing is the
   * absence of a correction, not an interruption — the opposite of an abandoned duel session
   * (0048), and deliberately so.
   *
   * Registered ONCE and reads `pendingRef`, never `pending`: a listener closing over the
   * first render's state would find an empty Map forever and commit nothing, silently.
   */
  useEffect(() => {
    const flush = () => {
      for (const id of [...pendingRef.current.keys()]) void commitTick(id, 'leave');
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Re-read when you come back to the tab.
   *
   * Today is computed against the day we last asked on (0052). Leave Rankati open overnight
   * and it would still be showing yesterday's gates — the common case, since that is what
   * an app left open all night does. Refetching on focus costs one request and fixes it.
   *
   * KNOWN LIMIT: midnight passing while you are actively staring at the screen does not
   * refresh. That needs a timer, and a timer is a background thing that runs forever to
   * serve an edge nobody has hit. Noted rather than built.
   */
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState === 'hidden') return;
      void refresh().catch((e: Error) => setError(e.message));
    };
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', reread);
    return () => {
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', reread);
    };
    // refresh is re-created each render but closes over nothing that changes its behaviour;
    // re-subscribing on every render would be churn for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onAdd(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      let target = listId;
      if (listId === NEW_LIST) {
        target = (await createList({ name: newListName })).id;
        setNewListName('');
      }
      await createTask({ title, listId: target });
      setTitle('');
      await refresh();
      setListId(target);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Forget a pending tick. Used by undo, and by commit once it has taken over. */
  function clearPending(id: string): void {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setPending((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  /**
   * Commit a tick — the ONLY place the server is told (ADR 0055). Never at tap.
   *
   * Two callers, two honest failure contracts, named rather than pretended to be one:
   *
   *   'ring'  — you are looking at it. A failure REVERTS (clearing pending un-ticks the
   *             circle, because the task itself was never changed) and shows the error. No
   *             retry: tapping again is the retry, and it is yours to make.
   *   'leave' — the page is going. There is nobody to show an error to and no state to
   *             revert, so failure is unknowable by construction. `keepalive` maximises
   *             delivery; if it never lands, the server never recorded it and the next load
   *             honestly shows the task not-done.
   */
  async function commitTick(id: string, mode: 'ring' | 'leave'): Promise<void> {
    clearPending(id);
    try {
      const updated = await completeTask(id, mode === 'leave');
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      // It has retired from the Arena and left Today (0047) — both reads moved.
      if (mode === 'ring') await refresh();
    } catch (e) {
      if (mode === 'ring') setError((e as Error).message);
      // 'leave': there is no one left to tell.
    }
  }

  /**
   * The circle. Tapping an untouched task starts the grace period; tapping a pending one
   * takes it back — and taking it back is not a reversal, because nothing was ever written.
   */
  function onToggleTick(id: string): void {
    if (pendingRef.current.has(id)) {
      clearPending(id); // no request was ever made, so there is nothing to undo
      return;
    }
    setError(null);
    const timer = setTimeout(() => void commitTick(id, 'ring'), TICK_GRACE_MS);
    timers.current.set(id, timer);
    setPending((prev) => new Map(prev).set(id, Date.now() + TICK_GRACE_MS));
  }

  /**
   * Set or clear the not-before gate (0052).
   *
   * The native date input's value IS 'YYYY-MM-DD' — the wire format — so nothing is parsed
   * and no Date is constructed, which is exactly how no timezone gets in. Empty means the
   * field was cleared, and null is the only way to remove a gate.
   */
  async function onSetNotBefore(id: string, value: string): Promise<void> {
    setError(null);
    try {
      await updateTask(id, { notBefore: value === '' ? null : value });
      // The row and the detail view both call this one handler (0054); each closes its own
      // editor, which is why nothing is closed from here any more.
      await refresh(); // a gate change moves a task between the two reads
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onSetList(id: string, listId: string): Promise<void> {
    setError(null);
    try {
      await updateTask(id, { listId });
      // The task moves to another list section, so both reads change — refresh, like a gate.
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onSetDue(id: string, value: string): Promise<void> {
    setError(null);
    try {
      // Unlike not-before, due does NOT gate — it never moves a task between the two reads
      // (ADR 0056) — so updating the one task in place is enough; no full refresh.
      const updated = await updateTask(id, { due: value === '' ? null : value });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onSetTier(id: string, tier: TaskTier): Promise<void> {
    setError(null);
    try {
      const updated = await updateTask(id, { tier });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Set or clear the effort bucket (ADR 0072). null = untagged, the only way back to fitting any
   * block. NOT a gate — like onSetTier and onSetNeedsHand it never moves a task between the reads,
   * so it patches the one task in place. A tag only reshapes the Today HAND, and only when a block
   * is set; the hand re-ranks on the next block change or refresh, the same least-cost shape 0056
   * accepts for tier. `tasks` is what the detail modal reads, so the picker reflects the new value.
   */
  async function onSetEffort(id: string, effort: Effort | null): Promise<void> {
    setError(null);
    try {
      const updated = await updateTask(id, { effort });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Set the declared impact level (ADR 0075). Drives ONLY the safety-net pin, never ranking — so it
   * never moves a task between reads; patched in place like onSetEffort. The pin (computed client-side
   * from impact + createdAt) recomputes on the next render from the updated `tasks`.
   */
  async function onSetImpact(id: string, impact: Impact): Promise<void> {
    setError(null);
    try {
      const updated = await updateTask(id, { impact });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Choose the free block (ADR 0072). Ephemeral: it updates the ref (so a later refetch keeps it)
   * and re-fetches ONLY Today with the new ordinal — the hand re-ranks, a too-big task sinks. It is
   * never persisted, so it dies with the session. Upcoming and Lists are untouched (fit is Today-only).
   */
  async function onSelectBlock(next: Effort | undefined): Promise<void> {
    blockRef.current = next;
    setBlock(next);
    setError(null);
    try {
      setToday(await getTodayTasks(localDay(), localTime(), next));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Edit the display-only effort thresholds (ADR 0072). Persisted client-side and used only to
   *  LABEL the picker — never sent to the server, which ranks on the ordinal bucket alone. */
  function onSetThresholds(next: Thresholds): void {
    setThresholds(next);
    storeThresholds(next);
  }

  /** Set the dealt-hand size N (ADR 0074). Re-caps the shown hand on the next render — smaller shows
   *  fewer held, larger leaves empty slots for Deal again. It never auto-grows (heldIds is untouched). */
  function onSetHandSize(n: number): void {
    setHandSize(n);
    storeHandSize(n);
  }

  /**
   * Set the soft "needs a hand" marker (ADR 0071). Unlike onSetAvailabilityWindow, this is
   * NEVER a gate — it never moves a task between the Lists/Today/Upcoming reads — so it
   * patches the one task in place, the same least-cost shape as onSetTier, not a full refresh.
   */
  async function onSetNeedsHand(id: string, needsHand: boolean): Promise<void> {
    setError(null);
    try {
      const updated = await updateTask(id, { needsHand });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Set or clear the availability window (ADR 0070). null = Anytime, the only way back to
   * ungated. Refreshes like onSetNotBefore, NOT like onSetTier: a window is a GATE, so
   * changing it moves the task between the two reads — a local patch of `tasks` would leave
   * Today showing (or hiding) it wrongly until the next full refresh.
   */
  async function onSetAvailabilityWindow(id: string, value: AvailabilityWindow | null): Promise<void> {
    setError(null);
    try {
      await updateTask(id, { availabilityWindow: value });
      await refresh(); // a gate change moves a task between the two reads
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function openDetail(id: string): void {
    detailTrigger.current = document.activeElement as HTMLElement | null;
    setError(null); // a stale banner error must not lead into the modal (0061 error-routing)
    setAddingToList(null);
    setCloneSeed(null);
    setDetailId(id);
  }

  /** The per-list `(+)` — open the detail modal in ADD MODE for `listId` (ADR 0073). No task is
   *  created yet; the first non-empty title does that (onCreateInList). */
  function openAdd(listId: string): void {
    detailTrigger.current = document.activeElement as HTMLElement | null;
    setError(null);
    setDetailId(null);
    setCloneSeed(null);
    setAddingToList(listId);
  }

  /**
   * The clone icon (ADR 0079) — open an add-mode SEEDED from `source`'s scalars, title blank. Same
   * modal (add-mode) as the `(+)`, just seeded; no task exists until a title is committed.
   */
  function openClone(source: Task): void {
    detailTrigger.current = document.activeElement as HTMLElement | null;
    setError(null);
    setDetailId(null);
    setCloneSeed({
      listId: source.listId,
      effort: source.effort,
      tier: source.tier,
      impact: source.impact,
      availabilityWindow: source.availabilityWindow,
      notBefore: source.notBefore,
      needsHand: source.needsHand,
    });
    // Relations are copied as-is on commit (ADR 0079) — capture them now; checklist as texts (recreated
    // unticked). A fresh clone earns its own rating: rating/duelCount are never copied.
    cloneRelations.current = {
      locationIds: source.locationIds,
      dependsOn: source.dependsOn,
      checklistTexts: source.checklist.map((c) => c.text),
    };
    setAddingToList(source.listId);
  }

  /**
   * Commit a clone (ADR 0079): create the task (title + list), then apply the seeded scalars in one
   * PATCH. `needsDetails` is OMITTED on purpose — sending any other field clears 0073's create-stamp,
   * so the clone lands unflagged (born detailed). Then flip to live-edit on the new id, like the (+).
   */
  async function onCreateClone(title: string, seed: CloneCommit): Promise<void> {
    setError(null);
    try {
      const created = await createTask({ title, listId: seed.listId });
      await updateTask(created.id, {
        effort: seed.effort,
        tier: seed.tier,
        impact: seed.impact,
        availabilityWindow: seed.availabilityWindow,
        notBefore: seed.notBefore,
        due: seed.due,
        needsHand: seed.needsHand,
      });
      // Then the RELATIONS (ADR 0079), copied from the source via the existing endpoints: the same
      // locations + prerequisite links (a full-set replace), and each checklist item recreated UNTICKED.
      const rel = cloneRelations.current;
      if (rel) {
        const relDto: { locationIds?: string[]; dependsOn?: string[] } = {};
        if (rel.locationIds.length > 0) relDto.locationIds = rel.locationIds;
        if (rel.dependsOn.length > 0) relDto.dependsOn = rel.dependsOn;
        if (Object.keys(relDto).length > 0) await updateTask(created.id, relDto);
        for (const text of rel.checklistTexts) await addChecklistItem(created.id, text);
      }
      await refresh();
      cloneRelations.current = null;
      setCloneSeed(null);
      setAddingToList(null);
      setDetailId(created.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Add mode's create-on-first-title (ADR 0073): create the task, then FLIP this same modal to
   * live-edit on the new id. Re-keying TaskDetail by the id re-mounts it with fresh state from the
   * created task (title, list, every field), so the rest fills in exactly as editing any task.
   */
  async function onCreateInList(title: string, listId: string): Promise<void> {
    setError(null);
    try {
      const created = await createTask({ title, listId });
      await refresh(); // the new task must be in `tasks` before detailTask resolves it
      setAddingToList(null);
      setDetailId(created.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Toggle the "needs details" flag (ADR 0073) — the modal flag icon. An explicit set the server
   *  honors (it wins, never force-cleared). Not a gate, so patch in place like onSetNeedsHand. */
  async function onSetNeedsDetails(id: string, needsDetails: boolean): Promise<void> {
    setError(null);
    try {
      const updated = await updateTask(id, { needsDetails });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function closeDetail(): void {
    setDetailId(null);
    setAddingToList(null);
    setCloneSeed(null);
    cloneRelations.current = null;
    setError(null); // the error belonged to the modal; do not leak it to the banner on close
    detailTrigger.current?.focus();
  }

  /** Rename a list — the v0.1 gap. Mirrors renaming a task exactly. */
  async function onRenameList(id: string): Promise<void> {
    setError(null);
    try {
      const updated = await updateList(id, { name: editListName });
      setLists((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setEditingListId(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Set or clear what a task waits for (ADR 0053).
   *
   * `dependsOn` REPLACES the set, so removing means sending the rest. The server does the
   * real refusing — self-dependency, unknown ids, and cycles come back as 400s with a
   * message worth showing, so nothing is re-implemented here to guess at them.
   */
  /**
   * Create a prerequisite and link it — one call, one transaction (ADR 0054).
   *
   * Not create-then-link from here: a create that succeeded followed by a link that failed
   * would strand an orphan task in a list nobody chose, and the cleanup could fail too.
   */
  async function onCreateRequired(id: string, title: string, listId: string): Promise<void> {
    setError(null);
    try {
      await createRequiredTask(id, { title, listId });
      await refresh(); // a new task AND a gate change — both reads move
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onSetDependsOn(id: string, dependsOn: string[]): Promise<void> {
    setError(null);
    try {
      await updateTask(id, { dependsOn });
      // Whoever is editing closes its own picker; this handler only writes (0054).
      await refresh(); // a gate change moves a task between the two reads
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Replace the task's location set (ADR 0060), same shape as onSetDependsOn. */
  async function onSetTaskLocations(id: string, locationIds: string[]): Promise<void> {
    setError(null);
    try {
      await updateTask(id, { locationIds });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * The readiness checklist (ADR 0071) — soft, NEVER a gate. Unlike onSetNotBefore/onSetAvailabilityWindow,
   * none of these three ever move a task between the Lists/Today/Upcoming reads, so each patches
   * just the one task's `checklist` in place — the same least-cost shape as onSetDue/onSetTier,
   * not a full refresh.
   */
  async function onAddChecklistItem(taskId: string, text: string): Promise<void> {
    setError(null);
    try {
      const item = await addChecklistItem(taskId, text);
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, checklist: [...t.checklist, item] } : t)),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onUpdateChecklistItem(
    taskId: string,
    itemId: string,
    dto: UpdateChecklistItemDto,
  ): Promise<void> {
    setError(null);
    try {
      const updated = await updateChecklistItem(itemId, dto);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, checklist: t.checklist.map((c) => (c.id === updated.id ? updated : c)) }
            : t,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onDeleteChecklistItem(taskId: string, itemId: string): Promise<void> {
    setError(null);
    try {
      await deleteChecklistItem(itemId);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, checklist: t.checklist.filter((c) => c.id !== itemId) } : t,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Create a location and tag this task with it (ADR 0061). TWO calls, deliberately NOT atomic —
   * unlike onCreateRequired's single endpoint (0054, built because a stranded TASK was costly). If
   * the create succeeds but the tag fails, the orphan is an EMPTY location — visible and deletable
   * in the manager — so the failure is SURFACED (an error, never a silent no-op) and locations are
   * refreshed so the new one appears; it is not worth an atomic endpoint. 0061 records why.
   */
  async function onCreateAndTagLocation(id: string, name: string): Promise<void> {
    setError(null);
    let created;
    try {
      created = await createLocation({ name });
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    try {
      const current = tasks.find((t) => t.id === id)?.locationIds ?? [];
      await updateTask(id, { locationIds: [...current, created.id] });
    } catch (e) {
      // Create succeeded, tag failed — do NOT leave the modal looking untouched.
      setError(
        `Created “${created.name}”, but tagging the task failed: ${(e as Error).message}. ` +
          'The location exists — add it again, or remove it in Manage locations.',
      );
    }
    await refresh(); // the new location shows in the picker even if the tag did not land
  }

  const locNameOf = (id: string) => locations.find((l) => l.id === id)?.name ?? 'this location';

  /** Add a location from the manager (ADR 0061). A case-insensitive duplicate surfaces as a 400. */
  async function onCreateLocation(name: string): Promise<void> {
    setError(null);
    try {
      await createLocation({ name });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onRenameLocation(id: string, name: string): Promise<void> {
    setError(null);
    try {
      await updateLocation(id, { name });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Delete a list and, by cascade, its tasks (v0.13, ADR 0064). The confirmation is graduated by
   * the FULL task count for the list — `tasks`, never `visibleTasks` — so an active location filter
   * can never shrink a 6-task list into plain-confirm territory (the same undercount failure the
   * delete/merge warnings guard against; the filter-active test pins it). The dialog itself is
   * ConfirmDestructive, rendered from `deletingListId`.
   */
  async function onDeleteList(id: string): Promise<void> {
    setError(null);
    try {
      await deleteList(id);
      setDeletingListId(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * The two reset triggers (v0.13, ADR 0064). Each closes Settings and opens the typed-DELETE
   * confirmation (rather than nesting one dialog inside another). The "keep sample data" choice is
   * captured here, at the moment of the click, so it survives Settings closing.
   */
  function onClearTasks(): void {
    setSettingsOpen(false);
    setResetPending({ mode: 'clear-tasks', keepSampleData: true });
  }
  function onFactoryReset(keepSampleData: boolean): void {
    setSettingsOpen(false);
    setResetPending({ mode: 'factory', keepSampleData });
  }

  /**
   * Run the confirmed reset. `confirm: "DELETE"` is sent to satisfy the server's machine-floor guard
   * — the same word the user typed, passed through. On a FACTORY reset the pinned location filter is
   * cleared CLIENT-SIDE: factory regenerates location ids, so a kept pin would dangle (ADR 0064's
   * "clear the pin when its target may not survive"). clear-tasks leaves locations alone, so its pin
   * stays. Then refresh; if the reset emptied every list, the deleted-list effect lands the empty state.
   */
  async function onConfirmReset(): Promise<void> {
    if (!resetPending) return;
    const { mode, keepSampleData } = resetPending;
    setError(null);
    try {
      await resetApp({ mode, keepSampleData, confirm: 'DELETE' });
      if (mode === 'factory') {
        setLocation(EVERYWHERE);
        setPinnedLocation(false);
        storeLocation(EVERYWHERE, false);
      }
      setResetPending(null);
      await refresh();
    } catch (e) {
      setResetPending(null);
      setError((e as Error).message);
    }
  }

  /**
   * Delete a location (ADR 0061). The warning is computed from the FULL `tasks` list — never
   * `visibleTasks` — so an active location filter can NEVER shrink the count of what a delete
   * touches. Same window.confirm shape as onDelete's "unblock N tasks", and the same reason: a
   * destructive effect that happens at a distance is said out loud first. Names the tasks that
   * would lose their ONLY location and so start appearing in every context.
   */
  async function onDeleteLocation(id: string): Promise<void> {
    const name = locNameOf(id);
    const tagged = tasks.filter((t) => t.locationIds.includes(id));
    const onlyHere = tagged.filter((t) => t.locationIds.length === 1);
    if (tagged.length > 0) {
      const noun = tagged.length === 1 ? 'task is' : 'tasks are';
      let message = `${tagged.length} ${noun} tagged “${name}”.`;
      if (onlyHere.length > 0) {
        const names = onlyHere.map((t) => t.title).join(', ');
        const w = onlyHere.length === 1 ? 'would lose its only location and start' : 'would lose their only location and start';
        message += ` ${onlyHere.length} ${w} showing everywhere: ${names}.`;
      }
      message += ' Delete anyway?';
      if (!window.confirm(message)) return;
    }
    setError(null);
    try {
      await deleteLocation(id);
      await refresh(); // the deleted-id effect resets the header filter if it pointed here
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Merge one location into another and delete the source (ADR 0061). Atomic on the server; the
   * warning here — count of tasks that move — is computed from the FULL `tasks` list, so a filter
   * cannot undercount it. If the source was the header's active filter, deleting it triggers the
   * deleted-id reset (Step 5) on the next refresh.
   */
  async function onMergeLocations(sourceId: string, targetId: string): Promise<void> {
    const src = locNameOf(sourceId);
    const tgt = locNameOf(targetId);
    const moving = tasks.filter((t) => t.locationIds.includes(sourceId)).length;
    const noun = moving === 1 ? 'task' : 'tasks';
    if (!window.confirm(`Move ${moving} ${noun} from “${src}” to “${tgt}” and delete “${src}”?`)) return;
    setError(null);
    try {
      await mergeLocations({ sourceId, targetId });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Renaming, from wherever it is asked for.
   *
   * The row and the detail view both call THIS — not their own copy (0054). The title is a
   * parameter because the draft belongs to whichever component is editing it.
   */
  async function onRename(id: string, title: string): Promise<void> {
    setError(null);
    try {
      const updated = await updateTask(id, { title });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onDelete(id: string): Promise<void> {
    // Deleting a blocker unblocks its dependents — the backend cascades unconditionally
    // (0053), which is right, but it happens at a distance: a task can appear in Today
    // because of something you did on this screen. Say so first rather than let it be a
    // surprise. The count is a filter over data already held, not a request.
    const unblocks = tasks.filter((t) => t.dependsOn.includes(id)).length;
    if (unblocks > 0) {
      const noun = unblocks === 1 ? 'task' : 'tasks';
      if (!window.confirm(`This will unblock ${unblocks} ${noun}. Delete anyway?`)) return;
    }

    setError(null);
    try {
      await deleteTask(id);
      await refresh(); // dependents may now be playable
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * The resolver for the inherited-urgency subtext (ADR 0059): id -> task, over the FULL task
   * list — NOT the location-filtered view. A row's source may be filtered out of sight (a Home
   * deadline behind the Office task that unblocks it, 0060) and must still resolve; building this
   * from a `visible*` list instead is the exact refactor that would silently break the subtext.
   */
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  /**
   * The location context-filter (ADR 0060), applied through the ONE predicate to all three views.
   * Lists, Today and Upcoming each render their `visible*` list; a sabotage of filterByLocation
   * reddens all three at once. tasksById above stays full on purpose (the subtext seam).
   */
  const visibleTasks = useMemo(() => filterByLocation(tasks, location), [tasks, location]);
  /** The Blocked filter's read (ADR 0069) — over the location-filtered set, so a set context narrows it. */
  const blocked = useMemo(() => blockedTasks(visibleTasks), [visibleTasks]);
  /**
   * The "Waiting on people" filter's read (ADR 0071) — same shape as `blocked`: flagged tasks
   * in the location-filtered set. needsHand is a soft label, not a gate, so this predicate is
   * the ONLY thing that decides membership — it must never also hide a task from Today/Lists/
   * the Arena (that would make the label a gate in disguise).
   */
  const waitingOnPeople = useMemo(() => visibleTasks.filter((t) => t.needsHand), [visibleTasks]);
  /**
   * The "needs details" inbox (ADR 0073) — active tasks still flagged unedited-since-creation.
   * Deliberately over the FULL `tasks`, NOT `visibleTasks`: this is a GLOBAL inbox, not a location
   * context, so the header badge count and this flat read do not shrink when a location is pinned
   * (unlike Blocked/Waiting, which are context reads). Done tasks are excluded — they left the flow.
   */
  const needsDetailsTasks = useMemo(
    () => tasks.filter((t) => t.status === 'active' && t.needsDetails),
    [tasks],
  );
  const visibleToday = useMemo(() => filterByLocation(today, location), [today, location]);
  const visibleUpcoming = useMemo(() => filterByLocation(upcoming, location), [upcoming, location]);
  /**
   * The dealt hand (ADR 0074) — composed CLIENT-SIDE over the location-filtered playable set: the
   * held cards still playable here, ranked, capped at N. `heldIds ∩ visibleToday`, so location
   * reshapes the hand. `autoDealt` is non-null only on the first-ever load (nothing held yet).
   */
  const handComposition = useMemo(
    () => composeHand(heldIds, visibleToday, handSize),
    [heldIds, visibleToday, handSize],
  );
  const hand = handComposition.cards;
  const handView = handState(hand.length, visibleToday.length);
  // Deal again does something only when there are empty slots AND more playable to pull in.
  const canDeal = hand.length < handSize && visibleToday.length > hand.length;

  // The pin snooze STATE (ADR 0086) — derived from each task's pinSnoozedUntil (server-side), which rides
  // on every read; no separate fetch or client store. A snoozed task is suppressed by computePin.
  const snoozes = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of visibleToday) if (t.pinSnoozedUntil) m[t.id] = Date.parse(t.pinSnoozedUntil);
    return m;
  }, [visibleToday]);

  /**
   * The impact safety-net pin (ADRs 0075, 0086) — computed CLIENT-SIDE from what we already have: the
   * playable set the hand is dealt from (`visibleToday`), the ids currently SHOWN in the hand (so a task
   * already dealt never pins), each task's declared impact + created date, plus the SERVER's config (fuses)
   * and snoozes (derived above). One fires or none. It drives nothing in the ranking — it only surfaces here.
   */
  const pin = computePin(
    visibleToday.map((t) => ({ id: t.id, impact: t.impact, createdAt: Date.parse(t.createdAt) })),
    new Set(visibleToday.map((t) => t.id)),
    hand.map((t) => t.id),
    snoozes, // a snoozed task is suppressed; the next-most-overdue takes its place
    Date.now(),
    pinDays, // the server's configured fuses (highFuseDays / mediumFuseDays)
  );
  const pinTask = pin ? (visibleToday.find((t) => t.id === pin.id) ?? null) : null;
  // "high-impact · 8 days" — the level + how long it has been sitting (ADR 0075).
  const pinReason = pin ? `${pin.level}-impact · ${pin.ageDays} ${pin.ageDays === 1 ? 'day' : 'days'}` : '';

  /**
   * Dismiss the shown pin for its level's span (ADRs 0075, 0086). OPTIMISTIC: stamp the task's
   * `pinSnoozedUntil` locally so the pin hides IMMEDIATELY (the derived snooze suppresses it; the
   * next-most-overdue takes its place), then POST it — syncing the server's instant on success, reverting on
   * failure. Dismissing a nag has no round-trip lag.
   */
  function onSnoozePin(): void {
    if (!pin) return;
    const id = pin.id;
    const stamp =
      (value: string | null) =>
      (t: Task): Task =>
        t.id === id ? { ...t, pinSnoozedUntil: value } : t;
    const optimistic = new Date(Date.now() + snoozeSpanMs(pin.level, pinDays)).toISOString();
    setToday((prev) => prev.map(stamp(optimistic)));
    setTasks((prev) => prev.map(stamp(optimistic)));
    snoozePin(id)
      .then((updated) => {
        setToday((prev) => prev.map(stamp(updated.pinSnoozedUntil)));
        setTasks((prev) => prev.map(stamp(updated.pinSnoozedUntil)));
      })
      .catch(() => {
        setToday((prev) => prev.map(stamp(null)));
        setTasks((prev) => prev.map(stamp(null)));
      });
  }

  /**
   * Edit the four impact-pin day-knobs (ADRs 0075, 0086) — saved SERVER-side. Reflect the server's VALIDATED
   * result (a bad field defaulted to its own default, not the whole save rejected); revert on failure.
   */
  function onSetPinDays(next: PinDays): void {
    const previous = pinDays;
    setPinDays(next);
    setPinConfig(next)
      .then(setPinDays)
      .catch(() => setPinDays(previous));
  }

  /**
   * "When you head out" (ADR 0074) — playable errands at OTHER places: `today \ visibleToday`, so
   * they only appear when a context is pinned (at Everywhere nothing is hidden). Grouped by place; a
   * task tagged to two places shows under each. These left the hand because they are not doable HERE.
   */
  const headOut = useMemo<HeadOutGroup[]>(() => {
    if (location === EVERYWHERE) return [];
    const here = new Set(visibleToday.map((t) => t.id));
    const groups = new Map<string, Task[]>();
    for (const task of today) {
      if (here.has(task.id)) continue; // in the hand's context — not "away"
      for (const locId of task.locationIds) {
        if (locId === location) continue; // its matching-here tag (shouldn't occur, but guard)
        const name = locations.find((l) => l.id === locId)?.name ?? 'Somewhere';
        (groups.get(name) ?? groups.set(name, []).get(name)!).push(task);
      }
    }
    return [...groups.entries()].map(([name, tasks]) => ({ name, tasks }));
  }, [today, visibleToday, location, locations]);

  /**
   * "Coming up" (ADR 0074) — the GLOBAL gated set: active tasks in NEITHER read (today ∪ upcoming),
   * soonest-to-unlock first. Uses the un-filtered server reads, NOT the location-filtered ones, so it
   * is global regardless of the pinned context. This is what the old gated-counts strip became.
   */
  const comingUpItems = useMemo(
    () =>
      comingUp(
        tasks,
        new Set(today.map((t) => t.id)),
        new Set(upcoming.map((t) => t.id)),
        localDay(),
        localTime(),
      ),
    [tasks, today, upcoming],
  );

  // Auto-deal the FIRST hand (ADR 0074): once something is playable and nothing has been dealt yet,
  // persist the top-N as the held set. Fires once — afterwards heldIds is an array and autoDealt is
  // null, so a refresh/completion never re-deals. `heldIds` is mutated only here and by Deal again.
  useEffect(() => {
    if (handComposition.autoDealt !== null) {
      setHeldIds(handComposition.autoDealt);
      storeHeldIds(handComposition.autoDealt);
    }
  }, [handComposition.autoDealt]);

  /** Deal again (ADR 0074) — a top-up: fill the empty (freed) slots with the next-best not-held,
   *  leaving held/undone cards in place. The ONLY place besides auto-deal that mutates the held set. */
  function onDealAgain(): void {
    const next = dealAgain(heldIds, visibleToday, handSize);
    setHeldIds(next);
    storeHeldIds(next);
  }
  const locationName =
    location === EVERYWHERE ? null : (locations.find((l) => l.id === location)?.name ?? null);

  /**
   * What the gates are holding back, and why (0052, 0053) — derived from the FILTERED set so the
   * Today tab's "N waiting" matches what the filter shows, not the whole board.
   */
  // Day AND time, like the reads themselves: the outside-hours part re-derives the window
  // check for display (0070), and it needs the same clock the server judged with.
  const waiting = waitingBreakdown(
    visibleTasks,
    new Set(visibleToday.map((t) => t.id)),
    localDay(),
    localTime(),
  );

  /**
   * Fresh from `tasks`, never a snapshot taken when the modal opened: an edit made inside
   * it must be visible inside it. If the task is deleted while open, this becomes undefined
   * and the modal simply unmounts.
   */
  const detailTask = detailId === null ? null : (tasks.find((t) => t.id === detailId) ?? null);

  const canSubmit =
    title.trim().length > 0 &&
    (listId !== NEW_LIST ? listId.length > 0 : newListName.trim().length > 0) &&
    !busy;

  // The auth gate (ADR 0076) — after all hooks, so the Rules of Hooks hold. Until status resolves we
  // paint the bare canvas (no flash of app or login); then setup / login / the app.
  if (authState === 'loading') return <div className="min-h-dvh bg-canvas" />;
  if (authState === 'setup') return <CreateAccount onAuthenticated={enterApp} />;
  if (authState === 'login') return <Login onAuthenticated={enterApp} />;

  return (
    <div ref={appRef} className="min-h-full bg-canvas text-fg">
      {/* The signature brand mark (ADR 0063) — a gradient stripe across the app top. Brand-only
          (CSS-scoped in index.css); absent on Slate/Warm/Clear. Decorative, hence aria-hidden. */}
      <div className="h-2 deck-brandbar" aria-hidden="true" />
      <div className="mx-auto max-w-5xl p-4 sm:p-6">
        <header className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Rankati</h1>
            <p className="text-sm text-muted">v0.32.0 — the shared pin</p>
          </div>
          <div className="flex items-center gap-2">
            {/* The location filter narrows the task views only; routines carry no location, so it is
                hidden on the Routines tab. */}
            {view !== 'routines' && (
              <LocationFilter
                locations={locations}
                value={location}
                pinned={pinnedLocation}
                onChange={onChangeLocation}
                onTogglePin={onTogglePin}
              />
            )}
            {/* The "needs details" inbox badge (ADR 0073) — shown on EVERY tab, only when the
                global active flagged count is > 0. Tapping switches to Lists and opens the flat
                needs-details read. A count, deliberately NOT a bell: it reassures ("N still to
                flesh out"), it does not push. */}
            {needsDetailsTasks.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setView('lists');
                  setListFilter('needs-details');
                }}
                aria-label={`${needsDetailsTasks.length} ${needsDetailsTasks.length === 1 ? 'task needs' : 'tasks need'} details`}
                title="Needs details — tasks not yet fleshed out"
                className="touch-manipulation rounded-sm px-2 py-2 text-sm font-medium text-body ring-1 ring-field hover:bg-hover"
              >
                <span aria-hidden="true">✎ {needsDetailsTasks.length}</span>
              </button>
            )}
            {/* Settings — theme picker + locations — beside the mode toggle (ADRs 0061, 0062). */}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setSettingsOpen(true);
              }}
              aria-label="Settings"
              title="Settings"
              className="touch-manipulation rounded-sm px-3 py-2 text-sm font-medium text-body ring-1 ring-field hover:bg-hover"
            >
              <span aria-hidden="true">⚙</span>
              <span className="sr-only">Settings</span>
            </button>
            <ThemeToggle mode={mode} onToggle={toggle} />
          </div>
        </header>

        {/* Three tabs. `aria-current` is what tells a screen reader which one you are on —
            colour alone says nothing to one. */}
        <nav className="mb-5 flex gap-1" aria-label="Views">
          {(['lists', 'today', 'upcoming', 'routines'] as const).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setView(name)}
              aria-current={view === name ? 'page' : undefined}
              className={`touch-manipulation rounded-xl px-3 py-2 text-sm font-medium capitalize ${
                view === name
                  ? 'bg-primary text-on-primary'
                  : 'text-body hover:bg-hover-strong'
              }`}
            >
              {name}
            </button>
          ))}
        </nav>

        {view === 'today' ? (
          <TodayView
            hand={hand}
            state={handView}
            onDealAgain={onDealAgain}
            canDeal={canDeal}
            onToggleTick={onToggleTick}
            pinTask={pinTask}
            pinReason={pinReason}
            onSnoozePin={onSnoozePin}
            onOpenDetail={openDetail}
            lists={lists}
            waiting={waiting}
            pending={pending}
            tasksById={tasksById}
            locationName={locationName}
            hiddenByFilter={today.length - visibleToday.length}
            block={block}
            onSelectBlock={onSelectBlock}
            thresholds={thresholds}
            headOut={headOut}
            comingUp={comingUpItems}
          />
        ) : view === 'upcoming' ? (
          <UpcomingView
            tasks={visibleUpcoming}
            lists={lists}
            tasksById={tasksById}
            locationName={locationName}
            hiddenByFilter={upcoming.length - visibleUpcoming.length}
          />
        ) : view === 'routines' ? (
          <RoutinesView on={localDay()} />
        ) : (
          <>
            {/* Committing a sitting reshuffles the ranking, so reload it in its new order. */}
            <Arena
              ref={arenaRef}
              onCommitted={() => void refresh().catch((e: Error) => setError(e.message))}
            />

            {/* Add a task. Stacks in portrait, spreads in landscape. */}
            <form
              onSubmit={onAdd}
              className="mb-6 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-edge"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What needs doing?"
                  aria-label="Task title"
                  className="min-w-0 flex-1 rounded-xl border border-field px-3 py-2 text-base outline-none focus:border-primary"
                />
                <select
                  value={listId}
                  onChange={(e) => setListId(e.target.value)}
                  aria-label="List"
                  className="rounded-xl border border-field bg-card px-3 py-2 text-base outline-none focus:border-primary sm:w-44"
                >
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                  <option value={NEW_LIST}>+ New list…</option>
                </select>
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="touch-manipulation rounded-xl bg-primary px-4 py-2 text-base font-medium text-on-primary deck-glow disabled:opacity-40 sm:w-28"
                >
                  {busy ? 'Adding…' : 'Add'}
                </button>
              </div>

              {listId === NEW_LIST && (
                <input
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  placeholder="New list name"
                  aria-label="New list name"
                  className="mt-3 w-full rounded-xl border border-field px-3 py-2 text-base outline-none focus:border-primary sm:w-64"
                />
              )}
            </form>

            {/* Only when NO modal is open. A <dialog> opened with showModal() renders in the top
                layer, above any normal z-index, so a banner here would sit BEHIND it — invisible.
                An error from a modal action is shown inside that modal instead (0061). */}
            {error && !settingsOpen && detailId === null && (
              <p
                role="alert"
                className="mb-4 rounded-xl bg-error-bg px-4 py-3 text-sm text-error ring-1 ring-error-edge"
              >
                {error}
              </p>
            )}

            {loading ? (
              <p className="text-muted">Loading…</p>
            ) : lists.length === 0 ? (
              <p className="text-muted">No lists yet — add a task to create one.</p>
            ) : (
              <>
                {/* All | Blocked | Waiting on people filter (ADR 0069, extended by 0071) — below
                    the add-form, above the lists. Blocked and Waiting on people each swap the
                    grid for a flat, cross-list read — the second for gated tasks, the third for
                    needsHand-flagged ones (a soft label, never a gate — 0071). */}
                <div className="mb-4 flex gap-1" role="group" aria-label="Task filter">
                  {(['all', 'blocked', 'waiting'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setListFilter(f)}
                      aria-pressed={listFilter === f}
                      className={`touch-manipulation rounded-xl px-3 py-1.5 text-sm font-medium ${
                        listFilter === f ? 'bg-primary text-on-primary' : 'text-body hover:bg-hover-strong'
                      }`}
                    >
                      {f === 'all'
                        ? 'All'
                        : f === 'blocked'
                          ? `Blocked${blocked.length ? ` (${blocked.length})` : ''}`
                          : `Waiting on people${waitingOnPeople.length ? ` (${waitingOnPeople.length})` : ''}`}
                    </button>
                  ))}
                </div>

                {listFilter === 'needs-details' ? (
                  // The needs-details flat read (ADR 0073) — entered via the header badge, exited by
                  // any of the three toggle segments (none of which equals 'needs-details', so the
                  // toggle shows none pressed; the badge is the active indicator). GLOBAL, not
                  // location-scoped. Each card OPENS the task's detail, the place to flesh it out —
                  // and the first field edit clears the flag, so the task leaves this view live.
                  needsDetailsTasks.length === 0 ? (
                    <p className="text-sm text-faint">Nothing needs details — every task is fleshed out.</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {needsDetailsTasks.map((task) => (
                        <li key={task.id}>
                          <button
                            type="button"
                            onClick={() => openDetail(task.id)}
                            aria-label={`Add details to ${task.title}`}
                            className="w-full rounded-2xl bg-card p-3 text-left shadow-sm ring-1 ring-edge hover:bg-hover"
                          >
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="min-w-0 truncate font-medium text-strong">{task.title}</span>
                              <span className="shrink-0 text-xs text-faint">
                                {lists.find((l) => l.id === task.listId)?.name}
                              </span>
                            </div>
                            <span className="mt-0.5 block text-xs text-faint">
                              <span aria-hidden="true">✎ </span>needs details
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : listFilter === 'blocked' ? (
                  blocked.length === 0 ? (
                    <p className="text-sm text-faint">
                      Nothing is blocked — every task’s prerequisites are done.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {blocked.map(({ task, waitingOn }) => (
                        <li key={task.id} className="rounded-2xl bg-card p-3 shadow-sm ring-1 ring-edge">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="min-w-0 truncate font-medium text-strong">{task.title}</p>
                            <span className="shrink-0 text-xs text-faint">
                              {lists.find((l) => l.id === task.listId)?.name}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-notice">
                            waiting on → {waitingOn.map((w) => w.title).join(', ')}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )
                ) : listFilter === 'waiting' ? (
                  waitingOnPeople.length === 0 ? (
                    <p className="text-sm text-faint">No tasks are waiting on a person.</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {waitingOnPeople.map((task) => (
                        <li key={task.id} className="rounded-2xl bg-card p-3 shadow-sm ring-1 ring-edge">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="min-w-0 truncate font-medium text-strong">{task.title}</p>
                            <span className="shrink-0 text-xs text-faint">
                              {lists.find((l) => l.id === task.listId)?.name}
                            </span>
                          </div>
                          {/* Same plain, never-amber treatment as the row marker (0071) — this
                              filter's membership already says "waiting"; the marker restates it
                              here only for a consistent glance, not as a second, contradicting cue. */}
                          <p className="mt-0.5 text-xs text-faint">
                            <span aria-hidden="true">🤝 </span>needs a hand
                          </p>
                        </li>
                      ))}
                    </ul>
                  )
                ) : (
                  <>
                {/* When the filter hides tasks, say so — Lists must not look emptier than it is
                    with no visible cause (ADR 0060, the "N waiting" principle). */}
                {locationName && tasks.length - visibleTasks.length > 0 && (
                  <p className="mb-3 text-xs text-notice">
                    Showing <span className="font-medium">{locationName}</span> —{' '}
                    {tasks.length - visibleTasks.length}{' '}
                    {tasks.length - visibleTasks.length === 1 ? 'task' : 'tasks'} hidden. Switch to
                    Everywhere to see all.
                  </p>
                )}
                {/* One column in portrait, more as width allows (ADR 0030). */}
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {lists.map((list) => {
                    const own = visibleTasks.filter((t) => t.listId === list.id);
                  return (
                    <section
                      key={list.id}
                      className="rounded-2xl bg-card p-4 shadow-sm ring-1 ring-edge"
                    >
                      <h2 className="mb-3 flex items-baseline justify-between gap-2">
                        {editingListId === list.id ? (
                          <input
                            value={editListName}
                            onChange={(e) => setEditListName(e.target.value)}
                            onBlur={() => onRenameList(list.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') onRenameList(list.id);
                              if (e.key === 'Escape') setEditingListId(null);
                            }}
                            aria-label={`Rename list ${list.name}`}
                            autoFocus
                            className="min-w-0 flex-1 rounded-xl border border-field px-2 py-1 text-base font-medium outline-none focus:border-primary"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingListId(list.id);
                              setEditListName(list.name);
                            }}
                            aria-label={`Rename list ${list.name}`}
                            className="min-w-0 flex-1 truncate text-left font-medium"
                          >
                            {list.name}
                          </button>
                        )}
                        <div className="flex shrink-0 items-baseline gap-2">
                          <span className="text-xs text-faint">
                            {own.filter((t) => t.status === 'active').length} active
                          </span>
                          {/* Duel this list (v0.12). Disabled unless it has >= 2 ACTIVE tasks, judged
                              over the FULL `tasks` set — NOT `visibleTasks` — so an active location
                              filter can't disable a list the server would still duel (same discipline
                              as the delete/merge warnings above; the agreement test pins it). The
                              reachable disabled REASON is the "N active" count beside it: it reads 0 or
                              1 exactly when VS is disabled — no hover needed. `VS` is literal, not a
                              swords/lightning glyph, which read as "fight" not "compare these two". */}
                          <button
                            type="button"
                            disabled={!isListDuelable(tasks, list.id)}
                            onClick={() => {
                              arenaRef.current?.start(list.id, list.name);
                              arenaRef.current?.scrollIntoView();
                            }}
                            aria-label={`Duel ${list.name}`}
                            title={
                              isListDuelable(tasks, list.id)
                                ? `Duel ${list.name}`
                                : 'Needs 2 active tasks to duel'
                            }
                            className="touch-manipulation rounded-sm bg-primary px-2 py-0.5 text-xs font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            VS
                          </button>
                          {/* Delete this list (v0.13). Opens ConfirmDestructive; the confirmation is
                              graduated by the FULL task count, computed where the dialog is rendered. */}
                          <button
                            type="button"
                            onClick={() => setDeletingListId(list.id)}
                            aria-label={`Delete list ${list.name}`}
                            className="touch-manipulation rounded-sm px-1.5 py-0.5 text-xs text-faint hover:text-danger"
                          >
                            Delete
                          </button>
                        </div>
                      </h2>

                      {own.length === 0 ? (
                        <p className="text-sm text-faint">Empty</p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {own.map((task) => (
                            <TaskRow
                              key={task.id}
                              task={task}
                              tasks={tasks}
                              onToggleTick={onToggleTick}
                              pendingUntil={pending.get(task.id)}
                              onDelete={onDelete}
                              onOpenDetail={openDetail}
                            />
                          ))}
                        </ul>
                      )}

                      {/* Per-list full-detail add (ADR 0073) — opens the detail modal in add mode
                          for THIS list, create-on-first-title. Distinct from the top quick-add form,
                          which is untouched fast capture. Bottom-right, out of the way of the rows. */}
                      <div className="mt-3 flex justify-end">
                        <button
                          type="button"
                          onClick={() => openAdd(list.id)}
                          aria-label={`Add a task to ${list.name}`}
                          title={`Add a task to ${list.name}`}
                          className="touch-manipulation rounded-full bg-primary px-2.5 py-0.5 text-lg font-semibold leading-none text-on-primary"
                        >
                          +
                        </button>
                      </div>
                    </section>
                  );
                })}
                </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* Rendered here rather than inside a row: one dialog, not one per task, and it
            survives the row re-rendering underneath it. `detailTask` is looked up fresh from
            `tasks`, so an edit made inside the modal shows in the modal (0054). The `key` is the
            id (or 'add' before one exists), so the add→edit flip RE-MOUNTS with fresh state from
            the created task — the whole modal, not a partial sync (ADR 0073). */}
        {(detailTask || addingToList !== null) && (
          <TaskDetail
            key={detailId ?? 'add'}
            task={detailTask}
            addListId={addingToList}
            cloneSeed={cloneSeed}
            onClone={openClone}
            onCreateClone={onCreateClone}
            onCreateInList={onCreateInList}
            onSetNeedsDetails={onSetNeedsDetails}
            tasks={tasks}
            lists={lists}
            onClose={closeDetail}
            onRename={onRename}
            onSetList={onSetList}
            onSetNotBefore={onSetNotBefore}
            onSetDue={onSetDue}
            onSetTier={onSetTier}
            onSetAvailabilityWindow={onSetAvailabilityWindow}
            onSetEffort={onSetEffort}
            onSetImpact={onSetImpact}
            thresholds={thresholds}
            onSetNeedsHand={onSetNeedsHand}
            onSetDependsOn={onSetDependsOn}
            onCreateRequired={onCreateRequired}
            onAddChecklistItem={onAddChecklistItem}
            onUpdateChecklistItem={onUpdateChecklistItem}
            onDeleteChecklistItem={onDeleteChecklistItem}
            locations={locations}
            onSetLocations={onSetTaskLocations}
            onCreateAndTagLocation={onCreateAndTagLocation}
            error={error}
          />
        )}

        {settingsOpen && (
          <SettingsModal
            theme={theme}
            mode={mode}
            onSelectTheme={setTheme}
            thresholds={thresholds}
            onSetThresholds={onSetThresholds}
            handSize={handSize}
            onSetHandSize={onSetHandSize}
            pinDays={pinDays}
            onSetPinDays={onSetPinDays}
            locations={locations}
            error={error}
            onClose={() => {
              setError(null);
              setSettingsOpen(false);
            }}
            onCreate={onCreateLocation}
            onRename={onRenameLocation}
            onDelete={onDeleteLocation}
            onMerge={onMergeLocations}
            onClearTasks={onClearTasks}
            onFactoryReset={onFactoryReset}
            onLogout={() => {
              // Best-effort revoke; return to login regardless (ADR 0076).
              void logout().catch(() => undefined);
              setSettingsOpen(false);
              setLoading(true);
              setAuthState('login');
            }}
          />
        )}

        {/* Reset confirmation (v0.13, ADR 0064) — always typed-DELETE (blast radius = everything).
            The counts come from the FULL tasks/lists, never a filtered view. */}
        {resetPending &&
          (() => {
            const isFactory = resetPending.mode === 'factory';
            const n = tasks.length;
            const taskPhrase = `${n} ${n === 1 ? 'task' : 'tasks'}`;
            return (
              <ConfirmDestructive
                title={isFactory ? 'Factory reset?' : 'Clear all tasks?'}
                confirmLabel={isFactory ? 'Factory reset' : 'Clear tasks'}
                requireTyped
                onConfirm={() => void onConfirmReset()}
                onCancel={() => setResetPending(null)}
              >
                {isFactory
                  ? `This deletes all ${taskPhrase} and every list, and resets locations to the four defaults` +
                    `${resetPending.keepSampleData ? ', then restores the sample lists and tasks' : ' (no lists or tasks)'}. ` +
                    'Your theme is kept. This cannot be undone.'
                  : `This deletes all ${taskPhrase} and their duel history. Your lists and locations stay. This cannot be undone.`}
              </ConfirmDestructive>
            );
          })()}

        {/* List-delete confirmation (v0.13, ADR 0064). Graduated by the FULL task count for the list
            — `tasks`, never `visibleTasks` — so a location filter can never shrink a >5-task list into
            a single-click plain confirm. requireTyped flips at exactly >5 (5 plain, 6 typed). */}
        {deletingListId &&
          (() => {
            const dl = lists.find((l) => l.id === deletingListId);
            if (!dl) return null;
            const count = tasks.filter((t) => t.listId === deletingListId).length;
            return (
              <ConfirmDestructive
                title={`Delete “${dl.name}”?`}
                confirmLabel="Delete list"
                requireTyped={count > 5}
                onConfirm={() => void onDeleteList(deletingListId)}
                onCancel={() => setDeletingListId(null)}
              >
                {count === 0
                  ? `This deletes “${dl.name}”. It has no tasks.`
                  : `This deletes “${dl.name}” and its ${count} ${count === 1 ? 'task' : 'tasks'}. This cannot be undone.`}
              </ConfirmDestructive>
            );
          })()}

        {/* A diagnostic readout on every screen: the server's UTC beside your local time.
            That gap is precisely why the Today read makes the client send its own day
            rather than trusting the server's clock (ADR 0052). */}
        <Clock />
      </div>
    </div>
  );
}
