/**
 * Deterministic prefix signals (`see.policy.observation_signal` in the paper's Listing 2).
 *
 * These are pure functions of revealed observations — no hidden state, no clocks, no randomness —
 * so a policy's decisions stay reproducible and prefix-only. They are evidence, never verdicts:
 * a repairable failure must not close a branch on its own (paper Appendix B).
 */

import type { CellId } from "./api.ts";
import type { Observation } from "../engine/tree.ts";

export type Prefix = Record<CellId, Observation>;

export interface SignalContext {
  baseline_score: number | null;
}

/** Revealed attempts in the same branch up to and including `cell`'s attempt. */
export function branch_cells(prefix: Prefix, cell: CellId): Observation[] {
  const self = prefix[cell];
  if (!self) return [];
  return branch_observations(prefix, self.branch).filter((o) => o.attempt <= self.attempt);
}

/** Every revealed attempt of one branch, ordered by refinement depth. */
export function branch_observations(prefix: Prefix, branch: number): Observation[] {
  return Object.values(prefix)
    .filter((o) => o.branch === branch)
    .sort((a, b) => a.attempt - b.attempt);
}

/** Best successful score in a branch. */
export function branch_best_for(prefix: Prefix, branch: number): number | null {
  let best: number | null = null;
  for (const o of branch_observations(prefix, branch)) {
    if (!probe_succeeded(o) || typeof o.score !== "number") continue;
    if (best === null || o.score > best) best = o.score;
  }
  return best;
}

/** Consecutive unsuccessful evaluations at the tail of a branch. */
export function branch_stale_for(prefix: Prefix, branch: number): number {
  const cells = branch_observations(prefix, branch);
  let count = 0;
  for (let i = cells.length - 1; i >= 0; i -= 1) {
    if (probe_succeeded(cells[i])) break;
    count += 1;
  }
  return count;
}

/** Best score in the branch from successful evaluations, or null when none succeeded yet. */
export function branch_best(prefix: Prefix, cell: CellId): number | null {
  let best: number | null = null;
  for (const o of branch_cells(prefix, cell)) {
    if (!probe_succeeded(o)) continue;
    if (typeof o.score === "number" && (best === null || o.score > best)) best = o.score;
  }
  return best;
}

/** Frontier gain over its parent (or over the baseline for a branch root). */
export function branch_gain(prefix: Prefix, cell: CellId): number | null {
  const self = prefix[cell];
  if (!self) return null;
  return self.delta_vs_parent;
}

/** Branch is trending up: its frontier evaluated successfully and beats the baseline. */
export function branch_promising(prefix: Prefix, cell: CellId, ctx: SignalContext): boolean {
  const self = prefix[cell];
  if (!self || !probe_succeeded(self) || typeof self.score !== "number") return false;
  const floor = typeof ctx.baseline_score === "number" ? ctx.baseline_score : null;
  if (floor === null) return true;
  return self.score > floor;
}

/** Paper Appendix B success semantics: evaluated with no error and `fail_class == "ok"`. */
export function probe_succeeded(o: Observation | null | undefined): boolean {
  return !!o && o.evaluated === true && o.error === null && o.fail_class === "ok";
}

/** `probe_improved_vs_parent` — this observation scored better than the attempt it refined. */
export function probe_improved_vs_parent(o: Observation | null | undefined): boolean {
  return probe_succeeded(o) && typeof o?.delta_vs_parent === "number" && o.delta_vs_parent > 0;
}

/** `probe_improved_vs_baseline` — this observation scored better than the initial workspace state. */
export function probe_improved_vs_baseline(o: Observation | null | undefined): boolean {
  return probe_succeeded(o) && typeof o?.delta_vs_baseline === "number" && o.delta_vs_baseline > 0;
}

/**
 * Consecutive invalid attempts at the tail of the branch, including the frontier.
 * `>= threshold` is hard evidence, not an automatic closure: another attempt may still repair it.
 */
export function branch_stale(prefix: Prefix, cell: CellId): number {
  const cells = branch_cells(prefix, cell);
  let count = 0;
  for (let i = cells.length - 1; i >= 0; i -= 1) {
    if (probe_succeeded(cells[i])) break;
    count += 1;
  }
  return count;
}

/** Branch has produced no valid attempt and shows repeated failures. */
export function branch_failed_hard(prefix: Prefix, cell: CellId, ctx: SignalContext, threshold = 2): boolean {
  if (branch_best(prefix, cell) !== null) return false;
  if (branch_stale(prefix, cell) < threshold) return false;
  const self = prefix[cell];
  const floor = ctx.baseline_score;
  if (typeof floor === "number" && self && typeof self.score === "number" && self.score > floor) return false;
  return true;
}

/** Branch indices with at least one revealed attempt but no successful evaluation. */
export function underexplored_branches(prefix: Prefix): number[] {
  const branches = new Map<number, boolean>();
  for (const o of Object.values(prefix)) {
    const ok = branches.get(o.branch) ?? false;
    branches.set(o.branch, ok || probe_succeeded(o));
  }
  return [...branches.entries()].filter(([, ok]) => !ok).map(([branch]) => branch).sort((a, b) => a - b);
}

/**
 * Failed frontiers whose failure is local/recoverable (`agent_error`, `eval_error`, `timeout`, …).
 * A local implementation failure does not prove the parent direction is poor — these stay eligible
 * for recovery rather than being closed automatically.
 */
export function repairable_failures(prefix: Prefix): CellId[] {
  return Object.entries(prefix)
    .filter(([, o]) => o.evaluated && !probe_succeeded(o) && o.fail_class !== "no_proposal")
    .map(([id]) => id);
}
