/** Durable, bounded campaign engine used by the autonomous loop. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { runAgent, type CommandResult, type EffectiveAgent } from "../agent/runner.ts";
import { EXTENSION_DIR, PACKAGE_DIR } from "../layout.ts";
import { defaultSearchConfig, experimentSeed, experimentWorkspace, experimentWorldPath, runExperiment, type ExperimentWorld, type SearchConfig } from "./experiment.ts";
import { CampaignBudget, CampaignLimitError } from "./budget.ts";
import { buildCandidatePatch, patchConflicts, verifyCandidatePatch, applyCandidatePatch, reconcileCandidatePatch, runCampaignGate, workspaceDigest, WorkspaceDriftDuringApplyError, type CandidatePatch } from "./campaign-patch.ts";
import { scoreSeedCopy } from "./score.ts";
import { absoluteGain } from "./intake.ts";
import { normalizeTask, scoringFingerprint, type AgentConfig, type TaskConfig } from "./task.ts";
import { readJson, writeFileAtomic, writeJson } from "./fsutil.ts";
import { allocator, acquirePhase, phaseIsActive } from "./ownership.ts";
import type { ProgressObserver } from "./progress.ts";
import { loadPrompt, renderPrompt } from "./prompt.ts";
import { parseThreshold, resolveThreshold, planTest } from "./measure.ts";
import { appendLedgerRecord, readLedger, ledgerHealth, type LedgerAgentRole, type LedgerEntry, type LedgerRecord } from "./ledger.ts";

export type CampaignAgentResolver = (savedAgent: AgentConfig) => AgentConfig | null;

interface Candidate {
  iteration: number;
  cell: string;
  score: number;
  raw_score: number | null;
  fail_class: string;
  workspace: string | null;
  program: string | null;
}

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

/** Hard operational ceilings, separate from the default values callers inherit. */
export const CAMPAIGN_LIMIT_MAXIMUMS: CampaignLimits = {
  maxCycles: 5,
  maxAgentStarts: 36,
  maxEvaluatorRuns: 100,
  deadlineMs: 720 * 60 * 1000,
  plateauCycles: 2,
  maxCandidatesPerCycle: 3,
};

/** The deadline a caller may request for one campaign (12 h), matching the loop's ceiling. */
export const CAMPAIGN_DEADLINE_MAX_MS = CAMPAIGN_LIMIT_MAXIMUMS.deadlineMs;

export const DEFAULT_CAMPAIGN_LIMITS: CampaignLimits = {
  ...CAMPAIGN_LIMIT_MAXIMUMS,
  deadlineMs: 60 * 60 * 1000,
};

/** The default two experiment attempts plus the candidate review. */
export const PROMOTION_AGENT_STARTS = defaultSearchConfig.batchSize + 1;
/** Minimum pairs in a noisy paired confirmation, matching the campaign's plan floor. */
export const PROMOTION_MIN_CONFIRMATION_PAIRS = 2;

export interface PromotionFloorInput {
  /** Evaluator readings still to take. A fresh campaign check plans 5. */
  readings: number;
  /** Correctness gates still to run on the unchanged target (one evaluator process each). */
  gates?: number;
  /** True when the evaluator repeats one exact value, so one before/after pair confirms a win. */
  deterministic: boolean;
  /** Pairs in a noisy confirmation; defaults to the campaign minimum of 8. */
  pairs?: number;
  /** Observed one-reading duration, or an estimate before the first reading completes. */
  readingMs?: number;
  expectedReadMs?: number;
  baselineReuse?: boolean;
  /** Declared evaluator timeout, used for processes that have not been observed. */
  evaluatorTimeoutMs: number;
  /** Declared agent timeout, for the reporting-only agent allowance. */
  agentTimeoutMs?: number;
}

/**
 * Minimum budget one verified promotion requires, derived from the shipped engine:
 * baseline readings, one process per declared gate, paired confirmation readings,
 * candidate attempts, and an independent review. These minimums match the current
 * experiment and promotion phases so infeasible campaigns stop before spending.
 *
 * `durationMs` is evaluator wall time only; the campaign has always been sized by the
 * evaluator, and the agent allowance is reported separately as `agentMs`. Once one
 * reading has been observed, its wall time estimates every evaluator process in the
 * floor (readings, confirmation, gates); before that the declared timeout is the only
 * available bound. The estimate is a floor, not a guarantee: a gate that runs longer
 * than a reading can still exhaust the deadline.
 */
export function promotionFloor(input: PromotionFloorInput): PromotionFloor {
  if (!Number.isFinite(input.readings) || input.readings < 0) throw new Error("promotionFloor readings must be a non-negative number");
  if (!Number.isFinite(input.evaluatorTimeoutMs) || input.evaluatorTimeoutMs <= 0) throw new Error("promotionFloor evaluatorTimeoutMs must be positive");
  const readings = Math.trunc(input.readings);
  const gates = Math.max(0, Math.trunc(input.gates ?? 0));
  const pairs = Math.max(2, Math.min(64, Math.floor(Math.trunc(input.pairs ?? PROMOTION_MIN_CONFIRMATION_PAIRS) / 2) * 2));
  const confirmationRuns = input.deterministic ? 2 : (input.baselineReuse ? 0 : 5) + 2 * pairs;
  const observed = typeof input.readingMs === "number" && Number.isFinite(input.readingMs) && input.readingMs > 0 ? input.readingMs : null;
  const expected = typeof input.expectedReadMs === "number" && Number.isFinite(input.expectedReadMs) && input.expectedReadMs > 0 ? input.expectedReadMs : null;
  const readingMs = observed ?? expected ?? input.evaluatorTimeoutMs;
  const durationMs = Math.ceil((readings + gates + confirmationRuns) * readingMs);
  const agentMs = typeof input.agentTimeoutMs === "number" && Number.isFinite(input.agentTimeoutMs) && input.agentTimeoutMs > 0
    ? PROMOTION_AGENT_STARTS * input.agentTimeoutMs
    : null;
  return {
    evaluatorRuns: readings + gates + confirmationRuns,
    agentStarts: PROMOTION_AGENT_STARTS,
    durationMs,
    readings,
    gates,
    confirmationRuns,
    deterministic: input.deterministic,
    agentMs,
  };
}

export interface PromotionFloor { evaluatorRuns: number; agentStarts: number; durationMs: number; readings: number; gates: number; confirmationRuns: number; deterministic: boolean; agentMs: number | null; }

/** Raised before any spend when the requested caps cannot fund one verified promotion. */
export class CampaignInfeasibleError extends Error {
  readonly floor: PromotionFloor;
  readonly recommended: { evaluatorRuns: number; agentStarts: number; deadlineMs: number };
  constructor(reason: string, floor: PromotionFloor, recommended: { evaluatorRuns: number; agentStarts: number; deadlineMs: number }) {
    super(reason);
    this.name = "CampaignInfeasibleError";
    this.floor = floor;
    this.recommended = recommended;
  }
}

type RunningPhase = "baseline" | "experiment" | "promote";
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
  searchConfig: SearchConfig;
  mechanism?: string;
  parentCampaignId?: string;
  minimumGain: number;
  requestedMinimumGain?: number | string;
  /** Per-promotion false-accept allowance assigned by the caller (see MeasurementPlan). */
  confirmationAlpha?: number;
  expectedReadMs?: number;
  /** Optional extra file/directory contents that define the scoring instrument. */
  identityInputs?: string[];
  checkReport?: CampaignCheckReport;
  /** Readings persisted as they complete, so an interrupted check resumes without paying again. */
  checkRuns?: CampaignCheckRun[];
  appliedIteration?: number;
  decidedPatches?: string[];
  minimumGainSource?: "explicit" | "calibrated";
  baselineScores?: number[];
  rawBaselineScores?: number[];
  gates?: string[];
  /** Permit a known-failing baseline gate; candidate gates still have to pass before promotion. */
  allowFailingBaselineGates?: boolean;
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
  pendingConfirmation?: { iteration: number; candidate: Candidate; patch: CandidatePatch[]; patchHash: string; evidenceDir: string; confirmationIdentity: string; targetDigest: string; pairs: number; maxPairs: number };
  pendingApply?: { iteration: number; candidate: Candidate; patch: CandidatePatch[]; before: number; after: number; transactionId: string };
  /** The agent command/model actually used by this campaign's latest child process. */
  effectiveAgent?: EffectiveAgent;
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
  searchConfig: SearchConfig;
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
  pendingConfirmation?: { iteration: number; cell: string; pairs: number; maxPairs: number };
  /** Evaluator preflight evidence, including a partial check after an abort. */
  check?: { qualified: boolean; runs: CampaignCheckRun[]; diagnoses: string[]; reportPath: string | null };
  /** The agent command/model actually used by this campaign's latest child process. */
  effectiveAgent?: EffectiveAgent;
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
  expectedReadMs?: number;
  /** The normal `.dream-rsi` container; each campaign is isolated under its `campaigns/` child. */
  baseRoot: string;
  projectDir: string;
  task: TaskConfig;
  searchConfig?: SearchConfig;
  goal: string;
  scope?: string[];
  verifierInputs?: string[];
  minimumGain?: number | string;
  /** Preserve failed baseline gates as required candidate gates instead of rejecting preflight. */
  allowFailingBaselineGates?: boolean;
  gates?: string[];
  /** Loop qualification readings to reuse when their identity matches this campaign's verifier. */
  seedReadings?: CampaignSeedReadings;
  /** Extra instrument files/directories hashed into the verifier identity (may be inside the workspace). */
  identityInputs?: string[];
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
  /** Research decision and predecessor that selected this campaign. */
  mechanism?: string;
  parentCampaignId?: string;
}

export interface CampaignCheckRun {
  durationMs: number;
  code: number | null;
  valid: boolean;
  failClass: string;
  score: number | null;
  rawScore?: number | null;
  error: string | null;
  /** Last 2000 characters of the reading's stdout, when a process ran. */
  stdoutTail?: string;
  /** Last 2000 characters of the reading's stderr, when a process ran. */
  stderrTail?: string;
  /** Per-reading log file under the check log root; null when no process ran (seeded). */
  logPath?: string | null;
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
  /** Minimum detectable effect including the requested gain, relative to the baseline. */
  mde_rel: number | null;
  /**
   * Instrument resolution: the smallest effect the measurement itself can resolve,
   * relative to the baseline, excluding the requested gain. A large requested gain
   * must not by itself look like an unreadable instrument.
   */
  resolution_rel: number | null;
  threshold_resolved: number;
  confirmationCostMs: number;
  /** True only when every planned reading ran valid and every gate passed. */
  qualified: boolean;
  /** Readings this check planned to take (5 for a campaign preflight). */
  plannedRuns: number;
}

export interface CampaignCheckOptions {
  /** Per-promotion false-accept allowance assigned by the caller. */
  confirmationAlpha?: number;
  baseRoot: string;
  projectDir: string;
  task: TaskConfig;
  verifierInputs?: string[];
  gates?: string[];
  /** Preserve failed baseline gates as required candidate gates instead of rejecting preflight. */
  allowFailingBaselineGates?: boolean;
  runs?: number;
  /** Readings already paid for by an interrupted check; the check continues after them. */
  priorRuns?: CampaignCheckRun[];
  /** Called after each recorded reading; a shortfall stops the check before gates run. */
  onReading?: (run: CampaignCheckRun, index: number) => { shortfall?: string } | void;
  /** Root for per-reading logs; defaults to <baseRoot>/checks. */
  logRoot?: string;
  /** Extra instrument files/directories hashed into the check identity (may be inside the workspace). */
  identityInputs?: string[];
  maxEvaluatorRuns?: number;
  minimumGain?: number | string;
  maxCycles?: number;
  deadlineMs?: number;
  beforeEvaluatorSpawn?: (key: string) => void;
  signal?: AbortSignal;
}

/** Loop qualification readings offered to a campaign so the baseline is not paid for twice. */
export interface CampaignSeedReadings {
  identity: string;
  runs: CampaignCheckRun[];
}

export interface CampaignResumeOptions {
  baseRoot: string;
  confirmationOnly?: boolean;
  extendLimits?: { agentStarts: number; evaluatorRuns: number; deadlineMs: number };
  projectDir: string;
  allowFailingBaselineGates?: boolean;
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
  return verifiedLedgerEntries(path.join(root, "history", "ledger.jsonl")).flatMap((entry) => {
    const facts = entry.facts;
    if (entry.kind !== "skip" || entry.outcome !== "rejected" || !facts || typeof facts.iteration !== "number" || typeof facts.cell !== "string" || typeof facts.terminalStage !== "string") return [];
    return [{ iteration: facts.iteration, cell: facts.cell, stage: facts.terminalStage, reasons: typeof facts.reason === "string" ? [facts.reason] : [] }];
  }).slice(-3);
}

/** True for a report written by this version or inferred for a legacy/partial one. */
function checkReportQualified(report: CampaignCheckReport): boolean {
  if (typeof report.qualified === "boolean") return report.qualified;
  const planned = typeof report.plannedRuns === "number" ? report.plannedRuns : report.runs.length;
  return report.runs.length >= planned && report.runs.every((run) => run.valid) && report.gateRuns.every((gate) => gate.passed);
}

function checkStatusOf(record: CampaignRecord): CampaignStatus["check"] {
  const report = record.checkReport;
  // Per-reading evidence is persisted as it lands, so it is fresher than the last
  // completed report when a resumed check was interrupted again.
  const runs = record.checkRuns?.length ? record.checkRuns : report?.runs ?? [];
  if (!report && runs.length === 0) return undefined;
  return {
    qualified: report ? checkReportQualified(report) : false,
    runs,
    diagnoses: report?.diagnoses ?? [],
    reportPath: report?.reportPath ?? null,
  };
}

interface CampaignLimitExtension {
  version: 1; campaignId: string;
  previous: { maxAgentStarts: number; maxEvaluatorRuns: number; deadlineMs: number; deadlineAt: string };
  next: { maxAgentStarts: number; maxEvaluatorRuns: number; deadlineMs: number; deadlineAt: string };
}
function recoverLimitExtension(record: CampaignRecord): void {
  const file = path.join(record.campaignRoot, "limit-extension.json");
  const change = readJson<CampaignLimitExtension>(file);
  if (!change) return;
  if (change.version !== 1 || change.campaignId !== record.id
    || [change.previous.maxAgentStarts, change.previous.maxEvaluatorRuns, change.previous.deadlineMs, change.next.maxAgentStarts, change.next.maxEvaluatorRuns, change.next.deadlineMs].some((value) => !Number.isSafeInteger(value) || value < 0)
    || change.next.maxAgentStarts < change.previous.maxAgentStarts || change.next.maxEvaluatorRuns < change.previous.maxEvaluatorRuns || change.next.deadlineMs < change.previous.deadlineMs
    || !Number.isFinite(Date.parse(change.previous.deadlineAt)) || !Number.isFinite(Date.parse(change.next.deadlineAt))
    || Date.parse(change.next.deadlineAt) !== Date.parse(change.previous.deadlineAt) + change.next.deadlineMs - change.previous.deadlineMs) throw new Error("campaign limit extension journal is invalid");
  const ledgerPath = path.join(record.campaignRoot, "campaign-processes.json");
  const ledger = readJson<{ version: number; agent_limit: number; evaluator_limit: number; agent_starts: number; evaluator_runs: number }>(ledgerPath);
  if (!ledger || ledger.version !== 1 || !Number.isSafeInteger(ledger.agent_limit) || !Number.isSafeInteger(ledger.evaluator_limit)
    || !Number.isSafeInteger(ledger.agent_starts) || ledger.agent_starts < 0 || !Number.isSafeInteger(ledger.evaluator_runs) || ledger.evaluator_runs < 0
    || ledger.agent_starts > change.next.maxAgentStarts || ledger.evaluator_runs > change.next.maxEvaluatorRuns) throw new Error("campaign limit extension ledger is invalid");
  const oldCaps = ledger.agent_limit === change.previous.maxAgentStarts && ledger.evaluator_limit === change.previous.maxEvaluatorRuns;
  const newCaps = ledger.agent_limit === change.next.maxAgentStarts && ledger.evaluator_limit === change.next.maxEvaluatorRuns;
  if ((!oldCaps && !newCaps) || (oldCaps && (ledger.agent_starts > change.previous.maxAgentStarts || ledger.evaluator_runs > change.previous.maxEvaluatorRuns))) throw new Error("campaign limit extension does not match the saved process ledger");
  if (oldCaps) new CampaignBudget(record.campaignRoot, change.previous.maxAgentStarts, change.previous.maxEvaluatorRuns).extendLimits(change.next.maxAgentStarts, change.next.maxEvaluatorRuns);
  const recordOld = record.limits.maxAgentStarts === change.previous.maxAgentStarts && record.limits.maxEvaluatorRuns === change.previous.maxEvaluatorRuns && record.limits.deadlineMs === change.previous.deadlineMs && record.deadlineAt === change.previous.deadlineAt;
  const recordNew = record.limits.maxAgentStarts === change.next.maxAgentStarts && record.limits.maxEvaluatorRuns === change.next.maxEvaluatorRuns && record.limits.deadlineMs === change.next.deadlineMs && record.deadlineAt === change.next.deadlineAt;
  if (!recordOld && !recordNew) throw new Error("campaign limit extension does not match the saved campaign record");
  if (recordOld) {
    record.limits.maxAgentStarts = change.next.maxAgentStarts;
    record.limits.maxEvaluatorRuns = change.next.maxEvaluatorRuns;
    record.limits.deadlineMs = change.next.deadlineMs;
    record.deadlineAt = change.next.deadlineAt;
    persist(record);
  }
  fs.rmSync(file, { force: true });
}
function extendPendingConfirmation(record: CampaignRecord, extra: { agentStarts: number; evaluatorRuns: number; deadlineMs: number }): void {
  if (!record.pendingConfirmation || record.state.kind !== "paused" || record.state.phase !== "promote") throw new Error("only a paused pending confirmation can receive more allowance");
  for (const [name, value] of Object.entries(extra)) if (!Number.isSafeInteger(value) || value < 0) throw new Error(`confirmation ${name} extension must be a non-negative integer`);
  if (extra.agentStarts + extra.evaluatorRuns + extra.deadlineMs === 0) throw new Error("no remaining allowance is available for confirmation");
  const previous = { maxAgentStarts: record.limits.maxAgentStarts, maxEvaluatorRuns: record.limits.maxEvaluatorRuns, deadlineMs: record.limits.deadlineMs, deadlineAt: record.deadlineAt };
  const next = { maxAgentStarts: previous.maxAgentStarts + extra.agentStarts, maxEvaluatorRuns: previous.maxEvaluatorRuns + extra.evaluatorRuns, deadlineMs: previous.deadlineMs + extra.deadlineMs, deadlineAt: new Date(Date.parse(previous.deadlineAt) + extra.deadlineMs).toISOString() };
  const file = path.join(record.campaignRoot, "limit-extension.json");
  writeFileAtomic(file, `${JSON.stringify({ version: 1, campaignId: record.id, previous, next } satisfies CampaignLimitExtension)}\n`, true);
  new CampaignBudget(record.campaignRoot, previous.maxAgentStarts, previous.maxEvaluatorRuns).extendLimits(next.maxAgentStarts, next.maxEvaluatorRuns);
  record.limits.maxAgentStarts = next.maxAgentStarts;
  record.limits.maxEvaluatorRuns = next.maxEvaluatorRuns;
  record.limits.deadlineMs = next.deadlineMs;
  record.deadlineAt = next.deadlineAt;
  persist(record);
  fs.rmSync(file, { force: true });
}

function statusOf(record: CampaignRecord): CampaignStatus {
  recoverLimitExtension(record);
  const budget = new CampaignBudget(record.campaignRoot, record.limits.maxAgentStarts, record.limits.maxEvaluatorRuns).read();
  return {
    id: record.id, baseRoot: record.baseRoot, campaignRoot: record.campaignRoot, engineRoot: record.campaignRoot,
    projectDir: record.projectDir, targetRoot: record.targetRoot, scope: record.scope, goal: record.goal,
    state: record.state, limits: record.limits, agentStarts: budget.agent_starts, evaluatorRuns: budget.evaluator_runs,
    completedCycles: record.completedCycles, currentScore: record.currentScore, bestScore: record.bestScore,
    noGainCycles: record.noGainCycles, startedAt: record.startedAt, deadlineAt: record.deadlineAt,
    effectiveEvaluatorTimeoutMs: record.task.evaluator_timeout_ms,
    rejections: readRejections(record.campaignRoot), searchConfig: record.searchConfig ?? defaultSearchConfig,
    health: ledgerHealth(campaignMemory(record)),
    ...(record.pendingConfirmation ? { pendingConfirmation: { iteration: record.pendingConfirmation.iteration, cell: record.pendingConfirmation.candidate.cell, pairs: record.pendingConfirmation.pairs, maxPairs: record.pendingConfirmation.maxPairs } } : {}),
    ...(checkStatusOf(record) ? { check: checkStatusOf(record)! } : {}),
    ...(record.effectiveAgent ? { effectiveAgent: record.effectiveAgent } : {}),
  };
}
function emit(record: CampaignRecord, options: Pick<CampaignOptions, "onProgress" | "onUpdate">): void {
  options.onUpdate?.(statusOf(record));
}
function writeActive(baseRoot: string, id: string): void { writeFileAtomic(activeFile(baseRoot), `${JSON.stringify({ id })}\n`, true); }
/** Keep detailed workspaces for the two newest terminal campaigns; worlds remain replayable. */
export function pruneCampaignWork(baseRoot: string): void {
  const parent = path.join(path.resolve(baseRoot), "campaigns");
  if (!fs.existsSync(parent)) return;
  const terminal: { root: string; startedAt: string }[] = [];
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(parent, entry.name);
    const record = readJson<CampaignRecord>(path.join(root, "campaign.json"));
    if (!record || record.version !== 1 || (record.state.kind !== "complete" && record.state.kind !== "failed")) continue;
    terminal.push({ root, startedAt: record.startedAt });
  }
  terminal.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.root.localeCompare(a.root));
  for (const old of terminal.slice(2)) {
    const cycles = path.join(old.root, "cycles");
    if (!fs.existsSync(cycles)) continue;
    for (const cycle of fs.readdirSync(cycles, { withFileTypes: true })) {
      if (!cycle.isDirectory()) continue;
      fs.rmSync(path.join(cycles, cycle.name, "work"), { recursive: true, force: true });
      fs.rmSync(path.join(cycles, cycle.name, "seed"), { recursive: true, force: true });
    }
  }
}
function assertNotAborted(signal: AbortSignal): void { if (signal.aborted) throw new Error("campaign stopped"); }
function assertVerifierIdentity(record: CampaignRecord): void {
  if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? [], record.identityInputs ?? []) !== record.verifierIdentity) {
    appendCampaignLedger(record, { kind: "integrity", campaignId: record.id, outcome: "verifier-changed", stage: "integrity" });
    throw new Error("task/evaluator identity changed during campaign; refusing incomparable results");
  }
}

const ledgerFile = (record: CampaignRecord): string => path.join(record.campaignRoot, "history", "ledger.jsonl");

function appendCampaignLedger(record: CampaignRecord, event: LedgerRecord): LedgerEntry {
  const baselineFingerprint = crypto.createHash("sha256").update(JSON.stringify({
    instrumentId: record.verifierIdentity,
    scores: record.baselineScores ?? [record.baselineScore, record.baselineRepeatScore, record.currentScore].filter((value): value is number => typeof value === "number"),
  })).digest("hex");
  return appendLedgerRecord(ledgerFile(record), {
    ...event,
    provenance: {
      contractId: crypto.createHash("sha256").update(JSON.stringify(record.task)).digest("hex"),
      instrumentId: record.verifierIdentity,
      baselineFingerprint,
      ...(record.mechanism ? { mechanism: record.mechanism } : {}),
      ...(record.parentCampaignId ? { parentCampaignId: record.parentCampaignId } : {}),
    },
  });
}

function campaignMemory(record: CampaignRecord): LedgerEntry[] {
  const parent = path.join(record.baseRoot, "campaigns");
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent).sort().flatMap((id) => {
    const root = path.join(parent, id);
    const prior = readRecord(root);
    if (!prior || path.resolve(prior.projectDir) !== path.resolve(record.projectDir) || prior.taskFingerprint !== record.taskFingerprint || prior.verifierIdentity !== record.verifierIdentity) return [];
    return verifiedLedgerEntries(path.join(root, "history", "ledger.jsonl"));
  });
}

function verifiedLedgerEntries(file: string): LedgerEntry[] {
  const ledger = readLedger(file);
  if (ledger.diagnostics.length > 0) throw new Error(`experiment ledger integrity check failed: ${ledger.diagnostics.join("; ")}`);
  return ledger.entries;
}

function measurementPlan(record: CampaignRecord, maxPairs = 8) {
  const threshold = parseThreshold(record.requestedMinimumGain ?? record.minimumGain);
  const raw = record.task.higher_is_better ? record.currentScore : -record.currentScore;
  return planTest({ baseline: record.baselineScores ?? [record.currentScore], higherIsBetter: record.task.higher_is_better,
    threshold: resolveThreshold(threshold, raw, record.task.higher_is_better), relative: threshold.kind === "relative", maxCycles: record.limits.maxCycles, maxPairs,
    ...(record.confirmationAlpha === undefined ? {} : { alphaConf: record.confirmationAlpha }) });
}

/**
 * Trailing non-editing agent errors recorded in the cycles before `iteration`.
 *
 * The current cycle is excluded: its own attempts are already in the saved world, and
 * counting both would report one error twice.
 */
function priorAgentErrorStreak(record: CampaignRecord, iteration: number): number {
  const attempts = verifiedLedgerEntries(ledgerFile(record)).filter((entry) => entry.kind === "attempt"
    && typeof entry.facts?.iteration === "number" && (entry.facts.iteration as number) < iteration);
  let streak = 0;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const entry = attempts[index]!;
    // `edited` is the attempt-local fact. The cumulative patch size cannot decide this:
    // a refinement that inherited its parent's change reports a non-zero size while it
    // changed nothing itself.
    const noEdit = entry.facts?.edited === false
      || (entry.facts?.edited === undefined && (entry.editCount ?? 0) === 0);
    if (entry.outcome === "agent_error" && noEdit) streak += 1;
    else break;
  }
  return streak;
}

function recordExperimentAttempts(record: CampaignRecord, iteration: number, world: ExperimentWorld): void {
  const prior = verifiedLedgerEntries(ledgerFile(record));
  for (const node of world.nodes) {
    if (node.stage !== "done" || prior.some((entry) => entry.kind === "attempt" && entry.facts?.iteration === iteration && entry.facts?.cell === node.id)) continue;
    const workspace = experimentWorkspace(record.campaignRoot, iteration, node.id);
    const proposal = workspace ? path.join(workspace, "proposal.md") : null;
    const title = proposal && fs.existsSync(proposal) ? fs.readFileSync(proposal, "utf8").split(/\r?\n/).find((line) => line.trim()) : undefined;
    const evidence = readJson<{ agent?: { evidence?: NonNullable<CommandResult["evidence"]> } }>(path.join(record.campaignRoot, "cycles", `c${String(iteration).padStart(4, "0")}`, "attempts", node.id, "attempt-evidence.json"))?.agent?.evidence;
    let editCount: number | undefined;
    if (workspace && fs.existsSync(workspace)) {
      try { editCount = buildCandidatePatch({ cycleSeedRoot: experimentSeed(record.campaignRoot, iteration), targetRoot: record.targetRoot,
        candidateRoot: workspace, scope: record.scope, exclude: ["proposal.md", record.task.score_path, ...record.task.copy_exclude] }).length; }
      catch { /* Scope violations retain an unknown edit count and face the promotion patch check. */ }
    }
    appendCampaignLedger(record, { kind: "attempt", campaignId: record.id, stage: "attempt",
      agent: "experiment", outcome: node.failClass ?? "unknown", title, editCount,
      ...(evidence ? { verifierRead: evidence.verifierRead } : {}),
      facts: { iteration, cell: node.id, mode: "experiment",
        score: node.score, valid: node.valid, timedOut: node.timedOut, measured: typeof node.score === "number",
        // Whether this attempt changed its own workspace. The cumulative patch size
        // above can be non-zero for a refinement that inherited its parent's change.
        edited: node.edited === true } });
  }
}

function recordAgentResult(record: CampaignRecord, role: LedgerAgentRole, result: CommandResult): void {
  if (result.effectiveAgent) {
    record.effectiveAgent = result.effectiveAgent;
    persist(record);
  }
  appendCampaignLedger(record, {
    kind: "agent_result",
    campaignId: record.id,
    stage: role === "review" ? "review" : "attempt",
    agentRole: role,
    outcome: result.ok && !result.timedOut && !result.aborted ? "success" : "failed",
    agentDurationMs: result.durationMs,
    ...(result.evidence ? { usage: result.evidence.usage } : {}),
    facts: { timedOut: result.timedOut, aborted: result.aborted ?? false, spawnFailed: result.spawnError !== null },
  });
}

function recordDispositions(record: CampaignRecord, iteration: number): void {
  const entries = verifiedLedgerEntries(ledgerFile(record));
  for (const attempt of entries.filter((entry) => entry.kind === "attempt" && entry.facts?.iteration === iteration)) {
    const cell = attempt.facts?.cell;
    if (typeof cell !== "string" || entries.some((entry) => entry.kind !== "attempt" && entry.facts?.iteration === iteration && entry.facts?.cell === cell)) continue;
    appendCampaignLedger(record, { kind: "skip", campaignId: record.id, stage: "skip", outcome: "not-selected", title: attempt.title,
      facts: { iteration, cell, reason: "Not confirmed within this cycle's selection and process budgets" } });
  }
}

function hashInputs(projectDir: string, task: TaskConfig, inputs: string[], gates: string[] = [], identityInputs: string[] = []): string {
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
  // Extra identity-only inputs (for example a contract-declared evaluator's own code and
  // fixtures) are hashed as part of the scoring identity but are not held to the
  // trusted-verifier path rules: they may live inside the editable workspace, because a
  // change to them must invalidate comparability rather than be refused outright.
  for (const input of [...new Set(identityInputs)].sort()) visit(projectDir, input);
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

function relativeEvaluatorPathDiagnoses(task: TaskConfig, targetRoot: string, scratchRoot: string): string[] {
  const diagnoses: string[] = [];
  const tokens = task.score_program.match(/"[^"\n]+"|'[^'\n]+'|[^\s]+/g) ?? [];
  for (const raw of tokens) {
    const token = raw.replace(/^("|')(.*)\1$/, "$2").replace(/^--[^=]+=\s*/, "");
    const looksLikePath = !path.isAbsolute(token) && (token.startsWith(".") || token.includes("/") || token.includes("\\") || /\.(?:mjs|cjs|js|ts|tsx|py|sh|ps1|rb|pl)$/i.test(token));
    if (!looksLikePath) continue;
    const targetPath = path.resolve(targetRoot, token);
    const scratchPath = path.resolve(scratchRoot, token);
    if (!contains(scratchRoot, scratchPath) && (fs.existsSync(targetPath) || token.split(/[\\/]+/).includes(".."))) {
      diagnoses.push(`score_program path ${token} resolves from the target but escapes the scratch copy; use an absolute path`);
      break;
    }
  }
  return diagnoses;
}

/** Bounded evidence kept per reading, so an aborted check never loses its reason. */
function tailOf(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(-2000) : undefined;
}

/** A persisted reading is trusted only for its shape; it is never re-derived from a file. */
function normalizeCheckRun(value: CampaignCheckRun): CampaignCheckRun | null {
  if (!value || typeof value !== "object") return null;
  if (typeof value.valid !== "boolean" || typeof value.failClass !== "string") return null;
  return {
    durationMs: typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : 0,
    code: typeof value.code === "number" && Number.isFinite(value.code) ? value.code : null,
    valid: value.valid,
    failClass: value.failClass,
    score: typeof value.score === "number" && Number.isFinite(value.score) ? value.score : null,
    ...(typeof value.rawScore === "number" && Number.isFinite(value.rawScore) ? { rawScore: value.rawScore } : {}),
    error: typeof value.error === "string" ? value.error : null,
    ...(typeof value.stdoutTail === "string" ? { stdoutTail: value.stdoutTail.slice(-2000) } : {}),
    ...(typeof value.stderrTail === "string" ? { stderrTail: value.stderrTail.slice(-2000) } : {}),
    ...(typeof value.logPath === "string" || value.logPath === null ? { logPath: value.logPath } : {}),
  };
}

function describeCheckRun(run: CampaignCheckRun, index: number): string {
  const reading = `reading ${index + 1}`;
  if (run.valid) return `${reading} valid, score ${run.score}`;
  return `${reading} ${run.failClass}${run.error ? `: ${run.error}` : ""}`;
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
  const plannedRuns = options.runs ?? 5;
  if (!Number.isSafeInteger(plannedRuns) || plannedRuns < 1 || plannedRuns > 5) throw new Error("check runs must be an integer between 1 and 5");
  if (gates.some((gate) => typeof gate !== "string" || gate.trim() === "")) throw new Error("gate commands must be non-empty strings");
  assertTrustedVerifier(projectDir, targetRoot, baseRoot, task, verifierInputs);
  const identityInputs = [...new Set(options.identityInputs ?? [])].sort();
  const checkIdentity = hashInputs(projectDir, task, verifierInputs, gates, identityInputs);
  const checkIntegrity = (): void => {
    if (hashInputs(projectDir, task, verifierInputs, gates, identityInputs) !== checkIdentity) throw new Error("task/evaluator identity changed during campaign check");
  };
  const checkedAt = new Date().toISOString();
  const scratchParent = path.join(baseRoot, "runtime", "checks");
  const pathDiagnoses = relativeEvaluatorPathDiagnoses(task, targetRoot, scratchParent);
  const diagnoses = [...pathDiagnoses];
  const checkDir = path.join(baseRoot, "checks");
  // One directory per check, so a later check cannot overwrite an older report's logs.
  const checkId = `${checkedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const logRoot = path.resolve(options.logRoot ?? checkDir, checkId);
  fs.mkdirSync(logRoot, { recursive: true });
  fs.mkdirSync(checkDir, { recursive: true });
  const reportPath = path.join(checkDir, `${checkId}.json`);
  // Readings already paid for in a previous process are reused, never re-run.
  const runResults: CampaignCheckRun[] = (Array.isArray(options.priorRuns) ? options.priorRuns : [])
    .slice(0, plannedRuns)
    .flatMap((run) => { const normalized = normalizeCheckRun(run); return normalized ? [normalized] : []; });
  const gateRuns: CampaignCheckReport["gateRuns"] = [];
  let stopReason: string | null = null;

  const aggregates = () => {
    const validScores = runResults.flatMap((run) => run.valid && run.score !== null ? [run.score] : []);
    const allValid = runResults.length > 0 && runResults.every((run) => run.valid);
    const rawSpread = allValid ? Math.max(...validScores) - Math.min(...validScores) : null;
    const spread = rawSpread !== null && Number.isFinite(rawSpread) ? rawSpread : null;
    const maxDuration = runResults.length > 0 ? Math.max(...runResults.map((run) => run.durationMs)) : 0;
    // The observed-process floor is the fastest real reading: it estimates the typical
    // evaluator cost without turning a transient load spike into a refused campaign.
    const observedDurations = runResults.flatMap((run) => run.durationMs > 0 ? [run.durationMs] : []);
    const observedMs = observedDurations.length > 0 ? Math.min(...observedDurations) : null;
    const mean = validScores.length ? validScores.reduce((sum, value) => sum + value / validScores.length, 0) : 0;
    const variance = validScores.length > 1 ? validScores.reduce((sum, value) => sum + ((value - mean) / Math.sqrt(validScores.length - 1)) ** 2, 0) : 0;
    const noise = Math.sqrt(variance);
    const deterministic = spread === 0 && validScores.length >= 2;
    const noiseRel = mean !== 0 && Number.isFinite(noise) ? noise / Math.abs(mean) : null;
    const parsedThreshold = parseThreshold(options.minimumGain ?? 0);
    const rawBaseline = task.higher_is_better ? mean : -mean;
    const thresholdResolved = absoluteGain(options.minimumGain ?? 0, mean);
    const plannedPairs = Math.max(8, Math.min(32, Math.floor(((options.maxEvaluatorRuns ?? DEFAULT_CAMPAIGN_LIMITS.maxEvaluatorRuns) - 16 - 2 * gates.length) / 8) * 4));
    const plan = validScores.length >= 2 && spread !== null ? planTest({ baseline: validScores, higherIsBetter: task.higher_is_better,
      ...(options.confirmationAlpha === undefined ? {} : { alphaConf: options.confirmationAlpha }),
      threshold: resolveThreshold(parsedThreshold, rawBaseline, task.higher_is_better), relative: parsedThreshold.kind === "relative", maxCycles: options.maxCycles ?? DEFAULT_CAMPAIGN_LIMITS.maxCycles, maxPairs: plannedPairs }) : null;
    const mdeRel = plan?.mdeRel ?? null;
    // Resolution excludes the requested threshold: a 50% target is not evidence that
    // the instrument cannot resolve a change; only the noise-driven component is.
    const resolutionRel = plan === null ? null
      : plan.relative
        ? (task.higher_is_better ? Math.expm1(plan.minimumDetectableEffect) : -Math.expm1(-plan.minimumDetectableEffect))
        : (mean !== 0 && Number.isFinite(plan.minimumDetectableEffect) ? Math.abs(plan.minimumDetectableEffect / mean) : null);
    const confirmationCostMs = Math.ceil((observedMs ?? maxDuration) * (deterministic ? 2 : 2 * PROMOTION_MIN_CONFIRMATION_PAIRS));
    return { validScores, allValid, rawSpread, spread, maxDuration, observedMs, mean, deterministic, noiseRel, thresholdResolved, plan, mdeRel, resolutionRel, confirmationCostMs };
  };

  const buildReport = (): CampaignCheckReport => {
    const stats = aggregates();
    const readingsComplete = runResults.length === plannedRuns && runResults.every((run) => run.valid);
    const gatesComplete = gateRuns.length === gates.length
      && (options.allowFailingBaselineGates === true || gateRuns.every((gate) => gate.passed));
    const qualified = stopReason === null && readingsComplete && gatesComplete
      && (stats.rawSpread === null || stats.spread !== null)
      && (stats.resolutionRel === null || stats.resolutionRel <= 0.5)
      && (options.deadlineMs === undefined || stats.confirmationCostMs <= options.deadlineMs);
    const report: CampaignCheckReport = {
      checkedAt, runs: runResults, spread: stats.spread,
      recommendedEvaluatorTimeoutMs: Math.max(30_000, Math.ceil(stats.maxDuration * 3)),
      recommendedMinimumGain: 0, diagnoses, gateRuns, reportPath,
      direction: task.higher_is_better ? "maximize" : "minimize", deterministic: stats.deterministic,
      noise_rel: stats.noiseRel, mde_rel: stats.mdeRel, resolution_rel: stats.resolutionRel,
      threshold_resolved: stats.thresholdResolved,
      confirmationCostMs: stats.confirmationCostMs, qualified, plannedRuns,
    };
    writeJson(reportPath, report);
    return report;
  };

  try {
    const invalidPrior = runResults.find((run) => !run.valid);
    if (invalidPrior) {
      stopReason = `saved reading was invalid (${invalidPrior.failClass}${invalidPrior.error ? `: ${invalidPrior.error}` : ""})`;
      diagnoses.push(stopReason);
    }
    if (!stopReason && pathDiagnoses.length > 0) {
      runResults.push({ durationMs: 0, code: null, valid: false, failClass: "configuration_error", score: null, error: pathDiagnoses.join("; ") });
      stopReason = "configuration_error";
    }
    // Fail fast: a reading is evidence, not a retry. Stop at the first invalid reading or
    // when the caller reports that the remaining budget cannot fund a promotion.
    for (let index = runResults.length; index < plannedRuns; index += 1) {
      if (stopReason) break;
      if (options.signal?.aborted) throw new Error("evaluator check was cancelled");
      const logPath = path.join(logRoot, `reading-${index + 1}.log`);
      fs.rmSync(logPath, { force: true });
      const commandCapture: { value?: CommandResult } = {};
      const outcome = await scoreSeedCopy({
        dreamRoot: baseRoot,
        projectDir,
        task,
        scratch: path.join(scratchParent, `dream-rsi-check-${crypto.randomUUID()}`),
        logPath,
        evaluatorKey: `check:${index}`,
        signal: options.signal,
        onCommand: (result) => { commandCapture.value = result; },
        beforeEvaluatorSpawn: options.beforeEvaluatorSpawn,
        exclude: contains(targetRoot, baseRoot) ? [baseRoot] : [],
      });
      // A cancelled process is not a reading: never record it as evidence.
      if (options.signal?.aborted) throw new Error("evaluator check was cancelled");
      checkIntegrity();
      const run: CampaignCheckRun = {
        durationMs: commandCapture.value?.durationMs ?? 0,
        code: commandCapture.value?.code ?? null,
        valid: outcome.valid && outcome.fail_class === "ok" && outcome.error === null && typeof outcome.score === "number" && Number.isFinite(outcome.score),
        failClass: outcome.fail_class,
        score: outcome.score,
        rawScore: outcome.raw_score,
        error: outcome.error,
        stdoutTail: tailOf(commandCapture.value?.stdoutTail),
        stderrTail: tailOf(commandCapture.value?.stderrTail),
        logPath,
      };
      runResults.push(run);
      const verdict = options.onReading?.(run, index);
      if (!run.valid) {
        stopReason = `reading ${index + 1} was invalid (${run.failClass}${run.error ? `: ${run.error}` : ""})`;
        diagnoses.push(`evaluator did not produce a valid score on the unchanged target: ${describeCheckRun(run, index)}`);
        break;
      }
      if (verdict?.shortfall) {
        stopReason = `stopped after reading ${index + 1}: ${verdict.shortfall}`;
        diagnoses.push(stopReason);
        break;
      }
    }
    if (!stopReason) {
      for (const [index, gate] of gates.entries()) {
        if (options.signal?.aborted) throw new Error("evaluator check was cancelled");
        const result = await runCampaignGate({
          sourceRoot: targetRoot,
          scratch: path.join(scratchParent, `dream-rsi-check-gate-${crypto.randomUUID()}`),
          command: gate,
          timeoutMs: task.evaluator_timeout_ms,
          key: `check-gate:${index}`,
          signal: options.signal,
          beforeSpawn: options.beforeEvaluatorSpawn,
        });
        if (options.signal?.aborted) throw new Error("evaluator check was cancelled");
        checkIntegrity();
        gateRuns.push({ command: gate, code: result.result.code, passed: result.passed, error: result.result.stderrTail || result.result.spawnError });
        if (!result.passed) {
          if (options.allowFailingBaselineGates) {
            diagnoses.push(`gate fails on the unchanged target and remains mandatory for candidates: ${gate}`);
          } else {
            stopReason = `gate failed on the unchanged target: ${gate}`;
            diagnoses.push(stopReason);
            break;
          }
        }
      }
    }
    // Gates that never ran are recorded as not run, so status never implies they passed.
    for (const gate of gates.slice(gateRuns.length)) {
      gateRuns.push({ command: gate, code: null, passed: false,
        error: pathDiagnoses.length > 0
          ? `not run because the score_program path is unsafe: ${pathDiagnoses.join("; ")}`
          : `not run because the evaluator check stopped early: ${stopReason ?? "the check did not reach the gates"}` });
    }
    const stats = aggregates();
    if (stats.rawSpread !== null && stats.spread === null) diagnoses.push("score spread exceeds the finite numeric range; no reliable minimum_gain recommendation is available");
    if (runResults.some((run) => run.code === 127 || run.code === 9009 || (run.code === 1 && /not found|not recognized|cannot find|is not recognized/i.test(run.error ?? "")))) {
      diagnoses.push("interpreter not found on PATH; on Windows prefer node â€¦");
    }
    if (runResults.some((run) => run.durationMs >= task.evaluator_timeout_ms * 0.8 || run.failClass === "timeout")) {
      diagnoses.push(`evaluator takes ${Math.ceil(stats.maxDuration / 1000)} s; configured timeout is ${task.evaluator_timeout_ms / 1000} s; reduce cases or raise evaluator_timeout_ms`);
    }
    if (stats.resolutionRel !== null && stats.resolutionRel > 0.5) diagnoses.push(`instrument cannot reliably detect an improvement below ${(stats.resolutionRel * 100).toFixed(1)}%; reduce measurement noise`);
    if (options.deadlineMs !== undefined && stats.confirmationCostMs > options.deadlineMs) diagnoses.push("one confirmation cannot fit inside the campaign deadline");
    return buildReport();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // An aborted check must never be reported as qualified, even when every reading and
    // gate it managed to take was valid: the report marks it unfinished.
    stopReason = stopReason ?? `the evaluator check did not finish: ${reason}`;
    if (!diagnoses.includes(reason)) diagnoses.push(`evaluator check did not finish: ${reason}`);
    try { (error as Error & { checkReport?: CampaignCheckReport }).checkReport = buildReport(); } catch { /* the throw is the contract */ }
    throw error;
  }
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
    const max = CAMPAIGN_LIMIT_MAXIMUMS[key as keyof CampaignLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key} must be an integer between 1 and ${max}`);
  }
  return limits;
}

/** Identity of the scoring instrument a campaign will use for one task/input/gate set. */
export function campaignVerifierIdentity(projectDir: string, task: TaskConfig, verifierInputs: string[] = [], gates: string[] = [], identityInputs: string[] = []): string {
  return hashInputs(projectDir, normalizeTask(task), [...new Set(verifierInputs)].sort(), [...gates], [...new Set(identityInputs)].sort());
}

function setPhase(record: CampaignRecord, phase: RunningPhase, iteration: number | null, options: Pick<CampaignOptions, "onProgress" | "onUpdate">): void {
  record.state = { kind: "running", phase, iteration };
  persist(record); emit(record, options);
  options.onProgress?.(iteration === null ? phase : `${phase} cycle ${iteration}`);
}

function makeBudget(record: CampaignRecord, createIfMissing = false): CampaignBudget {
  return new CampaignBudget(record.campaignRoot, record.limits.maxAgentStarts, record.limits.maxEvaluatorRuns, createIfMissing);
}

function withinDeadline(record: CampaignRecord): boolean { return Date.now() < Date.parse(record.deadlineAt); }

/** Fastest observed one-reading wall time; seeded or aborted readings are not observations. */
function observedReadingMs(runs: CampaignCheckRun[]): number | undefined {
  const observed = runs.flatMap((run) => Number.isFinite(run.durationMs) && run.durationMs > 0 ? [run.durationMs] : []);
  return observed.length > 0 ? Math.min(...observed) : undefined;
}

/**
 * Whether the deadline estimate is trustworthy yet: one reading can be a load spike, so
 * the time floor is asserted from the second observation, or before the confirmation once
 * no readings remain.
 */
function timeFloorIsObservable(runs: CampaignCheckRun[], readingsRemaining: number): boolean {
  const count = runs.filter((run) => Number.isFinite(run.durationMs) && run.durationMs > 0).length;
  return count >= 2 || (readingsRemaining === 0 && count >= 1);
}

/** True while repeated valid readings agree exactly; fewer than two readings prove nothing yet. */
function readingsLookDeterministic(runs: CampaignCheckRun[]): boolean {
  const scores = runs.flatMap((run) => run.valid && run.score !== null ? [run.score] : []);
  return scores.length < 2 || scores.every((score) => score === scores[0]);
}

interface CampaignFeasibilityInput {
  limits: CampaignLimits;
  task: TaskConfig;
  /** Evaluator readings still to take. */
  readings: number;
  /** Correctness gates still to run. */
  gates: number;
  /** Observed one-reading wall time; without it the time floor is not asserted. */
  readingMs?: number;
  expectedReadMs?: number;
  /** Extra instrument files/directories hashed into the check identity (may be inside the workspace). */
  identityInputs?: string[];
  spentEvaluatorRuns?: number;
  spentAgentStarts?: number;
  deadlineAt?: string;
  /** Require the noisy confirmation floor once repeated readings disagree. */
  requireNoisy?: boolean;
}

/**
 * The caps needed before one verified promotion is even possible. Agent starts are a hard
 * floor (1 probe + 5 live + 1 review); evaluator runs and (once observed) time are checked
 * against what is still unspent. Returns null when the saved caps can reach the floor.
 */
function campaignFeasibility(input: CampaignFeasibilityInput): { reason: string; floor: PromotionFloor; recommended: { evaluatorRuns: number; agentStarts: number; deadlineMs: number } } | null {
  const evaluatorTimeoutMs = input.task.evaluator_timeout_ms;
  const agentTimeoutMs = input.task.agent_timeout_ms;
  const floorFor = (deterministic: boolean): PromotionFloor => promotionFloor({
    readings: input.readings, gates: input.gates, deterministic,
    ...(input.readingMs !== undefined ? { readingMs: input.readingMs } : {}),
    ...(input.expectedReadMs !== undefined ? { expectedReadMs: input.expectedReadMs } : {}),
    baselineReuse: true,
    evaluatorTimeoutMs, agentTimeoutMs,
  });
  const deterministicFloor = floorFor(true);
  const noisyFloor = floorFor(false);
  const required = input.requireNoisy ? noisyFloor : deterministicFloor;
  const recommended = { evaluatorRuns: noisyFloor.evaluatorRuns, agentStarts: PROMOTION_AGENT_STARTS, deadlineMs: noisyFloor.durationMs };
  const remainingRuns = input.limits.maxEvaluatorRuns - (input.spentEvaluatorRuns ?? 0);
  const remainingAgents = input.limits.maxAgentStarts - (input.spentAgentStarts ?? 0);
  const failures: string[] = [];
  if (required.evaluatorRuns > 0 && remainingRuns < required.evaluatorRuns) {
    failures.push(`${remainingRuns} evaluator run(s) remain but ${required.evaluatorRuns} are needed for ${required.readings} reading(s), ${required.gates} gate(s), one ${required.deterministic ? "exact" : "noisy"} confirmation`);
  }
  if (remainingAgents < PROMOTION_AGENT_STARTS) {
    failures.push(`${remainingAgents} agent start(s) remain but a promotion needs ${PROMOTION_AGENT_STARTS} (two experiment attempts and review)`);
  }
  if (input.readingMs !== undefined && input.deadlineAt !== undefined) {
    const remainingMs = Date.parse(input.deadlineAt) - Date.now();
    if (remainingMs < required.durationMs) {
      failures.push(`${Math.max(0, Math.ceil(remainingMs / 1000))} s of deadline remain but the evaluator floor alone is ${Math.ceil(required.durationMs / 1000)} s`);
    }
  }
  if (failures.length === 0) return null;
  const minutes = (ms: number): number => Math.max(1, Math.ceil(ms / 60_000));
  return {
    reason: `cannot fund one verified promotion: ${failures.join("; ")}. Floors: ${deterministicFloor.evaluatorRuns} evaluator runs if exact (${noisyFloor.evaluatorRuns} if noisy), ${PROMOTION_AGENT_STARTS} agent starts, ${minutes(deterministicFloor.durationMs)} min evaluator time if exact (${minutes(noisyFloor.durationMs)} if noisy). Recommended caps: max_evaluator_runs >= ${recommended.evaluatorRuns}, max_agent_starts >= ${PROMOTION_AGENT_STARTS}, max_deadline_minutes >= ${minutes(recommended.deadlineMs)}. Raise the caps or make the evaluator cheaper; do not retry the same caps.`,
    floor: required,
    recommended,
  };
}

function preflightFailedReason(record: CampaignRecord, cause: string): string {
  const runs = record.checkRuns ?? record.checkReport?.runs ?? [];
  const last = runs.length > 0 ? describeCheckRun(runs[runs.length - 1], runs.length - 1) : "no reading completed";
  return `evaluator preflight failed: never produced a qualified baseline: ${cause}; last reading: ${last}. Fix the evaluator, then start a new campaign.`;
}

function candidatesFor(root: string, iteration: number, task: TaskConfig): Candidate[] {
  const world = readJson<ExperimentWorld>(experimentWorldPath(root, iteration));
  if (!world || world.status !== "complete") return [];
  return world.nodes.filter((node) => node.valid && typeof node.score === "number")
    .sort((a, b) => (b.score as number) - (a.score as number))
    .flatMap((node): Candidate[] => {
      const workspace = experimentWorkspace(root, iteration, node.id);
      const program = path.join(workspace, task.eval_program);
      return fs.existsSync(program) ? [{ iteration, cell: node.id, score: node.score as number, raw_score: task.higher_is_better ? node.score : -node.score!, fail_class: "ok", workspace, program }] : [];
    });
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
  appendCampaignLedger(record, { kind: "skip", campaignId: record.id, stage: "skip", outcome: "rejected", facts: { iteration, cell, terminalStage: stage, reason: reasons.join("; ") } });
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
      verifierRead: readJson<NonNullable<CommandResult["evidence"]>>(path.join(record.campaignRoot, "cycles", `c${String(iteration).padStart(4, "0")}`, "attempts", candidate.cell, "attempt-evidence.json"))?.verifierRead ?? false })}`,
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
    timeoutMs: record.task.agent_timeout_ms,
    logPath: path.join(reviewDir, "agent.log"),
    signal,
    beforeSpawn: () => reserve("agent", `${iteration}:${candidate.cell}:review`),
    onComplete: (result) => recordAgentResult(record, "review", result),
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

async function promoteCandidates(record: CampaignRecord, iteration: number, reserve: (kind: "agent" | "evaluator", key: string) => void, signal: AbortSignal, log: (message: string) => void, resolveAgent?: CampaignAgentResolver): Promise<{ applied: boolean; pending: boolean }> {
  const noisy = scoresAreNoisy(record);
  const maxCandidates = Math.min(2, record.limits.maxCandidatesPerCycle);
  const candidates = record.pendingConfirmation?.iteration === iteration
    ? [record.pendingConfirmation.candidate]
    : candidatesFor(record.campaignRoot, iteration, record.task);
  let confirmations = 0;
  const seedRoot = experimentSeed(record.campaignRoot, iteration);
  const workspaceAbsolute = path.resolve(record.projectDir, record.task.workspace);
  const workspaceRelativeInputs = record.verifierInputs.map((item) => path.relative(workspaceAbsolute, path.resolve(record.projectDir, item)))
    .filter((item) => item !== ".." && !item.startsWith(`..${path.sep}`) && !path.isAbsolute(item));
  const excluded = new Set(workspaceRelativeInputs.map((item) => item.replace(/\\/g, "/").toLowerCase()));
  for (const candidate of candidates) {
    if (confirmations >= maxCandidates) break;
    assertNotAborted(signal);
    if (!withinDeadline(record)) return { applied: false, pending: false };
    if (!noisy && candidate.score < record.currentScore + record.minimumGain) {
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
      appendCampaignLedger(record, { kind: "skip", campaignId: record.id, stage: "skip", outcome: "duplicate", patchHash, facts: { iteration, cell: candidate.cell } });
      continue;
    }
    if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? [], record.identityInputs ?? []) !== record.verifierIdentity) throw new Error("verifier files changed before candidate verification; scores are no longer comparable");
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
    const confirmationIdentity = `${record.verifierIdentity}:${patchHash}:${preVerifyDigest}`;
    if (record.pendingConfirmation?.patchHash === patchHash && record.pendingConfirmation.confirmationIdentity !== confirmationIdentity) { record.pendingConfirmation = undefined; persist(record); }
    const evidenceDir = path.join(record.campaignRoot, "history", `r${String(iteration).padStart(4, "0")}_campaign`, candidate.cell);
    const remainingRuns = record.limits.maxEvaluatorRuns - makeBudget(record).read().evaluator_runs;
    const worstDuration = Math.max(1, ...(record.checkReport?.runs.map((run) => run.durationMs) ?? [1]));
    const timeRuns = Math.floor((Date.parse(record.deadlineAt) - Date.now()) / worstDuration);
    const baselineRuns = record.rawBaselineScores && record.rawBaselineScores.length > 1 ? 0 : 5;
    const confirmationRunsAvailable = Math.min(remainingRuns, timeRuns) - baselineRuns - (record.gates?.length ?? 0);
    const affordablePairs = noisy ? Math.min(32, Math.floor(confirmationRunsAvailable / 4) * 2) : 2;
    const savedPairs = record.pendingConfirmation?.patchHash === patchHash && record.pendingConfirmation.confirmationIdentity === confirmationIdentity ? record.pendingConfirmation.pairs : 0;
    if (noisy && affordablePairs < 2) {
      if (savedPairs > 0) return { applied: false, pending: true };
      rejectCandidate(record, iteration, candidate.cell, "budget", ["remaining evaluator or time budget cannot support the first noisy confirmation look; candidate evidence remains in the campaign workspace"]);
      break;
    }
    confirmations += 1;
    const verification = await verifyCandidatePatch({
      dreamRoot: record.campaignRoot, projectDir: record.projectDir, task: record.task, patch, evidenceDir, signal,
      beforeSpawn: (key) => reserve("evaluator", `${iteration}:${candidate.cell}:${key}`),
      repeats: noisy ? 3 : 1,
      minimumGain: record.minimumGain,
      requireValidBeforeAfter: true,
      measurementPlan: measurementPlan(record, Math.max(8, savedPairs + affordablePairs)),
      maxPairsToRun: noisy ? Math.min(32, savedPairs + affordablePairs) : 1,
      confirmationIdentity: `${record.verifierIdentity}:${patchHash}:${preVerifyDigest}`,
      ...(record.rawBaselineScores && record.rawBaselineScores.length > 1 ? { baselineReadings: record.rawBaselineScores } : {}),
    });
    const priorPairs = new Set(verifiedLedgerEntries(ledgerFile(record)).filter((entry) => entry.kind === "confirm" && entry.patchHash === patchHash && entry.facts?.confirmationIdentity === confirmationIdentity).map((entry) => entry.facts?.pair));
    for (const [pair, value] of verification.pairs.entries()) {
      if (priorPairs.has(pair)) continue;
      appendCampaignLedger(record, { kind: "confirm", campaignId: record.id, stage: "confirm",
        outcome: verification.measurementDecision === "continue" ? "pending" : verification.improved ? "success" : "rejected", patchHash, evaluatorRunCount: 2,
        evaluatorDurationMs: (value.before.processDurationMs ?? 0) + (value.after.processDurationMs ?? 0),
        facts: { iteration, cell: candidate.cell, pair, confirmationIdentity, before: value.before.raw_score, after: value.after.raw_score, gain: value.gain, liveGain: candidate.score - record.currentScore } });
    }
    if (verification.measurementDecision === "continue") {
      record.pendingConfirmation = { iteration, candidate, patch, patchHash, evidenceDir, confirmationIdentity, targetDigest: preVerifyDigest, pairs: verification.pairs.length, maxPairs: Math.max(8, savedPairs + affordablePairs) };
      persist(record);
      return { applied: false, pending: true };
    }
    record.pendingConfirmation = undefined;
    record.decidedPatches = [...(record.decidedPatches ?? []), patchHash];
    persist(record);
    if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? [], record.identityInputs ?? []) !== record.verifierIdentity) throw new Error("verifier files changed during candidate verification; scores are no longer comparable");
    if (!verification.improved || verification.before.score === null || verification.after.score === null || (!noisy && verification.after.score < record.currentScore + record.minimumGain)) {
      rejectCandidate(record, iteration, candidate.cell, "verification", [verification.reason ?? `verified score ${verification.after.score} did not exceed current score ${record.currentScore} plus minimum gain ${record.minimumGain}`]);
      continue;
    }
    let gateFailure: string | null = null;
    for (const [index, command] of (record.gates ?? []).entries()) {
      const gate = await runCampaignGate({
        sourceRoot: record.targetRoot,
        scratch: path.join(record.campaignRoot, "runtime", "gates", `${iteration}-${crypto.randomUUID()}`),
        command,
        timeoutMs: record.task.evaluator_timeout_ms,
        logPath: path.join(evidenceDir, `gate-${index}.log`),
        signal,
        key: `${iteration}:${candidate.cell}:gate:${index}`,
        beforeSpawn: (key) => reserve("evaluator", key),
        patch,
      });
      appendCampaignLedger(record, { kind: "gate", campaignId: record.id, stage: "gate", outcome: gate.passed ? "success" : "rejected", patchHash,
        evaluatorDurationMs: gate.result.durationMs, facts: { iteration, cell: candidate.cell, index } });
      if (!gate.passed) {
        gateFailure = `gate exited ${gate.result.code ?? gate.result.signal ?? "without a status"}${gate.result.stderrTail ? `: ${gate.result.stderrTail.trim().slice(-300)}` : ""}`;
        break;
      }
    }
    if (gateFailure) {
      rejectCandidate(record, iteration, candidate.cell, "gate", [gateFailure]);
      continue;
    }
    if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? [], record.identityInputs ?? []) !== record.verifierIdentity) {
      throw new Error("verifier files changed during candidate gates; scores are no longer comparable");
    }
    let review: CampaignReview;
    const reviewDir = path.join(evidenceDir, "review");
    // Fingerprint the live target around the review window: the review agent
    // must not change workspace content outside the re-verified patch paths.
    const preReviewDigest = workspaceDigest({ root: record.targetRoot, cycleSeedRoot: seedRoot, repoRoot: record.targetRoot, exclude: digestExcludes });
    try {
      review = await reviewCandidate({ record, iteration, candidate, patch, verification, reviewDir, signal, reserve, resolveAgent });
      appendCampaignLedger(record, { kind: "review", campaignId: record.id, stage: "review", outcome: review.verdict, patchHash, facts: { iteration, cell: candidate.cell } });
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
    appendCampaignLedger(record, { kind: "apply", campaignId: record.id, stage: "apply", outcome: "success", patchHash, patchSize: patch.reduce((sum, file) => sum + (file.kind === "write" ? file.afterLines : file.beforeLines), 0), facts: { iteration, cell: candidate.cell, transactionId } });
    record.currentScore = verification.medianAfter ?? verification.after.score;
    record.bestScore = Math.max(record.bestScore, record.currentScore);
    record.pendingApply = undefined;
    record.appliedIteration = iteration;
    persist(record);
    log(`[apply] ${candidate.cell} verified ${verification.before.score} -> ${verification.after.score}; ${receipt.written.length} files`);
    return { applied: true, pending: false };
  }
  return { applied: false, pending: false };
}

async function reconcilePending(record: CampaignRecord): Promise<void> {
  const pending = record.pendingApply;
  if (!pending) return;
  const receipt = reconcileCandidatePatch({ journalDir: path.join(record.campaignRoot, "promotion-journal"), transactionId: pending.transactionId });
  if (receipt.state === "applied") {
    saveApplied(record, pending, { written: receipt.written, backupDir: receipt.backupDir! });
    if (!verifiedLedgerEntries(ledgerFile(record)).some((entry) => entry.kind === "apply" && entry.facts?.transactionId === pending.transactionId)) {
      appendCampaignLedger(record, { kind: "apply", campaignId: record.id, stage: "apply", outcome: "success", facts: { iteration: pending.iteration, cell: pending.candidate.cell, transactionId: pending.transactionId } });
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

async function execute(record: CampaignRecord, options: Pick<CampaignOptions, "signal" | "resolveAgent" | "beforeAgentSpawn" | "onProgress" | "onPhaseProgress" | "onUpdate" | "log" | "allowFailingBaselineGates"> & { confirmationOnly?: boolean }): Promise<CampaignResult> {
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
      if (kind === "agent") {
        options.beforeAgentSpawn?.(key);
        appendCampaignLedger(record, { kind: "agent_start", campaignId: record.id, stage: "attempt", outcome: "reserved" });
      }
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
    if (record.taskFingerprint !== currentTaskFingerprint || record.verifierIdentity !== hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? [], record.identityInputs ?? [])) {
      throw new Error("task/evaluator identity changed during campaign; refusing incomparable results");
    }
    if (!withinDeadline(record)) {
      if (record.baselineScore === undefined) {
        record.state = { kind: "failed", reason: preflightFailedReason(record, `campaign deadline expired (${record.limits.deadlineMs}ms)`) };
      } else {
        record.state = { kind: "complete", reason: `campaign deadline expired (${record.limits.deadlineMs}ms)` };
      }
      persist(record); emit(record, callbacks);
      return { ...statusOf(record), stopped: true, stopReason: record.state.reason };
    }
    if (record.baselineScore === undefined) {
      const savedRuns = ((record.checkRuns?.length ? record.checkRuns : record.checkReport?.runs) ?? [])
        .flatMap((run) => { const normalized = normalizeCheckRun(run); return normalized ? [normalized] : []; })
        .slice(0, 5);
      const savedInvalidIndex = savedRuns.findIndex((run) => !run.valid);
      if (savedInvalidIndex >= 0) {
        // A persisted invalid reading is evidence, not something to retry. Fail without spending.
        record.state = { kind: "failed", reason: preflightFailedReason(record, `saved ${describeCheckRun(savedRuns[savedInvalidIndex], savedInvalidIndex)}`) };
        persist(record); emit(record, callbacks);
        return { ...statusOf(record), stopped: true, stopReason: record.state.reason };
      }
      record.checkRuns = savedRuns;
      setPhase(record, "baseline", null, callbacks);
      const readingsLeft = Math.max(0, 5 - savedRuns.length);
      const observed = timeFloorIsObservable(savedRuns, readingsLeft) ? observedReadingMs(savedRuns) : undefined;
      const infeasible = campaignFeasibility({
        limits: record.limits, task: record.task, expectedReadMs: record.expectedReadMs,
        readings: readingsLeft, gates: (record.gates ?? []).length,
        ...(observed !== undefined ? { readingMs: observed } : {}),
        spentEvaluatorRuns: budget.read().evaluator_runs, spentAgentStarts: budget.read().agent_starts,
        deadlineAt: record.deadlineAt,
        requireNoisy: savedRuns.length >= 2 && !readingsLookDeterministic(savedRuns),
      });
      if (infeasible) {
        appendCampaignLedger(record, { kind: "integrity", campaignId: record.id, stage: "integrity", outcome: "infeasible", facts: { reason: infeasible.reason } });
        throw new CampaignInfeasibleError(infeasible.reason, infeasible.floor, infeasible.recommended);
      }
      record.checkReport = await checkCampaignEvaluator({
        baseRoot: record.baseRoot, projectDir: record.projectDir,
        task: record.task, verifierInputs: record.verifierInputs, gates: record.gates,
        runs: 5,
        ...(savedRuns.length > 0 ? { priorRuns: savedRuns } : {}),
        ...(record.identityInputs?.length ? { identityInputs: record.identityInputs } : {}),
        // Keep per-reading logs with the campaign so status can point at the failing run.
        logRoot: path.join(record.campaignRoot, "history", "check"),
        minimumGain: record.requestedMinimumGain,
        maxCycles: record.limits.maxCycles,
        allowFailingBaselineGates: options.allowFailingBaselineGates ?? record.allowFailingBaselineGates ?? false,
        maxEvaluatorRuns: record.limits.maxEvaluatorRuns,
        deadlineMs: Date.parse(record.deadlineAt) - Date.now(),
        signal,
        beforeEvaluatorSpawn: (key) => reserve("evaluator", key),
        onReading: (run, index) => {
          // Persist each paid reading as it lands: a later abort or limit cannot lose it.
          record.checkRuns = [...(record.checkRuns ?? []), run];
          persist(record);
          appendCampaignLedger(record, { kind: "check", campaignId: record.id, stage: "check", evaluatorDurationMs: run.durationMs,
            outcome: run.valid ? "valid" : "invalid",
            facts: { reading: index + 1, durationMs: run.durationMs, code: run.code ?? -1, valid: run.valid,
              ...(run.score === null ? {} : { score: run.score }) } });
          const runs = record.checkRuns;
          const remaining = Math.max(0, 5 - runs.length);
          const observedNow = timeFloorIsObservable(runs, remaining) ? observedReadingMs(runs) : undefined;
          const failure = campaignFeasibility({
            limits: record.limits, task: record.task, expectedReadMs: record.expectedReadMs,
            readings: remaining, gates: (record.gates ?? []).length,
            ...(observedNow !== undefined ? { readingMs: observedNow } : {}),
            spentEvaluatorRuns: makeBudget(record).read().evaluator_runs,
            spentAgentStarts: makeBudget(record).read().agent_starts,
            deadlineAt: record.deadlineAt,
            requireNoisy: runs.length >= 2 && !readingsLookDeterministic(runs),
          });
          return failure ? { shortfall: failure.reason } : undefined;
        },
      });
      assertVerifierIdentity(record);
      const check = record.checkReport;
      record.checkRuns = check.runs;
      // A complete reading set with an undetectable effect is its own actionable failure; an
      // incomplete set is reported through the shortfall diagnosis that stopped the check.
      // The guard is the instrument's resolution, not the requested gain: a large requested
      // gain must not, by itself, make a quiet instrument look unable to resolve anything.
      const resolution = check.resolution_rel ?? check.mde_rel;
      if (check.runs.length >= check.plannedRuns && resolution !== null && resolution > 0.5) throw new Error("evaluator preflight failed: minimum detectable effect exceeds 50%");
      if (!check.qualified) {
        throw new Error("evaluator preflight failed: " + (check.diagnoses.length > 0 ? check.diagnoses.join("; ") : "the evaluator check did not qualify"));
      }
      if (check.spread === null) throw new Error("evaluator preflight failed: score spread exceeds the finite numeric range");
      if (check.confirmationCostMs > Date.parse(record.deadlineAt) - Date.now()) throw new Error("evaluator preflight failed: one confirmation cannot fit inside the campaign deadline");
      record.baselineScores = check.runs.flatMap((run) => run.valid && run.score !== null ? [run.score] : []);
      record.rawBaselineScores = check.runs.flatMap((run) => run.valid && run.rawScore !== null && run.rawScore !== undefined ? [run.rawScore] : []);
      const sorted = [...record.baselineScores].sort((a, b) => a - b);
      const baseline = sorted[Math.floor(sorted.length / 2)];
      record.baselineScore = baseline;
      record.baselineRepeatScore = record.baselineScores[1];
      record.currentScore = baseline;
      record.bestScore = baseline;
      record.minimumGain = absoluteGain(record.requestedMinimumGain ?? 0, baseline);
      writeJson(path.join(record.campaignRoot, "history", "seed", "score.json"), { score: baseline,
        raw_score: record.task.higher_is_better ? baseline : -baseline, valid: true, fail_class: "ok", error: null,
        measured_at: new Date().toISOString(), workspace: record.task.workspace, score_program: record.task.score_program,
        fingerprint: scoringFingerprint(record.task), seconds: check.runs.reduce((sum, run) => sum + run.durationMs, 0) / 1000 });
      persist(record);
    }
    while (record.completedCycles.length < record.limits.maxCycles && record.noGainCycles < record.limits.plateauCycles) {
      assertNotAborted(signal);
      if (!withinDeadline(record)) { record.state = { kind: "complete", reason: `campaign deadline expired (${record.limits.deadlineMs}ms)` }; break; }
      const iteration = record.completedCycles.length + 1;
      record.minimumGain = absoluteGain(record.requestedMinimumGain ?? record.minimumGain, record.currentScore);
      if (record.appliedIteration === iteration) {
        record.completedCycles.push(iteration);
        record.noGainCycles = 0;
        persist(record);
        continue;
      }
      if (hashInputs(record.projectDir, record.task, record.verifierInputs, record.gates ?? [], record.identityInputs ?? []) !== record.verifierIdentity) throw new Error("verifier files changed between campaign cycles; scores are no longer comparable");
      if (options.confirmationOnly) {
        if (!record.pendingConfirmation || record.pendingConfirmation.iteration !== iteration) throw new Error("confirmation-only resume requires the saved pending candidate for the current iteration");
        assertVerifierIdentity(record);
      } else {
        setPhase(record, "experiment", iteration, callbacks);
        const cycleSpend = budget.read();
        const confirmationFloor = scoresAreNoisy(record) ? 2 * PROMOTION_MIN_CONFIRMATION_PAIRS : 2;
        const world = await runExperiment({
          root: record.campaignRoot, projectDir: record.projectDir, targetRoot: record.targetRoot, seedRoot: record.targetRoot,
          task: record.task, cycle: iteration, worldId: `${record.id}:${iteration}`, fingerprint: record.verifierIdentity, baseline: record.currentScore,
          threshold: record.minimumGain, config: record.searchConfig ?? defaultSearchConfig, signal, agent: record.task.agent,
          goal: record.goal, scope: record.scope, gates: record.gates ?? [],
          historySummary: campaignMemory(record).slice(-6).map((entry) => `${entry.kind}: ${entry.outcome ?? "recorded"}${entry.facts?.reason ? ` (${entry.facts.reason})` : ""}`).join("\n"),
          priorAgentErrorStreak: priorAgentErrorStreak(record, iteration),
          resolveAgent: options.resolveAgent,
          maxAgentAttempts: Math.max(0, record.limits.maxAgentStarts - cycleSpend.agent_starts - 1),
          maxEvaluatorAttempts: Math.max(0, record.limits.maxEvaluatorRuns - cycleSpend.evaluator_runs - confirmationFloor - (record.gates ?? []).length),
          onProgress: options.onPhaseProgress,
          beforeAgentSpawn: (key) => reserve("agent", key), beforeEvaluatorSpawn: (key) => reserve("evaluator", key),
          onAgentComplete: (result) => recordAgentResult(record, "experiment", result), log,
        });
        recordExperimentAttempts(record, iteration, world);
        assertVerifierIdentity(record);
        if (limitReason) { record.state = { kind: "complete", reason: limitReason }; persist(record); break; }
        if (world.status !== "complete") throw new Error(world.stopped ?? `experiment cycle ${iteration} did not complete`);
      }
      setPhase(record, "promote", iteration, callbacks);
      let promotion: { applied: boolean; pending: boolean };
      try { promotion = await promoteCandidates(record, iteration, reserve, signal, log, options.resolveAgent); }
      catch (error) {
        if (error instanceof CampaignLimitError && limitReason) { record.state = { kind: "complete", reason: limitReason }; break; }
        throw error;
      }
      if (promotion.pending) {
        record.state = { kind: "paused", phase: "promote", iteration, reason: "confirmation pending; use confirm with remaining allowance to continue saved paired evidence" };
        persist(record); emit(record, callbacks);
        break;
      }
      record.completedCycles.push(iteration);
      recordDispositions(record, iteration);
      if (promotion.applied) record.noGainCycles = 0;
      else record.noGainCycles += 1;
      persist(record); emit(record, callbacks);
      if (options.confirmationOnly) { record.state = { kind: "complete", reason: promotion.applied ? "saved confirmation completed and candidate promotion finished" : "saved confirmation completed without applying a candidate" }; persist(record); emit(record, callbacks); break; }
      if (record.noGainCycles >= record.limits.plateauCycles) { record.state = { kind: "complete", reason: `${record.noGainCycles} completed cycles without a verified gain` }; break; }
      if (record.completedCycles.length >= record.limits.maxCycles) { record.state = { kind: "complete", reason: "cycle limit reached" }; break; }
    }
    if (record.state.kind === "running") record.state = { kind: "complete", reason: "campaign finished" };
    persist(record); emit(record, callbacks);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const carrier = error as Error & { checkReport?: CampaignCheckReport };
    if (carrier.checkReport) {
      // A cancelled or limited check still returns its partial evidence to the record.
      record.checkReport = carrier.checkReport;
      record.checkRuns = carrier.checkReport.runs;
    }
    // A failure before the first qualified baseline is terminal and self-explanatory: it names
    // the limit or defect and the last paid reading, so an expired campaign is never "complete".
    const baselineMissing = record.baselineScore === undefined;
    const duringBaseline = record.state.kind === "running" && record.state.phase === "baseline";
    if (record.state.kind === "running" && record.state.phase === "experiment" && record.state.iteration !== null) {
      const interrupted = readJson<ExperimentWorld>(experimentWorldPath(record.campaignRoot, record.state.iteration));
      if (interrupted) recordExperimentAttempts(record, record.state.iteration, interrupted);
    }
    if (/verifier|identity|tamper/i.test(reason)) appendCampaignLedger(record, { kind: "integrity", campaignId: record.id, stage: "integrity", outcome: "failed", facts: { reason } });
    if (limitReason) {
      record.state = baselineMissing
        ? { kind: "failed", reason: preflightFailedReason(record, limitReason) }
        : { kind: "complete", reason: limitReason };
    } else if (signal.aborted || reason === "campaign stopped") {
      const prior = record.state;
      record.state = prior.kind === "running" ? { kind: "paused", phase: prior.phase, iteration: prior.iteration, reason: "stopped by request" } : { kind: "paused", phase: "experiment", iteration: null, reason: "stopped by request" };
    } else if (error instanceof CampaignInfeasibleError) {
      record.state = { kind: "failed", reason: baselineMissing ? preflightFailedReason(record, error.message) : error.message };
    } else if (error instanceof CampaignLimitError) {
      record.state = baselineMissing
        ? { kind: "failed", reason: preflightFailedReason(record, error.message) }
        : { kind: "complete", reason: error.message };
    } else if (baselineMissing && duringBaseline) {
      record.state = { kind: "failed", reason: preflightFailedReason(record, reason) };
    } else {
      record.state = { kind: "failed", reason };
    }
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
  const pathDiagnoses = relativeEvaluatorPathDiagnoses(task, targetRoot, path.join(baseRoot, "runtime", "checks"));
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
  const scopedTask: TaskConfig = { ...task };
  const identityInputs = [...new Set((options.identityInputs ?? []).map((input) => path.isAbsolute(input) ? input : path.resolve(projectDir, input)))];
  const verifierIdentity = hashInputs(projectDir, scopedTask, verifierInputs, gates, identityInputs);
  // Loop qualification readings are evidence, not a discount on the truth: they are reused
  // only when they were taken under exactly this scoring identity (including the
  // contract-declared evaluator's own files, which the identity hashes separately).
  const seedIdentity = campaignVerifierIdentity(projectDir, task, verifierInputs, gates, identityInputs);
  const seedRuns = options.seedReadings && (options.seedReadings.identity === verifierIdentity || options.seedReadings.identity === seedIdentity)
    ? options.seedReadings.runs.flatMap((run) => { const normalized = normalizeCheckRun(run); return normalized ? [normalized] : []; }).slice(0, 5)
    : [];
  // Refuse before any directory exists: caps that cannot fund one verified promotion would
  // otherwise spend readings (and possibly agents) to discover exactly that.
  const infeasible = campaignFeasibility({
    limits, task: scopedTask, readings: Math.max(0, 5 - seedRuns.length), gates: gates.length,
    ...(seedRuns.length >= 2 && !readingsLookDeterministic(seedRuns) ? { requireNoisy: true } : {}),
  });
  if (infeasible) throw new CampaignInfeasibleError(infeasible.reason, infeasible.floor, infeasible.recommended);
  pruneCampaignWork(baseRoot);
  const id = crypto.randomUUID();
  const campaignRoot = path.join(baseRoot, "campaigns", id);
  fs.mkdirSync(campaignRoot, { recursive: true });
  const started = Date.now();
  const record: CampaignRecord = {
    version: 1, id, baseRoot, campaignRoot, projectDir, targetRoot, goal: options.goal.trim(), task: scopedTask,
    scope: options.scope?.length ? [...options.scope] : ["."], verifierInputs, verifierIdentity, gates,
    ...(identityInputs.length > 0 ? { identityInputs } : {}),
    taskFingerprint: scoringFingerprint(scopedTask), searchConfig: options.searchConfig ?? defaultSearchConfig, minimumGain, requestedMinimumGain: options.minimumGain ?? 0,
    ...(options.mechanism ? { mechanism: options.mechanism.slice(0, 100) } : {}),
    ...(options.parentCampaignId ? { parentCampaignId: options.parentCampaignId.slice(0, 80) } : {}),
    minimumGainSource, baselineScores: [], limits, startedAt: new Date(started).toISOString(), deadlineAt: new Date(started + limits.deadlineMs).toISOString(),
    ...(options.allowFailingBaselineGates === true ? { allowFailingBaselineGates: true } : {}),
    ...(options.confirmationAlpha === undefined ? {} : { confirmationAlpha: options.confirmationAlpha }),
    ...(options.expectedReadMs === undefined ? {} : { expectedReadMs: options.expectedReadMs }),
    ...(seedRuns.length > 0 ? { checkRuns: seedRuns } : {}),
    completedCycles: [], currentScore: 0, bestScore: 0, noGainCycles: 0, state: { kind: "running", phase: "baseline", iteration: null },
  };
  makeBudget(record, true);
  persist(record);
  writeActive(baseRoot, id);
  const result = execute(record, { signal: options.signal, resolveAgent: options.resolveAgent, beforeAgentSpawn: options.beforeAgentSpawn, onProgress: options.onProgress, onPhaseProgress: options.onPhaseProgress, onUpdate: options.onUpdate, log: options.log, allowFailingBaselineGates: options.allowFailingBaselineGates });
  releaseStart();
  return await result;
  } catch (error) {
    releaseStart();
    throw error;
  }
}

export async function resumeCampaign(options: CampaignResumeOptions): Promise<CampaignResult> {
  const legacy = failPausedV2Campaign(options.baseRoot);
  if (legacy) throw new Error(legacy);
  const root = activeRoot(path.resolve(options.baseRoot));
  if (!root) throw new Error("no saved campaign exists for this project");
  const record = readRecord(root);
  if (!record) throw new Error("saved campaign record is missing or invalid");
  recoverLimitExtension(record);
  if (path.resolve(options.projectDir) !== path.resolve(record.projectDir)) throw new Error("campaign target project does not match the saved campaign");
  if (record.state.kind === "complete" || record.state.kind === "failed") return { ...statusOf(record), stopped: true, stopReason: record.state.reason };
  if (record.state.kind === "running" && phaseIsActive(record.campaignRoot, "campaign")) throw new Error("campaign is already running");
  if (record.state.kind === "running") { record.state = { kind: "paused", phase: record.state.phase, iteration: record.state.iteration, reason: "resuming after interrupted host process" }; persist(record); }
  if (options.confirmationOnly && !record.pendingConfirmation) throw new Error("confirmation-only resume requires saved pending confirmation evidence");
  if (options.extendLimits) extendPendingConfirmation(record, options.extendLimits);
  if (!withinDeadline(record)) {
    if (record.baselineScore === undefined) {
      // A preflight that ran out of time never established a baseline: it is failed, not complete,
      // and it explains the limit and the last paid reading.
      record.state = { kind: "failed", reason: preflightFailedReason(record, "campaign deadline expired before a qualified baseline") };
      persist(record);
      return { ...statusOf(record), stopped: true, stopReason: record.state.reason };
    }
    throw new Error("campaign deadline expired; its budget cannot be renewed");
  }
  fs.rmSync(path.join(record.campaignRoot, "stop.request"), { force: true });
  return execute(record, { signal: options.signal, resolveAgent: options.resolveAgent, beforeAgentSpawn: options.beforeAgentSpawn, onProgress: options.onProgress, onPhaseProgress: options.onPhaseProgress, onUpdate: options.onUpdate, log: options.log, allowFailingBaselineGates: options.allowFailingBaselineGates, confirmationOnly: options.confirmationOnly });
}

/** A 2.x paused tree is not a valid 3.0 experiment; mark it failed with a recovery path. */
export function failPausedV2Campaign(baseRoot: string): string | null {
  const root = path.resolve(baseRoot);
  const pointer = readJson<{ id?: unknown }>(activeFile(root));
  if (!pointer || typeof pointer.id !== "string" || !/^[a-f0-9-]{16,64}$/i.test(pointer.id)) return null;
  const recordPath = path.join(root, "campaigns", pointer.id, "campaign.json");
  const record = readJson<Record<string, unknown>>(recordPath);
  const state = record?.state;
  // 2.x used record version 1 and string iteration ids (or the old live phase).
  // Current 3.x campaign records also use version 1, so the old state shape is
  // part of the discriminator; version alone would reject every current resume.
  const legacyState = state && typeof state === "object" && !Array.isArray(state) ? state as Record<string, unknown> : null;
  if (record?.version !== 1 || legacyState?.kind !== "paused"
    || !(legacyState.phase === "live" || typeof legacyState.iteration === "string")) return null;
  const reason = "This paused campaign uses the 2.x format and cannot resume in 3.0. It was marked failed; start a new /dream-rsi loop to continue.";
  writeFileAtomic(recordPath, `${JSON.stringify({ ...record, state: { kind: "failed", reason } }, null, 2)}\n`, true);
  return reason;
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
