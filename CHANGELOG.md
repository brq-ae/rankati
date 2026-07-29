# Changelog

All notable changes to Rankati are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.33.1] — 2026-07-29

### Fixed

- **Mobile tap accuracy** — on a mobile browser tab, taps could register a few pixels above their target because the layout was pinned to the toolbar-hidden viewport height. The app now tracks the dynamic viewport, so taps land where you touch.

## [0.33.0] — 2026-07-29

**Logs, plus two fixes** — a new way to track things you do irregularly, a dropdown fix for dark themes, and a fixed install icon. **Migration-bearing** (the api applies it automatically on boot).

### Added

- **Logs** — the Routines tab now has two sub-tabs: **Reminders** (the recurring routines) and **Logs**, a new pull-based cadence tracker. A Log (Haircut, Nails, Pedicure) records dated occurrences with **✓ I did it today** (one per calendar day); open it for the last-done, a soft cadence hint ("usually ~35 days · it's been 40"), and the history with an undo. It never climbs, nags, or notifies — the hint shows only when you open it — and it stays wholly outside the ranking engine.

### Fixed

- **Dark-theme dropdowns** — native dropdown option lists rendered on a white background, clashing with dark themes (seen in the New-Routine "Type" dropdown). Every dropdown now themes its option list across all themes and modes.
- **The white installed-app icon** — the install icons had transparent corners (and the maskable one had no safe zone), so an installed tile could render white. Regenerated as fully opaque icons with a proper maskable safe zone.

## [0.32.0] — 2026-07-28

**The shared impact pin** — your most-neglected important task now surfaces in Telegram, and the pin's settings follow you across every client instead of living in one browser.

### Added

- **The impact pin in Telegram** — `/today` and the daily digest now lead with the ⚠️ pin (your most-overdue important, playable task), each with a **✓ Done** button to complete it and a **😴 Snooze** button to hide it for its level's span.

### Changed

- **Pin settings and snoozes now sync across clients** — the four pin day-values (the High/Medium fuses and snooze spans) and each task's snooze are stored on the server, so the web app and the Telegram bot share one source of truth and show the same pin. Previously the settings and snoozes lived only in the browser that set them. On upgrade, the pin day-values start at their defaults (High 7 / Medium 30 day fuses, High 1 / Medium 3 day snoozes); re-set them in **Settings** if you had customised them.

## [0.31.0] — 2026-07-28

**The Telegram bot** — capture and act on your tasks from Telegram, without opening the web app. It runs inside `rankati-api` by polling Telegram: no extra container, and nothing new to expose. Migration-bearing (the api applies it automatically on boot).

### Added

- **Connect your own bot** — create one with @BotFather, paste the token in **Settings → Telegram**, and send the shown link code to bind your chat. Only that one chat is served.
- **Capture by texting** — any message (or `/add …`) becomes a task in an **Inbox** list, with buttons to re-file it into another list or **🗑 discard** it.
- **`/today` and `/now`** — your top tasks and the single top task, each with a **✓ Done** button.
- **Daily digest** — optionally push today's tasks to your chat at a time and timezone you choose.
- **Settings → Telegram** — manage the token (masked), link code, bound chat, and digest, with a live connected / not-connected health indicator.

Your bot token is stored on your own server, shown masked, and never written to logs.

## [0.30.1] — 2026-07-26

**The Rankati logo** — the brand logo now ships as the browser favicon, the PWA install icons, and atop the
README. Not migration-bearing.

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
