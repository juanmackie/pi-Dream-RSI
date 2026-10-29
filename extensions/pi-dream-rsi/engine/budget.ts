/**
 * Durable accounting for one autonomous run.
 *
 * Every phase that can start a process — discovery probes, instrument qualification,
 * campaign candidates, review, post-apply checks and
 * dream replay — spends from the same parent allowance. A grant is written
 * before the child is dispatched, and a reservation left behind by a dead
 * process is charged on the next run instead of being handed out twice.
 *
 * The file format stays compatible with the version-1 loop budget: the original
 * counters keep their meaning, and the phase counters are additional.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileAtomic } from "./fsutil.ts";
import { allocator } from "./ownership.ts";

/** Phases that consume the run allowance. */
export const LOOP_PHASES = ["discovery", "qualification", "campaign", "dream", "post-apply"] as const;
export type LoopPhase = (typeof LOOP_PHASES)[number];

export interface LoopBudgetLimits {
  maxCampaigns: number;
  maxAgentStarts: number;
  maxEvaluatorRuns: number;
  deadlineMs: number;
}

/** One dispatch grant, written before the child runs. */
export interface LoopReservation {
  phase: LoopPhase;
  agent_starts: number;
  evaluator_runs: number;
  /** Campaigns this reservation may start; absent in legacy reservations, which cost one. */
  campaigns?: number;
  /** Campaign identity lets recovery reconcile actual process starts instead of the entire grant. */
  campaign_id?: string;
  campaign_agent_starts_before?: number;
  campaign_evaluator_runs_before?: number;
  at: string;
}

export interface LoopPhaseSpend {
  agent_starts: number;
  evaluator_runs: number;
  campaigns: number;
}

export interface RsiDailyBudget {
  window_id: string;
  campaigns: number;
  agent_starts: number;
  evaluator_runs: number;
  tokens: number;
  wall_ms: number;
  active_run: { started_at: string; allowance_ms: number } | null;
  /** True when token usage before this accounting version could not be reconstructed. */
  tokens_unattributed: boolean;
  /** True when lifetime wall time before this accounting version could not be reconstructed. */
  wall_unattributed?: boolean;
}

export interface LoopBudgetFile {
  version: 1;
  max_campaigns: number;
  max_agent_starts: number;
  max_evaluator_runs: number;
  campaigns: number;
  agent_starts: number;
  evaluator_runs: number;
  open_campaign: LoopReservation | null;
  /** Accumulated wall time of finished runs; absent in a legacy budget file. */
  wall_ms?: number;
  /** Durable continuous-mode pacing and plateau state; absent in legacy budgets. */
  last_campaign_started_at?: string | null;
  consecutive_no_win_campaigns?: number;
  last_plateau_campaign_id?: string | null;
  /** Rolling hour process reservations for continuous-mode soft rate limits. */
  hourly_starts?: { agents: number[]; evaluators: number[] };
  /** Per-phase spend for reporting and durable reconciliation. */
  phases?: Partial<Record<LoopPhase, LoopPhaseSpend>>;
  /** Provider-reported cumulative lifetime tokens; it is not a provider-side spending ceiling. */
  tokens_used?: number;
  /** Idempotent receipt for the single campaign that can be paused and resumed. */
  last_campaign_token_receipt?: { campaign_id: string; tokens: number };
  /** Per-UTC-day RSI caps and counters. Existing top-level counters remain lifetime totals. */
  rsi?: RsiDailyBudget;
}

export const RSI_DAILY_CAPS = { campaigns: 6, tokens: 400_000, wallMs: 240 * 60_000 } as const;


export function readSavedBudgetCaps(file: string): Pick<LoopBudgetFile, "max_campaigns" | "max_agent_starts" | "max_evaluator_runs"> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LoopBudgetFile> | null;
    if (!parsed || !Number.isSafeInteger(parsed.max_campaigns) || !Number.isSafeInteger(parsed.max_agent_starts) || !Number.isSafeInteger(parsed.max_evaluator_runs)
      || (parsed.max_campaigns as number) < 1 || (parsed.max_agent_starts as number) < 1 || (parsed.max_evaluator_runs as number) < 1) return null;
    return { max_campaigns: parsed.max_campaigns as number, max_agent_starts: parsed.max_agent_starts as number, max_evaluator_runs: parsed.max_evaluator_runs as number };
  } catch { return null; }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`loop limit ${label} must be a positive integer`);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function compareLimits(value: Partial<LoopBudgetFile>, limits: LoopBudgetLimits, allowIncrease: boolean): boolean {
  const old = [value.max_campaigns, value.max_agent_starts, value.max_evaluator_runs];
  const next = [limits.maxCampaigns, limits.maxAgentStarts, limits.maxEvaluatorRuns];
  if (next.some((limit, index) => limit < (old[index] as number))) {
    throw new Error("loop budget limits may only be increased through an approved contract replacement");
  }
  if (!allowIncrease && next.some((limit, index) => limit !== old[index])) {
    throw new Error("loop budget limits are immutable without an approved saved contract");
  }
  const spend = value.rsi ?? { campaigns: value.campaigns as number, agent_starts: value.agent_starts as number, evaluator_runs: value.evaluator_runs as number };
  if (limits.maxCampaigns < spend.campaigns || limits.maxAgentStarts < spend.agent_starts
    || limits.maxEvaluatorRuns < spend.evaluator_runs) {
    throw new Error("loop budget increase cannot set a cap below accumulated spend");
  }
  return next.some((limit, index) => limit !== old[index]);
}

function emptyPhases(): Partial<Record<LoopPhase, LoopPhaseSpend>> {
  return {};
}

function utcWindowId(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function isUtcDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function emptyRsiWindow(windowId: string): RsiDailyBudget {
  if (!isUtcDateKey(windowId)) throw new Error("RSI budget window must be a UTC date in YYYY-MM-DD form");
  return { window_id: windowId, campaigns: 0, agent_starts: 0, evaluator_runs: 0, tokens: 0, wall_ms: 0, active_run: null, tokens_unattributed: false, wall_unattributed: false };
}

function validRsiWindow(raw: unknown): raw is RsiDailyBudget {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const value = raw as Partial<RsiDailyBudget>;
  return typeof value.window_id === "string" && isUtcDateKey(value.window_id)
    && isCount(value.campaigns) && isCount(value.agent_starts) && isCount(value.evaluator_runs)
    && isCount(value.tokens) && isCount(value.wall_ms)
    && typeof value.tokens_unattributed === "boolean"
    && (value.wall_unattributed === undefined || typeof value.wall_unattributed === "boolean")
    && (value.active_run === null || (typeof value.active_run === "object" && value.active_run !== null
      && typeof value.active_run.started_at === "string" && Number.isFinite(Date.parse(value.active_run.started_at))
      && isCount(value.active_run.allowance_ms) && value.active_run.allowance_ms > 0));
}

/**
 * Read the durable budget, creating it on first use. Existing limits stay fixed
 * unless a saved approved contract authorizes a monotonic increase. Counters and
 * reservations remain fail-closed.
 */
export function readOrCreateLoopBudget(file: string, limits: LoopBudgetLimits, options: { allowIncrease?: boolean; rsiMode?: boolean; persistRsi?: boolean; rsiWindowId?: string; nowMs?: number } = {}): LoopBudgetFile {
  assertPositiveInteger(limits.maxCampaigns, "maxCampaigns");
  assertPositiveInteger(limits.maxAgentStarts, "maxAgentStarts");
  assertPositiveInteger(limits.maxEvaluatorRuns, "maxEvaluatorRuns");
  assertPositiveInteger(limits.deadlineMs, "deadlineMs");
  if (!fs.existsSync(file)) {
    const created: LoopBudgetFile = {
      version: 1,
      max_campaigns: limits.maxCampaigns,
      max_agent_starts: limits.maxAgentStarts,
      max_evaluator_runs: limits.maxEvaluatorRuns,
      campaigns: 0,
      agent_starts: 0,
      evaluator_runs: 0,
      open_campaign: null,
      wall_ms: 0,
      last_campaign_started_at: null,
      consecutive_no_win_campaigns: 0,
      last_plateau_campaign_id: null,
      hourly_starts: { agents: [], evaluators: [] },
      phases: emptyPhases(),
      ...(options.rsiMode ? { tokens_used: 0, rsi: emptyRsiWindow(options.rsiWindowId ?? utcWindowId(options.nowMs ?? Date.now())) } : {}),
    };
    if (!options.rsiMode || options.persistRsi !== false) writeLoopBudget(file, created);
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
  if (value.tokens_used !== undefined && !isCount(value.tokens_used)) throw new Error("loop budget token counter does not match the expected schema; refusing to continue on corrupted state");
  if (value.last_campaign_token_receipt !== undefined && (!value.last_campaign_token_receipt
    || typeof value.last_campaign_token_receipt.campaign_id !== "string" || !value.last_campaign_token_receipt.campaign_id
    || !isCount(value.last_campaign_token_receipt.tokens))) {
    throw new Error("loop budget campaign token receipt is invalid; refusing to continue on corrupted state");
  }
  if (value.rsi !== undefined && !validRsiWindow(value.rsi)) throw new Error("loop RSI budget does not match the expected schema; refusing to continue on corrupted state");
  if (value.rsi && options.rsiMode === false) throw new Error("an RSI budget cannot be downgraded to legacy mode; preserve its daily and lifetime accounting");
  const limitsChanged = compareLimits(value, limits, options.allowIncrease === true);
  const wallMs = value.wall_ms === undefined ? 0 : value.wall_ms;
  if (!isCount(wallMs)) throw new Error("loop budget wall-time counter does not match the expected schema; refusing to continue on corrupted state");
  const lastCampaignStartedAt = value.last_campaign_started_at === undefined ? null : value.last_campaign_started_at;
  if (lastCampaignStartedAt !== null && (typeof lastCampaignStartedAt !== "string" || !Number.isFinite(Date.parse(lastCampaignStartedAt)))) {
    throw new Error("loop budget campaign pacing timestamp is invalid; refusing to continue on corrupted state");
  }
  const consecutiveNoWinCampaigns = value.consecutive_no_win_campaigns === undefined ? 0 : value.consecutive_no_win_campaigns;
  if (!isCount(consecutiveNoWinCampaigns)) throw new Error("loop budget plateau counter is invalid; refusing to continue on corrupted state");
  const lastPlateauCampaignId = value.last_plateau_campaign_id === undefined ? null : value.last_plateau_campaign_id;
  if (lastPlateauCampaignId !== null && (typeof lastPlateauCampaignId !== "string" || !lastPlateauCampaignId || lastPlateauCampaignId.length > 200)) {
    throw new Error("loop budget plateau campaign identity is invalid; refusing to continue on corrupted state");
  }

  const openCampaign = value.open_campaign ?? null;
  if (openCampaign !== null) {
    if (typeof openCampaign !== "object" || openCampaign === null
      || !isCount(openCampaign.agent_starts) || !isCount(openCampaign.evaluator_runs)
      || typeof openCampaign.at !== "string" || !Number.isFinite(Date.parse(openCampaign.at))
      || (openCampaign.campaign_id !== undefined && typeof openCampaign.campaign_id !== "string")
      || (openCampaign.campaign_agent_starts_before !== undefined && !isCount(openCampaign.campaign_agent_starts_before))
      || (openCampaign.campaign_evaluator_runs_before !== undefined && !isCount(openCampaign.campaign_evaluator_runs_before))
      || (openCampaign.campaigns !== undefined && !isCount(openCampaign.campaigns))
      || (openCampaign.phase !== undefined && !LOOP_PHASES.includes(openCampaign.phase))) {
      throw new Error("loop budget carries an unreadable open-campaign reservation; refusing to continue on corrupted state");
    }
  }

  const phases = normalizePhases(value.phases);
  const hourlyStarts = normalizeHourlyStarts(value.hourly_starts);
  let budget: LoopBudgetFile = {
    version: 1,
    max_campaigns: limitsChanged ? limits.maxCampaigns : value.max_campaigns as number,
    max_agent_starts: limitsChanged ? limits.maxAgentStarts : value.max_agent_starts as number,
    max_evaluator_runs: limitsChanged ? limits.maxEvaluatorRuns : value.max_evaluator_runs as number,
    campaigns: value.campaigns as number,
    agent_starts: value.agent_starts as number,
    evaluator_runs: value.evaluator_runs as number,
    open_campaign: openCampaign,
    wall_ms: wallMs,
    last_campaign_started_at: lastCampaignStartedAt,
    consecutive_no_win_campaigns: consecutiveNoWinCampaigns,
    last_plateau_campaign_id: lastPlateauCampaignId,
    hourly_starts: hourlyStarts,
    phases,
    ...(value.tokens_used === undefined ? {} : { tokens_used: value.tokens_used }),
    ...(value.last_campaign_token_receipt === undefined ? {} : { last_campaign_token_receipt: { ...value.last_campaign_token_receipt } }),
    ...(value.rsi === undefined ? {} : { rsi: {
      ...structuredClone(value.rsi),
      wall_unattributed: value.rsi.wall_unattributed ?? (wallMs === 0 && ((value.campaigns as number) > 0 || (value.agent_starts as number) > 0)),
    } }),
  };
  if (options.rsiMode) {
    const nowMs = options.nowMs ?? Date.now();
    const windowId = options.rsiWindowId ?? utcWindowId(nowMs);
    if (!budget.rsi) {
      // Preserve legacy spend conservatively in the first day after migration. The old ledger
      // has no reliable token total, so mark that history as unattributed instead of claiming zero.
      budget.rsi = {
        window_id: windowId,
        campaigns: budget.campaigns,
        agent_starts: budget.agent_starts,
        evaluator_runs: budget.evaluator_runs,
        tokens: 0,
        wall_ms: RSI_DAILY_CAPS.wallMs,
        active_run: null,
        tokens_unattributed: budget.campaigns > 0 || budget.agent_starts > 0,
        wall_unattributed: (budget.wall_ms ?? 0) === 0 && (budget.campaigns > 0 || budget.agent_starts > 0),
      };
      budget.tokens_used ??= 0;
    } else {
      emptyRsiWindow(windowId);
      if (windowId < budget.rsi.window_id) throw new Error("UTC clock moved backward before the saved RSI window; refusing to renew daily allowance");
      if (budget.rsi.active_run) {
        if (nowMs < Date.parse(budget.rsi.active_run.started_at)) throw new Error("UTC clock moved backward during an active RSI reservation; refusing to release its allowance");
        budget = settleRsiRun(budget, nowMs, true);
      }
      if (budget.rsi!.window_id !== windowId) {
        budget.rsi = { ...emptyRsiWindow(windowId), tokens_unattributed: budget.rsi!.tokens_unattributed, wall_unattributed: budget.rsi!.wall_unattributed };
      }
    }
  }
  if (limitsChanged || (options.rsiMode && options.persistRsi !== false)) writeLoopBudget(file, budget);
  return budget;
}

function normalizeHourlyStarts(raw: unknown): { agents: number[]; evaluators: number[] } {
  if (raw === undefined) return { agents: [], evaluators: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("loop budget hourly process history is invalid; refusing to continue on corrupted state");
  const value = raw as { agents?: unknown; evaluators?: unknown };
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "agents") || !Object.hasOwn(value, "evaluators")) {
    throw new Error("loop budget hourly process history is invalid; refusing to continue on corrupted state");
  }
  const normalize = (entries: unknown): number[] => {
    if (!Array.isArray(entries) || entries.length > 10_000 || entries.some((at) => typeof at !== "number" || !Number.isSafeInteger(at) || at < 0)) {
      throw new Error("loop budget hourly process history is invalid; refusing to continue on corrupted state");
    }
    return [...entries];
  };
  return { agents: normalize(value.agents), evaluators: normalize(value.evaluators) };
}

export function reserveHourlyProcessStart(
  budget: LoopBudgetFile,
  kind: CampaignProcessKind,
  limit: number,
  nowMs: number,
): { budget: LoopBudgetFile; waitMs: number } {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("hourly process limit and timestamp must be positive safe integers");
  const hourly = budget.hourly_starts ?? { agents: [], evaluators: [] };
  const key = kind === "agent" ? "agents" : "evaluators";
  const recent = hourly[key].filter((at) => at > nowMs - 3_600_000).sort((a, b) => a - b);
  if (recent.length >= limit) {
    return { budget: { ...budget, hourly_starts: { ...hourly, [key]: recent } }, waitMs: Math.max(1, recent[0]! + 3_600_000 - nowMs) };
  }
  recent.push(nowMs);
  return { budget: { ...budget, hourly_starts: { ...hourly, [key]: recent } }, waitMs: 0 };
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
export function reconcileOpenReservation(
  budget: LoopBudgetFile,
  observed?: { agentStarts: number; evaluatorRuns: number; campaigns?: number },
): { budget: LoopBudgetFile; charged: LoopReservation } | null {
  const open = budget.open_campaign;
  if (!open) return null;
  const campaigns = observed?.campaigns ?? open.campaigns ?? 1;
  const agentStarts = observed
    ? Math.min(open.agent_starts, Math.max(0, observed.agentStarts - (open.campaign_agent_starts_before ?? 0)))
    : open.agent_starts;
  const evaluatorRuns = observed
    ? Math.min(open.evaluator_runs, Math.max(0, observed.evaluatorRuns - (open.campaign_evaluator_runs_before ?? 0)))
    : open.evaluator_runs;
  const phase = open.phase ?? "campaign";
  const phases = { ...(budget.phases ?? {}) };
  const prior = phases[phase] ?? { agent_starts: 0, evaluator_runs: 0, campaigns: 0 };
  phases[phase] = {
    agent_starts: prior.agent_starts + agentStarts,
    evaluator_runs: prior.evaluator_runs + evaluatorRuns,
    campaigns: prior.campaigns + campaigns,
  };
  return {
    charged: { ...open, agent_starts: agentStarts, evaluator_runs: evaluatorRuns, campaigns, phase },
    budget: {
      ...budget,
      campaigns: budget.campaigns + campaigns,
      agent_starts: budget.agent_starts + agentStarts,
      evaluator_runs: budget.evaluator_runs + evaluatorRuns,
      ...(budget.rsi ? { rsi: { ...budget.rsi, campaigns: budget.rsi.campaigns + campaigns,
        agent_starts: budget.rsi.agent_starts + agentStarts, evaluator_runs: budget.rsi.evaluator_runs + evaluatorRuns } } : {}),
      open_campaign: null,
      phases,
    },
  };
}

export interface RemainingAllowance {
  campaigns: number;
  agentStarts: number;
  evaluatorRuns: number;
}

export function remainingAllowance(budget: LoopBudgetFile): RemainingAllowance {
  const spend = budget.rsi ?? { campaigns: budget.campaigns, agent_starts: budget.agent_starts, evaluator_runs: budget.evaluator_runs };
  return {
    campaigns: budget.max_campaigns - spend.campaigns,
    agentStarts: budget.max_agent_starts - spend.agent_starts,
    evaluatorRuns: budget.max_evaluator_runs - spend.evaluator_runs,
  };
}

export function remainingRsiTokens(budget: LoopBudgetFile): number {
  return budget.rsi ? RSI_DAILY_CAPS.tokens - budget.rsi.tokens : Number.POSITIVE_INFINITY;
}

/** Account observed provider-reported usage without treating it as a provider-side hard ceiling. */
export function recordTokenUsage(budget: LoopBudgetFile, tokens: number): LoopBudgetFile {
  if (!isCount(tokens) || !Number.isSafeInteger((budget.tokens_used ?? 0) + tokens)) throw new Error("token usage must be a non-negative safe integer");
  return {
    ...budget,
    tokens_used: (budget.tokens_used ?? 0) + tokens,
    ...(budget.rsi ? { rsi: { ...budget.rsi, tokens: budget.rsi.tokens + tokens } } : {}),
  };
}

export function recordCampaignTokenUsage(budget: LoopBudgetFile, campaignId: string, tokens: number): LoopBudgetFile {
  if (!campaignId || !isCount(tokens)) throw new Error("campaign token usage receipt is invalid");
  const previous = budget.last_campaign_token_receipt;
  if (previous?.campaign_id === campaignId && tokens < previous.tokens) throw new Error("campaign token usage went backwards; refusing to reduce durable spend");
  const delta = previous?.campaign_id === campaignId ? tokens - previous.tokens : tokens;
  return { ...recordTokenUsage(budget, delta), last_campaign_token_receipt: { campaign_id: campaignId, tokens } };
}

/** Reserve this invocation's wall allowance before work begins; the active lease owns it. */
export function reserveRsiRun(budget: LoopBudgetFile, startedAtMs: number, requestedMs: number): { budget: LoopBudgetFile; allowanceMs: number } {
  if (!budget.rsi) throw new Error("RSI daily budget is missing; refusing to start");
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || !Number.isSafeInteger(requestedMs) || requestedMs < 1) {
    throw new Error("RSI run time bounds are invalid");
  }
  if (budget.rsi.active_run) throw new Error("an RSI run reservation is already active; recover the prior loop lease first");
  const nextUtcDay = Date.UTC(new Date(startedAtMs).getUTCFullYear(), new Date(startedAtMs).getUTCMonth(), new Date(startedAtMs).getUTCDate() + 1);
  const allowanceMs = Math.min(RSI_DAILY_CAPS.wallMs - budget.rsi.wall_ms, requestedMs, nextUtcDay - startedAtMs);
  if (!Number.isSafeInteger(allowanceMs) || allowanceMs < 1) throw new Error("the RSI daily wall-clock budget is exhausted");
  return { budget: { ...budget, rsi: { ...budget.rsi, active_run: { started_at: new Date(startedAtMs).toISOString(), allowance_ms: allowanceMs } } }, allowanceMs };
}

/** Settle an invocation or conservatively charge a crashed invocation up to its reservation. */
export function settleRsiRun(budget: LoopBudgetFile, endedAtMs: number, conservativeRecovery = false): LoopBudgetFile {
  const rsi = budget.rsi;
  if (!rsi?.active_run) return budget;
  const startedAtMs = Date.parse(rsi.active_run.started_at);
  if (!Number.isSafeInteger(endedAtMs) || endedAtMs < startedAtMs) throw new Error("UTC clock moved backward during an active RSI reservation; refusing to settle it");
  const elapsed = endedAtMs - startedAtMs;
  const charged = conservativeRecovery ? Math.min(rsi.active_run.allowance_ms, elapsed) : elapsed;
  return { ...budget, wall_ms: (budget.wall_ms ?? 0) + charged,
    rsi: { ...rsi, wall_ms: rsi.wall_ms + charged, active_run: null } };
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
export function chargeImmediateProcessStart(budget: LoopBudgetFile, phase: LoopPhase, kind: CampaignProcessKind): LoopBudgetFile {
  const agentStarts = kind === "agent" ? 1 : 0;
  const evaluatorRuns = kind === "evaluator" ? 1 : 0;
  if (!hasAllowance(budget, { agentStarts, evaluatorRuns })) throw new Error("durable process-start budget exhausted");
  const phases = { ...(budget.phases ?? {}) };
  const prior = phases[phase] ?? { agent_starts: 0, evaluator_runs: 0, campaigns: 0 };
  phases[phase] = { ...prior, agent_starts: prior.agent_starts + agentStarts, evaluator_runs: prior.evaluator_runs + evaluatorRuns };
  return {
    ...budget,
    agent_starts: budget.agent_starts + agentStarts,
    evaluator_runs: budget.evaluator_runs + evaluatorRuns,
    ...(budget.rsi ? { rsi: { ...budget.rsi, agent_starts: budget.rsi.agent_starts + agentStarts, evaluator_runs: budget.rsi.evaluator_runs + evaluatorRuns } } : {}),
    phases,
  };
}

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
    ...(budget.rsi ? { rsi: { ...budget.rsi, campaigns: budget.rsi.campaigns + campaigns,
      agent_starts: budget.rsi.agent_starts + observed.agentStarts, evaluator_runs: budget.rsi.evaluator_runs + observed.evaluatorRuns } } : {}),
    open_campaign: null,
    phases,
  };
}

/** Process-start ledger owned by one campaign. */
export type CampaignProcessKind = "agent" | "evaluator";

export interface CampaignProcessLedger {
  version: 1;
  agent_limit: number;
  evaluator_limit: number;
  agent_starts: number;
  evaluator_runs: number;
  last_start: { kind: CampaignProcessKind; key: string; reserved_at: string } | null;
}

export class CampaignLimitError extends Error {
  readonly kind: CampaignProcessKind;
  readonly limit: number;
  constructor(kind: CampaignProcessKind, limit: number) {
    super(`campaign ${kind} start limit reached (${limit})`);
    this.name = "CampaignLimitError";
    this.kind = kind;
    this.limit = limit;
  }
}

/** Durable process-start reservations shared by every phase in one campaign. */
export class CampaignBudget {
  readonly path: string;
  readonly root: string;
  readonly agentLimit: number;
  readonly evaluatorLimit: number;

  constructor(root: string, agentLimit: number, evaluatorLimit: number, createIfMissing = false) {
    this.root = root;
    this.agentLimit = agentLimit;
    this.evaluatorLimit = evaluatorLimit;
    this.path = path.join(root, "campaign-processes.json");
    fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(this.path) && createIfMissing) {
      this.write({ version: 1, agent_limit: agentLimit, evaluator_limit: evaluatorLimit, agent_starts: 0, evaluator_runs: 0, last_start: null });
    }
    if (!fs.existsSync(this.path)) throw new Error("campaign process ledger is missing; refusing to renew its budget");
  }

  read(): CampaignProcessLedger {
    const parsed: unknown = JSON.parse(fs.readFileSync(this.path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("campaign process ledger is invalid");
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || value.agent_limit !== this.agentLimit || value.evaluator_limit !== this.evaluatorLimit
      || typeof value.agent_starts !== "number" || !Number.isSafeInteger(value.agent_starts) || value.agent_starts < 0 || value.agent_starts > this.agentLimit
      || typeof value.evaluator_runs !== "number" || !Number.isSafeInteger(value.evaluator_runs) || value.evaluator_runs < 0 || value.evaluator_runs > this.evaluatorLimit
      || !(value.last_start === null || (typeof value.last_start === "object" && value.last_start !== null && !Array.isArray(value.last_start)))) {
      throw new Error("campaign process ledger does not match the saved limits");
    }
    const lastStart = value.last_start as Record<string, unknown> | null;
    if (lastStart && ((lastStart.kind !== "agent" && lastStart.kind !== "evaluator")
      || typeof lastStart.key !== "string" || typeof lastStart.reserved_at !== "string")) {
      throw new Error("campaign process ledger last_start is invalid");
    }
    return {
      version: 1, agent_limit: this.agentLimit, evaluator_limit: this.evaluatorLimit,
      agent_starts: value.agent_starts as number, evaluator_runs: value.evaluator_runs as number,
      last_start: lastStart as CampaignProcessLedger["last_start"],
    };
  }

  /** Extend a paused campaign only with allowance granted by its owning durable loop. */
  extendLimits(agentLimit: number, evaluatorLimit: number): void {
    if (!Number.isSafeInteger(agentLimit) || agentLimit < this.agentLimit || !Number.isSafeInteger(evaluatorLimit) || evaluatorLimit < this.evaluatorLimit) {
      throw new Error("campaign budget extension cannot reduce limits or use invalid counts");
    }
    allocator(this.root, () => {
      const ledger = this.read();
      this.write({ ...ledger, agent_limit: agentLimit, evaluator_limit: evaluatorLimit });
    });
  }

  reserve(kind: CampaignProcessKind, key: string): void {
    allocator(this.root, () => {
      const ledger = this.read();
      if (kind === "agent") {
        if (ledger.agent_starts >= ledger.agent_limit) throw new CampaignLimitError(kind, ledger.agent_limit);
        ledger.agent_starts += 1;
      } else {
        if (ledger.evaluator_runs >= ledger.evaluator_limit) throw new CampaignLimitError(kind, ledger.evaluator_limit);
        ledger.evaluator_runs += 1;
      }
      ledger.last_start = { kind, key, reserved_at: new Date().toISOString() };
      this.write(ledger);
    });
  }

  private write(ledger: CampaignProcessLedger): void {
    writeFileAtomic(this.path, `${JSON.stringify(ledger, null, 2)}\n`, true);
  }
}
