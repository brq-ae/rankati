/**
 * The web container's server (ADRs 0040, 0042). Two jobs, zero dependencies:
 *   1. serve the built SPA from dist/, with fallback to index.html
 *   2. reverse-proxy /api/* to the api service
 *
 * Those two jobs behind ONE published port are what let the same image serve a LAN IP
 * and a Cloudflare domain with no rebuild (ADR 0042). Kept dependency-free so the
 * runtime image is Node + dist/ + this file, and stays `USER node` (ADR 0040).
 *
 * .mjs, not .js: ESM regardless of any package.json that may or may not sit beside it.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS } from './csp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** WEB_ROOT exists so the smoke test can point at a fixture without a full build. */
const ROOT = resolve(process.env.WEB_ROOT ?? join(HERE, 'dist'));
const PORT = Number(process.env.WEB_PORT ?? 8080);
const HOST = process.env.WEB_HOST ?? '0.0.0.0';
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://api:3000';

/**
 * Do we believe X-Forwarded-* headers arriving from upstream?
 *
 * Default FALSE, and that default is the security control (ADR 0042). This same image
 * may be published straight onto the LAN, where any client can forge X-Forwarded-Proto.
 * With TRUST_PROXY=false we DROP whatever the client sent and substitute what we
 * actually observed. Only set true when a trusted proxy (Cloudflare, nginx) is really
 * in front — otherwise "honouring" these headers means honouring a lie.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function proxyToApi(req, res) {
  const target = new URL(API_ORIGIN);
  const headers = { ...req.headers, host: target.host };
  const clientIp = req.socket.remoteAddress ?? '';

  if (TRUST_PROXY) {
    // A trusted proxy is in front: preserve its chain and append ourselves.
    const chain = req.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = chain ? `${chain}, ${clientIp}` : clientIp;
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? 'http';
    headers['x-forwarded-host'] = req.headers['x-forwarded-host'] ?? req.headers.host ?? '';
  } else {
    // Nothing upstream is trusted, so anything the client claims is discarded.
    headers['x-forwarded-for'] = clientIp;
    headers['x-forwarded-proto'] = 'http';
    headers['x-forwarded-host'] = req.headers.host ?? '';
  }

  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', () => {
    if (!res.headersSent) {
      send(res, 502, JSON.stringify({ message: 'API unreachable' }), {
        'content-type': 'application/json; charset=utf-8',
      });
    } else {
      res.end();
    }
  });

  req.pipe(upstream);
}

async function serveFile(res, path) {
  const type = MIME[extname(path)] ?? 'application/octet-stream';
  // index.html must never be cached, or a deploy leaves stale asset URLs behind.
  const cache = path.endsWith('index.html')
    ? 'no-cache'
    : 'public, max-age=31536000, immutable';
  // The strict CSP + companions ride every served response (ADR 0051/0076). What matters is the
  // document (index.html), but sending them on every asset too costs nothing and keeps it uniform.
  res.writeHead(200, { 'content-type': type, 'cache-control': cache, ...SECURITY_HEADERS });
  createReadStream(path).pipe(res);
}

async function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request', SECURITY_HEADERS);
  }

  // normalize() resolves any ../ segments; because pathname is absolute, a leading
  // ../ cannot escape. resolve() then confines it, and the prefix check is the belt
  // to that braces — a traversal must fail closed, not "probably not resolve".
  const target = resolve(ROOT, `.${normalize(pathname)}`);
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    return send(res, 403, 'Forbidden', SECURITY_HEADERS);
  }

  try {
    const info = await stat(target);
    if (info.isFile()) return serveFile(res, target);
  } catch {
    /* fall through to the SPA fallback */
  }

  // A missing asset is a 404; a missing route is the SPA's problem, so it gets
  // index.html and the client router decides.
  if (extname(pathname)) return send(res, 404, 'Not Found', SECURITY_HEADERS);

  try {
    await stat(join(ROOT, 'index.html'));
    return serveFile(res, join(ROOT, 'index.html'));
  } catch {
    return send(res, 404, 'Not Found', SECURITY_HEADERS);
  }
}

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/')) return proxyToApi(req, res);
  void serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`web: serving ${ROOT} on ${HOST}:${PORT}, /api -> ${API_ORIGIN}`);
  console.log(`web: TRUST_PROXY=${TRUST_PROXY}`);
});
