# The API image. Built and published; the runtime image carries no source or build toolchain (ADR 0044).
# Context is the repo root — pnpm needs the workspace file, the lockfile and
# packages/shared to resolve @rankati/api (ADR 0034).

# Exact patch AND distro, like postgres:16.14-trixie. `22.23.1-slim` currently resolves
# to bookworm-slim, so a default-distro change could silently move us (ADR 0038).
FROM node:22.23.1-trixie-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

########################  build  ########################
FROM base AS build
WORKDIR /repo

# Manifests first so this layer caches until a dependency actually changes.
# tsconfig.base.json travels with the manifests: prisma.config.ts is TypeScript, so the
# Prisma CLI's loader reads apps/api/tsconfig.json, which extends this. Without it both
# `generate` and `migrate deploy` fail with "File '../../tsconfig.base.json' not found".
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
# Travels with the manifests so the 22 MB engine download below caches against the
# lockfile, not against every source change.
COPY apps/api/scripts/fetch-schema-engine.mjs apps/api/scripts/
# --ignore-scripts: dependency install scripts stay denied in the image too (ADR 0043).
# It also means prisma generate does NOT run here — the schema isn't copied yet.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @rankati/api...

# Prisma 7's client is Rust-free, but `prisma migrate deploy` still needs a native schema
# engine. @prisma/engines' postinstall would fetch it, and that script is denied (0043) —
# which never prevented the download, it only deferred it to the first CLI run: i.e. to
# container boot, as a non-root user who cannot write. That is the bug this fixes.
#
# So fetch it HERE: at build time, pinned to the lockfile's engine commit, and
# checksum-verified. The runtime downloads nothing and needs no network (0044, 0046).
RUN node apps/api/scripts/fetch-schema-engine.mjs /opt/prisma/schema-engine

COPY packages/shared packages/shared
COPY apps/api apps/api

# The Prisma client is gitignored, so it is not in the build context — it must be
# generated here or the build has no client to compile (ADRs 0033, 0043).
#
# This placeholder is BUILD-ONLY and deliberately fake. prisma.config.ts resolves
# env('DATABASE_URL') eagerly, so `generate` refuses to run without one — even though
# it only reads the schema and never opens a connection. Verified: without this the
# build fails with `PrismaConfigEnvError: Cannot resolve environment variable`.
# It exists in this stage alone and cannot reach the runtime image (separate FROM);
# the real URL is injected by Compose at run time (ADRs 0033, 0036).
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build_placeholder_never_connected"
RUN pnpm --filter @rankati/api exec prisma generate
RUN pnpm --filter @rankati/api build

########################  runtime  ########################
FROM base AS runtime
WORKDIR /repo

# A fresh --prod install rather than copying node_modules across stages: pnpm's
# node_modules are symlinks into a store, and copying them between stages breaks them.
# tsconfig.base.json travels with the manifests: prisma.config.ts is TypeScript, so the
# Prisma CLI's loader reads apps/api/tsconfig.json, which extends this. Without it both
# `generate` and `migrate deploy` fail with "File '../../tsconfig.base.json' not found".
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @rankati/api... \
    && pnpm store prune

# The schema engine, baked. Root-owned and mode 0555: node reads and executes it, and
# nothing — not even root — modifies it at runtime. Verified: with the binary present,
# `migrate deploy` needs no write access at all; the "Can't write to ..." error it used
# to throw was Prisma trying to DOWNLOAD a missing engine, not to use one (ADR 0046).
# The stable path deliberately avoids pnpm's version-hashed store directory.
COPY --from=build /opt/prisma/schema-engine /usr/local/lib/prisma/schema-engine
ENV PRISMA_SCHEMA_ENGINE_BINARY=/usr/local/lib/prisma/schema-engine

COPY --from=build /repo/apps/api/dist apps/api/dist
# migrate deploy needs the schema, the committed migrations and the config.
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts
COPY --chmod=0755 apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

WORKDIR /repo/apps/api
ENV NODE_ENV=production
# Non-root, no exceptions (ADR 0036). The image publishes no port (ADR 0042) — only
# the web service is reachable; this is exposed on the internal network alone.
USER node

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
