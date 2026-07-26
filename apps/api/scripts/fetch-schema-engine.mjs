// Fetches Prisma's schema-engine at build time, pinned and checksum-verified (ADR 0046).
//
// Why this exists: Prisma 7's CLIENT is Rust-free, but `prisma migrate deploy` still needs
// a native schema-engine binary. @prisma/engines' postinstall would download it — and that
// script is denied (ADR 0043). Denying it did not stop the download; it deferred it to the
// first CLI run, which in a non-root container means a boot-time fetch that fails. So we
// fetch it HERE, deliberately, at build time, and bake it in (ADRs 0044, 0045).
//
// Dependency-free on purpose: the base image has no curl and no wget, and Node has fetch.
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

// The commit comes from the lockfile, never from a literal here: @prisma/engines-version
// is pinned by pnpm, so the engine can never drift from the CLI that runs it.
//
// It is a TRANSITIVE dep, so pnpm's strict layout does not expose it to apps/api directly.
// Reach it through @prisma/client, which is a direct dependency and depends on it (0034).
const clientPkg = require.resolve('@prisma/client/package.json');
const { enginesVersion } = createRequire(clientPkg)('@prisma/engines-version');

// The base image is pinned to node:22.23.1-trixie-slim, which is Debian trixie with
// libssl.so.3 — so the target is fixed. A wrong target 404s here, and a subtly wrong one
// is caught by the container smoke test, which runs migrate deploy for real.
const TARGET = 'debian-openssl-3.0.x';
const dest = process.argv[2];
if (!dest) throw new Error('usage: fetch-schema-engine.mjs <dest>');

const base = `https://binaries.prisma.sh/all_commits/${enginesVersion}/${TARGET}/schema-engine`;

const get = async (url, what) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${what}: ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

console.log(`engine commit (from lockfile): ${enginesVersion}`);
console.log(`target: ${TARGET}`);

const gz = await get(`${base}.gz`, 'engine');
// Both checksums are published; verify the compressed download AND what we unpack from it.
// Honest label: these come from the same host as the binary, so this is TRANSIT INTEGRITY,
// not provenance — Prisma publishes no signature. Same posture as the fnm case (ADR 0038).
const wantGz = (await get(`${base}.gz.sha256`, 'gz checksum')).toString().trim().split(/\s+/)[0];
const gotGz = sha256(gz);
if (gotGz !== wantGz) throw new Error(`gz checksum mismatch:\n  want ${wantGz}\n  got  ${gotGz}`);
console.log(`gz sha256 verified:  ${gotGz}`);

const bin = gunzipSync(gz);
const wantBin = (await get(`${base}.sha256`, 'binary checksum')).toString().trim().split(/\s+/)[0];
const gotBin = sha256(bin);
if (gotBin !== wantBin) throw new Error(`binary checksum mismatch:\n  want ${wantBin}\n  got  ${gotBin}`);
console.log(`bin sha256 verified: ${gotBin}`);

mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, bin);
chmodSync(dest, 0o555); // read+execute, no write: nothing may modify it at runtime
console.log(`wrote ${dest} (${bin.length} bytes, mode 0555)`);
