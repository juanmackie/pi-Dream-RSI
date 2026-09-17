/**
 * Dreaming: the offline phase (paper §3, "Offline evaluation" + "Policy improvement and selection"),
 * driven by the prompt in `prompts/policy-improvement.md`.
 *
 *   fixed history H_t  ->  evaluate pi_0 .. pi_{M-1} on EVERY world (replay only, no new generation)
 *                      ->  revise the executable policy between revisions
 *                      ->  pi_{t+1} = argmax_m V_m        (V_m = mean over worlds of Eq. 1)
 *                      ->  deploy the winner for the next live episode
 *
 * Because pi_0 (the policy that just ran live) is always among the candidates, the selection satisfies
 * `V* >= V_0`. That guarantee is asserted, not assumed: if it breaks, something non-deterministic or
 * non-prefix-only happened and the iteration is reported as failed instead of deploying a regression.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { runAgent } from "../agent/runner.ts";
import { loadPrompt, renderPrompt } from "./prompt.ts";
import { readTree } from "./world.ts";
import { replayEpisode } from "./replay.ts";
import { sweepSummary, type BetaSweepPoint } from "./reward.ts";
import { planGrid } from "../policy/runner.ts";
import type { BetaSweepSummary, GridPlan, GridPlanningContext } from "../policy/api.ts";
import type { DiscoveryTree } from "./tree.ts";
import { normalizeTask, type TaskConfig } from "./task.ts";
import { BUNDLED_POLICY_DIR } from "../layout.ts";
import {
  appendJsonl,
  archivePolicyVersion,
  baselineDir,
  deployPolicy,
  ensurePolicyRuntime,
  historyDir,
  liveMethodPath,
  proposalResultsDir,
  recentManifests,
  roundDir,
  tracePoolDir,
  writeJson,
  type LiveCycleManifest,
} from "./world.ts";


export interface DreamOptions {
  dreamRoot: string;
  projectDir: string;
  task: TaskConfig;
  iteration: number;
  /** Overrides the deployed policy for revision 0 (used by tests). */
  policyPath?: string;
  log?: (message: string) => void;
  /** Wall-clock cap per policy-development agent call. */
  developmentTimeoutMs?: number;
  /** Skip the policy-development agent (revision 0 only) — useful for smoke tests. */
  evaluateOnly?: boolean;
}

export interface VersionEvaluation {
  revision: number;
  policy_path: string;
  policy_name: string | null;
  /** The version's baked-in default beta, as resolved from the policy itself. */
  default_beta: number;
  /** V_m — mean replay score across the fixed history at the version's default beta. */
  v_mean: number;
  deterministic: boolean | null;
  per_world: {
    iteration: number;
    value: number;
    probes: number;
    rounds: number;
    attainment: number | null;
    auc: number;
    parallel_penalty: number;
    ok: boolean;
    error: string | null;
  }[];
  /** Archived sweep of the beta grid for this version. */
  points: BetaSweepPoint[];
  summary: BetaSweepSummary;
  error: string | null;
}

export interface DreamResult {
  ok: boolean;
  error: string | null;
  iteration: number;
  worlds: number;
  revisions: number;
  evaluations: VersionEvaluation[];
  /** Index into `evaluations` of the selected version. */
  selected: number | null;
  selected_policy: string | null;
  /** The beta baked into the deployed policy. */
  deployed_beta: number;
  /** True when the policy-development agent changed the method file at least once. */
  improved: boolean;
  report: string;
}

function developmentPrompt(options: DreamOptions, worldCount: number): string {
  const template = loadPrompt("policy-improvement.md");
  return renderPrompt(template, {
    method_file: liveMethodPath(options.dreamRoot),
    history_dir: historyDir(options.dreamRoot),
    trace_pool: tracePoolDir(options.dreamRoot),
    baseline_dir: baselineDir(options.dreamRoot),
    worlds: worldCount,
    iteration: options.iteration,
  });
}

export async function runDreamPhase(rawOptions: DreamOptions): Promise<DreamResult> {
  // Normalize at the boundary, same as the live phase.
  const options: DreamOptions = { ...rawOptions, task: normalizeTask(rawOptions.task) };
  const { dreamRoot, task, iteration } = options;
  const log = options.log ?? (() => {});
  const policyDir = path.join(dreamRoot, "policy");
  ensurePolicyRuntime(dreamRoot, BUNDLED_POLICY_DIR);
  const currentPolicy = options.policyPath ?? liveMethodPath(dreamRoot);
  if (!fs.existsSync(currentPolicy)) throw new Error(`no policy to improve at ${currentPolicy}`);

  // --- fixed history ------------------------------------------------------
  const iterations: number[] = [];
  const worlds: DiscoveryTree[] = [];
  for (let t = 1; t <= iteration; t += 1) {
    const tree = readTree(dreamRoot, t);
    if (!tree) continue;
    iterations.push(t);
    worlds.push(tree);
  }
  if (worlds.length === 0) throw new Error("no recorded worlds to replay; run a live cycle first");

  const rewardConfig = {
    maxParallelism: task.workers,
    beta1: task.beta1,
    beta2: task.beta2,
    lambda: 1,
    baselineScore: worlds[0].baselineScore,
  };

  const evaluations: VersionEvaluation[] = [];
  const traces: Record<string, unknown>[] = [];
  const revisions = options.evaluateOnly ? 1 : Math.max(1, task.revisions);
  let improved = false;

  /** Evaluate one policy version: selection beta first, then the full grid for the sweep. */
  const evaluate = async (revision: number, policyPath: string): Promise<VersionEvaluation> => {
    const perWorld: VersionEvaluation["per_world"] = [];
    const errors: string[] = [];
    const values: number[] = [];
    let defaultBeta = task.default_beta;
    let policyName: string | null = null;
    let deterministic: boolean | null = null;

    for (let index = 0; index < worlds.length; index += 1) {
      const world = worlds[index];
      const episode = await replayEpisode({
        policyPath,
        world,
        beta: null, // the version's own baked-in default beta
        maxParallelism: task.workers,
        k2: task.k2,
        beta1: task.beta1,
        beta2: task.beta2,
        lambda: rewardConfig.lambda,
        timeoutMs: 120_000,
        verifyDeterminism: index === 0,
      });
      if (typeof episode.beta === "number" && Number.isFinite(episode.beta)) defaultBeta = episode.beta;
      if (episode.deterministic === false && deterministic !== false) deterministic = false;
      else if (episode.deterministic === true && deterministic === null) deterministic = true;
      const metrics = episode.metrics;
      // A version that cannot run a world must not be credited with the zeroed metrics of a failed run.
      const value = episode.ok ? metrics.value : Number.NEGATIVE_INFINITY;
      values.push(value);
      perWorld.push({
        iteration: iterations[index],
        value,
        probes: metrics.probes,
        rounds: metrics.rounds,
        attainment: metrics.attainment,
        auc: metrics.auc,
        parallel_penalty: metrics.parallel_penalty,
        ok: episode.ok,
        error: episode.error,
      });
      if (!episode.ok && episode.error) errors.push(`world ${iterations[index]}: ${episode.error}`);
      traces.push(
        ...episode.trace.map((decision) => ({
          iteration,
          revision,
          world: iterations[index],
          beta: "default",
          round: decision.round,
          prefix: decision.observed,
          batch: decision.batch,
          revealed: decision.revealed,
          best_after: decision.best_after,
          value: metrics.value,
          probes: metrics.probes,
          rounds: metrics.rounds,
          attainment: metrics.attainment,
        })),
      );
    }

    // Sweep the beta grid: the diagnostic that tells the agent whether beta buys anything.
    const points: BetaSweepPoint[] = [];
    for (const beta of task.beta_grid) {
      const attainments: number[] = [];
      const works: number[] = [];
      const parallelisms: number[] = [];
      const valuesAtBeta: number[] = [];
      const penalties: number[] = [];
      const traceAucs: number[] = [];
      const betaErrors: string[] = [];
      for (let index = 0; index < worlds.length; index += 1) {
        const episode = await replayEpisode({
          policyPath,
          world: worlds[index],
          beta,
          maxParallelism: task.workers,
          k2: task.k2,
          beta1: task.beta1,
          beta2: task.beta2,
          lambda: rewardConfig.lambda,
          timeoutMs: 120_000,
        });
        const metrics = episode.metrics;
        if (!episode.ok) {
          // Failed episodes are recorded, never averaged in as if they had scored zero.
          betaErrors.push(`beta ${beta} world ${iterations[index]}: ${episode.error ?? "failed"}`);
          traces.push(
            ...episode.trace.map((decision) => ({
              iteration,
              revision,
              world: iterations[index],
              beta,
              round: decision.round,
              prefix: decision.observed,
              batch: decision.batch,
              revealed: decision.revealed,
              best_after: decision.best_after,
              ok: false,
            })),
          );
          continue;
        }
        attainments.push(metrics.attainment ?? 0);
        works.push(metrics.probes);
        parallelisms.push(metrics.probes === 0 ? 0 : metrics.probes / Math.max(1, metrics.rounds));
        valuesAtBeta.push(metrics.value);
        penalties.push(metrics.parallel_penalty);
        traceAucs.push(metrics.auc);
        traces.push(
          ...episode.trace.map((decision) => ({
            iteration,
            revision,
            world: iterations[index],
            beta,
            round: decision.round,
            prefix: decision.observed,
            batch: decision.batch,
            revealed: decision.revealed,
            best_after: decision.best_after,
            value: metrics.value,
            probes: metrics.probes,
            rounds: metrics.rounds,
            attainment: metrics.attainment,
          })),
        );
      }
      const mean = (list: number[]): number => (list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length);
      points.push({
        beta,
        attainment: mean(attainments),
        work: mean(works),
        parallelism: mean(parallelisms),
        value: valuesAtBeta.length === 0 ? Number.NEGATIVE_INFINITY : mean(valuesAtBeta),
        penalty: mean(penalties),
        trace_auc: mean(traceAucs),
        errors: betaErrors,
      });
    }

    // The version's own baked-in default beta was read from the selection run above.
    const summary = sweepSummary(points, rewardConfig.lambda);
    const vMean = values.length === 0 ? Number.NEGATIVE_INFINITY : values.reduce((a, b) => a + b, 0) / values.length;
    return {
      revision,
      policy_path: policyPath,
      policy_name: policyName,
      default_beta: defaultBeta,
      v_mean: vMean,
      deterministic,
      per_world: perWorld,
      points,
      summary,
      error: errors.length > 0 ? errors.join("; ") : null,
    };
  };

  log(`[dream ${iteration}] fixed history: ${worlds.length} world(s); M=${revisions} revision(s)`);
  // Version 0 is the policy that just ran live: it must be evaluated from a stable, immutable path.
  let candidatePath = archivePolicyVersion(dreamRoot, 0, fs.readFileSync(currentPolicy, "utf8"));
  for (let revision = 0; revision < revisions; revision += 1) {
    const evaluation = await evaluate(revision, candidatePath);
    evaluations.push(evaluation);
    log(
      `[dream ${iteration}] pi_${revision}: V=${evaluation.v_mean.toFixed(4)} beta=${evaluation.default_beta} ` +
        `pareto.reward=${evaluation.summary.pareto_reward.toFixed(4)} auc=${evaluation.summary.auc.toFixed(4)} ` +
        `penalty=${evaluation.summary.parallel_penalty.toFixed(4)} deterministic=${evaluation.deterministic ?? "n/a"}`,
    );
    if (evaluation.deterministic === false) {
      evaluation.error = `${evaluation.error ? `${evaluation.error}; ` : ""}non-deterministic replay`;
      evaluation.v_mean = Number.NEGATIVE_INFINITY;
    }
    const isLast = revision === revisions - 1;
    if (isLast || options.evaluateOnly) continue;

    // --- revise the executable policy (the paper's policy-development agent) ---
    // The agent edits the deployed method file; each revision is then snapshotted as a new version.
    const methodFile = liveMethodPath(dreamRoot);
    const before = fs.readFileSync(methodFile, "utf8");
    const prompt = developmentPrompt(options, worlds.length);
    const agentRun = await runAgent({
      agent: task.agent,
      cwd: dreamRoot,
      prompt,
      timeoutMs: options.developmentTimeoutMs ?? task.agent_timeout_ms,
      logPath: path.join(roundDir(dreamRoot, iteration, "dream"), `development_r${revision}_agent.log`),
    });
    const after = fs.existsSync(methodFile) ? fs.readFileSync(methodFile, "utf8") : "";
    if (!agentRun.ok || after === before) {
      log(
        `[dream ${iteration}] revision ${revision + 1} left the policy unchanged (${agentRun.ok ? "no edit" : (agentRun.spawnError ?? "agent failed")})`,
      );
    } else {
      improved = true;
    }
    candidatePath = archivePolicyVersion(dreamRoot, revision + 1, after === "" ? before : after);
  }

  // --- selection ----------------------------------------------------------
  let selected = 0;
  for (let index = 1; index < evaluations.length; index += 1) {
    if (evaluations[index].v_mean > evaluations[selected].v_mean) selected = index;
  }
  const best = evaluations[selected];
  // The guarantee is `V* >= V_0` over the candidate set. It also has to *exist*: if every version
  // failed to score, deploying anything (or reporting success) would be a lie.
  const scored = evaluations.filter((e) => Number.isFinite(e.v_mean));
  const monotone =
    scored.length > 0 && Number.isFinite(best.v_mean) && best.v_mean >= (scored[0]?.v_mean ?? Number.NEGATIVE_INFINITY);
  if (monotone) {
    deployPolicy(dreamRoot, fs.readFileSync(best.policy_path, "utf8"));
  }
  const resultsDir = proposalResultsDir(dreamRoot, iteration);
  writeJson(path.join(resultsDir, "beta_sweep.json"), {
    iteration,
    lambda: rewardConfig.lambda,
    beta1: task.beta1,
    beta2: task.beta2,
    worlds: iterations,
    selected_revision: selected,
    selected_policy: best.policy_path,
    deployed_beta: best.default_beta,
    auc: best.summary.auc,
    pareto_reward: best.summary.pareto_reward,
    parallel_penalty: best.summary.parallel_penalty,
    frontier: best.summary.frontier,
    versions: evaluations.map((e) => ({
      revision: e.revision,
      v_mean: e.v_mean,
      default_beta: e.default_beta,
      deterministic: e.deterministic,
      auc: e.summary.auc,
      pareto_reward: e.summary.pareto_reward,
      parallel_penalty: e.summary.parallel_penalty,
      frontier: e.summary.frontier,
      points: e.points.map((p) => ({
        beta: p.beta,
        attainment: p.attainment,
        work: p.work,
        parallelism: p.parallelism,
        value: p.value,
        penalty: p.penalty,
        trace_auc: p.trace_auc,
      })),
      per_world: e.per_world,
      error: e.error,
    })),
  });
  appendJsonl(path.join(resultsDir, "policy_execution_traces.jsonl"), traces);
  writeJson(path.join(resultsDir, "selection.json"), {
    iteration,
    selected_revision: selected,
    monotone,
    v_mean: evaluations.map((e) => e.v_mean),
    deployed_beta: best.default_beta,
  });

  const report = [
    `iteration ${iteration}: ${worlds.length} replay world(s), ${evaluations.length} version(s) evaluated`,
    ...evaluations.map(
      (e) =>
        `  pi_${e.revision}: V=${e.v_mean.toFixed(4)} beta=${e.default_beta} pareto.reward=${e.summary.pareto_reward.toFixed(4)}` +
        ` probes=${meanOf(e.per_world.map((w) => w.probes)).toFixed(1)} rounds=${meanOf(e.per_world.map((w) => w.rounds)).toFixed(1)}` +
        (e.error ? ` error=${e.error}` : ""),
    ),
    `selected pi_${selected} (V* >= V_0: ${monotone}) -> deployed with beta=${best.default_beta}`,
  ].join("\n");

  return {
    ok: monotone,
    error: monotone
      ? null
      : scored.length === 0
        ? "no policy version produced a finite replay score (all failed or non-deterministic)"
        : "selection violated V* >= V_0 (non-deterministic or non-prefix-only policy)",
    iteration,
    worlds: worlds.length,
    revisions: evaluations.length,
    evaluations,
    selected,
    selected_policy: best.policy_path,
    deployed_beta: best.default_beta,
    improved,
    report,
  };
}

function meanOf(list: number[]): number {
  return list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length;
}

/** Ask the deployed policy for the next live grid (used by `dream_rsi_live`). */
export async function planNextGrid(
  dreamRoot: string,
  task: TaskConfig,
  iteration: number,
  baselineScore: number | null,
  policyPath?: string,
): Promise<{ plan: GridPlan; beta: number | null; error: string | null }> {
  const history = recentManifests(dreamRoot, 3).map((manifest: LiveCycleManifest) => {
    const sweep = readSweep(dreamRoot, manifest.iteration);
    return {
      iteration: manifest.iteration,
      best_score: manifest.best_score,
      baked_beta: manifest.baked_beta,
      sweep,
    };
  });
  const context: GridPlanningContext = {
    history,
    baseline_score: baselineScore,
    max_parallelism: task.workers,
    budget: { workers: task.workers, attempts: task.workers * Math.max(1, task.k1) },
  };
  const result = await planGrid({
    policyPath: policyPath ?? liveMethodPath(dreamRoot),
    maxParallelism: task.workers,
    gridPlanContext: context,
    timeoutMs: 60_000,
  });
  if (!result.ok || !result.plan) return { plan: fallbackGrid(task), beta: null, error: result.error ?? "plan_grid failed" };
  return {
    plan: {
      branch_count: Math.min(result.plan.branch_count, Math.max(1, task.workers)),
      refine_count: result.plan.refine_count,
      reason: result.plan.reason,
    },
    beta: result.beta ?? null,
    error: null,
  };
}

/** Safe default grid when a policy cannot plan one (paper: one branch per worker, refine to budget). */
export function fallbackGrid(task: TaskConfig): GridPlan {
  return {
    branch_count: Math.max(1, task.workers),
    refine_count: Math.max(1, task.k1),
    reason: "fallback: one branch per worker refined to the round budget",
  };
}

function readSweep(dreamRoot: string, iteration: number): BetaSweepSummary | null {
  const file = path.join(proposalResultsDir(dreamRoot, iteration), "beta_sweep.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BetaSweepSummary>;
    if (typeof parsed.auc !== "number" || typeof parsed.pareto_reward !== "number") return null;
    return {
      auc: parsed.auc,
      pareto_reward: parsed.pareto_reward,
      parallel_penalty: typeof parsed.parallel_penalty === "number" ? parsed.parallel_penalty : 0,
      frontier: Array.isArray(parsed.frontier) ? parsed.frontier : [],
    };
  } catch {
    return null;
  }
}
