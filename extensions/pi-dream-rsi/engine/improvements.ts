/**
 * Improvements waiting to be applied.
 *
 * Dream-RSI never writes to your source tree. Every candidate lives in `.dream-rsi/work/r<iter>/<cell>/`,
 * so "the loop found something better" and "your code changed" are two different events. This module is
 * how the first one gets noticed:
 *
 *   history/seed/score.json   what your code measured when the task was configured (the reference point)
 *   history/applied.jsonl     candidates you have already copied back
 *   -> pending: the best evaluated candidate that beats the seed score and has not been applied yet
 *
 * The comparison is on the engine's normalised score (higher is better) with a small relative threshold,
 * so noise-level differences do not nag.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { copyWorkspace, runShellCommand } from "../agent/runner.ts";
import { DiscoveryTree, type TreeNode } from "./tree.ts";
import { historyDir, iterationDir, readJson, workRoot, writeJson } from "./world.ts";
import { interpretEvaluation, readScoreFile, type ScoreOutcome } from "./live.ts";
import { readTask, type TaskConfig } from "./task.ts";

/** A candidate has to beat the recorded baseline by this much (relative) before it is worth reporting. */
export const MIN_IMPROVEMENT_RATIO = 0.01;

export interface SeedMeasurement {
  /** Normalised score (higher is better), matching the engine's convention. */
  score: number | null;
  raw_score: number | null;
  fail_class: string;
  error: string | null;
  measured_at: string;
  /** The workspace the measurement ran in, relative to the project when possible. */
  workspace: string;
  seconds: number;
}

export interface AppliedRecord {
  iteration: number;
  cell: string;
  score: number | null;
  applied_at: string;
  paths: string[];
  target: string;
}

export interface Candidate {
  iteration: number;
  cell: string;
  /** Normalised score used for comparison. */
  score: number;
  raw_score: number | null;
  fail_class: string;
  /** Where the candidate's code lives now (absolute). */
  workspace: string | null;
  /** The declared candidate program inside that workspace (absolute), when it exists. */
  program: string | null;
}

export interface ImprovementReport {
  seed: SeedMeasurement | null;
  applied: { score: number | null; count: number } | null;
  best: Candidate | null;
  /**
   * Set when there is something worth applying right now. `gain_pct` is null when the reference score is
   * zero (a percentage of nothing means nothing); `delta` always carries the raw improvement.
   */
  pending: (Candidate & { gain_pct: number | null; delta: number; relative_to: "seed" | "applied" }) | null;
  /** Human-readable reason when nothing is pending. */
  reason: string;
}

export function seedScorePath(dreamRoot: string): string {
  return path.join(historyDir(dreamRoot), "seed", "score.json");
}

export function appliedLogPath(dreamRoot: string): string {
  return path.join(historyDir(dreamRoot), "applied.jsonl");
}

/** The candidate program a candidate workspace holds, if the file is there. */
function programIn(workspace: string | null, task: TaskConfig, projectDir: string): string | null {
  if (!workspace) return null;
  const absolute = path.isAbsolute(workspace) ? workspace : path.resolve(projectDir, workspace);
  const file = path.join(absolute, task.eval_program);
  return fs.existsSync(file) ? file : null;
}

/**
 * Score the seed workspace once, so "better than what you have" has a measurement behind it instead of
 * an assumption. Runs in a throwaway copy: the seed itself is never touched.
 */
export async function measureSeed(options: {
  dreamRoot: string;
  projectDir: string;
  task: TaskConfig;
  log?: (message: string) => void;
}): Promise<SeedMeasurement | null> {
  const { dreamRoot, projectDir, task } = options;
  const log = options.log ?? (() => {});
  const seed = path.resolve(projectDir, task.workspace);
  if (!fs.existsSync(seed)) return null;
  const scratch = path.join(historyDir(dreamRoot), "seed-workspace");
  const started = Date.now();
  try {
    copyWorkspace(seed, scratch, { exclude: [dreamRoot, path.join(projectDir, ".git")] });
    const command = await runShellCommand(task.score_program, {
      cwd: scratch,
      timeoutMs: task.evaluator_timeout_ms,
      logPath: path.join(historyDir(dreamRoot), "seed", "score.log"),
    });
    const outcome: ScoreOutcome = interpretEvaluation(task, command, readScoreFile(scratch, task));
    const measurement: SeedMeasurement = {
      score: outcome.score,
      raw_score: outcome.raw_score,
      fail_class: outcome.fail_class,
      error: outcome.error,
      measured_at: new Date().toISOString(),
      workspace: path.relative(projectDir, seed) || seed,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    writeJson(seedScorePath(dreamRoot), measurement);
    log(
      `[seed] your code measures ${outcome.raw_score ?? "n/a"} (${outcome.fail_class}) in ${measurement.seconds}s — the reference point for every candidate`,
    );
    return measurement;
  } catch (error) {
    log(`[seed] baseline measurement failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function readSeedMeasurement(dreamRoot: string): SeedMeasurement | null {
  return readJson<SeedMeasurement>(seedScorePath(dreamRoot));
}

export function readApplied(dreamRoot: string): AppliedRecord[] {
  const file = appliedLogPath(dreamRoot);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as AppliedRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is AppliedRecord => record !== null);
}

export function recordApplied(dreamRoot: string, record: AppliedRecord): void {
  fs.mkdirSync(historyDir(dreamRoot), { recursive: true });
  fs.appendFileSync(appliedLogPath(dreamRoot), `${JSON.stringify(record)}\n`, "utf8");
}

/** Best successful candidate of one recorded iteration. */
function bestOfIteration(dreamRoot: string, iteration: number, task: TaskConfig, projectDir: string): Candidate | null {
  const file = path.join(iterationDir(dreamRoot, iteration), "tree.json");
  const json = readJson<import("./tree.ts").TreeJSON>(file);
  if (!json) return null;
  const tree = DiscoveryTree.fromJSON(json);
  let best: TreeNode | null = null;
  for (const node of tree.list()) {
    if (typeof node.score !== "number") continue;
    if (node.error !== null || node.fail_class !== "ok") continue;
    if (!best || node.score > (best.score ?? Number.NEGATIVE_INFINITY)) best = node;
  }
  if (!best) return null;
  const workspace = best.workspace ? path.resolve(projectDir, best.workspace) : null;
  return {
    iteration,
    cell: best.meta.cell_id,
    score: best.score as number,
    raw_score: best.raw_score,
    fail_class: best.fail_class,
    workspace,
    program: programIn(best.workspace, task, projectDir),
  };
}

/** Every iteration that has a recorded world, ascending. */
function recordedIterations(dreamRoot: string): number[] {
  const dir = path.join(dreamRoot, "trace_pool");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => /^iter(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}

/**
 * What is worth applying, and why not when nothing is. `projectDir` defaults to the parent of the dream
 * root, which is what the tools use.
 */
export function improvements(dreamRoot: string, task?: TaskConfig, projectDir?: string): ImprovementReport {
  const resolvedTask = task ?? readTask(dreamRoot);
  const project = projectDir ?? path.dirname(dreamRoot);
  const seed = readSeedMeasurement(dreamRoot);
  const appliedRecords = readApplied(dreamRoot);
  const appliedScores = appliedRecords.map((record) => record.score).filter((score): score is number => typeof score === "number");
  const appliedBest = appliedScores.length > 0 ? Math.max(...appliedScores) : null;

  let best: Candidate | null = null;
  for (const iteration of recordedIterations(dreamRoot)) {
    const candidate = bestOfIteration(dreamRoot, iteration, resolvedTask, project);
    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  }

  const unreachable =
    "no candidate workspace on disk for the best score (workspaces are per iteration: check .dream-rsi/work/)";
  if (!best) {
    return { seed, applied: appliedBest === null ? null : { score: appliedBest, count: appliedRecords.length }, best: null, pending: null, reason: "no successful candidate recorded yet" };
  }
  if (!best.program) {
    return {
      seed,
      applied: appliedBest === null ? null : { score: appliedBest, count: appliedRecords.length },
      best,
      pending: null,
      reason: unreachable,
    };
  }
  if (seed?.score === undefined || seed?.score === null) {
    return {
      seed,
      applied: appliedBest === null ? null : { score: appliedBest, count: appliedRecords.length },
      best,
      pending: null,
      reason: "your own code has not been measured yet, so there is no reference point (run dream_rsi_init)",
    };
  }

  // The reference point is whichever is better: your measured code, or the last thing you applied.
  const reference = appliedBest !== null && appliedBest > seed.score ? appliedBest : seed.score;
  const relative_to: "seed" | "applied" = appliedBest !== null && appliedBest > seed.score ? "applied" : "seed";
  const threshold = reference + Math.abs(reference) * MIN_IMPROVEMENT_RATIO;
  if (best.score <= threshold) {
    return {
      seed,
      applied: appliedBest === null ? null : { score: appliedBest, count: appliedRecords.length },
      best,
      pending: null,
      reason:
        `nothing beats ${relative_to === "applied" ? "the last applied candidate" : "your code"} ` +
        `(${reference}${relative_to === "applied" ? "" : ` → best ${best.score}`}) by ${MIN_IMPROVEMENT_RATIO * 100}%`,
    };
  }

  const delta = best.score - reference;
  // A percentage of a zero (or unknown-magnitude) reference is noise, so say the raw delta instead.
  const gain_pct = reference === 0 ? null : Math.round(((delta / Math.abs(reference)) * 100) * 10) / 10;
  return {
    seed,
    applied: appliedBest === null ? null : { score: appliedBest, count: appliedRecords.length },
    best,
    pending: { ...best, gain_pct, delta: Math.round(delta * 1e6) / 1e6, relative_to },
    reason: "improvement pending",
  };
}

/**
 * A specific candidate, resolved through the recorded trees (so it works for runs recorded before the
 * iteration-scoped workspace layout too). Defaults to the best candidate of the newest iteration.
 */
export function findCandidate(
  dreamRoot: string,
  task: TaskConfig,
  projectDir: string,
  iteration?: number,
  cell?: string,
): Candidate | null {
  const iterations = recordedIterations(dreamRoot).slice().reverse();
  for (const candidate_iteration of iterations) {
    if (typeof iteration === "number" && candidate_iteration !== iteration) continue;
    if (typeof cell === "string") {
      const found = bestOfIteration(dreamRoot, candidate_iteration, task, projectDir);
      if (found?.cell === cell) return found;
      if (found === null) continue;
      continue;
    }
    const best = bestOfIteration(dreamRoot, candidate_iteration, task, projectDir);
    if (best) return best;
  }
  return null;
}

/** Absolute path of a candidate workspace, for messaging and for `dream_rsi_apply`. */
export function candidatePath(dreamRoot: string, iteration: number, cell: string): string {
  return path.join(workRoot(dreamRoot), `r${String(iteration).padStart(4, "0")}`, cell);
}
