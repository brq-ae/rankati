import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../src/version';

/**
 * The error reporter's appVersion (version.ts) and the release version (root package.json) are two
 * copies of one value (ADR 0078). This locks them together so a bump to one but not the other — which
 * would ship a report claiming the wrong version — fails the suite instead of shipping silently.
 */
describe('APP_VERSION stays in sync with the release version', () => {
  it('version.ts APP_VERSION === the root package.json version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(APP_VERSION).toBe(pkg.version);
  });
});
