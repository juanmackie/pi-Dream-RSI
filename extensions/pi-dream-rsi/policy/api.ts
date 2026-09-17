/**
 * The exploration-policy contract (paper arXiv 2609.14858, Appendix B).
 *
 * A policy is *executable code*, not a prompt: the policy-improvement phase rewrites the module that
 * exports `OptimalPolicy`. Everything a policy may observe is prefix-only — revealed observations,
 * baseline score, legal sets, structural `meta`, and the deterministic helper signals in
 * `observation-signal.ts`. Unrevealed scores, true optima, hardcoded winning cell ids, absolute score
 * targets and internal trace data are off limits.
 */

import type { Observation } from "../engine/tree.ts";

export type CellId = string;

export interface CellMeta {
  branch: number;
  attempt: number;
  parent_id: CellId | null;
  seq: number;
  tags: string[];
}

export interface PolicyConfig {
  /** The single scalar beta in [0,1]. Fixed within one live/replay episode (paper Appendix B). */
  beta: number;
  [key: string]: unknown;
}

/** Episode budget. Replay always passes `null`: a policy must stop on its own. */
export interface Budget {
  attempts?: number;
  rounds?: number;
}

/** The observable interface handed to `solve()` — paper Appendix B, `question.*`. */
export interface QuestionView {
  /** Reset per-episode state (observed tree, probe counters). */
  reset(): void;
  /** Known observations for revealed cells only. */
  observed(): Record<CellId, Observation>;
  /** Roots + opened-branch frontiers. */
  legal_actions(): CellId[];
  /** Unopened roots only. */
  legal_roots(): CellId[];
  opened_branches(): number[];
  meta(cell_id: CellId): CellMeta;
  /** Probe a batch of cells; returns the observations produced for them. Always async. */
  probe_batch(cells: CellId[], on_reveal?: (o: Observation) => void): Promise<Observation[]>;
  baseline_score: number | null;
  max_parallelism: number;
  /** Host-provided extras the budget helpers need (not part of the paper's minimal list). */
  readonly rounds_used: number;
  readonly probes_used: number;
  /** Best successful score revealed so far. Bookkeeping: derive decisions from `observed()`. */
  readonly best_score: number | null;
  /** Paper Appendix B alias of `best_score`; explicitly bookkeeping-only for policies. */
  readonly best_so_far: number | null;
  /** Paper Appendix B alias of `probes_used`; explicitly bookkeeping-only for policies. */
  readonly budget_spent: number;
}

/** What a policy episode produced. */
export interface EpisodeResult {
  best_score: number | null;
  probes: number;
  rounds: number;
  stopped: string | null;
  curve: CurvePoint[];
}

export interface CurvePoint {
  round: number;
  probes: number;
  best: number | null;
}

/** Running accumulator a policy updates through `_record_curve`. */
export interface SimResult {
  curve: CurvePoint[];
  stopped: string | null;
}

export interface GridPlanningContext {
  /** Completed iterations, oldest first, as recorded in each live-cycle manifest sidecar. */
  history: {
    iteration: number;
    best_score: number | null;
    baked_beta: number | null;
    /** Archived beta-sweep summary for that iteration, when available. */
    sweep: BetaSweepSummary | null;
  }[];
  baseline_score: number | null;
  max_parallelism: number;
  budget: { workers: number; attempts: number } | null;
}

/** Answer to "how many directions, how deep" for the next live grid. */
export interface GridPlan {
  branch_count: number;
  refine_count: number;
  reason: string;
}

export interface BetaSweepSummary {
  auc: number;
  pareto_reward: number;
  parallel_penalty: number;
  frontier: { beta: number; attainment: number; work: number; parallelism: number; value: number }[];
}

/**
 * Base class for exploration policies. Subclasses implement `solve` and may override `plan_grid` and
 * `default_beta`. (Named after the paper's `LLMDesignedMethod`; the surface is identical.)
 */
export class LLMDesignedMethod {
  config: PolicyConfig;
  /** The beta the runtime forces for this episode (empty means "use your baked-in default"). */
  beta: number;
  /** The baked-in default beta a policy chooses for the next live episode. Override in subclasses. */
  default_beta: number;

  constructor(config?: Partial<PolicyConfig>) {
    this.config = { ...(config ?? {}) } as PolicyConfig;
    this.beta = resolveBeta(this, config ?? {});
    this.default_beta = this.beta;
  }

  /**
   * Must be implemented by the policy. May be async: `probe_batch` is asynchronous in this host
   * language (a live probe runs real agent attempts), so a live policy typically is too.
   */
  solve(_question: QuestionView, _budget?: Budget | null): EpisodeResult | Promise<EpisodeResult> {
    throw new Error("solve() is not implemented");
  }

  /**
   * Runs before a new live grid is created; never inspects the current episode.
   * Default: one branch per worker, full refinement depth.
   */
  plan_grid(context: GridPlanningContext): GridPlan {
    const branch_count = Math.max(1, context.max_parallelism);
    return {
      branch_count,
      refine_count: context.budget?.attempts ? Math.max(1, Math.ceil(context.budget.attempts / branch_count)) : 1,
      reason: "default: open one branch per worker and refine to the round budget",
    };
  }

  /** Convenience used by the shipped policy and by tests. */
  static schedule(beta: number): Schedule {
    const b = Math.min(1, Math.max(0, Number.isFinite(beta) ? beta : 0.6));
    return {
      beta: b,
      // High beta: more width, deeper patience, weaker pruning.
      open_root_bias: 0.25 + 0.75 * b,
      min_gain_to_continue: 0.02 - 0.02 * b,
      stale_rounds_before_park: Math.round(3 + 5 * b),
      prune_after_consecutive_failures: Math.round(5 - 3 * b),
      breadth_share: b,
    };
  }
}

export interface Schedule {
  beta: number;
  open_root_bias: number;
  min_gain_to_continue: number;
  stale_rounds_before_park: number;
  prune_after_consecutive_failures: number;
  breadth_share: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.6;
  return Math.min(1, Math.max(0, value));
}

/**
 * The one scalar beta (paper Appendix B): the episode-forced value wins, otherwise the policy's
 * baked-in `default_beta`, otherwise a moderate 0.6.
 */
export function resolveBeta(policy: LLMDesignedMethod, config: Partial<PolicyConfig> = {}): number {
  const declaredConfig = (policy as { config?: Partial<PolicyConfig> }).config;
  const forced =
    typeof config.beta === "number"
      ? config.beta
      : typeof declaredConfig?.beta === "number"
        ? declaredConfig.beta
        : null;
  if (forced !== null) return clamp01(forced);
  const declared = (policy as unknown as { default_beta?: unknown }).default_beta;
  return clamp01(typeof declared === "number" ? declared : 0.6);
}

/** Append the current curve point — the paper's `_record_curve`. */
export function _record_curve(res: SimResult, question: QuestionView): SimResult {
  res.curve.push({ round: question.rounds_used, probes: question.probes_used, best: question.best_so_far });
  return res;
}

/** True when the episode is out of budget or has nothing legal left to probe. */
export function _budget_done(question: QuestionView, budget?: Budget | null): boolean {
  if (question.legal_actions().length === 0) return true;
  if (!budget) return false;
  if (typeof budget.attempts === "number" && question.budget_spent >= budget.attempts) return true;
  if (typeof budget.rounds === "number" && question.rounds_used >= budget.rounds) return true;
  return false;
}

/** Episode result built from the question state — the paper's `finalize_result`. */
export function finalize_result(question: QuestionView, res?: SimResult): EpisodeResult {
  return {
    best_score: question.best_so_far,
    probes: question.budget_spent,
    rounds: question.rounds_used,
    stopped: res?.stopped ?? null,
    curve: res?.curve ?? [],
  };
}

export function newSimResult(): SimResult {
  return { curve: [], stopped: null };
}
