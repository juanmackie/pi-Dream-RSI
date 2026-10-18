import * as fs from "node:fs";
import * as path from "node:path";

import type { LeverAttempt, LeverProposal, LeverSourceKind } from "./levers.ts";
import { writeFileAtomic } from "./world.ts";

/**
 * Search strategy state for the unattended loop: durable cross-campaign memory,
 * UCB1-style allocation across levers, Memento-style notes for fresh-context
 * restarts, and the plateau stop rule. Allocation exists so the search cannot
 * lock into one early direction (MASS Fig. 8; RSI-Master §3.6 redirection).
 */

export interface LeverStats {
  campaigns: number;
  wins: number;
  evaluatorRuns: number;
  agentStarts: number;
  wallMs: number;
  lastOutcome: string | null;
  lastAt: string | null;
  /** Sum of independently verified gains, in the objective's units. Absent in legacy memory. */
  gain?: number;
  /** Sum of the evaluator runs those gains cost, for gain-per-cost allocation. */
  gainCostRuns?: number;
}

/**
 * Provenance for one experiment, so a score is only ever compared with another
 * score from the same baseline, objective and instrument.
 */
export interface ExperimentProvenance {
  /** Contract identity (objective + permissions) this experiment ran under. */
  contractId?: string;
  /** Frozen instrument identity; a revised instrument starts a new history. */
  evaluatorId?: string;
  /** Workspace fingerprint before the experiment. */
  baselineFingerprint?: string;
  /** The mechanism the candidate claimed to change. */
  mechanism?: string;
  /** Closed-class origin of the measured lever, safe to aggregate across trajectories. */
  strategyClass?: LeverSourceKind;
  /** Campaign this experiment continues, if any. */
  parentCampaign?: string;
}

export interface LoopMemoryRecord {
  kind: "campaign";
  leverId: string;
  outcome: "win" | "no-win" | "error" | "rejected";
  stopReason?: string;
  evaluatorRuns: number;
  agentStarts: number;
  wallMs: number;
  at: string;
  /** Independently measured gain for a win, in the objective's units. */
  verifiedGain?: number;
  provenance?: ExperimentProvenance;
}

export interface LoopMemory {
  version: 1;
  leverStats: Record<string, LeverStats>;
  outcomes: LoopMemoryRecord[];
  notes: string[];
}

export const MAX_OUTCOMES = 200;
export const MAX_NOTES = 50;

export function emptyMemory(): LoopMemory {
  return { version: 1, leverStats: {}, outcomes: [], notes: [] };
}

const MEMORY_OUTCOMES: ReadonlySet<string> = new Set(["win", "no-win", "error", "rejected"]);

const PROVENANCE_KEYS = ["contractId", "evaluatorId", "baselineFingerprint", "mechanism", "strategyClass", "parentCampaign"] as const;
const STRATEGY_CLASSES = new Set([
  "session-failure", "slow-command", "post-failure-edits", "session-tool-error", "repeated-tool-retry",
  "aborted-session", "session-compaction", "session-model-change", "dream-improve", "git-hotspot",
  "git-churn", "evaluator", "campaign-failure", "campaign-rejection", "campaign-health", "recon-command",
]);

function validProvenance(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!PROVENANCE_KEYS.includes(key as (typeof PROVENANCE_KEYS)[number])) return false;
    if (typeof entry !== "string" || entry.length > 200) return false;
    if (key === "strategyClass" && !STRATEGY_CLASSES.has(entry)) return false;
  }
  return true;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Read loop memory. A missing file is an empty memory; a corrupt file fails closed. */
export function readMemory(file: string): LoopMemory {
  if (!fs.existsSync(file)) return emptyMemory();
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("loop memory is unreadable; refusing to continue on corrupted state"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("loop memory is not an object");
  const value = parsed as Partial<LoopMemory>;
  if (value.version !== 1 || !value.leverStats || typeof value.leverStats !== "object" || Array.isArray(value.leverStats)
    || !Array.isArray(value.outcomes) || !Array.isArray(value.notes)
    || value.outcomes.length > MAX_OUTCOMES || value.notes.length > MAX_NOTES) {
    throw new Error("loop memory does not match the expected schema; refusing to continue on corrupted state");
  }
  for (const note of value.notes) {
    if (typeof note !== "string" || note.length > 1000) {
      throw new Error("loop memory contains an invalid note; refusing to continue on corrupted state");
    }
  }
  for (const entry of Object.values(value.leverStats as Record<string, unknown>)) {
    const stats = entry as Partial<LeverStats> | null;
    if (!stats || typeof stats !== "object" || Array.isArray(stats)
      || !isCount(stats.campaigns) || !isCount(stats.wins) || !isCount(stats.evaluatorRuns)
      || !isCount(stats.agentStarts) || !isCount(stats.wallMs)
      || stats.wins > stats.campaigns
      || !(stats.lastOutcome === null || (typeof stats.lastOutcome === "string" && MEMORY_OUTCOMES.has(stats.lastOutcome)))
      || !(stats.lastAt === null || typeof stats.lastAt === "string")
      || !(stats.gain === undefined || (typeof stats.gain === "number" && Number.isFinite(stats.gain) && stats.gain >= 0))
      || !(stats.gainCostRuns === undefined || isCount(stats.gainCostRuns))) {
      throw new Error("loop memory contains an invalid lever stats entry; refusing to continue on corrupted state");
    }
  }
  for (const record of value.outcomes) {
    const entry = record as Partial<LoopMemoryRecord> | null;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || entry.kind !== "campaign"
      || typeof entry.leverId !== "string" || entry.leverId.length === 0
      || typeof entry.outcome !== "string" || !MEMORY_OUTCOMES.has(entry.outcome)
      || !isCount(entry.evaluatorRuns) || !isCount(entry.agentStarts) || !isCount(entry.wallMs)
      || typeof entry.at !== "string" || entry.at.length === 0
      || (entry.stopReason !== undefined && (typeof entry.stopReason !== "string" || entry.stopReason.length > 1000))
      || (entry.verifiedGain !== undefined && (typeof entry.verifiedGain !== "number" || !Number.isFinite(entry.verifiedGain)))
      || !validProvenance(entry.provenance)) {
      throw new Error("loop memory contains an invalid outcome record; refusing to continue on corrupted state");
    }
  }
  return value as LoopMemory;
}

/** True when a record belongs to the current baseline, objective and instrument. */
export function isCurrentExperiment(record: LoopMemoryRecord, current: { contractId?: string; evaluatorId?: string; baselineFingerprint?: string }): boolean {
  const provenance = record.provenance;
  if (!provenance) return true; // legacy memory predates provenance; keep it comparable
  if (current.contractId !== undefined && provenance.contractId !== undefined && provenance.contractId !== current.contractId) return false;
  if (current.evaluatorId !== undefined && provenance.evaluatorId !== undefined && provenance.evaluatorId !== current.evaluatorId) return false;
  if (current.baselineFingerprint !== undefined && provenance.baselineFingerprint !== undefined
    && provenance.baselineFingerprint !== current.baselineFingerprint) return false;
  return true;
}

export function writeMemory(file: string, memory: LoopMemory): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(memory, null, 2)}\n`, true);
}

/** Pure updater: fold one campaign outcome into memory with bounded history. */
export function recordCampaignOutcome(memory: LoopMemory, record: LoopMemoryRecord): LoopMemory {
  const prior = memory.leverStats[record.leverId] ?? {
    campaigns: 0, wins: 0, evaluatorRuns: 0, agentStarts: 0, wallMs: 0, lastOutcome: null, lastAt: null,
  };
  const gained = record.outcome === "win" && typeof record.verifiedGain === "number" && Number.isFinite(record.verifiedGain) && record.verifiedGain > 0
    ? record.verifiedGain
    : 0;
  const stats: LeverStats = {
    campaigns: prior.campaigns + 1,
    wins: prior.wins + (record.outcome === "win" ? 1 : 0),
    evaluatorRuns: prior.evaluatorRuns + record.evaluatorRuns,
    agentStarts: prior.agentStarts + record.agentStarts,
    wallMs: prior.wallMs + record.wallMs,
    lastOutcome: record.outcome,
    lastAt: record.at,
    gain: (prior.gain ?? 0) + gained,
    gainCostRuns: (prior.gainCostRuns ?? 0) + (gained > 0 ? record.evaluatorRuns : 0),
  };
  return {
    version: 1,
    leverStats: { ...memory.leverStats, [record.leverId]: stats },
    outcomes: [...memory.outcomes, record].slice(-MAX_OUTCOMES),
    notes: memory.notes.slice(-MAX_NOTES),
  };
}

/** The latest recorded outcome per lever, in the shape the inventory consumes. */
export function attemptsFromMemory(memory: LoopMemory): LeverAttempt[] {
  const attempts: LeverAttempt[] = [];
  for (const [leverId, stats] of Object.entries(memory.leverStats)) {
    if (stats.lastOutcome === "win" || stats.lastOutcome === "no-win" || stats.lastOutcome === "error" || stats.lastOutcome === "rejected") {
      attempts.push({ leverId, outcome: stats.lastOutcome });
    }
  }
  return attempts.sort((a, b) => a.leverId.localeCompare(b.leverId));
}

export interface LeverRankingEntry {
  id: string;
  ucb: number;
  meanWinRate: number;
  campaigns: number;
  reason: string;
  /** Verified gain per evaluator run, for utility allocation. Absent when unmeasured. */
  gainPerRun?: number;
}

export type AllocationStrategy = "win-rate" | "utility";

export interface LeverSelection {
  selected: LeverProposal | null;
  ranking: LeverRankingEntry[];
}

/**
 * UCB1 allocation across levers. Untried levers are explored first (ordered by
 * inventory score), so the search opens new directions before it exploits a
 * proven one.
 *
 * Two strategies share the same shape and differ only in what "reward" means:
 *
 * - `win-rate` (default) rewards a binary campaign win. It is the historical
 *   behaviour and the comparison baseline.
 * - `utility` rewards measured gain per evaluator run, so a large improvement that
 *   was expensive to confirm competes honestly with a small cheap one. A lever
 *   with no measured gain yet carries only the exploration bonus, which is what
 *   keeps an unmeasured direction from being starved.
 */
export function ucbSelect(levers: LeverProposal[], memory: LoopMemory, options: { c?: number; strategy?: AllocationStrategy } = {}): LeverSelection {
  const c = Number.isFinite(options.c) && (options.c ?? 0) > 0 ? options.c as number : 1.2;
  const strategy = options.strategy ?? "win-rate";
  const totals = levers.reduce((sum, lever) => sum + (memory.leverStats[lever.id]?.campaigns ?? 0), 0);
  const untried = levers.filter((lever) => (memory.leverStats[lever.id]?.campaigns ?? 0) === 0);
  const rewards = levers.map((lever) => {
    const stats = memory.leverStats[lever.id];
    const campaigns = stats?.campaigns ?? 0;
    if (strategy === "win-rate") return campaigns === 0 ? 0 : (stats?.wins ?? 0) / campaigns;
    const gain = stats?.gain ?? 0;
    const runs = stats?.gainCostRuns ?? 0;
    return runs > 0 && gain > 0 ? gain / runs : 0;
  });
  // Utility rewards are in objective units; normalize so the exploration bonus has
  // a comparable scale instead of being swamped by large absolute gains.
  const scale = strategy === "utility" ? Math.max(...rewards.map(Math.abs), Number.EPSILON) : 1;
  const ranking: LeverRankingEntry[] = levers.map((lever, index) => {
    const stats = memory.leverStats[lever.id];
    const campaigns = stats?.campaigns ?? 0;
    if (campaigns === 0) {
      return { id: lever.id, ucb: Number.POSITIVE_INFINITY, meanWinRate: 0, campaigns, reason: "untried: opened before revisiting tried levers" };
    }
    const meanWinRate = (stats?.wins ?? 0) / campaigns;
    const gain = stats?.gain ?? 0;
    const runs = stats?.gainCostRuns ?? 0;
    const gainPerRun = runs > 0 && gain > 0 ? gain / runs : undefined;
    const reward = strategy === "utility" ? rewards[index] / scale : meanWinRate;
    const ucb = reward + c * Math.sqrt(Math.log(Math.max(totals, 1)) / campaigns);
    const reason = strategy === "utility"
      ? `verified gain ${gain.toFixed(3)} over ${runs} confirmation run(s) (${(rewards[index]).toFixed(3)} per run) plus exploration bonus`
      : `mean win rate ${meanWinRate.toFixed(2)} over ${campaigns} campaign(s) plus exploration bonus`;
    return { id: lever.id, ucb, meanWinRate, campaigns, reason, ...(gainPerRun === undefined ? {} : { gainPerRun }) };
  });
  ranking.sort((a, b) => b.ucb - a.ucb || a.id.localeCompare(b.id));
  if (untried.length > 0) {
    const best = [...untried].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0];
    return { selected: best, ranking };
  }
  const top = ranking[0];
  const selected = top ? levers.find((lever) => lever.id === top.id) ?? null : null;
  return { selected, ranking };
}

/** Bounded Memento-style digest for fresh-context restarts: notes first, then stats. */
export function mementoNotes(memory: LoopMemory, maxChars = 1200): string {
  const stats = Object.entries(memory.leverStats)
    .sort((a, b) => b[1].campaigns - a[1].campaigns || a[0].localeCompare(b[0]));
  const totalCampaigns = stats.reduce((sum, [, value]) => sum + value.campaigns, 0);
  const totalWins = stats.reduce((sum, [, value]) => sum + value.wins, 0);
  const lines = [`Loop memory: ${totalCampaigns} campaign(s), ${totalWins} verified win(s) across ${stats.length} lever(s).`];
  for (const note of memory.notes.slice(-3)) lines.push(`- note: ${note}`);
  for (const [id, value] of stats.slice(0, 4)) {
    lines.push(`- lever ${id}: ${value.campaigns} campaign(s), ${value.wins} win(s), last ${value.lastOutcome ?? "unknown"} at ${value.lastAt ?? "unknown"}; ${value.evaluatorRuns} evaluator run(s), ${value.agentStarts} agent start(s), ${Math.round(value.wallMs / 1000)} s.`);
  }
  for (const record of memory.outcomes.slice(-3)) {
    lines.push(`- ${record.at}: ${record.leverId} ${record.outcome}${record.stopReason ? ` (${record.stopReason})` : ""}`);
  }
  return lines.join("\n").slice(0, Math.max(0, maxChars));
}

export interface PlateauState {
  plateaued: boolean;
  consecutiveNoWin: number;
  leverId: string | null;
}

/** Consecutive campaign outcomes without a verified win at the tail of the history. */
export function plateauState(memory: LoopMemory, k = 3): PlateauState {
  let count = 0;
  let leverId: string | null = null;
  let mixed = false;
  for (let index = memory.outcomes.length - 1; index >= 0; index -= 1) {
    const record = memory.outcomes[index];
    if (record.outcome === "win") break;
    if (record.outcome === "rejected") continue; // screening outcomes are not search results
    count += 1;
    if (leverId === null) leverId = record.leverId;
    else if (leverId !== record.leverId) mixed = true;
  }
  return { plateaued: count >= Math.max(1, Math.round(k)), consecutiveNoWin: count, leverId: mixed ? null : leverId };
}
