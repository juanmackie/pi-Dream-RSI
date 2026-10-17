/**
 * Durable accounting for one autonomous run.
 *
 * Every phase that can start a process — discovery probes, evaluator authoring,
 * instrument qualification, campaign candidates, review, post-apply checks and
 * optimizer trials — spends from the same parent allowance. A grant is written
 * before the child is dispatched, and a reservation left behind by a dead
 * process is charged on the next run instead of being handed out twice.
 *
 * The file format stays compatible with the version-1 loop budget: the original
 * counters keep their meaning, and the phase counters are additional.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileAtomic } from "./world.ts";

/** Phases that consume the run allowance. */
export const LOOP_PHASES = ["discovery", "metric-author", "qualification", "campaign", "post-apply", "optimizer"] as const;
export type LoopPhase = (typeof LOOP_PHASES)[number];

export interface LoopBudgetLimits {
  maxCampaigns: number;
  maxAgentStarts: number;
  maxEvaluatorRuns: number;
  deadlineMs: number;
  /** Plateau restarts that re-explore a lever through another signal. */
  maxRestarts?: number;
  /** Reserved sub-allowance for optimizer (self-improvement) trials. */
  maxOptimizerTrials?: number;
}

/** One dispatch grant, written before the child runs. */
export interface LoopReservation {
  phase: LoopPhase;
  agent_starts: number;
  evaluator_runs: number;
  /** Campaigns this reservation may start; absent in legacy reservations, which cost one. */
  campaigns?: number;
  at: string;
}

export interface LoopPhaseSpend {
  agent_starts: number;
  evaluator_runs: number;
  campaigns: number;
}

export interface LoopBudgetFile {
  version: 1;
  max_campaigns: number;
  max_agent_starts: number;
  max_evaluator_runs: number;
  max_restarts: number;
  campaigns: number;
  agent_starts: number;
  evaluator_runs: number;
  restarts: number;
  open_campaign: LoopReservation | null;
  /** Added with phase accounting; absent in a legacy budget file. */
  max_optimizer_trials?: number;
  optimizer_trials?: number;
  /** Accumulated wall time of finished runs; absent in a legacy budget file. */
  wall_ms?: number;
  /** Per-phase spend, for reporting and for reconciling optimizer allowances. */
  phases?: Partial<Record<LoopPhase, LoopPhaseSpend>>;
}

const DEFAULT_MAX_RESTARTS = 1;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`loop limit ${label} must be a positive integer`);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function compareLimits(value: Partial<LoopBudgetFile>, limits: LoopBudgetLimits, maxRestarts: number, maxOptimizerTrials: number): void {
  if (value.max_campaigns !== limits.maxCampaigns || value.max_agent_starts !== limits.maxAgentStarts
    || value.max_evaluator_runs !== limits.maxEvaluatorRuns
    || (value.max_restarts !== undefined && value.max_restarts !== maxRestarts)
    || (value.max_optimizer_trials !== undefined && value.max_optimizer_trials !== maxOptimizerTrials)) {
    throw new Error("loop budget limits are immutable once created; keep the same limits or move the loop state aside to start a fresh budget");
  }
}

function emptyPhases(): Partial<Record<LoopPhase, LoopPhaseSpend>> {
  return {};
}

/**
 * Read the durable budget, creating it on first use. Immutable limits, fail-closed
 * counters, and the same reservation semantics as the original loop budget.
 */
export function readOrCreateLoopBudget(file: string, limits: LoopBudgetLimits): LoopBudgetFile {
  assertPositiveInteger(limits.maxCampaigns, "maxCampaigns");
  assertPositiveInteger(limits.maxAgentStarts, "maxAgentStarts");
  assertPositiveInteger(limits.maxEvaluatorRuns, "maxEvaluatorRuns");
  assertPositiveInteger(limits.deadlineMs, "deadlineMs");
  const maxRestarts = limits.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  if (!Number.isSafeInteger(maxRestarts) || maxRestarts < 0) throw new Error("loop limit maxRestarts must be a non-negative integer");
  const maxOptimizerTrials = limits.maxOptimizerTrials ?? 0;
  if (!Number.isSafeInteger(maxOptimizerTrials) || maxOptimizerTrials < 0) throw new Error("loop limit maxOptimizerTrials must be a non-negative integer");

  if (!fs.existsSync(file)) {
    const created: LoopBudgetFile = {
      version: 1,
      max_campaigns: limits.maxCampaigns,
      max_agent_starts: limits.maxAgentStarts,
      max_evaluator_runs: limits.maxEvaluatorRuns,
      max_restarts: maxRestarts,
      campaigns: 0,
      agent_starts: 0,
      evaluator_runs: 0,
      restarts: 0,
      open_campaign: null,
      max_optimizer_trials: maxOptimizerTrials,
      optimizer_trials: 0,
      wall_ms: 0,
      phases: emptyPhases(),
    };
    writeLoopBudget(file, created);
    return created;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("loop budget file is unreadable; refusing to continue on corrupted state"); }
  const value = parsed as Partial<LoopBudgetFile> | null;
  const numbers = [value?.max_campaigns, value?.max_agent_starts, value?.max_evaluator_runs, value?.campaigns, value?.agent_starts, value?.evaluator_runs];
  const counters = [value?.campaigns, value?.agent_starts, value?.evaluator_runs];
  // Counters are spend: a negative or fractional value must never inflate the remaining allowance.
  if (!value || value.version !== 1
    || numbers.some((entry) => typeof entry !== "number" || !Number.isSafeInteger(entry))
    || counters.some((entry) => entry === undefined || entry < 0)) {
    throw new Error("loop budget file does not match the expected schema; refusing to continue on corrupted state");
  }
  compareLimits(value, limits, maxRestarts, maxOptimizerTrials);

  // A present-but-invalid counter is corruption, not legacy absence: an explicit
  // null must not hand the restart allowance back.
  const restarts = value.restarts === undefined ? 0 : value.restarts;
  if (typeof restarts !== "number" || !Number.isSafeInteger(restarts) || restarts < 0 || restarts > maxRestarts) {
    throw new Error("loop budget restart counter does not match the expected schema; refusing to continue on corrupted state");
  }
  const optimizerTrials = value.optimizer_trials === undefined ? 0 : value.optimizer_trials;
  if (!isCount(optimizerTrials) || optimizerTrials > maxOptimizerTrials) {
    throw new Error("loop budget optimizer-trial counter does not match the expected schema; refusing to continue on corrupted state");
  }
  const wallMs = value.wall_ms === undefined ? 0 : value.wall_ms;
  if (!isCount(wallMs)) throw new Error("loop budget wall-time counter does not match the expected schema; refusing to continue on corrupted state");

  const openCampaign = value.open_campaign ?? null;
  if (openCampaign !== null) {
    if (typeof openCampaign !== "object" || openCampaign === null
      || !isCount(openCampaign.agent_starts) || !isCount(openCampaign.evaluator_runs)
      || typeof openCampaign.at !== "string" || !Number.isFinite(Date.parse(openCampaign.at))
      || (openCampaign.campaigns !== undefined && !isCount(openCampaign.campaigns))
      || (openCampaign.phase !== undefined && !LOOP_PHASES.includes(openCampaign.phase))) {
      throw new Error("loop budget carries an unreadable open-campaign reservation; refusing to continue on corrupted state");
    }
  }

  const phases = normalizePhases(value.phases);
  return {
    version: 1,
    max_campaigns: value.max_campaigns as number,
    max_agent_starts: value.max_agent_starts as number,
    max_evaluator_runs: value.max_evaluator_runs as number,
    max_restarts: maxRestarts,
    campaigns: value.campaigns as number,
    agent_starts: value.agent_starts as number,
    evaluator_runs: value.evaluator_runs as number,
    restarts,
    open_campaign: openCampaign,
    max_optimizer_trials: maxOptimizerTrials,
    optimizer_trials: optimizerTrials,
    wall_ms: wallMs,
    phases,
  };
}

function normalizePhases(raw: unknown): Partial<Record<LoopPhase, LoopPhaseSpend>> {
  if (raw === undefined) return emptyPhases();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("loop budget phase counters do not match the expected schema; refusing to continue on corrupted state");
  }
  const phases: Partial<Record<LoopPhase, LoopPhaseSpend>> = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!LOOP_PHASES.includes(key as LoopPhase)) {
      throw new Error(`loop budget phase counters name an unknown phase: ${key}`);
    }
    const spend = entry as Partial<LoopPhaseSpend> | null;
    if (!spend || typeof spend !== "object" || Array.isArray(spend)
      || !isCount(spend.agent_starts) || !isCount(spend.evaluator_runs) || !isCount(spend.campaigns)) {
      throw new Error("loop budget phase counters do not match the expected schema; refusing to continue on corrupted state");
    }
    phases[key as LoopPhase] = { agent_starts: spend.agent_starts, evaluator_runs: spend.evaluator_runs, campaigns: spend.campaigns };
  }
  return phases;
}

export function writeLoopBudget(file: string, budget: LoopBudgetFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(budget, null, 2)}\n`, true);
}

/**
 * Charge a reservation left behind by a process that died mid-phase. A legacy
 * reservation costs one campaign; a phase reservation states its own count, so a
 * discovery probe is not billed as a campaign.
 */
export function reconcileOpenReservation(budget: LoopBudgetFile): { budget: LoopBudgetFile; charged: LoopReservation } | null {
  const open = budget.open_campaign;
  if (!open) return null;
  const campaigns = open.campaigns ?? 1;
  const phase = open.phase ?? "campaign";
  const phases = { ...(budget.phases ?? {}) };
  const prior = phases[phase] ?? { agent_starts: 0, evaluator_runs: 0, campaigns: 0 };
  phases[phase] = {
    agent_starts: prior.agent_starts + open.agent_starts,
    evaluator_runs: prior.evaluator_runs + open.evaluator_runs,
    campaigns: prior.campaigns + campaigns,
  };
  return {
    charged: { ...open, campaigns, phase },
    budget: {
      ...budget,
      campaigns: budget.campaigns + campaigns,
      agent_starts: budget.agent_starts + open.agent_starts,
      evaluator_runs: budget.evaluator_runs + open.evaluator_runs,
      open_campaign: null,
      phases,
    },
  };
}

export interface RemainingAllowance {
  campaigns: number;
  agentStarts: number;
  evaluatorRuns: number;
  optimizerTrials: number;
}

export function remainingAllowance(budget: LoopBudgetFile): RemainingAllowance {
  return {
    campaigns: budget.max_campaigns - budget.campaigns,
    agentStarts: budget.max_agent_starts - budget.agent_starts,
    evaluatorRuns: budget.max_evaluator_runs - budget.evaluator_runs,
    optimizerTrials: (budget.max_optimizer_trials ?? 0) - (budget.optimizer_trials ?? 0),
  };
}

/**
 * Whether a phase may spend this much without exceeding a durable cap. Callers
 * check before dispatching a process, so a phase that would overspend stops the
 * run instead of silently inflating it.
 */
export function hasAllowance(budget: LoopBudgetFile, spend: { agentStarts?: number; evaluatorRuns?: number; campaigns?: number }): boolean {
  const remaining = remainingAllowance(budget);
  return (spend.agentStarts ?? 0) <= remaining.agentStarts
    && (spend.evaluatorRuns ?? 0) <= remaining.evaluatorRuns
    && (spend.campaigns ?? 0) <= remaining.campaigns;
}

/** Charge a finished phase against the budget and clear its reservation. */
export function settleReservation(
  budget: LoopBudgetFile,
  reservation: LoopReservation,
  observed: { agentStarts: number; evaluatorRuns: number; campaigns?: number },
): LoopBudgetFile {
  const campaigns = observed.campaigns ?? reservation.campaigns ?? 1;
  const phases = { ...(budget.phases ?? {}) };
  const prior = phases[reservation.phase] ?? { agent_starts: 0, evaluator_runs: 0, campaigns: 0 };
  phases[reservation.phase] = {
    agent_starts: prior.agent_starts + observed.agentStarts,
    evaluator_runs: prior.evaluator_runs + observed.evaluatorRuns,
    campaigns: prior.campaigns + campaigns,
  };
  return {
    ...budget,
    campaigns: budget.campaigns + campaigns,
    agent_starts: budget.agent_starts + observed.agentStarts,
    evaluator_runs: budget.evaluator_runs + observed.evaluatorRuns,
    optimizer_trials: (budget.optimizer_trials ?? 0) + (reservation.phase === "optimizer" ? 1 : 0),
    open_campaign: null,
    phases,
  };
}

/** Total wall time a run may still use, from the durable residue and this run's cap. */
export function wallTimeAllowance(budget: LoopBudgetFile): number {
  return budget.wall_ms ?? 0;
}
