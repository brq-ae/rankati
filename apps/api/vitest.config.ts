import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve @rankati/shared to its SOURCE for tests (ADR 0086) — the api now imports shared VALUES
  // (computePin, DEFAULT_PIN_DAYS, snoozeSpanMs), and tests must reflect the current source, not a possibly
  // stale built `dist`. The production `dist` path is covered separately by the in-image require smoke.
  resolve: {
    alias: {
      '@rankati/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    root: './',
    include: ['test/**/*.spec.ts'],
    // The smoke test drives one shared dev database (ADR 0037); parallel files
    // would race each other's rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  // No unplugin-swc here, deliberately. The usual advice is that Vitest cannot test
  // Nest because esbuild cannot emit decorator metadata — obsolete at Vite 8, which
  // transforms with Oxc and reads emitDecoratorMetadata from tsconfig.json. Verified:
  // DI resolves and all smoke tests pass without it (ADR 0037).
});
