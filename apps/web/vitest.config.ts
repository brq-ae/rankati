import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve @rankati/shared to its SOURCE for tests (ADR 0086) — the web imports shared VALUES
  // (computePin, computeLogStats). Without this, vitest's node resolution picks the built `dist`
  // (the package's `default` condition), so a new shared export is missing until a rebuild. The
  // alias keeps unit tests on source, matching the no-build dev loop and the api's vitest config.
  resolve: {
    alias: {
      '@rankati/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    root: './',
    // Two kinds of test live here, and they need different worlds:
    //   *.spec.ts   — spawns server.mjs for real. Must run in NODE.
    //   *.spec.tsx  — renders components. Needs a DOM.
    //
    // So the environment stays `node` globally and component files opt in with a
    // `// @vitest-environment happy-dom` docblock. That is forced, not preferred: vitest 4
    // removed `environmentMatchGlobs`, and separate projects is more config than two kinds
    // of test warrant.
    //
    // No plugins are declared, and none are needed: this file takes priority over
    // vite.config.ts, so the React plugin does not apply here — JSX is transformed by
    // esbuild via tsconfig's `jsx: react-jsx`. The plugin exists for Fast Refresh, which
    // tests do not use.
    include: ['test/**/*.spec.ts', 'test/**/*.spec.tsx'],
    // server.spec.ts binds a fixed port; parallel files would collide.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
