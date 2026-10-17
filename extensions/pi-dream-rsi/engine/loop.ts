import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readCampaignStatus, runCampaign, type CampaignOptions, type CampaignResult } from "./campaign.ts";
import {
  ContractNotApprovedError, approveRunContract, contractFile, contractIdentity, projectFingerprint, readStoredContract,
  restrictedEnvironment, type ApprovedContract, type RunContract,
} from "./intake.ts";
import {
  applyPromotionDecision, decidePromotion, loadActiveGeneration, readGenerationState,
  type PromotionEvidence,
} from "./generation.ts";
import { readLedger } from "./ledger.ts";
import { buildReconInventory, reconProject, type ReconResult } from "./recon.ts";
import { measureWorkload, verifyPostApply } from "./verify.ts";
import {
  hasAllowance, readOrCreateLoopBudget, reconcileOpenReservation, remainingAllowance, settleReservation, writeLoopBudget,
  type LoopBudgetFile, type LoopReservation,
} from "./loop-budget.ts";
import { buildLeverInventory, type LeverInventory, type LeverMetricKind, type LeverProposal } from "./levers.ts";
import { synthesizeMetric, type MetricPlan } from "./metrics.ts";
import {
  attemptsFromMemory, isCurrentExperiment, MAX_NOTES, mementoNotes, plateauState, readMemory, recordCampaignOutcome,
  ucbSelect, writeMemory, type LeverRankingEntry, type LoopMemory, type LoopMemoryRecord, type PlateauState,
} from "./search.ts";
import { collectSignals, type SignalsResult } from "./signals.ts";
import { defaultTask, type TaskConfig } from "./task.ts";
import { writeFileAtomic } from "./world.ts";

/**
 * The unattended loop: one iteration = recon, ranked lever, synthesized or
 * supplied metric, one bounded campaign in the existing campaign engine, then
 * the outcome is recorded and the next iteration re-ranks. Every step fails
 * closed: budgets live in a durable loop file with immutable limits, spend is
 * reserved before a campaign starts and reconciled after it ends, a lever
 * without a truthful metric is recorded as rejected instead of explored, and
 * the loop stops on empty inventory, budget exhaustion, blocked state, or
 * plateau after the bounded restart allowance is used.
 */

/** A lease heartbeat older than this is stale; its owner is assumed gone. */
const LEASE_STALE_MS = 45 * 60 * 1000;
/** Bounded plateau restarts that re-explore a tried lever with an alternate metric. */
const DEFAULT_MAX_RESTARTS = 1;

export interface LoopLimits {
  /** Campaigns the loop may start in total, across runs (durable). */
  maxCampaigns: number;
  /** Agent process starts the loop may spend in total, across runs (durable). */
  maxAgentStarts: number;
  /** Evaluator process runs the loop may spend in total, across runs (durable). */
  maxEvaluatorRuns: number;
  /** Wall-clock budget for one run. */
  deadlineMs: number;
  /** Consecutive campaigns without a verified win before the plateau stop. */
  plateauK?: number;
  /** Plateau restarts that measure an alternate signal on the same lever (default 1). */
  maxRestarts?: number;
  /** Reserved optimizer-trial allowance, spent from the same durable budget. */
  maxOptimizerTrials?: number;
}

export interface LeverCampaignSetup {
  task: TaskConfig;
  verifierInputs: string[];
  gates?: string[];
  controlPatch?: string;
  goal?: string;
  scope?: string[];
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
  /**
   * The approved run contract. When supplied, the loop works only inside it and
   * uses cold-start discovery; when absent it keeps the legacy signal-driven path.
   */
  contract?: RunContract;
  /** Known-better control patch forwarded to metric synthesis. */
  controlPatchPath?: string;
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
  /** Agent resolver forwarded to each campaign (active session model and thinking level). */
  resolveAgent?: CampaignOptions["resolveAgent"];
  /** Live campaign status updates forwarded to the host UI. */
  onCampaignUpdate?: CampaignOptions["onUpdate"];
  /** Phase progress forwarded to the host UI dashboard. */
  onPhaseProgress?: CampaignOptions["onPhaseProgress"];
  /** Test seam replacing the campaign engine. */
  runCampaignImpl?: (options: CampaignOptions) => Promise<CampaignResult>;
  /** Test seam replacing the independent post-apply measurement. */
  measureImpl?: (argv: string[], projectDir: string) => Promise<number | null>;
  /**
   * Optimizer trial seam. Supplied by a harness that owns the sealed confirmation
   * split; the loop never fabricates the evidence a promotion depends on.
   */
  optimizerTrial?: (context: { projectDir: string; loopRoot: string; generation: string | null }) => Promise<{
    challengerId: string;
    evidence: PromotionEvidence;
  } | { retain: string }>;
  /** Test seam replacing signal collection. */
  collectSignalsImpl?: (options: { projectDir: string; focus?: string; includeLogs?: boolean; sessionDir?: string }) => Promise<Pick<SignalsResult, "weaknesses" | "diagnostics">>;
}

export interface LoopCampaignRecord extends LoopMemoryRecord {
  campaignRoot: string | null;
}

export interface LoopResult {
  stopReason: string;
  /** Campaigns actually started by this run (including rejected preflights). */
  campaigns: number;
  wins: number;
  evaluatorRuns: number;
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
  /** Optimizer generation this run used, or null for the installed code. */
  generation: string | null;
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


/** The generation a fresh process would load, for reporting. A corrupt ledger is not fatal here. */
function activeGenerationLabel(loopRoot: string): string | null {
  try { return loadActiveGeneration(loopRoot)?.id ?? readGenerationState(loopRoot).active; }
  catch { return null; }
}

/** The alternate signal a plateau restart measures on the same lever evidence. */
function alternateMetricKind(lever: LeverProposal): LeverMetricKind | null {
  switch (lever.metricKind) {
    case "command-success": return "command-duration";
    case "command-duration": return "command-success";
    case "suite-failures": return "command-duration";
    default: return null;
  }
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
}

/**
 * Capture the pre-campaign baseline for one approved run.
 *
 * A qualified instrument already recorded its readings. Otherwise (a supplied
 * control patch, or a task provider) the baseline is measured now with the same
 * procedure the post-apply check repeats, so every promoted change can be
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
    };
  }
  if (options.plan.argv.length === 0) return null;
  const readings: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const reading = options.measureImpl
      ? await options.measureImpl(options.plan.argv, options.projectDir)
      : await measureWorkload({
        argv: options.plan.argv,
        cwd: options.projectDir,
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
  };
}

/** Wall time already spent by earlier runs under this project's contract. */
function readConsumedWallMs(loopRoot: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(loopRoot, "budget.json"), "utf8")) as { wall_ms?: unknown };
    return typeof parsed.wall_ms === "number" && Number.isSafeInteger(parsed.wall_ms) && parsed.wall_ms >= 0 ? parsed.wall_ms : 0;
  } catch { return 0; }
}

/** The contract's durable budgets, or null when this run has no approved contract. */
function approvedContract(contract: RunContract | undefined): RunContract["budgets"] | null {
  return contract ? contract.budgets : null;
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

/** Prefer the plateaued lever, then the highest-ranked lever; skip screened-out and solved levers. */
function pickRestartLever(
  inventory: LeverInventory,
  plateau: PlateauState,
  memory: LoopMemory,
  rejectedThisRun: Set<string>,
): LeverProposal | null {
  const order: LeverProposal[] = [];
  const consider = (lever: LeverProposal | undefined): void => {
    if (lever && !order.some((entry) => entry.id === lever.id)) order.push(lever);
  };
  if (plateau.leverId) consider(inventory.levers.find((lever) => lever.id === plateau.leverId));
  for (const lever of inventory.levers) consider(lever);
  for (const lever of order) {
    if (rejectedThisRun.has(lever.id)) continue;
    const stats = memory.leverStats[lever.id];
    if (!stats || stats.campaigns === 0 || stats.lastOutcome === "win") continue;
    if (alternateMetricKind(lever) === null) continue;
    return lever;
  }
  return null;
}

interface LoopLease { pid: number; host: string | null; startedAt: string; heartbeatAt: string; }

/** Read a lease; an unreadable lease proves nothing on its own. */
function readLease(file: string): LoopLease | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LoopLease> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt))) return null;
    if (typeof parsed.heartbeatAt !== "string" || !Number.isFinite(Date.parse(parsed.heartbeatAt))) return null;
    if (parsed.host !== undefined && typeof parsed.host !== "string") return null;
    return { pid: parsed.pid, host: parsed.host ?? null, startedAt: parsed.startedAt, heartbeatAt: parsed.heartbeatAt };
  } catch { return null; }
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

/** Default setup: synthesize the evaluator, then point a repo-root task at it. */
function defaultSetup(context: LeverSetupContext, options: LoopOptions): LeverCampaignSetup | { reject: string } {
  const { lever, plan, projectDir } = context;
  if (lever.scopeFiles.length === 0) return { reject: `lever ${lever.id} (${lever.sourceKind}) has no known patch scope yet; scope discovery must run before a campaign` };
  if (!plan) return { reject: `lever ${lever.id} has no metric plan` };
  if (!plan.ready) return { reject: `lever ${lever.id} metric is not ready: ${plan.rejections.join("; ")}` };
  const evaluatorAbsolute = path.resolve(projectDir, plan.evaluatorPath);
  const base = defaultTask(lever.id);
  const task: TaskConfig = {
    ...base,
    ...options.taskDefaults,
    workspace: ".",
    eval_program: lever.scopeFiles[0],
    score_program: `node "${evaluatorAbsolute}"`,
    score_path: plan.scorePath,
    higher_is_better: plan.higherIsBetter,
    problem_file: options.taskDefaults?.problem_file ?? null,
    copy_exclude: [],
    // The approved contract names the candidate agent; the task default (`pi`) is
    // only a fallback when no contract was approved.
    agent: context.contract?.agent ?? options.taskDefaults?.agent ?? base.agent,
  };
  return {
    task,
    verifierInputs: [evaluatorAbsolute],
    // The contract's preserved gates are as binding as the instrument's own.
    gates: [...new Set([...(context.contract?.preserved.gates ?? []), ...plan.gates])],
    ...(plan.controlPatchPath ? { controlPatch: plan.controlPatchPath } : {}),
    goal: lever.goal,
    scope: [...lever.scopeFiles],
  };
}

/**
 * Run the unattended loop until a stop rule fires. Returns a full record of
 * the run: stop reason, per-campaign outcomes, durable memory and budget paths,
 * and a bounded Memento digest for the next run.
 */
export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const limits = options.limits;
  const plateauK = Math.max(1, Math.round(limits.plateauK ?? 3));
  const maxRestarts = limits.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  if (!Number.isSafeInteger(maxRestarts) || maxRestarts < 0) throw new Error("loop limit maxRestarts must be a non-negative integer");

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
  const consumedWallMs = options.contract ? (readStoredContract(loopRoot) ? readConsumedWallMs(loopRoot) : 0) : 0;
  const remainingWallMs = Math.max(0, limits.deadlineMs - consumedWallMs);
  const deadlineAt = startedMs + (options.contract ? remainingWallMs : limits.deadlineMs);
  const budgetPath = path.join(loopRoot, "budget.json");
  const memoryPath = path.join(loopRoot, "memory.json");
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
  let approved: ApprovedContract | null = null;
  let recon: ReconResult | null = null;
  const rejectedThisRun = new Set<string>();
  const progress = options.onProgress ?? (() => {});
  const collectSignalsImpl = options.collectSignalsImpl ?? ((input: { projectDir: string; focus?: string; includeLogs?: boolean; sessionDir?: string }) => collectSignals({ ...input, now: now() }));
  const runCampaignImpl = options.runCampaignImpl ?? runCampaign;
  const campaignDefaults = {
    maxCycles: 2,
    maxAgentStarts: 18,
    maxEvaluatorRuns: 48,
    deadlineMs: 30 * 60 * 1000,
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
  const lease: LoopLease = { pid: process.pid, host: os.hostname(), startedAt: leaseStartedAt, heartbeatAt: leaseStartedAt };
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
  const touchLease = (): void => {
    if (!leaseHeld) return;
    writeFileAtomic(leasePath, `${JSON.stringify({ ...lease, heartbeatAt: now().toISOString() }, null, 2)}\n`, true);
  };
  let budget: LoopBudgetFile | null = null;
  // The optimizer-trial allowance comes from the caller or, when the caller defers,
  // from the contract the run is approved under. Both are durable once the budget exists.
  // The approved contract is an upper bound on durable spend, not a suggestion. A
  // caller asking for more than the contract approved gets the contract's figure; a
  // caller asking for less gets less. Nothing may widen its own allowance.
  const approvedBudgets = approvedContract(options.contract);
  const optimizerTrialCeiling = Math.min(
    limits.maxOptimizerTrials ?? Number.MAX_SAFE_INTEGER,
    approvedBudgets?.optimizerTrials ?? Number.MAX_SAFE_INTEGER,
  );
  const durableLimits = {
    maxCampaigns: Math.min(limits.maxCampaigns, approvedBudgets?.maxCampaigns ?? limits.maxCampaigns),
    maxAgentStarts: Math.min(limits.maxAgentStarts, approvedBudgets?.maxAgentStarts ?? limits.maxAgentStarts),
    maxEvaluatorRuns: Math.min(limits.maxEvaluatorRuns, approvedBudgets?.maxEvaluatorRuns ?? limits.maxEvaluatorRuns),
    deadlineMs: Math.min(limits.deadlineMs, approvedBudgets?.deadlineMs ?? limits.deadlineMs),
  };
  if (optimizerTrialCeiling !== Number.MAX_SAFE_INTEGER && optimizerTrialCeiling < 0) {
    throw new Error("loop limit maxOptimizerTrials must be a non-negative integer");
  }

  try {
    if (leaseHeld) {
      budget = readOrCreateLoopBudget(budgetPath, {
        maxCampaigns: durableLimits.maxCampaigns,
        maxAgentStarts: durableLimits.maxAgentStarts,
        maxEvaluatorRuns: durableLimits.maxEvaluatorRuns,
        deadlineMs: durableLimits.deadlineMs,
        maxRestarts,
        maxOptimizerTrials: optimizerTrialCeiling === Number.MAX_SAFE_INTEGER ? 0 : optimizerTrialCeiling,
      });
      // Crash-safe accounting: a leftover reservation means the previous process
      // died mid-phase, so charge the granted budget before spending more.
      const recovered = reconcileOpenReservation(budget);
      if (recovered) {
        budget = recovered.budget;
        writeLoopBudget(budgetPath, budget);
        const open = recovered.charged;
        addNote(`reconciled an interrupted ${open.phase} phase as spent at its granted budget (agent starts ${open.agent_starts}, evaluator runs ${open.evaluator_runs}, campaigns ${open.campaigns}); the reservation was written ${open.at}.`);
      }
    }
    // The approved contract is honoured before any discovery or probe: without
    // trusted-local consent nothing runs on this host.
    if (leaseHeld && options.contract) {
      try {
        approved = approveRunContract(projectDir, options.contract);
        const stored = readStoredContract(loopRoot);
        // Compare identity, not wording: the same sentence with wider scope, different
        // gates or a larger allowance would silently replace the approved boundary.
        if (stored && contractIdentity(stored.contract) !== contractIdentity(approved.contract)) {
          throw new ContractNotApprovedError(
            `a different run contract is already stored for this project ("${stored.contract.outcome.statement}"); approve that objective and boundary, or move ${contractFile(loopRoot)} aside deliberately`,
          );
        }
        writeFileAtomic(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...approved, contract: approved.contract }, null, 2)}\n`, true);
        contractId = contractIdentity(approved.contract);
        void restrictedEnvironment(approved.contract);
      } catch (error) {
        if (!(error instanceof ContractNotApprovedError)) throw error;
        noteLocally(`not-approved: ${error.reason}`);
        stopReason = "not-approved";
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
      if (remainingCampaigns <= 0 || remainingAgents <= 0 || remainingEvaluators <= 0) { stopReason = "budget"; break; }

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

      let evidenceCount = 0;
      if (approved) {
        // Cold start: measure the project's own declared workloads and attribute the
        // measurement to the code it imports. No session history is required.
        recon = await reconProject({
          projectDir,
          contract: approved.contract,
          maxProbes: options.reconProbes ?? 3,
          ...(options.signal ? { signal: options.signal } : {}),
          // Charge one evaluator run before the probe starts. `beforeProbe` runs
          // immediately before the process spawns, so the spend is durable first.
          beforeProbe: () => {
            const grant: LoopReservation = { phase: "discovery", agent_starts: 0, evaluator_runs: 1, campaigns: 0, at: now().toISOString() };
            if (!hasAllowance(budget!, { evaluatorRuns: 1 })) {
              throw new LoopBudgetExhaustedError("discovery probe");
            }
            budget = settleReservation(budget!, grant, { agentStarts: 0, evaluatorRuns: 1, campaigns: 0 });
            writeLoopBudget(budgetPath, budget);
          },
          onProgress: progress,
        });
        inventory = buildReconInventory({ contract: approved.contract, recon, attempts: attemptsFromMemory(memory) });
        evidenceCount = recon.probes.length;
        for (const blocker of recon.blockers) addNote(`recon blocker: ${blocker}`);
      } else {
        const signals = await collectSignalsImpl({
          projectDir,
          ...(options.focus ? { focus: options.focus } : {}),
          ...(options.includeLogs !== undefined ? { includeLogs: options.includeLogs } : {}),
          ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
        });
        inventory = buildLeverInventory({ weaknesses: signals.weaknesses, attempts: attemptsFromMemory(memory) });
        evidenceCount = signals.weaknesses.length;
      }
      // Experiments measured under another objective or another instrument are not
      // comparable; they stay in the durable history but do not steer this run.
      const comparable = comparableMemory(memory, { contractId, evaluatorId });
      const selection = ucbSelect(inventory.levers, comparable, { strategy: approved ? "utility" : "win-rate" });
      ranking = selection.ranking;
      progress(`loop: ${inventory.levers.length} lever(s) ranked from ${evidenceCount} measured or recorded signal(s); top candidate ${selection.selected?.id ?? "none"}`);

      const plateau = plateauState(comparable, plateauK);
      const allTried = inventory.levers.length > 0 && inventory.levers.every((lever) => (memory.leverStats[lever.id]?.campaigns ?? 0) > 0);
      let restart: { leverId: string; metricKind: LeverMetricKind } | null = null;
      if (plateau.plateaued && allTried) {
        // Memento-style restart: before the plateau stop, spend one bounded
        // restart on a different signal, because re-running the same metric is a
        // repeat of the same evaluation rather than new exploration.
        const restartCandidate = budget.restarts < maxRestarts && !options.taskProvider
          ? pickRestartLever(inventory, plateau, comparable, rejectedThisRun)
          : null;
        const restartMetric = restartCandidate ? alternateMetricKind(restartCandidate) : null;
        if (restartCandidate && restartMetric) {
          restart = { leverId: restartCandidate.id, metricKind: restartMetric };
          budget = { ...budget, restarts: budget.restarts + 1 };
          writeLoopBudget(budgetPath, budget);
          addNote(`plateau restart ${budget.restarts}/${maxRestarts}: re-exploring lever ${restartCandidate.id} through the alternate ${restartMetric} metric instead of stopping.`);
          progress(`loop: plateau restart ${budget.restarts}/${maxRestarts} on lever ${restartCandidate.id} (${restartCandidate.metricKind} -> ${restartMetric})`);
        }
        if (!restart) {
          // Before stopping, spend at most one reserved optimizer trial. The loop does
          // not run the trial itself: a harness that owns the sealed split supplies the
          // evidence, and the decision is recorded either way.
          const optimizerCeiling = budget.max_optimizer_trials ?? 0;
          if (approved && optimizerCeiling > 0
            && (budget.optimizer_trials ?? 0) < optimizerCeiling && options.optimizerTrial) {
            try {
              const trial = await options.optimizerTrial({ projectDir, loopRoot, generation: loadActiveGeneration(loopRoot)?.id ?? null });
              if ("retain" in trial) {
                addNote(`optimizer trial: champion retained (${trial.retain}).`);
              } else {
                const decision = decidePromotion(trial.evidence);
                budget = { ...budget, optimizer_trials: (budget.optimizer_trials ?? 0) + 1 };
                writeLoopBudget(budgetPath, budget);
                if (decision.outcome === "promote") {
                  // The ledger's own ceiling is the authority; the caller may only lower it.
                  applyPromotionDecision(loopRoot, trial.challengerId, decision);
                  addNote(`optimizer trial promoted ${trial.challengerId}: ${decision.reason}. It activates in the next process, not this one.`);
                } else {
                  addNote(`optimizer trial ${decision.outcome} for ${trial.challengerId}: ${decision.reason}`);
                }
              }
            } catch (error) {
              addNote(`optimizer trial did not complete: ${error instanceof Error ? error.message : String(error)}. The champion is retained.`);
            }
          } else if (approved && optimizerCeiling > 0 && (budget.optimizer_trials ?? 0) >= optimizerCeiling) {
            addNote("optimizer trial not run: the reserved optimizer allowance is spent. The champion is retained.");
          } else if (approved) {
            addNote("optimizer trial not run: no sealed confirmation harness is configured, so no challenger can be scored. The champion is retained.");
          }
          addNote(`plateau: ${plateau.consecutiveNoWin} consecutive campaign(s) without a verified win across all known levers; the loop stops here because a plain re-run repeats the same evaluation. Change the target or budget before restarting.`);
          stopReason = "plateau";
          break;
        }
      }

      const restartLever = restart ? inventory.levers.find((lever) => lever.id === restart.leverId) ?? null : null;
      const ordered: LeverProposal[] = [];
      for (const lever of [restartLever, selection.selected, ...inventory.levers]) {
        if (lever && !ordered.some((entry) => entry.id === lever.id)) ordered.push(lever);
      }
      if (ordered.length === 0) {
        // With an approved contract, recon already ran and named its blockers; the
        // honest reason is that nothing verifiable was found, not that no evidence exists.
        stopReason = approved ? "no verifiable lever" : "empty inventory";
        break;
      }

      let launched = false;
      for (const lever of ordered) {
        if (rejectedThisRun.has(lever.id)) continue;
        if (Date.now() >= deadlineAt) { stopReason = "deadline"; break; }
        let plan: MetricPlan | null = null;
        let setup: LeverCampaignSetup | { reject: string };
        const metricOverride = restart && restart.leverId === lever.id ? { metricKind: restart.metricKind } : null;
        if (options.taskProvider) {
          setup = options.taskProvider({ lever, plan: null, projectDir, loopRoot });
        } else {
          if (lever.metricKind === "unmeasurable") { rejectLever(lever, `lever ${lever.id} (${lever.sourceKind}) has no measurable metric kind`); continue; }
          if (lever.scopeFiles.length === 0) { rejectLever(lever, `lever ${lever.id} (${lever.sourceKind}) has no known patch scope yet; scope discovery must run before a campaign`); continue; }
          try {
          plan = await synthesizeMetric({
            projectDir,
            loopRoot,
            lever,
            ...(lever.command ? { command: lever.command } : {}),
            ...(options.controlPatchPath ? { controlPatchPath: options.controlPatchPath } : {}),
            ...(metricOverride ? { metricOverride } : {}),
            ...(approved && !options.controlPatchPath ? {
              qualification: {
                contract: approved.contract,
                workRoot: path.join(loopRoot, "qualification"),
                outcome: approved.contract.outcome.statement,
                minimumUsefulGain: approved.contract.outcome.minimumUsefulGain,
                ...(options.signal ? { signal: options.signal } : {}),
                beforeEvaluatorRun: () => {
                  const grant: LoopReservation = { phase: "qualification", agent_starts: 0, evaluator_runs: 1, campaigns: 0, at: now().toISOString() };
                  if (!hasAllowance(budget!, { evaluatorRuns: 1 })) {
                    throw new LoopBudgetExhaustedError("instrument qualification");
                  }
                  budget = settleReservation(budget!, grant, { agentStarts: 0, evaluatorRuns: 1, campaigns: 0 });
                  writeLoopBudget(budgetPath, budget);
                },
              },
            } : {}),
          });
          } catch (error) {
            // Running out of budget is a stop condition, not a defect in the lever.
            if (error instanceof LoopBudgetExhaustedError) { stopReason = "budget"; addNote(`${error.message}; the run stops here rather than overspending.`); break; }
            throw error;
          }
          setup = defaultSetup({ lever, plan, projectDir, loopRoot, contract: approved?.contract ?? null }, options);
        }
        if ("reject" in setup) { rejectLever(lever, setup.reject); continue; }
        if (plan?.evaluationContract) evaluatorId = plan.evaluationContract.id;

        // Re-read the allowance: discovery and instrument qualification in this same
        // iteration already spent evaluator runs, so the loop-top figures are stale.
        // Granting from them would let a campaign push the durable cap past its limit.
        const fresh = remainingAllowance(budget);
        if (fresh.campaigns <= 0 || fresh.agentStarts <= 0 || fresh.evaluatorRuns <= 0) { stopReason = "budget"; break; }
        const grantedAgents = Math.min(campaignDefaults.maxAgentStarts, fresh.agentStarts);
        const grantedEvaluators = Math.min(campaignDefaults.maxEvaluatorRuns, fresh.evaluatorRuns);
        const campaignDeadlineMs = Math.max(1_000, Math.min(campaignDefaults.deadlineMs, deadlineAt - Date.now()));
        const campaignStartedMs = Date.now();
        // Reserve the grant durably before the campaign runs: if this process dies
        // mid-campaign, the next run charges the reservation instead of losing it.
        // Independent verification needs a baseline recorded BEFORE any candidate runs.
        // A qualified instrument already carries one; a supplied control patch does not,
        // so measure it here with the same procedure the post-apply check repeats.
        const instrument = approved && plan ? await captureInstrument({
          plan,
          contract: approved.contract,
          gates: setup.gates ?? [],
          projectDir,
          workRoot: path.join(loopRoot, "post-apply"),
          beforeProcess: () => {
            const grant: LoopReservation = { phase: "post-apply", agent_starts: 0, evaluator_runs: 1, campaigns: 0, at: now().toISOString() };
            if (!hasAllowance(budget!, { evaluatorRuns: 1 })) throw new LoopBudgetExhaustedError("pre-campaign baseline");
            budget = settleReservation(budget!, grant, { agentStarts: 0, evaluatorRuns: 1, campaigns: 0 });
            writeLoopBudget(budgetPath, budget);
          },
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.measureImpl ? { measureImpl: options.measureImpl } : {}),
        }) : null;
        if (approved && plan && !instrument) {
          // Without an independent instrument this change could not be verified, so it
          // is not run: an unverifiable win would be recorded on faith.
          rejectLever(lever, `lever ${lever.id} has no independently measurable instrument, so an applied change could not be verified`);
          continue;
        }

        // Recorded before the campaign so the experiment names the baseline it started from.
        const baselineFingerprint = projectFingerprint(projectDir);

        const reserved: LoopReservation = {
          phase: "campaign", agent_starts: grantedAgents, evaluator_runs: grantedEvaluators, campaigns: 1, at: now().toISOString(),
        };
        budget = { ...budget, open_campaign: reserved };
        writeLoopBudget(budgetPath, budget);
        let result: CampaignResult;
        try {
          result = await runCampaignImpl({
            baseRoot,
            projectDir,
            task: setup.task,
            goal: setup.goal ?? lever.goal,
            scope: setup.scope ?? [...lever.scopeFiles],
            verifierInputs: setup.verifierInputs,
            gates: setup.gates ?? [],
            ...(options.minimumGain !== undefined ? { minimumGain: options.minimumGain } : {}),
            ...(setup.controlPatch ? { controlPatch: setup.controlPatch } : {}),
            limits: { maxCycles: campaignDefaults.maxCycles, maxAgentStarts: grantedAgents, maxEvaluatorRuns: grantedEvaluators, deadlineMs: campaignDeadlineMs },
            // The run's rare-event allowance is shared across the campaigns it may confirm.
            ...(approved ? { confirmationAlpha: approved.contract.budgets.falseAcceptBudget / approved.contract.budgets.maxCampaigns } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.resolveAgent ? { resolveAgent: options.resolveAgent } : {}),
            ...(options.onCampaignUpdate ? { onUpdate: options.onCampaignUpdate } : {}),
            ...(options.onPhaseProgress ? { onPhaseProgress: options.onPhaseProgress } : {}),
            onProgress: progress,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stopReason = `campaign failed: ${message}`;
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

        const applied = readLedger(path.join(result.campaignRoot, "history", "ledger.jsonl")).entries
          .some((entry) => entry.kind === "apply" && entry.outcome === "success");
        const cancelled = options.signal?.aborted === true || /stopped by request/i.test(result.stopReason);
        const failed = result.state?.kind === "failed";
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
        if (applied && approved) {
          if (!instrument) {
            postApplyFailure = "the applied change had no independent instrument to verify it against";
          }
        }
        if (applied && approved && instrument) {
          let postApply: Awaited<ReturnType<typeof verifyPostApply>>;
          try {
          postApply = await verifyPostApply({
            projectDir,
            contract: approved.contract,
            argv: instrument.argv,
            gates: instrument.gates,
            baseline: instrument.baseline,
            minimumUsefulGain: instrument.minimumUsefulGain,
            unit: instrument.unit,
            higherIsBetter: instrument.higherIsBetter,
            workRoot: path.join(loopRoot, "post-apply"),
            timeoutMs: instrument.timeoutMs,
            beforeProcess: () => {
              const grant: LoopReservation = { phase: "post-apply", agent_starts: 0, evaluator_runs: 1, campaigns: 0, at: now().toISOString() };
              if (!hasAllowance(budget!, { evaluatorRuns: 1 })) {
                throw new LoopBudgetExhaustedError("post-apply verification");
              }
              budget = settleReservation(budget!, grant, { agentStarts: 0, evaluatorRuns: 1, campaigns: 0 });
              writeLoopBudget(budgetPath, budget);
            },
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
              provenance: { ...(contractId ? { contractId } : {}), ...(evaluatorId ? { evaluatorId } : {}), baselineFingerprint: projectFingerprint(projectDir) },
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
            ...(lastCampaignId ? { parentCampaign: lastCampaignId.slice(0, 200) } : {}),
          },
        }, result.campaignRoot);
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
        if (failed && !cancelled && outcome !== "rejected") stopReason = `campaign failed: ${result.stopReason}`;
        if (cancelled) stopReason = "cancelled";
        // A promoted change that does not survive independent checking halts the run: the
        // tree no longer agrees with the measurement that promoted it, so continuing would
        // build later experiments on an unverified baseline.
        if (postApplyFailure) stopReason = `post-apply check failed: ${postApplyFailure}`;
        break; // re-rank before the next campaign
      }
      if (stopReason) break;
      if (!launched) {
        stopReason = inventory.levers.length === 0 && !approved ? "empty inventory" : "no verifiable lever";
        break;
      }
    }
  } finally {
    if (leaseHeld) {
      // Charge this run's wall time durably so a resume inherits what is left.
      if (budget && options.contract) {
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

  return {
    stopReason,
    // A campaign that threw has no root but did start and spend; it must appear in the count.
    campaigns: records.filter((record) => record.campaignRoot !== null || record.outcome === "error").length,
    wins: records.filter((record) => record.outcome === "win").length,
    evaluatorRuns: records.reduce((sum, record) => sum + record.evaluatorRuns, 0),
    agentStarts: records.reduce((sum, record) => sum + record.agentStarts, 0),
    memoryPath,
    budgetPath,
    memory,
    inventory,
    ranking,
    records,
    memento: mementoNotes(memory),
    contract: approved ? { fingerprint: approved.fingerprint, approvedAt: approved.approvedAt } : null,
    verifications,
    generation: approved ? activeGenerationLabel(loopRoot) : null,
  };
}
