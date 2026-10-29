import * as fs from "node:fs";
import * as path from "node:path";

import type { ExperimentNode, ExperimentWorld, SearchConfig } from "./experiment.ts";
import { defaultSearchConfig, selectActions } from "./experiment.ts";
import { readJson, writeFileAtomic, writeJson } from "./fsutil.ts";
import { runAgent, type CommandResult } from "../agent/runner.ts";
import type { AgentConfig } from "./task.ts";

export const DREAM_BETA1 = 0.02;
export const DREAM_BETA2 = 0.01;
export const DREAM_MIN_MARGIN = 0.01;
export const DREAM_MIN_COVERAGE = 0.6;
export const DREAM_MIN_PROBES = 3;
export const DREAM_MAX_PROBES = 12;
export const DREAM_MAX_CONSUMED_PROBES = 100_000;

export interface ReplayResult {
  best: number;
  revealed: string[];
  coverage: number;
  rounds: number;
}

export interface WorldValueInput { baseline: number; threshold: number; nodes: ExperimentNode[]; rounds: number; }

function validNodes(world: Pick<ExperimentWorld, "nodes">): ExperimentNode[] {
  return world.nodes.filter((node) => node.stage === "done" && node.valid && typeof node.score === "number");
}

/** Replay a config against recorded nodes only; unrecorded actions reduce coverage. */
export function replayWorld(world: ExperimentWorld, config: SearchConfig): ReplayResult {
  const recorded = world.nodes.filter((node) => node.stage === "done").sort((a, b) => a.seq - b.seq);
  const revealed = new Set<string>();
  const done: ExperimentNode[] = [];
  let best = world.baseline;
  let rounds = 0;
  let requestedActions = 0;
  let noGainRounds = 0;
  for (let round = 1; round <= config.maxRounds && noGainRounds < config.patience; round += 1) {
    const previousBest = best;
    const actions = selectActions(done, config, round);
    if (actions.length === 0) break;
    rounds = round;
    requestedActions += actions.length;
    const unused = [...recorded];
    for (let index = unused.length - 1; index >= 0; index -= 1) if (revealed.has(unused[index]!.id)) unused.splice(index, 1);
    for (const action of actions) {
      const nextIndex = unused.findIndex((node) => node.kind === action.kind && node.parent === action.parent);
      if (nextIndex < 0) continue;
      const [next] = unused.splice(nextIndex, 1);
      if (!next) continue;
      revealed.add(next.id);
      done.push(next);
      if (next.valid && typeof next.score === "number") best = Math.max(best, next.score);
    }
    noGainRounds = best > previousBest && best - previousBest >= world.threshold ? 0 : noGainRounds + 1;
  }
  const coverage = Math.max(recorded.length, requestedActions) === 0
    ? 0
    : revealed.size / Math.max(recorded.length, requestedActions);
  return { best, revealed: [...revealed], coverage, rounds };
}

/** Unitless objective used for comparing search configs across different score scales. */
export function worldValue(world: WorldValueInput, replay: ReplayResult): number {
  const valid = validNodes(world as Pick<ExperimentWorld, "nodes">);
  const worldMax = valid.length ? Math.max(...valid.map((node) => node.score as number)) : world.baseline;
  const scale = Math.max(worldMax - world.baseline, world.threshold, Number.EPSILON);
  const gain = (replay.best - world.baseline) / scale;
  const cost = replay.revealed.length;
  return gain - DREAM_BETA1 * cost + DREAM_BETA2 * cost / Math.max(1, replay.rounds);
}

export function scoreSearchConfig(worlds: ExperimentWorld[], config: SearchConfig): { score: number; coverage: number } {
  if (worlds.length === 0) return { score: 0, coverage: 0 };
  const results = worlds.map((world) => replayWorld(world, config));
  return { score: results.reduce((sum, result, index) => sum + worldValue(worlds[index]!, result), 0) / worlds.length,
    coverage: results.reduce((sum, result) => sum + result.coverage, 0) / results.length };
}

export interface ProbeScore { worldId: string; score: number; coverage: number; }
export interface ProbedConfig { config: SearchConfig; probes: ProbeScore[]; }

function compareStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function consistentProbeDelta(before: ProbeScore, after: ProbeScore): number | null {
  const delta = after.score - before.score;
  if (![before.score, before.coverage, after.score, after.coverage, delta].every(Number.isFinite)
    || before.coverage < DREAM_MIN_COVERAGE || after.coverage < DREAM_MIN_COVERAGE
    || before.coverage > 1 || after.coverage > 1
    || after.score <= before.score + DREAM_MIN_MARGIN || delta <= DREAM_MIN_MARGIN) return null;
  return delta;
}

function uniqueProbeScores(probes: ProbeScore[]): Map<string, ProbeScore> {
  const unique = new Map<string, ProbeScore>();
  for (const probe of probes) {
    if (typeof probe.worldId === "string" && probe.worldId.length > 0 && !unique.has(probe.worldId)) unique.set(probe.worldId, probe);
  }
  return unique;
}

/** Compose from per-world contrasts; a high aggregate or single lucky run cannot promote a config. */
export function composeSearchConfig(candidates: ProbedConfig[], incumbent: SearchConfig, minProbes = DREAM_MIN_PROBES): SearchConfig {
  if (!Number.isSafeInteger(minProbes) || minProbes < DREAM_MIN_PROBES || minProbes > DREAM_MAX_PROBES) return incumbent;
  const current = candidates.find((candidate) => JSON.stringify(candidate.config) === JSON.stringify(incumbent));
  if (!current) return incumbent;
  const baseline = uniqueProbeScores(current.probes);
  if (baseline.size < minProbes) return incumbent;
  const ids = [...baseline.keys()];
  const challengers = candidates.flatMap((candidate) => {
    if (JSON.stringify(candidate.config) === JSON.stringify(incumbent)) return [];
    const scores = uniqueProbeScores(candidate.probes);
    if (scores.size !== baseline.size || ids.some((id) => !scores.has(id))) return [];
    const deltas = ids.map((id) => consistentProbeDelta(baseline.get(id)!, scores.get(id)!) ?? Number.NEGATIVE_INFINITY);
    if (deltas.length < minProbes || deltas.some((delta) => delta <= DREAM_MIN_MARGIN)) return [];
    return [{ config: candidate.config, worstDelta: Math.min(...deltas), meanDelta: deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length }];
  });
  challengers.sort((a, b) => b.worstDelta - a.worstDelta || b.meanDelta - a.meanDelta
    || compareStrings(JSON.stringify(a.config), JSON.stringify(b.config)));
  return challengers[0]?.config ?? incumbent;
}

function scoreConfigProbes(worlds: ExperimentWorld[], config: SearchConfig): ProbeScore[] {
  return worlds.map((world) => ({
    worldId: world.worldId ?? `${world.fingerprint}:${world.cycle}`,
    ...scoreSearchConfig([world], config),
  }));
}

function readConsumedWorldIds(file: string): string[] | null {
  if (!fs.existsSync(file)) return [];
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as { worldIds?: unknown; consumedWorldIds?: unknown };
  const ids = Object.hasOwn(state, "consumedWorldIds") ? state.consumedWorldIds : state.worldIds;
  return Array.isArray(ids) && ids.length <= DREAM_MAX_CONSUMED_PROBES
    && ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 500) ? ids : null;
}

function uniqueConfigs(configs: SearchConfig[]): SearchConfig[] {
  const seen = new Set<string>();
  return configs.filter((config) => {
    const key = JSON.stringify(config);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateSearchConfig(value: unknown): SearchConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const keys = ["version", "batchSize", "exploreShare", "refineTop", "maxRounds", "patience"];
  if (Object.keys(item).length !== keys.length || keys.some((key) => !Object.hasOwn(item, key))) return null;
  if (item.version !== 1 || !Number.isInteger(item.batchSize) || (item.batchSize as number) < 1 || (item.batchSize as number) > 4
    || typeof item.exploreShare !== "number" || item.exploreShare < 0 || item.exploreShare > 1
    || !Number.isInteger(item.refineTop) || (item.refineTop as number) < 1 || (item.refineTop as number) > 3
    || !Number.isInteger(item.maxRounds) || (item.maxRounds as number) < 1 || (item.maxRounds as number) > 6
    || !Number.isInteger(item.patience) || (item.patience as number) < 1 || (item.patience as number) > 3) return null;
  return item as unknown as SearchConfig;
}

export interface DreamOptions {
  projectDir: string;
  loopRoot: string;
  agent: AgentConfig;
  resolveAgent?: (agent: AgentConfig) => AgentConfig | null;
  beforeAgentSpawn: (key: string) => void | Promise<void>;
  log?: (message: string) => void;
  onAgentComplete?: (result: CommandResult) => void;
  signal: AbortSignal;
  worlds?: ExperimentWorld[];
  incumbent?: SearchConfig;
  /** Independent recorded worlds required for a consistent contrast; never below the safe default. */
  minProbes?: number;
}

export async function maybeDream(options: DreamOptions): Promise<SearchConfig> {
  const incumbent = options.incumbent ?? readJson<SearchConfig>(path.join(options.loopRoot, "search-config.json")) ?? defaultSearchConfig;
  const minProbes = options.minProbes ?? DREAM_MIN_PROBES;
  if (!Number.isSafeInteger(minProbes) || minProbes < DREAM_MIN_PROBES || minProbes > DREAM_MAX_PROBES) {
    options.log?.(`[dream] minProbes must be between ${DREAM_MIN_PROBES} and ${DREAM_MAX_PROBES}; retaining the incumbent`);
    return incumbent;
  }
  const priorConsumed = readConsumedWorldIds(path.join(options.loopRoot, "dream-state.json"));
  if (!priorConsumed) {
    options.log?.("[dream] consumed-probe state is corrupt; retaining the incumbent");
    return incumbent;
  }
  if (priorConsumed.length >= DREAM_MAX_CONSUMED_PROBES) return incumbent;
  const consumed = new Set(priorConsumed);
  const seen = new Set<string>();
  const worlds = (options.worlds ?? []).filter((world) => {
    if (world.status !== "complete" || validNodes(world).length < 3) return false;
    const id = world.worldId ?? `${world.fingerprint}:${world.cycle}`;
    if (id.length === 0 || id.length > 500 || consumed.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).sort((a, b) => compareStrings(a.worldId ?? `${a.fingerprint}:${a.cycle}`, b.worldId ?? `${b.fingerprint}:${b.cycle}`))
    .slice(0, DREAM_MAX_PROBES);
  if (worlds.length < minProbes) return incumbent;
  const worldIds = worlds.map((world) => world.worldId ?? `${world.fingerprint}:${world.cycle}`);
  const scratch = path.join(options.loopRoot, "dream-work");
  fs.mkdirSync(scratch, { recursive: true });
  const proposalFile = path.join(scratch, "configs.json");
  fs.rmSync(proposalFile, { force: true });
  const promptFile = path.join(scratch, "DREAM.md");
  const traces = worlds.slice(-12).map((world) => ({ cycle: world.cycle, config: world.config, baseline: world.baseline, threshold: world.threshold,
    rounds: world.rounds, nodes: world.nodes.map(({ id, parent, kind, round, score, valid, timedOut, cost }) => ({ id, parent, kind, round, score, valid, timedOut, cost })) }));
  writeFileAtomic(promptFile, `Propose up to four SearchConfig data values as JSON in ${proposalFile}; do not propose executable policy code. Schema: {"configs":[{"version":1,"batchSize":1-4,"exploreShare":0-1,"refineTop":1-3,"maxRounds":1-6,"patience":1-3}]}. Incumbent: ${JSON.stringify(incumbent)}. The host probes each config on the same ${worlds.length} distinct worlds and composes from the per-world score vector. Adoption requires at least ${minProbes} probes with consistent positive direction and coverage >= ${DREAM_MIN_COVERAGE}; one best-looking run cannot decide. Objective per world: replay value; beta1=${DREAM_BETA1}, beta2=${DREAM_BETA2}. Traces:\n${JSON.stringify(traces, null, 2)}\n`);
  const result = await runAgent({ agent: options.agent, resolveAgent: options.resolveAgent, cwd: scratch, prompt: fs.readFileSync(promptFile, "utf8"),
    timeoutMs: 120_000, logPath: path.join(scratch, "agent.log"), signal: options.signal,
    beforeSpawn: () => options.beforeAgentSpawn("dream-config"), onComplete: options.onAgentComplete });
  if (!result.ok || !fs.existsSync(proposalFile)) {
    options.log?.("[dream] config proposal unavailable; retaining the incumbent search config");
    return incumbent;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(proposalFile, "utf8")); } catch { return incumbent; }
  const proposed = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as Record<string, unknown>).configs)
    ? (parsed as { configs: unknown[] }).configs.slice(0, 4).flatMap((value) => { const config = validateSearchConfig(value); return config ? [config] : []; }) : [];
  const configs = uniqueConfigs([incumbent, ...proposed, ...neighbors(incumbent)]);
  const probed = configs.map((config) => ({ config, probes: scoreConfigProbes(worlds, config) }));
  const adopted = composeSearchConfig(probed, incumbent, minProbes);
  const baseline = probed.find((candidate) => JSON.stringify(candidate.config) === JSON.stringify(incumbent))!;
  const candidates = probed.map((candidate) => ({
    config: candidate.config,
    probes: candidate.probes.map((probe, index) => ({ ...probe, incumbentScore: baseline.probes[index]!.score,
      delta: probe.score - baseline.probes[index]!.score })),
    consistentProbes: candidate.probes.filter((probe, index) => consistentProbeDelta(baseline.probes[index]!, probe) !== null).length,
  }));
  fs.mkdirSync(options.loopRoot, { recursive: true });
  writeFileAtomic(path.join(options.loopRoot, "dream-state.json"), `${JSON.stringify({
    worldIds,
    consumedWorldIds: [...consumed, ...worldIds].slice(-DREAM_MAX_CONSUMED_PROBES),
  }, null, 2)}\n`, true);
  writeJson(path.join(options.loopRoot, "search-config.json"), adopted);
  fs.appendFileSync(path.join(options.loopRoot, "dreams.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), worldIds, minProbes, incumbent, candidates, adopted })}\n`);
  return adopted;
}

function neighbors(config: SearchConfig): SearchConfig[] {
  return [
    { ...config, batchSize: Math.max(1, config.batchSize - 1) },
    { ...config, batchSize: Math.min(4, config.batchSize + 1) },
    { ...config, maxRounds: Math.max(1, config.maxRounds - 1) },
    { ...config, maxRounds: Math.min(6, config.maxRounds + 1) },
  ];
}
