/**
 * OptimalPolicy — the exploration policy `pi_1`.
 *
 * This is the paper's controlled baseline ("parallel refining"): several independent directions are
 * opened in parallel and every direction repeatedly refines its own frontier using the history
 * accumulated in that direction. The dreaming phase rewrites exactly this file, so it is written to be
 * a *good starting point* rather than a tuned one.
 *
 * Prefix signals (all from `question.observed()`, never from unrevealed data):
 *   - successful anchor   — best score from a successful evaluation in the branch
 *   - parent -> child gain — `delta_vs_parent` of the branch frontier
 *   - failure/repair tail  — consecutive unsuccessful evaluations at the frontier
 *   - explored depth       — `attempt`, and the grid's remaining refinement budget
 *
 * Batch rule (one dynamic portfolio per round, never a fixed widen-all/deepen-all wave):
 *   exploration roots first (bounded share), then at most ONE recovery of a repairable failure, then
 *   the strongest normal refinements from distinct branches, filling up to `max_parallelism`.
 *
 * Beta schedule: one scalar, read once, routed through `_schedule`. High beta = wider, more patient,
 * weaker pruning. Beta never changes inside `solve()`, and no threshold is an absolute score cutoff.
 *
 * Default beta: 0.6 — moderately exploratory, the paper's prescribed default when the live/beta
 * evidence is insufficient or conflicting.
 *
 * Grid planning: widen while live directions are still improving; on a plateau, hold or reduce width
 * and spend the budget going deeper on the surviving directions.
 *
 * Safeguards: a single failure never closes a direction; a repairable failure keeps eligibility and
 * gets at most one recovery slot per round; a branch with a successful anchor is never starved; and
 * batches prefer distinct branches so probes always run in parallel.
 */

import {
  LLMDesignedMethod,
  newSimResult,
  _budget_done,
  _record_curve,
  finalize_result,
  type Budget,
  type EpisodeResult,
  type GridPlan,
  type GridPlanningContext,
  type QuestionView,
  type Schedule,
} from "./api.ts";
import {
  branch_best_for,
  branch_observations,
  branch_stale_for,
  probe_improved_vs_baseline,
  probe_improved_vs_parent,
  probe_succeeded,
  type Prefix,
} from "./observation-signal.ts";

export const NAME = "OptimalPolicy";

// EVOLVE-BLOCK-START — the exploration policy the dreaming phase rewrites.
export class OptimalPolicy extends LLMDesignedMethod {
  /** Baked in for the next live episode; the dreaming phase adjusts this with the cross-cycle rule. */
  default_beta = 0.6;

  _schedule(beta: number): Schedule {
    return LLMDesignedMethod.schedule(beta);
  }

  plan_grid(context: GridPlanningContext): GridPlan {
    const maxWidth = Math.max(1, context.max_parallelism);
    const budgetAttempts = context.budget?.attempts ?? maxWidth * 6;
    const depthFor = (width: number): number => Math.max(1, Math.floor(budgetAttempts / width));

    if (context.history.length === 0) {
      return {
        branch_count: maxWidth,
        refine_count: Math.min(8, depthFor(maxWidth)),
        reason: "no live history: open one direction per worker and refine each to the round budget",
      };
    }

    const scored = context.history.filter((h) => typeof h.best_score === "number") as {
      iteration: number;
      best_score: number;
      baked_beta: number | null;
    }[];
    const latest = scored[scored.length - 1];
    const previous = scored[scored.length - 2];
    // Insufficient history is not a plateau: bootstrap full width rather than pretending to see a trend.
    if (!latest || !previous) {
      return {
        branch_count: maxWidth,
        refine_count: Math.min(8, depthFor(maxWidth)),
        reason: "fewer than two scored live cycles: bootstrap full width",
      };
    }
    const improving = latest.best_score > previous.best_score;

    if (improving) {
      return {
        branch_count: maxWidth,
        refine_count: Math.min(10, depthFor(maxWidth)),
        reason: `live best still improving (${previous.best_score} -> ${latest.best_score}): keep full width`,
      };
    }

    const width = Math.max(1, Math.round(maxWidth / 2));
    return {
      branch_count: width,
      refine_count: Math.min(12, depthFor(width)),
      reason: `live best plateaued at ${latest.best_score}: narrow to ${width} directions and refine the survivors deeper`,
    };
  }

  async solve(question: QuestionView, budget?: Budget | null): Promise<EpisodeResult> {
    question.reset();
    const res = newSimResult();
    const schedule = this._schedule(this.beta);

    while (!_budget_done(question, budget)) {
      const prefix = question.observed();
      const closed = closedBranches(prefix, schedule);
      const batch = selectBatch(prefix, question, closed, schedule);
      if (batch.length === 0) {
        res.stopped = "no legal action left";
        break;
      }
      await question.probe_batch(batch, () => _record_curve(res, question));
    }

    if (!res.stopped) res.stopped = _budget_done(question, budget) ? "budget" : "exhausted";
    return finalize_result(question, res);
  }
}
// EVOLVE-BLOCK-END

/**
 * Cumulative-evidence closure, rebuilt every round (so a later success reopens a branch).
 * One failure is never enough, and a branch holding a successful anchor is never closed.
 */
export function closedBranches(prefix: Prefix, schedule: Schedule): Set<number> {
  const closed = new Set<number>();
  const branches = new Set(Object.values(prefix).map((o) => o.branch));
  for (const branch of branches) {
    const cells = branch_observations(prefix, branch);
    if (cells.length === 0) continue;
    // A successful anchor — historical or current — protects the direction from closure.
    if (branch_best_for(prefix, branch) !== null) continue;
    const stale = branch_stale_for(prefix, branch);
    const attempted = cells.filter((o) => o.evaluated).length;
    // Two independent signals must agree before a direction is abandoned.
    if (stale >= schedule.prune_after_consecutive_failures && attempted >= schedule.prune_after_consecutive_failures) {
      closed.add(branch);
    }
  }
  return closed;
}

interface RankedFrontier {
  cell: string;
  branch: number;
  gain: number;
  improved: boolean;
  stale: number;
  attempt: number;
  repairable: boolean;
}

function rankFrontiers(prefix: Prefix, question: QuestionView, closed: Set<number>): RankedFrontier[] {
  const roots = new Set(question.legal_roots());
  const ranked: RankedFrontier[] = [];
  for (const cell of question.legal_actions()) {
    if (roots.has(cell)) continue;
    const meta = question.meta(cell);
    if (closed.has(meta.branch)) continue;
    const observation = prefix[cell];
    if (!observation) continue;
    ranked.push({
      cell,
      branch: meta.branch,
      gain: observation.delta_vs_parent ?? 0,
      improved: probe_improved_vs_parent(observation),
      stale: branch_stale_for(prefix, meta.branch),
      attempt: meta.attempt,
      repairable: observation.evaluated && !probe_succeeded(observation),
    });
  }
  // Deterministic priority: improved first, then gain, then fewer consecutive failures, then depth,
  // then branch id — never a clock, a random tie-break, or an absolute score threshold.
  return ranked.sort(
    (a, b) =>
      Number(b.improved) - Number(a.improved) ||
      b.gain - a.gain ||
      a.stale - b.stale ||
      b.attempt - a.attempt ||
      a.branch - b.branch,
  );
}

/** One dynamic portfolio batch: bounded exploration, at most one recovery, then exploitation. */
export function selectBatch(
  prefix: Prefix,
  question: QuestionView,
  closed: Set<number>,
  schedule: Schedule,
): string[] {
  const width = Math.max(1, question.max_parallelism);
  const batch: string[] = [];
  const roots = question.legal_roots().filter((cell) => {
    const meta = question.meta(cell);
    return meta.branch < 0 || !closed.has(meta.branch);
  });
  const explorationQuota = Math.max(1, Math.round(width * schedule.open_root_bias));
  for (const root of roots.slice(0, Math.min(explorationQuota, width))) batch.push(root);

  const ranked = rankFrontiers(prefix, question, closed);
  const recovery = ranked.find((r) => r.repairable);
  if (recovery && batch.length < width) batch.push(recovery.cell);

  for (const candidate of ranked) {
    if (batch.length >= width) break;
    if (batch.includes(candidate.cell)) continue;
    batch.push(candidate.cell);
  }

  // Never leave a slot idle when untouched directions are still available.
  for (const root of roots) {
    if (batch.length >= width) break;
    if (!batch.includes(root)) batch.push(root);
  }
  return batch.slice(0, width);
}

/** Kept for the improvement phase: does the prefix show any direction beating the baseline? */
export function anyImprovement(prefix: Prefix): boolean {
  return Object.values(prefix).some((o) => probe_improved_vs_baseline(o));
}
