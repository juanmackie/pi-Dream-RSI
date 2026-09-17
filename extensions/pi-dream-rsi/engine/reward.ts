/**
 * Reward computation.
 *
 * Two distinct scalars, straight from the paper:
 *
 * 1. The replay objective (Eq. 1), used to *select* the next policy:
 *
 *      V = max s_v  -  beta1 * N  +  beta2 * N / max(1, k*)
 *
 *    where `N` is the number of revealed non-root nodes (each one represents a
 *    generation-evaluation request) and `k*` is the number of completed decision rounds.
 *
 * 2. The sweep ranking, used to judge a policy's whole beta curve:
 *
 *      pareto.reward = pareto.auc - lambda * parallel_penalty
 *
 *    `pareto.auc` rewards high per-trace attainment with few total probes.
 *    `parallel_penalty` is the mean of `effective_sequential_rounds / total_probes`: a batch of size
 *    `k` costs one decision round and `ceil(k / W)` effective sequential rounds, so a serial policy
 *    sits near 1 and full batches approach `1/W`.
 *
 * All of it is derived from the host-recorded decision trace, never from numbers a policy reports
 * about itself. The paper states these forms but not its numeric constants, so `beta1`, `beta2`, and
 * `lambda` are explicit configuration with documented defaults.
 */

import type { Decision } from "../policy/host.ts";
import type { BetaSweepSummary } from "../policy/api.ts";

export interface RewardConfig {
  /** W — parallel workers. */
  maxParallelism: number;
  beta1: number;
  beta2: number;
  lambda: number;
  baselineScore: number | null;
}

export interface TraceMetrics {
  /** Revealed non-root nodes = N. */
  probes: number;
  /** Completed decision rounds = k*. */
  rounds: number;
  /** max s_v over everything revealed so far (including the root's baseline). */
  attainment: number | null;
  /** Eq. 1. */
  value: number;
  /** Mean per-probe attainment (see module docs). */
  auc: number;
  /** effective_sequential_rounds / total_probes. */
  parallel_penalty: number;
  /** Mean revealed cells per decision round — the batching signal. */
  batch_size: number;
}

export function replayValue(attainment: number | null, probes: number, rounds: number, cfg: RewardConfig): number {
  const quality = attainment ?? 0;
  const parallelismBonus = probes === 0 ? 0 : (cfg.beta2 * probes) / Math.max(1, rounds);
  return quality - cfg.beta1 * probes + parallelismBonus;
}

/** Derive everything the sweep needs from one replay episode's decision trace. */
export function traceMetrics(trace: Decision[], cfg: RewardConfig): TraceMetrics {
  let probes = 0;
  let attainment: number | null = cfg.baselineScore;
  let area = 0;
  let effectiveSequentialRounds = 0;
  const W = Math.max(1, cfg.maxParallelism);

  for (const decision of trace) {
    const revealed = Object.values(decision.revealed);
    // A batch of size k costs ceil(k / W) effective sequential rounds, regardless of how many of the
    // selected cells turned out to have a recorded continuation.
    effectiveSequentialRounds += Math.ceil(decision.batch.length / W);
    for (const observation of revealed) {
      probes += 1;
      if (observation.evaluated && observation.error === null && observation.fail_class === "ok") {
        if (typeof observation.score === "number" && (attainment === null || observation.score > attainment)) {
          attainment = observation.score;
        }
      }
      area += attainment ?? 0;
    }
  }

  const auc = probes === 0 ? (cfg.baselineScore ?? 0) : area / probes;
  const parallelPenalty = probes === 0 ? 0 : effectiveSequentialRounds / probes;
  return {
    probes,
    rounds: trace.length,
    attainment,
    value: replayValue(attainment, probes, trace.length, cfg),
    auc,
    parallel_penalty: parallelPenalty,
    batch_size: trace.length === 0 ? 0 : probes / trace.length,
  };
}

export function paretoReward(auc: number, parallelPenalty: number, lambda: number): number {
  return auc - lambda * parallelPenalty;
}

export interface BetaSweepPoint {
  beta: number;
  /** Mean max s_v over the fixed history. */
  attainment: number;
  /** Mean total probes (= N) — the work axis of the sweep curve. */
  work: number;
  /** Mean N / max(1, k*) — how well the policy batches. */
  parallelism: number;
  /** Mean Eq. 1 replay score at this beta (what selects the next policy). */
  value: number;
  /** Mean effective_sequential_rounds / total_probes at this beta. */
  penalty: number;
  /** Mean per-trace AUC, kept as a diagnostic only. */
  trace_auc: number;
  /** Episode-level failures recorded while evaluating this beta. */
  errors: string[];
}

/**
 * `pareto.auc`: area under the sweep curve of attainment versus work (total probes), normalized by
 * the work range so it stays in attainment units. A flatter work range falls back to mean attainment.
 */
export function sweepAuc(points: BetaSweepPoint[]): number {
  if (points.length === 0) return 0;
  const sorted = points.slice().sort((a, b) => a.work - b.work);
  const width = sorted[sorted.length - 1].work - sorted[0].work;
  if (sorted.length === 1 || width <= 0) {
    return sorted.reduce((sum, p) => sum + p.attainment, 0) / sorted.length;
  }
  let area = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    area += ((sorted[i].attainment + sorted[i - 1].attainment) / 2) * (sorted[i].work - sorted[i - 1].work);
  }
  return area / width;
}

/** Rank a swept beta grid by `pareto.reward = pareto.auc - lambda * parallel_penalty`. */
export function sweepSummary(points: BetaSweepPoint[], lambda: number): BetaSweepSummary {
  if (points.length === 0) return { auc: 0, pareto_reward: 0, parallel_penalty: 0, frontier: [] };
  const auc = sweepAuc(points);
  const parallelPenalty = points.reduce((sum, p) => sum + p.penalty, 0) / points.length;
  // Pareto frontier over (work, attainment): non-dominated points, cheapest work first.
  const frontier = points
    .slice()
    .sort((a, b) => a.work - b.work || b.attainment - a.attainment)
    .filter((point, index, sorted) => {
      for (let i = 0; i < index; i += 1) if (sorted[i].attainment >= point.attainment) return false;
      return true;
    })
    .map((p) => ({
      beta: p.beta,
      attainment: p.attainment,
      work: p.work,
      parallelism: p.parallelism,
      value: p.value,
    }));
  return {
    auc,
    pareto_reward: paretoReward(auc, parallelPenalty, lambda),
    parallel_penalty: parallelPenalty,
    frontier,
  };
}
