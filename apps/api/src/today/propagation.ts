import type { TaskTier } from '@rankati/shared';
import { daysUntil, urgencyMultiplier } from './scoring';

/**
 * Backward urgency propagation — the graph walk (ADR 0059).
 *
 * A deadline task pushes its urgency BACK to everything that (transitively) unblocks it, so the
 * actionable prerequisite at the end of a chain carries the deadline's weight. This computes, for
 * each task, the urgency it INHERITS and the ultimate deadline SOURCE driving it. It is the walk
 * only; a task's own urgency and the max(own, inherited) composition live in the read (0059).
 */

export interface PropagationTask {
  id: string;
  due: string | null;
  tier: TaskTier;
  /** The tasks this one is blocked by (0053). */
  dependsOn: string[];
}

export interface Inherited {
  /** The escalation multiplier inherited from the source deadline. */
  multiplier: number;
  /** The ULTIMATE deadline task driving it — not the immediate next link. */
  sourceId: string;
}

/**
 * Per-task inherited urgency. A task absent from the map inherits nothing that changes an outcome.
 *
 * TERMINATION rests on ADR 0053: cycles are refused at write time, so the graph is a DAG. The memo
 * is kept for EFFICIENCY (a diamond — two paths to one prerequisite — must be walked once, not
 * twice), and the `computing` guard makes any pathological cycle return early rather than loop —
 * insurance that is unreachable in normal operation, NOT a substitute for 0053's refusal.
 */
export function inheritedUrgency(tasks: PropagationTask[], on: string): Map<string, Inherited> {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // dependents[p] = the tasks that depend on p (p blocks them) — the reverse of dependsOn. Edges to
  // tasks not in this set (a done or absent prerequisite) are ignored: they are not conduits.
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const p of t.dependsOn) {
      if (!byId.has(p)) continue;
      const list = dependents.get(p);
      if (list) list.push(t.id);
      else dependents.set(p, [t.id]);
    }
  }

  /**
   * A task's own urgency AS A SOURCE — clamped at the d=0 peak, so an overdue source contributes
   * the 3× maximum rather than the unbounded raw multiplier (0059 (a)): nothing else ranks by HOW
   * overdue. Undated → 1 (no deadline to lend).
   */
  const sourceUrgency = (t: PropagationTask): number =>
    t.due === null ? 1 : urgencyMultiplier(Math.max(0, daysUntil(t.due, on)), t.tier);

  const memo = new Map<string, Inherited | null>();
  const computing = new Set<string>();

  const inh = (id: string): Inherited | null => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (computing.has(id)) return null; // cycle — impossible by 0053; insurance only (see spec)
    computing.add(id);

    let best: Inherited | null = null;
    for (const depId of dependents.get(id) ?? []) {
      const dep = byId.get(depId)!;
      // Two candidates from each dependent: its OWN source urgency (attributed to it), and what IT
      // inherited (which already carries the ULTIMATE source, not this intermediate link).
      const own: Inherited = { multiplier: sourceUrgency(dep), sourceId: dep.id };
      const passed = inh(depId);
      for (const c of [own, passed]) {
        if (c !== null && (best === null || c.multiplier > best.multiplier)) best = c;
      }
    }

    computing.delete(id);
    memo.set(id, best);
    return best;
  };

  const result = new Map<string, Inherited>();
  for (const t of tasks) {
    const got = inh(t.id);
    // A multiplier of 1 is the baseline (an undated source, no real deadline) and changes no
    // ordering; only meaningful inheritance is recorded.
    if (got !== null && got.multiplier > 1) result.set(t.id, got);
  }
  return result;
}
