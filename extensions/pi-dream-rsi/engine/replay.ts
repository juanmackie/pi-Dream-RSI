/**
 * Replay simulator transitions (paper §3, "Offline evaluation").
 *
 * Replay never generates candidates: it deterministically reveals what was recorded.
 * - Selecting an *unopened root slot* reveals the earliest-created recorded child of `r` that is
 *   still unrevealed, opening one previously unrevealed branch.
 * - Selecting an *opened frontier* reveals that node's unique recorded child, if one exists.
 * - `Child(v) = ∅` when no recorded continuation remains.
 *
 * The world is the frozen discovery tree; the observed tree grows inside `PolicyHost`.
 */

import { ROOT_ID, type DiscoveryTree } from "./tree.ts";
import type { ProbeFn, RevealedNode, Decision } from "../policy/host.ts";
import type { CellId } from "../policy/api.ts";
import { runPolicyChecked } from "../policy/runner.ts";
import { traceMetrics, type RewardConfig, type TraceMetrics } from "./reward.ts";

/**
 * @param isRevealed predicate over the *observed* prefix (so the simulator and the host cannot disagree)
 */
export function makeReplayProbe(world: DiscoveryTree, isRevealed: (cell: CellId) => boolean): ProbeFn {
  return async (cells: CellId[]): Promise<RevealedNode[]> => {
    const out: RevealedNode[] = [];
    const isSlotProbe = (cell: CellId): boolean => {
      const node = world.get(cell);
      return node?.meta.parent_id === ROOT_ID && node.meta.attempt === 0 && !isRevealed(cell);
    };
    // Root rule: earliest-created recorded branch outside the observed tree.
    const slots = cells.filter(isSlotProbe);
    if (slots.length > 0) {
      const pending = world
        .list()
        .filter((n) => n.meta.parent_id === ROOT_ID && !isRevealed(n.meta.cell_id))
        .sort((a, b) => a.meta.seq - b.meta.seq);
      for (let i = 0; i < slots.length && i < pending.length; i += 1) {
        out.push({ cell: pending[i].meta.cell_id, node: pending[i] });
      }
    }
    // Opened branch: reveal the unique recorded child of the selected frontier.
    for (const cell of cells) {
      if (isSlotProbe(cell)) continue;
      const child = world.childrenOf(cell)[0];
      if (!child || isRevealed(child.meta.cell_id)) continue;
      out.push({ cell: child.meta.cell_id, node: child });
    }
    return out;
  };
}


export interface ReplayEpisodeOptions {
  policyPath: string;
  world: DiscoveryTree;
  /** The one scalar baked into the policy config for this evaluation. */
  beta: number;
  maxParallelism: number;
  /** K2 — maximum decision rounds replay allows. */
  k2: number;
  beta1: number;
  beta2: number;
  lambda: number;
  timeoutMs?: number;
  /** Run the episode twice from independent module instances and compare decision traces. */
  verifyDeterminism?: boolean;
}

export interface ReplayEpisodeResult {
  ok: boolean;
  error: string | null;
  timedOut: boolean;
  metrics: TraceMetrics;
  trace: Decision[];
  deterministic: boolean | null;
  durationMs: number;
}

/**
 * Replay one policy version against one frozen world.
 *
 * `budget = null` (paper Appendix B): the round limit K2 is enforced by the environment — once K2
 * rounds are spent, `legal_actions()` is empty and any further probe is rejected.
 */
export async function replayEpisode(options: ReplayEpisodeOptions): Promise<ReplayEpisodeResult> {
  const rewardConfig: RewardConfig = {
    maxParallelism: options.maxParallelism,
    beta1: options.beta1,
    beta2: options.beta2,
    lambda: options.lambda,
    baselineScore: options.world.baselineScore,
  };
  const run = await runPolicyChecked({
    policyPath: options.policyPath,
    mode: "replay",
    maxParallelism: options.maxParallelism,
    config: options.beta === null ? {} : { beta: options.beta },
    world: options.world,
    maxRounds: options.k2,
    timeoutMs: options.timeoutMs ?? 60_000,
    verifyDeterminism: options.verifyDeterminism ?? false,
  });
  const trace = run.trace ?? [];
  return {
    ok: run.ok,
    error: run.error ?? null,
    timedOut: run.timedOut ?? false,
    metrics: traceMetrics(trace, rewardConfig),
    trace,
    deterministic: run.deterministic ?? null,
    beta: run.beta ?? null,
    durationMs: run.durationMs ?? 0,
  };
}
