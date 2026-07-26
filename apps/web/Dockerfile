# The web image. Built and published; the runtime image carries no source or build toolchain (ADR 0044).
# Context is the repo root — pnpm needs the workspace file and lockfile (ADR 0034).

FROM node:22.23.1-trixie-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

########################  build  ########################
FROM base AS build
WORKDIR /repo

# tsconfig.base.json travels with the manifests: apps/web/tsconfig.json extends it, and
# `tsc -b` fails with TS5083 without it.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
# Dependency install scripts stay denied in the image too (ADR 0043).
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @rankati/web...

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @rankati/web build

########################  runtime  ########################
FROM node:22.23.1-trixie-slim AS runtime
WORKDIR /app

# No node_modules at all: server.mjs is dependency-free (ADR 0040), so the runtime
# image is Node + the built assets + one file. Nothing to install, nothing to audit.
COPY --from=build /repo/apps/web/dist ./dist
COPY apps/web/server.mjs ./server.mjs
COPY apps/web/csp.mjs ./csp.mjs

ENV NODE_ENV=production
ENV WEB_PORT=8080
# The one published port of the whole stack (ADRs 0036, 0042).
EXPOSE 8080
USER node

CMD ["node", "server.mjs"]
