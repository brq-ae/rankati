import type { ResetMode } from '@rankati/shared';
import { DEFAULT_LOCATIONS, buildFreshState, type FreshState } from './fresh-state';
import type { PrismaClient } from './generated/prisma/client';

/** The interactive-transaction handle `resetOwner` passes to the seeder — a PrismaClient without `$transaction`. */
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export interface ResetOptions {
  /** Factory mode only. Defaults to true. Governs the sample lists/tasks, never the locations. */
  keepSampleData?: boolean;
  /**
   * TEST-ONLY (ADR 0065). The fresh==factory fingerprint proof pins `now` so two seeds produce
   * identical absolute dates. The reset endpoint and the `--wipe` CLI NEVER set this — production
   * always seeds against the real current time. A test seam, named as one, never a production path.
   */
  now?: Date;
}

export interface ResetSummary {
  mode: ResetMode;
  deleted: { duels: number; tasks: number; lists: number; locations: number; routines: number };
  seeded: { locations: number; lists: number; tasks: number };
}

/**
 * The ONE destructive wipe (ADR 0064), owner-scoped and atomic. Called by BOTH the reset endpoint
 * (`ResetService`) and the `--wipe` CLI (`seed.ts`) — never a second implementation, so the sample
 * data cannot be redesigned in one path and left stale in the other.
 *
 * ATOMIC: everything runs in a SINGLE `$transaction`. All deletes and the reseed commit together or
 * not at all — a throw anywhere rolls the whole thing back, so a half-reset (tasks gone but lists
 * not reseeded, locations half-replaced) cannot exist. This is 0061's merge pattern applied whole.
 *
 * OWNER SCOPING is the safety boundary, and this is the milestone's most load-bearing invariant.
 * Every DIRECT delete filters by `ownerId`. The two ownerless join tables — `TaskDependency` and
 * `TaskLocation` (0053/0060: "reached only THROUGH a task") — carry no `ownerId` to filter on and
 * are removed TRANSITIVELY by the owner-scoped `task` delete's `onDelete: Cascade`. Their scope is
 * structural, not a filter, which is sufficient precisely because the cascade only fires for the
 * tasks this owner-scoped delete removes. Proven, dangerous-direction-sabotaged, in
 * `reset-owner-boundary.spec.ts`.
 *
 * The caller supplies the owner. The HTTP endpoint passes the single local owner; a test passes a
 * throwaway owner — which is the whole reason no test ever needs to target `local` (ADR 0064).
 */
export async function resetOwner(
  prisma: PrismaClient,
  ownerId: string,
  mode: ResetMode,
  opts: ResetOptions = {},
): Promise<ResetSummary> {
  const keepSampleData = opts.keepSampleData ?? true;

  return prisma.$transaction(async (tx) => {
    // Duels first and explicitly, though the task cascade would take them: relying on a cascade to
    // delete the thing you are explicitly clearing hides what this does (the seed.ts reasoning).
    const duels = await tx.duel.deleteMany({ where: { ownerId } });
    // Deleting tasks cascades TaskDependency (both directions) and TaskLocation (the tags): the
    // ownerless join rows go here, transitively, scoped by this owner-scoped parent.
    const tasks = await tx.task.deleteMany({ where: { ownerId } });

    let listsDeleted = 0;
    let locationsDeleted = 0;
    let routinesDeleted = 0;
    let seededLocations = 0;
    let seededLists = 0;
    let seededTasks = 0;

    if (mode === 'factory') {
      const lists = await tx.list.deleteMany({ where: { ownerId } });
      const locations = await tx.location.deleteMany({ where: { ownerId } });
      // Routines are removed on FACTORY only — a fresh install has none. Clear-tasks leaves them:
      // they are not task-derived (ADR 0066). Owner-scoped, so another owner's routines are untouched.
      const routines = await tx.routine.deleteMany({ where: { ownerId } });
      listsDeleted = lists.count;
      locationsDeleted = locations.count;
      routinesDeleted = routines.count;

      if (keepSampleData) {
        // The full sample set — locations, lists, tasks, tags and dependencies (ADR 0065). `now`
        // resolves the relative dates; undefined here means the real current time (production).
        const seeded = await seedFreshState(tx, ownerId, buildFreshState(opts.now));
        seededLocations = seeded.locations;
        seededLists = seeded.lists;
        seededTasks = seeded.tasks;
      } else {
        // No sample data — but the four default locations are structure, always restored (ADR 0064).
        await tx.location.createMany({ data: DEFAULT_LOCATIONS.map((name) => ({ name, ownerId })) });
        seededLocations = DEFAULT_LOCATIONS.length;
      }
    }

    return {
      mode,
      deleted: {
        duels: duels.count,
        tasks: tasks.count,
        lists: listsDeleted,
        locations: locationsDeleted,
        routines: routinesDeleted,
      },
      seeded: { locations: seededLocations, lists: seededLists, tasks: seededTasks },
    };
  });
}

/**
 * Seed a resolved fresh state (ADR 0065). Runs INSIDE `resetOwner`'s transaction, so any throw here
 * rolls the whole reset back — a half-seeded set cannot result.
 *
 * FAIL-LOUD on unresolved references. Locations are resolved by NAME and dependencies by TITLE, and a
 * miss THROWS rather than silently skipping — otherwise a typo yields an untagged task or an
 * unlinked chain, the seed reports success, and the sample quietly demonstrates nothing (which is
 * exactly what a demo set must never do). Exported so the fail-loud guard can be tested directly with
 * a deliberately-bad state.
 */
export async function seedFreshState(
  tx: Tx,
  ownerId: string,
  state: FreshState,
): Promise<{ locations: number; lists: number; tasks: number }> {
  const locationIdByName = new Map<string, string>();
  for (const name of state.locations) {
    const loc = await tx.location.create({ data: { name, ownerId } });
    locationIdByName.set(name, loc.id);
  }

  const listIdByName = new Map<string, string>();
  for (const name of state.lists) {
    const list = await tx.list.create({ data: { name, ownerId } });
    listIdByName.set(name, list.id);
  }

  const taskIdByTitle = new Map<string, string>();
  for (const t of state.tasks) {
    const listId = listIdByName.get(t.list);
    if (!listId) throw new Error(`sample task "${t.title}" references unknown list "${t.list}"`);
    const task = await tx.task.create({
      // rating and duelCount are NOT set — they take the schema defaults (1000, 0). Nothing is
      // pre-dueled (ADR 0065); do not seed ratings here.
      data: {
        title: t.title,
        listId,
        ownerId,
        tier: t.tier,
        due: t.due,
        notBefore: t.notBefore,
        status: t.status,
        completedAt: t.completedAt,
      },
    });
    taskIdByTitle.set(t.title, task.id);
  }

  // Location TAGS — fail loud on an unknown location name.
  for (const t of state.tasks) {
    for (const name of t.locations) {
      const locationId = locationIdByName.get(name);
      if (!locationId) throw new Error(`sample task "${t.title}" references unknown location "${name}"`);
      await tx.taskLocation.create({ data: { taskId: taskIdByTitle.get(t.title)!, locationId } });
    }
  }

  // Dependency LINKS — fail loud on an unknown prerequisite title.
  for (const t of state.tasks) {
    if (t.requires === null) continue;
    const dependsOnId = taskIdByTitle.get(t.requires);
    if (!dependsOnId) throw new Error(`sample task "${t.title}" requires unknown task "${t.requires}"`);
    await tx.taskDependency.create({ data: { taskId: taskIdByTitle.get(t.title)!, dependsOnId } });
  }

  return { locations: state.locations.length, lists: state.lists.length, tasks: state.tasks.length };
}
