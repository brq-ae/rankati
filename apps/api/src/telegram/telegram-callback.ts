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
