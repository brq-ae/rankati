import type {
  AvailabilityWindow,
  ChecklistItem,
  Effort,
  Impact,
  List,
  Location,
  Task,
  TaskTier,
  UpdateChecklistItemDto,
} from '@rankati/shared';
import { useEffect, useRef, useState } from 'react';
import { EFFORTS, type Thresholds, bucketLabel } from './effort-prefs';
import { isGated, isWindowOpen, localDay, localTime } from './local-day';
import { TIERS, tierOf } from './tiers';

/**
 * The task detail view (ADR 0054) — the home for richer editing.
 *
 * Attachments, checklists and anything else with more than one field land HERE, not in the
 * row. Deciding that now, while it holds three things, is the point: without an answer every
 * later feature re-litigates "row or modal?" and the row grows until it is a form.
 *
 * It edits through the SAME handlers the row uses. Not kept in sync — the same call. Two
 * paths that agree by discipline eventually disagree; two that are literally one cannot.
 *
 * A native <dialog> with showModal(), not a dependency: it brings the focus trap,
 * Escape-to-close, background inerting and ::backdrop that a hand-rolled overlay
 * reimplements badly.
 *
 * WHAT THE HARNESS CANNOT PROVE: happy-dom implements <dialog>'s STATE — showModal, close,
 * open — but not the browser behaviours built on it. The focus trap and Escape are
 * eye-checked, and recorded that way, exactly as v0.3's no-flash was.
 */

/**
 * The availability-window picker's choices (ADR 0070) — the CLOSED preset set, plus Anytime
 * (null, ungated) as the first and default. The meanings are shown as subtext because the
 * presets are FIXED: "Working hours" is not editable to "9 to 5", so what it means must be
 * legible right where it is chosen. 8:00–14:00 is end-exclusive on the server; the subtext
 * states the window without litigating the boundary.
 */
const WINDOW_CHOICES: readonly {
  value: AvailabilityWindow | null;
  label: string;
  meaning: string;
}[] = [
  { value: null, label: 'Anytime', meaning: 'No window — always doable.' },
  { value: 'working_hours', label: 'Working hours', meaning: 'Mon–Fri, 8:00–14:00' },
  { value: 'workdays', label: 'Workdays', meaning: 'Mon–Fri, any time' },
  { value: 'weekend', label: 'Weekend', meaning: 'Sat–Sun, any time' },
];

/** The declared impact levels (ADR 0075) — None (default), then the two that arm the safety-net pin. */
const IMPACTS: readonly Impact[] = ['none', 'medium', 'high'];
const impactLabel = (i: Impact) => (i === 'none' ? 'None' : i === 'medium' ? 'Medium' : 'High');

/** The source task's scalars a clone opens seeded from (ADR 0079). Title/relations are handled elsewhere. */
export interface CloneSeed {
  listId: string;
  effort: Effort | null;
  tier: TaskTier;
  impact: Impact;
  availabilityWindow: AvailabilityWindow | null;
  notBefore: string | null;
  needsHand: boolean;
}
/** The (possibly tweaked) scalars committed when a clone's first title is entered — adds a fresh `due`. */
export interface CloneCommit extends CloneSeed {
  due: string | null;
}

interface TaskDetailProps {
  /**
   * The task being edited, or `null` in ADD MODE (ADR 0073) — the `(+)` opened this to add to a
   * list before any task exists. In add mode only the title shows; the first non-empty title fires
   * `onCreateInList`, App creates the task and re-keys this modal to the new id, and it re-mounts in
   * normal live-edit mode with fresh state from the created task.
   */
  task: Task | null;
  /** The list the `(+)` is adding to — only meaningful in add mode (task === null). */
  addListId: string | null;
  /**
   * When set, add mode opens as a CLONE (ADR 0079): the scalar pickers open seeded from a source
   * task, editable ("tweak before committing"), title blank. The first non-empty title fires
   * `onCreateClone` carrying the tweaked scalars. Null → the plain blank `(+)` add mode.
   */
  cloneSeed?: CloneSeed | null;
  /** The clone icon — open an add-mode seeded from this task (ADR 0079). Optional: the icon renders
   *  only when wired (App always wires it; isolated picker tests need not). */
  onClone?: (task: Task) => void;
  /** Commit a clone: create a task titled `title` carrying the seeded (tweaked) scalars (ADR 0079). */
  onCreateClone?: (title: string, seed: CloneCommit) => void;
  /** Add mode: create a task in `listId` titled `title`, then flip to live-edit (ADR 0073). */
  onCreateInList: (title: string, listId: string) => void;
  /** Toggle the "needs details" flag (ADR 0073) — the modal flag icon, "revisit later". */
  onSetNeedsDetails: (id: string, value: boolean) => void;
  tasks: Task[];
  lists: List[];
  onClose: () => void;
  onRename: (id: string, title: string) => void;
  /** Move the task to another list — changes only its listId (ADR 0056 follow-on). */
  onSetList: (id: string, listId: string) => void;
  onSetNotBefore: (id: string, value: string) => void;
  /** The deadline, edited through the same PATCH as notBefore (ADRs 0054, 0056). */
  onSetDue: (id: string, value: string) => void;
  /** The declared tier (ADR 0056). */
  onSetTier: (id: string, tier: TaskTier) => void;
  /** The availability window (ADR 0070) — one fixed preset, or null = Anytime = ungated. */
  onSetAvailabilityWindow: (id: string, value: AvailabilityWindow | null) => void;
  /**
   * The effort bucket (ADR 0072) — one of three, or null = untagged (fits any block, never sinks).
   * NOT a gate: like tier it never moves the task between reads, only reshapes the Today hand when a
   * block is set, so App patches it in place.
   */
  onSetEffort: (id: string, value: Effort | null) => void;
  /** The display-only minute thresholds that LABEL the buckets (0072) — client-side, never sent. */
  thresholds: Thresholds;
  /**
   * The declared impact level (ADR 0075) — None/Medium/High, drives only the safety-net pin, never
   * ranking. Two-state like tier: a value sets it. App patches it in place, like onSetEffort.
   */
  onSetImpact: (id: string, value: Impact) => void;
  /**
   * The soft "needs a hand" marker (ADR 0071) — NEVER a gate, unlike onSetNotBefore and
   * onSetAvailabilityWindow above: setting it never moves the task between Today/Lists/Upcoming,
   * so (per App's implementation) it patches the one task in place rather than refreshing.
   */
  onSetNeedsHand: (id: string, value: boolean) => void;
  onSetDependsOn: (id: string, dependsOn: string[]) => void;
  /** Create a prerequisite and link it, atomically (ADR 0054). */
  onCreateRequired: (id: string, title: string, listId: string) => void;
  /** Append a readiness item to the task's checklist (ADR 0071) — soft, never a gate. */
  onAddChecklistItem: (taskId: string, text: string) => void;
  /**
   * Edit one checklist item — text, done, or position. A `position` patch sets ONLY that item's
   * own value (0071); a reorder is two calls, one per swapped item, both made from here.
   */
  onUpdateChecklistItem: (taskId: string, itemId: string, dto: UpdateChecklistItemDto) => void;
  onDeleteChecklistItem: (taskId: string, itemId: string) => void;
  /** The managed location set — the picker's options and name resolver (ADRs 0060, 0061). */
  locations: Location[];
  /** Replace the task's whole location set (ADR 0060) — same three states as dependsOn. */
  onSetLocations: (id: string, locationIds: string[]) => void;
  /**
   * Create a location and tag this task with it (ADR 0061). Two calls, not atomic — unlike
   * onCreateRequired; the asymmetry and why it is proportionate are recorded in 0061 and handled
   * (surfaced, not silent) in App's implementation.
   */
  onCreateAndTagLocation: (id: string, name: string) => void;
  /**
   * Create a NEW list and move this task to it, in one action (v0.34.0). Two calls, not atomic —
   * mirrors onCreateAndTagLocation; App surfaces a create-succeeded-but-move-failed error rather than
   * leaving the modal looking untouched. A case-insensitive name match is handled in TaskDetail (it
   * selects the existing list via onSetList instead, so no duplicate is created).
   */
  onCreateListAndMove: (id: string, name: string) => void;
  /**
   * The App-level error from an action taken in this modal — a cycle-rejection 400 from the
   * Requires picker, a create-and-tag partial failure (0061). Shown INSIDE the dialog: a banner
   * behind a showModal() dialog is in a lower layer and invisible, which would make the
   * partial-failure "surfaced, not silent" a lie.
   */
  error: string | null;
}

export default function TaskDetail({
  task,
  tasks,
  lists,
  addListId,
  cloneSeed,
  onClone,
  onCreateClone,
  onCreateInList,
  onSetNeedsDetails,
  onClose,
  onRename,
  onSetList,
  onSetNotBefore,
  onSetDue,
  onSetTier,
  onSetAvailabilityWindow,
  onSetEffort,
  thresholds,
  onSetImpact,
  onSetNeedsHand,
  onSetDependsOn,
  onCreateRequired,
  onAddChecklistItem,
  onUpdateChecklistItem,
  onDeleteChecklistItem,
  locations,
  onSetLocations,
  onCreateAndTagLocation,
  onCreateListAndMove,
  error,
}: TaskDetailProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Guards a double-create in add mode: Enter and the following blur both fire the title commit, so
  // without this the first non-empty title could POST twice. Once true, further commits no-op until
  // this modal re-mounts on the new id (a fresh instance, fresh ref).
  const creatingRef = useRef(false);
  const [draftTitle, setDraftTitle] = useState(task?.title ?? '');
  /**
   * The picker's state is modal-local: nothing outside needs it, and it resets when the
   * modal closes — a stale query waiting on reopen would be wrong.
   */
  const [query, setQuery] = useState('');
  const [locQuery, setLocQuery] = useState('');
  const [newListId, setNewListId] = useState(task?.listId ?? '');
  /** The add-item box (ADR 0071) — modal-local, like every other picker's typed query above. */
  const [newItemText, setNewItemText] = useState('');
  /**
   * In-flight renames, keyed by item id — NOT one flat draftTitle like the title field above,
   * because more than one row's text can be mid-edit-worthy at once. An id absent here reads
   * the item's own `text` (nothing being edited, or a commit just landed); Escape drops the
   * key rather than writing anything, which is what makes it a cancel.
   */
  const [itemDrafts, setItemDrafts] = useState<Record<string, string>>({});

  // Clone add-mode's local, editable seed (ADR 0079). The modal re-mounts (key flips to 'add') when a
  // clone opens, so these initialise fresh from `cloneSeed`. `due` is NOT cloned — a clone earns a fresh
  // deadline — so it starts blank. Inert unless cloneSeed is set.
  const [seedListId, setSeedListId] = useState(cloneSeed?.listId ?? '');
  const [seedEffort, setSeedEffort] = useState<Effort | null>(cloneSeed?.effort ?? null);
  const [seedTier, setSeedTier] = useState<TaskTier>(cloneSeed?.tier ?? 'normal');
  const [seedImpact, setSeedImpact] = useState<Impact>(cloneSeed?.impact ?? 'none');
  const [seedWindow, setSeedWindow] = useState<AvailabilityWindow | null>(cloneSeed?.availabilityWindow ?? null);
  const [seedNotBefore, setSeedNotBefore] = useState<string | null>(cloneSeed?.notBefore ?? null);
  const [seedDue, setSeedDue] = useState<string | null>(null);
  const [seedNeedsHand, setSeedNeedsHand] = useState(cloneSeed?.needsHand ?? false);

  // showModal() rather than the `open` attribute: only the method gives the top layer, the
  // focus trap, the backdrop and Escape.
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  // ADD MODE (ADR 0073): no task yet — the (+) opened this to add to `addListId`. Show only the
  // title; the first non-empty title creates the task (once — creatingRef), and App re-keys this
  // modal to the new id so it re-mounts in normal live-edit for the rest of the fields. Closed with
  // an empty title creates nothing — no orphan. Everything below this guard assumes a real task.
  // CLONE add-mode (ADR 0079): seeded from a source task, scalar pickers editable, title blank. The
  // first non-empty title creates the task carrying the (tweaked) scalars; an empty-title close creates
  // nothing (0073's no-orphan property). This is the plain add-mode above, seeded instead of empty.
  if (task === null && cloneSeed) {
    const commitClone = () => {
      const title = draftTitle.trim();
      if (!title || creatingRef.current || !onCreateClone) return;
      creatingRef.current = true;
      onCreateClone(title, {
        listId: seedListId,
        effort: seedEffort,
        tier: seedTier,
        impact: seedImpact,
        availabilityWindow: seedWindow,
        notBefore: seedNotBefore,
        due: seedDue,
        needsHand: seedNeedsHand,
      });
    };
    return (
      <dialog
        ref={dialogRef}
        onClose={onClose}
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current?.close();
        }}
        aria-label="Clone a task"
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl bg-card p-0 text-fg shadow-lg backdrop:bg-backdrop"
      >
        <div className="h-2 deck-brandbar rounded-t-2xl" aria-hidden="true" />
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-faint">Clone task</h2>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="Cancel"
              className="touch-manipulation shrink-0 rounded-sm px-2 py-1 text-sm text-faint hover:bg-hover hover:text-strong-hover"
            >
              ✕
            </button>
          </div>
          {error && (
            <p role="alert" className="rounded-xl bg-error-bg px-3 py-2 text-sm text-error ring-1 ring-error-edge">
              {error}
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">New task title</span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- title is the one thing you must type */}
            <input
              autoFocus
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitClone();
                }
              }}
              onBlur={commitClone}
              placeholder="Type a title to create the clone"
              className="rounded-xl border border-field bg-field-bg px-3 py-2 text-base"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">List</span>
            <select
              value={seedListId}
              onChange={(e) => setSeedListId(e.target.value)}
              className="w-fit rounded-xl border border-field bg-control-bg px-2 py-1 text-sm"
            >
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Not before</span>
            <input
              type="date"
              value={seedNotBefore ?? ''}
              onChange={(e) => setSeedNotBefore(e.target.value === '' ? null : e.target.value)}
              className="w-fit rounded-xl border border-field bg-field-bg px-2 py-1 text-sm"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Due</span>
            <input
              type="date"
              value={seedDue ?? ''}
              onChange={(e) => setSeedDue(e.target.value === '' ? null : e.target.value)}
              className="w-fit rounded-xl border border-field bg-field-bg px-2 py-1 text-sm"
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Available</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Availability window">
              {WINDOW_CHOICES.map((w) => (
                <button
                  key={w.label}
                  type="button"
                  onClick={() => setSeedWindow(w.value)}
                  aria-label={`Set availability: ${w.label}`}
                  aria-pressed={seedWindow === w.value}
                  className={`touch-manipulation rounded-xl px-2 py-1 text-xs font-medium transition ${
                    seedWindow === w.value
                      ? 'bg-primary text-on-primary'
                      : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Effort</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Effort bucket">
              <button
                type="button"
                onClick={() => setSeedEffort(null)}
                aria-label="Set effort: Untagged"
                aria-pressed={seedEffort === null}
                className={`touch-manipulation rounded-xl px-2 py-1 text-xs font-medium transition ${
                  seedEffort === null
                    ? 'bg-primary text-on-primary'
                    : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
                }`}
              >
                Untagged
              </button>
              {EFFORTS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setSeedEffort(e)}
                  aria-label={`Set effort: ${bucketLabel(e, thresholds)}`}
                  aria-pressed={seedEffort === e}
                  className={`touch-manipulation rounded-xl px-2 py-1 text-xs font-medium capitalize transition ${
                    seedEffort === e
                      ? 'bg-primary text-on-primary'
                      : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Impact</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Impact level">
              {IMPACTS.map((i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSeedImpact(i)}
                  aria-label={`Set impact: ${impactLabel(i)}`}
                  aria-pressed={seedImpact === i}
                  className={`touch-manipulation rounded-xl px-2 py-1 text-xs font-medium transition ${
                    seedImpact === i
                      ? 'bg-primary text-on-primary'
                      : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
                  }`}
                >
                  {impactLabel(i)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">People</span>
            <button
              type="button"
              onClick={() => setSeedNeedsHand((v) => !v)}
              aria-pressed={seedNeedsHand}
              className={`touch-manipulation w-fit rounded-xl px-2 py-1 text-xs font-medium transition ${
                seedNeedsHand
                  ? 'bg-primary text-on-primary'
                  : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
              }`}
            >
              🤝 Needs a hand
            </button>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Importance</span>
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5" role="group" aria-label="Importance tier">
                {TIERS.map((tr) => (
                  <button
                    key={tr.value}
                    type="button"
                    onClick={() => setSeedTier(tr.value)}
                    aria-label={`Set importance: ${tr.label}`}
                    aria-pressed={seedTier === tr.value}
                    title={tr.label}
                    className={`size-6 rounded-full ${tr.swatch} ring-offset-1 ring-offset-white transition dark:ring-offset-slate-900 ${
                      seedTier === tr.value ? 'ring-2 ring-primary' : 'ring-1 ring-transparent hover:ring-field'
                    }`}
                  />
                ))}
              </div>
              <span className="text-sm text-body">{tierOf(seedTier).label}</span>
            </div>
          </div>
        </div>
      </dialog>
    );
  }

  if (task === null) {
    const createFromTitle = () => {
      const title = draftTitle.trim();
      if (!title || !addListId || creatingRef.current) return;
      creatingRef.current = true;
      onCreateInList(title, addListId);
    };
    return (
      <dialog
        ref={dialogRef}
        onClose={onClose}
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current?.close();
        }}
        aria-label="Add a task"
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl bg-card p-0 text-fg shadow-lg backdrop:bg-backdrop"
      >
        <div className="h-2 deck-brandbar rounded-t-2xl" aria-hidden="true" />
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-faint">Add task</h2>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="Cancel"
              className="touch-manipulation shrink-0 rounded-sm px-2 py-1 text-sm text-faint hover:bg-hover hover:text-strong-hover"
            >
              ✕
            </button>
          </div>
          {error && (
            <p role="alert" className="rounded-xl bg-error-bg px-3 py-2 text-sm text-error ring-1 ring-error-edge">
              {error}
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Title</span>
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={createFromTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createFromTitle();
              }}
              aria-label="New task title"
              placeholder="Name the task…"
              className="rounded-xl border border-field bg-field-bg px-2 py-1 text-base outline-none focus:border-primary"
            />
          </label>
          <p className="text-xs text-faint">
            Name it to start adding details — nothing is saved until you do.
          </p>
        </div>
      </dialog>
    );
  }

  const titleOf = (id: string) => tasks.find((t) => t.id === id)?.title ?? '(deleted)';
  const isDone = (id: string) => tasks.find((t) => t.id === id)?.status === 'done';

  /** Is the window open right now? Absent (null) for a windowless task — there is nothing to
   *  report (ADR 0070). Uses the same isWindowOpen the row and the waiting strip share. */
  const windowOpen =
    task.availabilityWindow === null
      ? null
      : isWindowOpen(task.availabilityWindow, localDay(), localTime());

  const commitTitle = () => {
    if (draftTitle.trim() && draftTitle !== task.title) onRename(task.id, draftTitle);
  };

  /**
   * The checklist (ADR 0071) — soft readiness, sorted by `position` on every render rather than
   * trusted to already be in order: App's local patch (no full refresh, since a checklist edit
   * never moves the task between reads) updates an item in place without re-sorting the array,
   * so display order must be derived here, not assumed.
   */
  const checklist = [...task.checklist].sort((a, b) => a.position - b.position);
  const doneCount = checklist.filter((c) => c.done).length;

  const draftFor = (item: ChecklistItem) => itemDrafts[item.id] ?? item.text;
  const setDraftFor = (id: string, text: string) =>
    setItemDrafts((prev) => ({ ...prev, [id]: text }));
  const clearDraft = (id: string) =>
    setItemDrafts((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _discard, ...rest } = prev;
      return rest;
    });
  const commitItemText = (item: ChecklistItem) => {
    const val = draftFor(item).trim();
    if (val && val !== item.text) onUpdateChecklistItem(task.id, item.id, { text: val });
    clearDraft(item.id); // reverts to item.text if the trim was empty or unchanged
  };

  const commitNewItem = () => {
    const text = newItemText.trim();
    if (!text) return;
    onAddChecklistItem(task.id, text);
    setNewItemText('');
  };

  /** Reorder by SWAPPING the two items' `position` values — two PATCHes, no renumbering (0071);
   *  disabled at the ends by the caller's index check. */
  const swapPositions = (a: ChecklistItem, b: ChecklistItem) => {
    onUpdateChecklistItem(task.id, a.id, { position: b.position });
    onUpdateChecklistItem(task.id, b.id, { position: a.position });
  };

  const typed = query.trim();

  /**
   * What this task could newly require — BROWSE-FIRST (0089): focus the box and every eligible
   * task drops down immediately, sorted A–Z; typing narrows it. You never have to remember a
   * name to find something.
   *
   * The eligible set is CAPPED at 50 (alphabetical) in BOTH the browse-all and the filtered
   * view; when more than 50 remain a faint "keep typing to narrow…" row stands in for the rest,
   * so a large backlog never walls the panel or shoves "+ Create" off-screen. The cap guards any
   * large match set, not merely the empty query.
   *
   * Self and already-linked are excluded because the client can know them alone. CYCLES ARE
   * NOT — that would be a second implementation of the rule the server enforces by walking
   * the graph, free to drift from it (0054). A looping pick is offered and refused with its
   * path, which is guided correction rather than a mystery.
   */
  const DEP_CAP = 50;
  const depEligible = tasks
    .filter((o) => o.id !== task.id && !task.dependsOn.includes(o.id))
    .filter((o) => typed === '' || o.title.toLowerCase().includes(typed.toLowerCase()))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const matches = depEligible.slice(0, DEP_CAP);
  const depOverflow = depEligible.length > DEP_CAP;

  // The picker is an aria-activedescendant COMBOBOX: ↓/↑ move a highlight, Enter selects it, Esc
  // clears — focus stays in the input, so a screen reader announces the active option rather than
  // chasing focus down the list. Tap and Tab still work (the options are real buttons).
  // depOpen drives the menu (browse-first, 0089): true on focus, false on blur/Escape.
  const [depOpen, setDepOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  // No option is pre-active on an empty (browse-all) query, so a stray Enter never silently adds a
  // dependency; typing activates the first match, arrowing activates from the top (0089).
  useEffect(() => setHighlight(query.trim() === '' ? -1 : 0), [query]);
  const activeIdx = highlight >= 0 && highlight < matches.length ? highlight : -1;
  const activeOption = activeIdx >= 0 ? matches[activeIdx] : undefined;
  const optionId = (id: string) => `req-opt-${id}`;
  const selectMatch = (o: Task) => {
    onSetDependsOn(task.id, [...task.dependsOn, o.id]); // the WHOLE set (0053)
    setQuery('');
  };

  // The list move is a create-or-move combobox (v0.34.0), mirroring the dependency picker above and
  // now BROWSE-FIRST (0089): focus the box and every list drops down (incl. the current one, marked
  // "(current)"), sorted A–Z; typing narrows. Pick one to MOVE to, or name a NEW list to create +
  // move to in one action. A case-insensitive name match selects the existing list — never a
  // duplicate. No cap — the list set is small and the box height-caps and scrolls.
  const [listQuery, setListQuery] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [listHighlight, setListHighlight] = useState(-1);
  // No option is pre-active on an empty (browse-all) query, so a stray Enter never silently moves
  // the task; typing activates the first match, arrowing activates from the top (0089).
  useEffect(() => setListHighlight(listQuery.trim() === '' ? -1 : 0), [listQuery]);
  const listTyped = listQuery.trim();
  const listMatches = lists
    .filter((l) => listTyped === '' || l.name.toLowerCase().includes(listTyped.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const listActiveIdx =
    listHighlight >= 0 && listHighlight < listMatches.length ? listHighlight : -1;
  const listActiveOption = listActiveIdx >= 0 ? listMatches[listActiveIdx] : undefined;
  const listOptionId = (id: string) => `list-opt-${id}`;
  const currentListName = lists.find((l) => l.id === task.listId)?.name ?? '(unknown)';
  const listExactMatch = (name: string) => lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  const moveToList = (listId: string) => {
    if (listId !== task.listId) onSetList(task.id, listId);
    setListQuery('');
  };
  const createOrMoveList = () => {
    if (!listTyped) return; // reject empty/whitespace
    const existing = listExactMatch(listTyped);
    if (existing) moveToList(existing.id); // case-insensitive match → select, no duplicate
    else onCreateListAndMove(task.id, listTyped); // new name → create + move
    setListQuery('');
  };

  // The location picker (ADRs 0060, 0061), now BROWSE-FIRST too (0089): focus the box and every
  // location drops down, sorted A–Z; typing narrows. It stays deliberately MINIMAL — a plain input
  // over a list of real, Tab-reachable <button>s, with NO listbox/option roles and NO arrow-key nav
  // (a listbox role without arrow nav announces a listbox whose arrows do nothing — worse than none).
  const locName = (id: string) => locations.find((l) => l.id === id)?.name ?? '(deleted)';
  const [locOpen, setLocOpen] = useState(false);
  const locTyped = locQuery.trim();
  // ALL locations whose name matches the query, tagged or not — the CREATE-SUPPRESSION set: if any
  // location matches, "+ Create" stays hidden even when the only match is already tagged (0061). On
  // an empty (browse-all) query this is every location, but "+ Create" is gated on locTyped anyway.
  const locMatching =
    locTyped === ''
      ? locations
      : locations.filter((l) => l.name.toLowerCase().includes(locTyped.toLowerCase()));
  // The clickable suggestions: the matches not already on this task, sorted A–Z. No cap — few places.
  const locSuggestions = locMatching
    .filter((l) => !task.locationIds.includes(l.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return (
    <dialog
      ref={dialogRef}
      // Fires on Escape and on close() alike, so one path closes the modal however it
      // happened — rather than Escape quietly bypassing the parent's state.
      onClose={onClose}
      // The backdrop is not a child, so a click on it lands on the <dialog> itself. A click
      // on anything inside targets that child instead.
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
      aria-label={`Details for ${task.title}`}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl bg-card p-0 text-fg shadow-lg backdrop:bg-backdrop"
    >
      {/* The signature brand mark (ADR 0063) — a gradient stripe capping the modal, top corners
          matched to the rounded-2xl modal. Brand-only (CSS-scoped); absent on other themes. */}
      <div className="h-2 deck-brandbar rounded-t-2xl" aria-hidden="true" />
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-faint">
              Task
            </h2>
            {/* The "needs details" flag (ADR 0073) — filled 🚩 = flagged, outline ⚐ = not; tap
                toggles. A manual "revisit later" control; setting it survives until a field edit
                clears it (no stickiness). Distinct from the automatic set-on-create/clear-on-edit. */}
            <button
              type="button"
              onClick={() => onSetNeedsDetails(task.id, !task.needsDetails)}
              aria-pressed={task.needsDetails}
              aria-label={task.needsDetails ? 'Needs details — tap to clear' : 'Flag as needs details'}
              title={task.needsDetails ? 'Needs details (revisit later) — tap to clear' : 'Flag: needs details'}
              className={`touch-manipulation shrink-0 rounded-sm px-1 text-sm leading-none transition ${
                task.needsDetails ? 'text-notice' : 'text-faint hover:text-body'
              }`}
            >
              <span aria-hidden="true">{task.needsDetails ? '🚩' : '⚐'}</span>
            </button>
            {/* Clone (ADR 0079): open an add-mode seeded from this task's scalars, title blank. Beside
                the needs-details flag. Nothing is copied until you type a title — no orphan. */}
            {onClone && (
              <button
                type="button"
                onClick={() => onClone(task)}
                aria-label="Clone task"
                title="Clone — duplicate this task with a blank title to tweak"
                className="touch-manipulation shrink-0 rounded-sm px-1 text-sm leading-none text-faint transition hover:text-body"
              >
                <span aria-hidden="true">⧉</span>
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close details"
            className="touch-manipulation shrink-0 rounded-sm px-2 py-1 text-sm text-faint hover:bg-hover hover:text-strong-hover"
          >
            ✕
          </button>
        </div>

        {/* An error from an action taken in this modal (a cycle rejection, a create-and-tag partial
            failure) shows HERE, in the dialog — never in the App banner behind it (0061). */}
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-error-bg px-3 py-2 text-sm text-error ring-1 ring-error-edge"
          >
            {error}
          </p>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Title</span>
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle();
            }}
            // No aria-label: the wrapping <label>'s "Title" names it. An aria-label would
            // override that — and the add-task form already answers to "Task title", so two
            // controls on one page would share an accessible name.
            className="rounded-xl border border-field bg-field-bg px-2 py-1 text-base outline-none focus:border-primary"
          />
        </label>

        {/* Move between lists (ADR 0056 follow-on). Changes ONLY the listId — dependencies, the
            dates, the tier and the Arena rating are logical, not organizational, and stay put; a
            dependency that crosses lists survives because the link is between task ids. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">List — currently “{currentListName}”</span>
          <input
            value={listQuery}
            onChange={(e) => setListQuery(e.target.value)}
            onFocus={() => setListOpen(true)}
            onBlur={() => setListOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault(); // close the popup first (don't also close the modal)
                setListOpen(false);
                setListQuery('');
                return;
              }
              if (listOpen && listMatches.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                setListHighlight((h) =>
                  e.key === 'ArrowDown' ? Math.min(h + 1, listMatches.length - 1) : Math.max(h - 1, 0),
                );
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (listOpen && listActiveOption) moveToList(listActiveOption.id);
                else if (listTyped) createOrMoveList();
              }
            }}
            role="combobox"
            aria-expanded={listOpen && listMatches.length > 0}
            aria-controls="list-move-listbox"
            aria-autocomplete="list"
            aria-activedescendant={listOpen && listActiveOption ? listOptionId(listActiveOption.id) : undefined}
            aria-label="Move to a list"
            placeholder="Search lists, or name a new one…"
            className="rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
          />
          {listOpen && listMatches.length > 0 && (
            <ul id="list-move-listbox" role="listbox" className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {listMatches.map((l, i) => (
                <li key={l.id} role="option" id={listOptionId(l.id)} aria-selected={i === listActiveIdx}>
                  <button
                    type="button"
                    // Keep focus on the input through the tap so onClick lands before onBlur closes it.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => moveToList(l.id)}
                    onMouseMove={() => setListHighlight(i)}
                    aria-label={`Move to ${l.name}`}
                    className={`w-full truncate rounded-xl px-2 py-1 text-left text-sm text-strong ${
                      i === listActiveIdx ? 'bg-hover' : 'hover:bg-hover'
                    }`}
                  >
                    {l.name}
                    {l.id === task.listId ? ' (current)' : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* Create-or-move: offered when text is typed AND no case-insensitive exact match exists (an
              exact match is pickable from the list above, so creating would duplicate it). */}
          {listTyped !== '' && !listExactMatch(listTyped) && (
            <div className="mt-1 border-t border-divider pt-2">
              <button
                type="button"
                onClick={createOrMoveList}
                aria-label={`Create ${listTyped} and move here`}
                className="touch-manipulation rounded-xl bg-primary px-2 py-1 text-xs font-medium text-on-primary"
              >
                + Create “{listTyped}” &amp; move
              </button>
            </div>
          )}
        </div>

        {/* The badge sits OUTSIDE the <label>. Inside, its text joins the input's
            accessible name — "Not before waiting for its day" — because a label names its
            control with everything it contains. Status is not a label. */}
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">
              Not before
            </span>
            <input
              type="date"
              value={task.notBefore ?? ''}
              onChange={(e) => onSetNotBefore(task.id, e.target.value)}
              className="w-fit rounded-xl border border-field bg-field-bg px-2 py-1 text-sm"
            />
          </label>
          {isGated(task.notBefore, localDay()) && (
            <span className="text-xs text-not-before">waiting for its day</span>
          )}
        </div>

        {/* Due sits beside Not before, and is deliberately a DIFFERENT statement — a deadline,
            not a start gate (ADR 0056). Same input and same wire discipline; v0.6 sets and shows
            it, nothing scores on it yet. */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Due</span>
          <input
            type="date"
            value={task.due ?? ''}
            onChange={(e) => onSetDue(task.id, e.target.value)}
            className="w-fit rounded-xl border border-field bg-field-bg px-2 py-1 text-sm"
          />
        </label>

        {/* The availability window (ADR 0070) — a 4-preset segmented picker beside the other
            gate fields. FIXED presets, not a builder: one choice from a closed set, Anytime
            (null) the default, and the chosen window's meaning spelled out under it. It edits
            through the same App handler pattern as the other gates. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Available</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Availability window">
            {WINDOW_CHOICES.map((w) => {
              const current = task.availabilityWindow === w.value;
              return (
                <button
                  key={w.label}
                  type="button"
                  onClick={() => onSetAvailabilityWindow(task.id, w.value)}
                  aria-label={`Set availability: ${w.label}`}
                  aria-pressed={current}
                  className={`touch-manipulation rounded-xl px-2 py-1 text-xs font-medium transition ${
                    current
                      ? 'bg-primary text-on-primary'
                      : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
                  }`}
                >
                  {w.label}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-faint">
            {WINDOW_CHOICES.find((w) => w.value === task.availabilityWindow)?.meaning}
          </span>
          {/* The live status (ADR 0070) — parallel to Not before's "waiting for its day":
              shown only for a windowed task, amber in the shut state, plain when open. */}
          {windowOpen !== null && (
            <span className={`text-xs ${windowOpen ? 'text-faint' : 'text-not-before'}`}>
              {windowOpen ? 'available now' : 'outside hours right now'}
            </span>
          )}
        </div>

        {/* Effort (ADR 0072) — the fit term's bucket: Untagged (null) the default, then the three
            sizes. NOT a gate — it never hides or moves the task; it only sinks the task in the
            Today hand when a block too small for it is set. The chosen bucket's minute range is
            shown from the client thresholds, the same labels the Today block picker uses. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Effort</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Effort bucket">
            <button
              type="button"
              onClick={() => onSetEffort(task.id, null)}
              aria-label="Set effort: Untagged"
              aria-pressed={task.effort === null}
              className={`touch-manipulation rounded-xl px-2 py-1 text-xs font-medium transition ${
                task.effort === null
                  ? 'bg-primary text-on-primary'
                  : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
              }`}
            >
              Untagged
            </button>
            {EFFORTS.map((e) => {
              const current = task.effort === e;
              return (
                <button
                  key={e}
                  type="button"
                  onClick={() => onSetEffort(task.id, e)}
                  aria-label={`Set effort: ${bucketLabel(e, thresholds)}`}
                  aria-pressed={current}
                  title={bucketLabel(e, thresholds)}
                  className={`touch-manipulation rounded-xl px-2 py-1 text-xs font-medium capitalize transition ${
                    current
                      ? 'bg-primary text-on-primary'
                      : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
                  }`}
                >
                  {e}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-faint">
            {task.effort === null
              ? 'Untagged — fits any block, never sinks.'
              : `${bucketLabel(task.effort, thresholds)} — sinks when the free block is smaller.`}
          </span>
        </div>

        {/* Impact (ADR 0075) — the declared level that arms the safety-net pin: None (default), then
            Medium/High. It NEVER enters the ranking (0007/0057) — it only decides whether a neglected,
            playable task nudges you. Same segmented picker as Effort/Tier above. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Impact</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Impact level">
            {IMPACTS.map((i) => {
              const current = task.impact === i;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onSetImpact(task.id, i)}
                  aria-label={`Set impact: ${impactLabel(i)}`}
                  aria-pressed={current}
                  className={`touch-manipulation rounded-xl px-2 py-1 text-xs font-medium transition ${
                    current
                      ? 'bg-primary text-on-primary'
                      : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
                  }`}
                >
                  {impactLabel(i)}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-faint">
            Medium and High get a gentle nudge if you keep neglecting them.
          </span>
        </div>

        {/* Needs a hand (ADR 0071) — a soft label, not a gate: it never hides or blocks the
            task, so it sits beside the gate fields but does not behave like one. A single
            press-toggle, not a segmented picker, because it is one boolean, not a preset set. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">People</span>
          <button
            type="button"
            onClick={() => onSetNeedsHand(task.id, !task.needsHand)}
            aria-pressed={task.needsHand}
            className={`touch-manipulation w-fit rounded-xl px-2 py-1 text-xs font-medium transition ${
              task.needsHand
                ? 'bg-primary text-on-primary'
                : 'bg-control-bg text-body ring-1 ring-field hover:bg-hover'
            }`}
          >
            🤝 Needs a hand
          </button>
          <span className="text-xs text-faint">involves or waits on a person — never hides the task</span>
        </div>

        {/* The tier picker (ADR 0056). Colour is the affordance but NEVER the only signal: each
            swatch carries its word in aria-label, the current one is aria-pressed, and the chosen
            word is shown in text. A declared dial, distinct from the earned rating. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Importance</span>
          <div className="flex items-center gap-2">
            <div className="flex gap-1.5" role="group" aria-label="Importance tier">
              {TIERS.map((t) => {
                const current = task.tier === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => onSetTier(task.id, t.value)}
                    aria-label={`Set importance: ${t.label}`}
                    aria-pressed={current}
                    title={t.label}
                    className={`size-6 rounded-full ${t.swatch} ring-offset-1 ring-offset-white transition dark:ring-offset-slate-900 ${
                      current
                        ? 'ring-2 ring-primary'
                        : 'ring-1 ring-transparent hover:ring-field'
                    }`}
                  />
                );
              })}
            </div>
            <span className="text-sm text-body">{tierOf(task.tier).label}</span>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Requires</span>
          {task.dependsOn.length === 0 ? (
            <p className="text-sm text-faint">Nothing — this is ready.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {task.dependsOn.map((id) => (
                <li key={id} className="flex items-center gap-2 text-sm">
                  <span
                    className={
                      isDone(id)
                        ? 'text-faint line-through'
                        : 'text-strong'
                    }
                  >
                    {isDone(id) ? '✓' : '⛓'} {titleOf(id)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onSetDependsOn(task.id, task.dependsOn.filter((x) => x !== id))}
                    aria-label={`Stop requiring ${titleOf(id)}`}
                    className="touch-manipulation rounded-sm px-1 text-xs text-faint hover:text-danger"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Browse-first (0089) aria-activedescendant combobox — focus drops all eligible options
              (A–Z), typing narrows; ↓/↑ highlight, Enter select, Esc close. Focus never leaves the
              input, so the screen reader hears the active option. */}
          <label className="mt-2 flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">
              Add something this requires
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setDepOpen(true)}
              onBlur={() => setDepOpen(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault(); // close the popup first (don't also close the modal)
                  setDepOpen(false);
                  setQuery('');
                  return;
                }
                if (!depOpen || matches.length === 0) return; // no popup → let Tab do its normal thing
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHighlight((h) => Math.min(h + 1, matches.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHighlight((h) => Math.max(h - 1, 0));
                } else if (e.key === 'Enter' && activeOption) {
                  e.preventDefault();
                  selectMatch(activeOption);
                }
              }}
              role="combobox"
              aria-expanded={depOpen && matches.length > 0}
              aria-controls="requires-listbox"
              aria-autocomplete="list"
              aria-activedescendant={depOpen && activeOption ? optionId(activeOption.id) : undefined}
              placeholder="Search tasks, or name something new…"
              className="rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
            />
          </label>

          {depOpen && matches.length > 0 && (
            // Height-capped and scrollable: ~5–6 rows show, the rest scroll inside. The eligible set
            // is already capped at 50 (browse-all or filtered); past that the hint row below stands
            // in for the remainder, so the box never walls the panel or pushes "+ Create" away.
            <ul id="requires-listbox" role="listbox" className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {matches.map((o, i) => (
                <li key={o.id} role="option" id={optionId(o.id)} aria-selected={i === activeIdx}>
                  <button
                    type="button"
                    // Keep focus on the input through the tap so onClick lands before onBlur closes
                    // the menu (the focus/blur-vs-tap race).
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectMatch(o)}
                    onMouseMove={() => setHighlight(i)}
                    aria-label={`Require ${o.title}`}
                    className={`w-full truncate rounded-xl px-2 py-1 text-left text-sm text-strong ${
                      i === activeIdx ? 'bg-hover' : 'hover:bg-hover'
                    }`}
                  >
                    {o.title}
                  </button>
                </li>
              ))}
              {depOverflow && (
                // Not an option (aria-hidden): a hint that the list is truncated at 50, not a pick.
                <li aria-hidden="true" className="px-2 py-1 text-xs italic text-faint">
                  keep typing to narrow…
                </li>
              )}
            </ul>
          )}

          {/* Offered whenever anything is typed, NOT only when nothing matched: a new
              prerequisite may legitimately share a word with an existing task, and hiding
              this because something matched would make the feature depend on your
              vocabulary. */}
          {typed !== '' && (
            <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-divider pt-2">
              <button
                type="button"
                onClick={() => {
                  onCreateRequired(task.id, typed, newListId);
                  setQuery('');
                }}
                aria-label={`Create ${typed} and require it`}
                className="touch-manipulation rounded-xl bg-primary px-2 py-1 text-xs font-medium text-on-primary"
              >
                + Create “{typed}”
              </button>
              <label className="flex items-center gap-1 text-xs text-muted">
                in
                <select
                  value={newListId}
                  onChange={(e) => setNewListId(e.target.value)}
                  aria-label="List for the new task"
                  className="rounded-xl border border-field bg-control-bg px-1 py-1 text-xs"
                >
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>

        {/* Where — the location tags (ADRs 0060, 0061). Placed beside Requires ON PURPOSE: the two
            pickers behave OPPOSITELY on "+ Create", and that divergence only reads if they sit
            together. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Where</span>
          {task.locationIds.length === 0 ? (
            <p className="text-sm text-faint">Anywhere — shown in every context.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {task.locationIds.map((id) => (
                <li
                  key={id}
                  className="flex items-center gap-1 rounded-full bg-chip px-2 py-0.5 text-sm"
                >
                  <span className="text-strong">{locName(id)}</span>
                  <button
                    type="button"
                    onClick={() => onSetLocations(task.id, task.locationIds.filter((x) => x !== id))}
                    aria-label={`Remove location ${locName(id)}`}
                    className="touch-manipulation rounded-sm px-0.5 text-xs text-faint hover:text-danger"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label className="mt-2 flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Add a place</span>
            <input
              value={locQuery}
              onChange={(e) => setLocQuery(e.target.value)}
              onFocus={() => setLocOpen(true)}
              onBlur={() => setLocOpen(false)}
              onKeyDown={(e) => {
                // Escape closes the popup (not the modal); there is no arrow-nav/Enter-select here,
                // so Enter is a plain no-op — trivially empty-safe, no stray tag can be added.
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setLocOpen(false);
                  setLocQuery('');
                }
              }}
              placeholder="Search places…"
              className="rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
            />
          </label>

          {locOpen && locSuggestions.length > 0 && (
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {locSuggestions.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    // Keep focus on the input through the tap so onClick lands before onBlur closes it.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      // locationIds is a full-set replace (0060) — append then send the whole set.
                      onSetLocations(task.id, [...task.locationIds, l.id]);
                      setLocQuery('');
                    }}
                    aria-label={`Add location ${l.name}`}
                    className="w-full truncate rounded-xl px-2 py-1 text-left text-sm text-strong hover:bg-hover"
                  >
                    {l.name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* THE DIVERGENCE (ADR 0061), and why it sits right next to the Requires picker: THAT one
              offers "+ Create" whenever anything is typed, because a new TASK may legitimately share
              a word with an existing one. THIS offers it ONLY when NOTHING matches, because a
              matching LOCATION almost certainly IS the one you want, and near-duplicates ("the
              garage" beside "Garage") are the failure mode. Do NOT "fix" this to match the other
              picker — the difference is the decision. */}
          {locTyped !== '' && locMatching.length === 0 && (
            <div className="mt-1 border-t border-divider pt-2">
              <button
                type="button"
                onClick={() => {
                  onCreateAndTagLocation(task.id, locTyped);
                  setLocQuery('');
                }}
                aria-label={`Create ${locTyped} and tag it`}
                className="touch-manipulation rounded-xl bg-primary px-2 py-1 text-xs font-medium text-on-primary"
              >
                + Create “{locTyped}”
              </button>
            </div>
          )}
        </div>

        {/* Checklist (ADR 0071) — SOFT readiness, never a gate: nothing here hides or blocks the
            task from Today/Upcoming/Lists/the Arena, so unlike the gate fields above (Not before,
            Available, Requires), every edit here patches the one task in place rather than
            refreshing — there is no gate state that could move it between reads. */}
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-muted">Checklist</span>
            <span className="text-xs text-faint">
              {doneCount} of {checklist.length} done
            </span>
          </div>

          {checklist.length === 0 ? (
            <p className="text-sm text-faint">Nothing yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {checklist.map((item, idx) => (
                <li key={item.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={() => onUpdateChecklistItem(task.id, item.id, { done: !item.done })}
                    aria-label={item.done ? `Mark "${item.text}" not done` : `Mark "${item.text}" done`}
                    className="shrink-0"
                  />
                  <input
                    value={draftFor(item)}
                    onChange={(e) => setDraftFor(item.id, e.target.value)}
                    onBlur={() => commitItemText(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitItemText(item);
                      else if (e.key === 'Escape') clearDraft(item.id); // discard the draft, keep item.text
                    }}
                    aria-label={`Checklist item: ${item.text}`}
                    className={`min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1 py-0.5 outline-none focus:border-field focus:bg-field-bg ${
                      item.done ? 'text-faint line-through' : 'text-strong'
                    }`}
                  />
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => swapPositions(item, checklist[idx - 1]!)}
                      disabled={idx === 0}
                      aria-label={`Move "${item.text}" up`}
                      className="touch-manipulation rounded-sm px-1 text-xs text-faint hover:text-strong-hover disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => swapPositions(item, checklist[idx + 1]!)}
                      disabled={idx === checklist.length - 1}
                      aria-label={`Move "${item.text}" down`}
                      className="touch-manipulation rounded-sm px-1 text-xs text-faint hover:text-strong-hover disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteChecklistItem(task.id, item.id)}
                      aria-label={`Remove "${item.text}"`}
                      className="touch-manipulation rounded-sm px-1 text-xs text-faint hover:text-danger"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* The button sits OUTSIDE the <label>, as a sibling — not nested inside it alongside the
              input. A <label> implicitly associates with EVERY labelable descendant, so a button
              nested in the same label would share the input's accessible name too, and the two
              controls would become indistinguishable to assistive tech and to getByLabelText. */}
          <div className="mt-2 flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-muted">Add a checklist item</span>
              <input
                value={newItemText}
                onChange={(e) => setNewItemText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitNewItem();
                  }
                }}
                placeholder="e.g. Call the plumber"
                className="rounded-xl border border-field bg-field-bg px-2 py-1 text-sm outline-none focus:border-primary"
              />
            </label>
            <button
              type="button"
              onClick={commitNewItem}
              disabled={newItemText.trim() === ''}
              aria-label="Add checklist item"
              className="touch-manipulation shrink-0 rounded-xl bg-primary px-2 py-1 text-xs font-medium text-on-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
