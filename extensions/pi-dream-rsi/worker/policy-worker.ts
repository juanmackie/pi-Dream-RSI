/**
 * Policy worker — runs one candidate policy version in an isolated, killable thread.
 *
 * Why a worker: policy code is machine-written and rewritten between iterations. Running it in
 * `worker_threads` keeps a hanging or throwing policy from taking down pi, bounds it with a
 * wall-clock deadline (`worker.terminate()`), and gives replay a clean, deterministic sandbox.
 *
 * Modes:
 * - `grid`   — load the policy, call `plan_grid()`, return the plan. No episode runs.
 * - `live`   — run `solve()`; `probe_batch` requests are relayed to the host, which executes
 *              real generation-evaluation attempts.
 * - `replay` — run `solve()` against a frozen world; reveals resolve locally, no host round-trips.
 */

import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

import { DiscoveryTree, ROOT_ID, type TreeJSON } from "../engine/tree.ts";
import { makeReplayProbe } from "../engine/replay.ts";
import { PolicyHost, type Decision, type RevealedNode } from "../policy/host.ts";
import {
  finalize_result,
  LLMDesignedMethod,
  resolveBeta,
  type Budget,
  type CellId,
  type GridPlan,
  type GridPlanningContext,
  type PolicyConfig,
  type QuestionView,
} from "../policy/api.ts";

export interface WorkerData {
  policyPath: string;
  mode: "grid" | "live" | "replay";
  config?: Partial<PolicyConfig>;
  maxParallelism: number;
  slots?: number[];
  grid?: { branch_count: number; refine_count: number } | null;
  /** K1 (live) or K2 (replay) decision-round limit enforced by the host. */
  maxRounds?: number;
  baselineScore?: number | null;
  refineCount?: number;
  budget?: Budget | null;
  world?: TreeJSON | null;
  gridPlanContext?: GridPlanningContext | null;
}

interface PendingProbe {
  resolve: (records: RevealedNode[]) => void;
  reject: (error: Error) => void;
}

function fail(message: string): never {
  throw new Error(message);
}

async function loadPolicy(policyPath: string): Promise<LLMDesignedMethod> {
  // No query string: Node resolves a file's module type from the nearest package.json, and a query
  // defeats that lookup (noisily). Independent instances come from independent workers instead.
  const module = (await import(pathToFileURL(policyPath).href)) as Record<string, unknown>;
  const exported = (module.OptimalPolicy ?? module.default) as unknown;
  if (typeof exported !== "function") {
    fail(`policy must export class OptimalPolicy (or a default class): ${policyPath}`);
  }
  const instance_ = new (exported as new (config?: Partial<PolicyConfig>) => LLMDesignedMethod)(workerData.config);
  if (typeof instance_.solve !== "function") fail("policy instance has no solve()");
  // Resolve after construction: a subclass field initializer (`default_beta = 0.8`) runs after super().
  instance_.beta = resolveBeta(instance_, workerData.config ?? {});
  return instance_;
}

function buildReplayHost(world: DiscoveryTree, maxParallelism: number): PolicyHost {
  const revealed = new Set<CellId>();
  const base = makeReplayProbe(world, (cell) => revealed.has(cell));
  return new PolicyHost({
    mode: "replay",
    maxParallelism,
    maxRounds: workerData.maxRounds,
    baselineScore: world.baselineScore,
    refineCount: world.refineCount,
    slots: [...new Set(world.list().filter((n) => n.meta.parent_id === ROOT_ID).map((n) => n.meta.branch))],
    probe: async (cells: CellId[]): Promise<RevealedNode[]> => {
      const records = await base(cells, 0);
      for (const record of records) revealed.add(record.cell);
      return records;
    },
  });
}

function buildLiveHost(maxParallelism: number, grid: { branch_count: number; refine_count: number }): PolicyHost {
  let pending: PendingProbe | null = null;
  parentPort!.on("message", (message: { type: string; records?: RevealedNode[]; message?: string }) => {
    if (!pending) return;
    if (message.type === "probe-reply") {
      const entry = pending;
      pending = null;
      entry.resolve(message.records ?? []);
      return;
    }
    if (message.type === "abort") {
      const entry = pending;
      pending = null;
      entry.reject(new Error(message.message ?? "aborted by host"));
    }
  });
  return new PolicyHost({
    mode: "live",
    maxParallelism,
    grid,
    maxRounds: workerData.maxRounds,
    baselineScore: workerData.baselineScore ?? null,
    slots: workerData.slots,
    probe: (cells: CellId[], round: number): Promise<RevealedNode[]> =>
      new Promise<RevealedNode[]>((resolve, reject) => {
        if (pending) {
          reject(new Error("policy issued overlapping probe_batch calls"));
          return;
        }
        pending = { resolve, reject };
        parentPort!.postMessage({ type: "probe", cells, round });
      }),
  });
}

async function runEpisode(
  policyPath: string,
  host: PolicyHost,
  budget: Budget | null,
): Promise<{ result: ReturnType<typeof finalize_result>; trace: Decision[]; revealed: number; name: string; beta: number }> {
  const policy = await loadPolicy(policyPath);
  const outcome = await Promise.resolve(policy.solve(host as QuestionView, budget));
  const result = outcome ?? finalize_result(host);
  return {
    result: { ...result, curve: result.curve ?? [] },
    trace: host.decisions,
    revealed: Object.keys(host.observed()).length,
    name: (policy.constructor as { name?: string }).name ?? "OptimalPolicy",
    beta: policy.beta,
  };
}

async function main(): Promise<void> {
  const data = workerData as WorkerData;
  if (data.mode === "grid") {
    const policy = await loadPolicy(data.policyPath);
    const context: GridPlanningContext = data.gridPlanContext ?? {
      history: [],
      baseline_score: data.baselineScore ?? null,
      max_parallelism: data.maxParallelism,
      budget: null,
    };
    const plan = (await Promise.resolve(policy.plan_grid(context))) as GridPlan;
    if (!plan || typeof plan.branch_count !== "number" || typeof plan.refine_count !== "number") {
      fail("plan_grid() must return { branch_count, refine_count, reason }");
    }
    parentPort!.postMessage({
      type: "grid-plan",
      plan: {
        branch_count: Math.max(1, Math.floor(plan.branch_count)),
        refine_count: Math.max(1, Math.floor(plan.refine_count)),
        reason: typeof plan.reason === "string" ? plan.reason : "",
      },
      beta: policy.beta,
    });
    return;
  }

  if (data.mode === "replay") {
    const world = DiscoveryTree.fromJSON(data.world as TreeJSON);
    const host = buildReplayHost(world, data.maxParallelism);
    const run = await runEpisode(data.policyPath, host, null);
    parentPort!.postMessage({
      type: "result",
      result: run.result,
      trace: run.trace,
      revealed: run.revealed,
      policyName: run.name,
      beta: run.beta,
    });
    return;
  }

  const grid = data.grid ?? { branch_count: data.maxParallelism, refine_count: data.refineCount ?? 1 };
  const host = buildLiveHost(data.maxParallelism, grid);
  const run = await runEpisode(data.policyPath, host, data.budget ?? null);
  parentPort!.postMessage({
    type: "result",
    result: run.result,
    trace: run.trace,
    revealed: run.revealed,
    policyName: run.name,
    beta: run.beta,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  parentPort!.postMessage({ type: "error", message, stack });
});
