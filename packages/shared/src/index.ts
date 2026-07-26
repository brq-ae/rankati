/**
 * The contract between apps/api and apps/web (ADR 0034).
 * Defined once, imported by both. No Prisma types cross this boundary (ADR 0033).
 *
 * This package is TYPES ONLY (ADR 0041). It emits no runtime JavaScript, so it needs no
 * build step and never has to reconcile Nest's CommonJS with Vite's ESM. Adding the first
 * runtime export — a constant, a function — reopens that question: read ADR 0041 first.
 * LOCAL_OWNER_ID lives in apps/api for exactly this reason.
 */

/** v0.1 lifecycle. `archived` arrives with the retention milestone (CONCEPT §11). */
export type TaskStatus = 'active' | 'done';

/**
 * A task's DECLARED importance tier (ADR 0056) — how steeply importance should escalate as a
 * deadline nears. This is NOT the earned Arena `rating`: `rating` is won by dueling, `tier` is
 * asserted, and the future urgency model uses both (rating the backbone, tier the exponent).
 *
 * The snake_case identifier is what crosses the wire and lives in the DB; the label ("Super
 * Important") and the colour are presentation, and live in the web app — this package is
 * types-only (ADR 0041), so no map belongs here.
 */
export type TaskTier = 'normal' | 'important' | 'super_important' | 'critical';

/**
 * The availability-window gate's FIXED presets (ADR 0070) — a closed set, deliberately not a
 * per-task builder. The fourth value, Anytime, is NULL on the field, not a member here.
 */
export type AvailabilityWindow = 'working_hours' | 'workdays' | 'weekend';

/** The `fit` effort bucket (ADR 0072) — ordinal size; NULL = untagged = fits any block, never sinks. */
export type Effort = 'quick' | 'medium' | 'long';

/**
 * The declared impact LEVEL (ADR 0075) — drives the safety-net pin, NEVER `priority_now` (0007/0057).
 * Default 'none'. The level sets the pin's fuse: High = 7 days, Medium = 30, off the created date.
 */
export type Impact = 'none' | 'medium' | 'high';

export interface List {
  id: string;
  name: string;
  /** Single local owner until auth exists (ADRs 0026, 0039). */
  ownerId: string;
}

/**
 * A per-task readiness checklist item (ADR 0071) — soft, NEVER a gate. It never hides or
 * blocks a task from Today/Upcoming/Lists/the Arena; ticking is the owner's own judgment
 * call. `done` never auto-resets — an item only leaves via explicit delete or its task's
 * deletion (cascade). Ordered by `position`.
 */
export interface ChecklistItem {
  id: string;
  taskId: string;
  text: string;
  done: boolean;
  position: number;
  /** ISO 8601 — what actually crosses the wire; JSON has no Date. */
  createdAt: string;
}

/**
 * POST /tasks/:id/checklist — add a readiness item to a task (ADR 0071). `text` is trimmed and
 * must be non-empty. The item is APPENDED: its `position` is the current max for the task + 1
 * (0 if it is the first).
 */
export interface CreateChecklistItemDto {
  text: string;
}

/**
 * PATCH /checklist/:itemId — edit a checklist item directly (ADR 0071). Values are taken as-is,
 * the routine-edit pattern:
 *   omitted -> leave unchanged
 *   value   -> set it
 * `position` sets ONLY this item's own value — it does NOT renumber siblings; display order is
 * `position asc`, so a caller wanting a clean resequence sends each item's new value itself.
 */
export interface UpdateChecklistItemDto {
  text?: string;
  done?: boolean;
  position?: number;
}

/**
 * A place I go — a managed context a task can be tagged with (ADR 0060). NOT a list and NOT
 * free text: a trip or a project is a list; a location is a PLACE. The name is stored with the
 * capitalisation first typed, and is unique per owner CASE-INSENSITIVELY (ADR 0061).
 */
export interface Location {
  id: string;
  name: string;
  /** Single local owner until auth exists (ADRs 0026, 0039). */
  ownerId: string;
}

export interface Task {
  id: string;
  title: string;
  listId: string;
  /** Single local owner until auth exists (ADRs 0026, 0039). */
  ownerId: string;
  status: TaskStatus;
  /** ISO 8601 — what actually crosses the wire; JSON has no Date. */
  createdAt: string;
  /** ISO 8601, or null while the task is still active. */
  completedAt: string | null;
  /**
   * The earned importance score (ADRs 0003, 0007, 0047) — `rating` and `importance` are
   * the same value at two layers, not two numbers.
   *
   * A `number`, not a string: the API stores this as Decimal for replay stability, and
   * converts at the boundary — the same explicit conversion the Date -> ISO fields get,
   * for the same reason (JSON has neither a Date nor a Decimal).
   *
   * "Hidden" in CONCEPT §4 means never shown to the user, not withheld from the client:
   * the web app needs it to order the ranked list.
   */
  rating: number;
  /**
   * The not-before gate: this task stays out of Today until this day (ADR 0052).
   *
   * A PLAIN CALENDAR DATE — 'YYYY-MM-DD' — never an ISO instant, and never to be handed to
   * `new Date()`. '2026-07-20T00:00:00.000Z' parsed by a client west of UTC renders as the
   * 19th: the gate would then be judged a day early, at exactly the boundary it exists to
   * police. Compare it as a string against the client's own local day.
   *
   * null = ungated. It does NOT hide the task from the Arena — gated tasks still duel.
   */
  notBefore: string | null;
  /**
   * The deadline — "should be done by this day" (ADR 0056). INDEPENDENT of notBefore, which is
   * the opposite statement ("can't start until"); a task may carry both, either, or neither.
   *
   * Same shape and the same rule as notBefore: a PLAIN CALENDAR DATE, 'YYYY-MM-DD', never an
   * ISO instant and never handed to `new Date()`. null = no deadline, which the future urgency
   * model reads as urgency 1. v0.6 captures and displays it only — nothing gates or ranks on it.
   */
  due: string | null;
  /**
   * The availability-window gate (ADR 0070): one fixed preset, or NULL = Anytime = ungated —
   * the 0052 optional-field shape, like notBefore. Hides from Today only, never from Lists or
   * the Arena. Inert in this slice: stored and carried on the wire, gating nothing yet.
   */
  availabilityWindow: AvailabilityWindow | null;
  /**
   * The effort bucket for the `fit` ranking term (ADR 0072). NULL = untagged = fits any free
   * block and never sinks. Re-orders the Today hand only when a block is set; never gates or
   * hides. Carried on every DTO; the fit penalty is computed server-side in the Today scoring.
   */
  effort: Effort | null;
  /**
   * The declared impact level (ADR 0075). Default 'none'. Drives ONLY the safety-net pin — never
   * `priority_now` (0007/0057) — so it re-orders nothing; the client computes the pin from this +
   * `createdAt` + the playable/held sets. Carried on every read.
   */
  impact: Impact;
  /**
   * The declared importance tier (ADR 0056), server-stamped and never absent — a task without
   * one is `normal`, the baseline. Distinct from `rating`: declared, not earned. v0.6 displays
   * it; the future model reads it as the urgency exponent.
   */
  tier: TaskTier;
  /**
   * Tasks this one waits for: it is blocked while ANY of them is not done (ADR 0053).
   *
   * Ids only. Whoever renders these already holds every task, so it can resolve titles and
   * work out blocked-ness itself; shipping {id, title, status} here would be a second copy
   * of task data on the wire, free to go stale against the first.
   *
   * Empty = nothing blocks it. It does NOT hide the task from the Arena — blocked tasks
   * still duel, so they arrive already ranked on the day they unblock.
   */
  dependsOn: string[];
  /**
   * The places this task is doable (ADR 0060) — ids only, like `dependsOn` (0053): whoever
   * renders these already holds every Location, so it resolves names itself. Empty = doable
   * ANYWHERE, shown in every context.
   *
   * This is what the header context-filter reads, and it reads it ENTIRELY ON THE CLIENT — the
   * server never filters a read by location (0060's divergence from 0052), so this always
   * carries the task's full location set regardless of the selected context. It never reaches
   * the Arena.
   */
  locationIds: string[];
  /**
   * A soft "this involves or waits on a person" marker (ADR 0071) — NOT a gate. It never
   * hides the task from Today/Lists/the Arena and never stops it dueling; it replaces the
   * hard people gate (0009 #6) and ADR 0012's four-state model for the owner's actual need.
   * Non-null with a default of false, like `tier` — every existing task is unaffected.
   */
  needsHand: boolean;
  /**
   * The "needs details" flag (ADR 0073) — "unedited since creation," a soft marker, NEVER a gate.
   * Set true by every create path, cleared by the first field/checklist edit, and client-toggleable
   * ("revisit later"). Non-null with a default of false, like `needsHand` — every existing task is
   * unflagged. Carried on every read; the lifecycle and the client toggle land with the server slice.
   */
  needsDetails: boolean;
  /**
   * The task's readiness checklist (ADR 0071) — soft, NEVER a gate, ordered by `position`.
   * Empty = no items. Ticks persist permanently; nothing here changes what Today/Lists/the
   * Arena show.
   */
  checklist: ChecklistItem[];
  /**
   * The deadline task whose urgency, propagated backward, drives THIS task's rank (ADR 0059).
   *
   * OPTIONAL because it is a property of a READ, not of a task: the same task carries it on the
   * Today/Upcoming reads and not on Lists or the Arena pair. Absent means "not computed here";
   * a value is set only by the scored reads, and only when inherited urgency STRICTLY exceeds the
   * task's own — i.e. when the inherited deadline is the reason it ranks where it does.
   *
   * Ids only, like `dependsOn` (0053): the client resolves the source's title and due from its own
   * task list. The source may be BLOCKED and so absent from this response — the client resolves it
   * from its all-tasks (Lists) fetch, and renders no subtext if it cannot, never a dangling id.
   */
  urgencySourceId?: string | null;
}

/** POST /lists */
export interface CreateListDto {
  name: string;
}

/**
 * POST /tasks/:id/requires — create a prerequisite and link it, in one action (ADR 0054).
 *
 * The task is created AND the dependency written, or neither happens. Two calls could
 * create the task and fail the link, stranding an orphan in a list nobody chose.
 *
 * `listId` is required rather than inherited: nothing can move a task between lists yet, so
 * the choice is made up front instead of stranding it somewhere it cannot leave.
 */
export interface CreateRequiredTaskDto {
  title: string;
  listId: string;
}

/** PATCH /lists/:id — renaming a list, the v0.1 gap. */
export interface UpdateListDto {
  name: string;
}

/** POST /locations — owner server-stamped; uniqueness is case-insensitive, 400 on a dup (ADR 0061). */
export interface CreateLocationDto {
  name: string;
}

/** PATCH /locations/:id — rename. Same case-insensitive uniqueness rule as create (ADR 0061). */
export interface UpdateLocationDto {
  name: string;
}

/**
 * POST /locations/merge — fold `sourceId` into `targetId`, then delete the source, ATOMICALLY
 * (ADR 0061). The direction is explicit: every task tagged the source becomes tagged the target
 * (deduped — a task tagged both ends with one tag), then the source is gone. The UI warns with
 * the count first, computed over the FULL task list (never the location-filtered view).
 */
export interface MergeLocationsDto {
  sourceId: string;
  targetId: string;
}

/**
 * POST /reset — a destructive, owner-wide wipe (ADR 0064). Two named modes; `confirm` MUST equal
 * the literal "DELETE" or the endpoint refuses with a 400 — the MACHINE floor beneath the UI's
 * typed-DELETE box. Two independent defences: a UI can be bypassed, a `curl` can be typo'd.
 *
 * - `clear-tasks` — deletes every task and everything downstream of tasks (duels, dependency links,
 *   location tags); lists survive empty, locations survive untouched. No reseed.
 * - `factory` — deletes tasks, lists and locations, then reseeds the shipped defaults. `keepSampleData`
 *   (default true) governs ONLY the sample lists/tasks; the four default locations are restored either
 *   way, because locations are structure, not sample content.
 */
export type ResetMode = 'clear-tasks' | 'factory';

export interface ResetRequestDto {
  mode: ResetMode;
  /** Factory mode only; ignored by clear-tasks. Defaults to true when omitted. */
  keepSampleData?: boolean;
  /** Must be the literal "DELETE"; the endpoint 400s otherwise (ADR 0064). */
  confirm: string;
}

/** POST /tasks */
export interface CreateTaskDto {
  title: string;
  listId: string;
}

/** PATCH /tasks/:id — edits the title only (edit/delete is a planned addition). */
/**
 * PATCH is partial: send only what changes.
 *
 * `notBefore` distinguishes three states, and the distinction is load-bearing:
 *   omitted      -> leave the gate exactly as it is
 *   'YYYY-MM-DD' -> gate the task until that day
 *   null         -> remove the gate
 *
 * A request with neither field is rejected: it asks for nothing, and silently doing
 * nothing while returning 200 is how a caller's bug becomes invisible.
 */
export interface UpdateTaskDto {
  title?: string;
  /**
   * Move the task to another list (ADR 0056 follow-on). Changes ONLY the list it belongs to —
   * lists are organizational, while dependencies and the Arena rating are logical and
   * orthogonal, so none of them move with it. A dependency that crosses lists survives, because
   * the link is between task ids, not lists. Omitted = stay put; a value = move there (400 if
   * that list does not exist). There is no null — a task always belongs to some list.
   */
  listId?: string;
  notBefore?: string | null;
  /**
   * The availability window (ADR 0070), with the SAME three states as notBefore:
   *   omitted -> leave the window exactly as it is
   *   value   -> set that preset
   *   null    -> clear it back to Anytime (ungated)
   */
  availabilityWindow?: AvailabilityWindow | null;
  /**
   * The effort bucket (ADR 0072), with the SAME three states as notBefore:
   *   omitted -> leave effort exactly as it is
   *   value   -> set that bucket
   *   null    -> clear it back to untagged (fits any block)
   */
  effort?: Effort | null;
  /**
   * The declared impact level (ADR 0075) — two states, like `tier`/`needsHand`:
   *   omitted -> leave it unchanged
   *   value   -> set it (validated against none/medium/high; drives only the pin, never ranking)
   */
  impact?: Impact;
  /**
   * The deadline, with the SAME three states as notBefore (ADR 0056):
   *   omitted      -> leave the deadline exactly as it is
   *   'YYYY-MM-DD' -> set it to that day
   *   null         -> remove it
   *
   * A calendar date on the wire, never an instant — the mapper serialises it with the same
   * date-only discipline as notBefore (0052).
   */
  due?: string | null;
  /**
   * The declared tier (ADR 0056). Two states, not three — it is non-null with a default, so
   * there is nothing to "clear":
   *   omitted -> leave it unchanged
   *   value   -> set it to that tier
   */
  tier?: TaskTier;
  /**
   * REPLACES the whole set — same three states as notBefore:
   *   omitted    -> leave the dependencies exactly as they are
   *   []         -> clear them all
   *   ['id',...] -> exactly this set
   *
   * Rejected with 400 if it would close a cycle (A->B->A: neither task could ever reach
   * Today again, silently) or if a task is listed as depending on itself (ADR 0053).
   */
  dependsOn?: string[];
  /**
   * REPLACES the whole set — the same three states as `dependsOn` (0053):
   *   omitted    -> leave the locations exactly as they are
   *   []         -> clear them all (the task becomes doable everywhere)
   *   ['id',...] -> exactly this set
   *
   * A full-set replace, NOT an add/remove delta: the tag picker is a multi-select that returns
   * the whole selection, single user (0026) means no concurrent edit a delta must preserve, and
   * `dependsOn` — the sibling many-to-many on this very DTO — is already a replace with these
   * exact three states. Rejected with 400 if any id is not an existing location of this owner
   * (like `listId`); there is no cycle concept — locations are not a graph.
   */
  locationIds?: string[];
  /**
   * The soft "needs a hand" marker (ADR 0071). Non-null with a default, like `tier` — two
   * states, not three:
   *   omitted -> leave it unchanged
   *   value   -> set it to that boolean
   */
  needsHand?: boolean;
  /**
   * The "needs details" flag (ADR 0073) — client-writable, the modal's "revisit later" toggle:
   *   omitted -> the flag follows the "any field edit clears it" rule (any OTHER field in this
   *              PATCH clears it to false)
   *   value   -> set it to that boolean EXPLICITLY, and it WINS — an explicit needsDetails is
   *              honored, never force-cleared. The client sends this alone (the toggle), so it
   *              never collides with a field edit.
   */
  needsDetails?: boolean;
}

/**
 * The two tasks of a duel — full tasks, not ids: the duel screen renders titles, and a
 * second round-trip to fetch them is exactly what "the next pair appears instantly"
 * cannot afford. One tap picks a winner; there is no draw (ADR 0047).
 */
export interface DuelPair {
  /**
   * Identifies THIS deal — the specific act of showing this pair, not the pair itself.
   *
   * The client echoes it back when it taps, and the server rejects a tap carrying any
   * other token with 409. Without it, the server records whatever ids it is handed and a
   * tap that raced an undo lands on the previous pair: a wrong judgement, stored silently.
   *
   * It is a token rather than a comparison of the two task ids because the SAME pair may
   * legitimately be dealt again (repeated pairs are allowed by design, ADR 0047) — ids
   * alone cannot tell a fresh deal of the same two tasks from a stale tap on the last one.
   */
  dealId: string;
  a: Task;
  b: Task;
}

/** POST /duel-sessions — an optional list narrows the pool without changing the rating (0003). */
export interface StartSessionDto {
  listId?: string | null;
}

/**
 * The pool floor for a duel — two. Exported as a TYPE, not a value: `@rankati/shared` is
 * types-only (0041), so the runtime `2` lives in each consumer — `apps/api`'s arena service and
 * `apps/web`'s duelable check — each declared `const MIN_POOL: MinPool = 2`. Diverging it is then
 * a COMPILE error, not a silent runtime drift: the closest 0041-compliant way to "share" the
 * constant. (Its meaning: fewer than two tasks cannot make a pair, 0047.)
 */
export type MinPool = 2;

/**
 * One row of the "can this list be dueled?" agreement fixtures. Shared as a TYPE because the two
 * tests that pin the rule — `apps/api/test/duelable-agreement.spec.ts` (the real server `start()`)
 * and `apps/web/test/duelable.spec.ts` (the client `isListDuelable`) — CANNOT share runtime
 * fixture data across the CJS/ESM boundary (0041, the same reason `MinPool` can't move here). The
 * type pins the fixture SHAPE so the two cannot drift in structure; the VALUES are duplicated in
 * each test and cross-referenced. Gate-agnostic by construction: a `'gated'` task is still
 * `active`, and the Arena ranks importance regardless of playability gates (0003).
 */
export interface DuelableCase {
  readonly label: string;
  /** The list's active tasks, each by gate state; `length` is the active count. */
  readonly active: readonly ('plain' | 'gated')[];
  /** Whether the list is duelable — the server `start()`s it and the client enables VS. */
  readonly duelable: boolean;
}

/**
 * Nothing to duel yet. NOT an error: wanting to rank one task is a perfectly sensible
 * thing to try, and the answer is "add another", not a 400 (ADR 0047). The UI renders
 * this as an empty state.
 */
export interface NeedMoreTasks {
  status: 'need-more-tasks';
  /** Active tasks in the pool right now. */
  activeCount: number;
  /** How many a duel needs — two. */
  required: number;
}

/**
 * The server owns the session id and hands it back here; the client sends it with every
 * tap, undo and commit. It lives in the API's memory and dies with the sitting (0048).
 */
export interface SessionStarted {
  status: 'started';
  sessionId: string;
  pair: DuelPair;
}

/** POST /duel-sessions. Switch on `status` — both outcomes are 200. */
export type StartSessionResult = SessionStarted | NeedMoreTasks;

/** The next duel to show. */
export interface NextPair {
  status: 'pair';
  pair: DuelPair;
}

/**
 * What a tap or an undo returns: the next pair, or the empty state if the pool has
 * dropped below two mid-sitting (completing tasks as you go will do it).
 */
export type NextPairResult = NextPair | NeedMoreTasks;

/** A single tap. Held pending in the API until the session ends (ADR 0048). */
export interface SubmitResultDto {
  winnerId: string;
  loserId: string;
  /** The `dealId` of the pair that was on screen when this tap happened. */
  dealId: string;
}

/** What one task's rating did across a whole sitting. */
export interface RatingChange {
  /** The task, carrying its NEW rating. */
  task: Task;
  before: number;
  after: number;
  /** after - before. Negative for tasks that lost ground. */
  delta: number;
}

/**
 * The result of ending a sitting — the payoff moment: what all that tapping actually did.
 * Cheap to return, because commit computes every part of it anyway (ADR 0048).
 */
export interface CommitSummary {
  sessionId: string;
  /** Duels written to history. */
  committed: number;
  /** Taps dropped because their task was deleted or completed mid-sitting (0048). */
  skipped: number;
  /** Every task whose rating moved, biggest climber first. */
  moved: RatingChange[];
}

// ── Routines (ADR 0066) — recurring rhythms, wholly outside the engine ───────────────────────────
// A Routine never duels, never gates, never enters Today/Upcoming/the Arena. One discriminated table.

export type RoutineType = 'frequency' | 'interval_floating' | 'interval_fixed';
export type PeriodUnit = 'day' | 'week' | 'month' | 'year';
export type IntervalUnit = 'day' | 'week' | 'month';

/**
 * A fixed calendar rule — three hand-rolled patterns (ADR 0066), NOT RRULE. `weekday` is 0–6 with
 * 0 = Sunday (JS `getUTCDay` convention). Represented on the wire/DB as flat nullable columns on the
 * Routine row; this union is the semantic shape the pure schedule module consumes.
 */
export type FixedRule =
  | { kind: 'nth_weekday_of_month'; ordinal: number; weekday: number } // ordinal 1–5, e.g. "1st Friday"
  | { kind: 'day_of_month'; day: number } // 1–31, clamped to the month's length ("the 31st" → Feb 28)
  | { kind: 'last_weekday_of_month'; weekday: number }; // e.g. "last Friday"
export type FixedRuleKind = FixedRule['kind'];

/**
 * The Routine read DTO — one discriminated row with mode-specific NULLABLE fields (the Task
 * optional-field shape, 0052). Calendar fields are `YYYY-MM-DD`; `snoozedUntil` is the ONE date+time
 * field (ISO), because snooze presets are sub-day (ADR 0066).
 */
export interface Routine {
  id: string;
  ownerId: string;
  name: string;
  type: RoutineType;
  createdAt: string;
  /** Hide-until moment for the display-only Snooze; ISO date+time, or null. Any type. */
  snoozedUntil: string | null;
  // frequency
  periodUnit: PeriodUnit | null;
  targetCount: number | null;
  periodCount: number | null;
  periodStart: string | null;
  // interval_floating
  intervalUnit: IntervalUnit | null;
  intervalCount: number | null;
  preferredWeekday: number | null;
  nextDue: string | null;
  // interval_fixed (the FixedRule flattened)
  ruleKind: FixedRuleKind | null;
  ruleOrdinal: number | null;
  ruleWeekday: number | null;
  ruleDayOfMonth: number | null;
  acknowledgedDate: string | null;
}

/**
 * POST /routines — create a routine. The server validates the fields required by `type` and computes
 * derived state from `on` (the client's local day): a frequency routine's `periodStart`, and a
 * floating routine's initial `nextDue` when `firstDue` is omitted. If `firstDue` IS given it is taken
 * as-is — the user's pick wins and is NOT re-snapped to the preferred weekday (ADR 0066 / v0.15).
 */
export interface CreateRoutineDto {
  name: string;
  type: RoutineType;
  on: string;
  periodUnit?: PeriodUnit;
  targetCount?: number;
  intervalUnit?: IntervalUnit;
  intervalCount?: number;
  preferredWeekday?: number | null;
  firstDue?: string;
  rule?: FixedRule;
}

/**
 * PATCH /routines/:id — edit any field directly (ADR 0066). Values are taken as-is (the option-(c)
 * pattern, no hidden recompute), except where a derived field must follow: changing a frequency's
 * period UNIT re-anchors `periodStart` and resets the tally (a week-count can't carry into a month),
 * and changing a fixed `rule` recomputes the next date and clears a now-stale dismiss. Only fields
 * appropriate to the routine's `type` may be sent. `on` (the client's local day) is required — it
 * re-anchors a period change and computes the returned display state.
 */
export interface UpdateRoutineDto {
  on: string;
  name?: string;
  targetCount?: number;
  periodUnit?: PeriodUnit;
  intervalUnit?: IntervalUnit;
  intervalCount?: number;
  preferredWeekday?: number | null;
  nextDue?: string;
  rule?: FixedRule;
}

/** POST /routines/:id/did and /dismiss — carry the client's local day (0052), like the Today reads. */
export interface RoutineActionDto {
  on: string;
}

/** POST /routines/:id/snooze — the client computes the absolute hide-until from a preset + its clock. */
export interface RoutineSnoozeDto {
  until: string;
}
