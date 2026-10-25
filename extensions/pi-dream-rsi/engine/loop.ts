import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CAMPAIGN_DEADLINE_MAX_MS, CampaignInfeasibleError, campaignVerifierIdentity, readCampaignStatus, resumeCampaign, runCampaign,
  type CampaignOptions, type CampaignRecord, type CampaignResumeOptions, type CampaignResult, type CampaignSeedReadings,
} from "./campaign.ts";
import {
  ContractNotApprovedError, approvalIdentity, approveRunContract, contractFile, contractIdentity, projectFingerprint, readStoredContract, validateRunContract,
  restrictedEnvironment, type ApprovedContract, type RunContract,
} from "./intake.ts";
import { readLedger } from "./ledger.ts";
import { buildReconInventory, reconProject, timeLikeOutcome, type ReconOptions, type ReconResult } from "./recon.ts";
import { measureEvaluatorReading, measureWorkload, verifyPostApply, type PostApplyEvaluator } from "./verify.ts";
import {
  hasAllowance, readOrCreateLoopBudget, readSavedBudgetCaps, reconcileOpenReservation, remainingAllowance, settleReservation, writeLoopBudget,
  type LoopBudgetFile, type LoopPhase, type LoopReservation,
} from "./budget.ts";
import type { LeverInventory, LeverMetricKind, LeverProposal } from "./levers.ts";
import { synthesizeMetric, type EvaluationContract, type MetricPlan } from "./metrics.ts";
import { parseThreshold } from "./measure.ts";
import {
  attemptsFromMemory, isCurrentExperiment, MAX_NOTES, mementoNotes, readMemory, recordCampaignOutcome,
  ucbSelect, writeMemory, type LeverRankingEntry, type LoopMemory, type LoopMemoryRecord,
} from "./search.ts";
import { collectSignals, type SignalsResult } from "./signals.ts";
import { defaultTask, type TaskConfig } from "./task.ts";
import { readJson, writeFileAtomic, writeJson } from "./fsutil.ts";
import { phaseIsActive } from "./ownership.ts";
import { normalizeProjectRelativePath, pathProtected, pathWithin } from "./scope.ts";
import { defaultSearchConfig, type ExperimentWorld, type SearchConfig } from "./experiment.ts";
import { maybeDream, validateSearchConfig } from "./dream.ts";
import { copyWorkspace, runAgent } from "../agent/runner.ts";

/**
 * The unattended loop: one iteration = recon, ranked lever, synthesized or
 * supplied metric, one bounded campaign in the existing campaign engine, then
 * the outcome is recorded and the next iteration re-ranks. Every step fails
 * closed: budgets live in a durable loop file with immutable limits, spend is
 * reserved before a campaign starts and reconciled after it ends, a lever
 * without a truthful metric is recorded as rejected instead of explored, and
 * the loop stops when recon finds no eligible lever, the budget is exhausted, or
 * the durable budget is reached.
 */

/** A lease heartbeat older than this is stale; its owner is assumed gone. */
const LEASE_STALE_MS = 45 * 60 * 1000;

export interface LoopLimits {
  /** Campaigns the loop may start in total, across runs (durable). */
  maxCampaigns: number;
  /** Agent process starts the loop may spend in total, across runs (durable). */
  maxAgentStarts: number;
  /** Evaluator process runs the loop may spend in total, across runs (durable). */
  maxEvaluatorRuns: number;
  /** Wall-clock budget for one run. */
  deadlineMs: number;
}

export interface LeverCampaignSetup {
  task: TaskConfig;
  verifierInputs: string[];
  gates?: string[];
  goal?: string;
  scope?: string[];
  /** Estimated reading cost for budget admission, separate from the process timeout. */
  expectedReadMs?: number;
}

export interface LeverSetupContext {
  lever: LeverProposal;
  plan: MetricPlan | null;
  projectDir: string;
  loopRoot: string;
  /** The approved contract, when this run works inside one. */
  contract?: RunContract | null;
}

/** Fixture and intake integration point: supply a full campaign setup, or reject. */
export type LeverTaskProvider = (context: LeverSetupContext) => LeverCampaignSetup | { reject: string };

export interface LoopOptions {
  projectDir: string;
  /** Loop state root; defaults to <projectDir>/.dream-rsi/loop and must remain a child of baseRoot. */
  loopRoot?: string;
  /** Campaign container; defaults to <projectDir>/.dream-rsi. */
  baseRoot?: string;
  limits: LoopLimits;
  focus?: string;
  includeLogs?: boolean;
  sessionDir?: string;
  /** Approved run contract; the loop never executes without trusted-local consent. */
  contract: RunContract;
  /** Explicit replacement authorization bound to the saved approval reviewed by the operator. */
  replaceContract?: string;
  /** Resume the paused campaign recorded in the loop's durable active context, then keep looping. */
  resumeActiveCampaign?: boolean;
  /** Resume only a persisted paired confirmation, without discovery or new agent search. */
  confirmationOnly?: boolean;
  /** Explicitly authorized evaluator/workload bootstrap. Paths are checked against editable scope before the callback runs. */
  evaluatorBootstrap?: {
    authorized: boolean;
    paths: string[];
    run: (context: { projectDir: string; contract: RunContract; focus?: string; scopeRoots: string[]; deadlineMs: number; beforeAgentSpawn: () => void; signal?: AbortSignal }) => Promise<{ validatedPaths: string[] }>;
  };
  /** How many declared workloads one cold-start recon pass may measure. */
  reconProbes?: number;
  /** Passed through to the campaign when supplied; calibrated inside the campaign otherwise. */
  minimumGain?: number | string;
  /** Use a supplied setup (fixture manifest) instead of synthesizing one. */
  taskProvider?: LeverTaskProvider;
  /** Task field overrides (agent config, timeouts) for the default synthesized setup. */
  taskDefaults?: Partial<TaskConfig>;
  /** Inner per-campaign bounds; always clamped to the remaining loop budget. */
  campaignDefaults?: { maxCycles?: number; maxAgentStarts?: number; maxEvaluatorRuns?: number; deadlineMs?: number };
  signal?: AbortSignal;
  now?: () => Date;
  onProgress?: (message: string) => void;
  /** Live loop work, including stages before a campaign exists. */
  onActivity?: (activity: LoopActivity) => void;
  /** Agent resolver forwarded to each campaign (active session model and thinking level). */
  resolveAgent?: CampaignOptions["resolveAgent"];
  /** Live campaign status updates forwarded to the host UI. */
  onCampaignUpdate?: CampaignOptions["onUpdate"];
  /** Phase progress forwarded to the host UI dashboard. */
  onPhaseProgress?: CampaignOptions["onPhaseProgress"];
  /** Test seam replacing the campaign engine. */
  runCampaignImpl?: (options: CampaignOptions) => Promise<CampaignResult>;
  /** Test seam replacing the saved campaign resume path. */
  resumeCampaignImpl?: (options: CampaignResumeOptions) => Promise<CampaignResult>;
  /** Test seam replacing the independent post-apply measurement. */
  measureImpl?: (argv: string[], projectDir: string) => Promise<number | null>;
  /** Test seam replacing signal collection. */
  collectSignalsImpl?: (options: { projectDir: string; focus?: string; includeLogs?: boolean; sessionDir?: string }) => Promise<Pick<SignalsResult, "weaknesses" | "diagnostics">>;
  /** Test seam replacing manifest probing and source attribution. */
  reconProjectImpl?: (options: ReconOptions) => Promise<ReconResult>;
}

export interface LoopCampaignRecord extends LoopMemoryRecord {
  campaignRoot: string | null;
}

export type LoopStopCode = "consent-required" | "budget-exhausted" | "deadline" | "cancelled" | "no-verifiable-lever" | "blocked" | "campaign-failure" | "post-apply-failure" | "paused" | "confirmation-pending" | "confirmation-complete" | "completed" | "stopped";

export interface LoopPreflightCheck {
  name: "contract" | "metric" | "evaluator" | "workload" | "scope" | "gates" | "budget";
  status: "passed" | "blocked" | "not-checked";
  reason: string;
  remedy?: string;
}

export interface LoopResult {
  stopCode: LoopStopCode;
  reportPath: string;
  preflight: { status: "passed" | "blocked" | "not-checked"; checks: LoopPreflightCheck[] };
  /** Total evaluator invocations this run, including discovery and qualification. */
  evaluatorRuns: number;
  /** Discovery/qualification invocations, reported separately from campaign spend. */
  preflightEvaluatorRuns: number;
  campaignEvaluatorRuns: number;
  evaluatorRunsByPhase: Partial<Record<LoopPhase, number>>;
  stopReason: string;
  /** Campaigns actually started by this run (including rejected preflights). */
  campaigns: number;
  wins: number;
  agentStarts: number;
  memoryPath: string;
  budgetPath: string;
  memory: LoopMemory;
  inventory: LeverInventory | null;
  ranking: LeverRankingEntry[];
  records: LoopCampaignRecord[];
  /** Bounded fresh-context digest for the next run. */
  memento: string;
  /** Identity of the approved contract this run worked inside, if any. */
  contract: { fingerprint: string; approvedAt: string } | null;
  /** Independent post-apply verifications recorded by this run. */
  verifications: LoopVerification[];
}

/**
 * Raised when a non-campaign phase would spend past a durable cap. The loop turns
 * this into an honest `budget` stop instead of inflating the run's spend.
 */
export class LoopBudgetExhaustedError extends Error {
  readonly phase: string;
  constructor(phase: string) {
    super(`the durable budget cannot fund ${phase}`);
    this.name = "LoopBudgetExhaustedError";
    this.phase = phase;
  }
}

/** One independent check of an applied change, run outside the campaign's own instrument. */
export interface LoopVerification {
  leverId: string;
  campaignId: string;
  outcome: string;
  passed: boolean;
  reason: string | null;
  at: string;
}


/** The frozen baseline a post-apply check compares against. */
interface CapturedInstrument {
  argv: string[];
  gates: string[];
  baseline: number[];
  unit: string;
  higherIsBetter: boolean;
  minimumUsefulGain: number | `${number}%`;
  /** Timeout for one workload measurement, from the instrument's own sampling plan. */
  timeoutMs: number;
  /** How the applied state is measured: wall clock, or the declared score instrument. */
  kind: LeverMetricKind;
  /** Present for every non-duration kind: the pinned program that reports the score. */
  evaluator?: PostApplyEvaluator;
}

interface LoopResumeContext {
  version: 1;
  contractId: string;
  campaignId?: string;
  lever: Pick<LeverProposal, "id" | "mechanism" | "sourceKind">;
  setup: LeverCampaignSetup;
  plan: Pick<MetricPlan, "evaluationContract">;
  instrument: CapturedInstrument;
  baselineFingerprint: string;
  phase?: "campaign" | "post-apply";
}

/**
 * The evaluator that measures a synthesized instrument inside a candidate copy.
 *
 * For every non-duration metric kind the score comes from the pinned wrapper under
 * the loop's protected subtree, run with the current node binary. A score kind's
 * wrapper in turn runs the contract's declared evaluator; post-apply verification
 * therefore measures the same number the campaign promoted.
 */
function instrumentEvaluator(projectDir: string, plan: MetricPlan): PostApplyEvaluator | undefined {
  if (plan.metricKind === "command-duration" || plan.metricKind === "unmeasurable") return undefined;
  return { argv: [process.execPath, path.resolve(projectDir, plan.evaluatorPath)], output: "score-json" };
}

function withinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isCommandFileToken(token: string): boolean {
  const value = token.replace(/^--[^=]+=\s*/, "");
  return !value.startsWith("-") && (/[\\/]/.test(value) || /\.(?:py|m?js|json|sh|bat|cmd)$/i.test(value));
}

function commandFileTokens(command: string): string[] {
  return (command.match(/"[^"\n]+"|'[^'\n]+'|[^\s]+/g) ?? [])
    .map((token) => token.replace(/^("|')(.*)\1$/, "$2"))
    .filter(isCommandFileToken)
    .map((token) => token.replace(/^--[^=]+=\s*/, ""));
}

/** Rebuild only the frozen context needed to continue a validated pending confirmation. */
function recoverPendingConfirmationContext(options: {
  record: CampaignRecord;
  contract: RunContract;
  projectDir: string;
  loopRoot: string;
  baseRoot: string;
}): LoopResumeContext {
  const { record, contract, projectDir, loopRoot, baseRoot } = options;
  const refuse = (reason: string): never => { throw new Error(`saved confirmation recovery refused: ${reason}`); };
  const pending = record.pendingConfirmation;
  const startedAt = Date.parse(record.startedAt);
  if (!pending || record.state.kind !== "paused" || record.state.phase !== "promote"
    || record.state.iteration !== pending.iteration || !Number.isSafeInteger(pending.pairs) || pending.pairs < 1
    || !Number.isSafeInteger(pending.maxPairs) || pending.maxPairs <= pending.pairs) {
    return refuse("campaign is not paused with incomplete confirmation evidence");
  }
  if (path.resolve(record.baseRoot) !== path.resolve(baseRoot)
    || path.resolve(record.projectDir) !== path.resolve(projectDir)
    || path.resolve(record.targetRoot) !== path.resolve(projectDir)
    || path.resolve(record.campaignRoot) !== path.resolve(baseRoot, "campaigns", record.id)
    || !Number.isFinite(startedAt)) {
    return refuse("campaign identity or project paths do not match this run");
  }
  if (record.goal !== contract.outcome.statement
    || record.task.higher_is_better !== contract.outcome.higherIsBetter
    || record.requestedMinimumGain !== contract.outcome.minimumUsefulGain
    || !record.scope.length || record.scope.some((scope) => !pathWithin(scope, contract.scope.roots))) {
    return refuse("saved campaign does not match the approved objective, direction, threshold, or scope");
  }
  const gates = [...new Set(record.gates ?? [])];
  if ((contract.preserved.gates ?? []).some((gate) => !gates.includes(gate))) {
    return refuse("saved campaign omits an approved correctness gate");
  }
  const evaluator = contract.outcome.evaluator;
  if (!evaluator || record.task.score_path !== "eval/score.json" || record.task.score_field !== "score"
    || record.task.valid_field !== "valid" || record.task.fail_class_field !== "fail_class"
    || record.task.error_field !== "error") {
    return refuse("saved campaign does not use the approved score protocol");
  }
  const metricRoot = path.resolve(loopRoot, "metrics");
  const wrapperPath = path.resolve(metricRoot, record.task.name, "evaluate.mjs");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(record.task.name)
    || !withinDirectory(metricRoot, wrapperPath)
    || record.task.score_program !== `node "${wrapperPath}"`
    || !(record.verifierInputs ?? []).some((input) => path.resolve(projectDir, input) === wrapperPath)) {
    return refuse("saved score wrapper is missing or does not match the campaign task");
  }
  const identityInputs = (evaluator.inputs ?? []).map((input) => path.resolve(projectDir, input)).sort();
  if (JSON.stringify([...(record.identityInputs ?? [])].map((input) => path.resolve(projectDir, input)).sort()) !== JSON.stringify(identityInputs)) {
    return refuse("saved evaluator inputs do not match the approved contract");
  }
  const verifierRoot = path.resolve(loopRoot, "verifiers", record.task.name);
  for (const input of evaluator.inputs ?? []) {
    const pinned = path.resolve(verifierRoot, ...input.replace(/\\/g, "/").split("/"));
    if (!withinDirectory(verifierRoot, pinned) || !(record.verifierInputs ?? []).some((saved) => path.resolve(projectDir, saved) === pinned)) {
      return refuse("an approved evaluator input is not pinned by the saved campaign");
    }
  }
  try {
    if (campaignVerifierIdentity(record.projectDir, record.task, record.verifierInputs, gates, record.identityInputs ?? []) !== record.verifierIdentity) {
      return refuse("the saved verifier identity no longer matches its pinned files");
    }
  } catch (error) {
    return refuse(`the saved verifier could not be validated (${error instanceof Error ? error.message : String(error)})`);
  }
  const wrapper = fs.readFileSync(wrapperPath, "utf8");
  const constant = (name: string): string => {
    const match = wrapper.match(new RegExp(`^const ${name} = (.+);$`, "m"));
    if (!match) return refuse(`the pinned wrapper is missing ${name}`);
    return match[1];
  };
  let command: unknown;
  let output: unknown;
  let unit: unknown;
  try {
    command = JSON.parse(constant("COMMAND"));
    output = JSON.parse(constant("SCORE_OUTPUT"));
    unit = JSON.parse(constant("SCORE_UNIT"));
  } catch (error) {
    return refuse(`the pinned wrapper has invalid score settings (${error instanceof Error ? error.message : String(error)})`);
  }
  const mode = constant("MODE").replace(/^"|"$/g, "");
  const timeoutMatch = constant("SAMPLE_TIMEOUT_MS").match(/^\d+$/);
  const sampleTimeoutMs = timeoutMatch ? Number(timeoutMatch[0]) : 0;
  if (mode !== "score" || !Array.isArray(command) || !command.every((part) => typeof part === "string")
    || JSON.stringify(command) !== JSON.stringify(evaluator.argv) || output !== evaluator.output || unit !== contract.outcome.unit
    || !Number.isSafeInteger(sampleTimeoutMs) || sampleTimeoutMs <= 0) {
    return refuse("the pinned wrapper does not match the approved evaluator settings");
  }
  for (const file of [...evaluator.argv.filter(isCommandFileToken).map((token) => token.replace(/^--[^=]+=\s*/, "")), ...gates.flatMap(commandFileTokens)]) {
    const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(projectDir, file);
    if (!fs.existsSync(absolute)) return refuse(`a measurement input is missing: ${file}`);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > startedAt) {
      return refuse(`a measurement input changed or is not a regular file: ${file}`);
    }
  }
  const qualifiedBaseline = (record.checkRuns ?? []).filter((run) =>
    run.stdoutTail === "seeded from loop qualification" && run.valid && typeof run.score === "number" && Number.isFinite(run.score),
  );
  if (qualifiedBaseline.length < 2) return refuse("the campaign has no complete saved qualification baseline");
  const baseline = qualifiedBaseline.map((run) => contract.outcome.higherIsBetter ? run.score! : -run.score!);
  const evidenceRoot = path.join(record.campaignRoot, "history");
  if (!withinDirectory(evidenceRoot, pending.evidenceDir)) return refuse("confirmation evidence is outside the campaign history");
  type SavedScoreOutcome = { score?: unknown; raw_score?: unknown; valid?: unknown; fail_class?: unknown; error?: unknown };
  type SavedPair = { measurement?: { before?: unknown; after?: unknown; gain?: unknown }; beforeOutcome?: SavedScoreOutcome; afterOutcome?: SavedScoreOutcome };
  const evidence = readJson<{ version?: unknown; identity?: unknown; baseline?: unknown; pairs?: SavedPair[]; readings?: Record<string, SavedScoreOutcome> }>(
    path.join(pending.evidenceDir, "confirmation.json"),
  );
  const expectedIdentity = `${record.verifierIdentity}:${pending.patchHash}:${pending.targetDigest}`;
  const validOutcome = (value: unknown): value is SavedScoreOutcome => !!value && typeof value === "object"
    && typeof (value as SavedScoreOutcome).valid === "boolean" && typeof (value as SavedScoreOutcome).fail_class === "string"
    && ((value as SavedScoreOutcome).score === null || (typeof (value as SavedScoreOutcome).score === "number" && Number.isFinite((value as SavedScoreOutcome).score)))
    && ((value as SavedScoreOutcome).raw_score === null || (typeof (value as SavedScoreOutcome).raw_score === "number" && Number.isFinite((value as SavedScoreOutcome).raw_score)))
    && ((value as SavedScoreOutcome).error === null || typeof (value as SavedScoreOutcome).error === "string");
  const validScore = (value: unknown): value is SavedScoreOutcome & { score: number; raw_score: number } => validOutcome(value)
    && value.valid === true && value.fail_class === "ok" && value.error === null
    && typeof value.score === "number" && Number.isFinite(value.score)
    && typeof value.raw_score === "number" && Number.isFinite(value.raw_score);
  const closeEnough = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(actual), Math.abs(expected));
  const relative = parseThreshold(record.requestedMinimumGain ?? record.minimumGain).kind === "relative";
  const validPair = (pair: SavedPair): boolean => {
    const beforeOutcome = pair?.beforeOutcome;
    const afterOutcome = pair?.afterOutcome;
    const before = beforeOutcome?.raw_score;
    const after = afterOutcome?.raw_score;
    const measurement = pair?.measurement;
    if (!measurement || typeof measurement.before !== "number" || !Number.isFinite(measurement.before)
      || typeof measurement.after !== "number" || !Number.isFinite(measurement.after)
      || typeof measurement.gain !== "number" || !Number.isFinite(measurement.gain)
      || !validScore(beforeOutcome) || !validScore(afterOutcome) || typeof before !== "number" || typeof after !== "number") return false;
    if (relative && (before <= 0 || after <= 0)) return false;
    const gain = relative
      ? contract.outcome.higherIsBetter ? Math.log(after / before) : Math.log(before / after)
      : contract.outcome.higherIsBetter ? after - before : before - after;
    return closeEnough(measurement.before, before) && closeEnough(measurement.after, after) && closeEnough(measurement.gain, gain);
  };
  const rawBaseline = record.rawBaselineScores;
  if (!Array.isArray(rawBaseline) || rawBaseline.length === 0 || rawBaseline.some((value) => !Number.isFinite(value))
    || !/^[a-f0-9]{64}$/i.test(pending.patchHash) || !/^[a-f0-9]{64}$/i.test(pending.targetDigest)
    || pending.confirmationIdentity !== expectedIdentity || evidence?.version !== 1 || evidence.identity !== expectedIdentity
    || !Array.isArray(evidence.baseline) || evidence.baseline.length !== rawBaseline.length
    || evidence.baseline.some((value, index) => typeof value !== "number" || !Number.isFinite(value) || !closeEnough(value, rawBaseline[index]))
    || !Array.isArray(evidence.pairs) || evidence.pairs.length !== pending.pairs || !evidence.pairs.every(validPair)
    || (evidence.readings !== undefined && (!evidence.readings || typeof evidence.readings !== "object" || Object.values(evidence.readings).some((value) => !validOutcome(value))))) {
    return refuse("saved paired measurements do not match the pending candidate");
  }
  if (!pending.patch.length || pending.patch.some((file) => {
    const relative = normalizeProjectRelativePath(file.relative);
    return !relative || !pathWithin(relative, contract.scope.roots) || pathProtected(relative, contract.scope.protectedAssets);
  })) {
    return refuse("pending candidate patch is empty or outside the approved editable scope");
  }
  return {
    version: 1,
    contractId: contractIdentity(contract),
    campaignId: record.id,
    lever: { id: record.task.name, sourceKind: "recon-command", mechanism: record.mechanism ?? "approved score confirmation" },
    setup: { task: record.task, verifierInputs: record.verifierInputs, gates, goal: record.goal, scope: record.scope, expectedReadMs: record.expectedReadMs },
    plan: {},
    instrument: {
      argv: [...evaluator.argv], gates, baseline, unit: contract.outcome.unit,
      higherIsBetter: contract.outcome.higherIsBetter, minimumUsefulGain: contract.outcome.minimumUsefulGain,
      timeoutMs: sampleTimeoutMs, kind: "score",
      evaluator: { argv: [process.execPath, wrapperPath], output: "score-json" },
    },
    baselineFingerprint: projectFingerprint(projectDir),
    phase: "campaign",
  };
}

/**
 * Capture the pre-campaign baseline for one approved run.
 *
 * A qualified instrument already recorded its readings. Otherwise the baseline
 * is measured now with the same procedure the post-apply check repeats, so every promoted change can be
 * verified against a baseline that existed before any candidate ran. Returns null
 * when no such baseline can be established, which means the change must not be
 * promoted on faith.
 */
async function captureInstrument(options: {
  plan: MetricPlan;
  contract: RunContract;
  gates: string[];
  projectDir: string;
  workRoot: string;
  beforeProcess: () => void;
  signal?: AbortSignal;
  measureImpl?: (argv: string[], projectDir: string) => Promise<number | null>;
}): Promise<CapturedInstrument | null> {
  const gates = [...new Set([...(options.contract.preserved.gates ?? []), ...options.gates])];
  const kind = options.plan.metricKind;
  const evaluator = instrumentEvaluator(options.projectDir, options.plan);
  const qualified = options.plan.evaluationContract;
  if (qualified) {
    return {
      argv: qualified.argv,
      gates: [...new Set([...gates, ...qualified.gates])],
      baseline: qualified.baseline,
      unit: qualified.unit,
      higherIsBetter: qualified.higherIsBetter,
      minimumUsefulGain: qualified.minimumUsefulGain,
      timeoutMs: options.plan.sampleTimeoutMs,
      kind,
      ...(evaluator ? { evaluator } : {}),
    };
  }
  if (options.plan.argv.length === 0) return null;
  const scratch = options.projectDir;
  const measuredEvaluator = evaluator;
  const readings: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const reading = measuredEvaluator
      ? await measureEvaluatorReading({
          evaluator: measuredEvaluator,
          cwd: scratch,
          contract: options.contract,
          timeoutMs: options.plan.sampleTimeoutMs,
          beforeProcess: options.beforeProcess,
          ...(options.signal ? { signal: options.signal } : {}),
      })
      : options.measureImpl
        ? await options.measureImpl(options.plan.argv, scratch)
        : await measureWorkload({
            argv: options.plan.argv,
            cwd: scratch,
            contract: options.contract,
            timeoutMs: options.plan.sampleTimeoutMs,
            beforeProcess: options.beforeProcess,
            ...(options.signal ? { signal: options.signal } : {}),
        });
    if (reading === null) return null;
    readings.push(reading);
  }
  return {
    argv: options.plan.argv,
    gates,
    baseline: readings,
    unit: options.plan.unit,
    higherIsBetter: options.plan.higherIsBetter,
    minimumUsefulGain: options.contract.outcome.minimumUsefulGain,
    timeoutMs: options.plan.sampleTimeoutMs,
    kind,
    ...(evaluator ? { evaluator } : {}),
  };
}

/** Wall time already spent by earlier runs under this project's contract. */
function readConsumedWallMs(loopRoot: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(loopRoot, "budget.json"), "utf8")) as { wall_ms?: unknown };
    return typeof parsed.wall_ms === "number" && Number.isSafeInteger(parsed.wall_ms) && parsed.wall_ms >= 0 ? parsed.wall_ms : 0;
  } catch { return 0; }
}

/** The contract's durable budget ceiling. */
function approvedContract(contract: RunContract): RunContract["budgets"] {
  return contract.budgets;
}

interface BudgetExtensionCaps {
  maxCampaigns: number;
  maxAgentStarts: number;
  maxEvaluatorRuns: number;
}

interface BudgetExtensionTransaction {
  version: 1;
  previous: ApprovedContract;
  next: ApprovedContract;
  previousCaps: BudgetExtensionCaps;
  nextCaps: BudgetExtensionCaps;
}

function isBudgetExtensionCaps(value: unknown): value is BudgetExtensionCaps {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const caps = value as Record<string, unknown>;
  return [caps.maxCampaigns, caps.maxAgentStarts, caps.maxEvaluatorRuns]
    .every((cap) => Number.isSafeInteger(cap) && (cap as number) > 0);
}

/** Complete an explicitly approved cap increase after a process interruption. */
function recoverBudgetExtension(loopRoot: string): void {
  const transactionPath = path.join(loopRoot, "budget-extension.json");
  if (!fs.existsSync(transactionPath)) return;
  const transaction = readJson<BudgetExtensionTransaction>(transactionPath);
  if (!transaction || transaction.version !== 1 || !transaction.previous || !transaction.next
    || !isBudgetExtensionCaps(transaction.previousCaps) || !isBudgetExtensionCaps(transaction.nextCaps)
    || validateRunContract(transaction.previous.contract).length > 0 || validateRunContract(transaction.next.contract).length > 0
    || !Number.isFinite(Date.parse(transaction.previous.approvedAt)) || !Number.isFinite(Date.parse(transaction.next.approvedAt))) {
    throw new Error("saved budget-extension transaction is invalid; inspect it before recovery");
  }
  const previousId = approvalIdentity(transaction.previous.contract);
  const nextId = approvalIdentity(transaction.next.contract);
  const current = readStoredContract(loopRoot);
  if (!current || ![previousId, nextId].includes(approvalIdentity(current.contract))) {
    throw new Error("saved budget-extension transaction does not match the current contract; inspect saved state before recovery");
  }
  const before = transaction.previous.contract.budgets;
  const after = transaction.next.contract.budgets;
  const oldCaps = transaction.previousCaps;
  const newCaps = transaction.nextCaps;
  if (after.maxCampaigns < before.maxCampaigns || after.maxAgentStarts < before.maxAgentStarts || after.maxEvaluatorRuns < before.maxEvaluatorRuns
    || after.deadlineMs < before.deadlineMs || after.falseAcceptBudget !== before.falseAcceptBudget
    || newCaps.maxCampaigns < oldCaps.maxCampaigns || newCaps.maxAgentStarts < oldCaps.maxAgentStarts || newCaps.maxEvaluatorRuns < oldCaps.maxEvaluatorRuns
    || newCaps.maxCampaigns > after.maxCampaigns || newCaps.maxAgentStarts > after.maxAgentStarts || newCaps.maxEvaluatorRuns > after.maxEvaluatorRuns) {
    throw new Error("saved budget-extension transaction does not contain a monotonic cap increase");
  }
  const budgetPath = path.join(loopRoot, "budget.json");
  const caps = readSavedBudgetCaps(budgetPath);
  const isOldCaps = caps?.max_campaigns === oldCaps.maxCampaigns && caps.max_agent_starts === oldCaps.maxAgentStarts && caps.max_evaluator_runs === oldCaps.maxEvaluatorRuns;
  const isNewCaps = caps?.max_campaigns === newCaps.maxCampaigns && caps.max_agent_starts === newCaps.maxAgentStarts && caps.max_evaluator_runs === newCaps.maxEvaluatorRuns;
  if (!caps || (!isOldCaps && !isNewCaps)) {
    throw new Error("saved budget-extension transaction does not match the durable budget; inspect saved state before recovery");
  }
  const budget = readOrCreateLoopBudget(budgetPath, {
    maxCampaigns: caps.max_campaigns, maxAgentStarts: caps.max_agent_starts,
    maxEvaluatorRuns: caps.max_evaluator_runs, deadlineMs: after.deadlineMs,
  });
  if (budget.campaigns > newCaps.maxCampaigns || budget.agent_starts > newCaps.maxAgentStarts || budget.evaluator_runs > newCaps.maxEvaluatorRuns) {
    throw new Error("saved budget-extension transaction would set a cap below accumulated spend");
  }
  writeFileAtomic(path.join(loopRoot, "contract.previous.json"), `${JSON.stringify(transaction.previous, null, 2)}\n`, true);
  if (approvalIdentity(current.contract) === previousId) {
    writeFileAtomic(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...transaction.next }, null, 2)}\n`, true);
  }
  writeLoopBudget(budgetPath, { ...budget, max_campaigns: newCaps.maxCampaigns, max_agent_starts: newCaps.maxAgentStarts, max_evaluator_runs: newCaps.maxEvaluatorRuns });
  fs.rmSync(transactionPath, { force: true });
}

/**
 * Memory reduced to experiments comparable with the current objective and
 * instrument. Legacy records without provenance stay comparable, so an upgrade
 * does not silently forget a project's history.
 */
function comparableMemory(memory: LoopMemory, current: { contractId: string | null; evaluatorId: string | null }): LoopMemory {
  const latest = new Map<string, LoopMemoryRecord>();
  for (const record of memory.outcomes) latest.set(record.leverId, record);
  const leverStats: LoopMemory["leverStats"] = {};
  for (const [id, stats] of Object.entries(memory.leverStats)) {
    const record = latest.get(id);
    if (record && !isCurrentExperiment(record, {
      ...(current.contractId ? { contractId: current.contractId } : {}),
      ...(current.evaluatorId ? { evaluatorId: current.evaluatorId } : {}),
    })) continue;
    leverStats[id] = stats;
  }
  const outcomes = memory.outcomes.filter((record) => isCurrentExperiment(record, {
    ...(current.contractId ? { contractId: current.contractId } : {}),
    ...(current.evaluatorId ? { evaluatorId: current.evaluatorId } : {}),
  }));
  return { ...memory, leverStats, outcomes };
}

export interface LoopActivity {
  state: "running" | "awaiting-consent" | "awaiting-approval" | "stopping" | "interrupted" | "unverified" | "unknown";
  phase: string;
  detail: string;
  startedAt: string | null;
  updatedAt: string | null;
  campaignId?: string;
}
interface LoopLease {
  pid: number; host: string | null; startedAt: string; heartbeatAt: string;
  activity?: { phase: string; detail: string; updatedAt: string; campaignId?: string };
}
const activityText = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240);

/** Read a lease; an unreadable lease proves nothing on its own. */
function readLease(file: string): LoopLease | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LoopLease> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt))) return null;
    if (typeof parsed.heartbeatAt !== "string" || !Number.isFinite(Date.parse(parsed.heartbeatAt))) return null;
    if (parsed.host !== undefined && parsed.host !== null && typeof parsed.host !== "string") return null;
    const value = parsed.activity;
    const activity = value && typeof value.phase === "string" && typeof value.detail === "string" && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
      ? { phase: activityText(value.phase), detail: activityText(value.detail), updatedAt: value.updatedAt,
        ...(typeof value.campaignId === "string" ? { campaignId: value.campaignId } : {}) } : undefined;
    return { pid: parsed.pid, host: parsed.host ?? null, startedAt: parsed.startedAt, heartbeatAt: parsed.heartbeatAt, ...(activity ? { activity } : {}) };
  } catch { return null; }
}

/** Read-only live work inspection; lease presence alone is not proof of a working process. */
export function readLoopActivity(baseRoot: string): LoopActivity | null {
  const file = path.join(baseRoot, "loop", "lease.json");
  if (!fs.existsSync(file)) return null;
  const lease = readLease(file);
  if (!lease) return { state: "unknown", phase: "unknown", detail: "A loop lease exists but cannot be read; activity cannot be verified.", startedAt: null, updatedAt: null };
  let state: LoopActivity["state"] = "unverified";
  if (lease.host === os.hostname()) {
    if (!processIsAlive(lease.pid)) state = "interrupted";
    else if (lease.activity) state = lease.activity.phase === "stopping" ? "stopping" : "running";
  }
  return { state, phase: lease.activity?.phase ?? "unknown", detail: lease.activity?.detail ?? "The owner has not published a work stage.",
    startedAt: lease.startedAt, updatedAt: lease.activity?.updatedAt ?? lease.heartbeatAt,
    ...(lease.activity?.campaignId ? { campaignId: lease.activity.campaignId } : {}) };
}

/** A lease file younger than this may still be mid-publication; it is not taken over. */
const LEASE_PUBLISH_GRACE_MS = 30 * 1000;

/** True while a lease file is young enough that an unreadable state can be a publication in progress. */
function leaseIsPublishing(file: string): boolean {
  try { return Date.now() - fs.statSync(file).mtimeMs < LEASE_PUBLISH_GRACE_MS; }
  catch { return false; }
}

/**
 * Publish the lease with one exclusive, complete write: a hard link of a fully written file.
 * Link failure with EEXIST means the lease is taken; a filesystem without hard links falls back
 * to exclusive creation, whose create-to-write moment the reader-side publish grace covers.
 */
function claimLease(file: string, self: LoopLease): boolean {
  const payload = `${JSON.stringify(self, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  let linked = false;
  try {
    fs.writeFileSync(temp, payload);
    try { fs.linkSync(temp, file); linked = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
  if (linked) return true;
  if (fs.existsSync(file)) return false;
  try {
    const descriptor = fs.openSync(file, "wx");
    try { fs.writeSync(descriptor, payload); } finally { fs.closeSync(descriptor); }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

type LeaseClaim =
  | { held: true; stale: LoopLease | null }
  | { held: false; holder: LoopLease | null; publishing: boolean; reason?: string };

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function releaseOwnedLease(file: string, owner: LoopLease): void {
  const current = readLease(file);
  if (current && current.pid === owner.pid && current.host === owner.host && current.startedAt === owner.startedAt) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Claim the loop lease exclusively, or report the live holder. Publication is one atomic hard
 * link of a fully written file, so a contender never observes a half-written lease. A lease
 * file that stays unreadable inside the publish grace window is reported as a publication in
 * progress instead of being taken over; an older unreadable file is preserved because its owner
 * cannot be verified. A readable stale lease is reaped only after its same-host process is gone.
 * The recovery claim serializes reapers, and an absent primary is claimed atomically rather than
 * unlinked. If the file stays contended, the current state is reported.
 */
function acquireLease(file: string, self: LoopLease, isFresh: (holder: LoopLease) => boolean): LeaseClaim {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let stale: LoopLease | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (claimLease(file, self)) return { held: true, stale };
    const holder = readLease(file);
    if (holder && isFresh(holder)) return { held: false, holder, publishing: false };
    if (!holder && leaseIsPublishing(file)) return { held: false, holder: null, publishing: true };
    const recoveryPath = `${file}.recovery`;
    if (!claimLease(recoveryPath, self)) {
      return { held: false, holder, publishing: false, reason: `another loop is recovering this stale lease; retry after it exits, or inspect ${recoveryPath} if it remains` };
    }
    try {
      // Serialize stale reapers, then re-read. Never unlink a fresh lease that replaced the one
      // observed above. Only reap a same-host lease whose process is demonstrably gone.
      const current = readLease(file);
      if (current && isFresh(current)) return { held: false, holder: current, publishing: false };
      if (!current) {
        if (leaseIsPublishing(file)) return { held: false, holder: null, publishing: true };
        if (fs.existsSync(file)) {
          return { held: false, holder: null, publishing: false, reason: "lease is unreadable and its owner cannot be verified; inspect it before takeover" };
        }
        // The observed owner may have released normally while this reaper waited. The primary
        // path is now absent, so claim it atomically; never unlink whatever a new owner publishes.
        if (claimLease(file, self)) return { held: true, stale };
        const replacement = readLease(file);
        return { held: false, holder: replacement, publishing: !replacement && leaseIsPublishing(file) };
      }
      if (current.host !== os.hostname() || processIsAlive(current.pid)) {
        return { held: false, holder: current, publishing: false, reason: "stale heartbeat belongs to a live or unverifiable process; refusing takeover" };
      }
      stale = current;
      try { fs.rmSync(file, { force: true }); } catch { /* the retry reports the current state */ }
      if (claimLease(file, self)) return { held: true, stale };
    } finally {
      releaseOwnedLease(recoveryPath, self);
    }
  }
  const holder = readLease(file);
  return { held: false, holder, publishing: !holder && leaseIsPublishing(file) };
}

/**
 * Copy declared evaluator inputs into the loop's protected subtree and return
 * their absolute paths.
 *
 * The campaign refuses verifier inputs inside the editable workspace (it cannot
 * hash untrusted workspace content into the instrument identity), so the declared
 * evaluator code and data are pinned by copies under the trusted subtree. The
 * evaluator still runs from its declared project-relative argv in the candidate
 * copy; the candidate's patch scope cannot reach that code, and editing the
 * original input changes the pinned identity instead of silently redefining the
 * score.
 */
function pinEvaluatorInputs(options: { projectDir: string; loopRoot: string; leverId: string; inputs: string[] }): string[] {
  if (options.inputs.length === 0) return [];
  const root = path.join(options.loopRoot, "verifiers", options.leverId);
  const pinned: string[] = [];
  for (const input of options.inputs) {
    const source = path.resolve(options.projectDir, input);
    if (!fs.existsSync(source)) continue;
    const target = path.join(root, ...input.replace(/\\/g, "/").split("/"));
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    pinned.push(target);
  }
  return pinned;
}

/** Default setup: synthesize the evaluator, then point a repo-root task at it. */
function defaultSetup(context: LeverSetupContext, options: LoopOptions): LeverCampaignSetup | { reject: string } {
  const { lever, plan, projectDir } = context;
  if (lever.scopeFiles.length === 0) return { reject: `lever ${lever.id} (${lever.sourceKind}) has no known patch scope yet; scope discovery must run before a campaign` };
  if (!plan) return { reject: `lever ${lever.id} has no metric plan` };
  if (!plan.ready) return { reject: `lever ${lever.id} metric is not ready: ${plan.rejections.join("; ")}` };
  const evaluatorAbsolute = path.resolve(projectDir, plan.evaluatorPath);
  // A score instrument's declared code/data must stay pinned: a candidate that can
  // edit the evaluator or its fixtures can redefine "improved".
  const pinnedInputs = pinEvaluatorInputs({ projectDir, loopRoot: context.loopRoot, leverId: lever.id, inputs: plan.evaluatorInputs });
  const base = defaultTask(lever.id);
  const task: TaskConfig = {
    ...base,
    ...options.taskDefaults,
    workspace: ".",
    eval_program: lever.scopeFiles[0],
    score_program: `node "${evaluatorAbsolute}"`,
    score_path: plan.scorePath,
    higher_is_better: plan.higherIsBetter,
    evaluator_timeout_ms: plan.wrapperTimeoutMs,
    problem_file: options.taskDefaults?.problem_file ?? null,
    copy_exclude: [],
    // The approved contract names the candidate agent; the task default (`pi`) is
    // only a fallback when no contract was approved.
    agent: context.contract?.agent ?? options.taskDefaults?.agent ?? base.agent,
  };
  return {
    task,
    verifierInputs: [...new Set([evaluatorAbsolute, ...pinnedInputs])],
    // The contract's preserved gates are as binding as the instrument's own.
    gates: [...new Set([...(context.contract?.preserved.gates ?? []), ...plan.gates])],
    goal: lever.goal,
    scope: [...lever.scopeFiles],
    expectedReadMs: plan.expectedReadMs,
  };
}

/**
 * Project-relative paths a unified diff touches, read from its headers.
 *
 * Handles git patches (`diff --git a/x b/y`, renames, new and deleted files) and
 * plain unified diffs (`--- a/x` / `+++ b/y`), including the timestamps some tools
 * append. Deleted (`/dev/null`) sides and duplicates are dropped. The result is
 * sorted so callers can compare sets deterministically.
 */
export interface SeedReadingsOptions {
  projectDir: string;
  /** Fingerprint recorded when the instrument qualification began. */
  qualificationFingerprint: string;
  task: TaskConfig;
  verifierInputs: string[];
  gates: string[];
  /** Contract-declared evaluator files, hashed into the identity separately from pinned inputs. */
  identityInputs?: string[];
  /** Frozen instrument baseline, when qualification produced one. */
  evaluationContract?: EvaluationContract | null;
}

/**
 * Reuse a qualified instrument's readings as the campaign's evaluator check, so the
 * loop does not pay for the same baseline twice. Only valid while the project still
 * matches the tree the approximation-free baseline was measured on: the same verifier
 * identity over edited content would seed a stale number.
 *
 * The campaign stores scores normalized to "higher is better" (a lower-is-better
 * reading is recorded as its negation), so a raw instrument baseline is negated for
 * a minimizing contract before it is seeded. Seeding raw values would make the
 * campaign treat a measurement of "more is worse" as if it were already normalized.
 */
export function campaignSeedReadings(options: SeedReadingsOptions): CampaignSeedReadings | null {
  const qualified = options.evaluationContract;
  if (!qualified || qualified.baseline.length === 0) return null;
  if (projectFingerprint(options.projectDir) !== options.qualificationFingerprint) return null;
  return {
    identity: campaignVerifierIdentity(options.projectDir, options.task, options.verifierInputs, options.gates, options.identityInputs ?? []),
    runs: qualified.baseline.map((reading) => ({
      durationMs: 0, code: null, valid: true, failClass: "ok",
      score: qualified.higherIsBetter ? reading : -reading,
      error: null,
      stdoutTail: "seeded from loop qualification", logPath: null,
    })),
  };
}

/**
 * Keep a campaign's own stop classification.
 *
 * A blocked run and an unavailable agent name a condition the operator must fix, so
 * they stay `blocked`. Everything else is a campaign failure.
 */
function classifyCampaignFailure(reason: string): string {
  if (reason.startsWith("blocked:")) return reason;
  if (/agent unavailable/i.test(reason)) return `blocked: ${reason}`;
  return `campaign failed: ${reason}`;
}

/** Scope governs writes, not the read/run dependencies of a verifier or gate. */
function bootstrapWritePlan(contract: RunContract, rawPaths: string[]): { paths: string[]; checks: LoopPreflightCheck[] } {
  const normalized = rawPaths.map((file) => normalizeProjectRelativePath(file));
  const invalid = rawPaths.filter((_file, index) => normalized[index] === null);
  const paths = [...new Set(normalized.filter((file): file is string => file !== null))];
  const outside = paths.filter((file) => !pathWithin(file, contract.scope.roots));
  const protectedPaths = paths.filter((file) => pathProtected(file, contract.scope.protectedAssets));
  const checks: LoopPreflightCheck[] = [];
  if (invalid.length) checks.push({ name: "scope", status: "blocked", reason: `Evaluator bootstrap paths must be normalized project-relative files without traversal or absolute paths: ${invalid.join(", ")}.`, remedy: "Replace each path with an exact file path inside the project, without `..`, an absolute prefix, or a trailing slash." });
  if (outside.length) checks.push({ name: "scope", status: "blocked", reason: `Planned bootstrap writes are outside editable scope: ${outside.join(", ")}.`, remedy: `Approve only the required write paths before setup: ${outside.join(", ")}. Existing evaluator and gate files do not need edit permission to run.` });
  if (protectedPaths.length) checks.push({ name: "scope", status: "blocked", reason: `Evaluator bootstrap paths are protected and cannot be changed: ${protectedPaths.join(", ")}.`, remedy: "Choose different bootstrap paths that are inside editable scope and outside all protected assets." });
  return { paths, checks };
}

function buildLoopPreflight(contract: RunContract, recon: ReconResult, inventory: LeverInventory, focus = "", bootstrapPaths: string[] = []): LoopResult["preflight"] {
  const checks: LoopPreflightCheck[] = [];
  const blocker = (name: LoopPreflightCheck["name"], reason: string, remedy: string): void => {
    checks.push({ name, status: "blocked", reason, remedy });
  };
  const metricIsTime = timeLikeOutcome(contract.outcome);
  const nativeFailureCount = contract.outcome.unit.trim().toLowerCase() === "failures"
    && !contract.outcome.higherIsBetter
    && inventory.levers.some((lever) => lever.metricKind === "suite-failures");
  if (contract.outcome.evaluator || metricIsTime || contract.outcome.proxyJustification || nativeFailureCount) {
    checks.push({ name: "metric", status: "passed", reason: contract.outcome.evaluator
      ? `The declared ${contract.outcome.unit} metric has a pinned evaluator command.`
      : nativeFailureCount ? "The declared lower-is-better failure-count metric has a scoped failing-test measurement."
        : contract.outcome.proxyJustification ? `The ${contract.outcome.unit} proxy is explicitly justified.` : `The ${contract.outcome.unit} metric is measured directly.` });
  } else {
    blocker("metric", `The declared ${contract.outcome.unit} metric has no evaluator and wall-clock time is not an approved substitute.`, "Supply an evaluator command and output format, or explicitly approve a justified proxy.");
  }
  if (contract.outcome.evaluator) {
    checks.push({ name: "evaluator", status: "passed", reason: "The contract supplies an executable evaluator command and output format; execution is checked during qualification." });
  } else if (nativeFailureCount) {
    checks.push({ name: "evaluator", status: "passed", reason: "Recon found a scoped failing-test suite, which provides the native failure-count instrument without a separate score evaluator." });
  } else if (metricIsTime || contract.outcome.proxyJustification) {
    checks.push({ name: "evaluator", status: "not-checked", reason: "No user evaluator command was supplied; a declared executable workload must be discovered for the approved time metric or proxy." });
  } else {
    blocker("evaluator", "No executable evaluator command is declared for the selected metric.", "Supply the evaluator argv and output format; a unit and score direction alone are not an evaluator.");
  }

  const workloadBlockers = recon.blockers.filter((reason) => /no benchmark or custom workload|declared workload .* did not complete|does not name a local entry file|no declared command matches/i.test(reason));
  const hasWorkload = recon.probes.some((probe) => probe.ok && recon.commands.some((command) => command.label === probe.label && (command.category === "benchmark" || command.category === "custom")));
  const hasFailingTest = recon.probes.some((probe) => !probe.ok && !probe.timedOut && probe.spawnFailed !== true && probe.exitCode !== null && probe.exitCode !== undefined
    && recon.commands.some((command) => command.label === probe.label && command.category === "test"));
  if (hasWorkload || hasFailingTest || contract.outcome.evaluator) {
    checks.push({ name: "workload", status: "passed", reason: hasWorkload ? "A declared benchmark or custom workload completed during discovery."
      : hasFailingTest ? "A declared test command completed with failures and can be measured as a failure-count workload."
        : "A contract-declared evaluator is available; workload validity is checked during qualification." });
  } else {
    const pinnedRequest = `${contract.outcome.statement} ${focus}`.match(/\bpinned\s+(?:synthetic\s+)?[^.;]{1,100}?\bworkload\b/i)?.[0];
    const reason = pinnedRequest
      ? `No executable ${pinnedRequest} was discovered; ${workloadBlockers[0] ?? "no runnable benchmark or custom workload is available"}.`
      : workloadBlockers[0] ?? "No executable workload was found for the approved metric.";
    blocker("workload", reason, `Declare and pin the requested workload and its evaluator${focus ? ` for “${focus.slice(0, 140)}”` : ""}. Use /dream-rsi loop <goal> to prepare and review the evaluator, scope and gates. For automation, supply evaluator.argv/output/inputs, unit and higher_is_better directly with dream_rsi_loop or a reviewed --config file. Preparation is not approval or qualification. Existing verification files need no edit permission; if setup must create or change files, approve its exact in-scope write plan.`);
  }

  const writeChecks = bootstrapWritePlan(contract, bootstrapPaths).checks;
  checks.push(...writeChecks);
  const scopeRejections = inventory.levers.length === 0
    ? inventory.rejected.filter((entry) => /approved editable scope|outside .*scope/i.test(entry.reason))
    : [];
  if (scopeRejections.length > 0) blocker("scope", `Candidate work is outside the approved editable scope: ${scopeRejections.map((entry) => entry.reason).join("; ")}.`, "Expand the approved scope to include the required implementation files, or choose a workload exercised by files already in scope.");
  else if (writeChecks.length === 0) checks.push({ name: "scope", status: "passed", reason: "Candidate edits and planned bootstrap writes are inside the approved boundary. Existing evaluators, fixtures, and correctness gates may be read or run outside editable scope." });

  if (contract.preserved.gates.every((gate) => gate.trim().length > 0)) {
    checks.push({ name: "gates", status: "not-checked", reason: contract.preserved.gates.length
      ? `${contract.preserved.gates.length} correctness gate(s) are declared; commands and target behavior are exercised before campaign search during qualification.`
      : "No correctness gates were declared; campaign readiness requires an independently valid evaluator and oracle." });
  } else {
    blocker("gates", "At least one correctness gate is empty.", "Replace the empty gate with an executable correctness check or remove it from the approved contract.");
  }
  const status = checks.some((check) => check.status === "blocked") ? "blocked"
    : checks.some((check) => check.status === "not-checked") ? "not-checked" : "passed";
  return { status, checks };
}

function qualificationBlockers(plan: MetricPlan | null, fallbackReason?: string): LoopPreflightCheck[] {
  const failures = plan?.qualification?.checks.filter((check) => check.required && !check.passed) ?? [];
  const checks = failures.length > 0 ? failures : [{ name: "evaluator", detail: fallbackReason ?? "no further detail was reported" }];
  return checks.map((failed) => {
    const name: LoopPreflightCheck["name"] = failed.name === "budget-fit" ? "budget"
      : failed.name === "oracle" ? "gates"
        : failed.name === "workload" || failed.name === "missing-workload" ? "workload" : "evaluator";
    const reason = failures.length > 0
      ? `Instrument qualification failed (${failed.name}): ${failed.detail}`
      : `Campaign setup could not produce a usable instrument: ${failed.detail}.`;
    const remedy = name === "budget" ? "Increase the remaining evaluator or deadline allowance within the approved limits, or reduce the required work."
      : name === "gates" ? "Declare a passing independent correctness gate or score-validity oracle that detects broken candidate code."
        : name === "workload" ? "Supply a runnable pinned workload for the declared metric. Approve editable scope only for files that setup or candidates must change, not existing verification dependencies."
          : "Fix the declared evaluator and verify its output against the selected metric without changing its unit or direction.";;
    return { name, status: "blocked", reason, remedy };
  });
}

function classifyStop(reason: string): LoopStopCode {
  if (!reason) return "completed";
  if (reason === "not-approved") return "consent-required";
  if (reason === "budget" || reason.includes("allowance exhausted")) return "budget-exhausted";
  if (reason === "deadline" || reason.startsWith("campaign deadline")) return "deadline";
  if (reason === "cancelled") return "cancelled";
  if (reason === "no verifiable lever") return "no-verifiable-lever";
  if (reason === "blocked" || reason.startsWith("blocked:")) return "blocked";
  if (reason === "paused") return "paused";
  if (reason === "confirmation pending") return "confirmation-pending";
  if (reason === "confirmation complete") return "confirmation-complete";
  if (reason.startsWith("post-apply check failed")) return "post-apply-failure";
  if (reason.startsWith("campaign failed") || reason.startsWith("resume failed")) return "campaign-failure";
  return "stopped";
}

/**
 * Run the unattended loop until a stop rule fires. Return outcomes, spend,
 * durable state paths, and a bounded Memento digest for the next run.
 */
export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const limits = options.limits;

  const projectDir = path.resolve(options.projectDir);
  if (!fs.existsSync(projectDir)) throw new Error(`loop project directory does not exist: ${projectDir}`);
  const baseRoot = path.resolve(options.baseRoot ?? path.join(projectDir, ".dream-rsi"));
  if (path.basename(baseRoot).toLowerCase() !== ".dream-rsi") throw new Error("loop baseRoot must be the project's canonical .dream-rsi directory");
  const loopRoot = path.resolve(options.loopRoot ?? path.join(baseRoot, "loop"));
  const loopRelative = path.relative(baseRoot, loopRoot);
  if (loopRelative === "" || loopRelative.startsWith("..") || path.isAbsolute(loopRelative)) {
    throw new Error("loopRoot must be a child of baseRoot so synthesized verifiers stay in the protected subtree");
  }

  const now = options.now ?? (() => new Date());
  const startedMs = Date.now();
  // A contract run's wall-clock allowance is durable across restarts; a legacy run
  // keeps the per-run window its callers already rely on.
  const consumedWallMs = readStoredContract(loopRoot) ? readConsumedWallMs(loopRoot) : 0;
  const remainingWallMs = Math.max(0, limits.deadlineMs - consumedWallMs);
  const deadlineAt = startedMs + remainingWallMs;
  const budgetPath = path.join(loopRoot, "budget.json");
  const memoryPath = path.join(loopRoot, "memory.json");
  const activeContextPath = path.join(loopRoot, "active.json");
  let memory = readMemory(memoryPath);
  const records: LoopCampaignRecord[] = [];
  const verifications: LoopVerification[] = [];
  /** Objective/instrument identity this run compares against. */
  let contractId: string | null = null;
  let evaluatorId: string | null = null;
  let lastCampaignId: string | null = null;
  let ranking: LeverRankingEntry[] = [];
  let inventory: LeverInventory | null = null;
  let stopReason = "";
  let preflight: LoopResult["preflight"] = { status: "not-checked", checks: [] };
  let runStartEvaluatorRuns = 0;
  let runStartAgentStarts = 0;
  let runStartPhases: Partial<Record<LoopPhase, import("./budget.ts").LoopPhaseSpend>> = {};
  let resumePending = options.resumeActiveCampaign === true;
  let approved: ApprovedContract | null = null;
  let storedAtStart: ApprovedContract | null = null;
  let recon: ReconResult | null = null;
  const rejectedThisRun = new Set<string>();
  let updateActivityDetail: ((message: string) => void) | undefined;
  const progress = (message: string): void => {
    // Publish work labels, not arbitrary evaluator or provider error text, in live metadata.
    if (message.startsWith("recon: probing ")) updateActivityDetail?.(message);
    options.onProgress?.(message);
  };
  const collectSignalsImpl = options.collectSignalsImpl ?? ((input: { projectDir: string; focus?: string; includeLogs?: boolean; sessionDir?: string }) => collectSignals({ ...input, now: now() }));
  const reconProjectImpl = options.reconProjectImpl ?? reconProject;
  const runCampaignImpl = options.runCampaignImpl ?? runCampaign;
  const resumeCampaignImpl = options.resumeCampaignImpl ?? resumeCampaign;
  const searchConfigPath = path.join(loopRoot, "search-config.json");
  const readSearchConfig = (): SearchConfig => {
    try { return validateSearchConfig(JSON.parse(fs.readFileSync(searchConfigPath, "utf8"))) ?? defaultSearchConfig; }
    catch { return defaultSearchConfig; }
  };
  const campaignDefaults = {
    maxCycles: 2,
    maxAgentStarts: 18,
    maxEvaluatorRuns: 48,
    deadlineMs: 60 * 60 * 1000,
    ...options.campaignDefaults,
  };

  const recordOutcome = (record: Omit<LoopMemoryRecord, "kind">, campaignRoot: string | null): void => {
    memory = recordCampaignOutcome(memory, { kind: "campaign", ...record });
    writeMemory(memoryPath, memory);
    records.push({ kind: "campaign", ...record, campaignRoot });
  };

  const addNote = (text: string): void => {
    memory = { ...memory, notes: [...memory.notes, text.slice(0, 220)].slice(-MAX_NOTES) };
    writeMemory(memoryPath, memory);
  };

  /** Returned-state note only: a blocked invocation must not rewrite records the owner holds. */
  const noteLocally = (text: string): void => {
    memory = { ...memory, notes: [...memory.notes, text.slice(0, 220)].slice(-MAX_NOTES) };
  };

  const rejectLever = (lever: LeverProposal, reason: string): void => {
    progress(`loop: rejected lever ${lever.id} (${lever.sourceKind}): ${reason}`);
    addNote(`lever ${lever.id} rejected: ${reason}`);
    recordOutcome({ leverId: lever.id, outcome: "rejected", stopReason: reason.slice(0, 200), evaluatorRuns: 0, agentStarts: 0, wallMs: 0, at: now().toISOString() }, null);
    rejectedThisRun.add(lever.id);
  };

  // Loop lease first, before any durable accounting: a blocked invocation must not touch the
  // active owner's budget. The claim is one exclusive creation, so two simultaneous starts
  // cannot both hold it; a stale lease (no heartbeat inside the staleness window) is taken
  // over explicitly, and the takeover is noted.
  const leasePath = path.join(loopRoot, "lease.json");
  const leaseStartedAt = now().toISOString();
  const lease: LoopLease = { pid: process.pid, host: os.hostname(), startedAt: leaseStartedAt, heartbeatAt: leaseStartedAt,
    activity: { phase: "setup", detail: "Checking saved approval and durable budget", updatedAt: leaseStartedAt } };
  const claim = acquireLease(leasePath, lease, (holder) => now().getTime() - Date.parse(holder.heartbeatAt) < LEASE_STALE_MS);
  const leaseHeld = claim.held;
  if (!claim.held) {
    noteLocally(claim.publishing
      ? "blocked: another loop is publishing its lease file; retry shortly."
      : `blocked: ${claim.reason ?? `another loop (pid ${claim.holder?.pid ?? "unknown"}) holds the loop lease with a heartbeat at ${claim.holder?.heartbeatAt ?? "unknown"}; stop it or wait for the lease to go stale before looping again.`}`);
    stopReason = "blocked";
  } else if (claim.stale) {
    addNote(`took over a stale loop lease last refreshed at ${claim.stale.heartbeatAt}.`);
  }
  let leaseOwnershipWarned = false;
  const touchLease = (): void => {
    if (!leaseHeld) return;
    const current = readLease(leasePath);
    if (!current || current.pid !== lease.pid || current.host !== lease.host || current.startedAt !== lease.startedAt) {
      if (!leaseOwnershipWarned) noteLocally("the loop lease is no longer owned by this run; live activity is not being published and another loop may hold this project");
      leaseOwnershipWarned = true;
      return;
    }
    writeFileAtomic(leasePath, `${JSON.stringify({ ...lease, heartbeatAt: now().toISOString() }, null, 2)}\n`, true);
  };
  let activityWriteWarning = false;
  let lastActivityWriteMs = 0;
  const persistActivity = (always: boolean): void => {
    // Campaign status updates arrive many times per iteration. Stage changes and progress
    // labels always publish; only high-frequency detail is coalesced, and it is flushed by
    // the next lease touch so a long phase never loses its label.
    if (!always && Date.now() - lastActivityWriteMs < 1000) return;
    try { touchLease(); lastActivityWriteMs = Date.now(); }
    catch (error) {
      if (!activityWriteWarning) noteLocally(`Live activity could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      activityWriteWarning = true;
      if (lease.activity) lease.activity.detail = activityText(`${lease.activity.detail} [live activity update not saved]`);
    }
  };
  const setActivity = (phase: string, detail: string, campaignId?: string, coalesce = false): void => {
    if (!leaseHeld) return;
    const previousPhase = lease.activity?.phase;
    lease.activity = { phase, detail: activityText(detail), updatedAt: now().toISOString(), ...(campaignId ? { campaignId } : {}) };
    persistActivity(!coalesce || phase !== previousPhase);
    options.onActivity?.({ state: options.signal?.aborted ? "stopping" : "running", ...lease.activity, startedAt: leaseStartedAt });
  };
  updateActivityDetail = (message) => setActivity(lease.activity?.phase ?? "setup", message, lease.activity?.campaignId);
  const onAbort = (): void => setActivity("stopping", "Cancellation requested; waiting for active work to unwind", lease.activity?.campaignId);
  if (leaseHeld) options.signal?.addEventListener("abort", onAbort, { once: true });
  let budget: LoopBudgetFile | null = null;
  const chargeOne = (phase: LoopPhase, process: "agent" | "evaluator"): void => {
    if (!budget) throw new LoopBudgetExhaustedError(`${phase} process`);
    const spend = process === "agent" ? { agentStarts: 1 } : { evaluatorRuns: 1 };
    if (!hasAllowance(budget, spend)) throw new LoopBudgetExhaustedError(`${phase} process`);
    const grant: LoopReservation = {
      phase, agent_starts: process === "agent" ? 1 : 0,
      evaluator_runs: process === "evaluator" ? 1 : 0, campaigns: 0, at: now().toISOString(),
    };
    budget = settleReservation(budget, grant, { agentStarts: grant.agent_starts, evaluatorRuns: grant.evaluator_runs, campaigns: 0 });
    writeLoopBudget(budgetPath, budget);
  };
  let agentProbed = false;
  /**
   * One charged agent start in a copy of the tree the campaign would use. A dead command,
   * a missing model, or a provider error must stop before the first campaign, not after it
   * has burned its allowance on attempts that can only fail.
   *
   * The probe runs in a copy of the task workspace because a task may launch its agent
   * with a project-relative command or script. An empty directory would break that
   * launcher and report a healthy agent as dead.
   */
  const probeAgentLiveness = async (task: TaskConfig): Promise<void> => {
    if (agentProbed) return;
    agentProbed = true;
    // Test seams replace the campaign engine, so a real probe would change their exact spend.
    if (options.runCampaignImpl || options.taskProvider) return;
    if (options.signal?.aborted) { stopReason = "cancelled"; return; }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) { stopReason = "deadline"; return; }
    setActivity("liveness", "Checking the configured agent before campaign search");
    const scratch = fs.mkdtempSync(path.join(loopRoot, "liveness-"));
    try {
      const startedAt = Date.now();
      const workspaceRoot = path.resolve(projectDir, task.workspace ?? ".");
      try {
        await copyWorkspace(workspaceRoot, scratch, {
          exclude: [path.join(projectDir, ".git"), path.join(projectDir, ".dream-rsi")],
        });
      } catch (error) {
        stopReason = `blocked: the agent liveness probe could not prepare its workspace copy: ${error instanceof Error ? error.message : String(error)}`;
        addNote(stopReason);
        progress(`loop: ${stopReason}`);
        return;
      }
      let result: Awaited<ReturnType<typeof runAgent>>;
      // The copy spent part of the wall-clock budget, so the remaining time is measured
      // again. An expired or cancelled run must not spawn or charge an agent.
      const timeLeft = deadlineAt - Date.now();
      if (options.signal?.aborted) { stopReason = "cancelled"; return; }
      if (timeLeft <= 0) { stopReason = "deadline"; return; }
      try {
        result = await runAgent({
          agent: task.agent,
          ...(options.resolveAgent ? { resolveAgent: options.resolveAgent } : {}),
          cwd: scratch,
          prompt: "Dream-RSI agent liveness probe. Reply with the single word ok. Do not change files.",
          timeoutMs: Math.max(1, Math.min(task.agent_timeout_ms, timeLeft, 4 * 60 * 1000)),
          ...(options.signal ? { signal: options.signal } : {}),
          beforeSpawn: () => chargeOne("qualification", "agent"),
          logPath: path.join(loopRoot, "liveness", "agent.log"),
        });
      } catch (error) {
        if (error instanceof LoopBudgetExhaustedError) {
          stopReason = "budget";
          addNote(`${error.message}; the run stops here rather than overspending.`);
          return;
        }
        throw error;
      }
      if (options.signal?.aborted) { stopReason = "cancelled"; return; }
      const effective = result.effectiveAgent;
      const label = `command "${effective?.command ?? task.agent.command}" model "${effective?.model ?? "child default"}"`;
      const detail = result.spawnError
        ? result.spawnError
        : result.timedOut
          ? `timed out after ${Math.ceil((Date.now() - startedAt) / 1000)}s`
          : !result.ok
            ? `exited with code ${result.code ?? "unknown"}`
            : (result.evidence?.terminalError ?? false)
              ? "reported a model or provider error"
              : result.outputFormat === "pi-json" && !result.evidence?.assistantText
                ? "returned no assistant text"
                : null;
      if (detail) {
        stopReason = `blocked: agent liveness probe failed before the first campaign: ${label} ${detail}. Fix the agent command or model, then start again.`;
        addNote(stopReason);
        progress(`loop: ${stopReason}`);
      } else {
        progress(`loop: agent liveness probe passed (${label})`);
      }
    } finally {
      try { fs.rmSync(scratch, { recursive: true, force: true }); }
      catch (e: any) { if (e?.code === "EBUSY" || e?.code === "EPERM") console.error(`EBUSY/EPERM at loop.ts finally scratch remove:`, new Error("EBUSY-site").stack); throw e; }
    }
  };
  const resumeSavedCampaign = async (): Promise<void> => {
    setActivity("resuming", "Loading saved campaign and confirmation evidence");
    const contextExists = fs.existsSync(activeContextPath);
    let context = readJson<LoopResumeContext>(activeContextPath);
    const before = readCampaignStatus(baseRoot);
    if (!before) throw new Error("the saved loop context has no campaign");
    if (!context && !contextExists && options.confirmationOnly) {
      if (!approved || !before.pendingConfirmation) throw new Error("confirmation recovery requires an approved contract and a saved pending candidate");
      const record = readJson<CampaignRecord>(path.join(before.campaignRoot, "campaign.json"));
      if (!record || record.id !== before.id || path.resolve(record.campaignRoot) !== path.resolve(before.campaignRoot)) {
        throw new Error("saved campaign record is missing or inconsistent; confirmation recovery refused");
      }
      context = recoverPendingConfirmationContext({ record, contract: approved.contract, projectDir, loopRoot, baseRoot });
      writeJson(activeContextPath, context);
      progress(`loop: reconstructed the frozen context for pending confirmation ${record.id} from validated campaign evidence`);
    }
    if (!context || context.version !== 1 || !context.lever?.id || !context.setup?.task || !context.plan || !context.instrument) {
      throw new Error("saved loop resume context is missing or invalid; the campaign cannot continue safely");
    }
    if (options.confirmationOnly && !before.pendingConfirmation) throw new Error("confirmation-only resume requires a saved pending candidate");
    const terminal = before.state.kind === "complete" || before.state.kind === "failed";
    if (!terminal && before.state.kind !== "paused" && before.state.kind !== "running") throw new Error("the saved loop context has no paused or interrupted campaign");
    if (before.state.kind === "running" && phaseIsActive(before.campaignRoot, "campaign")) throw new Error("the saved campaign is still running in another process");
    let result: CampaignResult;
    let agentDelta = 0;
    let evaluatorDelta = 0;
    if (terminal) {
      // A crash after the campaign committed but before independent verification
      // leaves a terminal campaign plus its frozen instrument in active.json.
      result = { ...before, stopped: true, stopReason: before.state.kind === "complete" || before.state.kind === "failed" ? before.state.reason : "" };
    } else {
      if (!budget) throw new LoopBudgetExhaustedError("campaign resume");
      const remaining = remainingAllowance(budget);
      const postApplyReserve = context.instrument.gates.length + (context.instrument.kind === "command-duration" ? 3 : 1);
      const campaignEvaluatorAllowance = Math.max(0, remaining.evaluatorRuns - postApplyReserve);
      if (remaining.agentStarts <= 0 || campaignEvaluatorAllowance <= 0) throw new LoopBudgetExhaustedError("campaign resume");
      const confirmationExtension = options.confirmationOnly ? {
        agentStarts: Math.max(0, remaining.agentStarts - Math.max(0, before.limits.maxAgentStarts - before.agentStarts)),
        evaluatorRuns: Math.max(0, campaignEvaluatorAllowance - Math.max(0, before.limits.maxEvaluatorRuns - before.evaluatorRuns)),
        deadlineMs: Math.max(0, deadlineAt - Date.now() - Math.max(0, Date.parse(before.deadlineAt) - Date.now())),
      } : undefined;
      const reservation: LoopReservation = {
        phase: "campaign", agent_starts: remaining.agentStarts, evaluator_runs: campaignEvaluatorAllowance,
        campaigns: 0, campaign_id: before.id,
        campaign_agent_starts_before: before.agentStarts, campaign_evaluator_runs_before: before.evaluatorRuns,
        at: now().toISOString(),
      };
      budget = { ...budget, open_campaign: reservation };
      writeLoopBudget(budgetPath, budget);
      try {
        result = await resumeCampaignImpl({
        baseRoot, projectDir,
        ...(approved ? { evaluatorEnv: restrictedEnvironment(approved.contract), evaluatorEnvKeys: approved.contract.execution.envAllowlist } : {}),
        ...(options.confirmationOnly ? { confirmationOnly: true, ...((confirmationExtension!.agentStarts + confirmationExtension!.evaluatorRuns + confirmationExtension!.deadlineMs > 0) ? { extendLimits: confirmationExtension } : {}) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.resolveAgent ? { resolveAgent: options.resolveAgent } : {}),
        onUpdate: (status) => {
          setActivity("resuming", `Campaign ${status.id}: ${status.state.kind}${status.state.kind === "running" ? ` / ${status.state.phase}` : ""}`, status.id, true);
          options.onCampaignUpdate?.(status);
        },
        ...(options.onPhaseProgress ? { onPhaseProgress: options.onPhaseProgress } : {}),
        onProgress: progress,
        });
      } catch (error) {
        budget = settleReservation(budget, reservation, { agentStarts: reservation.agent_starts, evaluatorRuns: reservation.evaluator_runs, campaigns: 0 });
        writeLoopBudget(budgetPath, budget);
        throw error;
      }
      agentDelta = Math.max(0, result.agentStarts - before.agentStarts);
      evaluatorDelta = Math.max(0, result.evaluatorRuns - before.evaluatorRuns);
      budget = settleReservation(budget, reservation, { agentStarts: agentDelta, evaluatorRuns: evaluatorDelta, campaigns: 0 });
      writeLoopBudget(budgetPath, budget);
    }
    evaluatorId = context.plan.evaluationContract?.id ?? null;
    contractId = context.contractId;
    lastCampaignId = result.id;
    writeJson(activeContextPath, { ...context, campaignId: result.id, phase: "post-apply" } satisfies LoopResumeContext);

    const applied = readLedger(path.join(result.campaignRoot, "history", "ledger.jsonl")).entries
      .some((entry) => entry.kind === "apply" && entry.outcome === "success");
    const failed = result.state.kind === "failed";
    const paused = result.state.kind === "paused";
    let postApplyFailure: string | null = null;
    let verifiedGain: number | undefined;
    if (applied) {
      if (!approved) postApplyFailure = "the saved loop contract is unavailable for independent verification";
      else {
        try {
          setActivity("post-apply", "Independently verifying the resumed applied change", result.id);
          const checked = await verifyPostApply({
            projectDir, contract: approved.contract,
            argv: context.instrument.argv, gates: context.instrument.gates, baseline: context.instrument.baseline,
            minimumUsefulGain: context.instrument.minimumUsefulGain, unit: context.instrument.unit,
            higherIsBetter: context.instrument.higherIsBetter,
            ...(context.instrument.kind !== "command-duration" ? { kind: context.instrument.kind, ...(context.instrument.evaluator ? { evaluator: context.instrument.evaluator } : {}) } : {}),
            workRoot: path.join(loopRoot, "post-apply"), timeoutMs: context.instrument.timeoutMs,
            beforeProcess: () => chargeOne("post-apply", "evaluator"),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.measureImpl ? { measureImpl: options.measureImpl } : {}),
          });
          if (checked.passed) verifiedGain = checked.gain ?? undefined;
          else postApplyFailure = checked.reason ?? "the resumed apply did not pass its independent post-apply check";
          verifications.push({ leverId: context.lever.id, campaignId: result.id, outcome: "win", passed: checked.passed, reason: checked.reason, at: now().toISOString() });
        } catch (error) {
          postApplyFailure = error instanceof Error ? error.message : String(error);
          verifications.push({ leverId: context.lever.id, campaignId: result.id, outcome: "win", passed: false, reason: postApplyFailure, at: now().toISOString() });
        }
      }
    }
    const outcome: LoopMemoryRecord["outcome"] = postApplyFailure ? "no-win" : applied ? "win" : failed ? "error" : paused ? "error" : "no-win";
    const reason = postApplyFailure ?? result.stopReason;
    recordOutcome({
      leverId: context.lever.id, outcome, stopReason: reason.slice(0, 200),
      evaluatorRuns: evaluatorDelta, agentStarts: agentDelta, wallMs: 0, at: now().toISOString(),
      ...(verifiedGain === undefined ? {} : { verifiedGain }),
      provenance: { contractId: context.contractId, ...(evaluatorId ? { evaluatorId } : {}), baselineFingerprint: projectFingerprint(projectDir), mechanism: context.lever.mechanism.slice(0, 200), strategyClass: context.lever.sourceKind },
    }, result.campaignRoot);
    if (!paused) fs.rmSync(activeContextPath, { force: true });
    if (paused) stopReason = options.confirmationOnly ? "confirmation pending" : "paused";
    else if (postApplyFailure) stopReason = `post-apply check failed: ${postApplyFailure}`;
    else if (failed) stopReason = classifyCampaignFailure(result.stopReason);
    else if (options.confirmationOnly) stopReason = "confirmation complete";
    else progress(`loop: resumed campaign ${result.id} finished as ${outcome} (${result.stopReason || "no reason"})`);
  };
  // Requested limits and approved contract budgets combine into this run's total
  // allowance. Replacement later prevents that allowance from shrinking saved caps.
  const approvedBudgets = approvedContract(options.contract);
  const durableLimits = {
    maxCampaigns: Math.min(limits.maxCampaigns, approvedBudgets?.maxCampaigns ?? limits.maxCampaigns),
    maxAgentStarts: Math.min(limits.maxAgentStarts, approvedBudgets?.maxAgentStarts ?? limits.maxAgentStarts),
    maxEvaluatorRuns: Math.min(limits.maxEvaluatorRuns, approvedBudgets?.maxEvaluatorRuns ?? limits.maxEvaluatorRuns),
    deadlineMs: Math.min(limits.deadlineMs, approvedBudgets?.deadlineMs ?? limits.deadlineMs),
  };

  try {
    if (leaseHeld) {
      setActivity("setup", "Checking saved approval and durable budget");
      recoverBudgetExtension(loopRoot);
      storedAtStart = readStoredContract(loopRoot);
      const existingCaps = readSavedBudgetCaps(budgetPath);
      budget = readOrCreateLoopBudget(budgetPath, {
        maxCampaigns: existingCaps?.max_campaigns ?? durableLimits.maxCampaigns,
        maxAgentStarts: existingCaps?.max_agent_starts ?? durableLimits.maxAgentStarts,
        maxEvaluatorRuns: existingCaps?.max_evaluator_runs ?? durableLimits.maxEvaluatorRuns,
        deadlineMs: durableLimits.deadlineMs,
      });
      if (!options.replaceContract && (durableLimits.maxCampaigns !== budget.max_campaigns
        || durableLimits.maxAgentStarts !== budget.max_agent_starts || durableLimits.maxEvaluatorRuns !== budget.max_evaluator_runs)) {
        throw new Error("loop budget limits are immutable without an explicitly approved contract replacement");
      }
      // Crash-safe accounting: a leftover reservation means the previous process
      // died mid-phase, so charge the granted budget before spending more.
      const open = budget.open_campaign;
      const recoveredCampaign = open?.phase === "campaign" && open.campaign_id ? readCampaignStatus(baseRoot) : null;
      const observed = recoveredCampaign && recoveredCampaign.id === open?.campaign_id
        ? { agentStarts: recoveredCampaign.agentStarts, evaluatorRuns: recoveredCampaign.evaluatorRuns, campaigns: open?.campaigns ?? 1 }
        : undefined;
      const recovered = reconcileOpenReservation(budget, observed);
      if (recovered) {
        budget = recovered.budget;
        writeLoopBudget(budgetPath, budget);
        const open = recovered.charged;
        addNote(`reconciled an interrupted ${open.phase} phase as spent at its granted budget (agent starts ${open.agent_starts}, evaluator runs ${open.evaluator_runs}, campaigns ${open.campaigns}); the reservation was written ${open.at}.`);
      }
      runStartEvaluatorRuns = budget.evaluator_runs;
      runStartAgentStarts = budget.agent_starts;
      runStartPhases = structuredClone(budget.phases ?? {});
    }
    // The approved contract is honoured before any discovery or probe: without
    // trusted-local consent nothing runs on this host.
    if (leaseHeld && !options.contract) {
      noteLocally("not-approved: a trusted-local run contract is required before repository commands can run");
      stopReason = "not-approved";
    } else if (leaseHeld) {
      try {
        const contract = options.contract;
        const proposed = approveRunContract(projectDir, contract);
        const stored = storedAtStart;
        const differs = stored && approvalIdentity(stored.contract) !== approvalIdentity(proposed.contract);
        if (options.replaceContract && (!stored || approvalIdentity(stored.contract) !== options.replaceContract)) {
          throw new ContractNotApprovedError("The saved run contract changed after replacement approval; inspect it and approve the new boundary again.", "contract");
        }
        if (differs && !options.replaceContract) {
          throw new ContractNotApprovedError(`A different run contract is already stored for this project: "${stored.contract.outcome.statement}". Requested objective: "${contract.outcome.statement}". Inspect both boundaries, then explicitly authorize replace_contract=true or --replace-contract. Consent alone does not replace a contract; replacement can only raise caps and retains all recorded spend.`, "contract");
        }
        const rawBootstrapPaths = options.evaluatorBootstrap?.authorized ? options.evaluatorBootstrap.paths : [];
        const { checks: staticChecks } = bootstrapWritePlan(contract, rawBootstrapPaths);
        if (contract.execution.consent && staticChecks.length > 0) {
          preflight = { status: "blocked", checks: staticChecks };
          stopReason = `blocked: ${staticChecks.map((check) => `${check.reason} Next step: ${check.remedy}`).join(" ")}`;
          addNote(stopReason);
        } else {
          if (differs) {
            if (options.signal?.aborted) { stopReason = "cancelled"; }
            else {
              const campaign = readCampaignStatus(baseRoot);
              if (campaign?.state.kind === "running" || campaign?.state.kind === "paused" || campaign?.pendingConfirmation || fs.existsSync(activeContextPath)) {
                throw new ContractNotApprovedError("Contract replacement is blocked while a campaign is running, paused, awaiting confirmation, or awaiting post-apply recovery. Resume or resolve it under the saved contract first.", "contract");
              }
              const priorBudgets = stored.contract.budgets;
              const nextBudgets = contract.budgets;
              if (nextBudgets.maxCampaigns < priorBudgets.maxCampaigns || nextBudgets.maxAgentStarts < priorBudgets.maxAgentStarts
                || nextBudgets.maxEvaluatorRuns < priorBudgets.maxEvaluatorRuns || nextBudgets.deadlineMs < priorBudgets.deadlineMs
                || nextBudgets.falseAcceptBudget !== priorBudgets.falseAcceptBudget) {
                throw new ContractNotApprovedError("Contract replacement may raise durable limits but cannot reduce caps or change the statistical budget.", "contract");
              }
              if (budget && (nextBudgets.maxCampaigns < budget.campaigns || nextBudgets.maxAgentStarts < budget.agent_starts || nextBudgets.maxEvaluatorRuns < budget.evaluator_runs)) {
                throw new ContractNotApprovedError("The raised limits are below spend already recorded; choose caps at or above current spend.", "contract");
              }
            }
          }
          if (!stopReason) {
            const replacingSavedContract = Boolean(stored && budget && options.replaceContract);
            const next = replacingSavedContract ? {
              ...durableLimits,
              maxCampaigns: Math.max(durableLimits.maxCampaigns, budget!.max_campaigns),
              maxAgentStarts: Math.max(durableLimits.maxAgentStarts, budget!.max_agent_starts),
              maxEvaluatorRuns: Math.max(durableLimits.maxEvaluatorRuns, budget!.max_evaluator_runs),
            } : durableLimits;
            if (replacingSavedContract && (next.maxCampaigns < budget!.campaigns || next.maxAgentStarts < budget!.agent_starts || next.maxEvaluatorRuns < budget!.evaluator_runs)) {
              throw new ContractNotApprovedError("The raised limits are below spend already recorded; choose caps at or above current spend.", "contract");
            }
            const raisesCaps = Boolean(budget && (next.maxCampaigns > budget.max_campaigns || next.maxAgentStarts > budget.max_agent_starts || next.maxEvaluatorRuns > budget.max_evaluator_runs));
            try {
              if (replacingSavedContract && raisesCaps) {
                const transaction: BudgetExtensionTransaction = { version: 1, previous: stored!, next: proposed,
                  previousCaps: { maxCampaigns: budget!.max_campaigns, maxAgentStarts: budget!.max_agent_starts, maxEvaluatorRuns: budget!.max_evaluator_runs },
                  nextCaps: { maxCampaigns: next.maxCampaigns, maxAgentStarts: next.maxAgentStarts, maxEvaluatorRuns: next.maxEvaluatorRuns } };
                writeFileAtomic(path.join(loopRoot, "budget-extension.json"), `${JSON.stringify(transaction, null, 2)}\n`, true);
                writeFileAtomic(path.join(loopRoot, "contract.previous.json"), `${JSON.stringify(stored, null, 2)}\n`, true);
                writeFileAtomic(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...proposed }, null, 2)}\n`, true);
                budget = { ...budget!, max_campaigns: next.maxCampaigns, max_agent_starts: next.maxAgentStarts, max_evaluator_runs: next.maxEvaluatorRuns };
                writeLoopBudget(budgetPath, budget);
                fs.rmSync(path.join(loopRoot, "budget-extension.json"), { force: true });
              } else {
                if (differs) writeFileAtomic(path.join(loopRoot, "contract.previous.json"), `${JSON.stringify(stored, null, 2)}\n`, true);
                writeFileAtomic(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...proposed }, null, 2)}\n`, true);
                if (replacingSavedContract) {
                  budget = { ...budget!, max_campaigns: next.maxCampaigns, max_agent_starts: next.maxAgentStarts, max_evaluator_runs: next.maxEvaluatorRuns };
                  writeLoopBudget(budgetPath, budget);
                }
              }
            } catch (error) {
              throw new ContractNotApprovedError(`The approved run contract could not be saved completely; no discovery was started. A cap-extension transaction will be recovered on the next start when present: ${error instanceof Error ? error.message : String(error)}`, "contract");
            }
            approved = proposed;
            contractId = contractIdentity(approved.contract);
            void restrictedEnvironment(approved.contract);
          }
        }
      } catch (error) {
        if (!(error instanceof ContractNotApprovedError)) throw error;
        noteLocally(`not-approved: ${error.reason}`);
        preflight = { status: "blocked", checks: [{ name: "contract", status: "blocked", reason: error.reason,
          remedy: error.kind === "contract" ? "Inspect the saved contract and approve an explicit replacement only after checking the objective, scope, gates, permissions, new total caps, and retained spend." : "Approve trusted-local execution before repository commands can run." }] };
        stopReason = error.kind === "contract" ? `blocked: ${error.reason}` : "not-approved";
      }
    }
    while (!stopReason && budget !== null) {
      if (options.signal?.aborted) { stopReason = "cancelled"; break; }
      touchLease();
      if (Date.now() >= deadlineAt) { stopReason = "deadline"; break; }
      const remaining = remainingAllowance(budget);
      const remainingCampaigns = remaining.campaigns;
      const remainingAgents = remaining.agentStarts;
      const remainingEvaluators = remaining.evaluatorRuns;
      if ((!resumePending && remainingCampaigns <= 0) || remainingAgents <= 0 || remainingEvaluators <= 0) { stopReason = "budget"; break; }

      if (resumePending) {
        resumePending = false;
        try { await resumeSavedCampaign(); }
        catch (error) {
          if (error instanceof LoopBudgetExhaustedError) stopReason = "budget";
          else stopReason = `resume failed: ${error instanceof Error ? error.message : String(error)}`;
          addNote(stopReason);
        }
        if (stopReason) break;
      }

      const activeRecord = readCampaignStatus(baseRoot);
      if (activeRecord && (activeRecord.state.kind === "running" || activeRecord.state.kind === "paused")) {
        addNote(`blocked: campaign ${activeRecord.id} is ${activeRecord.state.kind}; resume or stop it before looping again.`);
        stopReason = "blocked";
        break;
      }
      if (activeRecord) {
        const stopFile = path.join(activeRecord.campaignRoot, "stop.request");
        if (fs.existsSync(stopFile)) {
          fs.rmSync(stopFile, { force: true });
          addNote("cancelled: a stop request arrived between campaigns.");
          stopReason = "cancelled";
          break;
        }
      }

      if (!approved) { stopReason = "not-approved"; break; }
      // The contract's objective, scopes, gates, and workload allowlist govern every
      // discovery run. Session signals only rank recon findings; they cannot create a
      // legacy lever or bypass qualification.
      let evidenceCount = 0;
      const reconOptions = () => ({
        projectDir,
        contract: approved!.contract,
        maxProbes: options.reconProbes ?? 3,
        probeTimeoutMs: Math.max(1, Math.min(120_000, deadlineAt - Date.now())),
        ...(options.signal ? { signal: options.signal } : {}),
        beforeProbe: () => chargeOne("discovery", "evaluator"),
        onProgress: progress,
      });
      try {
        setActivity("discovery", "Discovering and measuring declared workloads");
        recon = await reconProjectImpl(reconOptions());
        // An aborted run must not report the abort as a broken workload.
        if (options.signal?.aborted) { stopReason = "cancelled"; break; }
        const missingWorkload = recon.blockers.some((reason) => /no benchmark or custom workload|no declared command matches|declared workload .* did not complete|does not name a local entry file/i.test(reason));
        const missingSetupFile = options.evaluatorBootstrap?.paths.some((file) => !fs.existsSync(path.resolve(projectDir, file))) ?? false;
        if (((missingWorkload && !approved.contract.outcome.evaluator) || missingSetupFile) && options.evaluatorBootstrap?.authorized) {
          const approvedContract = approved!.contract;
          const scopeRoots = approvedContract.scope.roots;
          const { paths: requiredPaths, checks } = bootstrapWritePlan(approvedContract, options.evaluatorBootstrap.paths);
          const categories = approvedContract.execution.allowedCommandCategories;
          if (!categories.includes("benchmark") && !categories.includes("custom")) checks.push({ name: "workload", status: "blocked", reason: `Approved command categories (${categories.join(", ") || "none"}) do not permit a benchmark or custom workload.`, remedy: "Approve the benchmark or custom command category before bootstrapping a workload." });
          if (checks.length > 0) {
            preflight = { status: "blocked", checks };
            const first = checks[0]!;
            stopReason = `blocked: ${first.reason} Next step: ${first.remedy}`;
            addNote(stopReason);
            break;
          }
          if (requiredPaths.length === 0) throw new Error("evaluator bootstrap requires exact planned file paths");
          if (options.signal?.aborted) { stopReason = "cancelled"; break; }
          const bootstrapDeadlineMs = Math.max(0, deadlineAt - Date.now());
          if (bootstrapDeadlineMs <= 0) { stopReason = "deadline"; break; }
          setActivity("bootstrap", "Creating the approved measurement harness and pinned workload");
          progress(`loop: bootstrapping pinned workload in approved scope (${requiredPaths.join(", ")})`);
          const bootstrap = await options.evaluatorBootstrap.run({ projectDir, contract: approvedContract, ...(options.focus ? { focus: options.focus } : {}), scopeRoots, deadlineMs: bootstrapDeadlineMs, beforeAgentSpawn: () => chargeOne("qualification", "agent"), ...(options.signal ? { signal: options.signal } : {}) });
          const validatedPaths = [...new Set(bootstrap.validatedPaths.map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "")))];
          const invalidPaths = validatedPaths.filter((file) => !requiredPaths.includes(file) || !pathWithin(file, scopeRoots) || pathProtected(file, approvedContract.scope.protectedAssets) || !fs.existsSync(path.resolve(projectDir, file)));
          if (invalidPaths.length > 0 || requiredPaths.some((file) => !validatedPaths.includes(file))) {
            throw new Error(`evaluator bootstrap did not validate its approved paths: ${[...new Set([...invalidPaths, ...requiredPaths.filter((file) => !validatedPaths.includes(file))])].join(", ")}`);
          }
          if (options.signal?.aborted) { stopReason = "cancelled"; break; }
          if (Date.now() >= deadlineAt) { stopReason = "deadline"; break; }
          setActivity("discovery", "Checking the generated workload before ranking");
          recon = await reconProjectImpl(reconOptions());
        }
      } catch (error) {
        if (error instanceof LoopBudgetExhaustedError) {
          addNote(`${error.message}; discovery stops before the durable evaluator cap is exceeded.`);
          stopReason = "budget";
          break;
        }
        if (options.evaluatorBootstrap?.authorized) {
          if (options.signal?.aborted) { stopReason = "cancelled"; break; }
          if (Date.now() >= deadlineAt) { stopReason = "deadline"; break; }
          const reason = `Evaluator bootstrap failed: ${error instanceof Error ? error.message : String(error)}.`;
          preflight = { status: "blocked", checks: [{ name: "workload", status: "blocked", reason, remedy: "Fix the bootstrap failure or supply a runnable pinned workload and evaluator command." }] };
          stopReason = `blocked: ${reason} Next step: Fix the bootstrap failure or supply a runnable pinned workload and evaluator command.`;
          addNote(stopReason);
          break;
        }
        throw error;
      }
      const sessionSignals = await collectSignalsImpl({
        projectDir,
        ...(options.focus ? { focus: options.focus } : {}),
        ...(options.includeLogs !== undefined ? { includeLogs: options.includeLogs } : {}),
        ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      });
      const usageSignals = sessionSignals.weaknesses.filter((weakness) => weakness.evidence.some((item) => item.source === "session"));
      inventory = buildReconInventory({ contract: approved.contract, recon, attempts: attemptsFromMemory(memory), signals: usageSignals });
      preflight = buildLoopPreflight(approved.contract, recon, inventory, options.focus, options.evaluatorBootstrap?.authorized ? options.evaluatorBootstrap.paths : []);
      evidenceCount = recon.probes.length;
      for (const blocker of recon.blockers) addNote(`recon blocker: ${blocker}`);
      // Experiments measured under another objective or another instrument are not
      // comparable; they stay in the durable history but do not steer this run.
      const comparable = comparableMemory(memory, { contractId, evaluatorId });
      const selection = ucbSelect(inventory.levers, comparable, { strategy: "utility" });
      ranking = selection.ranking;
      progress(`loop: ${inventory.levers.length} lever(s) ranked from ${evidenceCount} measured or recorded signal(s); top candidate ${selection.selected?.id ?? "none"}`);

      const ordered: LeverProposal[] = [];
      for (const lever of [selection.selected, ...inventory.levers]) {
        if (lever && !ordered.some((entry) => entry.id === lever.id)) ordered.push(lever);
      }
      if (ordered.length === 0) {
        const blockers = preflight.checks.filter((check) => check.status === "blocked");
        if (blockers.length > 0) {
          const first = blockers[0]!;
          stopReason = `blocked: ${first.reason}${first.remedy ? ` Next step: ${first.remedy}` : ""}`;
          addNote(stopReason);
        } else {
          stopReason = "no verifiable lever";
        }
        break;
      }

      const blockedChecks = preflight.checks.filter((check) => check.status === "blocked");
      if (blockedChecks.length > 0) {
        const first = blockedChecks[0]!;
        stopReason = `blocked: ${first.reason}${first.remedy ? ` Next step: ${first.remedy}` : ""}`;
        addNote(stopReason);
        break;
      }

      let launched = false;
      const instrumentationBlockers: LoopPreflightCheck[] = [];
      const noteInstrumentationBlockers = (plan: MetricPlan | null, reason?: string): void => {
        for (const blocker of qualificationBlockers(plan, reason)) {
          if (!instrumentationBlockers.some((existing) => existing.name === blocker.name && existing.reason === blocker.reason)) instrumentationBlockers.push(blocker);
        }
      };
      for (const lever of ordered) {
        if (rejectedThisRun.has(lever.id)) continue;
        if (Date.now() >= deadlineAt) { stopReason = "deadline"; break; }
        let plan: MetricPlan | null = null;
        /** Contract-declared evaluator files the campaign must hash into its identity. */
        let campaignIdentityInputs: string[] | undefined;
        let qualificationFingerprint: string | undefined;
        let setup: LeverCampaignSetup | { reject: string };
        if (options.taskProvider) {
          setup = options.taskProvider({ lever, plan: null, projectDir, loopRoot });
        } else {
          if (lever.metricKind === "unmeasurable") { rejectLever(lever, `lever ${lever.id} (${lever.sourceKind}) has no measurable metric kind`); continue; }
          if (lever.scopeFiles.length === 0) { rejectLever(lever, `lever ${lever.id} (${lever.sourceKind}) has no known patch scope yet; scope discovery must run before a campaign`); continue; }
          if (!approved) { rejectLever(lever, "a trusted run contract is required before a metric can be qualified"); continue; }
          const effectiveKind = lever.metricKind;
          const declaredScore = approved.contract.outcome.evaluator;
          // A score lever measures the contract's declared evaluator, never a
          // synthesized duration or failure count.
          const scoreEvaluator = effectiveKind === "score" && declaredScore ? {
            argv: [...declaredScore.argv],
            output: declaredScore.output,
            ...(declaredScore.inputs ? { inputs: [...declaredScore.inputs] } : {}),
            unit: approved.contract.outcome.unit,
            higherIsBetter: approved.contract.outcome.higherIsBetter,
          } : null;
          // The declared evaluator runs from its project paths, outside the campaign's
          // trusted verifier subtree. Hashing its files into the campaign identity makes
          // editing them abort the campaign instead of silently redefining the score.
          campaignIdentityInputs = scoreEvaluator && declaredScore?.inputs?.length
            ? declaredScore.inputs.map((input) => path.resolve(projectDir, input))
            : undefined;
          try {
          qualificationFingerprint = projectFingerprint(projectDir);
          setActivity("qualification", `Qualifying the measurement instrument for ${lever.id}`);
          plan = await synthesizeMetric({
            projectDir,
            loopRoot,
            lever,
            ...(lever.command ? { command: lever.command } : {}),
            ...(lever.command ? { expectedReadMs: recon?.probes.find((probe) => probe.label === recon?.commands.find((command) => command.source === lever.command!.source)?.label)?.durationMs ?? undefined } : {}),
            ...(scoreEvaluator ? { scoreEvaluator } : {}),
            ...(options.taskDefaults?.evaluator_timeout_ms !== undefined ? { evaluatorTimeoutMs: options.taskDefaults.evaluator_timeout_ms } : {}),
            qualification: {
              contract: approved.contract,
              workRoot: path.join(loopRoot, "qualification"),
              outcome: approved.contract.outcome.statement,
              minimumUsefulGain: approved.contract.outcome.minimumUsefulGain,
              editableScope: lever.scopeFiles,
              availableEvaluatorRuns: remainingAllowance(budget!).evaluatorRuns,
              ...(options.signal ? { signal: options.signal } : {}),
              deadlineAt,
              beforeEvaluatorRun: () => chargeOne("qualification", "evaluator"),
            },
          });
          } catch (error) {
            // Running out of budget is a stop condition, not a defect in the lever.
            if (error instanceof LoopBudgetExhaustedError) { stopReason = "budget"; addNote(`${error.message}; the run stops here rather than overspending.`); break; }
            throw error;
          }
          setup = defaultSetup({ lever, plan, projectDir, loopRoot, contract: approved?.contract ?? null }, options);
        }
        if ("reject" in setup) {
          rejectLever(lever, setup.reject);
          if (plan?.qualification && !plan.qualification.passed) noteInstrumentationBlockers(plan, setup.reject);
          else if (!options.taskProvider) noteInstrumentationBlockers(plan, setup.reject);
          continue;
        }
        if (plan?.evaluationContract) evaluatorId = plan.evaluationContract.id;

        // Capture the independently reusable baseline before calculating the campaign grant;
        // any fallback evaluator work here is charged before the campaign reservation is set.
        const instrument = plan ? await captureInstrument({
          plan,
          contract: approved.contract,
          gates: setup.gates ?? [],
          projectDir,
          workRoot: path.join(loopRoot, "post-apply"),
          beforeProcess: () => chargeOne("post-apply", "evaluator"),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.measureImpl ? { measureImpl: options.measureImpl } : {}),
        }) : null;
        if (plan && !instrument) {
          // Without an independent instrument this change could not be verified, so it
          // is not run: an unverifiable win would be recorded on faith.
          const reason = `lever ${lever.id} has no independently measurable instrument, so an applied change could not be verified`;
          rejectLever(lever, reason);
          noteInstrumentationBlockers(plan, reason);
          continue;
        }

        if (!agentProbed) {
          await probeAgentLiveness(setup.task);
          if (stopReason) break;
        }
        // The probe spent part of the wall-clock budget; a run that is out of time must
        // not start a campaign on the strength of a probe that finished too late.
        if (Date.now() >= deadlineAt) { stopReason = "deadline"; break; }

        const fresh = remainingAllowance(budget);
        const postApplyReserve = instrument ? instrument.gates.length + (instrument.kind === "command-duration" ? 3 : 1) : 0;
        if (fresh.campaigns <= 0 || fresh.agentStarts <= 0 || fresh.evaluatorRuns <= postApplyReserve) { stopReason = "budget"; break; }
        const grantedAgents = Math.min(campaignDefaults.maxAgentStarts, fresh.agentStarts);
        const grantedEvaluators = Math.min(campaignDefaults.maxEvaluatorRuns, fresh.evaluatorRuns - postApplyReserve);
        const campaignDeadlineMs = Math.max(1_000, Math.min(campaignDefaults.deadlineMs, CAMPAIGN_DEADLINE_MAX_MS, deadlineAt - Date.now()));
        const campaignStartedMs = Date.now();

        // Recorded before the campaign so the experiment names the baseline it started from.
        const baselineFingerprint = projectFingerprint(projectDir);
        // A qualified instrument in an approved contract run already paid for its baseline
        // readings: hand them to the campaign when the tree is still the approved one.
        const seedReadings = plan
          ? campaignSeedReadings({
            projectDir,
            qualificationFingerprint: qualificationFingerprint ?? approved.fingerprint,
            task: setup.task,
            verifierInputs: setup.verifierInputs,
            gates: setup.gates ?? [],
            ...(campaignIdentityInputs?.length ? { identityInputs: campaignIdentityInputs } : {}),
            evaluationContract: plan.evaluationContract,
          })
          : null;
        // The approved contract's outcome threshold binds every chained campaign unless
        // the caller supplied an explicit one.
        const chainedMinimumGain = options.minimumGain ?? approved.contract.outcome.minimumUsefulGain;

        const reserved: LoopReservation = {
          phase: "campaign", agent_starts: grantedAgents, evaluator_runs: grantedEvaluators, campaigns: 1, at: now().toISOString(),
        };
        if (plan && instrument) {
          writeJson(activeContextPath, {
            version: 1, contractId: contractId ?? contractIdentity(approved.contract), lever,
            setup, plan, instrument, baselineFingerprint,
          } satisfies LoopResumeContext);
        }
        budget = { ...budget, open_campaign: reserved };
        writeLoopBudget(budgetPath, budget);
        let result: CampaignResult;
        try {
          setActivity("campaign", `Starting bounded experiments for ${lever.id}`);
          result = await runCampaignImpl({
            baseRoot,
            projectDir,
            task: setup.task,
            evaluatorEnv: restrictedEnvironment(approved.contract), evaluatorEnvKeys: approved.contract.execution.envAllowlist,
            ...(setup.expectedReadMs !== undefined ? { expectedReadMs: setup.expectedReadMs } : {}),
            searchConfig: readSearchConfig(),
            goal: setup.goal ?? lever.goal,
            scope: setup.scope ?? [...lever.scopeFiles],
            mechanism: lever.mechanism,
            ...(lastCampaignId ? { parentCampaignId: lastCampaignId } : {}),
            verifierInputs: setup.verifierInputs,
            gates: setup.gates ?? [],
            allowFailingBaselineGates: true,
            ...(chainedMinimumGain !== undefined ? { minimumGain: chainedMinimumGain } : {}),
            ...(seedReadings ? { seedReadings } : {}),
            ...(campaignIdentityInputs?.length ? { identityInputs: campaignIdentityInputs } : {}),
            limits: { maxCycles: campaignDefaults.maxCycles, maxAgentStarts: grantedAgents, maxEvaluatorRuns: grantedEvaluators, deadlineMs: campaignDeadlineMs },
            // The run's rare-event allowance is shared across the campaigns it may confirm.
            confirmationAlpha: approved.contract.budgets.falseAcceptBudget / approved.contract.budgets.maxCampaigns,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.resolveAgent ? { resolveAgent: options.resolveAgent } : {}),
            onUpdate: (status) => {
              setActivity("campaign", `Campaign ${status.id}: ${status.state.kind}${status.state.kind === "running" ? ` / ${status.state.phase}` : ""}`, status.id, true);
              const saved = readJson<LoopResumeContext>(activeContextPath);
              if (saved && saved.version === 1) writeJson(activeContextPath, { ...saved, campaignId: status.id });
              if (budget?.open_campaign?.phase === "campaign") {
                budget = { ...budget, open_campaign: { ...budget.open_campaign, campaign_id: status.id } };
                writeLoopBudget(budgetPath, budget);
              }
              options.onCampaignUpdate?.(status);
            },
            ...(options.onPhaseProgress ? { onPhaseProgress: options.onPhaseProgress } : {}),
            onProgress: progress,
          });
        } catch (error) {
          if (error instanceof CampaignInfeasibleError) {
            // The campaign refused its own caps before creating a directory or running a
            // scorer. Charge nothing, record the screening outcome, and try the next lever.
            budget = settleReservation(budget, reserved, { agentStarts: 0, evaluatorRuns: 0, campaigns: 0 });
            writeLoopBudget(budgetPath, budget);
            fs.rmSync(activeContextPath, { force: true });
            addNote(`infeasible campaign for lever ${lever.id}: ${error.message}. Floors: evaluator runs ${error.floor.evaluatorRuns}, agent starts ${error.floor.agentStarts}, ${Math.ceil(error.floor.durationMs / 1000)} s evaluator time; recommended caps: maxEvaluatorRuns ${error.recommended.evaluatorRuns}, maxAgentStarts ${error.recommended.agentStarts}, max_deadline_minutes ${Math.ceil(error.recommended.deadlineMs / 60_000)}. No campaign evaluator or agent spend was charged.`);
            recordOutcome({ leverId: lever.id, outcome: "rejected", stopReason: `campaign infeasible: ${error.message}`.slice(0, 200), evaluatorRuns: 0, agentStarts: 0, wallMs: Date.now() - campaignStartedMs, at: now().toISOString() }, null);
            progress(`loop: campaign refused lever ${lever.id} as infeasible (${error.message}); no spend was charged and the next lever is screened`);
            rejectedThisRun.add(lever.id);
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          stopReason = classifyCampaignFailure(message);
          // A thrown campaign's real spend is unknown, so charge the reserved
          // grant; otherwise a crash loop could hand out the same allowance twice.
          // A thrown campaign's real spend is unknown, so charge the reserved
          // grant; otherwise a crash loop could hand out the same allowance twice.
          budget = settleReservation(budget, reserved, { agentStarts: grantedAgents, evaluatorRuns: grantedEvaluators });
          writeLoopBudget(budgetPath, budget);
          recordOutcome({ leverId: lever.id, outcome: "error", stopReason: `${stopReason} (spend reconciled at the granted campaign budget)`.slice(0, 200), evaluatorRuns: grantedEvaluators, agentStarts: grantedAgents, wallMs: Date.now() - campaignStartedMs, at: now().toISOString() }, null);
          launched = true;
          break;
        }

        budget = settleReservation(budget, reserved, { agentStarts: result.agentStarts, evaluatorRuns: result.evaluatorRuns });
        writeLoopBudget(budgetPath, budget);
        if (result.state.kind !== "paused" && result.state.kind !== "running") {
          const saved = readJson<LoopResumeContext>(activeContextPath);
          if (saved?.version === 1) writeJson(activeContextPath, { ...saved, campaignId: result.id, phase: "post-apply" } satisfies LoopResumeContext);
        }
        const applied = readLedger(path.join(result.campaignRoot, "history", "ledger.jsonl")).entries
          .some((entry) => entry.kind === "apply" && entry.outcome === "success");
        const cancelled = options.signal?.aborted === true || /stopped by request/i.test(result.stopReason);
        const failed = result.state?.kind === "failed";
        const paused = result.state?.kind === "paused" || result.state?.kind === "running";
        let outcome: LoopMemoryRecord["outcome"];
        if (applied) outcome = "win";
        else if (/preflight failed/i.test(result.stopReason)) outcome = "rejected";
        else if (cancelled) outcome = "error";
        else if (failed) outcome = "error";
        else outcome = "no-win";

        // An applied change is checked once more from outside the campaign: fresh copy,
        // declared correctness commands, and the same workload measured again against the
        // baseline recorded before any candidate ran. The campaign proved its own
        // instrument moved; this proves the resulting tree agrees with it.
        let verifiedGain: number | undefined;
        let postApplyFailure: string | null = null;
        if (applied) {
          if (!instrument) {
            postApplyFailure = "the applied change had no independent instrument to verify it against";
          }
        }
        if (applied && approved && instrument) {
          let postApply: Awaited<ReturnType<typeof verifyPostApply>>;
          try {
          setActivity("post-apply", "Independently verifying the applied change", result.id);
          postApply = await verifyPostApply({
            projectDir,
            contract: approved.contract,
            argv: instrument.argv,
            gates: instrument.gates,
            baseline: instrument.baseline,
            minimumUsefulGain: instrument.minimumUsefulGain,
            unit: instrument.unit,
            higherIsBetter: instrument.higherIsBetter,
            ...(instrument.kind !== "command-duration" ? {
              kind: instrument.kind,
              ...(instrument.evaluator ? { evaluator: instrument.evaluator } : {}),
            } : {}),
            workRoot: path.join(loopRoot, "post-apply"),
            timeoutMs: instrument.timeoutMs,
            beforeProcess: () => chargeOne("post-apply", "evaluator"),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.measureImpl ? { measureImpl: options.measureImpl } : {}),
          });
          } catch (error) {
            if (!(error instanceof LoopBudgetExhaustedError)) throw error;
            // The change is already on disk but cannot be checked: say so instead of
            // recording an unverified win or losing the event.
            postApplyFailure = `the durable budget could not fund verification of the applied change: ${error.message}`;
            verifications.push({ leverId: lever.id, campaignId: result.id, outcome, passed: false, reason: postApplyFailure, at: now().toISOString() });
            addNote(postApplyFailure);
            recordOutcome({
              leverId: lever.id, outcome: "no-win", stopReason: postApplyFailure.slice(0, 200),
              evaluatorRuns: result.evaluatorRuns, agentStarts: result.agentStarts,
              wallMs: Date.now() - campaignStartedMs, at: now().toISOString(),
              provenance: { ...(contractId ? { contractId } : {}), ...(evaluatorId ? { evaluatorId } : {}), baselineFingerprint: projectFingerprint(projectDir), strategyClass: lever.sourceKind },
            }, result.campaignRoot);
            stopReason = `post-apply check failed: ${postApplyFailure}`;
            launched = true;
            break;
          }
          verifications.push({
            leverId: lever.id,
            campaignId: result.id,
            outcome,
            passed: postApply.passed,
            reason: postApply.reason,
            at: now().toISOString(),
          });
          if (postApply.passed) {
            verifiedGain = postApply.gain ?? undefined;
            addNote(`post-apply check passed: ${postApply.detail}`);
          } else {
            postApplyFailure = postApply.reason ?? "the applied state did not reproduce the verified gain";
            addNote(`post-apply check failed: ${postApplyFailure}`);
          }
        }

        recordOutcome({
          leverId: lever.id,
          outcome: postApplyFailure ? "no-win" : outcome,
          stopReason: (postApplyFailure ?? result.stopReason).slice(0, 200),
          evaluatorRuns: result.evaluatorRuns,
          agentStarts: result.agentStarts,
          wallMs: Date.now() - campaignStartedMs,
          at: now().toISOString(),
          ...(verifiedGain === undefined ? {} : { verifiedGain }),
          provenance: {
            ...(contractId ? { contractId } : {}),
            ...(evaluatorId ? { evaluatorId } : {}),
            baselineFingerprint: baselineFingerprint ?? projectFingerprint(projectDir),
            mechanism: lever.mechanism.slice(0, 200),
            strategyClass: lever.sourceKind,
            ...(lastCampaignId ? { parentCampaign: lastCampaignId.slice(0, 200) } : {}),
          },
        }, result.campaignRoot);
        // Keep the frozen instrument and loop context while a paused campaign awaits
        // confirmation or an interrupted campaign needs a safe resume.
        if (!paused) fs.rmSync(activeContextPath, { force: true });
        if (!paused) try {
          const worlds: ExperimentWorld[] = [];
          const campaignsDir = path.join(baseRoot, "campaigns");
          for (const campaign of fs.readdirSync(campaignsDir, { withFileTypes: true })) {
            if (!campaign.isDirectory()) continue;
            const cyclesDir = path.join(campaignsDir, campaign.name, "cycles");
            if (!fs.existsSync(cyclesDir)) continue;
            for (const cycle of fs.readdirSync(cyclesDir, { withFileTypes: true })) {
              if (!cycle.isDirectory()) continue;
              try {
                const world = JSON.parse(fs.readFileSync(path.join(cyclesDir, cycle.name, "world.json"), "utf8")) as ExperimentWorld;
                if (world.status === "complete") worlds.push(world);
              } catch { /* An incomplete or unreadable world is not replay evidence. */ }
            }
          }
          const incumbent = readSearchConfig();
          setActivity("dream", "Comparing completed experiment worlds for the next search");
          const adopted = await maybeDream({
            projectDir, loopRoot, agent: setup.task.agent, resolveAgent: options.resolveAgent,
            signal: options.signal ?? new AbortController().signal, worlds, incumbent,
            beforeAgentSpawn: () => chargeOne("dream", "agent"),
          });
          if (JSON.stringify(adopted) !== JSON.stringify(incumbent)) addNote(`dream adopted search config ${JSON.stringify(adopted)}`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          addNote(`dream step skipped: ${reason.slice(0, 180)}`);
        }
        lastCampaignId = result.id;
        progress(`loop: campaign ${result.id} finished as ${postApplyFailure ? "no-win (post-apply check failed)" : outcome} (${(postApplyFailure ?? result.stopReason) || "no reason"})`);
        launched = true;
        if (outcome === "rejected") {
          addNote(`lever ${lever.id} rejected during preflight: ${result.stopReason}`);
          rejectedThisRun.add(lever.id);
        }
        // A terminal failure stops the loop, even when an earlier verified patch landed: the win is
        // recorded above, but a failing campaign must not be followed by another one. A lever-level
        // preflight rejection also arrives as a failed state; it is recorded as "rejected" above and
        // must not halt an unattended run that still has other levers to screen.
        if (failed && !cancelled && outcome !== "rejected") {
          stopReason = classifyCampaignFailure(result.stopReason);
        }
        if (cancelled) stopReason = "cancelled";
        // A promoted change that does not survive independent checking halts the run: the
        // tree no longer agrees with the measurement that promoted it, so continuing would
        // build later experiments on an unverified baseline.
        if (postApplyFailure) stopReason = `post-apply check failed: ${postApplyFailure}`;
        if (paused) stopReason = result.pendingConfirmation ? "confirmation pending" : "paused";
        break; // re-rank before the next campaign
      }
      if (stopReason) break;
      if (!launched) {
        const afterScreening = remainingAllowance(budget);
        if (afterScreening.campaigns <= 0 || afterScreening.agentStarts <= 0 || afterScreening.evaluatorRuns <= 0) {
          stopReason = "budget";
          break;
        }
        if (instrumentationBlockers.length > 0) {
          const blockedNames = new Set(instrumentationBlockers.map((check) => check.name));
          preflight = { status: "blocked", checks: [...preflight.checks.filter((check) => !blockedNames.has(check.name)), ...instrumentationBlockers] };
          stopReason = `blocked: ${instrumentationBlockers.map((check) => `${check.reason}${check.remedy ? ` Next step: ${check.remedy}` : ""}`).join(" ")}`;
          addNote(stopReason);
        } else stopReason = "no verifiable lever";
        break;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (leaseHeld) {
      // Charge this run's wall time durably so a resume inherits what is left.
      if (budget) {
        try {
          budget = { ...budget, wall_ms: (budget.wall_ms ?? 0) + Math.max(0, Date.now() - startedMs) };
          writeLoopBudget(budgetPath, budget);
        } catch { /* the run's outcome is already recorded; a failed write is reported by status */ }
      }
      // Only the current holder removes the file: a stale takeover by another loop must not be
      // undone by this process exiting later.
      releaseOwnedLease(leasePath, lease);
    }
  }

  const stopCode = classifyStop(stopReason);
  const reportPath = path.join(loopRoot, "latest-report.json");
  const spentPhases = budget?.phases ?? {};
  const evaluatorRunsByPhase = Object.fromEntries(Object.entries(spentPhases).map(([phase, spend]) => [
    phase, Math.max(0, (spend?.evaluator_runs ?? 0) - (runStartPhases[phase as LoopPhase]?.evaluator_runs ?? 0)),
  ])) as Partial<Record<LoopPhase, number>>;
  const totalEvaluatorRuns = budget ? budget.evaluator_runs - runStartEvaluatorRuns : records.reduce((sum, record) => sum + record.evaluatorRuns, 0);
  const preflightEvaluatorRuns = (evaluatorRunsByPhase.discovery ?? 0) + (evaluatorRunsByPhase.qualification ?? 0);
  const campaignEvaluatorRuns = evaluatorRunsByPhase.campaign ?? 0;
  const result: LoopResult = {
    stopCode, reportPath, preflight, stopReason,
    evaluatorRuns: totalEvaluatorRuns, preflightEvaluatorRuns, campaignEvaluatorRuns, evaluatorRunsByPhase,
    // A campaign that threw has no root but did start and spend; it must appear in the count.
    campaigns: records.filter((record) => record.campaignRoot !== null || record.outcome === "error").length,
    wins: records.filter((record) => record.outcome === "win").length,
    agentStarts: budget ? budget.agent_starts - runStartAgentStarts : records.reduce((sum, record) => sum + record.agentStarts, 0),
    memoryPath,
    budgetPath,
    memory,
    inventory,
    ranking,
    records,
    memento: mementoNotes(memory),
    contract: approved ? { fingerprint: approved.fingerprint, approvedAt: approved.approvedAt } : null,
    verifications,
  };
  try {
    writeJson(reportPath, { version: 1, at: now().toISOString(), stopCode, stopReason: stopReason.slice(0, 1000), preflight, campaigns: result.campaigns, wins: result.wins,
      evaluatorRuns: result.evaluatorRuns, preflightEvaluatorRuns, campaignEvaluatorRuns, agentStarts: result.agentStarts,
      evaluatorRunsByPhase,
      agentStartsByPhase: Object.fromEntries(Object.entries(spentPhases).map(([phase, spend]) => [phase, Math.max(0, (spend?.agent_starts ?? 0) - (runStartPhases[phase as LoopPhase]?.agent_starts ?? 0))])),
      verifications: verifications.map(({ campaignId, outcome, passed, at }) => ({ campaignId, outcome, passed, at })) });
  } catch (error) {
    memory.notes.push(`run report could not be saved: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
  }
  return result;
}
