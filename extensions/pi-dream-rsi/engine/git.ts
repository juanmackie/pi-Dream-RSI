import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runCommand } from "../agent/runner.ts";

const GIT_TIMEOUT_MS = 15_000;
const INTERNAL_STATE = /(?:^|\/)\.dream-rsi(?:\/|$)/i;
const SHA256 = /^[a-f0-9]{64}$/;
const PROTECTED_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

export interface VerifiedChange {
  /** Repository-relative path from the verified patch journal. */
  path: string;
  /** SHA-256 of the final file, or null when the verified patch deletes it. */
  afterHash: string | null;
}

export class AutoCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoCommitError";
  }
}

function gitEnvironment(): Record<string, string> {
  const result: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const keys = process.platform === "win32"
    ? ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"];
  for (const key of keys) if (typeof process.env[key] === "string") result[key] = process.env[key]!;
  return result;
}

async function git(cwd: string, args: string[], allowFailure = false, signal?: AbortSignal, timeoutMs = GIT_TIMEOUT_MS, input?: Buffer): Promise<{ ok: boolean; stdout: string }> {
  const result = await runCommand("git", args, {
    cwd,
    timeoutMs,
    killTree: true,
    env: gitEnvironment(),
    envOnly: true,
    logPath: null,
    ...(signal ? { signal } : {}),
    ...(input === undefined ? {} : { stdin: input }),
  });
  if (result.stdoutTail.length >= 64 * 1024) throw new AutoCommitError(`git ${args[0] ?? "command"} output exceeded the validation limit`);
  if (result.spawnError || result.timedOut || result.aborted || (!result.ok && !allowFailure)) {
    throw new AutoCommitError(`git ${args[0] ?? "command"} failed${result.timedOut ? " (timed out)" : result.aborted ? " (cancelled)" : result.code === null ? " (could not start)" : ` (exit ${result.code})`}`);
  }
  return { ok: result.ok, stdout: result.stdoutTail };
}

function relativePath(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new AutoCommitError("verified patch contains an invalid path");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))
    || INTERNAL_STATE.test(normalized) || /(?:^|\/)\.git(?:\/|$)/i.test(normalized)) {
    throw new AutoCommitError(`verified patch path is not eligible for auto-commit: ${normalized.slice(0, 120)}`);
  }
  return normalized;
}

function nonInternal(paths: string[]): string[] {
  return paths.map((value) => value.replace(/\\/g, "/")).filter((value) => value && !INTERNAL_STATE.test(value));
}

async function repoRoot(projectDir: string, signal?: AbortSignal): Promise<string> {
  const result = await git(projectDir, ["rev-parse", "--show-toplevel"], false, signal);
  const root = result.stdout.trim();
  if (!root || !path.isAbsolute(root)) throw new AutoCommitError("the selected project is not inside a Git working tree");
  return fs.realpathSync(root);
}

async function changedPaths(root: string, signal?: AbortSignal): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(root, ["diff", "--no-renames", "--name-only", "-z", "HEAD"], false, signal),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"], false, signal),
  ]);
  return nonInternal([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")]).sort();
}

async function ensureEmptyIndex(root: string, signal?: AbortSignal): Promise<void> {
  const staged = await git(root, ["diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD"], false, signal);
  if (staged.stdout.split("\0").some(Boolean)) throw new AutoCommitError("auto-commit requires an empty Git index; commit or unstage existing changes first");
}

function parseNames(output: string): string[] {
  return output.split("\0").filter(Boolean).map((value) => value.replace(/\\/g, "/")).sort();
}

async function localBranchRefs(root: string, signal?: AbortSignal): Promise<Map<string, string>> {
  const output = await git(root, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads/"], false, signal);
  const refs = new Map<string, string>();
  for (const line of output.stdout.split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf("\t");
    if (separator <= 0) throw new AutoCommitError("Git local branch references could not be validated");
    refs.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return refs;
}

async function currentHead(root: string, signal?: AbortSignal): Promise<string> {
  const result = await git(root, ["rev-parse", "--verify", "HEAD"], false, signal);
  const head = result.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new AutoCommitError("auto-commit requires a repository with an existing commit");
  return head;
}

async function assertNotDefaultBranch(root: string, branch: string, signal?: AbortSignal): Promise<void> {
  if (PROTECTED_BRANCHES.has(branch.toLowerCase())) throw new AutoCommitError("auto-commit refuses main/default branch targets; use a dedicated dream-rsi/* branch");
  const remotes = (await git(root, ["remote"], false, signal)).stdout.split(/\r?\n/).filter(Boolean);
  for (const remote of remotes) {
    const remoteHead = await git(root, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], true, signal);
    if (!remoteHead.ok) continue;
    const target = remoteHead.stdout.trim();
    const prefix = `${remote}/`;
    if (!target.startsWith(prefix) || target.length === prefix.length) throw new AutoCommitError("Git remote default branch reference could not be validated");
    if (branch === target.slice(prefix.length)) throw new AutoCommitError("auto-commit refuses the repository's configured default branch; use a dedicated feature branch");
  }
}

export interface PreparedAutoCommitBranch {
  root: string;
  branch: string;
  head: string;
}

/** Switch to or create a dedicated branch only when no user changes would be carried across. */
export async function ensureAutoCommitBranch(projectDir: string, branch: string, signal?: AbortSignal, allowDirtyOnCurrentBranch = false): Promise<PreparedAutoCommitBranch> {
  if (branch.startsWith("-")) throw new AutoCommitError("auto-commit branch must be a valid local branch name");
  const checked = await git(projectDir, ["check-ref-format", "--branch", branch], true, signal);
  if (!checked.ok) throw new AutoCommitError("auto-commit branch must be a valid local branch name");
  const root = await repoRoot(projectDir, signal);
  await assertNotDefaultBranch(root, branch, signal);
  await currentHead(root, signal);
  await ensureEmptyIndex(root, signal);
  const current = (await git(root, ["branch", "--show-current"], false, signal)).stdout.trim();
  const dirt = await changedPaths(root, signal);
  if (dirt.length && !(allowDirtyOnCurrentBranch && current === branch)) {
    throw new AutoCommitError(`auto-commit requires a clean working tree outside .dream-rsi; changed paths: ${dirt.slice(0, 8).join(", ")}`);
  }
  if (current !== branch) {
    const exists = await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true, signal);
    const switched = exists.ok
      ? await git(root, ["switch", "--quiet", branch], false, signal)
      : await git(root, ["switch", "--quiet", "-c", branch], false, signal);
    if (!switched.ok) throw new AutoCommitError("could not select the dedicated auto-commit branch");
  }
  return { root, branch, head: await currentHead(root, signal) };
}

function fileState(root: string, relative: string): { exists: boolean; contentHash?: string; content?: Buffer; mode?: number } {
  const absolute = path.resolve(root, ...relative.split("/"));
  const within = path.relative(root, absolute);
  if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new AutoCommitError("verified patch path escaped the repository");
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new AutoCommitError(`auto-commit refuses a non-regular file: ${relative}`);
    if (stat.size > 50 * 1024 * 1024) throw new AutoCommitError(`auto-commit file exceeds the 50 MiB limit: ${relative}`);
    const bytes = fs.readFileSync(absolute);
    return { exists: true, contentHash: crypto.createHash("sha256").update(bytes).digest("hex"), content: bytes, mode: stat.mode & 0o111 ? 0o100755 : 0o100644 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function gitBlobHash(root: string, relative: string, content: Buffer): Promise<string> {
  const result = await git(root, ["hash-object", `--path=${relative}`, "--stdin"], false, undefined, GIT_TIMEOUT_MS, content);
  const hash = result.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(hash)) throw new AutoCommitError(`Git could not hash the verified postimage: ${relative}`);
  return hash;
}

function cleanCommitText(value: string, max = 100): string {
  const clean = value.replace(/[\r\n\0\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  if (/(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-|(?:AKIA|ASIA)[A-Z0-9]{16}|BEGIN[^-]*PRIVATE KEY|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:password|secret|api[_-]?key)\s*[:=])/i.test(clean)) return "redacted";
  return clean.slice(0, max) || "unspecified";
}

export interface VerifiedCommitOptions {
  projectDir: string;
  branch: string;
  expectedHead: string;
  changes: VerifiedChange[];
  campaignId: string;
  leverId: string;
  unit: string;
  before: number;
  after: number;
  evidencePath: string;
  signal?: AbortSignal;
}

export interface AutoCommitReceipt {
  hash: string;
  branch: string;
  files: string[];
  warning?: string;
}

/** Stage only journal-verified postimages, then commit after the independent verifier has passed. */
export async function commitVerifiedChanges(options: VerifiedCommitOptions): Promise<AutoCommitReceipt> {
  const root = await repoRoot(options.projectDir, options.signal);
  const exec = (args: string[], allowFailure = false) => git(root, args, allowFailure, options.signal);
  if ((await exec(["branch", "--show-current"])).stdout.trim() !== options.branch) throw new AutoCommitError("the dedicated auto-commit branch changed during verification");
  const head = await currentHead(root, options.signal);
  if (head !== options.expectedHead) throw new AutoCommitError("the auto-commit branch advanced during verification; no commit was created");
  await ensureEmptyIndex(root, options.signal);
  const changes = options.changes.map((change) => ({ ...change, path: relativePath(change.path) }));
  if (!changes.length || new Set(changes.map((change) => change.path)).size !== changes.length) throw new AutoCommitError("verified patch has no files or contains duplicate paths");
  if (changes.some((change) => change.afterHash !== null && !SHA256.test(change.afterHash))) throw new AutoCommitError("verified patch has an invalid postimage digest");
  const expectedPaths = changes.map((change) => change.path).sort();
  const changed = await changedPaths(root, options.signal);
  const gitObjects = new Map<string, string>();
  const expectedModes = new Map<string, string>();
  for (const change of changes) {
    const state = fileState(root, change.path);
    if (change.afterHash === null) {
      if (state.exists) throw new AutoCommitError(`verified deletion was changed before commit: ${change.path}`);
      continue;
    }
    if (!state.exists || state.contentHash !== change.afterHash) throw new AutoCommitError(`verified postimage changed before commit: ${change.path}`);
    expectedModes.set(change.path, (state.mode ?? 0o100644).toString(8));
    gitObjects.set(change.path, await gitBlobHash(root, change.path, state.content!));
  }
  if (changed.length === 0) {
    const subject = (await exec(["show", "-s", "--format=%s", head])).stdout.trim();
    const committedNames = parseNames((await exec(["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", head])).stdout);
    const committedTree = (await exec(["ls-tree", "-r", "-z", head, "--", ...expectedPaths.map((file) => `:(literal)${file}`)])).stdout;
    const committedObjects = new Map<string, string>();
    for (const record of committedTree.split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t");
      if (tab < 0) throw new AutoCommitError("the committed tree could not be validated");
      const [mode, kind, objectId] = record.slice(0, tab).split(" ");
      if (kind === "blob") committedObjects.set(record.slice(tab + 1).replace(/\\/g, "/"), `${mode}:${objectId}`);
    }
    const matches = subject === `Dream-RSI: verified improvement (${cleanCommitText(options.campaignId, 80)})`
      && JSON.stringify(committedNames) === JSON.stringify(expectedPaths)
      && changes.every((change) => change.afterHash === null
        ? !committedObjects.has(change.path)
        : committedObjects.get(change.path) === `${expectedModes.get(change.path)}:${gitObjects.get(change.path)}`);
    if (matches) return { hash: head, branch: options.branch, files: expectedPaths };
    throw new AutoCommitError("the verified patch is not a new working-tree change, and HEAD is not its recorded auto-commit");
  }
  if (JSON.stringify(changed) !== JSON.stringify(expectedPaths)) throw new AutoCommitError("working-tree changes do not exactly match the verified patch; no commit was created");
  const addArgs = ["add", "--all", "--", ...expectedPaths.map((file) => `:(literal)${file}`)];
  await exec(addArgs);
  const staged = parseNames((await exec(["diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD"])).stdout);
  if (JSON.stringify(staged) !== JSON.stringify(expectedPaths)) throw new AutoCommitError("the Git index changed during auto-commit staging; staged changes were preserved");
  const indexOutput = await exec(["ls-files", "--stage", "-z", "--", ...expectedPaths.map((file) => `:(literal)${file}`)]);
  const index = new Map<string, string>();
  for (const record of indexOutput.stdout.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new AutoCommitError("the Git index could not be validated");
    const [mode, objectId, stage] = record.slice(0, tab).split(" ");
    if (stage !== "0") throw new AutoCommitError("the Git index contains an unresolved merge entry");
    index.set(record.slice(tab + 1).replace(/\\/g, "/"), `${mode}:${objectId}`);
  }
  for (const change of changes) {
    const indexed = index.get(change.path);
    if (change.afterHash === null ? indexed !== undefined : indexed !== `${expectedModes.get(change.path)}:${gitObjects.get(change.path)}`) {
      throw new AutoCommitError(`the staged postimage changed during auto-commit: ${change.path}`);
    }
  }
  const campaignId = cleanCommitText(options.campaignId, 80);
  const transactionMarker = crypto.randomUUID();
  const message = [
    `Dream-RSI: verified improvement (${campaignId})`,
    "",
    `Metric: ${options.before} -> ${options.after} ${cleanCommitText(options.unit, 24)}`,
    `Lever: ${cleanCommitText(options.leverId, 80)}`,
    `Evidence: ${cleanCommitText(options.evidencePath, 160)}`,
    `RSI-Transaction: ${transactionMarker}`,
  ].join("\n");
  if ((await exec(["branch", "--show-current"])).stdout.trim() !== options.branch || await currentHead(root, options.signal) !== head) {
    throw new AutoCommitError("the auto-commit branch changed before commit creation; verified changes remain staged");
  }
  if (options.signal?.aborted) throw new AutoCommitError("auto-commit was cancelled before commit creation; verified changes remain staged");
  const refsBeforeCommit = await localBranchRefs(root, options.signal);
  let commitError: unknown;
  try { await git(root, ["commit", "-m", message], false, undefined, 120_000); }
  catch (error) { commitError = error; }
  const refsAfterCommit = await localBranchRefs(root);
  const candidateCommitHashes = new Set<string>();
  for (const [ref, hash] of refsAfterCommit) if (refsBeforeCommit.get(ref) !== hash) candidateCommitHashes.add(hash);
  const observedHead = await currentHead(root);
  if (observedHead !== head) candidateCommitHashes.add(observedHead);
  let committedHead: string | null = null;
  for (const hash of candidateCommitHashes) {
    const candidateMessage = (await git(root, ["show", "-s", "--format=%B", hash])).stdout;
    if (candidateMessage.includes(`RSI-Transaction: ${transactionMarker}`)) { committedHead = hash; break; }
  }
  if (!committedHead) throw commitError ?? new AutoCommitError("Git did not create a transaction-marked commit");
  if (committedHead === head) throw commitError ?? new AutoCommitError("Git did not create a commit");
  const parent = (await git(root, ["rev-parse", "--verify", `${committedHead}^`])).stdout.trim();
  const committedMessage = (await git(root, ["show", "-s", "--format=%B", committedHead])).stdout;
  const ownedCommit = committedMessage.includes(`RSI-Transaction: ${transactionMarker}`);
  const committedNames = parseNames((await git(root, ["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", committedHead])).stdout);
  const committedTree = (await git(root, ["ls-tree", "-r", "-z", committedHead, "--", ...expectedPaths.map((file) => `:(literal)${file}`)])).stdout;
  const committedObjects = new Map<string, string>();
  for (const record of committedTree.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new AutoCommitError("the committed tree could not be validated");
    const [mode, kind, objectId] = record.slice(0, tab).split(" ");
    if (kind === "blob") committedObjects.set(record.slice(tab + 1).replace(/\\/g, "/"), `${mode}:${objectId}`);
  }
  const commitDiffersFromVerifiedPatch = changes.some((change) => change.afterHash === null
    ? committedObjects.has(change.path)
    : committedObjects.get(change.path) !== `${expectedModes.get(change.path)}:${gitObjects.get(change.path)}`);
  const currentBranch = (await git(root, ["branch", "--show-current"])).stdout.trim();
  const dedicatedRef = `refs/heads/${options.branch}`;
  const dedicatedBranchHasCommit = refsAfterCommit.get(dedicatedRef) === committedHead;
  if (!ownedCommit || parent !== head || JSON.stringify(committedNames) !== JSON.stringify(expectedPaths) || commitDiffersFromVerifiedPatch
    || currentBranch !== options.branch || !dedicatedBranchHasCommit) {
    if (ownedCommit) {
      const rollbackRefs = [...refsAfterCommit].filter(([ref, hash]) => hash === committedHead && refsBeforeCommit.get(ref) !== hash);
      for (const [ref] of rollbackRefs) {
        const previous = refsBeforeCommit.get(ref);
        if (previous) await git(root, ["update-ref", ref, previous, committedHead]);
        else await git(root, ["update-ref", "-d", ref, committedHead]);
      }
      throw new AutoCommitError("Git hooks moved or changed the verified commit; its new branch references were rolled back and the worktree changes were preserved");
    }
    throw new AutoCommitError("the Git commit does not match the verified patch; it was not rolled back because branch ownership could not be proven");
  }
  const residual = await changedPaths(root);
  return {
    hash: committedHead, branch: options.branch, files: expectedPaths,
    ...(residual.length ? { warning: `verified commit created, but the working tree changed during Git commit: ${residual.slice(0, 8).join(", ")}` } : {}),
  };
}
