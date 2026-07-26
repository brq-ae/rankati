import { config } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer loads .env automatically — it must be explicit (ADR 0033).
// Resolved from THIS file, never from cwd: `pnpm --filter` runs with cwd=apps/api,
// so a cwd-relative path would silently find nothing.
// In the container this file is absent from the runtime image and DATABASE_URL comes
// straight from Compose — dotenv simply finds nothing and no-ops (ADRs 0036, 0042).
config({ path: resolve(__dirname, '../../.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
