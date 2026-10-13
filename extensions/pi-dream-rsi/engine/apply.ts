/**
 * Applying a candidate: the one step that writes to the user's workspace.
 *
 * A candidate's score was measured in its own attempt workspace. That number does not prove anything
 * about the user's code after a copy: the candidate can depend on files that are not copied, and the
 * user's files can have changed since the cycle started. So an apply is a checked transaction:
 *
 *   1. find target files that changed since the cycle took its seed snapshot (an apply discards them)
 *   2. score a scratch copy of the workspace without and with the files — same scorer, same procedure
 *   3. write only when the second score is valid and better, and write all files or none
 *
 * Nothing here decides *which* candidate to take; that is `improvements.ts` and `candidates.ts`.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { copyWorkspace, runShellCommand } from "../agent/runner.ts";
import { interpretEvaluation, readScoreFile, type ScoreOutcome } from "./live.ts";
import { nodeWorkspace, workRoot } from "./world.ts";
import type { TaskConfig } from "./task.ts";

/** One file an apply copies from the candidate workspace (`from`) over the user's workspace (`to`). */
export interface ApplyFile {
  /** Workspace-relative path with forward slashes. */
  relative: string;
  from: string;
  to: string;
  /** Line counts before and after, for the report. */
  before: number;
  after: number;
}

/** True when `candidate` is `parent` or lives inside it, using resolved (real) paths. */
function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve `relative` inside `root` and refuse any symlink/junction escape.
 *
 * A string-prefix check is not enough on Windows: a junction or symlink component can point outside
 * either workspace while the textual path still looks contained. This walks each existing component,
 * resolves its real path, and rejects the moment one leaves the root.
 */
export function resolveWithinRoot(root: string, relative: string): string | null {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  const parts = relative.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  let current = realRoot;
  for (let index = 0; index < parts.length; index += 1) {
    const candidate = path.join(current, parts[index]);
    if (!fs.existsSync(candidate)) {
      current = path.join(current, ...parts.slice(index));
      break;
    }
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      return null;
    }
    if (!isWithin(realRoot, real)) return null;
    current = real;
  }
  return isWithin(realRoot, current) ? current : null;
}

/**
 * Score one state of the seed workspace in a throwaway copy: the workspace as it is, or with `overlay`
 * files laid on top. The seed itself is never touched, and the copy is removed afterwards.
 *
 * The reference measurement (`measureSeed`) and apply verification both use this, so "your code
 * measures X" and "your code with the candidate measures Y" come from the same instrument.
 */
export async function scoreSeedCopy(options: {
  dreamRoot: string;
  projectDir: string;
  task: TaskConfig;
  /** Where the throwaway copy goes. Must be free for this call: concurrent calls need different paths. */
  scratch: string;
  logPath: string;
  overlay?: Pick<ApplyFile, "relative" | "from">[];
  signal?: AbortSignal;
  beforeEvaluatorSpawn?: (key: string) => void;
  evaluatorKey?: string;
  exclude?: string[];
}): Promise<ScoreOutcome> {
  const { dreamRoot, projectDir, task, scratch } = options;
  const seed = path.resolve(projectDir, task.workspace);
  try {
    await copyWorkspace(seed, scratch, { exclude: [dreamRoot, path.join(projectDir, ".git"), ...(options.exclude ?? [])] });
    for (const file of options.overlay ?? []) {
      // The copy keeps the seed's symlinks. A link that leaves the copy would let this write reach
      // the real workspace before anything was verified.
      const target = resolveWithinRoot(scratch, file.relative);
      if (!target) throw new Error(`${file.relative}: resolves outside the scratch copy (symlink/junction)`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.from, target);
    }
    // The copy inherits any score file already in the seed workspace; remove it so only this
    // measurement's own output can be read back.
    fs.rmSync(path.join(scratch, task.score_path), { force: true });
    const command = await runShellCommand(task.score_program, {
      cwd: scratch,
      timeoutMs: task.evaluator_timeout_ms,
      logPath: options.logPath,
      signal: options.signal,
      beforeSpawn: () => options.beforeEvaluatorSpawn?.(options.evaluatorKey ?? "apply-score"),
    });
    return interpretEvaluation(task, command, readScoreFile(scratch, task));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function fileDigest(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Target files whose content is neither the cycle's seed snapshot nor the candidate's: the user (or an
 * earlier apply) changed them after the candidate's cycle started, and a copy would discard that change.
 * A cycle recorded before seed snapshots existed has nothing to compare against and reports none.
 */
export function locallyChanged(dreamRoot: string, iteration: number, files: ApplyFile[]): string[] {
  const snapshot = nodeWorkspace(dreamRoot, iteration, "seed");
  if (!fs.existsSync(snapshot)) return [];
  return files
    .filter((file) => {
      const current = fileDigest(file.to);
      return current !== fileDigest(path.join(snapshot, file.relative)) && current !== fileDigest(file.from);
    })
    .map((file) => file.relative);
}

/** Content identity of every target, to notice a file that changed while verification ran. */
export function targetState(files: ApplyFile[]): string {
  return files.map((file) => `${file.relative}:${fileDigest(file.to) ?? "absent"}`).join("\n");
}

export interface ApplyVerification {
  /** The user's workspace as it is now. */
  before: ScoreOutcome;
  /** The same workspace with the files applied. */
  after: ScoreOutcome;
  /** True when `after` is a successful evaluation and scores higher than `before`. */
  improved: boolean;
  /** Why this is not a measured improvement; null when it is one. */
  reason: string | null;
}

/** The engine's success rule: an evaluation that ran, reported no error, and has a finite score. */
function scored(outcome: ScoreOutcome): outcome is ScoreOutcome & { score: number } {
  return outcome.fail_class === "ok" && outcome.error === null && typeof outcome.score === "number";
}

function describe(outcome: ScoreOutcome): string {
  if (scored(outcome)) return String(outcome.raw_score ?? outcome.score);
  return `no score (${outcome.fail_class}${outcome.error ? `: ${outcome.error}` : ""})`;
}

/**
 * Measure the user's workspace without and with the files, one run each, in scratch copies. One pair
 * is a floor, not a statistic: it catches a broken or worse result, and a noisy scorer stays noisy.
 */
export async function verifyApply(options: {
  dreamRoot: string;
  projectDir: string;
  task: TaskConfig;
  files: ApplyFile[];
  /** Scorer logs land here as `before.log` and `after.log`. */
  evidenceDir: string;
  signal?: AbortSignal;
  beforeEvaluatorSpawn?: (key: string) => void;
}): Promise<ApplyVerification> {
  const { dreamRoot, projectDir, task, files, evidenceDir, signal, beforeEvaluatorSpawn } = options;
  const scratch = path.join(workRoot(dreamRoot), `apply-verify-${process.pid}-${Date.now()}`);
  // A cancelled run is not a verdict: stop instead of comparing a score with a killed evaluator.
  const stopIfCancelled = (): void => {
    if (signal?.aborted) throw new Error("verification was cancelled");
  };
  stopIfCancelled();
  const before = await scoreSeedCopy({
    dreamRoot, projectDir, task, signal, beforeEvaluatorSpawn,
    evaluatorKey: "apply-before",
    scratch: `${scratch}-before`,
    logPath: path.join(evidenceDir, "before.log"),
  });
  stopIfCancelled();
  const after = await scoreSeedCopy({
    dreamRoot, projectDir, task, signal, beforeEvaluatorSpawn,
    evaluatorKey: "apply-after",
    scratch: `${scratch}-after`,
    logPath: path.join(evidenceDir, "after.log"),
    overlay: files,
  });
  stopIfCancelled();
  const improved = scored(after) && (!scored(before) || after.score > before.score);
  return {
    before,
    after,
    improved,
    reason: improved ? null : `with these files your code measures ${describe(after)}, against ${describe(before)} without them`,
  };
}

/**
 * Copy every file over its target, or none. The previous version of each replaced file is kept under
 * `backupDir` first; when a later copy fails, the files already written get their previous content
 * back (and files the apply created are removed) before the error is rethrown.
 * Returns the relative paths that had a previous version.
 */
export function replaceFiles(files: ApplyFile[], backupDir: string): string[] {
  const written: { file: ApplyFile; backup: string | null }[] = [];
  try {
    for (const file of files) {
      let backup: string | null = null;
      if (fs.existsSync(file.to)) {
        backup = path.join(backupDir, file.relative);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(file.to, backup);
      }
      // Recorded before the copy, so a copy that fails half-way is rolled back too.
      written.push({ file, backup });
      fs.mkdirSync(path.dirname(file.to), { recursive: true });
      fs.copyFileSync(file.from, file.to);
    }
  } catch (error) {
    for (const { file, backup } of written.reverse()) {
      try {
        if (backup) fs.copyFileSync(backup, file.to);
        else fs.rmSync(file.to, { force: true });
      } catch {
        // Keep restoring the other files; the backup directory still holds this one.
      }
    }
    throw error;
  }
  return written.filter((entry) => entry.backup !== null).map((entry) => entry.file.relative);
}
