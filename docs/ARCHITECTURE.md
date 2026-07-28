# Rankati — Architecture

This document describes **how the system is built and deployed**. Product behaviour lives in [`CONCEPT.md`](CONCEPT.md).

> **Status:** the stack (§0) is in place and Rankati is self-hostable today. Built: the Arena ranking engine, the Today Track (`importance + urgency + fit`) dealt as a finite, beatable hand, four of the planned gates (not-before, dependency, location, and availability-window) with backward urgency propagation, the impact safety-net pin, routines, four colour themes, and single-user authentication. Later phases — the media pipeline (§2), a mobile client (§3), sync (§4), and archiving (§5) — remain design-level until built.

---

## 0. Chosen stack

Each row cites the ADR that governs it.

| Layer | Choice |
|---|---|
| **Language** | TypeScript, end-to-end |
| **Repo structure** | Monorepo, pnpm workspaces (`apps/api`, `apps/web`, `packages/shared`) |
| **Web frontend** | React + Vite + Tailwind, as a responsive PWA (kiosk-ready, pointer-events for multi-input) |
| **Backend** | Node + TypeScript (NestJS) |
| **Database** | PostgreSQL 16 |
| **ORM / DB access** | Prisma, with Prisma Migrate |
| **Media store** | Filesystem volume in v1 (object storage later) |
| **Tests** | Vitest |
| **Pinned runtimes** | Node 22.23.1 (per-user via fnm), PostgreSQL 16 |
| **Web serving (container)** | Minimal Node static server, `USER node` — not nginx |
| **Owner namespacing** | `ownerId` on every record; the constant `local` owner |
| **Authentication** | Single-user account (argon2id), server-side revocable sessions, global session guard |
| **Mobile (later)** | React Native for Android — deferred, API-first |

One language across the whole stack means a `Task`, gate, rating, or API contract is defined once and shared everywhere.

---

## 0.1 API surface

The endpoints that exist **today**. This table grows one milestone at a time; it documents what is built, never what is planned.

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/api/health` | — | `{ status, database }` (`@Public`) |
| `GET` | `/api/auth/status` | — | `{ needsSetup, authenticated }` (`@Public`; routes the web app to setup / login / app) |
| `POST` | `/api/auth/setup` | `{ username, password, trusted }` | `200` + session cookie (`@Public`; first run only, else `409` — setup is closed forever) |
| `POST` | `/api/auth/login` | `{ username, password, trusted }` | `200` + session cookie; `401` wrong; `429` + `Retry-After` when locked out (`@Public`) |
| `POST` | `/api/auth/logout` | — | `200`, revokes the session + clears the cookie (`@Public`) |
| `POST` | `/api/auth/change-password` | `{ currentPassword, newPassword }` | `200`; `401` wrong current. **Behind the guard.** Revokes every OTHER session, keeps this one |
| `POST` | `/api/client-error` | `{ message, stack?, view?, appVersion?, userAgent?, timestamp? }` | `204` (`@Public`; **log-only** — writes one line to the server log, no DB; rate-limited per IP → `429`, size-capped → `413`) |
| `GET` | `/api/lists` | — | `List[]` |
| `POST` | `/api/lists` | `CreateListDto` | `List` |
| `PATCH` | `/api/lists/:id` | `UpdateListDto` | `List` |
| `DELETE` | `/api/lists/:id` | — | `204`, cascade-deletes its tasks |
| `GET` | `/api/tasks` | `?sort=rating` (optional) | `Task[]` |
| `GET` | `/api/tasks/today` | `?on=YYYY-MM-DD` (required) `&at=HH:MM` (required whenever any task carries an availability window, else optional — fail-closed 400) `&block=quick\|medium\|long` (optional; the fit free-block — absent = Any = neutral; a too-big task sinks; the ordinal only, never minutes) | `Task[]` |
| `GET` | `/api/tasks/upcoming` | `?on=YYYY-MM-DD` (required) `&at=HH:MM` (same rule as today's) | `Task[]` |
| `GET` | `/api/tasks/:id` | — | `Task` |
| `POST` | `/api/tasks` | `CreateTaskDto` | `Task` |
| `POST` | `/api/tasks/:id/requires` | `CreateRequiredTaskDto` | `Task` |
| `PATCH` | `/api/tasks/:id` | `UpdateTaskDto` (incl. `needsDetails`; and `impact` — the declared None/Medium/High level, validated) | `Task` |
| `PATCH` | `/api/tasks/:id/complete` | — | `Task` |
| `DELETE` | `/api/tasks/:id` | — | `204`, no body |
| `POST` | `/api/tasks/:id/checklist` | `CreateChecklistItemDto` | `ChecklistItem` |
| `PATCH` | `/api/checklist/:itemId` | `UpdateChecklistItemDto` | `ChecklistItem` |
| `DELETE` | `/api/checklist/:itemId` | — | `204`, no body |
| `GET` | `/api/locations` | — | `Location[]` |
| `POST` | `/api/locations` | `CreateLocationDto` | `Location` (400 on a case-insensitive dup) |
| `PATCH` | `/api/locations/:id` | `UpdateLocationDto` | `Location` (rename) |
| `POST` | `/api/locations/merge` | `MergeLocationsDto` | `Location[]` (atomic; deletes the source) |
| `DELETE` | `/api/locations/:id` | — | `204`, cascade-untags |
| `POST` | `/api/duel-sessions` | `StartSessionDto` | `StartSessionResult` (200) |
| `POST` | `/api/duel-sessions/:id/results` | `SubmitResultDto` | `NextPairResult` (200) |
| `DELETE` | `/api/duel-sessions/:id/results/last` | — | `NextPairResult` (200) |
| `POST` | `/api/duel-sessions/:id/commit` | — | `CommitSummary` (200) |
| `POST` | `/api/reset` | `ResetRequestDto` | `200` (requires `confirm: "DELETE"`) |
| `GET` | `/api/routines` | `?on=YYYY-MM-DD` (required) | `Routine[]` (compute-fresh) |
| `POST` | `/api/routines` | `CreateRoutineDto` | `Routine` |
| `PATCH` | `/api/routines/:id` | `UpdateRoutineDto` | `Routine` (edit any field) |
| `DELETE` | `/api/routines/:id` | — | `204`, no body |
| `POST` | `/api/routines/:id/did` | `{ on }` | `Routine` (frequency +1 / floating resets clock) |
| `POST` | `/api/routines/:id/dismiss` | `{ on }` | `Routine` (fixed only) |
| `POST` | `/api/routines/:id/snooze` | `{ until }` | `Routine` (display-only hide-until) |
| `GET` | `/api/telegram/config` | — | `TelegramConfigDto` (masked; the raw token is never returned) |
| `GET` | `/api/telegram/status` | — | `TelegramStatusDto` (`running`/`error`/`stopped` poller health) |
| `PUT` | `/api/telegram/token` | `SetTelegramTokenDto` | `TelegramConfigDto` (starts/restarts the poller) |
| `DELETE` | `/api/telegram/token` | — | `TelegramConfigDto` (clears the token, unbinds, stops the poller) |
| `POST` | `/api/telegram/link-code` | — | `TelegramConfigDto` (issues a fresh one-time binding code) |
| `POST` | `/api/telegram/unlink` | — | `TelegramConfigDto` (unbinds the chat, re-issues a code) |
| `PUT` | `/api/telegram/digest` | `UpdateTelegramDigestDto` | `TelegramConfigDto` (enabling requires a timezone) |

The Telegram bot is bundled in `rankati-api` and reaches Telegram by long-polling — it adds no container and no inbound port; the routes above are the web app's Settings surface.

Three rules hold across all of it:

- **Everything lives under `/api`** — one prefix, no exceptions, so a single published port serves the web app and the API from one origin.
- **The types are `@rankati/shared`** — `List`, `Task`, and the DTOs are defined once and imported by both apps. Dates cross the wire as **ISO 8601 strings**, never `Date`.
- **`ownerId` is applied by the server** — the client never sends it, and every query is scoped by it from day one.
- **Every route requires a valid session** except the `@Public` ones — the `/api/auth/*` front door and `/api/health` (kept public for the smoke test and the proxy health-check). A global guard enforces it; a missing/expired session is `401`, and the web app routes back to login. State-changing requests also pass a same-origin CSRF check.

Completing a task is **idempotent**: re-completing an already-done task returns it unchanged and preserves the original `completedAt`.

---

## 1. Deployment shape

- **Develop first, then containerize.** Build the application, then package it into a container image.
- **v1 is a single container running as a web service.** The **container is the source of truth** for all data.
- **Web app (v1)** talks to the container live over an API; it does little to no caching because it's always online with the server.
- **Mobile app (later)** talks to the same container over the same API, and adds an **offline cache** (see §3).

```
                 ┌─────────────────────────────┐
                 │        Container            │
                 │  (web service = source of   │
                 │        truth)               │
                 │  ┌──────────┐  ┌─────────┐  │
   Web app  ───► │  │   API    │  │  Data   │  │
                 │  └──────────┘  │ (tasks, │  │
   Mobile   ───► │  ┌──────────┐  │  media, │  │
   app          │  │  Media   │  │ records)│  │
   (cache)      │  │  store   │  └─────────┘  │
                 │  └──────────┘               │
                 └─────────────────────────────┘
                          │  (optional)
                          ▼
              External archive: NAS / GDrive / OneDrive
```

**Tenancy:** v1 is single-user with a **login**, but every record is **namespaced by owner** from day one, and a **list is the sharing boundary**. This keeps the door open — with no rewrite — to hosted sign-up, self-hosted containers others run, and private+shared lists.

---

## 1.1 Authentication, sessions & exposure posture

Rankati is **single-user with a login**: one account, one dataset. Auth adds *authentication* (who are you, stay logged in), not *authorisation* — owner-scoping (`ownerId = "local"`, a constant) was already the boundary, and auth does not touch it. A new account created after a recovery reset sees all the same data.

**Passwords** are hashed with **argon2id** (`@node-rs/argon2`, OWASP baseline params); plaintext is never stored or logged. **Two new tables** carry it (Prisma; migration `add_auth`, additive):

- **`Account`** — `id`, `username` (unique), `passwordHash`, `createdAt`, and the persisted lockout state `failedAttempts` / `lockedUntil`. Its **existence is the first-run signal**: zero rows → the web app shows the create-account screen.
- **`Session`** — `id` (an opaque, cryptographically-random token = the cookie value), `accountId` (FK, `onDelete: Cascade`), `createdAt`, `expiresAt`, `trusted`. **Revoking a session is deleting its row** — sessions are server-side and revocable, not stateless JWTs.

**The session cookie** (`deck_session`) is `HttpOnly`, `SameSite=Lax`, and `Secure` **only when the request arrived over HTTPS** — derived from `X-Forwarded-Proto`. *Trust this device* → a 30-day `Max-Age` (persistent) + a 30-day server-side `expiresAt`; otherwise a pure session cookie (no `Max-Age`, dies on browser close) with a short server-side backstop. A request is authenticated iff its token's row exists and has not passed `expiresAt`.

**The guard** is a single global guard: every route requires a valid session, except those marked `@Public` — the `/api/auth/*` endpoints and `/api/health`. **CSRF** is same-origin enforcement (the SPA and API share one origin): a state-changing request with a foreign `Origin` is rejected; `SameSite=Lax` is the companion. There is no CSRF token to manage on the client.

**The escalating lockout** is a pure state machine persisted on the account, so it survives a restart: a failed attempt (wrong username *or* password — both count against the one account) increments `failedAttempts`; crossing a multiple of 5 arms a lock — **5 → 1 min, 10 → 5 min, 15 → 1 hr, 20 and beyond → 1 day (capped)**. While locked, login returns **`429` with `Retry-After`** and the password is not even checked — *a correct password during a lockout still fails*. A successful login resets the counter.

**Login hardening.** The username match on login is **case-insensitive** — `lower(input) === lower(stored)` — so `Alice` logs into the account stored as `alice`; the stored value keeps its original case (comparison-only, no schema change). The account is still fetched with `findFirst` (a wrong username still counts toward the lockout), and the password is still argon2-verified unchanged. On the web, the setup/login **password fields carry a show/hide toggle** so a silently-substituted generated password (a mobile "suggest a strong password" autofill at first-run) is visible before submit, and the **username inputs set `autocapitalize="none"` / `autocorrect="off"` / `spellcheck="false"`** so a keyboard cannot mangle them. Passwords are deliberately **not** trimmed/normalized — setup and login stay byte-symmetric.

**Recovery is deliberate, no email.** Forgot-password and lockout are resolved by the **operator on the box**, not by a self-service flow:

| Command | Effect |
|---|---|
| `docker compose exec api node dist/auth-admin.js --reset-to-first-run` | Deletes the account (sessions cascade) so the next visit shows create-account. **All tasks/lists/other data preserved.** |
| `docker compose exec api node dist/auth-admin.js --unlock` | Clears `failedAttempts`/`lockedUntil` so login works again. Password unchanged. |

Both mirror the `--wipe` CLI's guard: server access **is** the guard, and neither destroys data, so there is no typed-DELETE ceremony.

**Exposure posture.** Rankati serves **plain HTTP** and **must run behind a TLS-terminating reverse proxy** — never expose it without one, or the session cookie rides in the clear. The proxy holds the certificate and forwards `X-Forwarded-Proto` (which drives the `Secure` cookie); the web container trusts those forwarded headers (`app.set('trust proxy')`). The served build ships a **strict Content-Security-Policy** as a response header from Rankati's own web server (`server.mjs`), not the operator's proxy: `script-src` carries **no `'unsafe-inline'`** — the one inline script (the anti-flash theme) is allowed by its **sha256 hash**, guarded by a drift test that fails if the shipped script and the pinned hash diverge. `style-src` keeps `'unsafe-inline'` for the app's dynamic inline styles (progress bar width, tick-ring geometry) that cannot be hashed — **tightenable to `'self'` later with a real-browser violation check**. Companions: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`. Dev (Vite HMR, which needs inline/eval) is exempt — the strict CSP is the production served build only.

---

## 1.2 Client-side error handling

Unexpected errors used to have no safety net: a render-time throw unmounted the whole tree (a blank white screen), and everything else reached only the browser console — invisible on a phone or a self-hosted deploy with no dev tools open. Rankati adds a net, with **no third-party SaaS** (a private app should not take that dependency).

- **A React ERROR BOUNDARY wraps the app** (`main.tsx` renders `<ErrorBoundary><App/></ErrorBoundary>`). On a render crash it shows a friendly "Something went wrong" card with a **Reload** button and a collapsed **Show details** toggle (error + stack, with a **Copy** button). The fallback is deliberately **self-contained** — inline styles, fixed colours, a system font, no Tailwind/theme/context — so it renders even when the app's own styling is what broke.
- **GLOBAL HANDLERS** (`window` `error` + `unhandledrejection`, wired once at startup) catch errors OUTSIDE render — event handlers, timers, unawaited promises. The boundary catches render errors; together they cover both.
- **`POST /api/client-error`** logs the error to the **server log** (the Nest logger, one greppable line: `[client-error] view=… v=… ua="…" msg="…"`), never a SaaS. It is **`@Public`** (errors happen before login) but **log-only** (no DB, no state — blast radius is a few log lines), **size-capped** (413 over 16 KB, fields truncated), and **rate-limited** per IP (429). Payload: message + stack, current view, app version, user-agent, timestamp.
- **FLOOD CONTROL** is two-sided: the CLIENT dedupes (each unique error sent once) and caps total sends per session; the SERVER rate-limits + size-caps as the backstop. A render crash-loop firing the same error 500× becomes **one** log line, not thousands. The client's `appVersion` is pinned to the release version by a test, so a report never claims the wrong version.

---

## 2. Media upload pipeline (client-side)

Anything uploaded from a client is processed **on the device**, using the phone's own CPU/GPU, *before* it hits the wire. **Resize applies to media only** — documents are never compressed.

| Lane | Processing | Cap | Notes |
|---|---|---|---|
| **Image** | Downscale (long edge ~1920px / 1080p-class) + quality trim | **≤2MB** | Already-small files are left untouched. A 2MB image is "born ready" for WhatsApp / email / gov upload forms |
| **Video** | Transcode to **720p**, modest bitrate | **≤10MB** | Size is driven by length; a long clip that can't fit is flagged "large file, download-only" |
| **Documents** | None | as-is | PDFs and the like upload untouched; a >2MB doc is just a "large file" |
| **Attachments (raw)** | None | **unregulated** | Full-fidelity escape hatch for when the real thing is needed |

**How "shrink to size" actually works:** you don't set a filesize directly — you turn two knobs (resolution and quality) until the result lands under the cap. Video caps *quality* (720p at a modest bitrate) for a predictable size-per-minute rather than forcing a hard byte target.

**Watch-outs:**

- **Video transcode is heavy** — it needs a visible "compressing…" state and a sane ceiling on accepted input.
- **Originals are intentionally lost** for the optimized lanes. If full fidelity is needed, use the raw **Attachments** lane.
- **Format normalization** (e.g., HEIC→JPEG, EXIF/orientation) happens in this same on-device step.

---

## 3. Mobile client model

**The phone is a thick cache for tasks, a thin client for media.**

- **Tasks cache fully** — all task data plus each attachment's *descriptor* (filename, type, size). So offline you can capture, duel, and see your dealt hand; only the file bytes are absent.
- **Media never persists.** Files are fetched live from the container when opened, then discarded.
- **Offline media experience:** for every file regardless of size, you see the **filename + a "connect to open this" notice.** The size threshold below only matters when online.

**Fetch behaviour (when online):**

- **Small files** (≤2MB) download the moment you tap them — safe on mobile data.
- **Large files** (>2MB / raw attachments) are **tap-to-download**, so you never blow through data pulling a big video by accident.

**Security win:** because media is never cached, a lost or stolen phone **leaks nothing** — there's no passport scan sitting in local storage. **The caching rule doubles as the security model.**

---

## 4. Sync & offline

- The container is **authoritative**; the mobile cache is **read-through**.
- **Offline actions queue** — captures, completions, and duel results made offline pile up and sync on reconnect.
- **Conflict rule: server wins.** One simple, decided-once rule (last-write / server-authoritative) rather than complex merges.
- Cache invalidation follows the descriptor: task data syncs; media is always fetched fresh.

---

## 5. Storage, records & archiving

### 5.1 Retention lifecycle

`Active → Done → Archived`. Archiving keeps the container lean while retaining records.

### 5.2 What is kept

- **Record-worthiness:** list policy + **output safety net** (any task with an output is kept regardless of its list).
- **On archive: shed inputs, keep outputs.** Inputs are dropped; the artifact output (the record) is preserved.

### 5.3 Archive destination — one global, all-or-nothing policy

| Option | Behaviour |
|---|---|
| **Never archive** | Either *keep live forever* or *discard on done* (two distinct fates) |
| **In container** | Cold/archive store on the server; one tap to retrieve |
| **External** | NAS, Google Drive, OneDrive — user's own storage |

Two principles:

- **Offload the bytes, keep the breadcrumb.** Even when a record ships to GDrive, the container keeps a tiny **index entry** (name, date, location) so it stays searchable in-app and one tap re-fetches it. (Same trick as the mobile media model — keep the descriptor, fetch the bytes.)
- **Archives are self-describing.** What lands externally is a small self-contained bundle (a readable summary + the kept files), openable in years without the app.

### 5.4 Connector weight (flagged)

External destinations are **real step-2 work**: Google Drive / OneDrive need OAuth; a NAS needs a network path + credentials (SMB/NFS/WebDAV). Budget for this as genuine connector engineering, not a checkbox.

### 5.5 Housekeeping edge cases

- **Orphaned files** — deleting a task must reclaim its attachments, or the container bloats. If two tasks share a file, don't delete the one still in use (reference counting / dedup).
- **Storage limits** — finite container disk; cap sizes and never sync large files to a phone on cellular.
- **Recurring payloads — retired.** The old recurring-task *input shared across instances / output per instance* split assumed the template/instance model, which was later retired. Routines are minimal rhythms outside the engine and carry no attachments, so there is no per-occurrence payload to place.
- **Link rot** — a URL attachment can die; offer "save a copy" for important links.

---

## 6. The ranking engine (technical notes)

- **Rating system:** Elo-style, one rating per task, updated per duel. A **K-factor** controls step size: high for provisional/new tasks (fast placement), low for settled tasks (stability — a careless tap barely moves them).
- **Matchmaking:** balanced random — weighted toward least-dueled tasks for even exposure. Pure random except the provisional cold-start burst, which uses **targeted** pairing (binary-search-style placement).
- **Two pools:** list-scoped and global-scoped draws, both writing to the same rating.
- **Consistency:** inconsistent inputs (A>B>C>A) are tolerated; the rating resolves them probabilistically.

---

## 7. The Today Track engine (technical notes)

Order of operations each time the Track is computed:

1. **Gate filter** — drop tasks failing any *hard* gate (dependency, availability window, not-before, location — the four built; resource and people never became gates, dissolved/reframed instead). Most gates are pure state/clock checks; only location reads the context toggle.
2. **Urgency propagation** — push deadline urgency backward along dependency chains. *(Built. In practice it runs on the full active graph **before** the gate filter, not after it as this numbered order suggests: the gate hides the blocked deadline, so propagation must see the graph first, then the gate filters what is displayed. Whole chain, highest-wins, no decay; recomputed fresh per read.)*
3. **Score** — `priority_now = importance + urgency + fit` for the survivors. *(Urgency is built as a multiplicative escalation of the rating rather than an added term; `fit` is still unbuilt.)*
4. **Pin** — inject any Impact safety-net cards (high-impact + neglected + playable).
5. **Lanes & strips** — route "theirs" to Waiting-on-others; build the "when you head out" / "not now" strips; guarantee a non-empty, explained view even when the deck is all-gated.

**Critical conflict detection (flagged):** the engine must actively surface *impossible-but-urgent* states — a task due today whose window has passed, or a dependency chain that can't finish before its deadline. These are alerts, not silent hides.

---

## 8. Context detection roadmap

| Phase | Mechanism | Cost |
|---|---|---|
| **v1** (built) | Manual: a managed location set + a header dropdown filter, **reset-to-Everywhere by default plus an explicit pin**, "Everywhere" = show all | none |
| later | Wi-Fi heuristic (home SSID ⇒ home) | no GPS/battery |
| later (opt-in) | Geofencing / calendar | privacy + battery |

Principle: never hard-hide on a low-confidence signal; and prefer coarse buckets over precise pins (also less creepy, and important given the multi-user vision means not holding others' location trails).

---

## 9. Cross-cutting principles

- **Descriptor/bytes split** appears twice (mobile media, external archives): always keep a lightweight, searchable pointer; fetch heavy bytes on demand.
- **Gates are filters, not data loss** — worst case you see the wrong menu; "show everything" is always one tap away.
- **Hard v. soft** — v1 is all hard gates for a clean playable/not model.
- **Grow-ready, not grown** — namespaced-by-owner and list-as-boundary now; hosted/multi-user/self-host later, without a rewrite.

---

## 10. Technical decisions — resolved and still deferred

**Resolved:** language (TypeScript), repo structure (monorepo + pnpm workspaces), web framework (React/Vite/Tailwind PWA), backend (Node/NestJS), database (PostgreSQL), **ORM / DB-access layer (Prisma)**, media store (filesystem volume in v1), mobile approach (React Native, deferred), **test framework (Vitest)**, **pinned runtimes (Node 22.23.1, PostgreSQL 16)**, **owner namespacing (`ownerId`, single local owner)**, **web serving in the container (Node static server)**.

**Still deferred — become ADRs when chosen:**

- Auth model (none in v1; hosted sign-up later).
- External-connector implementations (OAuth flows for GDrive/OneDrive, NAS protocols).
- **CI setup** — the *test framework* is settled (Vitest); continuous integration is not.
- PWA offline strategy specifics (service-worker scope for the web app).
