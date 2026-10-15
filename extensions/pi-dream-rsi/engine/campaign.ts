/** Durable, bounded improve-target controller. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { copyWorkspace, runAgent, type CommandResult } from "../agent/runner.ts";
import { BUNDLED_POLICY_DIR, EXTENSION_DIR, PACKAGE_DIR } from "../layout.ts";
import { runLiveEpisode } from "./live.ts";
import { runDreamPhase } from "./dream.ts";
import { CampaignBudget, CampaignLimitError } from "./campaign-budget.ts";
import { buildCandidatePatch, patchConflicts, verifyCandidatePatch, applyCandidatePatch, reconcileCandidatePatch, runCampaignGate, type CandidatePatch } from "./campaign-patch.ts";
import { scoreSeedCopy } from "./apply.ts";
import { measureSeed, readSeedMeasurement, findCandidate, type Candidate } from "./improvements.ts";
import { normalizeTask, scoringFingerprint, type TaskConfig } from "./task.ts";
import { ensureDreamIgnore, ensurePolicyRuntime, liveMethodPath, nodeWorkspace, readManifest, readJson, writeFileAtomic, writeJson } from "./world.ts";
import { readTree } from "./world.ts";
import { acquirePhase, phaseIsActive, pidIsAlive } from "./ownership.ts";
import { checkpointPath } from "./checkpoint.ts";
import { tracePoolDir, writeCurrentManifest, type LiveCycleManifest } from "./world.ts";
import type { ProgressObserver } from "./progress.ts";

export interface CampaignLimits {
  maxCycles: number;
  maxAgentStarts: number;
  maxEvaluatorRuns: number;
  deadlineMs: number;
  plateauCycles: number;
  maxCandidatesPerCycle: number;
}

export const CAMPAIGN_MAX_EVALUATOR_TIMEOUT_MS = 5 * 60 * 1000;

export interface CampaignRuntimeDiagnostics {
  extensionDir: string;
  packageDir: string;
  packageVersion: string | null;
  campaignModule: string;
  evaluatorTimeoutCapMs: number;
}

/** Identify the loaded package copy and the timeout ceiling enforced by this runtime. */
export function campaignRuntimeDiagnostics(): CampaignRuntimeDiagnostics {
  let packageVersion: string | null = null;
  try {
    const packageJson: unknown = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"));
    if (typeof packageJson === "object" && packageJson !== null && "version" in packageJson && typeof packageJson.version === "string") {
      packageVersion = packageJson.version;
    }
  } catch {
    // Keep status available when the loaded extension directory has no readable package metadata.
  }
  return {
    extensionDir: EXTENSION_DIR,
    packageDir: PACKAGE_DIR,
    packageVersion,
    campaignModule: import.meta.url,
    evaluatorTimeoutCapMs: CAMPAIGN_MAX_EVALUATOR_TIMEOUT_MS,
  };
}

export const DEFAULT_CAMPAIGN_LIMITS: CampaignLimits = {
  maxCycles: 5,
  maxAgentStarts: 36,
  maxEvaluatorRuns: 100,
  deadlineMs: 60 * 60 * 1000,
  plateauCycles: 2,
  maxCandidatesPerCycle: 3,
};

type RunningPhase = "probe" | "baseline" | "live" | "dream" | "promote";
type CampaignState =
  | { kind: "running"; phase: RunningPhase; iteration: number | null }
  | { kind: "paused"; phase: RunningPhase; iteration: number | null; reason: string }
  | { kind: "complete"; reason: string }
  | { kind: "failed"; reason: string };

export interface CampaignRecord {
  version: 1;
  id: string;
  baseRoot: string;
  campaignRoot: string;
  projectDir: string;
  targetRoot: string;
  goal: string;
  task: TaskConfig;
  scope: string[];
  verifierInputs: string[];
  verifierIdentity: string;
  taskFingerprint: string;
  minimumGain: number;
  minimumGainSource?: "explicit" | "calibrated";
  baselineScores?: number[];
  gates?: string[];
  limits: CampaignLimits;
  startedAt: string;
  deadlineAt: string;
  completedCycles: number[];
  baselineScore?: number;
  baselineRepeatScore?: number;
  currentScore: number;
  bestScore: number;
  noGainCycles: number;
  state: CampaignState;
  pendingApply?: { iteration: number; candidate: Candidate; patch: CandidatePatch[]; before: number; after: number; transactionId: string };
}

export interface CampaignStatus {
  id: string;
  baseRoot: string;
  campaignRoot: string;
  engineRoot: string;
  projectDir: string;
  targetRoot: string;
  scope: string[];
  goal: string;
  state: CampaignState;
  limits: CampaignLimits;
  agentStarts: number;
  evaluatorRuns: number;
  completedCycles: number[];
  currentScore: number;
  bestScore: number;
  noGainCycles: number;
  startedAt: string;
  deadlineAt: string;
  effectiveEvaluatorTimeoutMs: number;
  rejections: CampaignRejection[];
}

export interface CampaignRejection {
  iteration: number;
  cell: string;
  stage: string;
  reasons: string[];
}

export interface CampaignResult extends CampaignStatus {
  stopped: boolean;
  stopReason: string;
}

export interface CampaignOptions {
  /** The normal `.dream-rsi` container; each campaign is isolated under its `campaigns/` child. */
  baseRoot: string;
  projectDir: string;
  task: TaskConfig;
  goal: string;
  scope?: string[];
  verifierInputs?: string[];
  minimumGain?: number;
  gates?: string[];
  limits?: Partial<CampaignLimits>;
  max_cycles?: number;
  max_agent_starts?: number;
  max_evaluator_runs?: number;
  maxCycles?: number;
  maxAgentStarts?: number;
  maxEvaluatorRuns?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Inner live/dream progress from the isolated engine root, including its cycle and worker attempts. */
  onPhaseProgress?: ProgressObserver;
  onUpdate?: (status: CampaignStatus) => void;
  log?: (message: string) => void;
}

export interface CampaignCheckRun {
  durationMs: number;
  code: number | null;
  valid: boolean;
  failClass: string;
  score: number | null;
  error: string | null;
}

export interface CampaignCheckReport {
  checkedAt: string;
  runs: CampaignCheckRun[];
  spread: number | null;
  recommendedEvaluatorTimeoutMs: number;
  recommendedMinimumGain: number;
  diagnoses: string[];
  gateRuns: { command: string; code: number | null; passed: boolean; error: string | null }[];
  reportPath: string;
}

export interface CampaignCheckOptions {
  baseRoot: string;
  projectDir: string;
  task: TaskConfig;
  verifierInputs?: string[];
  gates?: string[];
  runs?: number;
  signal?: AbortSignal;
}

export interface CampaignResumeOptions {
  baseRoot: string;
  projectDir: string;
  sessionId?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onPhaseProgress?: ProgressObserver;
  onUpdate?: (status: CampaignStatus) => void;
  log?: (message: string) => void;
}

const stateFile = (root: string): string => path.join(root, "campaign.json");
const activeFile = (baseRoot: string): string => path.join(baseRoot, "campaigns", "active.json");
const activeControllers = new Map<string, AbortController>();

function persist(record: CampaignRecord): void { writeFileAtomic(stateFile(record.campaignRoot), `${JSON.stringify(record, null, 2)}\n`, true); }
function readRecord(root: string): CampaignRecord | null {
  const parsed = readJson<CampaignRecord>(stateFile(root));
  if (!parsed || parsed.version !== 1 || !parsed.id || !parsed.campaignRoot || !parsed.projectDir || !parsed.task) return null;
  return parsed;
}
function activeRoot(baseRoot: string): string | null {
  const pointerPath = activeFile(baseRoot);
  if (!fs.existsSync(pointerPath)) return null;
  const pointer = readJson<{ id?: string }>(pointerPath);
  if (!pointer || typeof pointer.id !== "string" || !/^[a-f0-9-]{16,64}$/i.test(pointer.id)) throw new Error("active campaign pointer is malformed; refusing to treat the campaign as absent");
  const root = path.resolve(baseRoot, "campaigns", pointer.id);
  const record = path.dirname(root) === path.resolve(baseRoot, "campaigns") ? readRecord(root) : null;
  if (!record || record.id !== pointer.id || path.resolve(record.campaignRoot) !== root || path.resolve(record.baseRoot) !== path.resolve(baseRoot)) {
    throw new Error("active campaign record is unreadable or inconsistent; refusing to treat the campaign as absent");
  }
  return root;
}
function readRejections(root: string): CampaignRejection[] {
  const file = path.join(root, "history", "rejections.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      if (!Number.isSafeInteger(item.iteration) || typeof item.cell !== "string" || typeof item.stage !== "string" || !Array.isArray(item.reasons)) return [];
      const reasons = item.reasons.filter((reason): reason is string => typeof reason === "string");
      return [{ iteration: item.iteration as number, cell: item.cell, stage: item.stage, reasons }];
    } catch { return []; }
  }).slice(-3);
}

function statusOf(record: CampaignRecord): CampaignStatus {
  const budget = new CampaignBudget(record.campaignRoot, record.limits.maxAgentStarts, record.limits.maxEvaluatorRuns).read();
  return {
    id: record.id, baseRoot: record.baseRoot, campaignRoot: record.campaignRoot, engineRoot: record.campaignRoot,
    projectDir: record.projectDir, targetRoot: record.targetRoot, scope: record.scope, goal: record.goal,
    state: record.state, limits: record.limits, agentStarts: budget.agent_starts, evaluatorRuns: budget.evaluator_runs,
    completedCycles: record.completedCycles, currentScore: record.currentScore, bestScore: record.bestScore,
    noGainCycles: record.noGainCycles, startedAt: record.startedAt, deadlineAt: record.deadlineAt,
    effectiveEvaluatorTimeoutMs: record.task.evaluator_timeout_ms,
    rejections: readRejections(record.campaignRoot),
  };
}
function emit(record: CampaignRecord, options: Pick<CampaignOptions, "onProgress" | "onUpdate">): void {
  options.onUpdate?.(statusOf(record));
}
function writeActive(baseRoot: string, id: string): void { writeFileAtomic(activeFile(baseRoot), `${JSON.stringify({ id })}\n`, true); }
function assertNotAborted(signal: AbortSignal): void { if (signal.aborted) throw new Error("campaign stopped"); }
function assertVerifierIdentity(record: CampaignRecord): void {
  if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? []) !== record.verifierIdentity) {
    throw new Error("task/evaluator identity changed during campaign; refusing incomparable results");
  }
}

function hashInputs(projectDir: string, task: TaskConfig, inputs: string[], gates: string[] = []): string {
  const hash = crypto.createHash("sha256");
  const contract = {
    task: scoringFingerprint(task), score_program: task.score_program, score_path: task.score_path,
    fields: [task.score_field, task.valid_field, task.fail_class_field, task.error_field],
    direction: task.higher_is_better, evaluatorTimeout: task.evaluator_timeout_ms, copyExclude: [...task.copy_exclude].sort(),
  };
  hash.update(JSON.stringify(contract));
  // Keep the version-1 identity byte-for-byte stable for records written before gates existed.
  if (gates.length > 0) hash.update(`\0gates\0${JSON.stringify(gates)}`);
  const declared = new Set(inputs.map((file) => path.normalize(file)));
  if (task.problem_file) declared.add(path.normalize(task.problem_file));
  const visit = (root: string, file: string): void => {
    const absolute = path.resolve(root, file);
    hash.update(`\0${path.relative(projectDir, absolute)}\0`);
    if (!fs.existsSync(absolute)) { hash.update("missing"); return; }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`verifier input may not be a symbolic link: ${file}`);
    if (stat.isDirectory()) {
      hash.update("directory");
      for (const name of fs.readdirSync(absolute).sort()) visit(root, path.join(file, name));
    } else if (stat.isFile()) { hash.update("file"); hash.update(fs.readFileSync(absolute)); }
    else throw new Error(`unsupported verifier input: ${file}`);
  };
  for (const input of [...declared].sort()) visit(projectDir, input);
  return hash.digest("hex");
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertTrustedVerifier(projectDir: string, targetRoot: string, baseRoot: string, task: TaskConfig, inputs: string[]): void {
  if (inputs.length === 0) throw new Error("campaign requires declared verifier_inputs outside the editable workspace so the evaluator and its data stay pinned");
  const trustedRoot = fs.existsSync(baseRoot) ? fs.realpathSync(baseRoot) : path.resolve(baseRoot);
  const canonicalProject = fs.realpathSync(projectDir);
  for (const input of inputs) {
    const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(projectDir, input);
    if (!fs.existsSync(absolute)) throw new Error(`verifier input is missing: ${input}`);
    const realInput = fs.realpathSync(absolute);
    if (!path.isAbsolute(input)) {
      const projectRelative = path.relative(canonicalProject, realInput);
      if (projectRelative === ".." || projectRelative.startsWith(`..${path.sep}`) || path.isAbsolute(projectRelative)) throw new Error(`relative verifier input must stay inside the project directory: ${input}`);
    }
    const isProtected = contains(trustedRoot, realInput) && path.resolve(realInput) !== path.resolve(trustedRoot) && !contains(path.join(trustedRoot, "campaigns"), realInput);
    if (contains(targetRoot, realInput) && !isProtected) {
      throw new Error(`verifier input must be outside the editable task workspace: ${input}`);
    }
  }
  if (task.problem_file) {
    const problem = path.resolve(projectDir, task.problem_file);
    const protectedProblem = contains(trustedRoot, problem) && path.resolve(problem) !== path.resolve(trustedRoot) && !contains(path.join(trustedRoot, "campaigns"), problem);
    if (contains(targetRoot, problem) && !protectedProblem) throw new Error("problem_file must be outside the editable task workspace or stored in the protected verifier subtree");
  }
  const tokens = task.score_program.match(/"[^"\n]+"|'[^'\n]+'|[^\s]+/g) ?? [];
  const declared = inputs.map((input) => path.isAbsolute(input) ? path.resolve(input) : path.resolve(projectDir, input));
  let pinnedCode = false;
  for (const [index, raw] of tokens.entries()) {
    const token = raw.replace(/^(["'])(.*)\1$/, "$2").replace(/^--[^=]+=\s*/, "");
    if (/^-(?:c|e|command|encodedcommand)$/i.test(token)) throw new Error("campaign scoring commands cannot embed inline code; use a declared immutable evaluator wrapper");
    if (!token || token.startsWith("-")) continue;
    if (index > 0 && tokens[index - 1]?.match(/^-(?:c|e|command|encodedcommand)$/i)) {
      throw new Error("campaign scoring commands cannot embed inline code; use a declared immutable evaluator wrapper");
    }
    const looksLikePath = path.isAbsolute(token) || token.startsWith(".") || token.includes("/") || token.includes("\\") || /\.(?:mjs|cjs|js|ts|tsx|py|sh|ps1|rb|pl)$/i.test(token);
    if (!looksLikePath) continue;
    const absolute = path.isAbsolute(token) ? path.resolve(token) : path.resolve(targetRoot, token);
    const relative = path.relative(targetRoot, absolute);
    if ((relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) && fs.existsSync(absolute) && !contains(trustedRoot, absolute)) {
      throw new Error(`score_program references evaluator code inside the editable workspace (${token}); move it outside the workspace and declare it in verifier_inputs`);
    }
    if (index > 0 && fs.existsSync(absolute) && /\.(?:mjs|cjs|js|ts|tsx|py|sh|ps1|rb|pl|json|ya?ml|toml|csv|txt)$/i.test(absolute)) {
      const covered = declared.some((input) => {
        const rel = path.relative(input, absolute);
        return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
      });
      if (!covered) throw new Error(`evaluator asset must be listed in verifier_inputs: ${path.relative(projectDir, absolute)}`);
      if (/\.(?:mjs|cjs|js|ts|tsx|py|sh|ps1|rb|pl)$/i.test(absolute)) pinnedCode = true;
    }
    if (index === 0 && path.isAbsolute(token) && fs.existsSync(absolute) && declared.some((input) => input === absolute)) pinnedCode = true;
  }
  if (!pinnedCode) throw new Error("campaign score_program must invoke a declared immutable script or executable; ambiguous/module-only commands are unsupported");
}

function relativeEvaluatorPathDiagnoses(task: TaskConfig, targetRoot: string): string[] {
  const diagnoses: string[] = [];
  const tokens = task.score_program.match(/"[^"\n]+"|'[^'\n]+'|[^\s]+/g) ?? [];
  for (const raw of tokens) {
    const token = raw.replace(/^("|')(.*)\1$/, "$2").replace(/^--[^=]+=\s*/, "");
    const looksLikePath = !path.isAbsolute(token) && (token.startsWith(".") || token.includes("/") || token.includes("\\") || /\.(?:mjs|cjs|js|ts|tsx|py|sh|ps1|rb|pl)$/i.test(token));
    if (!looksLikePath) continue;
    const targetPath = path.resolve(targetRoot, token);
    const scratchRoot = path.join(os.tmpdir(), "dream-rsi-check-workspace");
    const scratchPath = path.resolve(scratchRoot, token);
    if (!contains(scratchRoot, scratchPath) && (fs.existsSync(targetPath) || token.split(/[\\/]+/).includes(".."))) {
      diagnoses.push(`score_program path ${token} resolves from the target but escapes the scratch copy; use an absolute path`);
      break;
    }
  }
  return diagnoses;
}

/** Check an evaluator without creating a campaign or writing seed history. */
export async function checkCampaignEvaluator(options: CampaignCheckOptions): Promise<CampaignCheckReport> {
  const projectDir = fs.realpathSync(options.projectDir);
  const baseRoot = path.resolve(options.baseRoot);
  if (path.basename(baseRoot).toLowerCase() !== ".dream-rsi") throw new Error("campaign baseRoot must be the project's canonical .dream-rsi directory");
  const task = normalizeTask(options.task);
  const requestedTimeoutMs = task.evaluator_timeout_ms;
  task.evaluator_timeout_ms = Math.min(task.evaluator_timeout_ms, CAMPAIGN_MAX_EVALUATOR_TIMEOUT_MS);
  const targetRoot = fs.realpathSync(path.resolve(projectDir, task.workspace));
  const verifierInputs = [...new Set(options.verifierInputs ?? [])].sort();
  const gates = [...(options.gates ?? [])];
  const runs = options.runs ?? 3;
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 5) throw new Error("check runs must be an integer between 1 and 5");
  if (gates.some((gate) => typeof gate !== "string" || gate.trim() === "")) throw new Error("gate commands must be non-empty strings");
  assertTrustedVerifier(projectDir, targetRoot, baseRoot, task, verifierInputs);
  const diagnoses = relativeEvaluatorPathDiagnoses(task, targetRoot);
  if (requestedTimeoutMs > CAMPAIGN_MAX_EVALUATOR_TIMEOUT_MS) diagnoses.push(`requested evaluator timeout was capped at ${CAMPAIGN_MAX_EVALUATOR_TIMEOUT_MS / 1000} s`);
  const checkDir = path.join(baseRoot, "checks");
  const scratchParent = os.tmpdir();
  const runResults: CampaignCheckRun[] = [];
  for (let index = 0; index < runs; index += 1) {
    if (options.signal?.aborted) throw new Error("evaluator check was cancelled");
    const commandCapture: { value?: CommandResult } = {};
    const outcome = await scoreSeedCopy({
      dreamRoot: baseRoot,
      projectDir,
      task,
      scratch: path.join(scratchParent, `dream-rsi-check-${crypto.randomUUID()}`),
      logPath: null,
      evaluatorKey: `check:${index}`,
      signal: options.signal,
      onCommand: (result) => { commandCapture.value = result; },
      exclude: contains(targetRoot, baseRoot) ? [baseRoot] : [],
    });
    runResults.push({
      durationMs: commandCapture.value?.durationMs ?? 0,
      code: commandCapture.value?.code ?? null,
      valid: outcome.valid && outcome.fail_class === "ok" && outcome.error === null && typeof outcome.score === "number" && Number.isFinite(outcome.score),
      failClass: outcome.fail_class,
      score: outcome.score,
      error: outcome.error,
    });
  }
  const validScores = runResults.flatMap((run) => run.valid && run.score !== null ? [run.score] : []);
  const spread = validScores.length === runResults.length ? Math.max(...validScores) - Math.min(...validScores) : null;
  const maxDuration = Math.max(...runResults.map((run) => run.durationMs));
  const recommendedEvaluatorTimeoutMs = Math.max(30_000, Math.min(CAMPAIGN_MAX_EVALUATOR_TIMEOUT_MS, Math.ceil(maxDuration * 3)));
  const recommendedMinimumGain = spread === null || spread === 0 ? 0 : spread * 1.5;
  if (runResults.some((run) => run.code === 127 || run.code === 9009 || (run.code === 1 && /not found|not recognized|cannot find|is not recognized/i.test(run.error ?? "")))) {
    diagnoses.push("interpreter not found on PATH; on Windows prefer node …");
  }
  if (runResults.some((run) => run.durationMs >= task.evaluator_timeout_ms * 0.8 || run.failClass === "timeout")) {
    diagnoses.push(`evaluator takes ${Math.ceil(maxDuration / 1000)} s; the cap is 300 s; reduce cases or raise evaluator_timeout_ms`);
  }
  if (runResults.some((run) => !run.valid) && diagnoses.length === 0) diagnoses.push("evaluator did not produce a valid score on the unchanged target");
  const gateRuns: CampaignCheckReport["gateRuns"] = [];
  for (const [index, gate] of gates.entries()) {
    if (options.signal?.aborted) throw new Error("evaluator check was cancelled");
    const result = await runCampaignGate({
      sourceRoot: targetRoot,
      scratch: path.join(scratchParent, `dream-rsi-check-gate-${crypto.randomUUID()}`),
      command: gate,
      timeoutMs: task.evaluator_timeout_ms,
      key: `check-gate:${index}`,
      signal: options.signal,
    });
    gateRuns.push({ command: gate, code: result.result.code, passed: result.passed, error: result.result.stderrTail || result.result.spawnError });
    if (!result.passed) diagnoses.push(`gate failed on the unchanged target: ${gate}`);
  }
  const checkedAt = new Date().toISOString();
  fs.mkdirSync(checkDir, { recursive: true });
  const reportPath = path.join(checkDir, `${checkedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.json`);
  const report: CampaignCheckReport = { checkedAt, runs: runResults, spread, recommendedEvaluatorTimeoutMs, recommendedMinimumGain, diagnoses, gateRuns, reportPath };
  writeJson(reportPath, report);
  return report;
}

function effectiveLimits(options: CampaignOptions): CampaignLimits {
  const requested: Partial<CampaignLimits> = {
    ...options.limits,
    ...(options.max_cycles !== undefined ? { maxCycles: options.max_cycles } : {}),
    ...(options.max_agent_starts !== undefined ? { maxAgentStarts: options.max_agent_starts } : {}),
    ...(options.max_evaluator_runs !== undefined ? { maxEvaluatorRuns: options.max_evaluator_runs } : {}),
    ...(options.maxCycles !== undefined ? { maxCycles: options.maxCycles } : {}),
    ...(options.maxAgentStarts !== undefined ? { maxAgentStarts: options.maxAgentStarts } : {}),
    ...(options.maxEvaluatorRuns !== undefined ? { maxEvaluatorRuns: options.maxEvaluatorRuns } : {}),
  };
  const limits = { ...DEFAULT_CAMPAIGN_LIMITS, ...requested };
  for (const [key, value] of Object.entries(limits)) {
    const max = DEFAULT_CAMPAIGN_LIMITS[key as keyof CampaignLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key} must be an integer between 1 and ${max}`);
  }
  return limits;
}

function setPhase(record: CampaignRecord, phase: RunningPhase, iteration: number | null, options: Pick<CampaignOptions, "onProgress" | "onUpdate">): void {
  record.state = { kind: "running", phase, iteration };
  persist(record); emit(record, options);
  options.onProgress?.(iteration === null ? phase : `${phase} cycle ${iteration}`);
}

function configureIsolatedEngine(root: string, task: TaskConfig): void {
  fs.mkdirSync(root, { recursive: true });
  ensurePolicyRuntime(root, BUNDLED_POLICY_DIR);
  const bundledMethod = path.join(BUNDLED_POLICY_DIR, "method.ts");
  const method = fs.readFileSync(bundledMethod, "utf8").replace(/default_beta\s*=\s*0\.6\s*;/, `default_beta = ${task.default_beta};`);
  fs.writeFileSync(liveMethodPath(root), method, "utf8");
  writeJson(path.join(root, "task.json"), task);
  ensureDreamIgnore(root);
}

function makeBudget(record: CampaignRecord, createIfMissing = false): CampaignBudget {
  return new CampaignBudget(record.campaignRoot, record.limits.maxAgentStarts, record.limits.maxEvaluatorRuns, createIfMissing);
}

function withinDeadline(record: CampaignRecord): boolean { return Date.now() < Date.parse(record.deadlineAt); }

async function runProbe(record: CampaignRecord, reserve: (kind: "agent" | "evaluator", key: string) => void, signal: AbortSignal, log: (message: string) => void): Promise<void> {
  const task = record.task;
  const scratch = path.join(record.campaignRoot, "probe-workspace");
  try {
    const exclude = [path.join(record.projectDir, ".git")];
    if (contains(record.targetRoot, record.baseRoot)) exclude.push(record.baseRoot);
    await copyWorkspace(record.targetRoot, scratch, { exclude });
    const result = await runAgent({
      agent: task.agent,
      cwd: scratch,
      prompt: `Inspect this project for the improvement goal below. Do not change files. Reply with one short sentence confirming you can inspect the target and identify the relevant code.\n\nGoal: ${record.goal}`,
      timeoutMs: Math.min(task.agent_timeout_ms, 8 * 60 * 1000),
      logPath: path.join(record.campaignRoot, "probe.log"),
      signal,
      beforeSpawn: () => reserve("agent", "campaign-probe"),
    });
    if (!result.ok || result.timedOut || result.aborted) throw new Error(`campaign intake probe failed: ${result.spawnError ?? result.stderrTail ?? `exit ${result.code}`}`);
    log(`[probe] ${result.stdoutTail.trim().slice(-400)}`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

function candidatesFor(root: string, iteration: number, task: TaskConfig, projectDir: string): Candidate[] {
  const tree = readTree(root, iteration);
  if (!tree) return [];
  return tree.list()
    .filter((node) => typeof node.score === "number" && node.fail_class === "ok" && node.error === null)
    .sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY))
    .map((node) => findCandidate(root, task, projectDir, iteration, node.meta.cell_id))
    .filter((candidate): candidate is Candidate => candidate !== null && candidate.workspace !== null && candidate.program !== null)
    .slice(0, DEFAULT_CAMPAIGN_LIMITS.maxCandidatesPerCycle);
}

function saveApplied(record: CampaignRecord, pending: NonNullable<CampaignRecord["pendingApply"]>, receipt: { written: string[]; backupDir: string }): void {
  const records = path.join(record.campaignRoot, "history", "applied.jsonl");
  fs.mkdirSync(path.dirname(records), { recursive: true });
  const previous = fs.existsSync(records) ? fs.readFileSync(records, "utf8").split(/\r?\n/).filter(Boolean) : [];
  if (previous.some((line) => { try { const item = JSON.parse(line) as { campaign_transaction?: string }; return item.campaign_transaction === pending.transactionId; } catch { return false; } })) return;
  fs.appendFileSync(records, `${JSON.stringify({
    iteration: pending.iteration, cell: pending.candidate.cell, score: pending.after, candidate_score: pending.candidate.score,
    before_score: pending.before, verified: true, fingerprint: scoringFingerprint(record.task), applied_at: new Date().toISOString(),
    paths: receipt.written, target: record.targetRoot, backup: path.relative(record.projectDir, receipt.backupDir), campaign_transaction: pending.transactionId,
  })}\n`, "utf8");
}

function rejectCandidate(record: CampaignRecord, iteration: number, cell: string, stage: string, reasons: string[]): void {
  const file = path.join(record.campaignRoot, "history", "rejections.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ iteration, cell, stage, reasons })}\n`, "utf8");
}

function scoresAreNoisy(record: CampaignRecord): boolean {
  const scores = record.baselineScores ?? [record.baselineScore, record.baselineRepeatScore].filter((score): score is number => typeof score === "number");
  return scores.length > 1 && Math.max(...scores) > Math.min(...scores);
}

async function promoteCandidates(record: CampaignRecord, iteration: number, reserve: (kind: "agent" | "evaluator", key: string) => void, signal: AbortSignal, log: (message: string) => void): Promise<boolean> {
  const noisy = scoresAreNoisy(record);
  const maxCandidates = noisy ? Math.min(2, record.limits.maxCandidatesPerCycle) : record.limits.maxCandidatesPerCycle;
  const candidates = candidatesFor(record.campaignRoot, iteration, record.task, record.projectDir).slice(0, maxCandidates);
  const seedRoot = nodeWorkspace(record.campaignRoot, iteration, "seed");
  const workspaceAbsolute = path.resolve(record.projectDir, record.task.workspace);
  const workspaceRelativeInputs = record.verifierInputs.map((item) => path.relative(workspaceAbsolute, path.resolve(record.projectDir, item)))
    .filter((item) => item !== ".." && !item.startsWith(`..${path.sep}`) && !path.isAbsolute(item));
  const excluded = new Set(workspaceRelativeInputs.map((item) => item.replace(/\\/g, "/").toLowerCase()));
  for (const candidate of candidates) {
    assertNotAborted(signal);
    if (!withinDeadline(record)) return false;
    if (candidate.score <= record.currentScore + record.minimumGain) {
      rejectCandidate(record, iteration, candidate.cell, "candidate-score", [`candidate score ${candidate.score} did not exceed current score ${record.currentScore} plus minimum gain ${record.minimumGain}`]);
      continue;
    }
    const workspaceAbsolute = path.resolve(record.projectDir, record.task.workspace);
    const declaredVerifierFiles = record.verifierInputs.map((item) => path.relative(workspaceAbsolute, path.resolve(record.projectDir, item)))
      .filter((item) => item !== ".." && !item.startsWith(`..${path.sep}`) && !path.isAbsolute(item));
    const workspaceCopyExcludes = record.task.copy_exclude.map((item) => path.relative(workspaceAbsolute, path.resolve(record.projectDir, item)))
      .filter((item) => item !== "" && item !== ".." && !item.startsWith(`..${path.sep}`) && !path.isAbsolute(item));
    const problemFile = record.task.problem_file ? path.relative(workspaceAbsolute, path.resolve(record.projectDir, record.task.problem_file)) : null;
    const patchExcludes = ["proposal.md", record.task.score_path, ...workspaceCopyExcludes, ...declaredVerifierFiles,
      ...(problemFile && problemFile !== ".." && !problemFile.startsWith(`..${path.sep}`) ? [problemFile] : [])]
      .filter((entry) => !entry.replace(/\\/g, "/").split("/").some((part) => part.toLowerCase() === ".dream-rsi" || part.toLowerCase() === ".git"));
    let patch: CandidatePatch[];
    try {
      patch = buildCandidatePatch({
        cycleSeedRoot: seedRoot, targetRoot: record.targetRoot, candidateRoot: candidate.workspace!, scope: record.scope,
        exclude: patchExcludes,
      });
    } catch (error) {
      rejectCandidate(record, iteration, candidate.cell, "patch", [error instanceof Error ? error.message : String(error)]);
      continue;
    }
    if (patch.length === 0 || patch.some((file) => [...excluded].some((input) => file.relative.toLowerCase() === input || file.relative.toLowerCase().startsWith(`${input}/`)))) {
      rejectCandidate(record, iteration, candidate.cell, "patch", ["candidate patch was empty or included a protected verifier path"]);
      continue;
    }
    if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? []) !== record.verifierIdentity) throw new Error("verifier files changed before candidate verification; scores are no longer comparable");
    const conflicts = patchConflicts({ cycleSeedRoot: seedRoot, patch });
    if (conflicts.length > 0) {
      rejectCandidate(record, iteration, candidate.cell, "patch", [`candidate conflicts with target changes: ${conflicts.join(", ")}`]);
      continue;
    }
    const evidenceDir = path.join(record.campaignRoot, "history", `r${String(iteration).padStart(4, "0")}_campaign`, candidate.cell);
    const verification = await verifyCandidatePatch({
      dreamRoot: record.campaignRoot, projectDir: record.projectDir, task: record.task, patch, evidenceDir, signal,
      beforeSpawn: (key) => reserve("evaluator", `${iteration}:${candidate.cell}:${key}`),
      repeats: noisy ? 3 : 1,
      minimumGain: record.minimumGain,
      requireValidBeforeAfter: true,
    });
    if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? []) !== record.verifierIdentity) throw new Error("verifier files changed during candidate verification; scores are no longer comparable");
    if (!verification.improved || verification.before.score === null || verification.after.score === null || verification.after.score <= record.currentScore + record.minimumGain) {
      rejectCandidate(record, iteration, candidate.cell, "verification", [verification.reason ?? `verified score ${verification.after.score} did not exceed current score ${record.currentScore} plus minimum gain ${record.minimumGain}`]);
      continue;
    }
    let gateFailure: string | null = null;
    for (const [index, command] of (record.gates ?? []).entries()) {
      const gate = await runCampaignGate({
        sourceRoot: record.targetRoot,
        scratch: path.join(os.tmpdir(), `dream-rsi-campaign-gate-${crypto.randomUUID()}`),
        command,
        timeoutMs: record.task.evaluator_timeout_ms,
        logPath: path.join(evidenceDir, `gate-${index}.log`),
        signal,
        key: `${iteration}:${candidate.cell}:gate:${index}`,
        beforeSpawn: (key) => reserve("evaluator", key),
        patch,
      });
      if (!gate.passed) {
        gateFailure = `gate exited ${gate.result.code ?? gate.result.signal ?? "without a status"}${gate.result.stderrTail ? `: ${gate.result.stderrTail.trim().slice(-300)}` : ""}`;
        break;
      }
    }
    if (gateFailure) {
      rejectCandidate(record, iteration, candidate.cell, "gate", [gateFailure]);
      continue;
    }
    if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? []) !== record.verifierIdentity) {
      throw new Error("verifier files changed during candidate gates; scores are no longer comparable");
    }
    const transactionId = `r${String(iteration).padStart(4, "0")}-${candidate.cell}-${crypto.randomUUID()}`;
    record.pendingApply = { iteration, candidate, patch, before: verification.before.score, after: verification.after.score, transactionId };
    persist(record);
    assertNotAborted(signal);
    const receipt = applyCandidatePatch({ seedRoot: record.targetRoot, patch, journalDir: path.join(record.campaignRoot, "promotion-journal"), transactionId, signal });
    saveApplied(record, record.pendingApply, receipt);
    record.currentScore = verification.medianAfter ?? verification.after.score;
    record.bestScore = Math.max(record.bestScore, record.currentScore);
    record.pendingApply = undefined;
    persist(record);
    log(`[apply] ${candidate.cell} verified ${verification.before.score} -> ${verification.after.score}; ${receipt.written.length} files`);
    return true;
  }
  return false;
}

async function reconcilePending(record: CampaignRecord): Promise<void> {
  const pending = record.pendingApply;
  if (!pending) return;
  const receipt = reconcileCandidatePatch({ journalDir: path.join(record.campaignRoot, "promotion-journal"), transactionId: pending.transactionId });
  if (receipt.state === "applied") {
    saveApplied(record, pending, { written: receipt.written, backupDir: receipt.backupDir! });
    record.currentScore = pending.after;
    record.bestScore = Math.max(record.bestScore, pending.after);
    record.pendingApply = undefined;
    persist(record);
  } else if (receipt.state === "prepared") {
    record.pendingApply = undefined;
    persist(record);
  }
}

async function execute(record: CampaignRecord, options: Pick<CampaignOptions, "signal" | "onProgress" | "onPhaseProgress" | "onUpdate" | "log">): Promise<CampaignResult> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let ownerRelease: () => void;
  try { ownerRelease = acquirePhase(record.campaignRoot, "campaign"); }
  catch (error) { options.signal?.removeEventListener("abort", abort); throw error; }
  activeControllers.set(record.campaignRoot, controller);
  const signal = controller.signal;
  const log = options.log ?? (() => {});
  const callbacks = { onProgress: options.onProgress, onUpdate: options.onUpdate };
  const budget = makeBudget(record);
  const stopFile = path.join(record.campaignRoot, "stop.request");
  fs.rmSync(stopFile, { force: true });
  let limitReason: string | null = null;
  const reserve = (kind: "agent" | "evaluator", key: string): void => {
    assertNotAborted(signal);
    assertVerifierIdentity(record);
    if (!withinDeadline(record)) {
      limitReason = `campaign deadline expired (${record.limits.deadlineMs}ms)`;
      controller.abort();
      throw new CampaignLimitError(kind, kind === "agent" ? record.limits.maxAgentStarts : record.limits.maxEvaluatorRuns);
    }
    try { budget.reserve(kind, key); }
    catch (error) {
      if (error instanceof CampaignLimitError) { limitReason = error.message; controller.abort(); }
      throw error;
    }
  };
  const stopPoll = setInterval(() => { if (fs.existsSync(stopFile)) controller.abort(); }, 250);
  const deadlineTimer = setTimeout(() => {
    limitReason = `campaign deadline expired (${record.limits.deadlineMs}ms)`;
    controller.abort();
  }, Math.max(0, Date.parse(record.deadlineAt) - Date.now()));
  try {
    await reconcilePending(record);
    const currentTaskFingerprint = scoringFingerprint(record.task);
    if (record.taskFingerprint !== currentTaskFingerprint || record.verifierIdentity !== hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? [])) {
      throw new Error("task/evaluator identity changed during campaign; refusing incomparable results");
    }
    if (!withinDeadline(record)) {
      record.state = { kind: "complete", reason: `campaign deadline expired (${record.limits.deadlineMs}ms)` };
      persist(record); emit(record, callbacks);
      return { ...statusOf(record), stopped: true, stopReason: record.state.reason };
    }
    if (!fs.existsSync(path.join(record.campaignRoot, "gates.complete"))) {
      for (const [index, command] of (record.gates ?? []).entries()) {
        const gate = await runCampaignGate({
          sourceRoot: record.targetRoot,
          scratch: path.join(os.tmpdir(), `dream-rsi-start-gate-${crypto.randomUUID()}`),
          command,
          timeoutMs: record.task.evaluator_timeout_ms,
          signal,
          key: `start-gate:${index}`,
          beforeSpawn: (key) => reserve("evaluator", key),
        });
        if (!gate.passed) throw new Error(`unchanged-target gate failed (${command}): ${gate.result.stderrTail || gate.result.spawnError || `exit ${gate.result.code}`}`);
        assertVerifierIdentity(record);
      }
      writeFileAtomic(path.join(record.campaignRoot, "gates.complete"), "ok\n", true);
    }
    if (!fs.existsSync(path.join(record.campaignRoot, "probe.complete"))) {
      setPhase(record, "probe", null, callbacks);
      try { await runProbe(record, reserve, signal, log); }
      catch (error) {
        if (limitReason) { record.state = { kind: "complete", reason: limitReason }; persist(record); return { ...statusOf(record), stopped: true, stopReason: limitReason }; }
        throw error;
      }
      writeFileAtomic(path.join(record.campaignRoot, "probe.complete"), "ok\n", true);
      record.state = { kind: "running", phase: "baseline", iteration: null }; persist(record);
    }
    if (!fs.existsSync(path.join(record.campaignRoot, "history", "seed", "score.json"))) {
      setPhase(record, "baseline", null, callbacks);
      await measureSeed({
        dreamRoot: record.campaignRoot, projectDir: record.projectDir, task: record.task, log,
        beforeEvaluatorSpawn: (key) => reserve("evaluator", key),
        signal,
        exclude: contains(record.targetRoot, record.baseRoot) ? [record.baseRoot] : [],
      });
      assertVerifierIdentity(record);
      if (limitReason) { record.state = { kind: "complete", reason: limitReason }; persist(record); return { ...statusOf(record), stopped: true, stopReason: limitReason }; }
    }
    const seed = readSeedMeasurement(record.campaignRoot);
    assertVerifierIdentity(record);
    if (!seed || seed.valid !== true || seed.fail_class !== "ok" || seed.error !== null || typeof seed.score !== "number" || !Number.isFinite(seed.score)) {
      throw new Error(`target verifier did not produce a trustworthy baseline${seed?.error ? `: ${seed.error}` : ""}`);
    }
    if (record.baselineScore === undefined) {
      record.baselineScore = seed.score;
      record.currentScore = seed.score;
      record.bestScore = seed.score;
      record.baselineScores = [seed.score];
      persist(record);
    }
    record.baselineScores ??= [record.baselineScore, ...(record.baselineRepeatScore === undefined ? [] : [record.baselineRepeatScore])];
    if (record.baselineRepeatScore === undefined) {
      setPhase(record, "baseline", null, callbacks);
      await measureSeed({
        dreamRoot: record.campaignRoot, projectDir: record.projectDir, task: record.task, log,
        beforeEvaluatorSpawn: (key) => reserve("evaluator", `${key}:repeat`),
        signal,
        exclude: contains(record.targetRoot, record.baseRoot) ? [record.baseRoot] : [],
      });
      if (limitReason) { record.state = { kind: "complete", reason: limitReason }; persist(record); return { ...statusOf(record), stopped: true, stopReason: limitReason }; }
      assertVerifierIdentity(record);
      const repeatedSeed = readSeedMeasurement(record.campaignRoot);
      if (!repeatedSeed || repeatedSeed.valid !== true || repeatedSeed.fail_class !== "ok" || repeatedSeed.error !== null || typeof repeatedSeed.score !== "number" || !Number.isFinite(repeatedSeed.score)) {
        throw new Error(`target verifier repeat did not produce a trustworthy score${repeatedSeed?.error ? `: ${repeatedSeed.error}` : ""}`);
      }
      record.baselineRepeatScore = repeatedSeed.score;
      record.baselineScores = [record.baselineScore, repeatedSeed.score];
      persist(record);
    }
    const baselineRange = Math.max(...record.baselineScores) - Math.min(...record.baselineScores);
    if (baselineRange > 0 && (record.minimumGainSource ?? "explicit") === "explicit" && baselineRange > record.minimumGain) {
      throw new Error(`target verifier repeated baseline changed by ${baselineRange}, above the configured minimum_gain tolerance ${record.minimumGain}`);
    }
    if (baselineRange > 0 && (record.minimumGainSource ?? "explicit") === "calibrated" && record.baselineScores.length < 3) {
      const third = await scoreSeedCopy({
        dreamRoot: record.campaignRoot,
        projectDir: record.projectDir,
        task: record.task,
        scratch: path.join(os.tmpdir(), `dream-rsi-calibration-${crypto.randomUUID()}`),
        logPath: null,
        evaluatorKey: "baseline:calibration",
        beforeEvaluatorSpawn: (key) => reserve("evaluator", key),
        signal,
        exclude: contains(record.targetRoot, record.baseRoot) ? [record.baseRoot] : [],
      });
      if (!third.valid || third.fail_class !== "ok" || third.error !== null || typeof third.score !== "number" || !Number.isFinite(third.score)) {
        throw new Error(`target verifier calibration did not produce a trustworthy score${third.error ? `: ${third.error}` : ""}`);
      }
      record.baselineScores.push(third.score);
      record.minimumGain = 1.5 * (Math.max(...record.baselineScores) - Math.min(...record.baselineScores));
      log(`[baseline] calibrated minimum_gain=${record.minimumGain} from ${record.baselineScores.length} measurements`);
      persist(record);
    }
    while (record.completedCycles.length < record.limits.maxCycles && record.noGainCycles < record.limits.plateauCycles) {
      assertNotAborted(signal);
      if (!withinDeadline(record)) { record.state = { kind: "complete", reason: `campaign deadline expired (${record.limits.deadlineMs}ms)` }; break; }
      const iteration = record.completedCycles.length + 1;
      if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? []) !== record.verifierIdentity) throw new Error("verifier files changed between campaign cycles; scores are no longer comparable");
      setPhase(record, "live", iteration, callbacks);
      const policyPath = liveMethodPath(record.campaignRoot);
      const manifest = readManifest(record.campaignRoot, iteration);
      const live = manifest?.status === "complete" ? { ok: true, error: null } : await runLiveEpisode({
        dreamRoot: record.campaignRoot, projectDir: record.projectDir, task: record.task, iteration,
        policyPath, bakedBeta: record.task.default_beta,
        grid: { branch_count: record.task.workers, refine_count: record.task.k1 },
        baselineScore: record.currentScore, previousBestScore: record.bestScore,
        onProgress: options.onPhaseProgress,
        resume: manifest?.status === "interrupted" || fs.existsSync(path.join(record.campaignRoot, "trace_pool", `iter${String(iteration).padStart(4, "0")}_current`, "checkpoint.json")),
        signal, workspaceExcludes: contains(record.targetRoot, record.baseRoot) ? [record.baseRoot] : [],
        beforeAgentSpawn: (key) => reserve("agent", key), beforeEvaluatorSpawn: (key) => reserve("evaluator", key),
        log,
      });
      assertVerifierIdentity(record);
      if (limitReason) { record.state = { kind: "complete", reason: limitReason }; persist(record); break; }
      if (!live.ok) throw new Error(live.error ?? `live cycle ${iteration} did not complete`);
      setPhase(record, "dream", iteration, callbacks);
      const selectionPath = path.join(record.campaignRoot, "history", `r${String(iteration).padStart(4, "0")}_dream`, "proposal_results", "selection.json");
      const dream = fs.existsSync(selectionPath) ? { ok: true, error: null } : await runDreamPhase({
        dreamRoot: record.campaignRoot, projectDir: record.projectDir, task: record.task, iteration,
        signal, log, onProgress: options.onPhaseProgress,
        beforeAgentSpawn: (key) => reserve("agent", key), beforeEvaluatorSpawn: (key) => reserve("evaluator", key),
      });
      if (limitReason) { record.state = { kind: "complete", reason: limitReason }; persist(record); break; }
      if (!dream.ok) throw new Error(dream.error ?? `dream cycle ${iteration} did not complete soundly`);
      assertVerifierIdentity(record);
      setPhase(record, "promote", iteration, callbacks);
      const before = record.currentScore;
      let applied: boolean;
      try { applied = await promoteCandidates(record, iteration, reserve, signal, log); }
      catch (error) {
        if (error instanceof CampaignLimitError && limitReason) { record.state = { kind: "complete", reason: limitReason }; break; }
        throw error;
      }
      record.completedCycles.push(iteration);
      if (applied && record.currentScore > before + record.minimumGain) record.noGainCycles = 0;
      else record.noGainCycles += 1;
      persist(record); emit(record, callbacks);
      if (record.noGainCycles >= record.limits.plateauCycles) { record.state = { kind: "complete", reason: `${record.noGainCycles} completed cycles without a verified gain` }; break; }
      if (record.completedCycles.length >= record.limits.maxCycles) { record.state = { kind: "complete", reason: "cycle limit reached" }; break; }
    }
    if (record.state.kind === "running") record.state = { kind: "complete", reason: "campaign finished" };
    persist(record); emit(record, callbacks);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (limitReason) record.state = { kind: "complete", reason: limitReason };
    else if (signal.aborted || reason === "campaign stopped") {
      const prior = record.state;
      record.state = prior.kind === "running" ? { kind: "paused", phase: prior.phase, iteration: prior.iteration, reason: "stopped by request" } : { kind: "paused", phase: "live", iteration: null, reason: "stopped by request" };
    } else if (error instanceof CampaignLimitError) record.state = { kind: "complete", reason: error.message };
    else record.state = { kind: "failed", reason };
    persist(record); emit(record, callbacks);
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(stopPoll);
    options.signal?.removeEventListener("abort", abort);
    activeControllers.delete(record.campaignRoot);
    ownerRelease();
  }
  const status = statusOf(record);
  return { ...status, stopped: status.state.kind !== "running", stopReason: status.state.kind === "complete" || status.state.kind === "failed" || status.state.kind === "paused" ? status.state.reason : "" };
}

export async function runCampaign(options: CampaignOptions): Promise<CampaignResult> {
  const baseRoot = path.resolve(options.baseRoot);
  if (path.basename(baseRoot).toLowerCase() !== ".dream-rsi") throw new Error("campaign baseRoot must be the project's canonical .dream-rsi directory");
  const releaseStart = acquirePhase(baseRoot, "campaign-start");
  try {
  const projectDir = fs.realpathSync(options.projectDir);
  const task = normalizeTask(options.task);
  if (!options.goal.trim()) throw new Error("campaign goal must not be empty");
  const targetRoot = fs.realpathSync(path.resolve(projectDir, task.workspace));
  const verifierInputs = [...new Set(options.verifierInputs ?? [])].sort();
  const gates = [...(options.gates ?? [])];
  if (gates.some((gate) => typeof gate !== "string" || gate.trim() === "")) throw new Error("gate commands must be non-empty strings");
  const pathDiagnoses = relativeEvaluatorPathDiagnoses(task, targetRoot);
  if (pathDiagnoses.length > 0) throw new Error(pathDiagnoses[0]);
  assertTrustedVerifier(projectDir, targetRoot, baseRoot, task, verifierInputs);
  const limits = effectiveLimits(options);
  const minimumGain = options.minimumGain ?? 0;
  const minimumGainSource = options.minimumGain === undefined ? "calibrated" : "explicit";
  if (!Number.isFinite(minimumGain) || minimumGain < 0) throw new Error("minimumGain must be a finite non-negative normalized-score delta");
  if (fs.existsSync(activeFile(baseRoot)) && !readCampaignStatus(baseRoot)) throw new Error("active campaign pointer exists but its record is unreadable; refusing to overwrite it");
  const existing = readCampaignStatus(baseRoot);
  if (existing && (existing.state.kind === "running" || existing.state.kind === "paused")) throw new Error("an unfinished campaign already exists; resume or stop it before starting another");
  const id = crypto.randomUUID();
  const campaignRoot = path.join(baseRoot, "campaigns", id);
  fs.mkdirSync(campaignRoot, { recursive: true });
  const started = Date.now();
  const scopedTask: TaskConfig = { ...task, workers: 2, max_loops: 1, k1: 3, k2: 4, revisions: 2, agent_timeout_ms: Math.min(task.agent_timeout_ms, 8 * 60 * 1000), evaluator_timeout_ms: Math.min(task.evaluator_timeout_ms, CAMPAIGN_MAX_EVALUATOR_TIMEOUT_MS), ...(task.workspace ? { workspace: task.workspace } : {}) };
  const verifierIdentity = hashInputs(projectDir, scopedTask, verifierInputs, gates);
  const record: CampaignRecord = {
    version: 1, id, baseRoot, campaignRoot, projectDir, targetRoot, goal: options.goal.trim(), task: scopedTask,
    scope: options.scope?.length ? [...options.scope] : ["."], verifierInputs, verifierIdentity, gates,
    taskFingerprint: scoringFingerprint(scopedTask), minimumGain, minimumGainSource, baselineScores: [], limits, startedAt: new Date(started).toISOString(), deadlineAt: new Date(started + limits.deadlineMs).toISOString(),
    completedCycles: [], currentScore: 0, bestScore: 0, noGainCycles: 0, state: { kind: "running", phase: "probe", iteration: null },
  };
  configureIsolatedEngine(campaignRoot, scopedTask);
  makeBudget(record, true);
  persist(record);
  writeActive(baseRoot, id);
  const result = execute(record, { signal: options.signal, onProgress: options.onProgress, onPhaseProgress: options.onPhaseProgress, onUpdate: options.onUpdate, log: options.log });
  releaseStart();
  return await result;
  } catch (error) {
    releaseStart();
    throw error;
  }
}

export async function resumeCampaign(options: CampaignResumeOptions): Promise<CampaignResult> {
  const root = activeRoot(path.resolve(options.baseRoot));
  if (!root) throw new Error("no saved campaign exists for this project");
  const record = readRecord(root);
  if (!record) throw new Error("saved campaign record is missing or invalid");
  if (path.resolve(options.projectDir) !== path.resolve(record.projectDir)) throw new Error("campaign target project does not match the saved campaign");
  if (record.state.kind === "complete" || record.state.kind === "failed") return { ...statusOf(record), stopped: true, stopReason: record.state.reason };
  if (!withinDeadline(record)) throw new Error("campaign deadline expired; its budget cannot be renewed");
  if (record.state.kind === "running" && phaseIsActive(record.campaignRoot, "campaign")) throw new Error("campaign is already running");
  recoverInterruptedLiveClaims(record.campaignRoot, { sessionId: options.sessionId });
  if (record.state.kind === "running") record.state = { kind: "paused", phase: record.state.phase, iteration: record.state.iteration, reason: "resuming after interrupted host process" };
  fs.rmSync(path.join(record.campaignRoot, "stop.request"), { force: true });
  return execute(record, { signal: options.signal, onProgress: options.onProgress, onPhaseProgress: options.onPhaseProgress, onUpdate: options.onUpdate, log: options.log });
}

/** Recover only stale live claims inside this campaign's isolated engine state before resuming it. */
export function recoverInterruptedLiveClaims(root: string, options: { sessionId?: string; isAlive?: (pid: number) => boolean } = {}): number[] {
  const dir = tracePoolDir(root);
  if (!fs.existsSync(dir)) return [];
  const isAlive = options.isAlive ?? pidIsAlive;
  const recovered: number[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const match = /^iter(\d+)_current$/.exec(entry);
    if (!match) continue;
    const iteration = Number(match[1]);
    if (phaseIsActive(root, `live-${iteration}`)) continue;
    const file = path.join(dir, entry, "live_cycle_manifest.json");
    const manifest = readJson<LiveCycleManifest>(file);
    if (!manifest || manifest.status !== "running") continue;
    if (manifest.owner) {
      const ownedByThisSession = options.sessionId !== undefined && manifest.owner.session_id === options.sessionId;
      if (!ownedByThisSession && isAlive(manifest.owner.pid)) continue;
    }
    writeCurrentManifest(root, {
      ...manifest,
      status: fs.existsSync(checkpointPath(root, iteration)) ? "interrupted" : "failed",
      completed_at: new Date().toISOString(),
      error: manifest.error ?? "interrupted — the previous run did not finish",
    });
    recovered.push(iteration);
  }
  return recovered.sort((a, b) => a - b);
}

export function readCampaignStatus(baseRoot: string): CampaignStatus | null {
  const root = activeRoot(path.resolve(baseRoot));
  const record = root ? readRecord(root) : null;
  return record ? statusOf(record) : null;
}

export function stopCampaign(baseRoot: string): CampaignStatus | null {
  const root = activeRoot(path.resolve(baseRoot));
  const record = root ? readRecord(root) : null;
  if (!record) return null;
  const controller = activeControllers.get(record.campaignRoot);
  writeFileAtomic(path.join(record.campaignRoot, "stop.request"), "stop\n", true);
  if (controller) controller.abort();
  else if (record.state.kind === "running" && !phaseIsActive(record.campaignRoot, "campaign")) {
    record.state = { kind: "paused", phase: record.state.phase, iteration: record.state.iteration, reason: "stopped by request" };
    persist(record);
  }
  return statusOf(record);
}
