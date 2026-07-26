# Contributing to Rankati

Thanks for your interest in Rankati. This is a small, focused project — bug reports, fixes, and
well-scoped improvements are all welcome. Please read the CLA at the bottom **before** you open a pull
request.

## Getting set up

Rankati is a TypeScript pnpm-workspace monorepo (`apps/api` NestJS + Prisma, `apps/web` React + Vite +
Tailwind, `packages/shared` types). You'll need **Node 22**, **pnpm**, and **Docker** (for Postgres).

```bash
pnpm install            # install the workspace
pnpm db:up              # start a local Postgres (Docker)
pnpm --filter @rankati/api exec prisma migrate dev   # apply migrations
pnpm dev                # run the api (:3000) + web (:12101) dev servers
```

Open the web app at **http://localhost:12101** — the first visit shows the create-account screen.

## Running the tests

```bash
pnpm --filter @rankati/api test     # api suite (Vitest, against the local Postgres)
pnpm --filter @rankati/web test     # web suite (Vitest + happy-dom)
pnpm --filter @rankati/api exec tsc --noEmit   # api typecheck
pnpm --filter @rankati/web exec tsc --noEmit   # web typecheck
```

Both suites and both typechecks should be green before you send a PR.

## Pull requests

- **Branch off `main`** and keep the change focused — one concern per PR.
- **Add or update tests** for behaviour changes; keep the suites and typechecks green.
- Use clear commit messages ([Conventional Commits](https://www.conventionalcommits.org/) preferred:
  `feat(...)`, `fix(...)`, `docs(...)`, `chore(...)`).
- Describe **what** changed and **why** in the PR body. If it changes product behaviour, note the
  user-facing effect.
- Please open an issue to discuss anything large before investing time in it.

## Contributor License Agreement (CLA)

By submitting a contribution to Rankati, you certify that you wrote it (or have the right to submit it),
and you agree it is provided under **AGPL-3.0** **and** that you grant the project owner
(**Brq / Saif BinAdhed**) a perpetual, worldwide, irrevocable, royalty-free license to use, modify,
sublicense, and **relicense** your contribution under any terms, including proprietary/commercial terms.
This lets Rankati offer a hosted or commercially-licensed version while remaining open-source. If you
don't agree, please don't submit contributions.

> **Note:** this CLA is written in plain language for clarity, not as vetted legal advice. If you or your
> employer intend to rely on it commercially, have a lawyer review it first.
