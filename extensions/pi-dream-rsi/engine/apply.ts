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

import * as fs from "node:fs";
import * as path from "node:path";

import { copyWorkspace, runShellCommand, type CommandResult } from "../agent/runner.ts";
import { interpretEvaluation, readScoreFile, type ScoreOutcome } from "./live.ts";
import type { RepositoryCommandContainment } from "./containment.ts";
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
  logPath?: string | null;
  overlay?: Pick<ApplyFile, "relative" | "from">[];
  signal?: AbortSignal;
  beforeEvaluatorSpawn?: (key: string) => void;
  evaluatorKey?: string;
  exclude?: string[];
  onCommand?: (command: CommandResult) => void;
  containment?: RepositoryCommandContainment;
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
      logPath: options.logPath ?? null,
      signal: options.signal,
      ...(options.containment ? { containment: { writableRoots: [scratch], ...(options.containment.readonlyRoots ? { readonlyRoots: options.containment.readonlyRoots } : {}) } } : {}),
      beforeSpawn: () => options.beforeEvaluatorSpawn?.(options.evaluatorKey ?? "apply-score"),
    });
    options.onCommand?.(command);
    return { ...interpretEvaluation(task, command, readScoreFile(scratch, task)), processDurationMs: command.durationMs };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
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
