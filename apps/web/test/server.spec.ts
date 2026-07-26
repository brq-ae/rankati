import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Smoke test for server.mjs — the hand-rolled static server + /api proxy (ADRs 0040, 0042).
 *
 * It is hand-rolled, so both of its jobs are tested, and so is the security behaviour:
 * with TRUST_PROXY=false the proxy must DISCARD client-supplied X-Forwarded-* headers.
 * That strip is the entire reason the LAN-safe default exists — untested, it is decoration.
 */

/** Planted outside the web root; must never reach a client. */
const SECRET = 'DECK_TRAVERSAL_CANARY_do_not_leak';

const WEB_PORT = 8199;
const API_PORT = 8198;
const web = `http://127.0.0.1:${WEB_PORT}`;

let child: ChildProcess;
let stubApi: Server;
/** Headers the stub API actually received, so we can assert on what was forwarded. */
let lastHeaders: Record<string, string | string[] | undefined> = {};

async function waitForServer(url: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server never came up: ${url}`);
}

beforeAll(async () => {
  // A fixture root, so this test needs no prior `vite build`.
  const base = await mkdtemp(join(tmpdir(), 'deck-web-'));
  // Planted OUTSIDE the served root: if any traversal reaches this, we have a real bug.
  await writeFile(join(base, 'secret.txt'), SECRET);

  const root = join(base, 'dist');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), '<!doctype html><div id="root">SPA</div>');
  await writeFile(join(root, 'app.js'), 'console.log("asset")');

  stubApi = createServer((req, res) => {
    lastHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stub: true, path: req.url }));
  });
  await new Promise<void>((r) => stubApi.listen(API_PORT, '127.0.0.1', r));

  child = spawn('node', [resolve(import.meta.dirname, '../server.mjs')], {
    env: {
      ...process.env,
      WEB_ROOT: root,
      WEB_PORT: String(WEB_PORT),
      WEB_HOST: '127.0.0.1',
      API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      TRUST_PROXY: 'false', // the LAN-safe default under test
    },
    stdio: 'ignore',
  });

  await waitForServer(web);
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stubApi?.close(() => r()));
});

describe('server.mjs — job 1: serve the SPA', () => {
  it('serves index.html at the root', async () => {
    const res = await fetch(`${web}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('id="root"');
  });

  it('serves a real asset', async () => {
    const res = await fetch(`${web}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
  });

  it('sets the strict CSP + companions on the served response (ADR 0051/0076)', async () => {
    const res = await fetch(`${web}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
    expect(scriptSrc).toContain('sha256-'); // the anti-flash script is allowed by its hash
    expect(scriptSrc).not.toContain("'unsafe-inline'"); // ...never by unsafe-inline — the hardening
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('falls back to index.html for an unknown client route', async () => {
    const res = await fetch(`${web}/some/deep/spa/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it('404s a missing asset rather than serving the SPA for it', async () => {
    // A missing .js must not return HTML — that turns a typo into a confusing parse error.
    const res = await fetch(`${web}/missing.js`);
    expect(res.status).toBe(404);
  });

  it('never serves a file from outside the web root', async () => {
    // SECRET sits one directory ABOVE the served root. The property that matters is
    // not the status code — it is that these bytes never reach a client. A traversal
    // that normalises to an extensionless path legitimately gets the SPA fallback
    // (200 + index.html); that leaks nothing. Serving the secret would.
    const attacks = [
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/..%252fsecret.txt',
      '/....//secret.txt',
      '/../../../../etc/passwd',
      '/..%2f..%2f..%2fetc%2fpasswd',
      '/%2e%2e/%2e%2e/etc/passwd',
    ];
    for (const attack of attacks) {
      const res = await fetch(`${web}${attack}`);
      const body = await res.text();
      expect(body, `leaked via ${attack}`).not.toContain(SECRET);
      expect(body, `leaked /etc/passwd via ${attack}`).not.toContain('root:x:');
    }
  });

  it('404s a traversal that resolves to a missing file', async () => {
    const res = await fetch(`${web}/..%2fsecret.txt`);
    expect([403, 404]).toContain(res.status);
  });
});

describe('server.mjs — job 2: proxy /api', () => {
  it('reaches the API through the proxy', async () => {
    const res = await fetch(`${web}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stub: true, path: '/api/health' });
  });

  it('forwards the method and body', async () => {
    const res = await fetch(`${web}/api/lists`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(200);
    expect(lastHeaders['content-type']).toContain('application/json');
  });
});

describe('server.mjs — TRUST_PROXY=false strips forged headers (ADR 0042)', () => {
  it('discards a client-supplied X-Forwarded-Proto', async () => {
    await fetch(`${web}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
    // The lie must not survive: nothing trusted is upstream on a LAN-exposed container.
    expect(lastHeaders['x-forwarded-proto']).toBe('http');
  });

  it('discards a forged X-Forwarded-For chain', async () => {
    await fetch(`${web}/api/health`, { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } });
    const fwd = String(lastHeaders['x-forwarded-for'] ?? '');
    expect(fwd).not.toContain('1.2.3.4');
    expect(fwd).toContain('127.0.0.1');
  });

  it('replaces X-Forwarded-Host with what it observed', async () => {
    await fetch(`${web}/api/health`, { headers: { 'x-forwarded-host': 'evil.example.com' } });
    expect(lastHeaders['x-forwarded-host']).not.toBe('evil.example.com');
    expect(String(lastHeaders['x-forwarded-host'])).toContain('127.0.0.1');
  });
});
