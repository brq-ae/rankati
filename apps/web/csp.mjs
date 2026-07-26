/**
 * The production Content-Security-Policy and companion security headers (public hardening — closes the
 * ADR 0051 backlog: the inline anti-flash theme script vs a strict CSP). Rankati's own web server
 * (server.mjs) sets these, so the image is self-contained and does not lean on the operator's proxy.
 *
 * DEV is exempt: Vite's HMR needs inline/eval, and the dev server never runs server.mjs. This policy is
 * the PRODUCTION served build only.
 */

/**
 * The sha256 of the inline anti-flash script in index.html (ADR 0051) — the ONE inline script we allow,
 * by hash rather than 'unsafe-inline'. It is static, so a build-time hash is the clean fit (not a
 * nonce). PINNED here and GUARDED: test/csp.spec.ts hashes the script actually shipped in index.html
 * and fails if it diverges from this value, so an edit to the script that isn't mirrored here is caught
 * before it silently breaks the theme under CSP.
 */
export const ANTI_FLASH_HASH = 'sha256-690AuazpgRnQRQeaiuCMy6kX4NTRUZVppwHA8g+opsI=';

/**
 * The policy, one directive per line. Audited against the actual built bundle (fonts self-hosted, API
 * same-origin, no external origins, no data: URIs in the bundle):
 *   - script-src carries NO 'unsafe-inline' — the anti-flash script is allowed by its hash alone. This
 *     is the load-bearing hardening.
 *   - style-src keeps 'unsafe-inline': the app renders dynamic inline styles (PendingBar's bar width,
 *     TickCircle's ring geometry) that cannot be hashed. Style injection is low-risk next to script;
 *     the tight control that matters is on script-src.
 *   - img-src allows data: defensively — Vite inlines small assets as data: URIs under its size
 *     threshold, and a data: image is harmless.
 *   - frame-ancestors 'none' + base-uri 'self' + form-action 'self' + object-src 'none' round it out.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' '${ANTI_FLASH_HASH}'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** CSP plus the standard companions: nosniff, and no referrer leaks (Rankati makes only same-origin calls). */
export const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
