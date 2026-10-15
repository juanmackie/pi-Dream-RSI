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

import { scoreSeedCopy } from "./apply.ts";
import { DiscoveryTree, type TreeNode } from "./tree.ts";
import { historyDir, iterationDir, readJson, readManifest, workRoot, writeJson } from "./world.ts";
import { programFingerprint, scoreMatchesDirection, scoringFingerprint, type TaskConfig } from "./task.ts";

export interface SeedMeasurement {
  /** Normalised score (higher is better), matching the engine's convention. */
  score: number | null;
  raw_score: number | null;
  fail_class: string;
  valid?: boolean;
  error: string | null;
  measured_at: string;
  /** The workspace the measurement ran in, relative to the project when possible. */
  workspace: string;
  /** The scorer this measurement came from; absent in files written before it was recorded. */
  score_program?: string;
  /**
   * Scoring-contract fingerprint of the task at measure time (`scoringFingerprint`), plus a hash of
   * the measured program's contents. Absent in files written before they were recorded. A mismatch
   * against the current task means this baseline describes a different objective — it cannot serve
   * as the reference point and campaign intake re-measures instead of keeping it.
   */
  fingerprint?: string;
  program_fingerprint?: string;
  seconds: number;
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

export function seedScorePath(dreamRoot: string): string {
  return path.join(historyDir(dreamRoot), "seed", "score.json");
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
  beforeEvaluatorSpawn?: (key: string) => void;
  signal?: AbortSignal;
  exclude?: string[];
}): Promise<SeedMeasurement | null> {
  const { dreamRoot, projectDir, task } = options;
  const log = options.log ?? (() => {});
  const seed = path.resolve(projectDir, task.workspace);
  if (!fs.existsSync(seed)) return null;
  const started = Date.now();
  try {
    const outcome = await scoreSeedCopy({
      dreamRoot,
      projectDir,
      task,
      scratch: path.join(historyDir(dreamRoot), "seed-workspace"),
      logPath: path.join(historyDir(dreamRoot), "seed", "score.log"),
      beforeEvaluatorSpawn: options.beforeEvaluatorSpawn,
      signal: options.signal,
      evaluatorKey: "seed-measurement",
      exclude: options.exclude,
    });
    const measurement: SeedMeasurement = {
      score: outcome.score,
      raw_score: outcome.raw_score,
      fail_class: outcome.fail_class,
      valid: outcome.valid,
      error: outcome.error,
      measured_at: new Date().toISOString(),
      workspace: path.relative(projectDir, seed) || seed,
      score_program: task.score_program,
      fingerprint: scoringFingerprint(task),
      program_fingerprint: programFingerprint(projectDir, task) ?? undefined,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    // The reference point is overwritten by definition, so keep the previous one. Re-running init after a
    // candidate was applied would otherwise move the goalposts instead of leaving the old number behind.
    const file = seedScorePath(dreamRoot);
    const previous = readSeedMeasurement(dreamRoot);
    if (previous) {
      const stamp = (previous.measured_at ?? measurement.measured_at).replace(/[:.]/g, "-");
      const kept = path.join(historyDir(dreamRoot), "seed", `score.${stamp}.json`);
      if (kept !== file) {
        fs.copyFileSync(file, kept);
        log(`[seed] previous reference kept at ${path.relative(dreamRoot, kept)}`);
      }
    }
    writeJson(file, measurement);
    log(
      `[seed] your code measures ${outcome.raw_score ?? "n/a"} (${outcome.fail_class}) in ${measurement.seconds}s — the reference point for every candidate`,
    );
    return measurement;
  } catch (error) {
    log(`[seed] baseline measurement failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function readSeedMeasurement(dreamRoot: string): SeedMeasurement | null {
  return readJson<SeedMeasurement>(seedScorePath(dreamRoot));
}

/**
 * The tree root's starting score: the cycle-1 baseline when it describes the current task,
 * otherwise the measured seed score, otherwise null. Without the seed fallback an idle replay
 * scores 0 while a cost-task policy scores negative, so doing nothing always wins.
 */
function bestOfIteration(
  dreamRoot: string,
  iteration: number,
  task: TaskConfig,
  projectDir: string,
  skip?: Set<string>,
): Candidate | null {
  const manifest = readManifest(dreamRoot, iteration);
  if (manifest?.task_fingerprint !== undefined && manifest.task_fingerprint !== scoringFingerprint(task)) {
    return null; // recorded under a different scoring contract: not comparable with this task
  }
  const file = path.join(iterationDir(dreamRoot, iteration), "tree.json");
  const json = readJson<import("./tree.ts").TreeJSON>(file);
  if (!json) return null;
  const tree = DiscoveryTree.fromJSON(json);
  let best: TreeNode | null = null;
  for (const node of tree.list()) {
    if (typeof node.score !== "number") continue;
    if (node.error !== null || node.fail_class !== "ok") continue;
    if (!scoreMatchesDirection(task, node.score, node.raw_score)) continue;
    if (skip?.has(node.meta.cell_id)) continue;
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
function candidateByCell(
  dreamRoot: string,
  iteration: number,
  cell: string,
  task: TaskConfig,
  projectDir: string,
): Candidate | null {
  const manifest = readManifest(dreamRoot, iteration);
  if (manifest?.task_fingerprint !== undefined && manifest.task_fingerprint !== scoringFingerprint(task)) {
    return null;
  }
  const file = path.join(iterationDir(dreamRoot, iteration), "tree.json");
  const json = readJson<import("./tree.ts").TreeJSON>(file);
  if (!json) return null;
  const node = DiscoveryTree.fromJSON(json).get(cell);
  if (!node || typeof node.score !== "number") return null;
  if (node.error !== null || node.fail_class !== "ok") return null;
  if (!scoreMatchesDirection(task, node.score, node.raw_score)) return null;
  const workspace = node.workspace ? path.resolve(projectDir, node.workspace) : null;
  return {
    iteration,
    cell: node.meta.cell_id,
    score: node.score,
    raw_score: node.raw_score,
    fail_class: node.fail_class,
    workspace,
    program: programIn(node.workspace, task, projectDir),
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
      // Look the requested cell up directly, not just each iteration's winner: a runner-up is a valid
      // candidate, and the same cell id exists in every iteration, so the iteration must be honoured.
      const found = candidateByCell(dreamRoot, candidate_iteration, cell, task, projectDir);
      if (found) return found;
      continue;
    }
    const best = bestOfIteration(dreamRoot, candidate_iteration, task, projectDir);
    if (best) return best;
  }
  return null;
}

/** Absolute path of a candidate workspace, for messaging and patch validation. */
export function candidatePath(dreamRoot: string, iteration: number, cell: string): string {
  return path.join(workRoot(dreamRoot), `r${String(iteration).padStart(4, "0")}`, cell);
}
