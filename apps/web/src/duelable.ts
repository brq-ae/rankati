import type { MinPool, Task } from '@rankati/shared';

/**
 * The pool floor, duplicated from the server's by necessity — `@rankati/shared` is types-only
 * (0041), so the runtime `2` can't live there. The shared `MinPool` type pins it to 2 at compile
 * time; the agreement tests pin the behaviour. The server's copy is in
 * `apps/api/src/arena/arena-session.service.ts` — change one, change the other.
 */
export const MIN_POOL: MinPool = 2;

/**
 * Can this list be dueled? Mirrors the server's `eligibleWhere` EXACTLY (0003): count the list's
 * ACTIVE tasks — and nothing else.
 *
 *   - GATE-AGNOSTIC: a blocked or date-gated task is still `active`, and the Arena ranks
 *     importance, which is independent of the playability gates (0052, 0053). The server's
 *     `eligibleWhere` applies no gate filter, and neither does this.
 *   - LOCATION-AGNOSTIC: the location filter is client-side presentation (0060); the Arena pool
 *     never sees it. So the caller MUST pass the FULL, unfiltered owner task set
 *     (`getRankedTasks`), NOT the location-filtered view — passing the filtered set would disable
 *     VS on a list the server would still duel.
 *
 * Both properties are pinned by the agreement tests (see `apps/web/test/duelable.spec.ts` and the
 * server-side `apps/api/test/duelable-agreement.spec.ts`).
 */
export function isListDuelable(
  tasks: readonly Pick<Task, 'listId' | 'status'>[],
  listId: string,
): boolean {
  return tasks.filter((t) => t.listId === listId && t.status === 'active').length >= MIN_POOL;
}
