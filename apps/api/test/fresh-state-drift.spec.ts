import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCATIONS } from '../src/fresh-state';

/**
 * Drift guard (ADR 0064). `DEFAULT_LOCATIONS` (the TS single-definition consumed by a factory
 * reset) and the four names the `location_gate` migration SEEDS on a fresh database are the same
 * set. The migration is history and is never rewritten, so the two copies cannot be merged — this
 * test makes their divergence LOUD instead, the way the anti-flash guard reads `index.html` rather
 * than trusting a remembered copy of the script.
 *
 * It reads the REAL migration file and parses its INSERT — deliberately NOT a hardcoded copy of the
 * names here, which would be a third copy free to drift from both. Order is not asserted: the two
 * lists are compared as sets, because `findAll` sorts locations by name (0060/0061) so seeding order
 * is cosmetic — the invariant that matters is "the same names", nothing more.
 */
const MIGRATION = join(__dirname, '../prisma/migrations/20260719204043_location_gate/migration.sql');

/** Pull each seeded name out of `(gen_random_uuid(), 'Name', 'local')` rows in the real SQL. */
function seededLocationNames(sql: string): string[] {
  const names: string[] = [];
  const re = /gen_random_uuid\(\)\s*,\s*'([^']+)'\s*,\s*'local'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) names.push(m[1]!);
  return names;
}

describe('fresh-state drift guard (ADR 0064)', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('the instrument works — the migration file really does seed locations', () => {
    // Guard the guard: a broken parse would return [] and make the comparison below pass vacuously.
    // Assert the parse finds the seed before trusting what it compares.
    expect(seededLocationNames(sql).length).toBeGreaterThan(0);
  });

  it('DEFAULT_LOCATIONS is the same set of names the migration seeds', () => {
    const fromMigration = [...seededLocationNames(sql)].sort();
    const fromCode = [...DEFAULT_LOCATIONS].sort();
    expect(fromCode).toEqual(fromMigration);
  });
});
