import type { TaskTier } from '@rankati/shared';

/**
 * The canonical fresh state — the SINGLE definition of what a brand-new Rankati looks like (ADRs 0064,
 * 0065). Consumed by BOTH the `--wipe` CLI (`seed.ts`) and the reset endpoint's `ResetService`, so a
 * fresh install and a factory reset land in identical states.
 *
 * v0.14 (ADR 0065): a realistic UAE/GCC set that EXERCISES every capability — locations (single,
 * multi, none), all four tiers, deadlines, a not-before, four dependency chains, and one completed
 * task — so a fresh install demonstrates the engine rather than listing words. Two decisions here are
 * PROTECTED against well-meaning "fixes" (see ADR 0065):
 *   - **Nothing is pre-dueled.** Every task starts at rating 1000 (the schema default). The flatness
 *     is the point — the first duel is where the order becomes yours. Do NOT seed ratings.
 *   - **The tap chain has no deadline, on purpose.** It teaches that a dependency gates without any
 *     deadline involved; the other three chains teach inherited urgency. Do NOT give the tap a `due`.
 *
 * `DEFAULT_LOCATIONS` is duplicated by the `location_gate` migration's SQL seed; the drift-guard test
 * (`fresh-state-drift.spec.ts`) reddens if they diverge (0064).
 */

/** The starting location set (ADR 0060). A factory reset restores exactly these; the migration seeds them. */
export const DEFAULT_LOCATIONS = ['Home', 'Office/Work', 'Garage', 'Shop/Mall'] as const;

/** The five sample lists. "Business" is deliberately NOT "Work" — an Office/Work LOCATION exists (0065). */
export const SAMPLE_LISTS = ['Home', 'Car', 'Government', 'Groceries', 'Business'] as const;

/**
 * A sample task, defined by RELATIVE offsets (ADR 0065). `dueInDays`/`notBeforeInDays` are resolved
 * to absolute calendar days at seed time by {@link buildFreshState}, so the seed is dynamic every run.
 * `locations` and `requires` are references resolved by NAME/TITLE at insert time, and an unknown
 * reference throws (fail-loud, `seedFreshState`). `completedDaysAgo` present ⇒ the task is done.
 */
interface SampleTask {
  readonly title: string;
  readonly list: (typeof SAMPLE_LISTS)[number];
  readonly locations?: readonly string[];
  readonly dueInDays?: number;
  readonly notBeforeInDays?: number;
  readonly tier?: TaskTier;
  readonly requires?: string;
  readonly completedDaysAgo?: number;
}

const SAMPLE_TASKS: readonly SampleTask[] = [
  // HOME
  { title: 'Change AC filter', list: 'Home', locations: ['Home'] },
  { title: "Reply to landlord's WhatsApp", list: 'Home' }, // no location — shows in every context
  { title: 'Renew Ejari', list: 'Home', notBeforeInDays: 14, dueInDays: 42, tier: 'important' },
  { title: 'Buy laundry detergent', list: 'Home', locations: ['Shop/Mall'], tier: 'normal' },
  { title: 'Fix the kitchen tap', list: 'Home', locations: ['Home'], requires: 'Buy plumbing parts' },
  { title: 'Buy plumbing parts', list: 'Home', locations: ['Shop/Mall', 'Garage'] }, // multi-location

  // CAR
  { title: 'Get the car serviced', list: 'Car', locations: ['Garage'], dueInDays: 10 }, // +10d: reaches Upcoming ≥5 (0065)
  { title: 'Renew Salik top-up', list: 'Car', dueInDays: 5 },
  { title: 'Register the car', list: 'Car', dueInDays: 12, requires: 'Pass vehicle inspection' },
  { title: 'Pass vehicle inspection', list: 'Car', locations: ['Garage'] },
  { title: 'Renew car insurance', list: 'Car', completedDaysAgo: 2 }, // the done state

  // GOVERNMENT
  { title: 'Renew Emirates ID', list: 'Government', dueInDays: 10, tier: 'critical' },
  { title: 'Renew trade licence', list: 'Government', dueInDays: 21, tier: 'super_important' },
  { title: 'Renew visa', list: 'Government', dueInDays: 8, requires: 'Do medical fitness test' },
  { title: 'Do medical fitness test', list: 'Government' }, // no gates — actionable now
  { title: 'Get MOFA attestation', list: 'Government', dueInDays: 10, notBeforeInDays: 7, requires: 'Collect original documents' }, // both gates
  { title: 'Collect original documents', list: 'Government', locations: ['Office/Work'] },
  { title: 'Submit VAT return', list: 'Government', dueInDays: 28, tier: 'important' },

  // GROCERIES
  { title: 'Buy milk', list: 'Groceries', locations: ['Shop/Mall'] },
  { title: 'Buy eggs', list: 'Groceries', locations: ['Shop/Mall'] },
  { title: 'Collect dry cleaning', list: 'Groceries', locations: ['Shop/Mall'] },

  // BUSINESS
  { title: 'Sign the tenancy contract', list: 'Business', locations: ['Office/Work'], dueInDays: 14 },
  { title: 'Prepare the quarterly deck', list: 'Business', tier: 'important' },
  { title: 'Call the accountant', list: 'Business' }, // no location
];

/** A resolved sample task — offsets turned into absolute dates, ready to seed. */
export interface ResolvedTask {
  readonly title: string;
  readonly list: string;
  readonly locations: readonly string[];
  readonly due: Date | null;
  readonly notBefore: Date | null;
  readonly tier: TaskTier;
  readonly requires: string | null;
  readonly status: 'active' | 'done';
  readonly completedAt: Date | null;
}

export interface FreshState {
  readonly locations: readonly string[];
  readonly lists: readonly string[];
  readonly tasks: readonly ResolvedTask[];
}

/** UTC midnight of `now` + `days` — a plain calendar day for a `@db.Date` column (the 0052 discipline). */
function dayFromNow(now: Date, days: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
}

/**
 * Resolve the sample set against a moment in time (ADR 0065). `now` defaults to the real current time
 * and PRODUCTION always uses that default: the reset endpoint and the `--wipe` CLI never pass `now`.
 * The ONLY caller that passes a fixed `now` is the fresh==factory fingerprint proof, which needs two
 * seeds to produce identical absolute dates — a test seam, named as one, never a production path.
 */
export function buildFreshState(now: Date = new Date()): FreshState {
  const tasks: ResolvedTask[] = SAMPLE_TASKS.map((t) => ({
    title: t.title,
    list: t.list,
    locations: t.locations ?? [],
    due: t.dueInDays === undefined ? null : dayFromNow(now, t.dueInDays),
    notBefore: t.notBeforeInDays === undefined ? null : dayFromNow(now, t.notBeforeInDays),
    tier: t.tier ?? 'normal',
    requires: t.requires ?? null,
    status: t.completedDaysAgo === undefined ? 'active' : 'done',
    completedAt: t.completedDaysAgo === undefined ? null : dayFromNow(now, -t.completedDaysAgo),
  }));
  return { locations: DEFAULT_LOCATIONS, lists: SAMPLE_LISTS, tasks };
}
