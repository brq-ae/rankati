# Rankati — Product Concept

This document describes **what Rankati does** and **why each mechanic exists**. It is the product source of truth. Technical/system decisions live in [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. The core idea

Rankati is a **personal decision engine**. Its job is to answer *"what should I do right now?"* — not merely to store what exists.

The original problem it solves: *"I keep losing track of my projects and the things I must do."* Rankati attacks that on three fronts, which map to the user's own words:

- **Track** — one trustworthy home for everything, so nothing falls through the cracks.
- **Evaluate** — decide what actually matters, via a low-effort ranking game.
- **Time** — estimate, track, and learn how long things really take, and when they're even possible.

Everything below serves that single question.

---

## 2. The lifecycle of a task

Every task travels the same arc. Each stage hands off to the next:

```
Capture ──► Triage ──► Arena ──► Today Track ──► Complete/Reflect ──► Review ──► Archive
  (Inbox)   (attrs +    (earns    (dealt when      (instant done +      (weekly    (records
             gates)     rank)      playable)        tap-sized reflect)   pulse)     kept)
```

- **Capture** — a thought becomes a task in one tap, landing in the **Inbox**, bare.
- **Triage** — you add the structured bits (list, gates, deadline, duration) and any **input** attachments.
- **Arena** — the task earns an **importance** rating through duels.
- **Today Track** — when the task is *playable right now*, it's dealt into your hand.
- **Complete / Reflect** — marking done is instant; reflection (time, output, "how'd it go") is tap-sized and can be deferred.
- **Review** — a gentle weekly pulse surfaces patterns and prunes the stale.
- **Archive** — completed work that's worth keeping becomes a **record**.

---

## 3. Entities

### 3.1 Task

The atom of the system. A task carries:

| Field | Meaning | Notes |
|---|---|---|
| **Title** | What it is | — |
| **List** | The one list it belongs to | Also its dueling pool and (later) sharing boundary |
| **Importance** | Earned priority from the Arena | Elo-style, one global rating. *Not* entered by hand |
| **Impact** | Declared consequence (High/Med/Low) | *Safety net only* — never enters the ranking math |
| **Effort / duration estimate** | How long you think it'll take | Feeds the "fit" calc; refined by estimate-vs-actual |
| **Deadline** | When it's *due* | Optional |
| **Not-before date** | Earliest it *can* start | Mirror of a deadline; optional |
| **Availability windows** | Clock windows when it's *possible* | e.g., office open Mon–Fri 8–2 |
| **Location gate** | Which context it's doable in | Optional; most tasks have none (doable anywhere) |
| **Resource gate** | A thing you need in hand | Deferred as a hard gate — absorbed by the dependency gate + a checklist item (§5.2); often converts into a prerequisite task |
| **Dependencies** | Tasks that block this one | Planned, foreseen ordering |
| **Responsibility** | Who's on the hook | Shipped as a soft `needsHand` boolean + a Lists filter; the four-state model (Solo / Needs-a-hand / Shared / Theirs) in §7 is deferred design |
| **Routine** | A rhythm you keep, wholly outside the engine | Frequency / floating / fixed; never ranked, never gated (§8) |
| **Attachments** | Inputs and outputs | Files, links, notes, contacts, map pins, amounts (§9) |
| **Reflection** | Captured on completion | Actual time, output, sentiment (§10) |

**Importance vs. Impact — the key distinction.** These arrive from opposite directions and are *not* redundant:

- **Importance is *earned*** — revealed by your duel choices ("what do I actually reach for?"). Relative, gut-level.
- **Impact is *declared*** — a stated consequence ("how bad if this never happens?"). Absolute, one tap.

The canonical example: *"Back up my laptop"* has **low importance** (you keep skipping it) but **high impact** (catastrophic if the disk dies). That divergence is exactly why both exist — importance ranks your wants; impact stops a quiet catastrophe from being buried.

### 3.2 List

A **bucket** of tasks. It is also:

- the **dueling pool** for "list mode" in the Arena,
- the **ownership boundary** (and, later, the **sharing boundary**),
- the carrier of a **retention policy** (§11).

A list is private by default. There is **no separate "project" layer** — see §12.

A list can be **deleted**, which **cascades to its tasks** (and their duel history, dependency links
and location tags). The confirmation is **graduated by size** — a plain confirm for a small list, a
typed **DELETE** for a large one — because the friction should scale with what is destroyed. You may
delete your **last** list; the app then shows an **empty state** that invites you to create one (it
does not refuse the delete or auto-create a replacement). *Built.*

### 3.3 Inbox

The zero-friction landing zone for captured tasks before triage.

> **Quick capture.** Two capture paths, deliberately kept distinct. The top **quick-add**
> form is unchanged fast capture — a bare title, gone in a second. The per-list **`(+)`** is the opposite
> intent: it opens the detail modal in **add mode** for that list (create-on-first-title — the task exists
> the moment you name it, and bailing with an empty title creates nothing), so a task you already know the
> details of goes in whole, in one flow.
>
> Every newly created task is stamped **`needsDetails`** — "unedited since creation," a soft marker, never a
> gate. It **clears on the first real edit** (any field, a checklist change, or gaining a prerequisite), and
> is **hand-toggleable** in the modal (a flag icon = "revisit later"). A header **count-badge** ("✎ N")
> surfaces the still-unfleshed set as a global inbox, and tapping it lists exactly those tasks so they are
> findable rather than lost — the Inbox above, made real for the fast-captured task.
>
> **Clone a task.** A **clone icon** in the detail modal opens that same add-mode
> **seeded** from an existing task — every field pre-filled but the **title blank** — so a repetitive task
> (same list, effort, gates, prerequisites, checklist) goes in as duplicate-and-tweak: adjust what differs,
> type a title, done. It copies the scalars, the locations, the same prerequisite links, and the checklist
> items (recreated **unticked** — a fresh task hasn't done its prep); it does **not** copy the Arena rating
> (importance is earned, not inherited). Like the `(+)`, nothing is created until you type a title — bail and
> there's no orphan.

### 3.4 Thread (lineage)

When completing a task spawns a follow-on task, the link between them is preserved. A chain of these forms a **Thread** — a walkable **case history** (§10.4).

---

## 4. The Arena — how tasks get ranked

Ranking 20 tasks at once is impossible. Ranking two is trivial. The Arena is built on that fact.

### 4.1 Pairwise duels

You're shown two (or three) tasks and pick the more important. Each pick updates a hidden **Elo-style rating**. A task that keeps winning floats to the top. You never rate in a vacuum; you just answer "this or that."

- **One rating per task.** There is a single importance number, full stop.
- **Two dueling modes, differing only by the pool:**
  - *List mode* draws pairs from one list.
  - *Global mode* draws pairs from all tasks.
  - Both update the **same** rating. A list is just a filtered *view* of the one rating.
- **It never ends.** Unlike a sort (meaningless until finished), a rating is meaningful after one duel and only sharpens. You duel as much as you like; you're never "done," just "confident enough."
- **It forgives inconsistency.** If you say A > B, B > C, then C > A, the rating just treats them as data points. You're never forced to be perfectly logical.

### 4.2 Matchmaking — balanced random ("football fairness")

Pairs are drawn **randomly, but fairly**: weighted toward the tasks dueled *least*, so exposure evens out and every task gets its fair share of matches, like a league where everyone plays a comparable number of games. This trades a little ranking speed for a ranking you can trust — no task languishes unranked by bad luck.

Matchmaking is **pure random by design** — *not* "smart" (we deliberately don't over-sample uncertain pairs). The single exception is cold-start (below).

### 4.3 Cold-start — new tasks

A brand-new task enters **provisional**:

- It **jumps the matchmaking queue** for its first handful of duels, and
- moves in **big steps** (high K-factor), so it snaps to roughly the right slot fast — think binary-search placement, only a few duels even in a large pool.

Then it **graduates** into the normal balanced-random pool and moves in small steps like everyone else. This is the *one* place a pinch of targeted ("smart") pairing lives; everywhere else stays pure random.

---

## 5. The Today Track — what to do now

The Arena decides *importance*. The Today Track decides *what's playable right now* and deals you a hand.

> **Status: this section describes the target; here is how much of it is built.** Today
> now orders by importance **escalated by urgency**: a task's Arena rating is
> multiplied by how near its `due` deadline is — the tier setting how steeply and how early it
> climbs — and **overdue tasks are pinned to the top**. A dated task not yet near enough waits in
> a new **Upcoming** tab. This escalation is multiplicative, not the earlier additive `+`.
>
> What remains of **§5.1** (`importance + urgency + fit`): **all three factors now drive the
> order** — `fit` shipped as a bucketed penalty. A task carries an optional
> **effort bucket** (Quick / Medium / Long); set the **free block** at the top of Today and a task
> too big for it **sinks** — its Today score is multiplied by a penalty. It is **neutral by
> default**: no block, an untagged task, or a fitting task changes nothing, so an un-blocked hand is
> byte-identical to before the term existed. It touches the **Today hand only** — overdue stays
> pinned, placement between Today and Upcoming is unchanged, Lists and the Arena never see it. The
> minute thresholds that *label* the buckets are **display-only**, client-side; only the ordinal
> bucket crosses the wire. **Deferred by design:** learning (estimate-vs-actual) and exact
> durations — buckets, not minutes, and no self-tuning yet. Of **§5.2's six gates**, **four exist** — not-before, dependency,
> **location**, the last as a client-side context-filter across all views, not a
> Today-only gate, and **availability window**: four fixed presets, judged server-side by
> the client's own clock. **§5.3's
> backward urgency propagation is now built**: a blocked
> deadline's urgency flows backward along the whole chain, so the actionable prerequisite is
> pulled into a playable tab carrying that urgency and naming the goal. **§5.4** (the impact pin)
> and **§5.5** (lanes, the dealt hand) do not exist.
>
> The all-gated morning is still honoured only in the smallest way: Today distinguishes "nothing
> active" from tasks that are merely waiting, and says how many are blocked versus not yet due,
> rather than reporting an empty screen as if you had no work. **The per-task gate slate is now
> settled, not "remaining":** the availability window follows that shape
> exactly (an optional field, `NULL` = ungated, hides from Today only, leaves the Arena alone).
> **Resource and people did not become gates** — both were tested against real tasks and dissolved
> them: resource into the existing dependency gate (an "acquire it" prerequisite task)
> plus a checklist item; people into a soft `needsHand` label plus the "Waiting on people" Lists
> filter (§7), never hiding a task. No further per-task gates are planned. **Location was
> always the exception, and deliberately so:** a context is not a per-task condition, so it filters
> *all* views client-side and may fail open (unknown context shows everything), where a per-task
> gate fails closed.

### 5.1 The priority-now formula

```
priority_now = importance + urgency + fit
```

- **importance** — from the Arena.
- **urgency** — grows as a deadline nears (gentle ramp, sharper near the wire).
- **fit** — rewards tasks that fit your current free block; penalizes those that don't. *Built as a penalty multiplier: a task too big for the block you set **sinks**; neutral by default; ordinal buckets (Quick/Medium/Long), not durations.*

**Impact is deliberately *not* in this formula** (it acts only as a safety-net pin — §5.4). Keeping the math to three terms makes it easy to reason about and tune.

> **Both non-importance terms are now MULTIPLICATIVE, not additive.** Today-score is the Arena rating *escalated* by urgency as the deadline nears (tier setting the steepness), then multiplied by the **fit penalty**: `score = rating × urgencyMultiplier × fitPenalty`, where the penalty is 1 unless the task is too big for the free block. This box stays as the original three-factor design target.

Worked example — *Sunday night, 2 hours free:*

| Task | importance | urgency | fit | priority_now |
|---|---|---|---|---|
| Fix citations (due tomorrow, fits 2h) | 986 | +120 | 0 | **1106** |
| Write intro (no deadline, needs 3h) | 1047 | 0 | −40 | **1007** |

The "less important" task correctly tops tonight's deck, because it's due and it fits.

### 5.2 Gates — what's even on the table

Before ordering, the Track filters to what's genuinely *possible*. There are two families:

**Hard gates (block — you literally cannot):** the four built in v1.

- **Dependency** — a prerequisite isn't done yet.
- **Availability window** — outside the task's doable clock hours. *Built: four
  FIXED presets — Anytime (the default; no window), Working hours (Mon–Fri 8:00–14:00), Workdays
  (Mon–Fri), Weekend — a closed set, deliberately not a per-task builder.*
- **Not-before date** — too early to start.
- **Location** — you're not in the right context (§6).

**Resource and people — the last two hard-gate candidates; neither shipped as a
gate.** Both were tested against the owner's real tasks and dissolved them: **resource**
into the existing dependency gate ("acquire it" as a prerequisite task) plus a checklist item ("did I
bring my stuff"); **people** into a soft `needsHand` label plus the "Waiting on people" Lists filter
(§7) — visible, never gating. The slots for both stay named and deferred, not built.

**Soft gates (nudge, don't block):** **considered but NOT in v1.** Energy/focus, weather, batching. All v1 gates are hard, which keeps the Track a clean "playable or not." Soft nudges can be added later.

### 5.3 Dependency urgency propagates backward

A boring prerequisite can be the *most urgent thing you own*. If "Submit thesis" is due Friday and can't start until the advisor replies, then "Email advisor" — low importance on its own — is promoted and flagged *(unblocks Fix citations)*. Urgency flows **backward** along the dependency chain, or the Track would keep burying the one task that frees everything.

> **Built.** The deadline's urgency propagates backward along the whole chain — highest wins, no decay — and the promoted task carries subtext naming the goal. It is recomputed fresh on every read, so it appears and vanishes with the deadline it serves.

> **The Blocked filter.** The Lists tab has an `[ All | Blocked ]` toggle: Blocked shows, across all lists, the tasks currently held by an unfinished **direct** prerequisite — each naming what it waits on ("waiting on → …"). It is a *filter over data that already exists*, not a new capability, and it is **distinct from §7's people Waiting-on-others lane**: this is tasks blocked by *tasks*; that lane is work blocked on *people*.

### 5.4 Impact safety-net pin

Impact stays out of the ordering, but fires a **pin** when all three hold:

1. the task is **High impact**,
2. it's been **neglected** (keeps sinking / skipped past a threshold), and
3. it's **playable right now** (passes gates, fits the block).

Then it surfaces as one highlighted card with its reason (*"high-impact · skipped 3× · 30 min"*) and is **snoozeable** — dismiss it and it goes quiet, so the safety net never becomes nagging.

> **Built — the graded pin.** Impact is a declared per-task **level**:
> **None (the default) / Medium / High**, set in the detail modal. It still **never enters the ranking** — it drives only the pin. "Neglected" became concrete: a task is neglected once it has
> sat unfinished for a **fuse's worth of days**, and the LEVEL sets the fuse — **High = 7 days, Medium =
> 30** — off the task's created date. The pin fires for a Medium/High task that is **playable now**,
> **past its fuse**, and **not already in the hand**: one highlighted card **above the hand** (⚠️,
> most-overdue first, one at a time) with its reason (e.g. "high-impact · 8 days"). **Snooze** hides it
> for a level-set span — **High 1 day, Medium 3** — then it returns if still neglected. All four
> day-values are **editable in Settings**, and those four settings plus each task's snooze are **stored
> on the server** — so the web app, the Telegram bot, and any future client draw on one source of truth
> and compute the identical pin from one shared function. The dealt hand is what made this buildable — a
> stable playable set to count neglect against. The original "skipped 3×" neglect-count is a possible
> future refinement — the fuse is simpler.

> **Checklists are readiness, not ranking.** Ticking an item is a personal
> judgement call, never enforced (§9). The proposed ranking signal — "a fully-ticked checklist
> ranks the task higher," a long-standing open question, additive-or-multiplicative against
> `priority_now` undecided — is explicitly **still deferred** to a later ranking pass. (`fit` shipped as
> a size penalty, and the impact pin shipped as a declared level, not this checklist signal.)

### 5.5 Lanes and the empty state

- **"Theirs" tasks** live in a separate **Waiting-on-others** lane — ranked among themselves so you know who to chase first, surfaced as follow-up nudges, never as action cards.
- **"Needs-a-hand" tasks** that are gated surface as *"coordinate with X."*
- **The all-gated morning:** when your whole top-ten is blocked, the Track never shows a blank screen. It shows what *is* playable, plus strips for what unlocks soonest and who to chase.

> **Built, with two changes from the sketch above.** The all-gated morning is
> honoured exactly: a **"Nothing playable right now"** state with the strips as the focus, never blank.
> But the separate **"Waiting-on-others" lane is DROPPED** — a `needsHand` task is *playable*, so
> it stays **in the hand** with its 🤝 marker rather than being parked in a lane. The Theirs/four-state
> model that lane was for stays deferred. The two strips that shipped are **"When you head out"**
> (playable errands elsewhere, grouped by place) and **"Coming up"** (the gated set, soonest-to-unlock).

### 5.6 The dealt hand and the win condition

The Track deals a **hand** — the playable cards, in priority order — plus auxiliary strips ("when you head out," "waiting on others," "not now"). The hand has a bottom. **Emptying it is the win** ("beat the deck"). This is the gamification: the duel mechanic *is* the game, and clearing the hand *is* the daily goal — no XP or streaks bolted on.

> **Built — Today BECAME the hand.** Today is no longer an open-ended ranked list:
> it is a finite, beatable hand of the top-N playable cards (default 5, editable in Settings), **held and
> manual**. Completing a card (the same tick/undo ring, now on the card) empties its slot and
> **nothing slides in** — *Deal again* tops up the freed slots with the next-best not-held, on your tap.
> Clearing the hand is the **win** — "You beat the deck" — and *Deal again* starts the next round; if
> nothing is playable it is the never-blank state. Overdue stays pinned, inherited-urgency
> subtexts still show, and the fit block picker still shapes what is dealt. It **reads the
> existing scoring and changes none of it** — the hand is composition and statefulness over the same
> `findToday`. The held set lives **client-side** (localStorage), so there is no schema or API change.
> The §5.4 **impact pin** — the neglect/skip count the hand now makes possible — is the deferred next step.

---

## 6. Context & location

- Locations are a **small, editable set of contexts** — Home, Work, Out to start, plus any you add.
- A task's location gate names which context(s) it's doable in, and it's **optional** — most tasks (writing, emailing) carry none and appear everywhere.
- **v1 detection is manual** (no Wi-Fi/geofencing yet — those are later, opt-in enhancements; see ARCHITECTURE), with a permanent "show everything" (Everywhere) override.
- Principle: **coarse beats precise** (Home/Out/Work, not exact pins), and Rankati **never hides behind a guess** — an unsure signal shows tasks anyway, dimmed.

Most gates need **no detection at all** — availability windows and not-before dates are clock math, and dependencies are internal state. Only *location* genuinely needs sensing, and v1 handles it manually. (Resource and people never became gates needing detection at all — see §5.2.)

> **Built.** Locations are a **managed many-to-many entity** (create, rename, delete, merge), and the manual "detection" is a **header dropdown** that filters Lists, Today and Upcoming together to the chosen place plus everything untagged. It **reverses an earlier design**: the *sticky* toggle is **reversed** to **reset-to-Everywhere-by-default plus an explicit pin** — a silently-sticky context filter is a lying view. It filters **client-side and across all views**, never touching the Arena.

---

## 7. Responsibility — who does it

**Shipped:** a soft `needsHand` boolean on Task — a visible row marker plus a
detail-view toggle, meaning "this involves or waits on a person." It never gates: a flagged task
stays exactly as playable as any other, still dealt by the Track, still dueling in the Arena, never
hidden from Today/Upcoming/Lists. Lists' segmented toggle grows a third segment, `[ All | Blocked |
Waiting on people ]` (the same filter pattern reused verbatim), surfacing the flagged set flat and
cross-list, alongside Blocked. Who the person is lives in the title or a checklist item (§9) — the
flag itself carries no relationship, no contact, no availability.

**The four-state model below is DEFERRED design, kept for the record, not what is built.** An earlier design
modelled responsibility as four states with a hard people-gate and a separate Waiting-on-others lane;
testing that model against real tasks found it heavier than the need — coordination ("call
the plumber," "ask Sam") turned out to be a checklist item, not a gate condition. The table is kept as the original thinking, not a status board: a future reader
considering "Shared" or a real Theirs handoff should restart from here, not from `needsHand`, which
has no room to grow into a real handoff.

Four states, each flowing through the system differently:

| Responsibility | Competes in | Dealt by the Track? | Lives in |
|---|---|---|---|
| **Mine, solo** | Your arena | Yes, when eligible | Main deck |
| **Mine, needs a hand** | Your arena | Only if the helper's available; else "coordinate with X" | Main deck (people-gated) |
| **Shared** | Your arena | Your part gets dealt; gated if it waits on their part | Main deck |
| **Theirs** | Waiting-on-others lane (ranked among themselves) | Never as an action — follow-up nudges only | Waiting-on-others lane |

This field is also the **seed of future collaboration**: today it's a label + a name; once multi-user exists, "Theirs" becomes a real handoff to another person's board.

---

## 8. Routines — rhythms you keep

Things you repeat aren't things you rank against each other; they're **rhythms you keep**. A **Routine** is a first-class entity that lives **wholly outside the engine** — it never duels, never has an importance, never gates, and never appears in Today / Upcoming / Lists / the Arena. It lives in its own **Routines tab**, which has two sub-tabs: **Reminders** (the recurring routines below) and **Logs** (§8.1 — pull-based cadence trackers). *(This supersedes an old template/instance model; recurrence never entered the Arena.)*

**Reminders** come in three types:

- **Frequency** — "N times per day / week / month / year." Shows your progress in the current period ("2/3 this week") and **resets at the period boundary** (day → each day, week → Monday, month → the 1st, year → Jan 1). **No history** — the prior period is simply discarded. Action: **Did it** (+1).
- **Interval — floating** — "every N days / weeks / months," measured from when you *last did it*. **Did it** restarts the clock (optionally snapping forward to a preferred weekday, never earlier); if the date passes untouched it stays and **climbs**.
- **Interval — fixed** — locked to a calendar rule ("1st Friday", "the 15th", "last Friday"). A pure reminder: doing it **never** moves the next date. **Dismiss** just clears the current highlight until the date passes and it recomputes to the next.

**Snooze** hides any routine from the tab for a while (5 minutes … 1 day) so others take the top; it touches no schedule and records nothing done or missed. The tab **climbs** — overdue and nearer-due reminders rise; frequency routines (which have no due date) sit in a band below, ordered within that band by **pace pressure** — how far behind you are given the time left in the current period (the daily rate you'd now need), so the most-at-risk rhythm rises and a goal-met one sinks.

Reminders stay deliberately minimal: **no history, no streaks, no adherence-over-time**, and **no notifications** — a reminder is a tab you open and check. (The "may come later" history is now **Logs** below — a separate kind, not a change to reminders.) *Built.*

### 8.1 Logs — cadence you track, not a rhythm you're held to

Some repeated things aren't rhythms you must keep on pace — you just want to **track how often** they happen: a haircut, nails, a pedicure. A **Log** is the opposite of a reminder on every axis: its dated occurrences **are** its history, it **never climbs, nags, or shows pace pressure**, and its cadence hint appears **only when you open it** — pure pull, never a notification.

Tap **✓ I did it today** to stamp today's occurrence (idempotent — one per calendar day). Open a Log and it shows the **last-done**, a **soft cadence hint** (*"usually ~35 days · it's been 40"*), and the **history** — dated occurrences, newest-first, each with an **undo** to remove a mis-tap. Under two occurrences it stays graceful — *"logged once on \<date\>"* / *"not logged yet"*, never a bogus average. A Log is renamable and deletable like a list and, like everything in this tab, lives **wholly outside the engine** — never ranked, gated, or in Today / Upcoming / Lists / the Arena. Grouping many Logs (Grooming, Home) is deferred; they start flat. *Built.*

---

## 9. Attachments — what a task carries

Attachments come in **two flavours by timing**, and this distinction drives records and archiving:

- **Inputs** — what you need *to do* the task, added at triage: the PDF to send, a login, instructions, a reference doc.
- **Outputs** — what the task *produced or received*, added on completion: a confirmation number, a receipt, a photo of the finished job, a court verdict PDF.

**Outputs themselves come in two kinds:**

- **Artifact outputs** — a static file/record. Stays on the task; archived with it.
- **Task outputs (follow-ons)** — completing the task *spawns another task*. Not archived as an output; it becomes a live successor (§10.4).

**Attachable types:** files, links (URLs), notes, a **contact/person**, a **map pin/address**, an **amount/cost**, and the location of a physical item ("passport, blue drawer").

> **Checklists shipped as real per-task structure, not a loose note.** A
> `ChecklistItem` list (text, done, position) — add, rename, tick/untick, reorder, remove — backed by
> its own table (the third related-entity table, alongside dependencies and locations), not JSON on
> the task. Ticks persist permanently; nothing resets them, not on completion, not on a schedule. A
> checklist is **soft, never a gate** (held here again): a task completes with items
> unticked, exactly as any other. The ranking signal — a fully-ticked checklist ranking the task
> higher — is explicitly deferred to the Today Track build (§5.4).

**Upload lanes** (see ARCHITECTURE for the technical rules):

| Lane | Rule |
|---|---|
| **Image** | Auto-downsized to ~1080p and ≤2MB (born ready for WhatsApp/email/gov upload). Already-small files untouched |
| **Video** | 720p, ≤10MB |
| **Documents** | PDFs and the like — uploaded **as-is**, never compressed |
| **Attachments (raw)** | **Unregulated** — any size, full fidelity, for when you deliberately need the real thing |

The four lanes = **optimized lanes for the common case + a raw escape hatch** for the exception.

---

## 10. Completion, reflection, and learning

### 10.1 Marking done is instant

**"Done" is always one tap and never blocked.** The system must never punish you for finishing something — that's how decks go stale. The tap is instant to the eye — the circle fills at once — but the commit waits **fifteen seconds**, so a mis-tap is taken back by tapping again rather than by a confirm dialog that would tax every real completion. Leaving the page inside that window commits it: a completed action honoured, not an unfinished one discarded.

### 10.2 Reflection is full, but tap-sized and deferrable

On completion, Rankati prompts for a **full reflection** — but designed so it's ~5 seconds, not a form:

- **Time** — pre-filled from the stopwatch, or a one-tap chip ("15m / 30m / 1h / longer").
- **Output** — one-tap attach, or "nothing."
- **How'd it go** — a sentiment tap ("smooth / fine / rough / ran long"), with an optional text box.

On a slammed day you can **punt** a reflection into a queue that the weekly review sweeps up. Full reflection stays the default ritual; it just never blocks "done."

Over a month, the "how'd it go" line becomes a **diary of patterns** ("anything involving the advisor runs 2× and feels painful").

### 10.3 The learning loop

- Completing a task **cascades**: anything it was blocking unlocks, and the Track refreshes on the spot.
- **Estimate vs. actual** deltas accumulate. Rankati learns you underestimate writing by ~60% and warns/pads accordingly. This feeds straight back into the **fit** term, so "does this fit my 2 hours?" gets more honest every week.

### 10.4 Threads — when outputs are tasks

When a task's output is a *follow-on task* (the verdict says "file an appeal by the 30th"):

- the follow-on drops into the **Inbox** as a fresh task,
- the original task **archives as its own record** ("this happened, and it led here"),
- the follow-on runs its full lifecycle and archives when *it* completes,
- **the lineage link is preserved.**

Preserved lineage turns the archive from a flat pile into **threaded case histories**: *hearing → verdict → file appeal → appeal verdict*, walkable as one case years later. (This is subtly different from a dependency: a dependency is *foreseen* ordering; a follow-on is *emergent*, discovered only on completion.)

---

## 11. Records & retention

Completed work that matters is kept; the rest is shed.

### 11.1 The retention lifecycle

```
Active ──► Done ──► Archived
```

- **Active** — in the working set (Arena, Today Track).
- **Done** — completed, still nearby for the retrospective and weekly review.
- **Archived** — offloaded to keep the container lean, but retained as a record.

### 11.2 What counts as a record

**List policy + output safety net:**

- A **list policy** sets the default (e.g., "Legal"/"Finance" keep everything; "Errands" discards).
- **Any task that produced an output is kept regardless** — so a genuine record never slips through just because it lived in the "wrong" list.

### 11.3 What survives archiving

**Shed the inputs, keep the outputs.** The stuff you needed to do the task falls away; the artifact it produced (the verdict, the receipt) is preserved. Archiving is therefore both cheap (drop the bulk) and safe (never lose what mattered).

### 11.4 Where archives live

A **single global, all-or-nothing** policy (no per-item mixing):

- **Never archive** — which splits into two fates: *keep live forever* (a record you reference often) or *discard on done* (nothing worth keeping).
- **Archive in the container** — cold store on the server.
- **Archive to your own storage** — NAS, Google Drive, OneDrive.

Two principles: **offload the bytes, keep the breadcrumb** (a searchable index entry stays even when the file ships to GDrive), and **archives are self-describing** (a readable bundle you can open in five years without the app).

---

## 12. Deliberate non-decisions (scope discipline)

Things we consciously chose **not** to build in v1, so scope stays honest:

- **No separate Project layer.** Lists are enough. Project-like grouping emerges *bottom-up* from Threads instead of being declared top-down.
- **No soft gates** (energy, weather, batching). All v1 gates are hard.
- **No multi-user / collaboration** in v1 — but the data model is namespaced by owner and treats a list as the sharing boundary, so it can grow.
- **No offline media cache** on mobile (tasks only) — this also doubles as the security model.

---

## 13. Open threads (parked, not lost)

- **Sub-task vs. dependency** — where the line sits between decomposing one task and ordering two.
- **A task in multiple lists** — currently one list each (keeps the dueling pool clean); revisit if needed.
- **Notifications/nudges** — staleness ("waiting on Sarah 3 weeks"), deadline warnings — lightly specified.
- **Snooze / defer / someday** — beyond the pin snooze, a fuller defer model.
- **Deadlock detection** — circular dependencies (A↔B) and perpetually-unavailable helpers need explicit handling.

## 14. Appearance

Rankati offers several colour **themes** — a brand default, the original slate, a warm palette, and a colour-blind-safe one — each in light or dark, chosen in Settings and remembered. Theme is taste and changes freely, with one promise it must never break: **colours that carry meaning stay fixed regardless of theme.** The tier heat (critical is always hottest), an overdue marker, a not-before hold, the pin — these *communicate*, so a theme may tune a shade for contrast but never what the colour says. See [`docs/THEMES.md`](THEMES.md) for the per-theme spec, including how the colour-blind-safe theme adds a non-colour cue where hue alone can't be trusted.

## 15. Starting over

Settings offers two ways to wipe, named by **intent** rather than a matrix of options:

- **Clear tasks** — deletes every task and everything that exists only because tasks exist (their duel
  history, dependency links, and location tags). Your **lists and locations stay** (empty); nothing is
  reseeded. The point is your own structure, freshly empty.
- **Factory reset** — back to a fresh install: tasks and lists deleted, locations reset to the shipped
  defaults. A **"Keep sample data"** switch (on by default) decides whether the sample lists and tasks
  come back or you land on a genuinely empty app. Your **theme is kept** — that is a preference, not
  data — and the pinned location filter is cleared.

Both wipes demand you **type DELETE** to confirm: the friction *is* the point, so neither can fire by
muscle memory or a misclick. A **fresh install and a factory reset land in the identical state** —
the shipped defaults are defined once, so the app a new user first sees is the app a reset returns
you to. *Built.*

That shipped state is a **realistic sample set that demonstrates the engine**: a UAE/GCC
person's lists — Home, Car, Government, Groceries, Business — whose tasks exercise every capability at
once: single-, multi- and no-location tags, all four tiers, deadlines, a not-before, four dependency
chains (three carrying a deadline that propagates back to its blocker, one deliberately without, to
show a dependency gates even with no deadline involved), and one completed task. **Dates are relative
to when the seed runs**, so a reset always produces fresh deadlines, never ones overdue on arrival.
**Nothing is pre-dueled** — every sample task starts at the same rating, because the order is yours to
set; the first duel is where it becomes yours. *Redesigned.*

---

## 16. Signing in

*Shipped.* Rankati is **single-user**: one account guards one dataset. This is
what makes the data *yours* rather than the machine's the moment Rankati runs somewhere other people can
reach — it is not "going public", it is the price of anyone else being able to run Rankati at all.

- **First run** — the very first visit shows a **create-account** screen: pick a username and password.
  There is no sign-up flow and no second account; once created, setup is closed. You land straight in the
  app.
- **Logging in** — after that, a visit with no session shows the **login** screen. A wrong username or
  password is one message that never says which was wrong. Too many wrong tries **locks you out** for a
  spell that grows the more you fail (a minute, then longer), so guessing does not pay. The **username is
  case-insensitive** — `Alice` and `alice` are the same account, so a phone auto-capitalizing the
  first letter doesn't lock you out.
- **See what you're typing** — every password field has a **show/hide eye**, so you can confirm the actual
  characters before submitting; useful when a phone quietly filled in a *generated* password at first-run
  that isn't the one you meant to set.
- **Trust this device** — a checkbox on both screens. Ticked, you stay logged in for **30 days**;
  unticked, the session ends when you close the browser.
- **Change your password** in Settings — it also **logs out every other device**, keeping only the one
  you changed it on.
- **Log out** from Settings, any time.
- **Forgot your password?** There is no email reset. Whoever runs the box clears the account back to
  first-run with a single command — **your tasks and lists are untouched**, you just set a new password
  and carry on. A lockout is cleared the same way. (The operator commands are in `ARCHITECTURE.md` §1.1
  and `INSTALL.md`.)
