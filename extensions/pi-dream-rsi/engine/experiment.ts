import * as fs from "node:fs";
import * as path from "node:path";

import { copyWorkspace, runAgent, runShellCommand, childOwnership, stopRecoveredChild, type CommandResult } from "../agent/runner.ts";
import type { AgentConfig, TaskConfig } from "./task.ts";
import { interpretEvaluation, readScoreFile } from "./score.ts";
import { writeFileAtomic, writeJson } from "./fsutil.ts";
import { workspaceDigest } from "./campaign-patch.ts";
import { progressFromWorld, type ProgressObserver } from "./progress.ts";
import { loadPrompt, renderPrompt } from "./prompt.ts";

export interface SearchConfig {
  version: 1;
  batchSize: number;
  exploreShare: number;
  refineTop: number;
  maxRounds: number;
  patience: number;
}

export const defaultSearchConfig: SearchConfig = {
  version: 1, batchSize: 2, exploreShare: 0.5, refineTop: 1, maxRounds: 3, patience: 1,
};

/** Stop before a dead agent can burn the whole campaign allowance. */
export const MAX_CONSECUTIVE_AGENT_ERRORS = 3;

/**
 * Count trailing attempts that failed without an edit because the agent process reported an error.
 *
 * `prior` is the streak carried in from the previous cycle. Any attempt that is not an
 * error resets it, so a healthy attempt between two errors breaks the run of errors.
 */
function consecutiveAgentErrors(world: ExperimentWorld, prior = 0): number {
  const done = world.nodes
    .filter((node) => node.stage === "done")
    .sort((a, b) => a.seq - b.seq);
  let streak = Math.max(0, prior);
  for (const node of done) {
    if (node.agentError === true && node.edited !== true) streak += 1;
    else streak = 0;
  }
  return streak;
}

export interface ExperimentAction {
  kind: "branch" | "refine";
  parent: string | null;
}

export interface ExperimentNode {
  id: string;
  parent: string | null;
  kind: "branch" | "refine";
  round: number;
  seq: number;
  stage: "planned" | "agent" | "evaluating" | "done";
  score: number | null;
  valid: boolean;
  failClass: string | null;
  timedOut: boolean;
  timeoutKind?: "wall" | "idle";
  salvaged?: boolean;
  /** The agent process reported a model/provider error (JSON mode) for this attempt. */
  agentError?: boolean;
  /** Whether the attempt changed the workspace before it ended. */
  edited?: boolean;
  cost: number;
  retries: number;
  process?: { pid: number; identity: string | null; children?: { pid: number; identity: string | null }[]; startedAt: string };
  error?: string | null;
}

export interface ExperimentWorld {
  version: 1;
  worldId?: string;
  cycle: number;
  status: "running" | "complete" | "failed" | "interrupted";
  fingerprint: string;
  config: SearchConfig;
  baseline: number;
  threshold: number;
  rounds: number;
  agentStarts: number;
  evaluatorRuns: number;
  stopped: string | null;
  nodes: ExperimentNode[];
}

function validConfig(config: SearchConfig): void {
  if (config.version !== 1 || !Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 4
    || !Number.isFinite(config.exploreShare) || config.exploreShare < 0 || config.exploreShare > 1
    || !Number.isInteger(config.refineTop) || config.refineTop < 1 || config.refineTop > 3
    || !Number.isInteger(config.maxRounds) || config.maxRounds < 1 || config.maxRounds > 6
    || !Number.isInteger(config.patience) || config.patience < 1 || config.patience > 3) {
    throw new Error("search config is outside its supported bounds");
  }
}

/** Pure action policy shared by live runs and replay. */
export function selectActions(doneNodes: ExperimentNode[], config: SearchConfig, round: number): ExperimentAction[] {
  validConfig(config);
  if (!Number.isInteger(round) || round < 1 || round > config.maxRounds) return [];
  const valid = doneNodes.filter((node) => node.valid && typeof node.score === "number")
    .sort((a, b) => (b.score as number) - (a.score as number) || a.seq - b.seq);
  if (round === 1) return Array.from({ length: config.batchSize }, () => ({ kind: "branch", parent: null }));
  const branchCount = Math.round(config.batchSize * config.exploreShare);
  const refineCount = config.batchSize - branchCount;
  const actions: ExperimentAction[] = Array.from({ length: branchCount }, () => ({ kind: "branch", parent: null }));
  const parents = valid.slice(0, config.refineTop);
  for (let index = 0; index < refineCount && parents.length > 0; index += 1) {
    actions.push({ kind: "refine", parent: parents[index % parents.length].id });
  }
  return actions;
}

export interface ExperimentOptions {
  root: string;
  projectDir: string;
  targetRoot: string;
  seedRoot: string;
  task: TaskConfig;
  cycle: number;
  worldId?: string;
  fingerprint: string;
  baseline: number;
  threshold: number;
  config: SearchConfig;
  goal?: string;
  scope?: string[];
  gates?: string[];
  historySummary?: string;
  /** Trailing non-editing agent errors from earlier cycles, so the breaker spans the campaign. */
  priorAgentErrorStreak?: number;
  signal: AbortSignal;
  agent: AgentConfig;
  resolveAgent?: (agent: AgentConfig) => AgentConfig | null;
  beforeAgentSpawn: (key: string) => void | Promise<void>;
  beforeEvaluatorSpawn: (key: string) => void | Promise<void>;
  evaluatorEnv?: Record<string, string>;
  evaluatorEnvKeys?: string[];
  maxAgentAttempts?: number;
  maxEvaluatorAttempts?: number;
  log?: (message: string) => void;
  onAgentComplete?: (result: CommandResult) => void;
  onProgress?: ProgressObserver;
}

const pad = (value: number): string => String(value).padStart(4, "0");
const idFor = (seq: number): string => `n${seq}`;
function copyExclusions(options: ExperimentOptions): string[] {
  return [path.join(options.projectDir, ".git"), path.join(options.projectDir, ".dream-rsi"), options.root];
}
export function experimentWorldPath(root: string, cycle: number): string {
  return path.join(root, "cycles", `c${pad(cycle)}`, "world.json");
}
export function experimentWorkspace(root: string, cycle: number, id: string): string {
  return path.join(root, "cycles", `c${pad(cycle)}`, "work", id);
}
export function experimentSeed(root: string, cycle: number): string {
  return path.join(root, "cycles", `c${pad(cycle)}`, "seed");
}
function attemptDirectory(root: string, cycle: number, id: string): string {
  return path.join(root, "cycles", `c${pad(cycle)}`, "attempts", id);
}

function saveWorld(file: string, world: ExperimentWorld): void {
  writeJson(file, world);
}

function readWorld(file: string): ExperimentWorld | null {
  if (!fs.existsSync(file)) return null;
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`saved experiment world is unreadable: ${file}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`saved experiment world is invalid: ${file}`);
  const world = value as Partial<ExperimentWorld>;
  if (world.version !== 1 || !Number.isSafeInteger(world.cycle) || typeof world.fingerprint !== "string"
    || !Array.isArray(world.nodes) || !Number.isFinite(world.baseline) || !Number.isFinite(world.threshold)
    || !Number.isSafeInteger(world.rounds) || !Number.isSafeInteger(world.agentStarts) || !Number.isSafeInteger(world.evaluatorRuns)
    || !["running", "complete", "failed", "interrupted"].includes(world.status ?? "")
    || !world.nodes.every((node) => node && typeof node.id === "string" && ["planned", "agent", "evaluating", "done"].includes(node.stage))) {
    throw new Error(`saved experiment world is invalid: ${file}`);
  }
  validConfig(world.config as SearchConfig);
  return world as ExperimentWorld;
}

function readText(file: string): string {
  try { return fs.readFileSync(file, "utf8").slice(0, 12_000); } catch { return ""; }
}

function summary(world: ExperimentWorld, node: ExperimentNode): string {
  if (!node.parent) return `Cycle baseline: ${world.baseline}. Goal: improve the measured result by at least ${world.threshold}.`;
  const parent = world.nodes.find((item) => item.id === node.parent);
  return `Parent ${node.parent} scored ${parent?.score ?? "invalid"}; this attempt explores its changes.`;
}

async function evaluateAttempt(options: ExperimentOptions, world: ExperimentWorld, node: ExperimentNode, file: string, workspace: string, attempt: string, timedOut: boolean, agentResult?: CommandResult): Promise<void> {
  const evidence = path.join(attempt, "attempt-evidence.json");
  const scoreFile = path.join(workspace, options.task.score_path);
  fs.rmSync(scoreFile, { force: true });
  const evalResult = await runShellCommand(options.task.score_program, {
    cwd: workspace, timeoutMs: options.task.evaluator_timeout_ms,
    logPath: path.join(attempt, "eval.log"), signal: options.signal,
    ...(options.evaluatorEnv ? { envOnly: true, env: options.evaluatorEnv, redactEnvKeys: options.evaluatorEnvKeys ?? [] } : {}),
    beforeSpawn: async () => {
      await options.beforeEvaluatorSpawn(`experiment-${options.cycle}-${node.id}`);
      world.evaluatorRuns += 1;
      saveWorld(file, world);
    },
    onSpawn: (pid) => { node.process = { ...childOwnership(pid), startedAt: new Date().toISOString() }; saveWorld(file, world); },
  });
  node.process = undefined;
  if (evalResult.aborted || options.signal.aborted) {
    node.stage = "evaluating";
    node.error = "evaluation interrupted";
    saveWorld(file, world);
    throw new Error("experiment stopped");
  }
  const outcome = interpretEvaluation(options.task, evalResult, readScoreFile(workspace, options.task));
  node.score = outcome.score;
  node.valid = outcome.valid && outcome.fail_class === "ok";
  node.failClass = outcome.fail_class;
  node.timedOut = timedOut;
  node.error = outcome.error;
  node.stage = "done";
  writeFileAtomic(evidence, `${JSON.stringify({ ...(agentResult ? { agent: agentResult } : {}), evaluation: evalResult, outcome }, null, 2)}\n`);
  saveWorld(file, world);
}

async function runAttempt(options: ExperimentOptions, world: ExperimentWorld, node: ExperimentNode, file: string): Promise<void> {
  const attempt = attemptDirectory(options.root, options.cycle, node.id);
  const workspace = experimentWorkspace(options.root, options.cycle, node.id);
  const parentWorkspace = node.parent ? experimentWorkspace(options.root, options.cycle, node.parent) : experimentSeed(options.root, options.cycle);
  fs.mkdirSync(attempt, { recursive: true });
  if (node.stage === "evaluating") {
    if (node.process) {
      await stopRecoveredChild(node.process);
      node.process = undefined;
      saveWorld(file, world);
    }
    if (!fs.existsSync(workspace)) await copyWorkspace(parentWorkspace, workspace, { exclude: copyExclusions(options) });
    await evaluateAttempt(options, world, node, file, workspace, attempt, node.timedOut);
    return;
  }
  if (node.process) {
    await stopRecoveredChild(node.process);
    node.process = undefined;
  }
  await copyWorkspace(parentWorkspace, workspace, { exclude: copyExclusions(options) });
  const excluded = options.task.copy_exclude ?? [];
  const before = workspaceDigest({ root: workspace, cycleSeedRoot: parentWorkspace, exclude: ["proposal.md", options.task.score_path, ...excluded] });
  const proposal = path.join(attempt, "proposal.md");
  const workspaceProposal = path.join(workspace, "proposal.md");
  fs.rmSync(proposal, { force: true });
  fs.rmSync(workspaceProposal, { force: true });
  const problem = options.task.problem_file ? readText(path.resolve(options.projectDir, options.task.problem_file)) : "";
  const prompt = renderPrompt(loadPrompt("discovery-agent.md"), {
    candidate_brief: `Goal: ${options.goal ?? options.task.name}\nEvaluator: ${options.task.score_program}\nMetric: ${options.task.score_field} (${options.task.higher_is_better ? "higher" : "lower"} is better)\nCorrectness gates: ${(options.gates ?? []).join(" | ") || "none"}`,
    parent_summary: `${summary(world, node)}\n${options.historySummary ?? "No earlier campaign notes."}`,
    attempt_budget: "One agent attempt. The host evaluates only after a workspace edit and a proposal.",
    scope_files: (options.scope ?? ["."]).join(", "),
    eval_program: options.task.eval_program,
    problem_section: problem ? `Problem statement:\n${problem}` : "",
    node_dir: attempt,
    history_dir: path.join(options.root, "cycles", `c${pad(options.cycle)}`, "attempts"),
  });
  fs.writeFileSync(path.join(attempt, "prompt.md"), prompt, "utf8");
  node.stage = "agent";
  node.retries += 1;
  saveWorld(file, world);
  options.onProgress?.(progressFromWorld(options.root, world));
  const command = await runAgent({
    agent: options.agent, resolveAgent: options.resolveAgent, cwd: workspace, prompt,
    timeoutMs: options.task.agent_timeout_ms, idleTimeoutMs: Math.min(options.task.agent_timeout_ms, 4 * 60 * 1000), logPath: path.join(attempt, "agent.log"), signal: options.signal,
    beforeSpawn: async () => {
      await options.beforeAgentSpawn(`experiment-${options.cycle}-${node.id}`);
      world.agentStarts += 1;
      node.cost += 1;
      saveWorld(file, world);
    },
    onSpawn: (pid) => { node.process = { ...childOwnership(pid), startedAt: new Date().toISOString() }; saveWorld(file, world); },
    onComplete: options.onAgentComplete,
  });
  const afterAgent = await command;
  node.process = undefined;
  if (afterAgent.aborted || options.signal.aborted) {
    node.stage = "agent";
    saveWorld(file, world);
    throw new Error("experiment stopped");
  }
  if (afterAgent.spawnError) {
    node.error = afterAgent.spawnError;
    saveWorld(file, world);
    throw new Error(`agent unavailable: ${afterAgent.spawnError}`);
  }
  if (!fs.existsSync(proposal) && fs.existsSync(workspaceProposal)) {
    fs.copyFileSync(workspaceProposal, proposal);
  }
  let proposed = fs.existsSync(proposal);
  const edited = workspaceDigest({ root: workspace, cycleSeedRoot: parentWorkspace, exclude: ["proposal.md", options.task.score_path, ...excluded] }) !== before;
  const evidence = path.join(attempt, "attempt-evidence.json");
  // An attempt fails when the agent process failed: a terminal assistant error, or a
  // non-zero exit. A timeout is a separate case, and a retried error that a later
  // message recovered is not a failure.
  const failedExit = !afterAgent.ok && !afterAgent.timedOut && !afterAgent.aborted;
  const agentErrored = (afterAgent.evidence?.terminalError ?? false) || failedExit;
  const agentLabel = afterAgent.effectiveAgent
    ? `command "${afterAgent.effectiveAgent.command}" model "${afterAgent.effectiveAgent.model ?? "child default"}"`
    : `command "${options.agent.command}" model "unknown"`;
  const failureReason = afterAgent.evidence?.terminalError
    ? "the agent reported a model or provider error"
    : failedExit
      ? `the agent exited with code ${afterAgent.code ?? "unknown"}`
      : null;
  node.agentError = agentErrored;
  node.edited = edited;
  if (!edited) {
    node.stage = "done"; node.valid = false;
    node.failClass = agentErrored ? "agent_error" : proposed ? "no_edit" : "no_proposal";
    node.error = agentErrored
      ? `agent process failed: ${failureReason} (${agentLabel})`
      : proposed ? "agent made no workspace changes" : "agent did not write proposal.md";
    writeFileAtomic(evidence, `${JSON.stringify({ agent: afterAgent, evaluation: null, outcome: { valid: false, fail_class: node.failClass, error: node.error } }, null, 2)}\n`);
    saveWorld(file, world); options.onProgress?.(progressFromWorld(options.root, world));
    if (agentErrored && consecutiveAgentErrors(world, options.priorAgentErrorStreak ?? 0) >= MAX_CONSECUTIVE_AGENT_ERRORS) {
      throw new Error(`blocked: ${MAX_CONSECUTIVE_AGENT_ERRORS} consecutive non-editing agent attempts failed (${agentLabel}). Check the agent command, model, and provider credentials before resuming.`);
    }
    return;
  }
  if (!proposed && afterAgent.timedOut && edited) {
    fs.writeFileSync(proposal, `Salvaged proposal: the agent timed out (${afterAgent.timeoutKind ?? "wall"}) after changing the workspace. The host will evaluate the scoped patch and correctness gates; inspect the changed files and risks before promotion.\n`, "utf8");
    proposed = true;
    node.salvaged = true;
  }
  if (!proposed) {
    node.stage = "done"; node.valid = false;
    node.failClass = agentErrored ? "agent_error" : "no_proposal";
    node.error = agentErrored
      ? `agent process failed: ${failureReason} (${agentLabel}) after editing the workspace`
      : "agent edited the workspace but did not write proposal.md";
    writeFileAtomic(evidence, `${JSON.stringify({ agent: afterAgent, evaluation: null, outcome: { valid: false, fail_class: node.failClass, error: node.error } }, null, 2)}\n`);
    saveWorld(file, world); options.onProgress?.(progressFromWorld(options.root, world)); return;
  }
  node.stage = "evaluating";
  node.timedOut = afterAgent.timedOut;
  if (afterAgent.timeoutKind) node.timeoutKind = afterAgent.timeoutKind;
  if (afterAgent.timedOut && proposed) node.salvaged = true;
  saveWorld(file, world);
  options.onProgress?.(progressFromWorld(options.root, world));
  await evaluateAttempt(options, world, node, file, workspace, attempt, afterAgent.timedOut, afterAgent);
  options.onProgress?.(progressFromWorld(options.root, world));
}

/** Execute a bounded, resumable sequence of branch/refine attempts for one campaign cycle. */
export async function runExperiment(options: ExperimentOptions): Promise<ExperimentWorld> {
  validConfig(options.config);
  const file = experimentWorldPath(options.root, options.cycle);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let world = readWorld(file);
  if (world && (world.fingerprint !== options.fingerprint || world.cycle !== options.cycle)) throw new Error("saved experiment identity changed");
  if (!world) {
    const seed = experimentSeed(options.root, options.cycle);
    if (!fs.existsSync(seed)) await copyWorkspace(options.seedRoot, seed, { exclude: copyExclusions(options) });
    world = { version: 1, ...(options.worldId ? { worldId: options.worldId } : {}), cycle: options.cycle, status: "running", fingerprint: options.fingerprint,
      config: options.config, baseline: options.baseline, threshold: options.threshold,
      rounds: 0, agentStarts: 0, evaluatorRuns: 0, stopped: null, nodes: [] };
    saveWorld(file, world);
  }
  const startingAgentStarts = world.agentStarts;
  const startingEvaluatorRuns = world.evaluatorRuns;
  let best = Math.max(options.baseline, ...world.nodes.filter((node) => node.valid && node.score !== null).map((node) => node.score as number));
  if (world.status === "complete") return world;
  let replayBest = world.baseline;
  let noGainRounds = 0;
  let pendingRound: number | null = null;
  for (let round = 1; round <= world.rounds; round += 1) {
    const roundNodes = world.nodes.filter((node) => node.round === round);
    if (roundNodes.some((node) => node.stage !== "done")) { pendingRound = round; break; }
    const priorBest = replayBest;
    replayBest = Math.max(replayBest, ...roundNodes.filter((node) => node.valid && node.score !== null).map((node) => node.score as number));
    noGainRounds = replayBest > priorBest && replayBest - priorBest >= options.threshold ? 0 : noGainRounds + 1;
  }
  const pendingRoundBest = replayBest;
  try {
    for (const node of world.nodes) {
      if (node.stage === "done") continue;
      const agentNeeded = node.stage !== "evaluating";
      const agentSpend = world.agentStarts - startingAgentStarts;
      const evaluatorSpend = world.evaluatorRuns - startingEvaluatorRuns;
      const agentLimit = options.maxAgentAttempts ?? Number.MAX_SAFE_INTEGER;
      const evaluatorLimit = options.maxEvaluatorAttempts ?? Number.MAX_SAFE_INTEGER;
      if ((agentNeeded && agentSpend >= agentLimit) || evaluatorSpend >= evaluatorLimit
        || (agentNeeded && evaluatorSpend + 1 > evaluatorLimit)) {
        world.stopped = "budget exhausted";
        node.stage = "done"; node.valid = false; node.failClass = "budget_exhausted";
        node.error = "campaign search allowance exhausted before this attempt";
        saveWorld(file, world);
        continue;
      }
      await runAttempt(options, world, node, file);
    }
    if (pendingRound !== null) {
      best = Math.max(replayBest, ...world.nodes.filter((node) => node.round === pendingRound && node.stage === "done" && node.valid && node.score !== null).map((node) => node.score as number));
      noGainRounds = best > pendingRoundBest && best - pendingRoundBest >= options.threshold ? 0 : noGainRounds + 1;
    }
    for (let round = world.rounds + 1; round <= options.config.maxRounds && noGainRounds < options.config.patience; round += 1) {
      if (options.signal.aborted) throw new Error("experiment stopped");
      const previousBest = best;
      const remainingAgents = (options.maxAgentAttempts ?? Number.MAX_SAFE_INTEGER) - (world.agentStarts - startingAgentStarts);
      const remainingEvaluators = (options.maxEvaluatorAttempts ?? Number.MAX_SAFE_INTEGER) - (world.evaluatorRuns - startingEvaluatorRuns);
      const capacity = Math.max(0, Math.min(options.config.batchSize, remainingAgents, remainingEvaluators));
      const actions = selectActions(world.nodes, options.config, round).slice(0, capacity);
      if (actions.length === 0) {
        if (capacity === 0) {
          world.stopped = "budget exhausted";
          break;
        }
        world.stopped = "no valid nodes to refine";
        break;
      }
      const firstSeq = world.nodes.length + 1;
      const planned = actions.map((action, index): ExperimentNode => ({
        id: idFor(firstSeq + index), parent: action.parent, kind: action.kind,
        round, seq: firstSeq + index, stage: "planned", score: null, valid: false,
        failClass: null, timedOut: false, cost: 0, retries: 0,
      }));
      world.nodes.push(...planned);
      world.rounds = round;
      saveWorld(file, world);
      options.onProgress?.(progressFromWorld(options.root, world));
      for (const node of planned) {
        if (options.signal.aborted) throw new Error("experiment stopped");
        const agentSpend = world.agentStarts - startingAgentStarts;
        const evaluatorSpend = world.evaluatorRuns - startingEvaluatorRuns;
        if (agentSpend >= (options.maxAgentAttempts ?? Number.MAX_SAFE_INTEGER)
          || evaluatorSpend >= (options.maxEvaluatorAttempts ?? Number.MAX_SAFE_INTEGER)) {
          world.stopped = "budget exhausted";
          node.stage = "done"; node.valid = false; node.failClass = "budget_exhausted";
          node.error = "campaign search allowance exhausted before this attempt";
          saveWorld(file, world);
          continue;
        }
        await runAttempt(options, world, node, file);
      }
      best = Math.max(best, ...world.nodes.filter((node) => node.valid && node.score !== null).map((node) => node.score as number));
      noGainRounds = best > previousBest && best - previousBest >= options.threshold ? 0 : noGainRounds + 1;
    }
    world.status = "complete";
    if (!world.stopped) world.stopped = noGainRounds >= options.config.patience ? "patience" : "round limit";
    options.onProgress?.(progressFromWorld(options.root, world));
  } catch (error) {
    world.status = options.signal.aborted ? "interrupted" : "failed";
    world.stopped = error instanceof Error ? error.message : String(error);
    throw error;
  } finally { saveWorld(file, world); }
  return world;
}
