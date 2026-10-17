/** Complete, scope-limited candidate verification and recoverable target promotion. */

import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { copyWorkspace, runShellCommand, type CommandResult } from "../agent/runner.ts";
import { interpretEvaluation, readScoreFile, type ScoreOutcome } from "./live.ts";
import type { ApplyVerification } from "./apply.ts";
import type { TaskConfig } from "./task.ts";
import { runPaired, type MeasurementPlan } from "./measure.ts";

export interface CandidateWrite {
  kind: "write";
  relative: string;
  from: string;
  to: string;
  beforeHash: string | null;
  afterHash: string;
  beforeLines: number;
  afterLines: number;
}

export interface CandidateDelete {
  kind: "delete";
  relative: string;
  to: string;
  beforeHash: string;
  beforeLines: number;
}

export type CandidatePatch = CandidateWrite | CandidateDelete;

export interface CandidateVerificationPair {
  before: ScoreOutcome;
  after: ScoreOutcome;
  gain: number | null;
  rawGain: number | null;
}

export interface CandidatePatchVerification extends ApplyVerification {
  pairs: CandidateVerificationPair[];
  medianPairedGain: number | null;
  medianAfter: number | null;
  medianAfterRaw: number | null;
}

export interface GateRun {
  command: string;
  result: CommandResult;
  passed: boolean;
}

const RESERVED = new Set([".git", ".dream-rsi"]);

/**
 * Ephemeral artifacts that test runners and build tools create in a workspace after an
 * evaluation: bytecode caches, test-runner state, dependency trees, virtual environments
 * and build output. They are never candidate changes, so the difference walk ignores them
 * at any depth. Without this skip, a runner that writes its cache (pytest, coverage, a
 * compiler) turns every candidate into an out-of-scope change.
 */
const EPHEMERAL = new Set([
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".pytype", ".tox", ".nox",
  "node_modules", ".venv", "venv", ".cache", ".gradle", "target", ".turbo", ".parcel-cache",
  ".vite", ".next", ".nuxt", ".svelte-kit", ".angular", ".output", ".coverage", "htmlcov", ".nyc_output",
]);

function digest(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeRelative(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error("patch path must be a non-empty relative path");
  const parts = value.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes(":"))) throw new Error(`unsafe patch path: ${value}`);
  if (parts.some((part) => RESERVED.has(part.toLowerCase()))) throw new Error(`protected path cannot be changed: ${value}`);
  return parts.join("/");
}

function normalizeScopes(scopes?: string[]): string[] | null {
  if (!scopes || scopes.length === 0) return null;
  return scopes.map((scope) => {
    if (scope === "." || scope === "./") return "";
    return safeRelative(scope.replace(/[\\/]$/, ""));
  });
}

function withinScopes(relative: string, scopes: string[] | null): boolean {
  if (scopes === null) return true;
  const candidate = process.platform === "win32" ? relative.toLowerCase() : relative;
  return scopes.some((scope) => {
    const normalized = process.platform === "win32" ? scope.toLowerCase() : scope;
    return normalized === "" || candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}

function ensureDirectoryRoot(root: string): string {
  const real = fs.realpathSync(root);
  if (!fs.statSync(real).isDirectory()) throw new Error(`not a directory: ${root}`);
  return real;
}

interface FileEntry { hash: string; lines: number; mode: number; absolute: string }

/**
 * Cache-like paths that must stay candidate-visible, compared as repository-relative paths,
 * directories and files alike. A path the repository tracks is repository content: `treeFiles`
 * keeps it visible, and this walk descends into a visible cache directory so nested cache
 * paths are registered too — an agent edit or a review-window change inside tracked content
 * cannot escape the patch and the scope check. A cache-shaped path without tracked files was
 * created by runner activity and stays skipped. Without git evidence a present path counts as
 * repository content, which is the safe direction for the scope check.
 */
function visibleCachePaths(rootInput: string, repoRoot?: string): Set<string> {
  const root = ensureDirectoryRoot(rootInput);
  const visible = new Set<string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const lower = entry.name.toLowerCase();
      if (RESERVED.has(lower)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (EPHEMERAL.has(lower)) {
        if (repoRoot && gitTracksPath(repoRoot, relative) === false) continue;
        visible.add(process.platform === "win32" ? relative.toLowerCase() : relative);
      }
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
    }
  };
  walk(root, "");
  return visible;
}

/** null when git evidence is unavailable; false when the path holds no tracked files. */
function gitTracksPath(repoRoot: string, relative: string): boolean | null {
  const result = spawnSync("git", ["-C", repoRoot, "--literal-pathspecs", "ls-files", "-z", "--", relative],
    { encoding: "buffer", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.length > 0;
}

function treeFiles(rootInput: string, excluded: string[] = [], visibleEphemeral: Set<string> = new Set()): Map<string, FileEntry> {
  const root = ensureDirectoryRoot(rootInput);
  const files = new Map<string, FileEntry>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const lower = entry.name.toLowerCase();
      if (RESERVED.has(lower)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const comparedRelative = process.platform === "win32" ? relative.toLowerCase() : relative;
      if (EPHEMERAL.has(lower) && !visibleEphemeral.has(comparedRelative)) continue;
      if (excluded.some((item) => {
        const comparedItem = process.platform === "win32" ? item.toLowerCase() : item;
        return comparedRelative === comparedItem || comparedRelative.startsWith(`${comparedItem}/`);
      })) continue;
      safeRelative(relative);
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`symbolic links are not supported in candidate scope: ${relative}`);
      if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isFile()) {
        const bytes = fs.readFileSync(absolute);
        const text = bytes.toString("utf8");
        files.set(relative, { hash: digest(bytes), lines: text.length === 0 ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0), mode: stat.mode & 0o777, absolute });
      } else throw new Error(`unsupported filesystem entry in candidate scope: ${relative}`);
    }
  };
  walk(root, "");
  return files;
}

function assertModeCompatible(relative: string, before: FileEntry | undefined, after: FileEntry | undefined): void {
  if (before && after && before.mode !== after.mode) throw new Error(`file mode changes are not supported: ${relative}`);
  if (after && (after.mode & 0o111) !== 0) throw new Error(`executable file mode is not supported: ${relative}`);
}

/** Build a deterministic full file patch between a cycle snapshot and candidate, targeted at the live tree. */
export function buildCandidatePatch(options: {
  cycleSeedRoot: string;
  targetRoot: string;
  candidateRoot: string;
  scope?: string[];
  /** Workspace-relative evaluator/generated artifacts that are never candidate changes. */
  exclude?: string[];
}): CandidatePatch[] {
  const seedRoot = ensureDirectoryRoot(options.cycleSeedRoot);
  const targetRoot = ensureDirectoryRoot(options.targetRoot);
  const candidateRoot = ensureDirectoryRoot(options.candidateRoot);
  const scopes = normalizeScopes(options.scope);
  const excluded = normalizeScopes(options.exclude) ?? [];
  const visibleEphemeral = visibleCachePaths(seedRoot, targetRoot);
  const seed = treeFiles(seedRoot, excluded, visibleEphemeral);
  treeFiles(targetRoot, excluded, visibleEphemeral);
  const candidate = treeFiles(candidateRoot, excluded, visibleEphemeral);
  const relatives = [...new Set([...seed.keys(), ...candidate.keys()])].sort((a, b) => a.localeCompare(b));
  const patch: CandidatePatch[] = [];
  for (const relative of relatives) {
    const before = seed.get(relative);
    const after = candidate.get(relative);
    if (before?.hash === after?.hash) continue;
    if (!withinScopes(relative, scopes)) throw new Error(`candidate changed path outside declared scope: ${relative}`);
    assertModeCompatible(relative, before, after);
    const target = path.join(targetRoot, ...relative.split("/"));
    if (!before || after) {
      if (!after) continue;
      patch.push({ kind: "write", relative, from: after.absolute, to: target, beforeHash: before?.hash ?? null, afterHash: after.hash, beforeLines: before?.lines ?? 0, afterLines: after.lines });
    } else {
      patch.push({ kind: "delete", relative, to: target, beforeHash: before.hash, beforeLines: before.lines });
    }
  }
  return patch;
}

function desiredHash(operation: CandidatePatch): string | null {
  return operation.kind === "write" ? operation.afterHash : null;
}

/**
 * Fingerprint of every candidate-visible file under a root: relative path,
 * content hash, and mode. The campaign takes it around candidate review so
 * drift outside the re-verified paths is detected before a patch is applied.
 * Cache visibility is anchored to the cycle seed, exactly as in
 * `buildCandidatePatch`, and excluded generated artifacts do not participate.
 */
export function workspaceDigest(options: { root: string; cycleSeedRoot?: string; repoRoot?: string; exclude?: string[] }): string {
  const root = ensureDirectoryRoot(options.root);
  const excluded = normalizeScopes(options.exclude) ?? [];
  const anchor = ensureDirectoryRoot(options.cycleSeedRoot ?? root);
  const files = treeFiles(root, excluded, visibleCachePaths(anchor, options.repoRoot));
  const entries = [...files.entries()]
    .map(([relative, entry]) => `${process.platform === "win32" ? relative.toLowerCase() : relative}\u0000${entry.hash}\u0000${entry.mode}`)
    .sort((a, b) => a.localeCompare(b));
  return digest(JSON.stringify(entries));
}

export class WorkspaceDriftDuringApplyError extends Error {
  constructor() {
    super("target workspace changed immediately before or during promotion outside the re-verified patch paths");
    this.name = "WorkspaceDriftDuringApplyError";
  }
}

function fileHashOrNull(file: string, root: string): string | null {
  const resolved = resolveSafe(root, file);
  if (!resolved || !fs.existsSync(resolved)) return null;
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`target is not a regular file: ${file}`);
  return digest(fs.readFileSync(resolved));
}

function assertNoSymlinkPath(file: string): void {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`symbolic link in candidate patch input: ${file}`);
  }
}

function resolveSafe(rootInput: string, candidate: string): string | null {
  const root = ensureDirectoryRoot(rootInput);
  const absolute = path.resolve(candidate);
  if (!isWithin(root, absolute)) return null;
  let current = root;
  const relative = path.relative(root, absolute);
  const parts = relative ? relative.split(path.sep) : [];
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    if (!fs.existsSync(current)) {
      current = path.join(current, ...parts.slice(i + 1));
      break;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are not supported: ${path.relative(root, current)}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`parent is not a directory: ${path.relative(root, current)}`);
  }
  return current;
}

function validatePatchEntry(root: string, operation: { relative: string; to: string }): string {
  const relative = safeRelative(operation.relative);
  if (relative !== operation.relative) throw new Error(`patch path must use normalized forward slashes: ${operation.relative}`);
  const target = resolveSafe(root, operation.to);
  const expected = path.resolve(root, ...relative.split("/"));
  if (!target || path.resolve(target) !== expected) throw new Error(`patch target does not match declared path: ${relative}`);
  return target;
}

/** Conflicts are current targets that are neither the cycle preimage nor the desired postimage. */
export function patchConflicts(options: { cycleSeedRoot: string; patch: CandidatePatch[] }): string[] {
  const seedRoot = ensureDirectoryRoot(options.cycleSeedRoot);
  const conflicts: string[] = [];
  for (const operation of options.patch) {
    const relative = safeRelative(operation.relative);
    const seedPath = path.join(seedRoot, ...relative.split("/"));
    const expectedBefore = operation.kind === "write" ? operation.beforeHash : operation.beforeHash;
    const seedHash = fileHashOrNull(seedPath, seedRoot);
    if (seedHash !== expectedBefore) throw new Error(`patch preimage does not match cycle snapshot: ${relative}`);
    const targetRoot = rootForTarget(operation.to, relative);
    const target = validatePatchEntry(targetRoot, operation);
    const actual = fileHashOrNull(target, targetRoot);
    if (actual !== expectedBefore && actual !== desiredHash(operation)) conflicts.push(relative);
  }
  return conflicts;
}

function rootForTarget(target: string, relative: string): string {
  const parts = relative.split("/");
  let root = path.resolve(target);
  for (let index = 0; index < parts.length; index += 1) root = path.dirname(root);
  if (path.resolve(root, ...parts) !== path.resolve(target)) throw new Error(`patch target does not match declared path: ${relative}`);
  return root;
}

function validScore(outcome: ScoreOutcome): outcome is ScoreOutcome & { score: number } {
  return outcome.valid === true && outcome.fail_class === "ok" && outcome.error === null && typeof outcome.score === "number" && Number.isFinite(outcome.score);
}

async function scoreCopy(options: {
  sourceRoot: string; scratch: string; task: TaskConfig; logPath: string; dreamRoot: string;
  signal?: AbortSignal; beforeSpawn?: (key: string) => void; evaluatorKey: string; patch?: CandidatePatch[];
}): Promise<ScoreOutcome> {
  const { sourceRoot, scratch, task, logPath, signal, beforeSpawn, evaluatorKey } = options;
  try {
    await preparePatchedCopy({ sourceRoot, scratch, patch: options.patch });
    const scorePath = resolveSafe(scratch, path.join(scratch, task.score_path));
    if (!scorePath) throw new Error(`score path escapes verification workspace: ${task.score_path}`);
    fs.rmSync(scorePath, { force: true });
    const command = await runShellCommand(task.score_program, {
      cwd: scratch,
      timeoutMs: task.evaluator_timeout_ms,
      logPath,
      signal,
      beforeSpawn: () => beforeSpawn?.(evaluatorKey),
    });
    return interpretEvaluation(task, command, readScoreFile(scratch, task));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Copy a source tree and apply the complete verified patch into a disposable workspace. */
export async function preparePatchedCopy(options: {
  sourceRoot: string;
  scratch: string;
  patch?: CandidatePatch[];
}): Promise<void> {
  await copyWorkspace(options.sourceRoot, options.scratch, {
    exclude: [path.join(options.sourceRoot, ".git"), path.join(options.sourceRoot, ".dream-rsi")],
  });
  for (const operation of options.patch ?? []) {
    const target = resolveSafe(options.scratch, path.join(options.scratch, ...operation.relative.split("/")));
    if (!target) throw new Error(`patch escaped verification workspace: ${operation.relative}`);
    if (operation.kind === "delete") fs.rmSync(target, { force: true });
    else {
      if (digest(fs.readFileSync(operation.from)) !== operation.afterHash) throw new Error(`candidate patch input changed: ${operation.relative}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(operation.from, target);
    }
  }
}

/** Run one correctness command against a clean copy, optionally with the complete candidate patch. */
export async function runCampaignGate(options: {
  sourceRoot: string;
  scratch: string;
  command: string;
  timeoutMs: number;
  logPath?: string | null;
  signal?: AbortSignal;
  beforeSpawn?: (key: string) => void;
  key: string;
  patch?: CandidatePatch[];
}): Promise<GateRun> {
  try {
    await preparePatchedCopy({ sourceRoot: options.sourceRoot, scratch: options.scratch, patch: options.patch });
    const result = await runShellCommand(options.command, {
      cwd: options.scratch,
      timeoutMs: options.timeoutMs,
      logPath: options.logPath ?? null,
      signal: options.signal,
      beforeSpawn: () => options.beforeSpawn?.(options.key),
    });
    return { command: options.command, result, passed: result.ok && !result.timedOut && !result.aborted };
  } finally {
    fs.rmSync(options.scratch, { recursive: true, force: true });
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

/** Score the live target and the complete candidate patch in independent scratch workspaces. */
export async function verifyCandidatePatch(options: {
  dreamRoot: string;
  projectDir: string;
  task: TaskConfig;
  patch: CandidatePatch[];
  evidenceDir: string;
  signal?: AbortSignal;
  beforeSpawn?: (key: string) => void;
  repeats?: 1 | 3;
  minimumGain?: number;
  requireValidBeforeAfter?: boolean;
  measurementPlan?: MeasurementPlan;
}): Promise<CandidatePatchVerification> {
  const { dreamRoot, projectDir, task, patch, evidenceDir, signal, beforeSpawn } = options;
  const targetRoot = path.resolve(projectDir, task.workspace);
  ensureDirectoryRoot(targetRoot);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const scratchBase = path.join(evidenceDir, `candidate-${process.pid}-${Date.now()}`);
  const stop = (): void => { if (signal?.aborted) throw new Error("candidate verification was cancelled"); };
  stop();
  if (options.measurementPlan) {
    const outcomes = new Map<string, ScoreOutcome>();
    const measured = await runPaired({
      plan: options.measurementPlan,
      higherIsBetter: task.higher_is_better,
      instrument: async ({ condition, pair, order, baseline }) => {
        stop();
        const outcome = await scoreCopy({
          sourceRoot: targetRoot,
          scratch: `${scratchBase}-${baseline ? `baseline${order}` : `pair${pair}-${condition}`}`,
          task,
          dreamRoot,
          logPath: path.join(evidenceDir, `measure-${order}-${condition}.log`),
          signal,
          beforeSpawn,
          evaluatorKey: `candidate-${baseline ? "baseline" : condition}:pair${pair}`,
          ...(condition === "after" ? { patch } : {}),
        });
        outcomes.set(`${baseline ? "baseline" : `pair${pair}`}:${condition}:${order}`, outcome);
        return { valid: validScore(outcome), value: typeof outcome.raw_score === "number" ? outcome.raw_score : outcome.score ?? Number.NaN };
      },
    });
    const pairs: CandidateVerificationPair[] = measured.pairs.map((entry, index) => {
      const find = (condition: "before" | "after"): ScoreOutcome => {
        const value = [...outcomes.entries()].find(([key]) => key.startsWith(`pair${index}:${condition}:`))?.[1];
        if (!value) throw new Error(`measurement outcome missing for pair ${index} ${condition}`);
        return value;
      };
      const before = find("before");
      const after = find("after");
      const rawGain = validScore(before) && validScore(after) && typeof before.raw_score === "number" && typeof after.raw_score === "number"
        ? (task.higher_is_better ? after.raw_score - before.raw_score : before.raw_score - after.raw_score)
        : null;
      return { before, after, gain: entry.gain, rawGain };
    });
    const medianPairedGain = median(pairs.map((pair) => pair.gain).filter((gain): gain is number => gain !== null));
    const medianAfter = median(pairs.map((pair) => pair.after).filter(validScore).map((score) => score.score));
    const medianAfterRaw = median(pairs.map((pair) => pair.after).filter(validScore).flatMap((score) => typeof score.raw_score === "number" ? [score.raw_score] : []));
    const first = pairs[0];
    const last = pairs.at(-1);
    const baselineOutcome = [...outcomes.entries()].find(([key]) => key.startsWith("baseline:before:"))?.[1];
    const before = first?.before ?? baselineOutcome ?? { score: null, raw_score: null, valid: false, fail_class: "invalid", error: "no baseline score" };
    const after = last?.after ?? before;
    return {
      before,
      after: { ...after, score: medianAfter, raw_score: medianAfterRaw },
      improved: measured.decision.decision === "accept",
      reason: measured.decision.decision === "accept" ? null : measured.decision.reason,
      pairs,
      medianPairedGain,
      medianAfter,
      medianAfterRaw,
    };
  }
  const expectedPairs = options.repeats ?? 1;
  const minimumGain = options.minimumGain ?? 0;
  const pairs: CandidateVerificationPair[] = [];
  for (let index = 0; index < expectedPairs; index += 1) {
    const before = await scoreCopy({
      sourceRoot: targetRoot, scratch: `${scratchBase}-pair${index}-before`, task, dreamRoot,
      logPath: path.join(evidenceDir, `pair${index}-before.log`), signal, beforeSpawn,
      evaluatorKey: `candidate-before:pair${index}`,
    });
    stop();
    const after = await scoreCopy({
      sourceRoot: targetRoot, scratch: `${scratchBase}-pair${index}-after`, task, dreamRoot,
      logPath: path.join(evidenceDir, `pair${index}-after.log`), signal, beforeSpawn,
      evaluatorKey: `candidate-after:pair${index}`, patch,
    });
    stop();
    const bothValid = validScore(before) && validScore(after);
    const rawGain = validScore(before) && validScore(after) && typeof before.raw_score === "number" && typeof after.raw_score === "number"
      ? (task.higher_is_better ? after.raw_score - before.raw_score : before.raw_score - after.raw_score)
      : null;
    const gain = bothValid ? after.score - before.score : null;
    pairs.push({ before, after, gain, rawGain });
    if (expectedPairs > 1 && (gain === null || (index === 0 && gain <= minimumGain))) break;
  }
  const gains = pairs.map((pair) => pair.gain).filter((gain): gain is number => gain !== null);
  const medianPairedGain = median(gains);
  const medianAfter = median(pairs.map((pair) => pair.after).filter(validScore).map((score) => score.score));
  const medianAfterRaw = median(pairs.map((pair) => pair.after).filter(validScore).flatMap((score) => typeof score.raw_score === "number" ? [score.raw_score] : []));
  const allValid = pairs.every((pair) => validScore(pair.after) && ((options.requireValidBeforeAfter || expectedPairs > 1) ? validScore(pair.before) : true));
  const improved = expectedPairs === 1 && !options.requireValidBeforeAfter
    ? validScore(pairs[0].after) && (!validScore(pairs[0].before) || pairs[0].after.score > pairs[0].before.score)
    : pairs.length === expectedPairs && allValid && medianPairedGain !== null && medianPairedGain > minimumGain;
  const first = pairs[0];
  const last = pairs.at(-1) ?? first;
  if (!first || !last) throw new Error("candidate verification produced no score pairs");
  return {
    before: first.before,
    after: { ...last.after, score: medianAfter, raw_score: medianAfterRaw },
    improved,
    reason: improved ? null : `paired verification did not exceed minimum gain ${minimumGain}; valid before/after scores are required`,
    pairs,
    medianPairedGain,
    medianAfter,
    medianAfterRaw,
  };
}

interface JournalEntry { relative: string; to: string; kind: CandidatePatch["kind"]; beforeHash: string | null; afterHash: string | null; beforeMode: number | null; beforeIdentity: string | null; afterIdentity: string | null; backup: string | null; tombstone: string | null; untouched: boolean; from?: string; }
interface PatchJournal { transactionId: string; seedRoot: string; patchHash: string; state: "prepared" | "applied" | "rolled_back"; written: string[]; backupDir: string; entries: JournalEntry[]; }

function entryExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function danglingLink(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isSymbolicLink()) return false;
    fs.statSync(file);
    return false;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function fileIdentity(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`target is not a regular file: ${file}`);
    return `${String(stat.dev)}:${String(stat.ino)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function patchFingerprint(patch: CandidatePatch[]): string {
  const canonical = patch.map((operation) => ({
    kind: operation.kind,
    relative: operation.relative,
    beforeHash: operation.beforeHash,
    afterHash: desiredHash(operation),
  })).sort((a, b) => a.relative.localeCompare(b.relative));
  return digest(JSON.stringify(canonical));
}

function journalPath(journalDir: string, transactionId: string): string {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(transactionId) || transactionId === "." || transactionId === "..") throw new Error("invalid transaction id");
  return path.join(path.resolve(journalDir), `${transactionId}.json`);
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporary, file);
}

function writeFileAtomic(target: string, contents: Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, contents, { flag: "wx", mode });
  fs.renameSync(temporary, target);
}

function mkdirParents(target: string, root: string): string[] {
  const created: string[] = [];
  let current = path.dirname(target);
  const missing: string[] = [];
  while (current !== root && isWithin(root, current) && !fs.existsSync(current)) { missing.push(current); current = path.dirname(current); }
  if (!isWithin(root, current)) throw new Error(`parent directory escapes target root: ${target}`);
  for (const directory of missing.reverse()) { fs.mkdirSync(directory); created.push(directory); }
  return created;
}

function rollbackJournal(journal: PatchJournal, seedRoot: string): string[] {
  const conflicts: string[] = [];
  const actions: Array<{ entry: JournalEntry; target: string; action: "none" | "restore-delete" | "restore-write" | "remove-add" }> = [];
  for (const entry of [...journal.entries].reverse()) {
    const target = validatePatchEntry(seedRoot, { kind: entry.kind, relative: entry.relative, to: entry.to, ...(entry.kind === "write" ? { from: entry.from!, afterHash: entry.afterHash!, beforeHash: entry.beforeHash, beforeLines: 0, afterLines: 0 } : { beforeHash: entry.beforeHash!, beforeLines: 0 }) } as CandidatePatch);
    if (danglingLink(target)) { conflicts.push(entry.relative); continue; }
    const current = fileHashOrNull(target, seedRoot);
    const identity = fileIdentity(target);
    if (entry.untouched) { actions.push({ entry, target, action: "none" }); continue; }
    if (entry.kind === "delete") {
      const tombstoneExists = entry.tombstone ? (danglingLink(entry.tombstone) || entryExists(entry.tombstone)) : false;
      let tombstoneIdentity: string | null = null;
      if (entry.tombstone && !danglingLink(entry.tombstone) && entryExists(entry.tombstone)) {
        try { tombstoneIdentity = fileIdentity(entry.tombstone); } catch { tombstoneIdentity = null; }
      }
      if (current === entry.beforeHash && identity === entry.beforeIdentity && !tombstoneExists) { actions.push({ entry, target, action: "none" }); continue; }
      if (current === null && entry.tombstone && tombstoneIdentity === entry.beforeIdentity && !danglingLink(entry.tombstone)) {
        actions.push({ entry, target, action: "restore-delete" });
        continue;
      }
      conflicts.push(entry.relative);
      continue;
    }
    if (current === entry.beforeHash && identity === entry.beforeIdentity) { actions.push({ entry, target, action: "none" }); continue; }
    if (current !== entry.afterHash || !entry.afterIdentity || identity !== entry.afterIdentity) { conflicts.push(entry.relative); continue; }
    actions.push({ entry, target, action: entry.backup ? "restore-write" : "remove-add" });
  }
  if (conflicts.length > 0) return conflicts;
  for (const { entry, target, action } of actions) {
    if (action === "restore-delete") fs.renameSync(entry.tombstone!, target);
    else if (action === "restore-write") writeFileAtomic(target, fs.readFileSync(entry.backup!), entry.beforeMode ?? 0o666);
    else if (action === "remove-add") fs.rmSync(target, { force: true });
  }
  for (const entry of journal.entries) {
    if (entry.tombstone && !danglingLink(entry.tombstone) && entryExists(entry.tombstone)) {
      try {
        const identity = fileIdentity(entry.tombstone);
        if (identity && entry.beforeIdentity && identity === entry.beforeIdentity) fs.rmSync(entry.tombstone, { force: true });
      } catch { /* unexpected tombstone type — do not delete an unowned colliding link */ }
    }
  }
  journal.state = "rolled_back";
  return conflicts;
}

/** Reconcile a durable promotion journal. Prepared work is rolled back; committed work returns its receipt. */
export function reconcileCandidatePatch(options: { journalDir: string; transactionId: string }): { state: "none" | "prepared" | "applied" | "rolled_back"; written: string[]; backupDir: string | null } {
  const file = journalPath(options.journalDir, options.transactionId);
  if (!fs.existsSync(file)) return { state: "none", written: [], backupDir: null };
  const journal = JSON.parse(fs.readFileSync(file, "utf8")) as PatchJournal;
  if (journal.transactionId !== options.transactionId || typeof journal.patchHash !== "string" || !["prepared", "applied", "rolled_back"].includes(journal.state)) throw new Error("invalid patch journal");
  if (journal.state === "prepared") {
    const conflicts = rollbackJournal(journal, journal.seedRoot);
    if (conflicts.length) throw new Error(`cannot recover partial promotion; target changed at: ${conflicts.join(", ")}`);
    writeJsonAtomic(file, journal);
    return { state: "prepared", written: [], backupDir: journal.backupDir };
  }
  if (journal.state === "applied") {
    for (const entry of journal.entries) if (entry.tombstone) fs.rmSync(entry.tombstone, { force: true });
  }
  return { state: journal.state, written: journal.state === "applied" ? journal.written : [], backupDir: journal.backupDir };
}

/** Validate all paths and preimages before writing, then promote complete writes/deletes or roll back. */
export function applyCandidatePatch(options: {
  seedRoot: string;
  patch: CandidatePatch[];
  journalDir: string;
  transactionId: string;
  signal?: AbortSignal;
  expectedWorkspaceDigest?: string;
  cycleSeedRoot?: string;
  repoRoot?: string;
  digestExclude?: string[];
}): { written: string[]; backupDir: string } {
  const seedRoot = ensureDirectoryRoot(options.seedRoot);
  const file = journalPath(options.journalDir, options.transactionId);
  const tombstoneExcludes = options.patch
    .filter((operation) => operation.kind === "delete")
    .map((operation) => `${safeRelative(operation.relative)}.dream-rsi-${options.transactionId}.deleted`);
  for (const relative of tombstoneExcludes) {
    const tombstone = path.join(seedRoot, ...relative.split("/"));
    if (entryExists(tombstone)) throw new Error(`promotion tombstone already exists: ${relative}`);
  }
  const digestExclude = [...(options.digestExclude ?? []), ...tombstoneExcludes];
  const assertWorkspaceDigest = (): void => {
    if (options.expectedWorkspaceDigest !== undefined && workspaceDigest({
      root: seedRoot,
      cycleSeedRoot: options.cycleSeedRoot,
      repoRoot: options.repoRoot,
      exclude: digestExclude,
    }) !== options.expectedWorkspaceDigest) throw new WorkspaceDriftDuringApplyError();
  };
  assertWorkspaceDigest();
  if (fs.existsSync(file)) {
    const receipt = reconcileCandidatePatch(options);
    const prior = JSON.parse(fs.readFileSync(file, "utf8")) as PatchJournal;
    if (prior.patchHash !== patchFingerprint(options.patch)) throw new Error("transaction id is already bound to a different candidate patch");
    if (receipt.state === "applied") return { written: receipt.written, backupDir: receipt.backupDir! };
    if (receipt.state === "prepared" || receipt.state === "rolled_back") throw new Error("previous promotion was rolled back; re-verify with a new transaction id");
  }
  const seen = new Set<string>();
  const targets = new Map<string, { operation: CandidatePatch; target: string }>();
  for (const operation of options.patch) {
    const relative = safeRelative(operation.relative);
    if (seen.has(relative)) throw new Error(`duplicate patch path: ${relative}`);
    seen.add(relative);
    const target = validatePatchEntry(seedRoot, operation);
    const currentHash = fileHashOrNull(target, seedRoot);
    if (currentHash !== operation.beforeHash && currentHash !== desiredHash(operation)) throw new Error(`target changed since candidate verification: ${relative}`);
    if (operation.kind === "write") {
      assertNoSymlinkPath(operation.from);
      const fromStat = fs.lstatSync(operation.from);
      if (!fromStat.isFile() || fromStat.isSymbolicLink() || digest(fs.readFileSync(operation.from)) !== operation.afterHash) throw new Error(`candidate patch input changed: ${relative}`);
      if (fromStat.mode & 0o111) throw new Error(`executable file mode is not supported: ${relative}`);
    }
    targets.set(relative, { operation, target });
  }
  if (options.signal?.aborted) throw new Error("promotion was cancelled before writing");

  const backupDir = path.join(path.resolve(options.journalDir), options.transactionId, "backup");
  const entries: JournalEntry[] = [];
  const changed: string[] = [];
  const createdDirs: string[] = [];
  for (const { operation, target } of targets.values()) {
    const currentHash = fileHashOrNull(target, seedRoot);
    const wantedHash = desiredHash(operation);
    const untouched = currentHash === wantedHash;
    const backup = currentHash === null ? null : path.join(backupDir, ...operation.relative.split("/"));
    if (backup) {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    }
    const beforeIdentity = currentHash === null ? null : fileIdentity(target);
    const tombstone = operation.kind === "delete" && !untouched ? `${target}.dream-rsi-${options.transactionId}.deleted` : null;
    if (tombstone && entryExists(tombstone)) throw new Error(`promotion tombstone already exists: ${operation.relative}`);
    entries.push({ relative: operation.relative, to: target, kind: operation.kind, beforeHash: currentHash, afterHash: wantedHash, beforeMode: currentHash === null ? null : fs.statSync(target).mode & 0o777, beforeIdentity, afterIdentity: null, backup, tombstone, untouched, ...(operation.kind === "write" ? { from: operation.from } : {}) });
    if (!untouched) changed.push(operation.relative);
  }
  const journal: PatchJournal = { transactionId: options.transactionId, seedRoot, patchHash: patchFingerprint(options.patch), state: "prepared", written: changed, backupDir, entries };
  writeJsonAtomic(file, journal);
  try {
    for (const entry of entries) {
      if (options.signal?.aborted) throw new Error("promotion cancelled");
      const { operation, target } = targets.get(entry.relative)!;
      if (entry.untouched) continue;
      if (operation.kind === "delete") {
        if (fileHashOrNull(target, seedRoot) !== entry.beforeHash || fileIdentity(target) !== entry.beforeIdentity) throw new Error(`target changed during promotion: ${entry.relative}`);
        fs.renameSync(target, entry.tombstone!);
      }
      else {
        createdDirs.push(...mkdirParents(target, seedRoot));
        if (fileHashOrNull(target, seedRoot) !== entry.beforeHash || fileIdentity(target) !== entry.beforeIdentity) throw new Error(`target changed during promotion: ${entry.relative}`);
        const contents = fs.readFileSync(operation.from);
        if (digest(contents) !== operation.afterHash) throw new Error(`candidate patch input changed during promotion: ${operation.relative}`);
        const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o666;
        writeFileAtomic(target, contents, mode);
        entry.afterIdentity = fileIdentity(target);
        writeJsonAtomic(file, journal);
      }
      writeJsonAtomic(file, journal);
    }
    assertWorkspaceDigest();
    journal.state = "applied";
    writeJsonAtomic(file, journal);
    for (const entry of entries) if (entry.tombstone) fs.rmSync(entry.tombstone, { force: true });
    return { written: journal.written, backupDir };
  } catch (error) {
    const conflicts = rollbackJournal(journal, seedRoot);
    for (const directory of [...new Set(createdDirs)].reverse()) { try { fs.rmdirSync(directory); } catch { /* non-empty means it is not ours to remove */ } }
    writeJsonAtomic(file, journal);
    if (conflicts.length) throw new Error(`${String(error)}; rollback conflicted at: ${conflicts.join(", ")}`);
    throw error;
  }
}
