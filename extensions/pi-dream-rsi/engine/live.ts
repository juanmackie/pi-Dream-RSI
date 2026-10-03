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

import { copyWorkspace, childIdentity, stopRecoveredChild, runAgent, runShellCommand, type CommandResult } from "../agent/runner.ts";
import { DiscoveryTree, isOpened, type TreeNode } from "./tree.ts";
import { loadPrompt, renderPrompt } from "./prompt.ts";
import { runPolicy } from "../policy/runner.ts";
import type { EpisodeResult } from "../policy/api.ts";
import type { ProbeFn, RevealedNode } from "../policy/host.ts";
import type { TaskConfig } from "./task.ts";
import { runningIterations } from "../state.ts";
import { checkpointPath } from "./checkpoint.ts";
import { allocator, acquirePhase, dreamIsActive } from "./ownership.ts";
import { ProgressRecorder, readProgress, type ProgressObserver } from "./progress.ts";
import { readCheckpoint, saveCheckpoint, validateCheckpoint, freezePolicy, snapshotSeed, workspaceHash,
  type LiveCheckpoint, type PendingAttempt, type PreparedAttempt } from "./checkpoint.ts";
import { normalizeTask, scoringFingerprint } from "./task.ts";
import {
  archiveAttempt,
  writeJsonl,
  iterationDir,
  currentManifestPath,
  readJson,
  writeFileAtomic,
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
  resume?: boolean;
  onProgress?: ProgressObserver;
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

export async function runLiveEpisode(rawOptions: LiveEpisodeOptions): Promise<LiveEpisodeResult> {
  const release = allocator(rawOptions.dreamRoot, () => {
    if (dreamIsActive(rawOptions.dreamRoot)) throw new Error("a dream phase owns this project");
    if (runningIterations(rawOptions.dreamRoot).filter((i) => i !== rawOptions.iteration).length >= normalizeTask(rawOptions.task).max_loops) throw new Error("project max_loops budget is already in use");
    const release = acquirePhase(rawOptions.dreamRoot, `live-${rawOptions.iteration}`, rawOptions.owner);
    if (!rawOptions.resume && fs.existsSync(checkpointPath(rawOptions.dreamRoot, rawOptions.iteration))) {
      release(); throw new Error("this cycle already has a checkpoint; use resume or a new iteration");
    }
    return release;
  });
  const control = new AbortController();
  const abort = (): void => control.abort();
  rawOptions.signal?.addEventListener("abort", abort, { once: true });
  if (rawOptions.signal?.aborted) abort();
  try { return await runOwnedLiveEpisode({ ...rawOptions, signal: control.signal }, control); }
  catch (error) {
    // A failed checkpoint write aborts execution; the last durable checkpoint remains recoverable.
    let recoverable = false;
    try {
      const cp = readCheckpoint(rawOptions.dreamRoot, rawOptions.iteration);
      recoverable = true;
      if (cp.status !== "complete") {
        cp.status = "interrupted"; cp.manifest.status = "interrupted";
        cp.manifest.error = String(error); saveCheckpoint(rawOptions.dreamRoot, cp);
        writeCurrentManifest(rawOptions.dreamRoot, cp.manifest);
      }
    } catch { /* leave the last durable state */ }
    if (!recoverable) {
      const manifest = readJson<LiveCycleManifest>(currentManifestPath(rawOptions.dreamRoot, rawOptions.iteration));
      if (manifest) writeCurrentManifest(rawOptions.dreamRoot, { ...manifest, status: "failed", completed_at: new Date().toISOString(), error: String(error), note: String(error) });
    }
    const progress = readProgress(rawOptions.dreamRoot, rawOptions.iteration);
    if (progress) {
      progress.status = recoverable ? "interrupted" : "failed";
      writeFileAtomic(path.join(iterationDir(rawOptions.dreamRoot, rawOptions.iteration, true), "live_progress.json"), JSON.stringify(progress));
    }
    throw error;
  } finally { rawOptions.signal?.removeEventListener("abort", abort); release(); }
}

async function runOwnedLiveEpisode(rawOptions: LiveEpisodeOptions, control: AbortController): Promise<LiveEpisodeResult> {
  // Normalize at the boundary: the engine must not depend on the caller having filled in defaults.
  let cp = rawOptions.resume ? await validateCheckpoint(rawOptions.dreamRoot, rawOptions.projectDir, normalizeTask(rawOptions.task), rawOptions.iteration) : null;
  if (cp) {
    for (const batch of cp.batches) for (const pending of batch.attempts) {
      if (!pending.record && pending.process) await stopRecoveredChild(pending.process);
      pending.process = undefined;
    }
  }
  const options: LiveEpisodeOptions = cp ? { ...rawOptions, task: cp.task, grid: cp.manifest.grid,
    bakedBeta: cp.manifest.baked_beta, baselineScore: cp.manifest.baseline_score,
    previousBestScore: cp.manifest.previous_best_score } : { ...rawOptions, task: normalizeTask(rawOptions.task) };
  const { dreamRoot, projectDir, task, iteration, grid } = options;
  const log = options.log ?? (() => {});
  const abort = (): void => control.abort();
  const signal = control.signal;
  const originalPolicy = options.policyPath || liveMethodPath(dreamRoot);
  const seedWorkspace = cp?.seed ?? path.join(path.dirname(nodeWorkspace(dreamRoot, iteration, "seed")), "seed");
  const tree = cp ? DiscoveryTree.fromJSON(cp.tree) : new DiscoveryTree({ baselineScore: options.baselineScore,
    branchCount: grid.branch_count, refineCount: grid.refine_count });
  if (!cp) for (let branch = 0; branch < grid.branch_count; branch += 1) tree.addBranchSlot(branch);
  const progress = new ProgressRecorder(dreamRoot, iteration, "live", task.k1, task.workers, options.onProgress);
  const createdAt = new Date().toISOString();
  let manifest: LiveCycleManifest = cp?.manifest ?? {
    iteration,
    status: "running",
    created_at: createdAt,
    completed_at: null,
    owner: options.owner,
    baked_beta: options.bakedBeta,
    policy_version: originalPolicy,
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
  manifest = { ...manifest, status: "running", owner: options.owner, completed_at: null };
  writeCurrentManifest(dreamRoot, manifest);

  // First cycle in a project: make sure the bulky half of the state dir cannot be committed by accident.
  ensureDreamIgnore(dreamRoot);

  // Bounded retention: attempt workspaces are the bulky half of the state dir. Recorded trees and
  // attempt records are untouched, so candidates stay auditable; only the copied workspaces age out.
  const pruned = pruneWorkspaces(dreamRoot, task.work_retention, iteration);
  if (pruned.length > 0) log(`[live ${iteration}] pruned old workspaces: ${pruned.join(", ")}`);

  const promptTemplate = cp?.prompt_template ?? loadPrompt("discovery-agent.md");
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
  const basePromptVars = cp?.prompt_vars ?? {
    // Pure Dream-RSI: semantic direction guidance is deliberately empty (paper §4 ablation).
    direction_guidance: "",
    history_dir: historyDir(dreamRoot),
    baseline_dir: baselineDir(dreamRoot),
    eval_program: task.eval_program,
    problem_file: task.problem_file ? path.resolve(projectDir, task.problem_file) : "(none provided)",
    problem_section: readProblemSection(projectDir, task),
  };

  if (!cp) {
    const seedSource = path.resolve(projectDir, task.workspace);
    if (!fs.existsSync(seedSource)) throw new Error(`task workspace does not exist: ${seedSource}`);
    progress.activity("snapshotting seed workspace");
    const seedHash = await snapshotSeed(seedSource, seedWorkspace,
      [dreamRoot, ...task.copy_exclude.map((e) => path.resolve(projectDir, e))]);
    if (signal.aborted) throw new Error("live episode aborted during seed snapshot");
    const hashes = freezePolicy(originalPolicy, path.join(path.dirname(seedWorkspace), "frozen"));
    cp = { version: 1, project: path.resolve(projectDir), task, manifest, policy: Object.keys(hashes)[0], policy_hashes: hashes,
      seed: seedWorkspace, seed_hash: seedHash, prompt_template: promptTemplate, prompt_vars: basePromptVars,
      tree: tree.toJSON(), batches: [], status: "running", extra_agent_calls: 0, extra_eval_calls: 0, resumes: 0 };
  }
  const checkpoint = cp;
  const policyPath = checkpoint.policy;
  const commit = (): void => {
    manifest.attempts = tree.list().filter((n) => n.evaluated).length;
    manifest.best_score = tree.bestScore();
    checkpoint.manifest = manifest; checkpoint.tree = tree.toJSON();
    try { saveCheckpoint(dreamRoot, checkpoint); } catch (error) { abort(); throw error; }
    progress.snapshot.tree = checkpoint.tree; progress.snapshot.best = manifest.best_score;
  };
  const policyOptions = { policyPath, mode: "live" as const, maxParallelism: task.workers,
    config: { beta: options.bakedBeta }, baselineScore: options.baselineScore, grid, maxRounds: task.k1,
    budget: { attempts: grid.branch_count * grid.refine_count, rounds: task.k1 },
    signal, onStop: abort, timeoutMs: options.policyTimeoutMs ?? 24 * 60 * 60 * 1000 };
  const matches = (batch: LiveCheckpoint["batches"][number], cells: string[], round: number): boolean =>
    batch.round === round && JSON.stringify(batch.cells) === JSON.stringify(cells);
  if (options.resume && !checkpoint.final) {
    // Prove the saved request prefix matches before launching any agent or evaluator.
    let index = 0; let boundary = false; let divergence: string | null = null;
    const check = await runPolicy({ ...policyOptions, onStop: undefined, probe: async (cells, round) => {
      const batch = checkpoint.batches[index++];
      if (batch && !matches(batch, cells, round)) { divergence = `policy diverged at saved batch ${index}`; throw new Error(divergence); }
      if (!batch || batch.attempts.some((a) => !a.record)) { boundary = true; throw new Error("saved prefix verified"); }
      return batch.attempts.map((a) => a.record!);
    } });
    if (divergence || (!boundary && (!check.ok || index !== checkpoint.batches.length))) throw new Error(divergence ?? "policy could not reconstruct the saved prefix");
    checkpoint.resumes += 1;
  }
  checkpoint.status = "running";
  commit();
  progress.flush(true);

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

  const execute = async (prepared: PreparedAttempt, pending: PendingAttempt): Promise<RevealedNode> => {
    const started = Date.now();
    const resumedEvaluation = Boolean(pending.agentRun);
    const recordDir = attemptDir(dreamRoot, iteration, prepared.cell);
    log(`[live ${iteration}] round ${prepared.round}: attempt ${prepared.cell} (from ${prepared.parentCell})`);
    if (!pending.agentRun) {
      pending.stage = "agent"; pending.prepared = prepared; commit();
      progress.stage(prepared.cell, prepared.parentCell, prepared.round, "agent", pending.retry);
    }
    const agentRun = pending.agentRun ?? await runAgent({
      agent: task.agent,
      cwd: prepared.workspace,
      prompt: prepared.prompt,
      timeoutMs: task.agent_timeout_ms,
      logPath: prepared.logPath,
      signal,
      onOutput: (event) => progress.output(prepared.cell, false, event),
      onSpawn: (pid) => { pending.process = { pid, identity: childIdentity(pid) }; commit(); },
    });
    pending.process = undefined;
    if (agentRun.aborted || signal.aborted) throw new Error("attempt interrupted during generation");
    if (!pending.agentRun) {
      const snapshot = path.join(path.dirname(seedWorkspace), "agent_finished", prepared.cell);
      await copyWorkspace(prepared.workspace, snapshot);
      const snapshotHash = await workspaceHash(snapshot);
      // Publish stage + snapshot hash together after all I/O; sibling commits cannot see half a transition.
      pending.agentRun = agentRun; pending.prepared = prepared; pending.stage = "evaluation";
      pending.agent_snapshot = snapshot; pending.workspace_hash = snapshotHash; commit();
    }
    const proposalPath = path.join(prepared.workspace, "proposal.md");
    let outcome: ScoreOutcome;
    let evalRun: CommandResult | null = null;
    if (signal.aborted) throw new Error("attempt interrupted after generation");
    if (agentRun.timedOut) {
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
    } else {
      // The workspace was copied from the parent and carries its files, including the parent's score
      // file. Remove it before scoring: a scorer that fails without writing its own verdict must not
      // have the parent's success read back as this attempt's result.
      fs.rmSync(path.join(prepared.workspace, task.score_path), { force: true });
      if (resumedEvaluation) { checkpoint.extra_eval_calls += 1; commit(); }
      progress.stage(prepared.cell, prepared.parentCell, prepared.round, "evaluation", pending.retry);
      evalRun = await runShellCommand(task.score_program, {
        cwd: prepared.workspace,
        timeoutMs: task.evaluator_timeout_ms,
        logPath: path.join(recordDir, "eval.log"),
        signal,
        onOutput: (event) => progress.output(prepared.cell, true, event),
        onSpawn: (pid) => { pending.process = { pid, identity: childIdentity(pid) }; commit(); },
      });
      pending.process = undefined;
      if (evalRun.aborted || signal.aborted) throw new Error("attempt interrupted during evaluation");
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

  let batchIndex = 0;
  const probe: ProbeFn = async (cells, round) => {
    if (signal.aborted) throw new Error("live episode aborted");
    let batch = checkpoint.batches[batchIndex++];
    if (batch && !matches(batch, cells, round)) throw new Error(`policy diverged at batch ${batchIndex}`);
    if (!batch) {
      batch = { round, cells: [...cells], attempts: cells.map((cell) => ({ ...planTarget(cell), stage: "preparing", retry: 0, record: null })) };
      checkpoint.batches.push(batch);
      commit(); // Entire ordered request is durable BEFORE dispatch.
    }
    const settled = await Promise.allSettled(batch.attempts.map(async (pending) => {
      if (pending.record) {
        progress.stage(pending.cell, pending.parentCell, round, pending.record.node.error ? "failed" : "complete", pending.retry,
          pending.record.node.score ?? null, pending.record.node.error ?? null);
        return pending.record;
      }
      let prepared = pending.prepared;
      if (pending.stage !== "evaluation") {
        if (prepared) {
          pending.retry += 1; checkpoint.extra_agent_calls += 1;
          const record = attemptDir(dreamRoot, iteration, pending.cell);
          const abandoned = path.join(record, `retry_${pending.retry}`);
          fs.mkdirSync(abandoned, { recursive: true });
          const workspace = nodeWorkspace(dreamRoot, iteration, pending.cell);
          if (fs.existsSync(workspace)) fs.renameSync(workspace, path.join(abandoned, "workspace"));
          for (const name of ["agent.log", "eval.log", "prompt.md", "prepare.json"]) {
            if (fs.existsSync(path.join(record, name))) fs.renameSync(path.join(record, name), path.join(abandoned, name));
          }
        }
        pending.stage = "preparing"; pending.agentRun = undefined; commit();
        progress.stage(pending.cell, pending.parentCell, round, "preparing", pending.retry);
        try { prepared = await materialize(pending, round); }
        catch (error) {
          if (signal.aborted) throw error;
          const record = recordPrepareFailure(pending.cell, error);
          pending.record = record; pending.stage = "complete"; commit();
          progress.stage(pending.cell, pending.parentCell, round, "failed", pending.retry, null, String(error));
          return record;
        }
      } else {
        const retryIndex = checkpoint.extra_eval_calls + 1;
        const abandoned = path.join(attemptDir(dreamRoot, iteration, pending.cell), `eval_retry_${retryIndex}`);
        fs.mkdirSync(abandoned, { recursive: true });
        if (fs.existsSync(prepared!.workspace)) fs.renameSync(prepared!.workspace, path.join(abandoned, "workspace"));
        await copyWorkspace(pending.agent_snapshot!, prepared!.workspace);
        const evalLog = path.join(attemptDir(dreamRoot, iteration, pending.cell), "eval.log");
        if (fs.existsSync(evalLog)) fs.renameSync(evalLog, `${evalLog}.retry-${retryIndex}`);
        commit();
      }
      if (signal.aborted) throw new Error("live episode aborted");
      const record = await execute(prepared!, pending);
      const completedHash = await workspaceHash(prepared!.workspace);
      pending.workspace_hash = completedHash; pending.record = record; pending.stage = "complete";
      commit(); // Save completed siblings even while other attempts remain unfinished.
      progress.stage(pending.cell, pending.parentCell, round, record.node.error ? "failed" : "complete", pending.retry,
        record.node.score ?? null, record.node.error ?? null);
      return record;
    }));
    const failure = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failure) throw failure.reason;
    manifest.decision_rounds = round;
    commit(); // A batch reply is never ahead of its checkpoint.
    return settled.map((s) => (s as PromiseFulfilledResult<RevealedNode>).value);
  };
  log(`[live ${iteration}] frozen policy ${path.basename(policyPath)} beta=${options.bakedBeta} grid=${grid.branch_count}x${grid.refine_count} workers=${task.workers} k1=${task.k1}`);
  const run = checkpoint.final ?? await runPolicy({ ...policyOptions, probe });
  if (run.ok && batchIndex < checkpoint.batches.length && !checkpoint.final) throw new Error("policy ended before consuming saved batches");

  manifest = {
    ...manifest,
    status: run.ok ? "complete" : "interrupted",
    completed_at: new Date().toISOString(),
    decision_rounds: run.result?.rounds ?? manifest.decision_rounds,
    attempts: tree.list().filter((n) => n.evaluated).length,
    best_score: tree.bestScore(),
    stopped: run.result?.stopped ?? null,
    error: run.ok ? null : (run.error ?? "policy failed"),
    policy_name: run.policyName ?? manifest.policy_name,
    note: run.violations?.length ? run.violations.join("; ") : null,
  };
  checkpoint.status = run.ok ? "complete" : "interrupted";
  if (run.ok) checkpoint.final = run;
  commit();
  writeCurrentManifest(dreamRoot, manifest);
  writeJson(path.join(roundDir(dreamRoot, iteration, "live"), "tree.json"), tree.toJSON());
  writeJson(path.join(roundDir(dreamRoot, iteration, "live"), "live_cycle_manifest.json"), manifest);
  if (run.ok) {
    // The complete manifest is the publication marker; replay ignores unfinished worlds.
    writeTree(dreamRoot, iteration, tree);
    writeJsonl(path.join(roundDir(dreamRoot, iteration, "live"), "policy_execution_traces.jsonl"),
      (run.trace ?? []).map((decision) => ({ iteration, mode: "live", round: decision.round,
        prefix: decision.observed, batch: decision.batch, revealed: decision.revealed, best_after: decision.best_after })));
    if (iteration === 1 && manifest.attempts > 0) seedBaseline(dreamRoot, iteration, tree, scoringFingerprint(task));
    writeManifest(dreamRoot, manifest);
  } else {
    for (const batch of checkpoint.batches) for (const a of batch.attempts) if (!a.record)
      progress.stage(a.cell, a.parentCell, batch.round, "interrupted", a.retry);
  }
  progress.snapshot.best = tree.bestScore(); progress.snapshot.tree = tree.toJSON();
  progress.finish(manifest.status);
  log(`[live ${iteration}] ${manifest.status}: attempts=${manifest.attempts} rounds=${manifest.decision_rounds} best=${manifest.best_score} trace_pool=${tracePoolDir(dreamRoot)}`);

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
