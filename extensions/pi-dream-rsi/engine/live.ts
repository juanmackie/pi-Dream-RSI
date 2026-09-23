/**
 * Online exploration (paper §3, "Online rollout").
 *
 * One live episode runs policy `pi_t` for at most `K1` decision rounds. Each selected cell is one
 * generation-evaluation attempt: the attempt resumes its primary parent's saved workspace, a discovery
 * agent produces a candidate, and the task's fixed evaluator scores it. Batches run in parallel, so a
 * batch of `k` extends the tree by `k` children — which is why replay can count them as one round.
 *
 * The transition is stochastic (the agent may produce different outcomes from the same workspace), and
 * that is exactly why the recorded tree is later replayed instead of re-executed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { copyWorkspace, runAgent, runShellCommand, type CommandResult } from "../agent/runner.ts";
import { DiscoveryTree, isOpened, type TreeNode } from "./tree.ts";
import { loadPrompt, renderPrompt } from "./prompt.ts";
import { runPolicy } from "../policy/runner.ts";
import type { EpisodeResult } from "../policy/api.ts";
import type { ProbeFn, RevealedNode } from "../policy/host.ts";
import type { TaskConfig } from "./task.ts";
import { normalizeTask, scoringFingerprint } from "./task.ts";
import {
  archiveAttempt,
  appendJsonl,
  attemptDir,
  baselineDir,
  ensureDreamIgnore,
  historyDir,
  liveMethodPath,
  nodeWorkspace,
  pruneWorkspaces,
  roundDir,
  seedBaseline,
  tracePoolDir,
  writeCurrentManifest,
  writeJson,
  writeManifest,
  writeTree,
  workRoot,
  type LiveCycleManifest,
  type PhaseOwner,
} from "./world.ts";

export interface LiveEpisodeOptions {
  dreamRoot: string;
  projectDir: string;
  task: TaskConfig;
  iteration: number;
  policyPath: string;
  policyName?: string | null;
  bakedBeta: number;
  grid: { branch_count: number; refine_count: number };
  baselineScore: number | null;
  previousBestScore?: number | null;
  /** Wall-clock cap for the policy orchestration itself (attempts have their own timeouts). */
  policyTimeoutMs?: number;
  log?: (message: string) => void;
  signal?: AbortSignal;
  /** Project-level claim owner, so another session cannot reclaim this in-flight cycle. */
  owner?: PhaseOwner;
}

export interface LiveEpisodeResult {
  ok: boolean;
  error: string | null;
  /** The recorded discovery tree `T_t`. */
  tree: DiscoveryTree;
  manifest: LiveCycleManifest;
  result: EpisodeResult | null;
  violations: string[];
  timedOut: boolean;
}

/** Evaluation outcome for one attempt, after normalizing the task's score convention. */
export interface ScoreOutcome {
  score: number | null;
  raw_score: number | null;
  valid: boolean;
  fail_class: string;
  error: string | null;
}

/**
 * Interpret an evaluator result (pure, so the scoring rules are testable without spawning anything).
 * The evaluator owns `valid`/`fail_class`/`error`; the runner only decides what a missing field means.
 */
export function interpretEvaluation(
  task: TaskConfig,
  command: CommandResult,
  scoreJson: Record<string, unknown> | null,
): ScoreOutcome {
  if (command.timedOut) {
    return { score: null, raw_score: null, valid: false, fail_class: "timeout", error: "evaluator timed out" };
  }
  if (command.aborted) {
    return { score: null, raw_score: null, valid: false, fail_class: "cancelled", error: "evaluator cancelled" };
  }
  if (command.spawnError) {
    return { score: null, raw_score: null, valid: false, fail_class: "eval_error", error: command.spawnError };
  }
  if (!command.ok) {
    // An unsuccessful execution is not a verdict. A score file that happens to be present is not this
    // run's output (the attempt workspace inherits its parent's), so it must never validate the attempt.
    const tail = command.stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
    return {
      score: null,
      raw_score: null,
      valid: false,
      fail_class: "eval_error",
      error: `evaluator exited with code ${command.code}${tail ? `: ${tail}` : ""}`,
    };
  }
  if (!scoreJson) {
    return {
      score: null,
      raw_score: null,
      valid: false,
      fail_class: "eval_error",
      error: `evaluator wrote no ${task.score_path}`,
    };
  }
  const reportedClass = scoreJson[task.fail_class_field];
  const reportedError = scoreJson[task.error_field];
  const reportedValid = scoreJson[task.valid_field];
  const raw = scoreJson[task.score_field];
  const failClass = typeof reportedClass === "string" && reportedClass ? reportedClass : null;
  const errorText =
    typeof reportedError === "string" && reportedError.trim() !== ""
      ? reportedError
      : typeof reportedError === "object" && reportedError !== null
        ? JSON.stringify(reportedError)
        : null;

  if (failClass && failClass !== "ok") {
    return {
      score: null,
      raw_score: typeof raw === "number" ? raw : null,
      valid: reportedValid === false ? false : false,
      fail_class: failClass,
      error: errorText ?? `evaluator reported fail_class=${failClass}`,
    };
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return {
      score: null,
      raw_score: null,
      valid: false,
      fail_class: "invalid_score",
      error: `score field "${task.score_field}" is missing or not a finite number`,
    };
  }
  return {
    score: task.higher_is_better ? raw : -raw,
    raw_score: raw,
    valid: reportedValid === false ? false : true,
    fail_class: "ok",
    error: errorText,
  };
}

/** Per-attempt bookkeeping produced by the synchronous preparation step. */
interface PreparedAttempt {
  /** Cell whose outcome this attempt records: the slot itself, or the newly created child. */
  cell: string;
  parentCell: string;
  workspace: string;
  workspaceRel: string;
  prompt: string;
  promptPath: string;
  logPath: string;
  round: number;
}

export async function runLiveEpisode(rawOptions: LiveEpisodeOptions): Promise<LiveEpisodeResult> {
  // Normalize at the boundary: the engine must not depend on the caller having filled in defaults.
  const options: LiveEpisodeOptions = { ...rawOptions, task: normalizeTask(rawOptions.task) };
  const { dreamRoot, projectDir, task, iteration, grid } = options;
  const log = options.log ?? (() => {});
  const policyPath = options.policyPath || liveMethodPath(dreamRoot);
  const seedWorkspace = path.resolve(projectDir, task.workspace);
  if (!fs.existsSync(seedWorkspace)) {
    throw new Error(`task workspace does not exist: ${seedWorkspace}`);
  }

  const tree = new DiscoveryTree({
    baselineScore: options.baselineScore,
    branchCount: grid.branch_count,
    refineCount: grid.refine_count,
  });
  for (let branch = 0; branch < grid.branch_count; branch += 1) tree.addBranchSlot(branch);

  const createdAt = new Date().toISOString();
  let manifest: LiveCycleManifest = {
    iteration,
    status: "running",
    created_at: createdAt,
    completed_at: null,
    owner: options.owner,
    baked_beta: options.bakedBeta,
    policy_version: policyPath,
    policy_name: options.policyName ?? null,
    grid,
    decision_rounds: 0,
    attempts: 0,
    baseline_score: options.baselineScore,
    best_score: options.baselineScore,
    previous_best_score: options.previousBestScore ?? null,
    stopped: null,
    error: null,
    note: null,
    task_fingerprint: scoringFingerprint(task),
  };
  writeCurrentManifest(dreamRoot, manifest);

  // First cycle in a project: make sure the bulky half of the state dir cannot be committed by accident.
  ensureDreamIgnore(dreamRoot);

  // Bounded retention: attempt workspaces are the bulky half of the state dir. Recorded trees and
  // attempt records are untouched, so candidates stay auditable; only the copied workspaces age out.
  const pruned = pruneWorkspaces(dreamRoot, task.work_retention, iteration);
  if (pruned.length > 0) log(`[live ${iteration}] pruned old workspaces: ${pruned.join(", ")}`);

  const promptTemplate = loadPrompt("discovery-agent.md");
  // The discovery prompt tells every attempt to read `$baseline_dir`. On the first cycle there is no
  // baseline attempt yet, so say so where the agent will look instead of handing it a missing path.
  const baseline = baselineDir(dreamRoot);
  fs.mkdirSync(baseline, { recursive: true });
  if (!fs.existsSync(path.join(baseline, "score.json"))) {
    writeJson(path.join(baseline, "score.json"), {
      score: null,
      note:
        "No baseline attempt yet: this is the first cycle. The best valid attempt of cycle 1 becomes the floor to beat.",
    });
  }
  const basePromptVars = {
    // Pure Dream-RSI: semantic direction guidance is deliberately empty (paper §4 ablation).
    direction_guidance: "",
    history_dir: historyDir(dreamRoot),
    baseline_dir: baselineDir(dreamRoot),
    eval_program: task.eval_program,
    problem_file: task.problem_file ? path.resolve(projectDir, task.problem_file) : "(none provided)",
    problem_section: readProblemSection(projectDir, task),
  };

  /** Decide which cell records this attempt and register the new node (synchronous, no I/O). */
  const planTarget = (cell: string): { cell: string; parentCell: string; parentWorkspace: string } => {
    const parent = tree.get(cell);
    if (!parent) throw new Error(`policy selected an unknown cell: ${cell}`);
    if (!isOpened(parent)) {
      // Unopened root slot: the attempt *is* this cell, starting from the initial workspace state.
      parent.meta.tags = ["branch-root"];
      return { cell, parentCell: "root", parentWorkspace: seedWorkspace };
    }
    const attempt = parent.meta.attempt + 1;
    const child = tree.addChild(cell, parent.meta.branch, attempt, ["refine"]);
    return { cell: child.meta.cell_id, parentCell: cell, parentWorkspace: nodeWorkspace(dreamRoot, iteration, cell) };
  };

  /** Prepare the workspace and prompt for one attempt (I/O). */
  const materialize = async (target: { cell: string; parentCell: string; parentWorkspace: string }, round: number): Promise<PreparedAttempt> => {
    const prepareStarted = Date.now();
    const workspace = nodeWorkspace(dreamRoot, iteration, target.cell);
    const copyExclude = [dreamRoot, ...(task.copy_exclude ?? []).map((entry) => path.resolve(projectDir, entry))];
    await copyWorkspace(target.parentWorkspace, workspace, { exclude: copyExclude });
    const parentProposal = target.parentCell === "root" ? null : tree.get(target.parentCell)?.proposal ?? null;
    if (parentProposal) {
      const from = path.join(projectDir, parentProposal);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(workspace, "proposal.md"));
    }
    const record = attemptDir(dreamRoot, iteration, target.cell);
    fs.mkdirSync(record, { recursive: true });
    const prompt = renderPrompt(promptTemplate, { ...basePromptVars, node_dir: workspace });
    const promptPath = path.join(record, "prompt.md");
    fs.writeFileSync(promptPath, prompt, "utf8");
    const workspaceRel = path.relative(projectDir, workspace) || workspace;
    const node = tree.get(target.cell);
    if (node) {
      node.workspace = workspaceRel;
      node.proposal = path.join(workspaceRel, "proposal.md");
    }
    // Preparation-time metric: how long the copy+prompt step took, so a slow copy is visible without
    // guessing from the total attempt duration.
    const prepareMs = Date.now() - prepareStarted;
    writeJson(path.join(record, "prepare.json"), {
      cell: target.cell,
      parent_cell: target.parentCell,
      prepare_ms: prepareMs,
      copied_from: path.relative(projectDir, target.parentWorkspace) || target.parentWorkspace,
    });
    log(`[live ${iteration}] prepared ${target.cell} in ${prepareMs}ms`);
    return {
      cell: target.cell,
      parentCell: target.parentCell,
      workspace,
      workspaceRel,
      prompt,
      promptPath,
      logPath: path.join(record, "agent.log"),
      round,
    };
  };

  /** Record a failed attempt that never got as far as running an agent. */
  const recordPrepareFailure = (cell: string, error: unknown): RevealedNode => {
    const message = error instanceof Error ? error.message : String(error);
    const outcome: ScoreOutcome = { score: null, raw_score: null, valid: false, fail_class: "agent_error", error: message };
    const record = attemptDir(dreamRoot, iteration, cell);
    fs.mkdirSync(record, { recursive: true });
    fs.writeFileSync(path.join(record, "error.txt"), `agent_error: ${message}\n`, "utf8");
    const updated = tree.setOutcome(cell, {
      evaluated: true,
      valid: false,
      fail_class: outcome.fail_class,
      error: message,
      score: null,
      raw_score: null,
      duration_ms: 0,
    });
    return { cell, node: { ...updated, meta: updated.meta } };
  };

  const execute = async (prepared: PreparedAttempt): Promise<RevealedNode> => {
    const started = Date.now();
    const recordDir = attemptDir(dreamRoot, iteration, prepared.cell);
    log(`[live ${iteration}] round ${prepared.round}: attempt ${prepared.cell} (from ${prepared.parentCell})`);
    const agentRun = await runAgent({
      agent: task.agent,
      cwd: prepared.workspace,
      prompt: prepared.prompt,
      timeoutMs: task.agent_timeout_ms,
      logPath: prepared.logPath,
      signal: options.signal,
    });
    const proposalPath = path.join(prepared.workspace, "proposal.md");
    let outcome: ScoreOutcome;
    let evalRun: CommandResult | null = null;
    if (agentRun.aborted || options.signal?.aborted) {
      outcome = { score: null, raw_score: null, valid: false, fail_class: "cancelled", error: "attempt cancelled" };
    } else if (agentRun.timedOut) {
      // Say how long it ran and whether it ever printed: a silent timeout with an empty agent.log is a
      // different diagnosis (blocked before startup: session/daemon, provider queue) from a slow one.
      const seconds = Math.round(agentRun.durationMs / 100) / 10;
      const silent = (agentRun.stdoutTail + agentRun.stderrTail).trim() === "";
      outcome = {
        score: null,
        raw_score: null,
        valid: false,
        fail_class: "timeout",
        error: `discovery agent timed out after ${seconds}s${silent ? " with no output at all (empty agent.log)" : ""}`,
      };
    } else if (agentRun.spawnError) {
      outcome = { score: null, raw_score: null, valid: false, fail_class: "agent_error", error: agentRun.spawnError };
    } else if (!agentRun.ok) {
      // A crashed agent is a different diagnosis from an agent that finished and proposed nothing.
      const tail = agentRun.stderrTail.trim().split("\n").filter(Boolean).slice(-2).join(" | ");
      outcome = {
        score: null,
        raw_score: null,
        valid: false,
        fail_class: "agent_error",
        error: `agent exited with code ${agentRun.code}${tail ? `: ${tail}` : ""}`,
      };
    } else if (!fs.existsSync(proposalPath)) {
      outcome = {
        score: null,
        raw_score: null,
        valid: false,
        fail_class: "no_proposal",
        error: "agent produced no proposal.md",
      };
    } else if (options.signal?.aborted) {
      outcome = { score: null, raw_score: null, valid: false, fail_class: "cancelled", error: "attempt cancelled before evaluation" };
    } else {
      // The workspace was copied from the parent and carries its files, including the parent's score
      // file. Remove it before scoring: a scorer that fails without writing its own verdict must not
      // have the parent's success read back as this attempt's result.
      fs.rmSync(path.join(prepared.workspace, task.score_path), { force: true });
      evalRun = await runShellCommand(task.score_program, {
        cwd: prepared.workspace,
        timeoutMs: task.evaluator_timeout_ms,
        logPath: path.join(recordDir, "eval.log"),
        signal: options.signal,
      });
      outcome = interpretEvaluation(task, evalRun, readScoreFile(prepared.workspace, task));
    }
    const errorPath = path.join(recordDir, "error.txt");
    if (outcome.error) fs.writeFileSync(errorPath, `${outcome.fail_class}: ${outcome.error}\n`, "utf8");
    else fs.rmSync(errorPath, { force: true });

    const scorePath = path.join(prepared.workspace, task.score_path);
    archiveAttempt(dreamRoot, iteration, prepared.cell, {
      proposal: proposalPath,
      score: scorePath,
      error: outcome.error ? errorPath : null,
      log: prepared.logPath,
    });

    const node: Partial<TreeNode> = {
      evaluated: true,
      valid: outcome.valid,
      fail_class: outcome.fail_class,
      error: outcome.error,
      score: outcome.score,
      raw_score: outcome.raw_score,
      artifacts: [prepared.promptPath, prepared.logPath].map((p) => path.relative(projectDir, p)),
      duration_ms: Date.now() - started,
    };
    const updated = tree.setOutcome(prepared.cell, node);
    return { cell: prepared.cell, node: { ...node, meta: updated.meta } };
  };

  const probe: ProbeFn = async (cells, round) => {
    if (options.signal?.aborted) throw new Error("live episode aborted");
    return await Promise.all(
      cells.map(async (cell) => {
        let target: { cell: string; parentCell: string; parentWorkspace: string };
        try {
          target = planTarget(cell);
        } catch (error) {
          // Unknown/illegal cell from the policy: fail the run rather than inventing a node.
          throw error;
        }
        try {
          return await execute(await materialize(target, round));
        } catch (error) {
          log(`[live ${iteration}] attempt ${target.cell} failed before the agent ran: ${String(error)}`);
          return recordPrepareFailure(target.cell, error);
        }
      }),
    );
  };

  log(
    `[live ${iteration}] policy ${path.basename(policyPath)} beta=${options.bakedBeta} grid=${grid.branch_count}x${grid.refine_count} workers=${task.workers} k1=${task.k1}`,
  );
  const run = await runPolicy({
    policyPath,
    mode: "live",
    maxParallelism: task.workers,
    config: { beta: options.bakedBeta },
    baselineScore: options.baselineScore,
    grid,
    maxRounds: task.k1,
    budget: { attempts: grid.branch_count * grid.refine_count, rounds: task.k1 },
    probe,
    timeoutMs: options.policyTimeoutMs ?? 24 * 60 * 60 * 1000,
  });

  manifest = {
    ...manifest,
    status: run.ok ? "complete" : "failed",
    completed_at: new Date().toISOString(),
    decision_rounds: run.result?.rounds ?? 0,
    attempts: tree.nNonRoot,
    best_score: tree.bestScore(),
    stopped: run.result?.stopped ?? null,
    error: run.ok ? null : (run.error ?? "policy failed"),
    policy_name: run.policyName ?? manifest.policy_name,
    note: run.violations?.length ? run.violations.join("; ") : null,
  };
  writeManifest(dreamRoot, manifest);
  writeCurrentManifest(dreamRoot, manifest);
  writeTree(dreamRoot, iteration, tree);
  writeJson(path.join(roundDir(dreamRoot, iteration, "live"), "tree.json"), tree.toJSON());
  writeJson(path.join(roundDir(dreamRoot, iteration, "live"), "live_cycle_manifest.json"), manifest);
  if (run.trace) {
    appendJsonl(
      path.join(roundDir(dreamRoot, iteration, "live"), "policy_execution_traces.jsonl"),
      run.trace.map((decision) => ({
        iteration,
        mode: "live",
        round: decision.round,
        prefix: decision.observed,
        batch: decision.batch,
        revealed: decision.revealed,
        best_after: decision.best_after,
      })),
    );
  }
  if (iteration === 1 && tree.nNonRoot > 0) {
    seedBaseline(dreamRoot, iteration, tree, scoringFingerprint(task));
  }
  fs.mkdirSync(workRoot(dreamRoot), { recursive: true });
  log(
    `[live ${iteration}] done: attempts=${tree.nNonRoot} rounds=${manifest.decision_rounds} best=${manifest.best_score} (baseline ${options.baselineScore}) trace_pool=${tracePoolDir(dreamRoot)}`,
  );

  return {
    ok: run.ok,
    error: run.ok ? null : (run.error ?? "policy failed"),
    tree,
    manifest,
    result: run.result ?? null,
    violations: run.violations ?? [],
    timedOut: run.timedOut ?? false,
  };
}

/** Read the scorer's verdict file from a workspace (shared with the seed measurement). */
export function readScoreFile(workspace: string, task: TaskConfig): Record<string, unknown> | null {
  const file = path.join(workspace, task.score_path);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readProblemSection(projectDir: string, task: TaskConfig): string {
  if (!task.problem_file) return "## Problem statement\n(no problem file configured)";
  const file = path.resolve(projectDir, task.problem_file);
  if (!fs.existsSync(file)) return `## Problem statement\n(missing problem file: ${file})`;
  return `## Problem statement\n\n${fs.readFileSync(file, "utf8").trim()}`;
}
