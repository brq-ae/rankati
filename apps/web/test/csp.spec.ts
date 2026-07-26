import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANTI_FLASH_HASH, CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../csp.mjs';

/**
 * The strict CSP and the anti-flash hash (public hardening, ADR 0051/0076). The load-bearing guard is
 * DRIFT: the pinned hash must equal the sha256 of the inline script actually shipped in index.html, or
 * a future edit to that script would silently break the theme under CSP. We also model the browser's
 * inline-allow decision so the hash is provably load-bearing (a wrong hash blocks the script) — there
 * is no headless browser here to enforce the policy for real.
 */
function antiFlashScript(): string {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('anti-flash inline <script> not found in index.html');
  return match[1];
}

const sha256 = (text: string): string => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

/**
 * Faithful model of how a browser decides whether an inline <script> may run under a CSP: if script-src
 * lists a hash or nonce, 'unsafe-inline' is IGNORED, and the script runs only if its own sha256 is
 * listed. For this policy (a hash, no unsafe-inline) that reduces to "the script's hash is present".
 */
function inlineScriptAllowed(csp: string, scriptText: string): boolean {
  const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
  const hasHashOrNonce = /'(sha(256|384|512)-|nonce-)/.test(scriptSrc);
  if (scriptSrc.includes("'unsafe-inline'") && !hasHashOrNonce) return true;
  return scriptSrc.includes(`'${sha256(scriptText)}'`);
}

describe('the strict CSP + the anti-flash hash (ADR 0051/0076)', () => {
  it('DRIFT GUARD: the pinned hash equals the inline script actually shipped in index.html', () => {
    expect(sha256(antiFlashScript())).toBe(ANTI_FLASH_HASH);
  });

  it('script-src carries the hash and NO unsafe-inline', () => {
    const scriptSrc = /script-src ([^;]*)/.exec(CONTENT_SECURITY_POLICY)?.[1] ?? '';
    expect(scriptSrc).toContain(ANTI_FLASH_HASH);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('the anti-flash script is ALLOWED under the policy — the theme applies with no violation', () => {
    expect(inlineScriptAllowed(CONTENT_SECURITY_POLICY, antiFlashScript())).toBe(true);
  });

  it('self-contained: the fetchable directives stay same-origin (audit holds)', () => {
    for (const directive of [
      "default-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ]) {
      expect(CONTENT_SECURITY_POLICY).toContain(directive);
    }
  });

  it('the companion headers are present', () => {
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });
});
