import type { TaskTier } from '@rankati/shared';

/**
 * The tier heat gradient (ADR 0056) — the ONE runtime source for a tier's colour and word.
 *
 * It lives here, not in @rankati/shared, because that package is types-only (ADR 0041): the enum's
 * type crosses the wire, its presentation does not. Both the detail view's picker and the row's
 * display read this same list, so the colour a tier shows can never drift between the two.
 *
 * Colour is never the ONLY signal: the picker carries the word in its aria-label and shows the
 * selected word, and the row pairs the dot with the due glyph. Ordered coolest → hottest, which
 * is also the order the swatches render.
 */
export interface TierChoice {
  value: TaskTier;
  /** The word shown to a person — Title Case, distinct from the snake_case stored value. */
  label: string;
  /** A filled swatch, for the picker buttons. */
  swatch: string;
  /** A foreground tint, for the row's tier dot and the due glyph. */
  accent: string;
}

export const TIERS: readonly TierChoice[] = [
  {
    value: 'normal',
    label: 'Normal',
    swatch: 'bg-tier-normal',
    accent: 'text-tier-normal-accent',
  },
  { value: 'important', label: 'Important', swatch: 'bg-tier-important', accent: 'text-tier-important-accent' },
  {
    value: 'super_important',
    label: 'Super Important',
    swatch: 'bg-tier-super',
    accent: 'text-tier-super-accent',
  },
  {
    value: 'critical',
    label: 'Critical',
    swatch: 'bg-tier-critical',
    accent: 'text-tier-critical-accent',
  },
];

/** normal is always TIERS[0] — the baseline, and the safe fallback for an unknown value. */
const NORMAL: TierChoice = TIERS[0]!;

/** The choice for a stored tier value. Falls back to normal — the baseline — for safety. */
export const tierOf = (value: TaskTier): TierChoice =>
  TIERS.find((t) => t.value === value) ?? NORMAL;
