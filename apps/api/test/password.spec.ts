import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password';

/**
 * argon2id password hashing (ADR 0076): a hash verifies its own password, rejects a wrong one, is not
 * the plaintext, and is salted (two hashes of the same password differ). A malformed stored hash
 * verifies as false rather than throwing.
 */
describe('password hashing (ADR 0076)', () => {
  it('hashes then verifies the same password → true', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
  });

  it('rejects a wrong password → false', async () => {
    const h = await hashPassword('s3cret-pass');
    expect(await verifyPassword(h, 's3cret-Pass')).toBe(false);
    expect(await verifyPassword(h, '')).toBe(false);
  });

  it('the hash is NOT the plaintext, and is argon2id', async () => {
    const h = await hashPassword('hunter2');
    expect(h).not.toContain('hunter2');
    expect(h.startsWith('$argon2id$')).toBe(true); // the encoded format names the algorithm
  });

  it('is salted — two hashes of the SAME password differ, both still verify', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same')).toBe(true);
    expect(await verifyPassword(b, 'same')).toBe(true);
  });

  it('a malformed stored hash verifies as false, never throws', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false);
  });
});
