# Changelog

All notable changes to Rankati are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.46.0] — 2026-09-11

### Added

- **Several reminders per meeting.** A meeting can now carry more than one Telegram reminder — set, say, **1 day before AND 1 hour before**. In a task's Meeting section, each reminder is its own row (a number + minutes/hours/days); use **+ Add reminder** to add another (up to 5) and ✕ to remove one. A new meeting still starts with a single 1-hour reminder. Each fires once at its own time; rescheduling the meeting re-arms them all.

## [0.45.0] — 2026-09-11

### Added

- **Meeting time on a task.** Open a task and set a **Meeting time** (a date and a clock time), with an optional **duration**. A timed task gets a **Telegram reminder** before it — one hour ahead by default, or set your own lead (minutes, hours, or days); untick it to turn the reminder off. A future meeting **stays out of your Today hand** (and doesn't raise its impact pin) until it's near — it waits in Upcoming and appears in Today on the day, or earlier if you set "show in Today N days before". If a new meeting time overlaps another timed task, you'll see a gentle **double-book warning** — it never blocks the save. (Meeting time is a real moment, separate from the day-only Not-before / Due gates.)

## [0.44.0] — 2026-09-10

### Added

- **Venue — a place for a task.** Open a task and paste a **Google Maps link** into the new **Venue** field. Once saved, the task shows two buttons: **G-Maps** opens the saved link (jumping straight into the Maps app on your phone), and **Waze** starts navigation there. Rankati works out the coordinates from the link for you; if a link has no coordinates, Waze searches by the place name instead, and if there's nothing to route to, the Waze button simply doesn't appear. Clear the field to remove the venue. (Venue is a place *on one task* — separate from the reusable Home/Office **locations** that filter your Today hand.)

## [0.43.0] — 2026-09-10

### Added

- **Pin lists to the top.** Each list now has a **📌** — pin the ones you reach for most and they float to the top of the Lists screen; everything else stays in alphabetical order below. Tap again to unpin.
- **Clickable links in checklists and notes.** A web address in a checklist item or a task's notes is now a real link — tap it to open in a new tab. Items and notes show their text (with links live) by default; a small **✎** edits them, so an item that's nothing but a link is still editable. Links are the only thing made clickable and are rendered safely — pasted text can never inject anything.

## [0.42.2] — 2026-09-10

### Added

- **Undo a reminder "Did it" you tapped by mistake.** Once you mark a reminder done — in the app or by tapping ✓ on a Telegram nag — its row shows **"✓ done today"** with an **Undo** button, available all day. Undo puts it right back: an "N times per period" reminder's count drops by one, an every-N reminder becomes due again today, a fixed-date one is un-acknowledged, its Telegram nag re-opens, and if it keeps a Log, today's entry is removed. (A frequency reminder keeps its "Did it" button alongside, so you can still log another.)

## [0.42.1] — 2026-09-09

### Fixed

- **Telegram reminders stop nagging you for the day once you tap "Did it."** For a "N times per week/month" reminder, tapping ✓ Did it now silences its Telegram nags for the rest of that day and they resume tomorrow — before, because you were still under the weekly target, it kept pinging the same day. The nag also now reads "3/7 this week" rather than a puzzling "3/7 today" for a weekly reminder.
- **"N times per period" reminders can now keep a Log.** Turn on "Log each completion" for a frequency reminder (e.g. Walk – 5000 Steps) and tapping ✓ Did it records that day in a Log — from the app or from a Telegram nag. It records one entry per day (the reminder still keeps the full count), so you build a day-by-day history alongside the weekly tally. Completing a linked reminder in the app now records the Log too, not only from Telegram.

## [0.42.0] — 2026-08-28

### Added

- **Deleting a task now has a 15-second undo — the same as completing one.** Tap the **✕** and the task doesn't vanish for good: its row stays in place, struck through, with a winding ring where the ✕ was. Tap that ring any time in the next 15 seconds to undo, and nothing was ever deleted. Leave it be (or close the app) and the delete goes through. While the ring is running, the task is held out of your Today hand so you're never dealt a card you just deleted. (Deleting a task that others depend on still warns you first, and deleting a whole list still asks you to type to confirm.)

## [0.41.1] — 2026-08-22

### Changed

- **Telegram nag reminders now take any interval, not just presets.** When you turn on "Remind me on Telegram" for a reminder, you can set how often to be nagged to **any whole number of minutes or hours** — every 10 minutes, every 45 minutes, every 3 hours, up to once a day — instead of choosing from a fixed list. Existing reminders keep their current interval.

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
