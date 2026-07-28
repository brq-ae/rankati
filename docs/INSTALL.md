# Rankati — Install & Deployment

Rankati ships as two container images (`rankati-web`, `rankati-api`) plus a PostgreSQL container, wired by
`docker-compose.yml`. This page covers the **operator** concerns that authentication introduced: how to
expose Rankati safely, first-run setup, and the recovery commands.

> **The one rule that matters: never expose Rankati without a TLS-terminating reverse proxy in front of it.**

## Exposure — Rankati serves plain HTTP behind a TLS proxy

Rankati's web container serves **plain HTTP** and terminates no TLS itself. The session cookie is
marked `Secure` **only** when the request arrived over HTTPS — so on a bare HTTP origin the cookie that
keeps you logged in would travel in the clear. **Put a reverse proxy in front that terminates HTTPS** and
holds the certificate. Homelab-common choices, any of which work:

- **Nginx Proxy Manager (NPM)** — a proxy host with an SSL certificate. Nothing extra to configure: it
  forwards `X-Forwarded-Proto` automatically.
- **Caddy** — `rankati.example.com { reverse_proxy rankati-web:8080 }`. Automatic HTTPS; sets the forwarded
  headers.
- **Traefik** — a router + service to the `rankati-web` container with a TLS resolver.

**The proxy must forward `X-Forwarded-Proto`** — that header is what tells Rankati the request was HTTPS and
makes the session cookie `Secure`. On **Nginx Proxy Manager this is automatic** (a standard proxy host
with SSL needs no extra header config). For a hand-rolled Nginx, add
`proxy_set_header X-Forwarded-Proto $scheme;`. Caddy and Traefik set it by default.

Rankati's web container trusts these forwarded headers only when told to — set `TRUST_PROXY=true` in the
compose environment once a **trusted** proxy is actually in front (the default is `false`, the LAN-safe
posture, which discards client-forged forwarded headers).

**Optional first shield:** add **IP rate-limiting at the proxy** (e.g. NPM's advanced config, Caddy's
`rate_limit`, or Traefik middleware) in front of `/api/auth/login`. Rankati's own escalating lockout is the
backstop; a proxy rate-limit blunts noise before it reaches the app.

## First-run setup

On first launch there is **no account**, so the very first visit shows a **create-account** screen
(username + password). This screen is not itself password-protected — whoever reaches it first claims the
account. Two implications:

- **Create your account right after deploy — ideally before exposing Rankati to the internet.**
- If you must expose it first, there is a brief **claim window**: create the account immediately so nobody
  else does. (First-run setup is open by design; server access and creating the account promptly are the
  guard.)

**Trust this device** on the login/create-account screen keeps you signed in for **30 days**; leave it
unticked on a shared or public machine and the session ends when the browser closes.

## Telegram bot (optional)

Rankati can connect to a Telegram bot **you** own — it runs inside the `rankati-api` container by polling Telegram, so it adds no container and no inbound port.

1. Create a bot with **@BotFather** in Telegram and copy its token.
2. In Rankati, **Settings → Telegram** → paste the token → **Connect**. The badge shows whether the bot is connected.
3. Send the shown **link code** to your bot to bind your chat (one-time; only that chat is served).
4. Optionally turn on the **daily digest** — a send time plus your timezone.

Capture by texting the bot; read with `/today` and `/now`; complete with the ✓ buttons. The token is stored on your server (masked in the UI, never logged).

## Recovery — run on the box, no email

There is no email-based password reset. Both escapes are **operator commands** run on the host, and
**neither destroys your data**:

**Forgot the password** — reset back to first-run (the account is removed; **tasks, lists, locations,
routines, everything else are preserved**), then set a new password at the create-account screen:

```
docker compose exec api node dist/auth-admin.js --reset-to-first-run
```

**Locked out** (too many failed logins) — clear the lockout (the password is unchanged):

```
docker compose exec api node dist/auth-admin.js --unlock
```

Server access is the guard for both — that is why neither needs a typed-DELETE confirmation.

## Upgrading

Pull the new images and bring the stack back up — the api applies any database migrations automatically on boot:

```
docker compose pull
docker compose up -d
```
