# Changelog

All notable changes to Rankati are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.41.0] — 2026-08-22

### Added

- **Log something from Telegram in one message.** Start a message with **`+`** to record a Log occurrence — `+walk` marks a walk today, `+haircut` a haircut. It finds your existing Log by name (case-insensitive, so `+Haircut` and `+haircut` are the same one) or creates it the first time (the reply says **(new log)** so a typo is easy to spot), and logging the same thing twice in a day counts once. Once a Log has a couple of entries the reply adds its cadence, e.g. **"✓ Logged: Walk — usually ~7 days"**. There's also a **`/log <name>`** command in the `/` menu that does the same. Because an occurrence is dated to your day, this needs your timezone set (Settings → Telegram); without one it asks you to set it rather than guess the date.

## [0.40.0] — 2026-08-22

### Added

- **Telegram nag-reminders.** Any reminder can now **nudge you on Telegram until you actually do it** — not just once. Turn on **"Remind me on Telegram"** when creating or editing a reminder and pick how often to be nagged (every 30 minutes, hourly, or every 2 hours). While a reminder is due and unfinished, Rankati pings you on that cadence; each nag carries three buttons — **✓ Did it** (marks it done, exactly like tapping it in the app), **😴 Later** (snooze 1 hour, 3 hours, or until morning), and **Skip today** (quiet it for the rest of today; it comes back tomorrow if still due). Nagging respects your quiet hours and stops the moment the reminder is satisfied. It works whether or not your daily digest is on.
- **Link a reminder to a Log.** For date-style reminders (every-N and fixed-date, not the "N times per period" kind), a new **"Log each completion"** toggle keeps a running history: tapping ✓ Did it — in the app or from a Telegram nag — also records the day in a Log named after the reminder (created automatically the first time), so you build up a track record without any extra step.

## [0.39.0] — 2026-08-21

### Added

- **Quiet hours for Telegram.** Set a nightly window (e.g. 22:00–08:00, in your digest timezone) in **Settings → Telegram**, and Rankati sends **no** Telegram messages during it — nothing pings you while you sleep. If your daily digest is scheduled inside the window, it isn't lost: it's **delayed until the window ends** rather than dropped, and Settings shows a live note (e.g. "Digest at 07:00 is within quiet hours — it'll be delayed until 08:00") so you know. Leave both times blank to turn it off. (Groundwork for the upcoming Telegram nag-reminders.)

## [0.38.0] — 2026-08-16

### Added

- **Ideas — a place for thoughts that aren't tasks yet.** A new **Ideas** tab holds things you might do but haven't decided on: jot a title, add notes later, and it stays completely out of the way — never ranked, never dealt to Today. When you're ready, **Make it a task** and pick which list it lands in. Capture ideas from Telegram too: start a message with **#** (or use **/idea**) and it shows up here.
- **Task notes.** Every task now has a free-text **Notes** field in its detail view — somewhere for context, links, or the details a promoted idea carried over. It's display-only: notes never affect ranking, gates, or what Today deals you.

## [0.37.0] — 2026-08-06

### Added

- **Log a day you forgot.** A Log's detail now has a "Forgot a day?" row: pick any past date (up to today) and tap Log to record that occurrence — handy when you did the thing but didn't open the app, or when you want to seed a new Log with its real history. Logging a day that's already recorded changes nothing (no duplicate, no error), and the cadence hint updates to match.

## [0.36.0] — 2026-08-04

### Changed

- **The pickers in a task now show their options the moment you tap them.** Choosing a list to move to, a task to depend on, or a place to tag used to stay blank until you typed — no help if you'd forgotten the name. Now each opens to the full list, sorted A–Z, and typing narrows it. The dependency picker shows up to 50 at once with a gentle "keep typing to narrow…" hint when there are more, and a stray Enter on an untouched box no longer selects anything.

## [0.35.0] — 2026-07-31

### Changed

- **Tidier Settings.** The Settings screen is now a compact list of collapsible sections — Appearance, Today & pins, Locations, Telegram, Account, and Reset — instead of one long scroll. Tap a section to expand it; everything works exactly as before, it's just easier to find.

## [0.34.0] — 2026-07-30

Two daily-use features.

### Added

- **Create a list from inside a task** — the task detail's List field is now a type-to-search-or-create box: filter your lists and pick one to move the task, or type a new name to create the list and move the task to it in one action (no more making an empty list first). A name that matches an existing list (any capitalisation) just moves it there — no duplicate.
- **View your lists, reminders, and logs from Telegram** — three read-only commands: **`/lists`** (tap a list to see its active tasks, with ⚠️ on high-impact), **`/routines`** (your reminders in the same order as the app), and **`/logs`** (each log's last-done and cadence, e.g. "Haircut — 40 days ago, usually ~35"). `/routines` and the "N days ago" in `/logs` use the timezone from your digest settings; set one to see them.

## [0.33.2] — 2026-07-29

### Fixed

- **A spurious "Unauthorized" banner on first login** — a red "Unauthorized" banner could briefly flash on the app right after logging in (you stayed logged in, and a refresh cleared it). It no longer appears: the app never refreshes before you're authenticated, and a 401 (which simply routes you to login) never surfaces as an error banner.

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
