# Themes

How Rankati's colour themes work, and exactly what each one changes. This file is the human-readable
record of the themes themselves.

**`apps/web/src/index.css` is the authoritative source for every resolved value.** This doc records
what CAN'T be read back out of the CSS — external brand hexes, deliberate design values, derivation
rules, and the reasoning — and points at `index.css` for anything resolvable. A full hex table here
would be a second copy with no drift guard keeping it honest, so there isn't one.

**Beyond colour — a theme changes *only* colour.** The brand's non-colour identity (typography,
shape, the signature gradient bar) is a **single app-wide baseline**, not a theme axis.
Every theme renders in the same font (Inter) and the same radius/shadow scale; a theme never changes
type or shape. Two things there interact with this file's rules: the **primary glow** is *tinted per
theme* (it reads `var(--primary)`), and the **gradient bar** is a **brand-only mark** — present under
`[data-theme='brand']` and absent on the others (a mark must sit only where it belongs, not recolour
per theme). The **browser-drawn-surface** rule below now covers shape too (the `<select>` popup's
corners), not just colour.

## How a theme is applied and persisted

- **Two independent axes.** Mode (light / dark) is the `.dark` class on `<html>`. Theme is
  the `data-theme` attribute on `<html>`. 4 themes × 2 modes = 8 combinations, all reachable.
- **Two localStorage keys.** `deck.theme` holds the mode (light/dark); `deck.palette` holds the
  theme. The key names predate the mode/theme rename — `deck.theme` is the *mode* — kept as-is to
  avoid a migration that would silently reset a stored preference.
- **Default is brand.** Nothing stored → brand. An **invalid** stored theme — a stale name from a
  downgrade, a typo, anything not one of the four — falls back to brand rather than applying an
  unknown `data-theme`, so the app never renders untokenised. The invalid case, not just the
  missing one, is tested.
- **The picker** is in the Settings modal (the gear), a button group beside location management;
  the mode toggle stays in the header. Both persist.
- **Anti-flash.** An inline script in `index.html` applies BOTH axes before the first paint — a
  theme flash is the same bug the anti-flash script prevents. The script can't import, so its constants
  (both keys, the valid set, the default) are duplicated; a **drift guard** in
  `test/anti-flash.spec.tsx` reads the file and fails if any diverge from `mode.ts` / `palette.ts`
  (it now also locks the mode key, previously comment-only).
- **`<meta name="theme-color">`** (the mobile address-bar tint) is theme-aware: the inline script
  sets the default-theme canvas per mode, and React re-reads the live canvas on every change.
  **Implemented but NOT verified on-device** — it's browser chrome, never app content, and was
  deliberately not eye-checked. If a browser rejects the computed colour format the tint simply
  stops tracking; nothing else is affected.

## The token model

Colour is expressed as **semantic tokens** named by meaning, never by shade — a component says
`bg-canvas` or `text-tier-critical`, never `bg-slate-100` or `text-red-700`. A theme is a block that
overrides those custom properties. Colour is data, not surgery. Two tiers keep it safe:

- **Palette tokens** (canvas, card, text, primary…) a theme may vary freely.
- **Meaning tokens** (the tier heat ramp, overdue, not-before, error, pin…) carry a fixed meaning
  and live in the base layer. A theme may tune a **shade** for contrast but must never change what a
  colour **communicates** — critical always reads hottest, overdue always urgent. This is why there
  is no per-element colour control, and why only Clear tunes any meaning token (below).

## Opacity — which tokens may go translucent, and which may not

This is the rule a theme author — and anyone extending the UI — needs *before* they hit it. It has a
general form that governs **both colour and shape**: *for a surface the browser draws itself — a
native control's popup, scrollbars — style the CONTROL we own, never the SURFACE the browser owns.*
This milestone hit it **twice**: `control-bg` (colour, below) and the `<select>` popup's corners
(shape, further below). The colour form of the rule:

> **Any surface the browser itself draws — native controls and their popups, scrollbars — or that
> something solid sits on top of and expects to hide, must be OPAQUE.** A translucent value there
> composites against something you don't control (a UA default, or whatever shows through), and the
> result is unpredictable.

- **May be translucent:** overlay tokens composited in normal DOM over a known solid backdrop —
  `field-bg` (a tint over the canvas), `backdrop` (a scrim, translucent *by purpose*), the pending
  track, and brand-dark's white-overlay neutrals. Nothing structural depends on them being solid.
- **Must stay opaque:** `canvas` and `card` (solid surfaces other things layer onto — a card can't
  be translucent and still be a card), `control-bg` (native `<select>`), and `primary` (the
  `on-primary` text is drawn on it). `index.css` is authoritative for which token is which.

### The `control-bg` contract (the worked example)

A native `<select>` renders its option popup as a **browser-drawn surface**, not part of our DOM. A
translucent `background-color` on the select makes that popup composite toward white, so light-in-
dark text becomes unreadable (white-on-white). Text `<input>`s have no popup and *want* translucent
depth. Two requirements that had shared one token — the same class of collision as not-before and
pin both being amber. So:

- **`field-bg`** — text inputs. May be translucent (brand dark uses a 5%-white overlay for depth).
- **`control-bg`** — native `<select>`. **Opaque in dark modes** (transparent is fine in light,
  where the UA popup is already light). Slate/Warm/Clear set it to the opaque value their `field-bg`
  already had (nothing changed); brand sets the **opaque twin** of its translucent field,
  `color-mix(in srgb, #ffffff 5%, var(--card))`, so even the closed control looks identical.

The two selects that paint `bg-card` were already correct — not lucky — because `card` is opaque in
every theme by the rule above.

### Shape — the `<select>` popup keeps the browser's corners

Under the brand radius baseline, the closed `<select>` controls round correctly (`xl`), but
their open option lists have **square corners** the surrounding rounded UI no longer matches. The
popup is unreachable the same way its background was: `border-radius` doesn't propagate to it, and
the one mechanism that would style it — `appearance: base-select` + `::picker(select)` — does not add
corners to the native control, it **replaces the native rendering mode entirely**, which by Chrome's
own docs "doesn't trigger built-in mobile operating system components." Rounding the corners would
therefore *cost the native mobile picker* (the iOS wheel, the Android sheet) on a phone-first app —
the loss is **not a side effect of the fix, it is the fix**. (Support is partial too — Chromium
135+/Safari 27, nothing in Firefox — so it would style one browser family and silently do nothing in
another.) **Decision: round the control we own, and live with the browser's corners on the transient,
only-visible-while-open popup.** Noted as a known trade-off to revisit — and honestly,
**revisit ≠ fix**: `base-select` always replaces the native picker by design, so even at Baseline the
mobile trade never goes away.

### The lesson

A **browser-drawn surface is the standing exception** to "our tokens style everything" — it surfaced
**twice this milestone**, colour (`control-bg`) then shape (the popup corners), which is why it is one
rule and not two incidents: style the control we own, not the surface the browser owns. And any
static check we run (the colour-set diff, a radius grep) compares *our CSS*, never the browser's
native *rendering*, so none of them can catch these — the guard is knowing the boundary is there.

Before brand, `field-bg` on a `<select>` was fine in every theme, but only by accident: Slate's
`field-bg` is opaque because Slate predates theming and never used translucency, and Warm/Clear
inherited that accident. **Brand didn't introduce the bug — it exposed it**, being the first theme
to use translucency. The general lesson: **a token's correctness can depend on a property no theme
had exercised yet.** The colour-set diff that proved the Step-A sweep byte-identical compares CSS
*values*, not browser-native *rendering*, so it could never have caught this — which is why the fix
is a token contract, not a per-theme patch.

---

## Slate — the original palette, promoted to a named theme

The cool-grey palette Rankati shipped with. It **is the base layer** (`:root` / `.dark`), not a copy —
selecting Slate removes `data-theme` and the base shows through.

- **Palette overrides:** none. The values are today's `--color-slate-*` references, so "preserved
  exactly" is true *by construction*, not by a hand-copied table that could drift.
- **Meaning overrides:** none.

## Brand — the default

Near-white / deep-purple canvases with a magenta-pink primary as the emphasis signal (active tab,
primary button, ticked done-circle, focus/selection rings).

- **Palette overrides:** all 22 palette tokens. The values that **can't be derived from the CSS**
  because they came from the external brand spec:
  - `canvas` `#f8fafc` / `#1A102E` · `card` `#ffffff` / `#2D1B4E` · `primary` `#E62E8A` (both modes)
  - `secondary` `#6B21A8` and the `#F472B6` dark-primary echo — **reserved and unused**.
  - The other spec tokens (`subtle`, `fg`, `muted`, `faint`, `edge`) resolve to Tailwind refs and
    white-overlays — see `index.css`.
- **Provenance — the split that matters the day the brand changes.** The spec named **9** tokens;
  Rankati's surface needed **22**, so **13 were derived** from the spec's own idiom (dark neutrals as
  white overlays at graded opacity; text on a cool white→slate ramp):
  - **From the spec (9):** `canvas`, `card`, `subtle`, `fg`, `muted`, `faint`, `edge`, `primary`,
    `secondary`.
  - **Derived (13):** `chip`, `hover`, `hover-strong`, `surface-hover`, `surface-active`,
    `backdrop`, `strong`, `body`, `strong-hover`, `divider`, `field`, `field-bg`, `on-primary`.
- **Meaning overrides:** none — the tier reds and the brand pink stay distinct because the pink
  carries a real blue component the meaning-reds don't.

## Warm — a warm identity, distinct from Slate and Brand

Slate and Brand are both cool (cool grey; magenta). Warm takes the axis neither does.

- **Palette overrides:** the whole neutral ramp swapped `stone`-for-`slate`, 1:1 and shade-for-shade
  (so it stays byte-honest against Tailwind's `--color-stone-*`), plus a **teal** primary
  (`teal-600` light / `teal-400` dark). That swap rule *is* the spec — no hex table needed.
- **Why teal:** it avoids every meaning hue (red / orange / yellow / amber), so the primary can't be
  mistaken for a signal. Its only near-neighbour is emerald-*positive*, rare and almost never
  co-visible.
- **Meaning overrides:** none. **Verified by human eye-check at Step C, light and dark**, with the
  **pin fill** and **yellow-important** — the lowest-contrast warm-on-warm pairings — looked at
  specifically; neither needed a shade tune, because lightness contrast (which carries legibility)
  is near-identical between `stone` and `slate` at each step.

## Clear — the colour-blind-safe theme

Slate's chrome with a universally-safe **blue** primary, and two complementary moves aimed at the
one real problem: the tier ramp (grey → yellow → orange → red) is the classic red-green confusion
set, so retinting alone cannot fix it.

**1. Retint.** The tier swatches are re-spaced **monotonic in lightness** — important lightest,
critical darkest — because lightness survives red-green colour-blindness even when hue collapses.
The deliberate retint values (not derivable — they're the design decision):

- **Palette override:** `primary` → `blue-600` (light) / `blue-400` (dark).
- **Meaning tunes** (the only theme that tunes any): `tier-important` → `yellow-300`,
  `tier-critical` → `red-700` (light) / `red-600` (dark), and their accents darker for text
  legibility (`tier-important-accent` `yellow-600`/`yellow-500`, `tier-critical-accent`
  `red-700`/`red-500`). Super stays mid; normal stays the grey baseline. Overdue-red and
  not-before-amber are **not** recoloured — that would change what they communicate, and they
  already carry distinct glyphs (⚑ due, ⧗ not-before).

**2. Shape cue.** The row's tier dot is 8px — too small for a label, and pure colour there makes the
theme cosmetic for exactly the person it's for. Under Clear only, the dot is **shape-coded** from
its `data-tier` attribute: important = circle, super = diamond, critical = triangle. Colour still
rides along, so the cue is triple-coded (hue + lightness + shape). The `data-tier` attribute is
unconditional (all themes) — an improvement in its own right, making the tier machine-readable in
the DOM rather than inferable only from a colour class.

### The honest limits — what Clear does *not* claim

- **The retint** widens the perceived gap, but a red-weak viewer may still find orange (super) and
  dark-red (critical) closer than someone with typical vision does. It helps; it doesn't guarantee.
- **The shape cue** is what carries the tier when colour fails — but it's on the small row dot, and
  shape recognition at that size has its own limits.
- **Neither claims to "solve" colour-blindness**, and this theme is **not** validated by a simulator.
  The acceptance test is a colour-blind person using it and reporting whether the tiers are genuinely
  tellable apart. If the answer is no, that's a finding to act on, not a number to argue with. Better
  this doc understates than overstates.

---

## Where the values live

All theme blocks are in `apps/web/src/index.css` — the base `:root` / `.dark` (Slate + all meaning
tokens), then `[data-theme='brand' | 'warm' | 'clear']`, each with a `.dark` companion, then Clear's
shape-cue rules. The `data-tier` attribute is set in `TaskRow.tsx`; the axes and persistence live in
`mode.ts` / `palette.ts`, applied pre-paint by the inline script in `index.html`.
