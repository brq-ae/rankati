import { describe, expect, it } from 'vitest';
import {
  decodeDiscard,
  decodeDone,
  decodeRefile,
  encodeDiscard,
  encodeDone,
  encodeRefile,
  REFILE_BUTTON_CAP,
  selectRefileLists,
} from '../src/telegram/telegram-callback';

const A = '11111111-2222-3333-4444-555555555555';
const B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('re-file callback_data codec (ADR 0084)', () => {
  it('packs two UUIDs into 46 bytes — under the 64-byte cap', () => {
    const data = encodeRefile(A, B);
    expect(data.startsWith('m:')).toBe(true);
    expect(Buffer.byteLength(data, 'utf8')).toBe(46);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('round-trips exactly', () => {
    expect(decodeRefile(encodeRefile(A, B))).toEqual({ taskId: A, listId: B });
  });

  it('round-trips edge UUIDs (all-zero, all-f)', () => {
    const z = '00000000-0000-0000-0000-000000000000';
    const f = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    expect(decodeRefile(encodeRefile(z, f))).toEqual({ taskId: z, listId: f });
  });

  it('rejects malformed payloads with null, never throwing', () => {
    expect(decodeRefile('')).toBeNull();
    expect(decodeRefile('x:not-ours')).toBeNull();
    expect(decodeRefile('m:tooshort')).toBeNull();
    expect(decodeRefile(`m:${'A'.repeat(43)}`)).toBeNull(); // one short of 44
    expect(decodeRefile(`m:${'A'.repeat(45)}`)).toBeNull(); // one over 44
  });
});

describe('done callback_data codec (Step 6)', () => {
  it('packs one UUID + mode into 25 bytes with a distinct "d:" prefix', () => {
    const data = encodeDone(A, 'today');
    expect(data.startsWith('d:')).toBe(true);
    expect(data.startsWith('m:')).toBe(false); // never collides with re-file
    expect(Buffer.byteLength(data, 'utf8')).toBe(25);
  });

  it('round-trips the task id AND the mode', () => {
    expect(decodeDone(encodeDone(A, 'today'))).toEqual({ taskId: A, mode: 'today' });
    expect(decodeDone(encodeDone(B, 'now'))).toEqual({ taskId: B, mode: 'now' });
  });

  it('rejects malformed / wrong-family payloads with null', () => {
    expect(decodeDone('')).toBeNull();
    expect(decodeDone(encodeRefile(A, B))).toBeNull(); // an "m:" payload is not a done payload
    expect(decodeDone('d:xshort')).toBeNull();
    expect(decodeDone(`d:z${'A'.repeat(22)}`)).toBeNull(); // bad mode char
  });
});

describe('discard callback_data codec (Step 8 polish)', () => {
  it('packs one UUID into 24 bytes with a distinct "x:" prefix', () => {
    const data = encodeDiscard(A);
    expect(data.startsWith('x:')).toBe(true);
    expect(Buffer.byteLength(data, 'utf8')).toBe(24);
  });

  it('round-trips the task id', () => {
    expect(decodeDiscard(encodeDiscard(A))).toBe(A);
    expect(decodeDiscard(encodeDiscard(B))).toBe(B);
  });

  it('rejects malformed / wrong-family payloads with null', () => {
    expect(decodeDiscard('')).toBeNull();
    expect(decodeDiscard(encodeDone(A, 'today'))).toBeNull(); // a "d:" payload is not a discard
    expect(decodeDiscard(encodeRefile(A, B))).toBeNull(); // nor an "m:"
    expect(decodeDiscard('x:short')).toBeNull();
  });
});

describe('selectRefileLists (ADR 0084)', () => {
  const L = (id: string, name: string) => ({ id, name });

  it('excludes the inbox, preserves the given (alphabetical) order, and caps', () => {
    const lists = Array.from({ length: 12 }, (_, i) => L(`id${i}`, `List ${i}`));
    const { shown, total } = selectRefileLists(lists, 'id0');
    expect(shown.map((l) => l.id)).not.toContain('id0');
    expect(shown).toHaveLength(REFILE_BUTTON_CAP);
    expect(shown[0].id).toBe('id1'); // order preserved from input
    expect(total).toBe(11); // 12 minus the inbox
  });

  it('returns all candidates when under the cap, with no overflow', () => {
    const lists = [L('inbox', 'Inbox'), L('a', 'A'), L('b', 'B')];
    const { shown, total } = selectRefileLists(lists, 'inbox');
    expect(shown.map((l) => l.name)).toEqual(['A', 'B']);
    expect(total).toBe(2);
  });
});
