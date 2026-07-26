/**
 * The session cookie (ADR 0076) — reading, writing, and clearing it, plus the HTTPS derivation.
 *
 * We parse the raw Cookie header ourselves and set cookies via Express's response, so no
 * cookie-parser middleware is needed — the guard and the auth endpoints share these helpers, and
 * the integration tests build the app without any extra middleware and still work.
 */

/** The opaque session token rides in this cookie; its value is the Session row id. */
export const SESSION_COOKIE = 'deck_session';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A trusted ("remember this device") cookie persists for 30 days; see the Session backstop server-side. */
export const TRUSTED_MAX_AGE_MS = 30 * DAY_MS;

/** Only the fields we read off the incoming request — avoids a hard dependency on @types/express. */
export interface HttpRequestLike {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  maxAge?: number;
  path?: string;
}

/** Only the response methods we call — Express supplies these at runtime under platform-express. */
export interface HttpResponseLike {
  cookie(name: string, value: string, options?: CookieOptions): unknown;
  clearCookie(name: string, options?: CookieOptions): unknown;
}

/** First value of a header that may arrive as a comma list or a repeated array. */
export function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim();
}

/**
 * The request is HTTPS iff the trusted proxy says so via X-Forwarded-Proto (ADR 0077). Rankati runs only
 * behind a TLS-terminating proxy, so this header — not the raw socket — is the source of truth, and it
 * is what drives the Secure attribute.
 */
export function isHttps(req: HttpRequestLike): boolean {
  return firstHeader(req.headers['x-forwarded-proto']) === 'https';
}

/** Pull the session token out of the raw Cookie header, or undefined if absent. */
export function readSessionToken(req: HttpRequestLike): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Set the session cookie. Always HttpOnly + SameSite=Lax; Secure only over HTTPS (ADR 0077). A trusted
 * session gets a 30-day Max-Age (persists across restarts of the browser); an untrusted one gets no
 * Max-Age — a pure session cookie that dies on browser close, backstopped by the Session row's expiry.
 */
export function setSessionCookie(res: HttpResponseLike, token: string, trusted: boolean, https: boolean): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: https,
    path: '/',
    ...(trusted ? { maxAge: TRUSTED_MAX_AGE_MS } : {}),
  });
}

export function clearSessionCookie(res: HttpResponseLike): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/' });
}
