import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Tailwind v4 is a Vite plugin — there is no postcss.config.js by design.
  plugins: [react(), tailwindcss()],
  server: {
    // Bind 0.0.0.0 so the dev server is reachable at the LAN IP (ADR 0035).
    host: true,
    port: 12101,
    // Poll for file changes instead of trusting inotify inode-tracking. `git checkout`/`merge`
    // replace files by writing a NEW inode and renaming over the old one — which an inode-bound
    // watcher silently misses, so Vite keeps serving a stale transform (the recurring
    // stale-dev-server trap; see scripts/dev.sh and Instructions §7). Polling catches those swaps
    // so HMR stays honest. This is `server.*` config — it applies ONLY to `vite` (the dev server)
    // and has no effect on `vite build`, so production output is untouched.
    watch: { usePolling: true, interval: 200 },
    // No `allowedHosts` entry: Vite's host check targets *hostnames*, and this box is
    // reached by raw IP, so the DNS-rebinding protection stays on without pinning our
    // IP into a committed file. Verified by loading it, not assumed (ADR 0042).
    proxy: {
      // The browser only ever talks to :12101. Vite forwards /api to the loopback API,
      // which makes dev same-origin — no CORS — and mirrors the prod single-port
      // shape exactly (ADR 0042).
      '/api': { target: 'http://127.0.0.1:3000' },
    },
  },
});
