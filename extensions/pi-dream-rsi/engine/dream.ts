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

export interface ScoredConfig { config: SearchConfig; score: number; coverage: number; }

/** Pick the best eligible challenger; incumbent wins ties and low-coverage contests. */
export function chooseSearchConfig(candidates: ScoredConfig[], incumbent: SearchConfig): SearchConfig {
  const current = candidates.find((candidate) => JSON.stringify(candidate.config) === JSON.stringify(incumbent));
  if (!current) return incumbent;
  const winner = candidates.filter((candidate) => candidate.coverage >= DREAM_MIN_COVERAGE)
    .sort((a, b) => b.score - a.score)[0];
  return winner && winner.score > current.score + DREAM_MIN_MARGIN ? winner.config : incumbent;
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
  beforeAgentSpawn: (key: string) => void;
  log?: (message: string) => void;
  onAgentComplete?: (result: CommandResult) => void;
  signal: AbortSignal;
  worlds?: ExperimentWorld[];
  incumbent?: SearchConfig;
}

export async function maybeDream(options: DreamOptions): Promise<SearchConfig> {
  const incumbent = options.incumbent ?? readJson<SearchConfig>(path.join(options.loopRoot, "search-config.json")) ?? defaultSearchConfig;
  const worlds = (options.worlds ?? []).filter((world) => world.status === "complete" && validNodes(world).length >= 3);
  const worldIds = worlds.map((world) => world.worldId ?? `${world.fingerprint}:${world.cycle}`);
  const priorDream = readJson<{ worldIds?: string[] }>(path.join(options.loopRoot, "dream-state.json"));
  if (worlds.length < 2 || worldIds.every((id) => priorDream?.worldIds?.includes(id))) return incumbent;
  const scratch = path.join(options.loopRoot, "dream-work");
  fs.mkdirSync(scratch, { recursive: true });
  const proposalFile = path.join(scratch, "configs.json");
  fs.rmSync(proposalFile, { force: true });
  const promptFile = path.join(scratch, "DREAM.md");
  const traces = worlds.slice(-12).map((world) => ({ cycle: world.cycle, config: world.config, baseline: world.baseline, threshold: world.threshold,
    rounds: world.rounds, nodes: world.nodes.map(({ id, parent, kind, round, score, valid, timedOut, cost }) => ({ id, parent, kind, round, score, valid, timedOut, cost })) }));
  writeFileAtomic(promptFile, `Propose up to four search configs as JSON in ${proposalFile}. Schema: {"configs":[{"version":1,"batchSize":1-4,"exploreShare":0-1,"refineTop":1-3,"maxRounds":1-6,"patience":1-3}]}. Incumbent: ${JSON.stringify(incumbent)}. Objective: mean replay value; beta1=${DREAM_BETA1}, beta2=${DREAM_BETA2}. Traces:\n${JSON.stringify(traces, null, 2)}\n`);
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
  const configs = [incumbent, ...proposed, ...neighbors(incumbent)];
  const scored = configs.map((config) => ({ config, ...scoreSearchConfig(worlds, config) }));
  const adopted = chooseSearchConfig(scored, incumbent);
  fs.mkdirSync(options.loopRoot, { recursive: true });
  writeJson(path.join(options.loopRoot, "search-config.json"), adopted);
  fs.appendFileSync(path.join(options.loopRoot, "dreams.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), worldIds: worlds.map((world) => world.cycle), incumbent, candidates: scored, adopted })}\n`);
  writeJson(path.join(options.loopRoot, "dream-state.json"), { worldIds });
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
