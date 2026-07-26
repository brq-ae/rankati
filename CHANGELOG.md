# Changelog

All notable changes to Rankati are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.30.0] — 2026-07-26

Initial public release. Rankati — a self-hosted, single-user personal decision engine for tasks — is now
open source under the GNU AGPL-3.0, distributed as Docker Hub images (`brqae/rankati-api`,
`brqae/rankati-web`) run by a public `docker-compose.yml`.

### Added

- **The Arena** — pairwise-duel ranking that learns a single importance rating per task.
- **Gates** — dependency, availability-window, not-before, and location conditions that hide what you
  can't act on yet.
- **The Today Track** — your ranked, playable tasks dealt as a small, finite, beatable hand.
- **The impact safety-net pin** — a gentle nudge for an important task before it goes neglected too long.
- **Routines**, four colour **themes**, and **single-user authentication** (argon2id, server-side
  revocable sessions).
- **Self-hosting** — `docker compose up` with automatic database migrations on first start; the web front
  door on `:12101`, behind a TLS reverse proxy for internet exposure.
