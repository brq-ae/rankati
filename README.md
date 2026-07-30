<p align="center"><img src="assets/rankati-logo.png" alt="Rankati" width="128"></p>

# Rankati

> A **personal decision engine for tasks** — self-hosted, single-user. Not a to-do list.

A to-do list tells you what *exists*. Rankati answers the harder question:

> **"What should I do *right now*, given the time I have, where I am, and what isn't blocked yet?"**

It's named for its core mechanic: it **ranks** your tasks and **deals you a small, beatable hand** of what
you can actually do this minute — then gets out of your way.

## How it works

Rankati combines a few ideas most task apps keep separate:

- **The Arena — ranking by duels.** You never sort a big pile at once. You settle quick *this-or-that*
  duels, and an Elo-style rating quietly learns your priorities. One **importance** number per task, earned.
- **Gates — is it even doable now?** A task isn't just *due* on a date — it's only *playable* under
  conditions: an unblocked dependency, an availability window, a not-before date, the right place. Gates
  hide what you can't act on, so the list is always honest.
- **The Today Track — a dealt hand.** It takes your ranked, playable tasks (`importance + urgency + fit`)
  and deals a **small hand of cards**. The hand has a bottom — **clearing it is the win** ("beat the deck").
  No endless list, no XP or streaks; the duel *is* the game and finishing the hand *is* the goal.
- **The impact pin — a gentle safety net.** Flag a task's impact (Medium/High) and if it goes neglected
  past its fuse while it's doable, one ⚠️ nudge floats above the hand. It never touches the ranking — just
  makes sure something important can't quietly rot.

### Beyond the core engine

- **Lists, Upcoming & Routines.** Group tasks into lists, see what's dated-but-not-yet-due in
  Upcoming, and keep recurring rhythms as **Routines** — plus **Logs**, which track how often you
  actually do a thing (a haircut, nails) and show your cadence, without nagging.
- **Telegram bot (optional).** Capture a task, glance at your hand / lists / routines / logs, and get
  a daily digest — from your phone, without opening the app. You run your *own* bot over long-polling,
  so nothing is exposed to the internet and no ports are opened. Worth being clear about the trade-off:
  messages route through Telegram, which isn't end-to-end encrypted — so keep anything genuinely
  sensitive in the app itself.

The full product concept lives in [`docs/CONCEPT.md`](docs/CONCEPT.md); the architecture is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quickstart (self-host)

Rankati ships as two container images (`rankati-api`, `rankati-web`) plus an official PostgreSQL image,
wired by a `docker-compose.yml`.

```bash
# 1. Get the compose file + env template (from this repo)
cp .env.example .env
# 2. Edit .env — set POSTGRES_PASSWORD (and the other secrets) to your own values
# 3. Bring it up
docker compose up -d
```

The web app is published on **port `12101`**. Visit it, and the **first visit shows a create-account
screen** — pick your username and password, and you're in.

> **Create your account right after starting it, before exposing it to anyone** — first-run setup is open
> by design (whoever reaches it first claims the single account).

See [`docs/INSTALL.md`](docs/INSTALL.md) for the full deployment notes (reverse proxy, first-run, and the
recovery commands).

## Telegram bot (optional)

Capture and act on your tasks from Telegram, without opening the web app. It runs inside `rankati-api` by polling Telegram — no extra container, and nothing new to expose.

1. In Telegram, message **@BotFather**, create a bot, and copy its **token**.
2. In Rankati, open **Settings → Telegram**, paste the token, and **Connect**.
3. Copy the **link code** it shows and send it to your bot in Telegram to bind your chat (one-time; only that chat is served).

Then, from your chat:

- **Text the bot anything** (or `/add buy milk`) to capture it as a task in an **Inbox** list — with buttons to file it into another list or **🗑 discard** it.
- **`/today`** deals your top tasks and **`/now`** shows the top one, each with a **✓ Done** button.
- Optionally enable a **daily digest** (a time + your timezone) to have today's tasks pushed to you each morning.
- Your **most-neglected important task** leads `/today` and the digest as a ⚠️ **pin**, with **✓ Done** to complete it and **😴 Snooze** to hide it for a while — the same pin the web app shows, since its settings now live on the server.

Your token is stored on your own server, shown masked, and never logged.

## Requirements

- **Docker** + Docker Compose.
- **A TLS-terminating reverse proxy** (Nginx Proxy Manager, Caddy, Traefik, …) **if you expose Rankati to
  the internet.** Rankati serves plain HTTP and marks its session cookie `Secure` only over HTTPS, so the
  proxy must terminate TLS and forward `X-Forwarded-Proto`. **Never expose it without one.** On a trusted
  LAN you can run it directly.

## Status & scope

- **Single-user.** One account guards one dataset — perfect for self-hosting your own life.
- **Recovery is on the box** (no email): operator commands reset a forgotten password (data preserved) or
  clear a lockout — see [`docs/INSTALL.md`](docs/INSTALL.md).

## License & contributing

Rankati is open source under the **GNU AGPL-3.0** — see [`LICENSE`](LICENSE).

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — it covers how to build
and test, and includes a short **Contributor License Agreement** you agree to by submitting a PR.
