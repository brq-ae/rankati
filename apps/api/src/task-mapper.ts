import type { Task as TaskDto } from '@rankati/shared';
import type { Task } from './generated/prisma/client';

/**
 * A task WITH its relation links loaded — dependencies (ADR 0053) and locations (ADR 0060).
 *
 * The relations are required by the TYPE, not by convention, and that is the whole point. If
 * `toTaskDto` took a bare Task and read `blockedBy` / `locations` optionally, any query that
 * forgot the include would quietly produce `dependsOn: []` / `locationIds: []` — rendering a
 * BLOCKED task as unblocked, in Today, with nothing to see, or a Garage-only task as doable
 * everywhere. Requiring them here turns that runtime corruption into a compile error: the
 * compiler walks you to every call site.
 *
 * Same principle as refusing cycles at write time, applied at the type layer — make the
 * wrong state unrepresentable rather than merely unlikely.
 */
export type TaskWithRelations = Task & {
  blockedBy: { dependsOnId: string }[];
  locations: { locationId: string }[];
  checklist: { id: string; taskId: string; text: string; done: boolean; position: number; createdAt: Date }[];
};

/** What every query must select to satisfy the type above. */
export const TASK_INCLUDE = {
  blockedBy: { select: { dependsOnId: true } },
  locations: { select: { locationId: true } },
  // Readiness checklist (ADR 0071) — ordered by position, the display order.
  checklist: { orderBy: { position: 'asc' } },
} as const;

/**
 * Maps a stored row to the wire contract (@rankati/shared).
 *
 * Lives in its own module rather than beside TasksService because the Arena needs it too,
 * and TasksService needs the Arena — importing it from there would make a cycle. A mapper
 * has no dependencies, so it is the natural thing to pull out.
 *
 * The conversions are the point: Prisma hands back Date and Decimal objects, but the
 * contract says `string` and `number`, and JSON has neither type. Doing it explicitly here
 * makes the mismatch impossible rather than merely unlikely.
 */
export function toTaskDto(task: TaskWithRelations): TaskDto {
  return {
    id: task.id,
    title: task.title,
    listId: task.listId,
    ownerId: task.ownerId,
    status: task.status,
    createdAt: task.createdAt.toISOString(),
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    // Storage is Decimal so a replay years from now reproduces today's ratings
    // (ADRs 0047, 0048); the wire stays a plain number.
    rating: task.rating.toNumber(),
    // .slice(0, 10), NOT .toISOString(): notBefore is a calendar DAY (0052). Sending
    // '2026-07-20T00:00:00.000Z' would let a client west of UTC parse it back as the 19th
    // and judge the gate a day early — at exactly the boundary the gate exists to police.
    // The column is @db.Date and the driver anchors it at UTC midnight, which is the only
    // reason this slice is correct; not-before-storage.spec.ts asserts that anchor across
    // four timezones rather than trusting it.
    notBefore: task.notBefore ? task.notBefore.toISOString().slice(0, 10) : null,
    // due is a calendar DAY, exactly like notBefore (ADR 0056): .slice(0, 10), NEVER a full
    // .toISOString(). A deadline sent as '2026-07-20T00:00:00.000Z' would parse back to the
    // 19th west of UTC — the same day-early trap the not-before gate exists to avoid, and the
    // future urgency ramp would inherit it. The @db.Date column anchors at UTC midnight, which
    // is what makes this slice correct; the mapper test asserts it across timezones.
    due: task.due ? task.due.toISOString().slice(0, 10) : null,
    // A plain enum string or null (ADR 0070) — no conversion, like tier. NULL = Anytime =
    // ungated. Carried on every read from this slice on; the gate clause is the next slice.
    availabilityWindow: task.availabilityWindow,
    effort: task.effort,
    // The declared impact level (ADR 0075) — a plain enum, no conversion. Drives the client-side pin
    // only, never ranking; carried on every read so the client can compute it.
    impact: task.impact,
    // A plain enum string — declared, not earned (ADR 0056). No conversion: unlike Date and
    // Decimal, the wire type and the stored type are the same.
    tier: task.tier,
    // Ids only: whoever renders these holds every task already (0053).
    dependsOn: task.blockedBy.map((link) => link.dependsOnId),
    // Ids only, like dependsOn (0060): the client holds every Location and resolves names.
    // Empty = doable anywhere. The server never filters a read by these — the header filter
    // is client-side (0060), so this always carries the task's full location set.
    locationIds: task.locations.map((link) => link.locationId),
    // A plain boolean, soft marker, never a gate (ADR 0071) — no conversion, like tier.
    needsHand: task.needsHand,
    // The "needs details" flag (ADR 0073) — a plain boolean soft marker, never a gate. Carried on
    // every read from this slice on; the set-on-create/clear-on-edit lifecycle is the next slice.
    needsDetails: task.needsDetails,
    // Readiness checklist (ADR 0071), already ordered by position via TASK_INCLUDE. Same
    // Date -> ISO conversion as createdAt above; inert storage, never gates.
    checklist: task.checklist.map((item) => ({
      id: item.id,
      taskId: item.taskId,
      text: item.text,
      done: item.done,
      position: item.position,
      createdAt: item.createdAt.toISOString(),
    })),
  };
}
