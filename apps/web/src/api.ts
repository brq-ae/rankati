import type {
  ChecklistItem,
  CommitSummary,
  CreateChecklistItemDto,
  CreateListDto,
  CreateLocationDto,
  CreateTaskDto,
  List,
  Location,
  Log,
  CreateLogDto,
  UpdateLogDto,
  MergeLocationsDto,
  NextPairResult,
  PinDays,
  ResetRequestDto,
  Routine,
  CreateRoutineDto,
  UpdateRoutineDto,
  StartSessionDto,
  StartSessionResult,
  SubmitResultDto,
  CreateRequiredTaskDto,
  Effort,
  Task,
  TelegramConfigDto,
  TelegramStatusDto,
  UpdateChecklistItemDto,
  UpdateListDto,
  UpdateLocationDto,
  UpdateTaskDto,
  UpdateTelegramDigestDto,
} from '@rankati/shared';

/**
 * Every request uses a RELATIVE path — never a host, port, or scheme (ADR 0042).
 *
 * This is the rule that lets one image serve any IP and any domain with no rebuild:
 * in dev, Vite proxies /api to the loopback API; in production, the web container
 * proxies /api to the api service. Both are same-origin, so there is no CORS and
 * nothing to configure per environment. Do not add a base URL here.
 */
/**
 * A single seam for session expiry (ADR 0076): when any request comes back 401 mid-use — the session
 * expired or was revoked server-side — the app should route back to the login screen rather than show a
 * broken UI. App registers a handler; api.ts fires it before throwing, so no per-call site has to know.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/** For the raw-fetch helpers (no JSON body to parse): fire the 401 seam, then throw. */
function ensureOk(res: Response): void {
  if (res.ok) return;
  if (res.status === 401) onUnauthorized?.();
  throw new Error(`${res.status} ${res.statusText}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.(); // session expired/revoked → back to login
    // The API returns { message } for 4xx (ADR: see ARCHITECTURE §0.1).
    const body: unknown = await res.json().catch(() => null);
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }

  return (await res.json()) as T;
}

export const getLists = (): Promise<List[]> => request<List[]>('/api/lists');

/** Rename a list — the gap v0.1 left (tasks could be renamed, lists could not). */
export const updateList = (id: string, dto: UpdateListDto): Promise<List> =>
  request<List>(`/api/lists/${id}`, { method: 'PATCH', body: JSON.stringify(dto) });

export const createList = (dto: CreateListDto): Promise<List> =>
  request<List>('/api/lists', { method: 'POST', body: JSON.stringify(dto) });

/** Delete a list; the server cascades its tasks (and their deps and tags), ADR 0064. */
export const deleteList = async (id: string): Promise<void> => {
  const res = await fetch(`/api/lists/${id}`, { method: 'DELETE' });
  ensureOk(res);
};

/**
 * The destructive reset (ADR 0064). `confirm` MUST be the literal "DELETE" or the server refuses —
 * the machine floor beneath the UI's typed-DELETE box. The summary body is ignored by the client.
 */
export const resetApp = (dto: ResetRequestDto): Promise<void> =>
  request<void>('/api/reset', { method: 'POST', body: JSON.stringify(dto) });

export const getTasks = (): Promise<Task[]> => request<Task[]>('/api/tasks');

/** The managed location set (ADR 0060). The dropdown's options and the name resolver. */
export const getLocations = (): Promise<Location[]> => request<Location[]>('/api/locations');

export const createLocation = (dto: CreateLocationDto): Promise<Location> =>
  request<Location>('/api/locations', { method: 'POST', body: JSON.stringify(dto) });

export const updateLocation = (id: string, dto: UpdateLocationDto): Promise<Location> =>
  request<Location>(`/api/locations/${id}`, { method: 'PATCH', body: JSON.stringify(dto) });

export const deleteLocation = async (id: string): Promise<void> => {
  const res = await fetch(`/api/locations/${id}`, { method: 'DELETE' });
  ensureOk(res);
};

/** Fold source into target and delete the source (ADR 0061). Returns the surviving set. */
export const mergeLocations = (dto: MergeLocationsDto): Promise<Location[]> =>
  request<Location[]>('/api/locations/merge', { method: 'POST', body: JSON.stringify(dto) });

export const createTask = (dto: CreateTaskDto): Promise<Task> =>
  request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(dto) });

/**
 * Commit a tick (ADR 0055). Called at ring-end or on leave — NEVER at tap.
 *
 * `keepalive` is what makes commit-on-leave real rather than hopeful: a normal fetch started
 * during pagehide is likely to be cancelled as the page goes away, which would silently not
 * commit — the exact loss the grace period exists to prevent, reintroduced by its own
 * mechanism. It is off by default because it is only needed on the way out, and it caps the
 * body at 64KB.
 */
export const completeTask = (id: string, keepalive = false): Promise<Task> =>
  request<Task>(`/api/tasks/${id}/complete`, { method: 'PATCH', keepalive });

/**
 * Every task, ranked and UNGATED — what the Lists view shows (ADRs 0003, 0047).
 *
 * Gates are not applied here on purpose: Lists shows everything, including tasks waiting
 * for their day, so you can see and edit them (0052).
 */
export const getRankedTasks = (): Promise<Task[]> => request<Task[]>('/api/tasks?sort=rating');

/**
 * The Today read: active tasks whose gates have opened, ranked (ADR 0052).
 *
 * `on` is OUR local day — the server has no way to know it and will 400 rather than guess.
 * That is the point: a gate that silently stops gating is worse than no gate.
 *
 * `at` is OUR local time, HH:MM — the availability-window gate's clock context (ADR 0070),
 * sent on EVERY read for the same reason: the server judges windows by the user's clock,
 * never its own, and fail-closes (400) the moment a windowed task exists. Always sending it
 * means the first windowed task ever created cannot strand this client behind that 400.
 */
export const getTodayTasks = (on: string, at: string, block?: Effort): Promise<Task[]> => {
  // `block` is the fit term's free-block context (ADR 0072) — the ORDINAL bucket only, never a
  // minute count. It rides THIS read alone (Upcoming does not take it), is OPTIONAL (absent = Any =
  // neutral), and is EPHEMERAL: it is a live UI choice, never read from storage, so a reload has no
  // block to send. The display-only thresholds that label the picker stay client-side and never
  // touch this URL — only quick/medium/long crosses the wire.
  const q = `on=${encodeURIComponent(on)}&at=${encodeURIComponent(at)}`;
  return request<Task[]>(`/api/tasks/today?${q}${block ? `&block=${block}` : ''}`);
};

/**
 * The Upcoming read: dated, playable tasks not yet near enough for Today (ADR 0058). Same `on`,
 * same `at`, same 400-if-absent rules (0052, 0070); the threshold is the only thing dividing
 * it from Today.
 */
export const getUpcomingTasks = (on: string, at: string): Promise<Task[]> =>
  request<Task[]>(`/api/tasks/upcoming?on=${encodeURIComponent(on)}&at=${encodeURIComponent(at)}`);

export const updateTask = (id: string, dto: UpdateTaskDto): Promise<Task> =>
  request<Task>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(dto) });

/**
 * Create a prerequisite and link it, in one transaction (ADR 0054).
 *
 * One call, not two: a create that succeeded followed by a link that failed would strand an
 * orphan task in a list nobody chose. Returns the BLOCKED task — we asked what it now
 * requires, and its dependsOn is the answer.
 */
export const createRequiredTask = (id: string, dto: CreateRequiredTaskDto): Promise<Task> =>
  request<Task>(`/api/tasks/${id}/requires`, { method: 'POST', body: JSON.stringify(dto) });

/** 204, so there is no body to parse. */
export const deleteTask = async (id: string): Promise<void> => {
  const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
  ensureOk(res);
};

/**
 * A per-task readiness checklist (ADR 0071) — soft, never a gate. Creation is addressed through
 * the parent task; edit and delete address the item's own id, mirroring the server's routes.
 */
export const addChecklistItem = (taskId: string, text: string): Promise<ChecklistItem> =>
  request<ChecklistItem>(`/api/tasks/${taskId}/checklist`, {
    method: 'POST',
    body: JSON.stringify({ text } satisfies CreateChecklistItemDto),
  });

export const updateChecklistItem = (
  itemId: string,
  dto: UpdateChecklistItemDto,
): Promise<ChecklistItem> =>
  request<ChecklistItem>(`/api/checklist/${itemId}`, { method: 'PATCH', body: JSON.stringify(dto) });

/** 204, so there is no body to parse. */
export const deleteChecklistItem = async (itemId: string): Promise<void> => {
  const res = await fetch(`/api/checklist/${itemId}`, { method: 'DELETE' });
  ensureOk(res);
};

/**
 * Open a sitting (ADR 0048). Returns a UNION, not a throw: a pool too small to duel is
 * `status: 'need-more-tasks'` at 200, and the caller switches on it rather than catching.
 */
export const startSession = (dto: StartSessionDto = {}): Promise<StartSessionResult> =>
  request<StartSessionResult>('/api/duel-sessions', {
    method: 'POST',
    body: JSON.stringify(dto),
  });

/**
 * One tap. The response carries the NEXT pair — that is what makes "next pair appears
 * instantly" possible, so never follow this with a fetch.
 *
 * `dto.dealId` names the pair being judged. A stale one comes back 409 rather than being
 * recorded against whatever is on the table now.
 */
export const submitResult = (sessionId: string, dto: SubmitResultDto): Promise<NextPairResult> =>
  request<NextPairResult>(`/api/duel-sessions/${sessionId}/results`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });

/** Undo the last tap and get a FRESH pair — never the mis-tapped one (ADR 0048). */
export const undoLastResult = (sessionId: string): Promise<NextPairResult> =>
  request<NextPairResult>(`/api/duel-sessions/${sessionId}/results/last`, { method: 'DELETE' });

/** End the sitting: ratings settle here, and this is the only place numbers are shown. */
export const commitSession = (sessionId: string): Promise<CommitSummary> =>
  request<CommitSummary>(`/api/duel-sessions/${sessionId}/commit`, { method: 'POST' });

// ── Routines (ADR 0066) — a silo; nothing here touches tasks or the engine. Reads take the client's
// local day; the compute-fresh display state comes back computed. ──────────────────────────────────
export const getRoutines = (on: string): Promise<Routine[]> =>
  request<Routine[]>(`/api/routines?on=${encodeURIComponent(on)}`);

export const createRoutine = (dto: CreateRoutineDto): Promise<Routine> =>
  request<Routine>('/api/routines', { method: 'POST', body: JSON.stringify(dto) });

export const updateRoutine = (id: string, dto: UpdateRoutineDto): Promise<Routine> =>
  request<Routine>(`/api/routines/${id}`, { method: 'PATCH', body: JSON.stringify(dto) });

export const deleteRoutine = async (id: string): Promise<void> => {
  const res = await fetch(`/api/routines/${id}`, { method: 'DELETE' });
  ensureOk(res);
};

export const routineDid = (id: string, on: string): Promise<Routine> =>
  request<Routine>(`/api/routines/${id}/did`, { method: 'POST', body: JSON.stringify({ on }) });

export const routineDismiss = (id: string, on: string): Promise<Routine> =>
  request<Routine>(`/api/routines/${id}/dismiss`, { method: 'POST', body: JSON.stringify({ on }) });

export const routineSnooze = (id: string, until: string): Promise<Routine> =>
  request<Routine>(`/api/routines/${id}/snooze`, { method: 'POST', body: JSON.stringify({ until }) });

// ── Logs (ADR 0087) — pull-based cadence trackers; a sibling silo, also wholly outside the engine.
// Reads (and the mutations that return a Log) carry the client's local day so the server-derived cadence
// stats come back fresh. The list is light (stats only); the detail read carries the dated occurrences. ─
export const getLogs = (on: string): Promise<Log[]> =>
  request<Log[]>(`/api/logs?on=${encodeURIComponent(on)}`);

export const getLog = (id: string, on: string): Promise<Log> =>
  request<Log>(`/api/logs/${id}?on=${encodeURIComponent(on)}`);

export const createLog = (dto: CreateLogDto): Promise<Log> =>
  request<Log>('/api/logs', { method: 'POST', body: JSON.stringify(dto) });

export const renameLog = (id: string, dto: UpdateLogDto, on: string): Promise<Log> =>
  request<Log>(`/api/logs/${id}?on=${encodeURIComponent(on)}`, { method: 'PATCH', body: JSON.stringify(dto) });

export const deleteLog = async (id: string): Promise<void> => {
  const res = await fetch(`/api/logs/${id}`, { method: 'DELETE' });
  ensureOk(res);
};

export const logDid = (id: string, on: string): Promise<Log> =>
  request<Log>(`/api/logs/${id}/did`, { method: 'POST', body: JSON.stringify({ on }) });

export const logUndo = (id: string, entryId: string, on: string): Promise<Log> =>
  request<Log>(`/api/logs/${id}/entries/${encodeURIComponent(entryId)}?on=${encodeURIComponent(on)}`, {
    method: 'DELETE',
  });

// ── Auth (ADR 0076) — the front door. status routes the app; setup/login open a session (the server
// sets the cookie); logout revokes it. login is raw (not `request`) so the caller sees the 401/429
// status and the Retry-After header the lockout emits. ─────────────────────────────────────────────
export interface AuthStatus {
  needsSetup: boolean;
  authenticated: boolean;
}
export interface Credentials {
  username: string;
  password: string;
  trusted: boolean;
}

export const getAuthStatus = (): Promise<AuthStatus> => request<AuthStatus>('/api/auth/status');

/** First-run: create the single account. The server auto-logs-in on success (sets the cookie). */
export const setupAccount = (dto: Credentials): Promise<void> =>
  request<void>('/api/auth/setup', { method: 'POST', body: JSON.stringify(dto) });

/** Outcome of a login attempt — a discriminated union so the screen can tell 401 from a 429 lockout. */
export type LoginOutcome = { ok: true } | { ok: false; status: number; retryAfterSeconds?: number };

export async function login(dto: Credentials): Promise<LoginOutcome> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
  });
  if (res.ok) return { ok: true };
  const retryAfter = res.headers.get('Retry-After');
  return {
    ok: false,
    status: res.status,
    retryAfterSeconds: retryAfter !== null ? Number(retryAfter) : undefined,
  };
}

/** Revoke the current session server-side. Best-effort: the client returns to login regardless. */
export const logout = (): Promise<void> => request<void>('/api/auth/logout', { method: 'POST' });

/** Change-password outcome — raw (not `request`) so a wrong-current 401 shows inline and does NOT trip
 *  the global 401 seam (which would log you out mid-change). */
export type ChangePasswordOutcome = { ok: true } | { ok: false; status: number };

export async function changePassword(dto: {
  currentPassword: string;
  newPassword: string;
}): Promise<ChangePasswordOutcome> {
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
  });
  return res.ok ? { ok: true } : { ok: false, status: res.status };
}

// ---- Telegram bot settings (ADR 0084, Step 8) — thin wrappers over the authed endpoints. ----

export const getTelegramConfig = (): Promise<TelegramConfigDto> =>
  request<TelegramConfigDto>('/api/telegram/config');

/** The poller's live health — polled after a token change to settle the "connected/rejected" badge. */
export const getTelegramStatus = (): Promise<TelegramStatusDto> =>
  request<TelegramStatusDto>('/api/telegram/status');

export const setTelegramToken = (token: string): Promise<TelegramConfigDto> =>
  request<TelegramConfigDto>('/api/telegram/token', { method: 'PUT', body: JSON.stringify({ token }) });

/** Remove the bot token — unbinds + stops the poller (confirm in the UI first). */
export const deleteTelegramToken = (): Promise<TelegramConfigDto> =>
  request<TelegramConfigDto>('/api/telegram/token', { method: 'DELETE' });

export const regenerateTelegramCode = (): Promise<TelegramConfigDto> =>
  request<TelegramConfigDto>('/api/telegram/link-code', { method: 'POST' });

export const unlinkTelegram = (): Promise<TelegramConfigDto> =>
  request<TelegramConfigDto>('/api/telegram/unlink', { method: 'POST' });

export const setTelegramDigest = (dto: UpdateTelegramDigestDto): Promise<TelegramConfigDto> =>
  request<TelegramConfigDto>('/api/telegram/digest', { method: 'PUT', body: JSON.stringify(dto) });

// ---- Impact pin config + snooze (ADR 0086) — server-backed, one source across clients. ----

/** The four pin day-knobs. */
export const getPinConfig = (): Promise<PinDays> => request<PinDays>('/api/settings/pin');

/** Save the knobs; returns the server's VALIDATED result (a bad field defaulted, not rejected). */
export const setPinConfig = (config: PinDays): Promise<PinDays> =>
  request<PinDays>('/api/settings/pin', { method: 'PUT', body: JSON.stringify(config) });

/** Snooze a task's pin; returns the updated task (with pinSnoozedUntil set). */
export const snoozePin = (taskId: string): Promise<Task> =>
  request<Task>(`/api/tasks/${taskId}/pin-snooze`, { method: 'POST' });

/** Clear a task's pin snooze; returns the updated task. */
export const unsnoozePin = (taskId: string): Promise<Task> =>
  request<Task>(`/api/tasks/${taskId}/pin-snooze`, { method: 'DELETE' });
