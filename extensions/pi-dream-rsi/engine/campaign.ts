/** Durable, bounded improve-target controller. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { copyWorkspace, runAgent, runShellCommand, type CommandResult } from "../agent/runner.ts";
import { BUNDLED_POLICY_DIR, EXTENSION_DIR, PACKAGE_DIR } from "../layout.ts";
import { runLiveEpisode } from "./live.ts";
import { runDreamPhase } from "./dream.ts";
import { CampaignBudget, CampaignLimitError } from "./campaign-budget.ts";
import { buildCandidatePatch, patchConflicts, verifyCandidatePatch, applyCandidatePatch, reconcileCandidatePatch, runCampaignGate, workspaceDigest, WorkspaceDriftDuringApplyError, type CandidatePatch } from "./campaign-patch.ts";
import { scoreSeedCopy } from "./apply.ts";
import { findCandidate, type Candidate } from "./improvements.ts";
import { normalizeTask, scoringFingerprint, type AgentConfig, type TaskConfig } from "./task.ts";
import { ensureDreamIgnore, ensurePolicyRuntime, liveMethodPath, nodeWorkspace, readManifest, readJson, writeFileAtomic, writeJson } from "./world.ts";
import { readTree } from "./world.ts";
import { allocator, acquirePhase, phaseIsActive, pidIsAlive } from "./ownership.ts";
import { checkpointPath } from "./checkpoint.ts";
import { tracePoolDir, writeCurrentManifest, attemptDir, deployedBetaPath, type LiveCycleManifest } from "./world.ts";
import type { ProgressObserver } from "./progress.ts";
import { loadPrompt, renderPrompt } from "./prompt.ts";
import { parseThreshold, resolveThreshold, planTest } from "./measure.ts";
import { appendLedgerRecord, readLedger, ledgerDigest, ledgerHealth, type LedgerEntry } from "./ledger.ts";

export type CampaignAgentResolver = (savedAgent: AgentConfig) => AgentConfig | null;

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
  defaultEvaluatorTimeoutMs: number;
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
    defaultEvaluatorTimeoutMs: CAMPAIGN_MAX_EVALUATOR_TIMEOUT_MS,
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
  requestedMinimumGain?: number | string;
  /** Per-promotion false-accept allowance assigned by the caller (see MeasurementPlan). */
  confirmationAlpha?: number;
  controlPatch?: string;
  checkReport?: CampaignCheckReport;
  appliedIteration?: number;
  decidedPatches?: string[];
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
  health: ReturnType<typeof ledgerHealth>;
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
  /** Per-promotion false-accept allowance, so a chained loop can share one budget. */
  confirmationAlpha?: number;
  /** The normal `.dream-rsi` container; each campaign is isolated under its `campaigns/` child. */
  baseRoot: string;
  projectDir: string;
  task: TaskConfig;
  goal: string;
  scope?: string[];
  verifierInputs?: string[];
  minimumGain?: number | string;
  controlPatch?: string;
  gates?: string[];
  limits?: Partial<CampaignLimits>;
  max_cycles?: number;
  max_agent_starts?: number;
  max_evaluator_runs?: number;
  maxCycles?: number;
  maxAgentStarts?: number;
  maxEvaluatorRuns?: number;
  signal?: AbortSignal;
  resolveAgent?: CampaignAgentResolver;
  /** Additional synchronous shared-budget reservation after the campaign reservation, immediately before spawn. */
  beforeAgentSpawn?: (key: string) => void;
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
  direction: "maximize" | "minimize";
  deterministic: boolean;
  noise_rel: number | null;
  mde_rel: number | null;
  threshold_resolved: number;
  confirmationCostMs: number;
  control: { validated: boolean; gain: number | null; reason: string };
}

export interface CampaignCheckOptions {
  /** Per-promotion false-accept allowance assigned by the caller. */
  confirmationAlpha?: number;
  baseRoot: string;
  projectDir: string;
  task: TaskConfig;
  verifierInputs?: string[];
  gates?: string[];
  runs?: number;
  maxEvaluatorRuns?: number;
  minimumGain?: number | string;
  controlPatch?: string;
  maxCycles?: number;
  deadlineMs?: number;
  beforeEvaluatorSpawn?: (key: string) => void;
  signal?: AbortSignal;
}

export interface CampaignResumeOptions {
  baseRoot: string;
  projectDir: string;
  sessionId?: string;
  signal?: AbortSignal;
  resolveAgent?: CampaignAgentResolver;
  /** Additional synchronous shared-budget reservation after the campaign reservation, immediately before spawn. */
  beforeAgentSpawn?: (key: string) => void;
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
  return readLedger(path.join(root, "history", "ledger.jsonl")).entries.flatMap((entry) => {
    const facts = entry.facts;
    if (entry.kind !== "skip" || entry.outcome !== "rejected" || !facts || typeof facts.iteration !== "number" || typeof facts.cell !== "string" || typeof facts.terminalStage !== "string") return [];
    return [{ iteration: facts.iteration, cell: facts.cell, stage: facts.terminalStage, reasons: typeof facts.reason === "string" ? [facts.reason] : [] }];
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
    health: ledgerHealth(campaignMemory(record)),
  };
}
function emit(record: CampaignRecord, options: Pick<CampaignOptions, "onProgress" | "onUpdate">): void {
  options.onUpdate?.(statusOf(record));
}
function writeActive(baseRoot: string, id: string): void { writeFileAtomic(activeFile(baseRoot), `${JSON.stringify({ id })}\n`, true); }
function assertNotAborted(signal: AbortSignal): void { if (signal.aborted) throw new Error("campaign stopped"); }
function assertVerifierIdentity(record: CampaignRecord): void {
  if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? []) !== record.verifierIdentity) {
    appendLedgerRecord(ledgerFile(record), { kind: "integrity", campaignId: record.id, outcome: "verifier-changed", stage: "integrity" });
    throw new Error("task/evaluator identity changed during campaign; refusing incomparable results");
  }
}

const ledgerFile = (record: CampaignRecord): string => path.join(record.campaignRoot, "history", "ledger.jsonl");

function campaignMemory(record: CampaignRecord): LedgerEntry[] {
  const parent = path.join(record.baseRoot, "campaigns");
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent).sort().flatMap((id) => {
    const root = path.join(parent, id);
    const prior = readRecord(root);
    if (!prior || path.resolve(prior.projectDir) !== path.resolve(record.projectDir) || prior.taskFingerprint !== record.taskFingerprint || prior.verifierIdentity !== record.verifierIdentity) return [];
    return readLedger(path.join(root, "history", "ledger.jsonl")).entries;
  });
}

function absoluteThreshold(input: number | string, baseline: number): number {
  const threshold = parseThreshold(input);
  return threshold.kind === "relative" ? Math.abs(baseline) * threshold.value : threshold.value;
}

function measurementPlan(record: CampaignRecord, maxPairs = 8) {
  const threshold = parseThreshold(record.requestedMinimumGain ?? record.minimumGain);
  const raw = record.task.higher_is_better ? record.currentScore : -record.currentScore;
  return planTest({ baseline: record.baselineScores ?? [record.currentScore], higherIsBetter: record.task.higher_is_better,
    threshold: resolveThreshold(threshold, raw, record.task.higher_is_better), relative: threshold.kind === "relative", maxCycles: record.limits.maxCycles, maxPairs,
    ...(record.confirmationAlpha === undefined ? {} : { alphaConf: record.confirmationAlpha }) });
}

function recordLiveAttempts(record: CampaignRecord, iteration: number): void {
  const tree = readTree(record.campaignRoot, iteration);
  if (!tree) return;
  const prior = readLedger(ledgerFile(record)).entries;
  for (const node of tree.list()) {
    if (node.meta.branch < 0 || (!node.evaluated && !node.workspace) || prior.some((entry) => entry.kind === "attempt" && entry.facts?.iteration === iteration && entry.facts?.cell === node.meta.cell_id)) continue;
    const workspace = node.workspace ? path.resolve(record.projectDir, node.workspace) : null;
    const proposal = workspace ? path.join(workspace, "proposal.md") : null;
    const title = proposal && fs.existsSync(proposal) ? fs.readFileSync(proposal, "utf8").split(/\r?\n/).find((line) => line.trim()) : undefined;
    const evidence = readJson<NonNullable<CommandResult["evidence"]>>(path.join(attemptDir(record.campaignRoot, iteration, node.meta.cell_id), "attempt-evidence.json"));
    let editCount: number | undefined;
    if (workspace && fs.existsSync(workspace)) {
      try { editCount = buildCandidatePatch({ cycleSeedRoot: nodeWorkspace(record.campaignRoot, iteration, "seed"), targetRoot: record.targetRoot,
        candidateRoot: workspace, scope: record.scope, exclude: ["proposal.md", record.task.score_path, ...record.task.copy_exclude] }).length; }
      catch { /* Scope violations retain an unknown edit count and face the promotion patch check. */ }
    }
    appendLedgerRecord(ledgerFile(record), { kind: "attempt", campaignId: record.id, stage: "attempt",
      agent: "discovery", outcome: node.fail_class, title, editCount, ...(evidence ? { usage: evidence.usage, verifierRead: evidence.verifierRead } : {}), facts: { iteration, cell: node.meta.cell_id, mode: "live",
        score: node.score, valid: node.valid, timedOut: node.partial ?? false, measured: typeof node.score === "number" } });
  }
}

function recordDispositions(record: CampaignRecord, iteration: number): void {
  const entries = readLedger(ledgerFile(record)).entries;
  for (const attempt of entries.filter((entry) => entry.kind === "attempt" && entry.facts?.iteration === iteration)) {
    const cell = attempt.facts?.cell;
    if (typeof cell !== "string" || entries.some((entry) => entry.kind !== "attempt" && entry.facts?.iteration === iteration && entry.facts?.cell === cell)) continue;
    appendLedgerRecord(ledgerFile(record), { kind: "skip", campaignId: record.id, stage: "skip", outcome: "not-selected", title: attempt.title,
      facts: { iteration, cell, reason: "Not confirmed within this cycle's selection and process budgets" } });
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

function digest(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
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
  const targetRoot = fs.realpathSync(path.resolve(projectDir, task.workspace));
  const verifierInputs = [...new Set(options.verifierInputs ?? [])].sort();
  const gates = [...(options.gates ?? [])];
  const runs = options.runs ?? 5;
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 5) throw new Error("check runs must be an integer between 1 and 5");
  if (gates.some((gate) => typeof gate !== "string" || gate.trim() === "")) throw new Error("gate commands must be non-empty strings");
  assertTrustedVerifier(projectDir, targetRoot, baseRoot, task, verifierInputs);
  const checkIdentity = hashInputs(projectDir, task, verifierInputs, gates);
  const checkIntegrity = (): void => {
    if (hashInputs(projectDir, task, verifierInputs, gates) !== checkIdentity) throw new Error("task/evaluator identity changed during campaign check");
  };
  const pathDiagnoses = relativeEvaluatorPathDiagnoses(task, targetRoot);
  const diagnoses = [...pathDiagnoses];
  const checkDir = path.join(baseRoot, "checks");
  const scratchParent = os.tmpdir();
  const runResults: CampaignCheckRun[] = [];
  for (let index = 0; index < runs; index += 1) {
    if (options.signal?.aborted) throw new Error("evaluator check was cancelled");
    if (pathDiagnoses.length > 0) {
      runResults.push({
        durationMs: 0,
        code: null,
        valid: false,
        failClass: "configuration_error",
        score: null,
        error: pathDiagnoses.join("; "),
      });
      continue;
    }
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
      beforeEvaluatorSpawn: options.beforeEvaluatorSpawn,
      exclude: contains(targetRoot, baseRoot) ? [baseRoot] : [],
    });
    checkIntegrity();
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
  const rawSpread = validScores.length === runResults.length ? Math.max(...validScores) - Math.min(...validScores) : null;
  const spread = rawSpread !== null && Number.isFinite(rawSpread) ? rawSpread : null;
  if (rawSpread !== null && spread === null) diagnoses.push("score spread exceeds the finite numeric range; no reliable minimum_gain recommendation is available");
  const maxDuration = Math.max(...runResults.map((run) => run.durationMs));
  const recommendedEvaluatorTimeoutMs = Math.max(30_000, Math.ceil(maxDuration * 3));
  const recommendedMinimumGain = 0;
  if (runResults.some((run) => run.code === 127 || run.code === 9009 || (run.code === 1 && /not found|not recognized|cannot find|is not recognized/i.test(run.error ?? "")))) {
    diagnoses.push("interpreter not found on PATH; on Windows prefer node …");
  }
  if (runResults.some((run) => run.durationMs >= task.evaluator_timeout_ms * 0.8 || run.failClass === "timeout")) {
    diagnoses.push(`evaluator takes ${Math.ceil(maxDuration / 1000)} s; configured timeout is ${task.evaluator_timeout_ms / 1000} s; reduce cases or raise evaluator_timeout_ms`);
  }
  if (runResults.some((run) => !run.valid) && diagnoses.length === 0) diagnoses.push("evaluator did not produce a valid score on the unchanged target");
  const gateRuns: CampaignCheckReport["gateRuns"] = [];
  for (const [index, gate] of gates.entries()) {
    if (options.signal?.aborted) throw new Error("evaluator check was cancelled");
    if (pathDiagnoses.length > 0) {
      gateRuns.push({ command: gate, code: null, passed: false, error: `not run because the score_program path is unsafe: ${pathDiagnoses.join("; ")}` });
      continue;
    }
    const result = await runCampaignGate({
      sourceRoot: targetRoot,
      scratch: path.join(scratchParent, `dream-rsi-check-gate-${crypto.randomUUID()}`),
      command: gate,
      timeoutMs: task.evaluator_timeout_ms,
      key: `check-gate:${index}`,
      signal: options.signal,
      beforeSpawn: options.beforeEvaluatorSpawn,
    });
    checkIntegrity();
    gateRuns.push({ command: gate, code: result.result.code, passed: result.passed, error: result.result.stderrTail || result.result.spawnError });
    if (!result.passed) diagnoses.push(`gate failed on the unchanged target: ${gate}`);
  }
  const checkedAt = new Date().toISOString();
  fs.mkdirSync(checkDir, { recursive: true });
  const reportPath = path.join(checkDir, `${checkedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.json`);
  const mean = validScores.length ? validScores.reduce((sum, value) => sum + value / validScores.length, 0) : 0;
  const variance = validScores.length > 1 ? validScores.reduce((sum, value) => sum + ((value - mean) / Math.sqrt(validScores.length - 1)) ** 2, 0) : 0;
  const noise = Math.sqrt(variance);
  const deterministic = spread === 0 && validScores.length >= 2;
  const noiseRel = mean !== 0 && Number.isFinite(noise) ? noise / Math.abs(mean) : null;
  const parsedThreshold = parseThreshold(options.minimumGain ?? 0);
  const rawBaseline = task.higher_is_better ? mean : -mean;
  const thresholdResolved = absoluteThreshold(options.minimumGain ?? 0, mean);
  const plannedPairs = Math.max(8, Math.min(32, Math.floor(((options.maxEvaluatorRuns ?? DEFAULT_CAMPAIGN_LIMITS.maxEvaluatorRuns) - 16 - 2 * gates.length) / 8) * 4));
  const plan = validScores.length >= 2 && spread !== null ? planTest({ baseline: validScores, higherIsBetter: task.higher_is_better,
    ...(options.confirmationAlpha === undefined ? {} : { alphaConf: options.confirmationAlpha }),
    threshold: resolveThreshold(parsedThreshold, rawBaseline, task.higher_is_better), relative: parsedThreshold.kind === "relative", maxCycles: options.maxCycles ?? DEFAULT_CAMPAIGN_LIMITS.maxCycles, maxPairs: plannedPairs }) : null;
  const mdeRel = plan?.mdeRel ?? null;
  const confirmationCostMs = Math.ceil(maxDuration * (deterministic ? 2 : 5 + 2 * plannedPairs));
  if (mdeRel !== null && mdeRel > 0.5) diagnoses.push(`instrument cannot reliably detect an improvement below ${(mdeRel * 100).toFixed(1)}%; reduce measurement noise`);
  if (options.deadlineMs !== undefined && confirmationCostMs > options.deadlineMs) diagnoses.push("one confirmation cannot fit inside the campaign deadline");
  const control = { validated: false, gain: null as number | null, reason: "instrument unvalidated: no control_patch supplied" };
  if (options.controlPatch && plan) {
    const scratch = path.join(os.tmpdir(), `dream-rsi-control-${crypto.randomUUID()}`);
    try {
      const controlFile = fs.realpathSync(path.resolve(projectDir, options.controlPatch));
      await copyWorkspace(targetRoot, scratch, { exclude: [baseRoot, path.join(projectDir, ".git")] });
      const quoted = process.platform === "win32" ? `"${controlFile.replace(/"/g, '""')}"` : `'${controlFile.replace(/'/g, `'"'"'`)}'`;
      const applied = await runShellCommand(`git apply -- ${quoted}`, { cwd: scratch, timeoutMs: task.evaluator_timeout_ms, signal: options.signal });
      if (!applied.ok) throw new Error(`control_patch cannot be applied: ${applied.stderrTail}`);
      const protectedFiles = verifierInputs.map((file) => path.relative(targetRoot, path.resolve(projectDir, file))).filter((file) => !file.startsWith("..") && !path.isAbsolute(file)).map((file) => file.replace(/\\/g, "/").toLowerCase());
      const patch = buildCandidatePatch({ cycleSeedRoot: targetRoot, targetRoot, candidateRoot: scratch, scope: ["."], exclude: [task.score_path] });
      if (patch.some((file) => protectedFiles.includes(file.relative.toLowerCase()))) throw new Error("control_patch changes a protected verifier input");
      const verification = await verifyCandidatePatch({ dreamRoot: baseRoot, projectDir, task, patch,
        evidenceDir: path.join(checkDir, `control-${crypto.randomUUID()}`), signal: options.signal,
        beforeSpawn: options.beforeEvaluatorSpawn, minimumGain: thresholdResolved, measurementPlan: plan, requireValidBeforeAfter: true });
      control.gain = verification.medianPairedGain;
      control.validated = verification.improved;
      control.reason = verification.improved ? "known-better control confirmed" : verification.reason ?? "control has the wrong direction or insufficient detectable gain";
      if (!control.validated) diagnoses.push(control.reason);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  const report: CampaignCheckReport = { checkedAt, runs: runResults, spread, recommendedEvaluatorTimeoutMs, recommendedMinimumGain, diagnoses, gateRuns, reportPath,
    direction: task.higher_is_better ? "maximize" : "minimize", deterministic, noise_rel: noiseRel, mde_rel: mdeRel, threshold_resolved: thresholdResolved, confirmationCostMs, control };
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

async function runProbe(record: CampaignRecord, reserve: (kind: "agent" | "evaluator", key: string) => void, signal: AbortSignal, log: (message: string) => void, resolveAgent?: CampaignAgentResolver): Promise<void> {
  const task = record.task;
  const scratch = path.join(record.campaignRoot, "probe-workspace");
  try {
    const exclude = [path.join(record.projectDir, ".git")];
    if (contains(record.targetRoot, record.baseRoot)) exclude.push(record.baseRoot);
    await copyWorkspace(record.targetRoot, scratch, { exclude });
    const result = await runAgent({
      agent: task.agent,
      resolveAgent,
      cwd: scratch,
      prompt: `Inspect this project for the improvement goal below. Do not change files. Reply with one short sentence confirming you can inspect the target and identify the relevant code.\n\nGoal: ${record.goal}`,
      timeoutMs: Math.min(task.agent_timeout_ms, 120_000),
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
    .filter((node) => (node.valid && typeof node.score === "number" && node.fail_class === "ok" && node.error === null)
      || (node.fail_class === "timeout_scored" && node.timeout_assessment?.valid === true && node.timeout_assessment.error === null && typeof node.timeout_assessment.score === "number"))
    .sort((a, b) => (b.score ?? b.timeout_assessment?.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? a.timeout_assessment?.score ?? Number.NEGATIVE_INFINITY))
    .map((node): Candidate | null => {
      if (node.fail_class !== "timeout_scored") return findCandidate(root, task, projectDir, iteration, node.meta.cell_id);
      if (!node.workspace || typeof node.timeout_assessment?.score !== "number") return null;
      const workspace = path.resolve(projectDir, node.workspace);
      return { iteration, cell: node.meta.cell_id, score: node.timeout_assessment.score, raw_score: node.timeout_assessment.raw_score,
        fail_class: "ok", workspace, program: path.join(workspace, task.eval_program) };
    })
    .filter((candidate): candidate is Candidate => candidate !== null && candidate.workspace !== null && candidate.program !== null);
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
  appendLedgerRecord(ledgerFile(record), { kind: "skip", campaignId: record.id, stage: "skip", outcome: "rejected", facts: { iteration, cell, terminalStage: stage, reason: reasons.join("; ") } });
}

function scoresAreNoisy(record: CampaignRecord): boolean {
  const scores = record.baselineScores ?? [record.baselineScore, record.baselineRepeatScore].filter((score): score is number => typeof score === "number");
  return scores.length > 1 && Math.max(...scores) > Math.min(...scores);
}

type CampaignReview = { verdict: "accept" | "reject"; reasons: string[] };

async function reviewCandidate(options: {
  record: CampaignRecord;
  iteration: number;
  candidate: Candidate;
  patch: CandidatePatch[];
  verification: Awaited<ReturnType<typeof verifyCandidatePatch>>;
  reviewDir: string;
  signal: AbortSignal;
  reserve: (kind: "agent" | "evaluator", key: string) => void;
  resolveAgent?: CampaignAgentResolver;
}): Promise<CampaignReview> {
  const { record, iteration, candidate, patch, verification, reviewDir, signal, reserve, resolveAgent } = options;
  assertNotAborted(signal);
  fs.rmSync(reviewDir, { recursive: true, force: true });
  const beforeDir = path.join(reviewDir, "before");
  const afterDir = path.join(reviewDir, "after");
  fs.mkdirSync(beforeDir, { recursive: true });
  fs.mkdirSync(afterDir, { recursive: true });
  const files: string[] = [];
  for (const operation of patch) {
    const relativeParts = operation.relative.split("/");
    const before = path.join(record.targetRoot, ...relativeParts);
    const reviewBefore = path.join(beforeDir, ...relativeParts);
    const reviewAfter = path.join(afterDir, ...relativeParts);
    const beforeExists = fs.existsSync(before);
    if (beforeExists) {
      fs.mkdirSync(path.dirname(reviewBefore), { recursive: true });
      fs.copyFileSync(before, reviewBefore);
    }
    if (operation.kind === "write") {
      if (digest(fs.readFileSync(operation.from)) !== operation.afterHash) throw new Error(`candidate patch input changed before review: ${operation.relative}`);
      fs.mkdirSync(path.dirname(reviewAfter), { recursive: true });
      fs.copyFileSync(operation.from, reviewAfter);
    }
    files.push(`- ${operation.kind.toUpperCase()} ${operation.relative} (before: ${beforeExists ? `before/${operation.relative}` : "absent"}; after: ${operation.kind === "delete" ? "deleted" : `after/${operation.relative}`})`);
  }
  fs.writeFileSync(path.join(reviewDir, "REVIEW.md"), [
    `Goal: ${record.goal}`,
    `Lever: ${candidate.cell}`,
    `Scope: ${record.scope.join(", ")}`,
    `Evaluator command: ${record.task.score_program}`,
    `Verifier inputs: ${record.verifierInputs.join(", ")}`,
    `Correctness gates: ${(record.gates ?? []).join(" | ") || "none"}`,
    `Verified before score: ${verification.before.score}`,
    `Verified after score: ${verification.after.score}`,
    `Candidate score: ${candidate.score} (raw: ${candidate.raw_score ?? "n/a"})`,
    `Paired measurements: ${JSON.stringify(verification.pairs)}`,
    `Integrity flags: ${JSON.stringify({ verifierIdentityUnchanged: true, candidatePatchPinned: true,
      verifierRead: readJson<NonNullable<CommandResult["evidence"]>>(path.join(attemptDir(record.campaignRoot, iteration, candidate.cell), "attempt-evidence.json"))?.verifierRead ?? false })}`,
    `Line counts: ${JSON.stringify(patch.map((file) => ({ path: file.relative, before: file.beforeLines, after: file.kind === "write" ? file.afterLines : 0 })))}`,
    "Candidate proposal:",
    (() => { const file = candidate.workspace ? path.join(candidate.workspace, "proposal.md") : null; return file && fs.existsSync(file) ? fs.readFileSync(file, "utf8").slice(0, 8192) : "No proposal available. Judge the patch and evidence."; })(),
    "Changed files:",
    ...files,
  ].join("\n") + "\n", "utf8");
  const reviewPath = path.join(reviewDir, "review.json");
  fs.rmSync(reviewPath, { force: true });
  const prompt = renderPrompt(loadPrompt("adversarial-review.md"), { review_file: "REVIEW.md", output_file: "review.json" });
  const run = await runAgent({
    agent: record.task.agent,
    resolveAgent,
    cwd: reviewDir,
    prompt,
    timeoutMs: Math.min(record.task.agent_timeout_ms, 8 * 60 * 1000),
    logPath: path.join(reviewDir, "agent.log"),
    signal,
    beforeSpawn: () => reserve("agent", `${iteration}:${candidate.cell}:review`),
  });
  assertNotAborted(signal);
  if (!run.ok || run.timedOut || run.aborted) throw new Error(`adversarial review agent failed${run.spawnError ? `: ${run.spawnError}` : run.stderrTail ? `: ${run.stderrTail.trim().slice(-300)}` : ` (exit ${run.code})`}`);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(reviewPath, "utf8")); }
  catch { throw new Error("adversarial review did not produce valid review.json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("adversarial review output must be an object");
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "verdict") || !Object.hasOwn(value, "reasons") || (value.verdict !== "accept" && value.verdict !== "reject") || !Array.isArray(value.reasons) || !value.reasons.every((reason) => typeof reason === "string")) {
    throw new Error('adversarial review output must match {"verdict":"accept"|"reject","reasons":[string,...]}');
  }
  return { verdict: value.verdict, reasons: value.reasons as string[] };
}

function assertPatchBytesUnchanged(patch: CandidatePatch[]): void {
  for (const operation of patch) {
    if (operation.kind === "write" && digest(fs.readFileSync(operation.from)) !== operation.afterHash) {
      throw new Error(`candidate patch changed during review: ${operation.relative}`);
    }
  }
}

async function promoteCandidates(record: CampaignRecord, iteration: number, reserve: (kind: "agent" | "evaluator", key: string) => void, signal: AbortSignal, log: (message: string) => void, resolveAgent?: CampaignAgentResolver): Promise<boolean> {
  const noisy = scoresAreNoisy(record);
  const maxCandidates = Math.min(2, record.limits.maxCandidatesPerCycle);
  const candidates = candidatesFor(record.campaignRoot, iteration, record.task, record.projectDir);
  let confirmations = 0;
  const seedRoot = nodeWorkspace(record.campaignRoot, iteration, "seed");
  const workspaceAbsolute = path.resolve(record.projectDir, record.task.workspace);
  const workspaceRelativeInputs = record.verifierInputs.map((item) => path.relative(workspaceAbsolute, path.resolve(record.projectDir, item)))
    .filter((item) => item !== ".." && !item.startsWith(`..${path.sep}`) && !path.isAbsolute(item));
  const excluded = new Set(workspaceRelativeInputs.map((item) => item.replace(/\\/g, "/").toLowerCase()));
  for (const candidate of candidates) {
    if (confirmations >= maxCandidates) break;
    assertNotAborted(signal);
    if (!withinDeadline(record)) return false;
    if (!noisy && candidate.score <= record.currentScore + record.minimumGain) {
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
    const patchHash = digest(Buffer.from(JSON.stringify(patch.map((file) => [file.relative, file.kind, file.kind === "write" ? file.afterHash : null]))));
    if (record.decidedPatches?.includes(patchHash)) {
      appendLedgerRecord(ledgerFile(record), { kind: "skip", campaignId: record.id, stage: "skip", outcome: "duplicate", patchHash, facts: { iteration, cell: candidate.cell } });
      continue;
    }
    if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? []) !== record.verifierIdentity) throw new Error("verifier files changed before candidate verification; scores are no longer comparable");
    const conflicts = patchConflicts({ cycleSeedRoot: seedRoot, patch });
    if (conflicts.length > 0) {
      rejectCandidate(record, iteration, candidate.cell, "patch", [`candidate conflicts with target changes: ${conflicts.join(", ")}`]);
      continue;
    }
    // Fingerprint the live target for the whole verification-to-apply window: the candidate was
    // measured against this content, so a change to any candidate-visible path outside the
    // re-verified patch makes the verified gain incomparable, even before the review digest.
    // Patched paths stay out of the digest: patchConflicts and assertPatchBytesUnchanged already
    // guard them with the idempotent-postimage rule, so a path that already holds the verified
    // result is not drift.
    const digestExcludes = [...patchExcludes, ...patch.map((file) => file.relative)];
    const preVerifyDigest = workspaceDigest({ root: record.targetRoot, cycleSeedRoot: seedRoot, repoRoot: record.targetRoot, exclude: digestExcludes });
    const evidenceDir = path.join(record.campaignRoot, "history", `r${String(iteration).padStart(4, "0")}_campaign`, candidate.cell);
    const remainingRuns = record.limits.maxEvaluatorRuns - makeBudget(record).read().evaluator_runs;
    const worstDuration = Math.max(1, ...(record.checkReport?.runs.map((run) => run.durationMs) ?? [1]));
    const timeRuns = Math.floor((Date.parse(record.deadlineAt) - Date.now()) / worstDuration);
    const affordablePairs = noisy ? Math.min(32, Math.floor((Math.min(remainingRuns, timeRuns) - 5 - (record.gates?.length ?? 0)) / 8) * 4) : 8;
    if (noisy && affordablePairs < 8) {
      rejectCandidate(record, iteration, candidate.cell, "budget", ["remaining evaluator or time budget cannot support a noisy confirmation"]);
      break;
    }
    confirmations += 1;
    const verification = await verifyCandidatePatch({
      dreamRoot: record.campaignRoot, projectDir: record.projectDir, task: record.task, patch, evidenceDir, signal,
      beforeSpawn: (key) => reserve("evaluator", `${iteration}:${candidate.cell}:${key}`),
      repeats: noisy ? 3 : 1,
      minimumGain: record.minimumGain,
      requireValidBeforeAfter: true,
      measurementPlan: measurementPlan(record, affordablePairs),
    });
    record.decidedPatches = [...(record.decidedPatches ?? []), patchHash];
    persist(record);
    for (const [pair, value] of verification.pairs.entries()) appendLedgerRecord(ledgerFile(record), { kind: "confirm", campaignId: record.id,
      stage: "confirm", outcome: verification.improved ? "success" : "rejected", patchHash,
      facts: { iteration, cell: candidate.cell, pair, before: value.before.raw_score, after: value.after.raw_score, gain: value.gain, liveGain: candidate.score - record.currentScore } });
    if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? []) !== record.verifierIdentity) throw new Error("verifier files changed during candidate verification; scores are no longer comparable");
    if (!verification.improved || verification.before.score === null || verification.after.score === null || (!noisy && verification.after.score <= record.currentScore + record.minimumGain)) {
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
      appendLedgerRecord(ledgerFile(record), { kind: "gate", campaignId: record.id, stage: "gate", outcome: gate.passed ? "success" : "rejected", patchHash, facts: { iteration, cell: candidate.cell, index } });
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
    let review: CampaignReview;
    const reviewDir = path.join(evidenceDir, "review");
    // Fingerprint the live target around the review window: the review agent
    // must not change workspace content outside the re-verified patch paths.
    const preReviewDigest = workspaceDigest({ root: record.targetRoot, cycleSeedRoot: seedRoot, repoRoot: record.targetRoot, exclude: digestExcludes });
    try {
      review = await reviewCandidate({ record, iteration, candidate, patch, verification, reviewDir, signal, reserve, resolveAgent });
      appendLedgerRecord(ledgerFile(record), { kind: "review", campaignId: record.id, stage: "review", outcome: review.verdict, patchHash, facts: { iteration, cell: candidate.cell } });
    } catch (error) {
      if (signal.aborted || error instanceof CampaignLimitError) throw error;
      rejectCandidate(record, iteration, candidate.cell, "review", [error instanceof Error ? error.message : String(error)]);
      continue;
    }
    assertVerifierIdentity(record);
    try { assertPatchBytesUnchanged(patch); }
    catch (error) {
      rejectCandidate(record, iteration, candidate.cell, "review", [error instanceof Error ? error.message : String(error)]);
      continue;
    }
    const reviewConflicts = patchConflicts({ cycleSeedRoot: seedRoot, patch });
    if (reviewConflicts.length > 0) {
      rejectCandidate(record, iteration, candidate.cell, "review", [`target changed during review at: ${reviewConflicts.join(", ")}`]);
      continue;
    }
    const postReviewDigest = workspaceDigest({ root: record.targetRoot, cycleSeedRoot: seedRoot, repoRoot: record.targetRoot, exclude: digestExcludes });
    if (postReviewDigest !== preReviewDigest) {
      rejectCandidate(record, iteration, candidate.cell, "review", ["target workspace changed during review outside the re-verified patch paths"]);
      continue;
    }
    if (postReviewDigest !== preVerifyDigest) {
      rejectCandidate(record, iteration, candidate.cell, "verification", ["target workspace changed during candidate verification outside the re-verified patch paths"]);
      continue;
    }
    if (review.verdict !== "accept") {
      rejectCandidate(record, iteration, candidate.cell, "review", review.reasons.length > 0 ? review.reasons : ["review rejected without a reason"]);
      continue;
    }
    const transactionId = `r${String(iteration).padStart(4, "0")}-${candidate.cell}-${crypto.randomUUID()}`;
    record.pendingApply = { iteration, candidate, patch, before: verification.before.score, after: verification.after.score, transactionId };
    persist(record);
    assertNotAborted(signal);
    let receipt: ReturnType<typeof applyCandidatePatch>;
    try {
      receipt = applyCandidatePatch({
        seedRoot: record.targetRoot,
        patch,
        journalDir: path.join(record.campaignRoot, "promotion-journal"),
        transactionId,
        signal,
        expectedWorkspaceDigest: preVerifyDigest,
        cycleSeedRoot: seedRoot,
        repoRoot: record.targetRoot,
        digestExclude: digestExcludes,
      });
    } catch (error) {
      if (!(error instanceof WorkspaceDriftDuringApplyError)) throw error;
      record.pendingApply = undefined;
      persist(record);
      rejectCandidate(record, iteration, candidate.cell, "apply", [error.message]);
      throw error;
    }
    saveApplied(record, record.pendingApply, receipt);
    appendLedgerRecord(ledgerFile(record), { kind: "apply", campaignId: record.id, stage: "apply", outcome: "success", patchHash, patchSize: patch.reduce((sum, file) => sum + (file.kind === "write" ? file.afterLines : file.beforeLines), 0), facts: { iteration, cell: candidate.cell, transactionId } });
    record.currentScore = verification.medianAfter ?? verification.after.score;
    record.bestScore = Math.max(record.bestScore, record.currentScore);
    record.pendingApply = undefined;
    record.appliedIteration = iteration;
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
    if (!readLedger(ledgerFile(record)).entries.some((entry) => entry.kind === "apply" && entry.facts?.transactionId === pending.transactionId)) {
      appendLedgerRecord(ledgerFile(record), { kind: "apply", campaignId: record.id, stage: "apply", outcome: "success", facts: { iteration: pending.iteration, cell: pending.candidate.cell, transactionId: pending.transactionId } });
    }
    record.currentScore = pending.after;
    record.bestScore = Math.max(record.bestScore, pending.after);
    record.appliedIteration = pending.iteration;
    record.pendingApply = undefined;
    persist(record);
  } else if (receipt.state === "prepared") {
    record.pendingApply = undefined;
    persist(record);
  }
}

async function execute(record: CampaignRecord, options: Pick<CampaignOptions, "signal" | "resolveAgent" | "beforeAgentSpawn" | "onProgress" | "onPhaseProgress" | "onUpdate" | "log">): Promise<CampaignResult> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let ownerRelease: () => void;
  try { ownerRelease = allocator(record.campaignRoot, () => acquirePhase(record.campaignRoot, "campaign")); }
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
    try {
      budget.reserve(kind, key);
      if (kind === "agent") options.beforeAgentSpawn?.(key);
    }
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
    if (!record.checkReport) {
      setPhase(record, "baseline", null, callbacks);
      record.checkReport = await checkCampaignEvaluator({ baseRoot: record.baseRoot, projectDir: record.projectDir,
        task: record.task, verifierInputs: record.verifierInputs, gates: record.gates, minimumGain: record.requestedMinimumGain,
        controlPatch: record.controlPatch, maxCycles: record.limits.maxCycles, maxEvaluatorRuns: record.limits.maxEvaluatorRuns, deadlineMs: Date.parse(record.deadlineAt) - Date.now(),
        signal, beforeEvaluatorSpawn: (key) => reserve("evaluator", key) });
      assertVerifierIdentity(record);
      const check = record.checkReport;
      if (check.runs.some((run) => !run.valid) || check.gateRuns.some((gate) => !gate.passed)) throw new Error("evaluator preflight failed: " + check.diagnoses.join("; "));
      if (check.spread === null) throw new Error("target verifier spread exceeds the finite numeric range");
      if (check.mde_rel !== null && check.mde_rel > 0.5) throw new Error("evaluator preflight failed: minimum detectable effect exceeds 50%");
      if (check.confirmationCostMs > Date.parse(record.deadlineAt) - Date.now()) throw new Error("evaluator preflight failed: one confirmation cannot fit inside the campaign deadline");
      if (record.controlPatch && !check.control.validated) {
        appendLedgerRecord(ledgerFile(record), { kind: "integrity", campaignId: record.id, stage: "integrity", outcome: "control-rejected", facts: { directionAnomaly: typeof check.control.gain === "number" && check.control.gain < 0 } });
        throw new Error("evaluator preflight failed: " + check.control.reason);
      }
      record.baselineScores = check.runs.flatMap((run) => run.valid && run.score !== null ? [run.score] : []);
      const sorted = [...record.baselineScores].sort((a, b) => a - b);
      const baseline = sorted[Math.floor(sorted.length / 2)];
      record.baselineScore = baseline;
      record.baselineRepeatScore = record.baselineScores[1];
      record.currentScore = baseline;
      record.bestScore = baseline;
      record.minimumGain = absoluteThreshold(record.requestedMinimumGain ?? 0, baseline);
      writeJson(path.join(record.campaignRoot, "history", "seed", "score.json"), { score: baseline,
        raw_score: record.task.higher_is_better ? baseline : -baseline, valid: true, fail_class: "ok", error: null,
        measured_at: new Date().toISOString(), workspace: record.task.workspace, score_program: record.task.score_program,
        fingerprint: scoringFingerprint(record.task), seconds: check.runs.reduce((sum, run) => sum + run.durationMs, 0) / 1000 });
      persist(record);
    }
    if (!fs.existsSync(path.join(record.campaignRoot, "probe.complete"))) {
      setPhase(record, "probe", null, callbacks);
      await runProbe(record, reserve, signal, log, options.resolveAgent);
      assertVerifierIdentity(record);
      writeFileAtomic(path.join(record.campaignRoot, "probe.complete"), "ok\n", true);
    }
    while (record.completedCycles.length < record.limits.maxCycles && record.noGainCycles < record.limits.plateauCycles) {
      assertNotAborted(signal);
      if (!withinDeadline(record)) { record.state = { kind: "complete", reason: `campaign deadline expired (${record.limits.deadlineMs}ms)` }; break; }
      const iteration = record.completedCycles.length + 1;
      record.minimumGain = absoluteThreshold(record.requestedMinimumGain ?? record.minimumGain, record.currentScore);
      if (record.appliedIteration === iteration) {
        record.completedCycles.push(iteration);
        record.noGainCycles = 0;
        persist(record);
        continue;
      }
      if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? []) !== record.verifierIdentity) throw new Error("verifier files changed between campaign cycles; scores are no longer comparable");
      setPhase(record, "live", iteration, callbacks);
      const policyPath = liveMethodPath(record.campaignRoot);
      const manifest = readManifest(record.campaignRoot, iteration);
      const live = manifest?.status === "complete" ? { ok: true, error: null } : await runLiveEpisode({
        dreamRoot: record.campaignRoot, projectDir: record.projectDir, task: record.task, iteration,
        policyPath, bakedBeta: (() => { const deployed = readJson<{ beta?: number }>(deployedBetaPath(record.campaignRoot)); return typeof deployed?.beta === "number" && Number.isFinite(deployed.beta) && deployed.beta >= 0 && deployed.beta <= 1 ? deployed.beta : record.task.default_beta; })(),
        grid: { branch_count: record.task.workers, refine_count: record.task.k1 },
        baselineScore: record.currentScore, previousBestScore: record.bestScore,
        onProgress: options.onPhaseProgress,
        resume: manifest?.status === "interrupted" || fs.existsSync(path.join(record.campaignRoot, "trace_pool", `iter${String(iteration).padStart(4, "0")}_current`, "checkpoint.json")),
        signal, workspaceExcludes: contains(record.targetRoot, record.baseRoot) ? [record.baseRoot] : [],
        beforeAgentSpawn: (key) => reserve("agent", key), beforeEvaluatorSpawn: (key) => reserve("evaluator", key),
        resolveAgent: options.resolveAgent,
        candidateBrief: { goal: record.goal, direction: record.task.higher_is_better ? "maximize" : "minimize", metric: record.task.score_field,
          minimumGain: record.requestedMinimumGain ?? record.minimumGain, scope: record.scope,
          gates: (record.gates ?? []).map((command) => record.verifierInputs.reduce((text, file) => {
            const absolute = path.resolve(record.projectDir, file);
            return [file, absolute, absolute.replace(/\\/g, "/")].reduce((value, input) => value.replaceAll(input, "[protected input]"), text);
          }, command)), timeBudgetMs: record.task.agent_timeout_ms },
        experimentDigest: ledgerDigest(campaignMemory(record)),
        protectedReadPaths: record.verifierInputs.flatMap((file) => [path.resolve(record.projectDir, file), path.relative(record.targetRoot, path.resolve(record.projectDir, file))]),
        log,
      });
      recordLiveAttempts(record, iteration);
      assertVerifierIdentity(record);
      if (limitReason) { record.state = { kind: "complete", reason: limitReason }; persist(record); break; }
      if (!live.ok) throw new Error(live.error ?? `live cycle ${iteration} did not complete`);
      setPhase(record, "dream", iteration, callbacks);
      const selectionPath = path.join(record.campaignRoot, "history", `r${String(iteration).padStart(4, "0")}_dream`, "proposal_results", "selection.json");
      const eligibleWorlds = record.completedCycles.concat(iteration).filter((cycle) => {
        const tree = readTree(record.campaignRoot, cycle);
        return tree && tree.list().filter((node) => node.valid && node.fail_class === "ok" && node.error === null && node.meta.branch >= 0).length >= 3;
      });
      const skipDream = eligibleWorlds.length < 2;
      if (skipDream) appendLedgerRecord(ledgerFile(record), { kind: "dream", campaignId: record.id, stage: "dream", outcome: "skipped", facts: { iteration, eligibleWorlds: eligibleWorlds.length } });
      const dream = skipDream || fs.existsSync(selectionPath) ? { ok: true, error: null } : await runDreamPhase({
        dreamRoot: record.campaignRoot, projectDir: record.projectDir, task: record.task, iteration,
        signal, log, onProgress: options.onPhaseProgress,
        beforeAgentSpawn: (key) => reserve("agent", key), beforeEvaluatorSpawn: (key) => reserve("evaluator", key), resolveAgent: options.resolveAgent,
      });
      if (limitReason) { record.state = { kind: "complete", reason: limitReason }; persist(record); break; }
      if (!dream.ok) {
        appendLedgerRecord(ledgerFile(record), { kind: "dream", campaignId: record.id, stage: "dream", outcome: "failed", facts: { iteration, error: dream.error } });
        log(`[dream] ${dream.error ?? "failed"}; retaining the deployed policy`);
      }
      assertVerifierIdentity(record);
      setPhase(record, "promote", iteration, callbacks);
      let applied: boolean;
      try { applied = await promoteCandidates(record, iteration, reserve, signal, log, options.resolveAgent); }
      catch (error) {
        if (error instanceof CampaignLimitError && limitReason) { record.state = { kind: "complete", reason: limitReason }; break; }
        throw error;
      }
      record.completedCycles.push(iteration);
      recordDispositions(record, iteration);
      if (applied) record.noGainCycles = 0;
      else record.noGainCycles += 1;
      persist(record); emit(record, callbacks);
      if (record.noGainCycles >= record.limits.plateauCycles) { record.state = { kind: "complete", reason: `${record.noGainCycles} completed cycles without a verified gain` }; break; }
      if (record.completedCycles.length >= record.limits.maxCycles) { record.state = { kind: "complete", reason: "cycle limit reached" }; break; }
    }
    if (record.state.kind === "running") record.state = { kind: "complete", reason: "campaign finished" };
    persist(record); emit(record, callbacks);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (record.state.kind === "running" && record.state.phase === "live" && record.state.iteration !== null) recordLiveAttempts(record, record.state.iteration);
    if (/verifier|identity|tamper/i.test(reason)) appendLedgerRecord(ledgerFile(record), { kind: "integrity", campaignId: record.id, stage: "integrity", outcome: "failed", facts: { reason } });
    if (limitReason) record.state = { kind: "complete", reason: limitReason };
    else if (signal.aborted || reason === "campaign stopped") {
      const prior = record.state;
      record.state = prior.kind === "running" ? { kind: "paused", phase: prior.phase, iteration: prior.iteration, reason: "stopped by request" } : { kind: "paused", phase: "live", iteration: null, reason: "stopped by request" };
    } else if (error instanceof CampaignLimitError) record.state = { kind: "complete", reason: error.message };
    else record.state = { kind: "failed", reason };
    persist(record); emit(record, callbacks);
  } finally {
    if (record.state.kind !== "running" && record.completedCycles.length < record.limits.maxCycles) recordDispositions(record, record.completedCycles.length + 1);
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
  const releaseStart = allocator(baseRoot, () => acquirePhase(baseRoot, "campaign-start"));
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
  parseThreshold(options.minimumGain ?? 0);
  const minimumGain = typeof options.minimumGain === "number" ? options.minimumGain : 0;
  const minimumGainSource = options.minimumGain === undefined ? "calibrated" : "explicit";
  if (!Number.isFinite(minimumGain) || minimumGain < 0) throw new Error("minimumGain must be a finite non-negative normalized-score delta");
  if (fs.existsSync(activeFile(baseRoot)) && !readCampaignStatus(baseRoot)) throw new Error("active campaign pointer exists but its record is unreadable; refusing to overwrite it");
  const existing = readCampaignStatus(baseRoot);
  if (existing && (existing.state.kind === "running" || existing.state.kind === "paused")) throw new Error("an unfinished campaign already exists; resume or stop it before starting another");
  const id = crypto.randomUUID();
  const campaignRoot = path.join(baseRoot, "campaigns", id);
  fs.mkdirSync(campaignRoot, { recursive: true });
  const started = Date.now();
  const scopedTask: TaskConfig = { ...task, workers: 2, max_loops: 1, k1: 3, k2: 4, revisions: 2, agent_timeout_ms: Math.min(task.agent_timeout_ms, 8 * 60 * 1000), ...(task.workspace ? { workspace: task.workspace } : {}) };
  const verifierIdentity = hashInputs(projectDir, scopedTask, verifierInputs, gates);
  const record: CampaignRecord = {
    version: 1, id, baseRoot, campaignRoot, projectDir, targetRoot, goal: options.goal.trim(), task: scopedTask,
    scope: options.scope?.length ? [...options.scope] : ["."], verifierInputs, verifierIdentity, gates,
    taskFingerprint: scoringFingerprint(scopedTask), minimumGain, requestedMinimumGain: options.minimumGain ?? 0, controlPatch: options.controlPatch,
    minimumGainSource, baselineScores: [], limits, startedAt: new Date(started).toISOString(), deadlineAt: new Date(started + limits.deadlineMs).toISOString(),
    ...(options.confirmationAlpha === undefined ? {} : { confirmationAlpha: options.confirmationAlpha }),
    completedCycles: [], currentScore: 0, bestScore: 0, noGainCycles: 0, state: { kind: "running", phase: "probe", iteration: null },
  };
  configureIsolatedEngine(campaignRoot, scopedTask);
  makeBudget(record, true);
  persist(record);
  writeActive(baseRoot, id);
  const result = execute(record, { signal: options.signal, resolveAgent: options.resolveAgent, beforeAgentSpawn: options.beforeAgentSpawn, onProgress: options.onProgress, onPhaseProgress: options.onPhaseProgress, onUpdate: options.onUpdate, log: options.log });
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
  return execute(record, { signal: options.signal, resolveAgent: options.resolveAgent, beforeAgentSpawn: options.beforeAgentSpawn, onProgress: options.onProgress, onPhaseProgress: options.onPhaseProgress, onUpdate: options.onUpdate, log: options.log });
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
