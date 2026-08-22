/**
 * Telegram callback_data codec for the re-file buttons (ADR 0084, Step 5).
 *
 * Telegram caps callback_data at 64 BYTES. A re-file button must carry BOTH the task and the target list,
 * but two raw UUIDs are 72 bytes. So each UUID travels as base64url of its 16 raw bytes (22 chars): the
 * payload is "m:" + task(22) + list(22) = 46 bytes, comfortably under the cap and fully self-contained (no
 * server-side action map to go stale on restart).
 */

const REFILE_PREFIX = 'm:';
const TOKEN_LEN = 22; // base64url of 16 bytes

/** The regex the transport routes re-file callbacks on. */
export const REFILE_TRIGGER = /^m:/;

/** How many list buttons a capture confirmation shows at most (ADR 0084) — never a wall of buttons. */
export const REFILE_BUTTON_CAP = 8;

/** A UUID (36 chars) → its 16 raw bytes as base64url (22 chars). */
function uuidToToken(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
}

/** A 22-char base64url token → the canonical UUID string. Throws unless it decodes to exactly 16 bytes. */
function tokenToUuid(token: string): string {
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 16) throw new Error('token is not 16 bytes');
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Pack a (task, list) pair into callback_data. */
export function encodeRefile(taskId: string, listId: string): string {
  return `${REFILE_PREFIX}${uuidToToken(taskId)}${uuidToToken(listId)}`;
}

/** Unpack callback_data → the (task, list) ids, or null if it is not a well-formed re-file payload. */
export function decodeRefile(data: string): { taskId: string; listId: string } | null {
  if (!data.startsWith(REFILE_PREFIX)) return null;
  const body = data.slice(REFILE_PREFIX.length);
  if (body.length !== TOKEN_LEN * 2) return null;
  try {
    return {
      taskId: tokenToUuid(body.slice(0, TOKEN_LEN)),
      listId: tokenToUuid(body.slice(TOKEN_LEN)),
    };
  } catch {
    return null;
  }
}

// ── Done button (Step 6) ─────────────────────────────────────────────────────────────────────────────

const DONE_PREFIX = 'd:';

/** The regex the transport routes ✓ Done callbacks on (distinct from re-file's "m:"). */
export const DONE_TRIGGER = /^d:/;

/** Which command the button was shown under, so the tap knows how to update the message. */
export type DoneMode = 'today' | 'now';

/**
 * Pack a ✓ Done button's payload: "d:" + a 1-char mode (t = /today re-render the hand, n = /now edit to
 * done) + base64url(taskId) = 25 bytes. One UUID fits easily; the mode carries the (small) context the two
 * commands' differing completion UX needs.
 */
export function encodeDone(taskId: string, mode: DoneMode): string {
  return `${DONE_PREFIX}${mode === 'now' ? 'n' : 't'}${uuidToToken(taskId)}`;
}

/** Unpack a ✓ Done payload → the task id + its mode, or null if malformed. */
export function decodeDone(data: string): { taskId: string; mode: DoneMode } | null {
  if (!data.startsWith(DONE_PREFIX)) return null;
  const body = data.slice(DONE_PREFIX.length);
  if (body.length !== 1 + TOKEN_LEN) return null;
  const modeChar = body[0];
  if (modeChar !== 't' && modeChar !== 'n') return null;
  try {
    return { taskId: tokenToUuid(body.slice(1)), mode: modeChar === 'n' ? 'now' : 'today' };
  } catch {
    return null;
  }
}

// ── Discard button (Step 8 polish) ───────────────────────────────────────────────────────────────────

const DISCARD_PREFIX = 'x:';

/** The regex the transport routes 🗑 Discard callbacks on (distinct from "m:"/"d:"). */
export const DISCARD_TRIGGER = /^x:/;

/** Pack a 🗑 Discard button's payload: "x:" + base64url(taskId) = 24 bytes. */
export function encodeDiscard(taskId: string): string {
  return `${DISCARD_PREFIX}${uuidToToken(taskId)}`;
}

/** Unpack a 🗑 Discard payload → the task id, or null if malformed. */
export function decodeDiscard(data: string): string | null {
  if (!data.startsWith(DISCARD_PREFIX)) return null;
  const body = data.slice(DISCARD_PREFIX.length);
  if (body.length !== TOKEN_LEN) return null;
  try {
    return tokenToUuid(body);
  } catch {
    return null;
  }
}

// ── Pin snooze button (Step 6) ───────────────────────────────────────────────────────────────────────

const PIN_SNOOZE_PREFIX = 's:';

/** The regex the transport routes 😴 Snooze callbacks on (distinct from "m:"/"d:"/"x:"). */
export const PIN_SNOOZE_TRIGGER = /^s:/;

/** Pack a 😴 Snooze button's payload: "s:" + base64url(taskId) = 24 bytes. */
export function encodePinSnooze(taskId: string): string {
  return `${PIN_SNOOZE_PREFIX}${uuidToToken(taskId)}`;
}

/** Unpack a 😴 Snooze payload → the task id, or null if malformed. */
export function decodePinSnooze(data: string): string | null {
  if (!data.startsWith(PIN_SNOOZE_PREFIX)) return null;
  const body = data.slice(PIN_SNOOZE_PREFIX.length);
  if (body.length !== TOKEN_LEN) return null;
  try {
    return tokenToUuid(body);
  } catch {
    return null;
  }
}

// ── List picker (ADR 0088) — /lists navigation buttons ──────────────────────────────────────────────

const LIST_PICK_PREFIX = 'l:';

/** The regex the transport routes /lists list-picker taps on (distinct from "m:"/"d:"/"x:"/"s:"). */
export const LIST_PICK_TRIGGER = /^l:/;

/** Pack a /lists picker button's payload: "l:" + base64url(listId) = 24 bytes. Navigation, not an action. */
export function encodeListPick(listId: string): string {
  return `${LIST_PICK_PREFIX}${uuidToToken(listId)}`;
}

/** Unpack a /lists picker payload → the list id, or null if malformed. */
export function decodeListPick(data: string): string | null {
  if (!data.startsWith(LIST_PICK_PREFIX)) return null;
  const body = data.slice(LIST_PICK_PREFIX.length);
  if (body.length !== TOKEN_LEN) return null;
  try {
    return tokenToUuid(body);
  } catch {
    return null;
  }
}

// ── Nag-reminder buttons (ADR 0091 M2) — ✓ Did it / 😴 Later / Skip today ─────────────────────────────
// Each carries a ROUTINE id (packed identically to a task id). Distinct prefixes g:/w:/k: (m d x s l taken).

const NAG_DID_PREFIX = 'g:';
const NAG_LATER_PREFIX = 'w:';
const NAG_SKIP_PREFIX = 'k:';

/** Triggers the transport routes the three nag buttons on. */
export const NAG_DID_TRIGGER = /^g:/;
export const NAG_LATER_TRIGGER = /^w:/;
export const NAG_SKIP_TRIGGER = /^k:/;

/** A single-UUID nag payload: "<prefix>" + base64url(routineId) = 24 bytes. */
function encodeNag(prefix: string, routineId: string): string {
  return `${prefix}${uuidToToken(routineId)}`;
}
/** Unpack a single-UUID nag payload → the routine id, or null if malformed. */
function decodeNag(prefix: string, data: string): string | null {
  if (!data.startsWith(prefix)) return null;
  const body = data.slice(prefix.length);
  if (body.length !== TOKEN_LEN) return null;
  try {
    return tokenToUuid(body);
  } catch {
    return null;
  }
}

/** ✓ Did it — record + satisfy for the period (and write the linked Log if any). */
export const encodeNagDid = (routineId: string): string => encodeNag(NAG_DID_PREFIX, routineId);
export const decodeNagDid = (data: string): string | null => decodeNag(NAG_DID_PREFIX, data);

/** 😴 Later — opens the 1h / 3h / until-morning span submenu (the span codec is added with that handler). */
export const encodeNagLater = (routineId: string): string => encodeNag(NAG_LATER_PREFIX, routineId);
export const decodeNagLater = (data: string): string | null => decodeNag(NAG_LATER_PREFIX, data);

/** Skip today — mute the nag until the next due period, without recording. */
export const encodeNagSkip = (routineId: string): string => encodeNag(NAG_SKIP_PREFIX, routineId);
export const decodeNagSkip = (data: string): string | null => decodeNag(NAG_SKIP_PREFIX, data);

/** 😴 Later's chosen span: 1 hour / 3 hours / until morning. */
export type NagSnoozeSpan = 'hour' | 'threeHours' | 'morning';
const NAG_SNOOZE_PREFIX = 'y:';
const SPAN_CHAR: Record<NagSnoozeSpan, string> = { hour: 'h', threeHours: 't', morning: 'm' };
const CHAR_SPAN: Record<string, NagSnoozeSpan> = { h: 'hour', t: 'threeHours', m: 'morning' };

/** The regex the transport routes the span sub-buttons on. */
export const NAG_SNOOZE_TRIGGER = /^y:/;

/** Pack a span sub-button: "y:" + span char(1) + base64url(routineId) = 25 bytes. */
export function encodeNagSnooze(routineId: string, span: NagSnoozeSpan): string {
  return `${NAG_SNOOZE_PREFIX}${SPAN_CHAR[span]}${uuidToToken(routineId)}`;
}

/** Unpack a span sub-button → { routineId, span }, or null if malformed. */
export function decodeNagSnooze(data: string): { routineId: string; span: NagSnoozeSpan } | null {
  if (!data.startsWith(NAG_SNOOZE_PREFIX)) return null;
  const body = data.slice(NAG_SNOOZE_PREFIX.length);
  if (body.length !== 1 + TOKEN_LEN) return null;
  const span = CHAR_SPAN[body[0]!];
  if (!span) return null;
  try {
    return { routineId: tokenToUuid(body.slice(1)), span };
  } catch {
    return null;
  }
}

/**
 * The lists offered as re-file buttons (ADR 0084): the input is already alphabetical (ListsService.findAll
 * orders by name, matching the web app). Drop the Inbox itself and cap the count; return what to show plus
 * the total available so the caller can note an overflow rather than silently hiding lists.
 */
export function selectRefileLists<T extends { id: string }>(
  alphabeticalLists: T[],
  inboxId: string,
  cap = REFILE_BUTTON_CAP,
): { shown: T[]; total: number } {
  const candidates = alphabeticalLists.filter((l) => l.id !== inboxId);
  return { shown: candidates.slice(0, cap), total: candidates.length };
}
