import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Password hashing (ADR 0076) — argon2**id**, via the maintained @node-rs/argon2 (prebuilt native, no
 * build toolchain). Plaintext is never stored or logged; only the hash string (which embeds its own
 * salt + params) is persisted. Verify is constant-time by the library and swallows a malformed-hash
 * error into `false` rather than throwing — a login must never 500 on a bad stored value.
 *
 * Params: OWASP's argon2id baseline — 19 MiB memory, 2 passes, 1 lane. Comfortable for a single-user
 * login; the encoded hash carries them, so a future retune verifies old hashes unchanged.
 */
const OPTS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false; // a malformed/foreign hash is a failed verification, never a crash
  }
}
