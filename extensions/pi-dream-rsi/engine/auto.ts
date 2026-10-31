import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { copyWorkspace, runCommand, runShellCommand } from "../agent/runner.ts";
import { ensureAutoCommitBranch, commitVerifiedChanges, type VerifiedChange } from "./git.ts";
import { normalizeProjectRelativePath, pathProtected, pathWithin } from "./scope.ts";
import { restrictedEnvironment } from "./intake.ts";
import { writeFileAtomic } from "./fsutil.ts";
import { parseThreshold, planTest, resolveThreshold, runPaired } from "./measure.ts";

const MAX_COMMAND_MS = 120_000;
const MAX_CV = 0.05;
const SECRET = /(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-|(?:AKIA|ASIA)[A-Z0-9]{16}|BEGIN[^-]*PRIVATE KEY|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:password|secret|api[_-]?key|token)\s*[:=]\s*\S+)/i;
const SECRET_TOKENS = /(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:password|secret|api[_-]?key|token)\s*[:=]\s*\S+)/gi;
function redactLogText(value: string): string { return SECRET.test(value) && /BEGIN[^-]*PRIVATE KEY/i.test(value) ? "[REDACTED SECRET]" : value.replace(SECRET_TOKENS, "[REDACTED]").slice(0, 240); }
const COMMAND_ENV = restrictedEnvironment({ execution: { consent: false, envAllowlist: [], allowedCommandCategories: [] } });

export interface AutoInput {
  consent: boolean; goal: string; metric: string; unit: string; higherIsBetter: boolean; command: string; checks: string;
  scope: string[]; protectedAssets?: string[]; minimumGain: number | `${number}%`;
  maxExperiments: number; maxConsecutiveDiscards: number; providerCap?: number; branch?: string;
}
export interface AutoConfig extends AutoInput {
  version: 1; projectDir: string; branch: string; initialHead: string; expectedHead: string;
  baselineReadings: number[]; baseline: number; cv: number; best: number; runs: number;
  consecutiveDiscards: number; state: "active" | "stopped"; stopReason: string | null; stopRequested?: boolean;
  providerTransientRetries?: number; providerFailure?: "quota" | "transient" | null;
  contractDigest: string; stateDigest: string; promptHash?: string;
}
interface AutoRun { id: string; runNumber: number; head: string; metric: number; paths: string[]; postimages: Record<string, string | null>; description?: string; hypothesis?: string; }
interface AutoLog { run: number; id: string; status: "kept" | "discarded"; metric: number; best: number; commit: string | null; description: string; hypothesis?: string; confidence: number; at: string; }
const rootOf = (projectDir: string): string => path.resolve(projectDir);
function assertStateDirectory(file: string): void {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`auto state path is not a real directory: ${path.basename(file)}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const stateDir = (projectDir: string): string => {
  const parent = path.join(rootOf(projectDir), ".dream-rsi");
  assertStateDirectory(parent);
  const state = path.join(parent, "auto");
  assertStateDirectory(state);
  return state;
};
const configPath = (projectDir: string): string => path.join(stateDir(projectDir), "config.json");
const runPath = (projectDir: string): string => path.join(stateDir(projectDir), "last-run.json");
const logPath = (projectDir: string): string => path.join(stateDir(projectDir), "log.jsonl");
const lockPath = (projectDir: string): string => path.join(stateDir(projectDir), "run.lock");
function fail(message: string): never { throw new Error(message); }
function immutableContract(config: AutoConfig): string {
  const fields = { goal: config.goal, metric: config.metric, unit: config.unit, higherIsBetter: config.higherIsBetter, command: config.command,
    checks: config.checks, scope: config.scope, protectedAssets: config.protectedAssets, minimumGain: config.minimumGain, maxExperiments: config.maxExperiments,
    maxConsecutiveDiscards: config.maxConsecutiveDiscards, providerCap: config.providerCap, branch: config.branch, initialHead: config.initialHead,
    baselineReadings: config.baselineReadings, baseline: config.baseline, cv: config.cv };
  return crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
function stateDigest(config: AutoConfig): string {
  const { stateDigest: _ignored, ...state } = config;
  return crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
function writeConfig(config: AutoConfig, directory = stateDir(config.projectDir)): void {
  config.stateDigest = stateDigest(config);
  writeFileAtomic(path.join(directory, "config.json"), `${JSON.stringify(config, null, 2)}\n`, true);
}
function readConfig(projectDir: string): AutoConfig {
  let value: AutoConfig;
  try { value = JSON.parse(fs.readFileSync(configPath(projectDir), "utf8")) as AutoConfig; }
  catch { return fail("no valid auto session exists; run /dream-rsi auto init first"); }
  if (!value || value.version !== 1 || value.projectDir !== rootOf(projectDir) || !Array.isArray(value.scope) || !value.scope.length
    || typeof value.branch !== "string" || !Number.isSafeInteger(value.runs) || value.runs < 0
    || !Number.isFinite(value.best) || !Number.isFinite(value.baseline) || !Array.isArray(value.baselineReadings)
    || value.baselineReadings.length !== 5 || value.baselineReadings.some((n) => !Number.isFinite(n))
    || typeof value.command !== "string" || typeof value.checks !== "string"
    || value.scope.some((item) => typeof item !== "string" || !normalizeProjectRelativePath(item))
    || value.protectedAssets?.some((item) => typeof item !== "string" || !normalizeProjectRelativePath(item))
    || (value.state !== "active" && value.state !== "stopped") || !Number.isSafeInteger(value.maxExperiments) || !Number.isSafeInteger(value.consecutiveDiscards)
    || typeof value.contractDigest !== "string" || value.contractDigest !== immutableContract(value)
    || typeof value.stateDigest !== "string" || value.stateDigest !== stateDigest(value)) return fail("auto config failed validation or its approved state changed; inspect it before continuing");
  const prompt = path.join(stateDir(projectDir), "prompt.md");
  if (typeof value.promptHash !== "string" || !fs.existsSync(prompt)) return fail("auto resume prompt changed outside the auto logger; inspect it before continuing");
  const promptText = fs.readFileSync(prompt, "utf8");
  const promptHash = crypto.createHash("sha256").update(promptText).digest("hex");
  if (promptHash !== value.promptHash) {
    if (promptText !== renderPrompt(value, readLog(projectDir))) return fail("auto resume prompt changed outside the auto logger; inspect it before continuing");
    value.promptHash = promptHash; writeConfig(value);
  }
  const measureScript = `#!/bin/sh\nset -eu\n${value.command}\n`;
  const checkScript = `#!/bin/sh\nset -eu\n${value.checks}\n`;
  try {
    if (fs.readFileSync(path.join(stateDir(projectDir), "measure.sh"), "utf8") !== measureScript
      || fs.readFileSync(path.join(stateDir(projectDir), "checks.sh"), "utf8") !== checkScript) return fail("measure or check command changed; init a new reviewed auto session");
  } catch { return fail("auto command files are missing or unreadable; inspect state before continuing"); }
  return value;
}
async function git(root: string, args: string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd: root, timeoutMs: 15_000, killTree: true, logPath: null, envOnly: true, env: COMMAND_ENV });
  if (!result.ok) return fail(`git ${args[0]} failed${result.timedOut ? " (timed out)" : ` (exit ${result.code})`}`);
  return result.stdoutTail;
}
function parseStatus(value: string): Array<{ status: string; file: string }> {
  const items = value.split("\0").filter(Boolean);
  const result: Array<{ status: string; file: string }> = [];
  for (let index = 0; index < items.length; index += 1) {
    const entry = items[index]!;
    if (entry.length < 4) return fail("Git status could not be parsed safely");
    const status = entry.slice(0, 2); const file = entry.slice(3).replaceAll("\\", "/");
    result.push({ status, file });
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return result;
}
async function statusPaths(root: string): Promise<Array<{ status: string; file: string }>> {
  return parseStatus(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]))
    .filter(({ file }) => !file.startsWith(".dream-rsi/"));
}
function insideScope(file: string, config: Pick<AutoConfig, "scope" | "protectedAssets">): boolean {
  return config.scope.some((scope) => pathWithin(file, [scope])) && !pathProtected(file, config.protectedAssets ?? []);
}
async function ensureRepository(config: AutoConfig): Promise<void> {
  const branch = (await git(config.projectDir, ["branch", "--show-current"])).trim();
  if (branch !== config.branch) fail(`branch drift: expected ${config.branch}, found ${branch || "detached HEAD"}`);
  if ((await git(config.projectDir, ["rev-parse", "--verify", "HEAD"])).trim() !== config.expectedHead) fail("branch drift: HEAD changed outside the auto loop");
}
async function withCleanCopy<T>(root: string, action: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-auto-"));
  try {
    await copyWorkspace(root, scratch, { exclude: [path.join(root, ".git"), path.join(root, ".dream-rsi")] });
    return await action(scratch);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
async function numericCommand(root: string, command: string): Promise<number> {
  return withCleanCopy(root, async (scratch) => {
    const result = await runShellCommand(command, { cwd: scratch, timeoutMs: MAX_COMMAND_MS, logPath: null, envOnly: true, env: COMMAND_ENV });
    if (!result.ok) fail(`measure command failed${result.timedOut ? " (timed out)" : result.spawnError ? `: ${result.spawnError}` : ` (exit ${result.code})`}`);
    const output = result.stdoutTail.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(output)) fail("measure command must print exactly one finite number on stdout");
    const value = Number(output); if (!Number.isFinite(value)) fail("measure command returned a non-finite number");
    return value;
  });
}
async function checkCommand(root: string, command: string): Promise<void> {
  await withCleanCopy(root, async (scratch) => {
    const result = await runShellCommand(command, { cwd: scratch, timeoutMs: MAX_COMMAND_MS, logPath: null, envOnly: true, env: COMMAND_ENV });
    if (!result.ok) fail(`correctness check failed${result.timedOut ? " (timed out)" : result.spawnError ? `: ${result.spawnError}` : ` (exit ${result.code})`}`);
  });
}
function coefficient(readings: number[]): number {
  const mean = readings.reduce((a, b) => a + b, 0) / readings.length;
  if (mean === 0) return readings.every((n) => n === 0) ? 0 : Infinity;
  const variance = readings.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (readings.length - 1);
  return Math.sqrt(variance) / Math.abs(mean);
}
function validateInput(raw: AutoInput): AutoInput {
  if (!raw || typeof raw !== "object") fail("auto settings must be an object");
  if (raw.consent !== true) fail("trusted-local consent is required; repository commands run on this host");
  if (typeof raw.goal !== "string" || !raw.goal.trim() || raw.goal.length > 1000) fail("goal must be a non-empty sentence up to 1000 characters");
  if (typeof raw.metric !== "string" || !raw.metric.trim() || raw.metric.length > 120) fail("metric must be a non-empty name up to 120 characters");
  if (typeof raw.unit !== "string" || !raw.unit.trim() || raw.unit.length > 40) fail("unit must be a non-empty label up to 40 characters");
  for (const [name, value] of [["goal", raw.goal], ["metric", raw.metric], ["unit", raw.unit], ["command", raw.command], ["checks", raw.checks]] as const) {
    if (typeof value === "string" && SECRET.test(value)) fail(`${name} contains secret-shaped text; do not store credentials in auto state`);
  }
  if (typeof raw.higherIsBetter !== "boolean") fail("higherIsBetter must be true or false");
  if (!Array.isArray(raw.scope) || !raw.scope.length || raw.scope.length > 100) fail("scope must contain 1–100 project-relative paths");
  const scope = raw.scope.map((item) => typeof item === "string" ? normalizeProjectRelativePath(item) : null);
  if (scope.some((item) => item === null)) fail("scope paths must be safe, project-relative paths");
  const protectedAssets = raw.protectedAssets ?? [];
  if (!Array.isArray(protectedAssets) || protectedAssets.length > 100 || protectedAssets.some((item) => typeof item !== "string" || !normalizeProjectRelativePath(item))) fail("protectedAssets must contain safe project-relative paths");
  for (const item of scope as string[]) if (pathProtected(item, [...protectedAssets, ".git", ".dream-rsi"])) fail(`scope overlaps a protected path: ${item}`);
  for (const [field, value] of [["command", raw.command], ["checks", raw.checks]] as const) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) fail(`${field} must be one non-empty command line`);
  }
  if (typeof raw.minimumGain !== "number" && (typeof raw.minimumGain !== "string" || !/^\d+(?:\.\d+)?%$/.test(raw.minimumGain))) fail("minimumGain must be a non-negative number or percentage");
  if (typeof raw.minimumGain === "number" && (!Number.isFinite(raw.minimumGain) || raw.minimumGain < 0)) fail("minimumGain must be finite and non-negative");
  if (typeof raw.minimumGain === "string" && Number(raw.minimumGain.slice(0, -1)) >= 100) fail("minimumGain percentage must be below 100%");
  if (!Number.isSafeInteger(raw.maxExperiments) || raw.maxExperiments < 1 || raw.maxExperiments > 1000) fail("maxExperiments must be an integer from 1 to 1000");
  if (!Number.isSafeInteger(raw.maxConsecutiveDiscards) || raw.maxConsecutiveDiscards < 1 || raw.maxConsecutiveDiscards > 1000) fail("maxConsecutiveDiscards must be an integer from 1 to 1000");
  if (raw.branch !== undefined && (typeof raw.branch !== "string" || !raw.branch.trim() || raw.branch.length > 255)) fail("branch must be a dedicated local branch name");
  if (!Number.isFinite(raw.providerCap) || raw.providerCap! <= 0) fail("providerCap is required and must be positive; also configure the matching provider-side hard cap");
  return { ...raw, goal: raw.goal.trim(), metric: raw.metric.trim(), unit: raw.unit.trim(), scope: scope as string[], protectedAssets: [...protectedAssets], branch: raw.branch ?? "dream-rsi/auto" };
}
function truncateIncompleteLogTail(file: string): void {
  if (!fs.existsSync(file)) return;
  const fd = fs.openSync(file, "r+");
  try {
    let end = fs.fstatSync(fd).size;
    if (!end) return;
    const finalByte = Buffer.alloc(1); fs.readSync(fd, finalByte, 0, 1, end - 1);
    if (finalByte[0] === 0x0a) return;
    while (end > 0) {
      const start = Math.max(0, end - 64 * 1024);
      const bytes = Buffer.alloc(end - start); fs.readSync(fd, bytes, 0, bytes.length, start);
      const newline = bytes.lastIndexOf(0x0a);
      if (newline >= 0) { fs.ftruncateSync(fd, start + newline + 1); fs.fsyncSync(fd); return; }
      end = start;
    }
    fs.ftruncateSync(fd, 0); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function appendLog(projectDir: string, item: AutoLog): void {
  const file = logPath(projectDir);
  truncateIncompleteLogTail(file);
  const rows = readLog(projectDir);
  const prior = rows.find((row) => row.id === item.id);
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify(item)) fail("auto log already contains a different record for this run");
    return;
  }
  if (rows.some((row) => row.run === item.run)) fail("auto log already contains this run number with a different ID");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(item)}\n`, { encoding: "utf8", flag: "a" });
  const fd = fs.openSync(file, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function renderPrompt(config: AutoConfig, tail: AutoLog[]): string {
  const recent = tail.slice(-20).map((row) => `- ${row.status}: ${row.description}; metric=${row.metric}; best=${row.best}; ${row.hypothesis ?? "no hypothesis"}`).join("\n");
  return `# Dream-RSI auto session\n\nGoal: ${config.goal}\nMetric: ${config.metric} (${config.unit}; ${config.higherIsBetter ? "higher" : "lower"} is better)\nScope: ${config.scope.join(", ")}\nBranch: ${config.branch}\nBaseline: ${config.baseline}; best: ${config.best}\nExperiments: ${config.runs}/${config.maxExperiments}; consecutive discards: ${config.consecutiveDiscards}/${config.maxConsecutiveDiscards}\n\n## Recent experiments\n${recent || "No experiments yet."}\n\nPropose one new hypothesis. Edit only within scope, then call dream_rsi_auto_run followed by dream_rsi_auto_log.\n`;
}
function writePrompt(config: AutoConfig, tail: AutoLog[], directory = stateDir(config.projectDir)): void {
  const content = renderPrompt(config, tail);
  writeFileAtomic(path.join(directory, "prompt.md"), content);
  config.promptHash = crypto.createHash("sha256").update(content).digest("hex");
  writeConfig(config, directory);
}

export async function initAuto(projectDir: string, input: AutoInput): Promise<{ ok: true; config: AutoConfig }> {
  const root = rootOf(projectDir); const inputChecked = validateInput(input);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail("project directory does not exist");
  if (fs.existsSync(stateDir(root))) fail("auto session state already exists; inspect or stop it before reinitializing");
  const initial = await statusPaths(root);
  const unrelated = initial.filter(({ file }) => !file.startsWith(".dream-rsi/"));
  if (unrelated.length) fail(`init requires a clean working tree outside .dream-rsi; changed paths: ${unrelated.slice(0, 8).map(({ file }) => file).join(", ")}`);
  for (const { file } of initial) if (!file.startsWith(".dream-rsi/")) fail(`init refuses dirty path: ${file}`);
  const head = (await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  const before = await Promise.all(Array.from({ length: 5 }, () => numericCommand(root, inputChecked.command)));
  const cv = coefficient(before); if (!Number.isFinite(cv) || cv > MAX_CV) fail(`baseline CV ${(cv * 100).toFixed(2)}% exceeds the 5% qualification limit`);
  await checkCommand(root, inputChecked.checks);
  const pathsAfter = await statusPaths(root);
  if (pathsAfter.some(({ file }) => !file.startsWith(".dream-rsi/"))) fail("qualification command changed repository files; clean the working tree and retry");
  const branchInfo = await ensureAutoCommitBranch(root, inputChecked.branch!);
  if (branchInfo.head !== head) fail("repository HEAD changed during initialization");
  const median = [...before].sort((a, b) => a - b)[2]!;
  const config: AutoConfig = { ...inputChecked, version: 1, projectDir: root, branch: branchInfo.branch, initialHead: head, expectedHead: head,
    baselineReadings: before, baseline: median, best: median, cv, runs: 0, consecutiveDiscards: 0, state: "active", stopReason: null, contractDigest: "", stateDigest: "" };
  config.contractDigest = immutableContract(config);
  const parent = path.dirname(stateDir(root));
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, ".auto-init-"));
  try {
    writeFileAtomic(path.join(staging, "measure.sh"), `#!/bin/sh\nset -eu\n${inputChecked.command}\n`);
    writeFileAtomic(path.join(staging, "checks.sh"), `#!/bin/sh\nset -eu\n${inputChecked.checks}\n`);
    const baseline: AutoLog = { run: 0, id: crypto.randomUUID(), status: "kept", metric: median, best: median, commit: null, description: "qualified baseline", confidence: 1 - cv, at: new Date().toISOString() };
    writeFileAtomic(path.join(staging, "log.jsonl"), `${JSON.stringify(baseline)}\n`);
    writePrompt(config, [baseline], staging);
    fs.renameSync(staging, stateDir(root));
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { ok: true, config };
}

async function runAutoLocked(projectDir: string): Promise<AutoRun> {
  const config = readConfig(projectDir); if (config.state !== "active" || config.stopRequested) fail(`auto session stopped: ${config.stopReason ?? "operator stop"}`);
  if (config.runs >= config.maxExperiments) fail("experiment cap reached; stop the loop or review its results");
  if (fs.existsSync(runPath(projectDir))) fail("the previous run is not logged; call dream_rsi_auto_log first");
  await ensureRepository(config);
  const changes = await statusPaths(config.projectDir);
  const outside = changes.filter(({ file }) => !insideScope(file, config));
  if (outside.length) fail(`out-of-scope diff: ${outside.slice(0, 8).map(({ file }) => file).join(", ")}`);
  const metric = await numericCommand(config.projectDir, config.command);
  await ensureRepository(config);
  const after = await statusPaths(config.projectDir);
  const bad = after.filter(({ file }) => !insideScope(file, config));
  if (bad.length) fail(`out-of-scope diff after measurement: ${bad.slice(0, 8).map(({ file }) => file).join(", ")}`);
  const paths = [...new Set([...changes, ...after].map(({ file }) => file))].sort();
  const postimages: Record<string, string | null> = {};
  for (const file of paths) {
    const target = path.resolve(config.projectDir, ...file.split("/"));
    const relative = path.relative(config.projectDir, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`experiment path escaped the repository: ${file}`);
    if (!fs.existsSync(target)) { postimages[file] = null; continue; }
    const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) fail(`experiment contains a non-regular file: ${file}`);
    postimages[file] = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  }
  const run: AutoRun = { id: crypto.randomUUID(), runNumber: config.runs + 1, head: config.expectedHead, metric, paths, postimages };
  writeFileAtomic(runPath(projectDir), `${JSON.stringify(run, null, 2)}\n`, true);
  return run;
}

async function discard(config: AutoConfig): Promise<void> {
  const current = await statusPaths(config.projectDir);
  if (current.some(({ file }) => !insideScope(file, config))) fail("discard refused: unrelated out-of-scope changes appeared; preserve them and inspect manually");
  const tracked = current.filter(({ status }) => status !== "??").map(({ file }) => `:(literal)${file}`);
  if (tracked.length) await git(config.projectDir, ["restore", "--source=HEAD", "--worktree", "--staged", "--", ...tracked]);
  for (const { status, file } of current) {
    if (status !== "??") continue;
    const target = path.resolve(config.projectDir, ...file.split("/"));
    const rel = path.relative(config.projectDir, target);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || !insideScope(file, config)) fail(`discard refused unsafe untracked path: ${file}`);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail(`discard refused non-regular untracked path: ${file}`);
    fs.rmSync(target, { recursive: stat.isDirectory(), force: true });
  }
}
function readLog(projectDir: string): AutoLog[] {
  const file = logPath(projectDir);
  if (!fs.existsSync(file)) return [];
  const fd = fs.openSync(file, "r");
  let text: string;
  try {
    const size = fs.fstatSync(fd).size; const start = Math.max(0, size - 256 * 1024);
    const bytes = Buffer.alloc(size - start); fs.readSync(fd, bytes, 0, bytes.length, start); text = bytes.toString("utf8");
  } finally { fs.closeSync(fd); }
  if (text && !text.endsWith("\n")) text = text.slice(0, text.lastIndexOf("\n") + 1);
  if (fs.statSync(file).size > 256 * 1024) text = text.slice(text.indexOf("\n") + 1);
  let rows: AutoLog[];
  try { rows = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as AutoLog); }
  catch { return fail("auto log tail is unreadable; inspect it before continuing"); }
  let previous = -1;
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.run) || row.run <= previous
      || !["kept", "discarded"].includes(row.status) || !Number.isFinite(row.metric) || !Number.isFinite(row.best)
      || !Number.isFinite(row.confidence) || typeof row.description !== "string" || typeof row.id !== "string") return fail("auto log tail failed schema validation; inspect it before continuing");
    previous = row.run;
  }
  return rows;
}
async function confirmGain(config: AutoConfig): Promise<{ accepted: boolean; confidence: number }> {
  const baselineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-auto-baseline-"));
  let worktree = false;
  try {
    fs.rmSync(baselineRoot, { recursive: true, force: true });
    await git(config.projectDir, ["worktree", "add", "--quiet", "--detach", baselineRoot, config.expectedHead]);
    worktree = true;
    const baselineReadings = await Promise.all(Array.from({ length: 5 }, () => numericCommand(baselineRoot, config.command)));
    const cv = coefficient(baselineReadings);
    if (!Number.isFinite(cv) || cv > MAX_CV) fail(`current best CV ${(cv * 100).toFixed(2)}% exceeds the 5% confirmation limit`);
    const threshold = parseThreshold(config.minimumGain);
    const plan = planTest({ baseline: baselineReadings, higherIsBetter: config.higherIsBetter,
      threshold: resolveThreshold(threshold, Math.abs(config.best), config.higherIsBetter),
      relative: threshold.kind === "relative", maxCycles: 1, maxPairs: 8, alphaConf: 0.05 });
    const confirmation = await runPaired({ plan, higherIsBetter: config.higherIsBetter, baselineReadings,
      instrument: ({ condition }) => numericCommand(condition === "before" ? baselineRoot : config.projectDir, config.command) });
    return { accepted: confirmation.decision.decision === "accept", confidence: confirmation.decision.decision === "accept" ? 0.95 : 0 };
  } finally {
    try { if (worktree) await git(config.projectDir, ["worktree", "remove", "--force", baselineRoot]); }
    finally { fs.rmSync(baselineRoot, { recursive: true, force: true }); }
  }
}
function runLockActive(projectDir: string, cleanStale = true): boolean {
  const file = lockPath(projectDir);
  if (!fs.existsSync(file)) return false;
  let contents: string; let identity: fs.Stats; let pid: unknown;
  try { contents = fs.readFileSync(file, "utf8"); identity = fs.lstatSync(file); pid = JSON.parse(contents).pid; }
  catch { return fail("auto run lock is unreadable; inspect it before continuing"); }
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return fail("auto run lock has an invalid owner; inspect it before continuing");
  try { process.kill(pid as number, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return fail("auto run lock owner cannot be verified; inspect it before continuing");
    const current = fs.lstatSync(file);
    if (current.dev !== identity.dev || current.ino !== identity.ino || fs.readFileSync(file, "utf8") !== contents) return fail("auto run lock changed during stale-owner recovery; retry status");
    if (cleanStale) fs.unlinkSync(file);
    return false;
  }
}
function acquireRunLock(projectDir: string): () => void {
  fs.mkdirSync(stateDir(projectDir), { recursive: true });
  const file = lockPath(projectDir);
  let fd: number;
  try { fd = fs.openSync(file, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (runLockActive(projectDir)) return fail("an auto run is already in progress");
    try { fd = fs.openSync(file, "wx"); }
    catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return fail("another auto run claimed the session; retry after it finishes");
      throw retryError;
    }
  }
  fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  fs.fsyncSync(fd);
  const identity = fs.fstatSync(fd);
  return () => {
    fs.closeSync(fd);
    try {
      const current = fs.lstatSync(file);
      if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(file);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
}
export async function runAuto(projectDir: string): Promise<AutoRun> {
  const release = acquireRunLock(projectDir);
  try { return await runAutoLocked(projectDir); }
  finally { release(); }
}
function mergeStopRequest(config: AutoConfig): void {
  const current = readConfig(config.projectDir);
  if (current.stopRequested) { config.stopRequested = true; config.stopReason = current.stopReason; }
}
function advanceAutoConfig(config: AutoConfig, item: AutoLog): void {
  if (config.runs + 1 === item.run) {
    config.runs = item.run;
    config.consecutiveDiscards = item.status === "kept" ? 0 : config.consecutiveDiscards + 1;
  } else if (config.runs !== item.run) fail("logged run number does not match durable auto state");
  config.best = item.best;
  if (item.commit) config.expectedHead = item.commit;
  if (config.stopRequested) { config.state = "stopped"; config.stopReason = "operator stopped at run boundary"; }
  else if (config.runs >= config.maxExperiments) { config.state = "stopped"; config.stopReason = "experiment cap reached"; }
  else if (config.consecutiveDiscards >= config.maxConsecutiveDiscards) { config.state = "stopped"; config.stopReason = "consecutive discard cap reached"; }
  else { config.state = "active"; config.stopReason = null; }
}
async function reconcileLoggedAutoRun(config: AutoConfig, run: AutoRun, item: AutoLog): Promise<AutoLog> {
  if (item.run !== run.runNumber || item.metric !== run.metric
    || (item.status === "kept" ? !item.commit || item.best !== item.metric : item.commit !== null)) fail("existing auto log row does not match its pending run");
  const branch = (await git(config.projectDir, ["branch", "--show-current"])).trim();
  if (branch !== config.branch) fail(`branch drift: expected ${config.branch}, found ${branch || "detached HEAD"}`);
  if (item.status === "kept") {
    const parent = (await git(config.projectDir, ["rev-list", "--parents", "-n", "1", item.commit!])).trim().split(/\s+/)[1];
    if (parent !== run.head) fail("logged auto commit is not the commit produced from this pending run");
    const changes: VerifiedChange[] = run.paths.map((file) => ({ path: file, afterHash: run.postimages[file] ?? null }));
    const receipt = await commitVerifiedChanges({ projectDir: config.projectDir, branch: config.branch, expectedHead: config.expectedHead, changes,
      campaignId: run.id, leverId: "auto", unit: config.unit, before: config.best, after: run.metric, evidencePath: ".dream-rsi/auto/log.jsonl" });
    if (receipt.hash !== item.commit) fail("logged auto commit differs from the verified commit; inspect the session");
  } else {
    const head = (await git(config.projectDir, ["rev-parse", "--verify", "HEAD"])).trim();
    if (head !== config.expectedHead || (await statusPaths(config.projectDir)).length !== 0) fail("logged discard cannot be reconciled because the repository is not clean at its recorded HEAD");
  }
  mergeStopRequest(config);
  advanceAutoConfig(config, item);
  writeConfig(config);
  fs.rmSync(runPath(config.projectDir), { force: true });
  writePrompt(config, readLog(config.projectDir));
  return item;
}
export async function logAuto(projectDir: string, details: { description: string; hypothesis?: string; status?: "keep" | "discard" }): Promise<AutoLog> {
  const release = acquireRunLock(projectDir);
  try { return await logAutoLocked(projectDir, details); }
  finally { release(); }
}
async function logAutoLocked(projectDir: string, details: { description: string; hypothesis?: string; status?: "keep" | "discard" }): Promise<AutoLog> {
  const config = readConfig(projectDir);
  let run: AutoRun; try { run = JSON.parse(fs.readFileSync(runPath(projectDir), "utf8")) as AutoRun; } catch { return fail("there is no unlogged run; call dream_rsi_auto_run first"); }
  if (!run || typeof run.id !== "string" || !run.id || !Number.isSafeInteger(run.runNumber) || run.runNumber < 1) fail("last run identity is invalid");
  if (!Number.isFinite(run.metric) || !Array.isArray(run.paths)) fail("last run metric or path list is invalid");
  if (run.paths.some((file) => typeof file !== "string" || !insideScope(file, config)) || new Set(run.paths).size !== run.paths.length) fail("last run paths are invalid or outside scope");
  if (!run.postimages || typeof run.postimages !== "object" || Array.isArray(run.postimages)
    || JSON.stringify(Object.keys(run.postimages).sort()) !== JSON.stringify([...run.paths].sort())) fail("last run postimage map does not match its paths");
  if (Object.values(run.postimages).some((hash) => hash !== null && (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)))) fail("last run contains an invalid postimage hash");
  const existingLog = readLog(projectDir).find((row) => row.id === run.id);
  if (existingLog) return reconcileLoggedAutoRun(config, run, existingLog);
  if (run.runNumber !== config.runs + 1) fail("pending run number does not match durable auto state; inspect the session before continuing");
  if (run.head !== config.expectedHead) fail("last run belongs to a different branch state");
  if (config.state !== "active" && !config.stopRequested) fail(`auto session stopped: ${config.stopReason ?? "operator stop"}`);
  const currentBranch = (await git(config.projectDir, ["branch", "--show-current"])).trim();
  if (currentBranch !== config.branch) fail(`branch drift: expected ${config.branch}, found ${currentBranch || "detached HEAD"}`);
  const currentHead = (await git(config.projectDir, ["rev-parse", "--verify", "HEAD"])).trim();
  const recoveringCommit = currentHead !== config.expectedHead;
  let recoveredCommit: string | null = null;
  if (recoveringCommit) {
    const changes: VerifiedChange[] = run.paths.map((file) => ({ path: file, afterHash: run.postimages[file] ?? null }));
    const receipt = await commitVerifiedChanges({ projectDir: config.projectDir, branch: config.branch, expectedHead: config.expectedHead, changes,
      campaignId: run.id, leverId: "auto", unit: config.unit, before: config.best, after: run.metric, evidencePath: ".dream-rsi/auto/log.jsonl" });
    recoveredCommit = receipt.hash; config.expectedHead = receipt.hash; config.best = run.metric;
  } else await ensureRepository(config);
  const current = recoveringCommit ? [] : await statusPaths(config.projectDir);
  if (current.some(({ file }) => !insideScope(file, config))) fail("out-of-scope diff; no experiment was committed or discarded");
  const changed = [...new Set(current.map(({ file }) => file))].sort();
  let recoveringDiscard = false;
  if (!recoveringCommit && JSON.stringify(changed) !== JSON.stringify([...run.paths].sort())) {
    if (!run.paths.length || changed.some((file) => !run.paths.includes(file))) fail("working tree changed after run; refusing to commit or discard an unreviewed patch");
    recoveringDiscard = true;
  }
  for (const file of changed) {
    const target = path.resolve(config.projectDir, ...file.split("/"));
    if (!fs.existsSync(target)) { if (run.postimages[file] !== null) fail(`experiment changed after measurement: ${file}`); continue; }
    const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) fail(`experiment changed to a non-regular file: ${file}`);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    if (digest !== run.postimages[file]) fail(`experiment changed after measurement: ${file}`);
  }
  const suppliedDescription = typeof details?.description === "string" ? redactLogText(details.description.trim()) : "";
  if (!suppliedDescription && !recoveringCommit && !recoveringDiscard) fail("description is required; no log entry was written");
  const description = suppliedDescription || "recovered interrupted run";
  const hypothesis = typeof details?.hypothesis === "string" && details.hypothesis.trim() ? redactLogText(details.hypothesis.trim()) : undefined;
  let outcome: AutoLog["status"] = recoveringCommit ? "kept" : "discarded"; let commit: string | null = recoveredCommit;
  let checkPassed = recoveringCommit;
  if (!recoveringCommit && !recoveringDiscard) {
    try { await checkCommand(config.projectDir, config.checks); checkPassed = true; } catch { /* failed checks discard this experiment and allow the next one */ }
  }
  let confirmation = recoveringCommit ? { accepted: true, confidence: 0.95 } : { accepted: false, confidence: 0 };
  if (!recoveringCommit && !recoveringDiscard && details.status !== "discard" && checkPassed && changed.length > 0) confirmation = await confirmGain(config);
  let keep = recoveringCommit || !recoveringDiscard && details.status !== "discard" && checkPassed && confirmation.accepted && changed.length > 0;
  let best = config.best;
  if (recoveringDiscard) await discard(config);
  if (keep && !recoveringCommit) {
    await ensureRepository(config);
    try { await checkCommand(config.projectDir, config.checks); } catch { keep = false; }
    if (keep) {
      const finalPaths = [...new Set((await statusPaths(config.projectDir)).map(({ file }) => file))].sort();
      if (JSON.stringify(finalPaths) !== JSON.stringify([...run.paths].sort())) fail("working tree changed during final verification; preserving edits without committing");
      for (const file of run.paths) {
        const target = path.resolve(config.projectDir, ...file.split("/"));
        if (!fs.existsSync(target)) { if (run.postimages[file] !== null) fail(`experiment changed during final verification: ${file}`); continue; }
        const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) fail(`experiment changed to a non-regular file: ${file}`);
        if (crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== run.postimages[file]) fail(`experiment changed during final verification: ${file}`);
      }
    }
  }
  if (keep && !recoveringCommit) {
    const changes: VerifiedChange[] = run.paths.map((file) => ({ path: file, afterHash: run.postimages[file] ?? null }));
    const receipt = await commitVerifiedChanges({ projectDir: config.projectDir, branch: config.branch, expectedHead: config.expectedHead, changes,
      campaignId: run.id, leverId: "auto", unit: config.unit, before: config.best, after: run.metric, evidencePath: ".dream-rsi/auto/log.jsonl" });
    commit = receipt.hash; config.expectedHead = receipt.hash; config.best = run.metric; best = run.metric; outcome = "kept";
  } else if (!keep && !recoveringDiscard) await discard(config);
  if (recoveringCommit) best = config.best;
  const item: AutoLog = { run: run.runNumber, id: run.id, status: outcome, metric: run.metric, best, commit,
    description, ...(hypothesis ? { hypothesis } : {}), confidence: outcome === "kept" ? confirmation.confidence : 0, at: new Date().toISOString() };
  appendLog(projectDir, item);
  mergeStopRequest(config);
  advanceAutoConfig(config, item);
  writeConfig(config);
  fs.rmSync(runPath(projectDir), { force: true });
  writePrompt(config, readLog(projectDir));
  return item;
}
export function refreshAutoPrompt(projectDir: string): void {
  const config = readConfig(projectDir);
  writePrompt(config, readLog(projectDir));
}
export function autoLogTail(projectDir: string): string { return readLog(projectDir).slice(-20).map((row) => JSON.stringify(row)).join("\n").slice(-12_000); }

export function statusAuto(projectDir: string): { state: string; runs: number; best: number; confidence: number; providerCap: number; branch: string; next: string; config: Pick<AutoConfig, "maxExperiments" | "unit" | "stopRequested" | "stopReason"> } {
  const config = readConfig(projectDir);
  const rows = readLog(projectDir);
  const confidence = [...rows].reverse().find((row) => row.status === "kept")?.confidence ?? 0;
  const stopping = config.stopRequested === true;
  const running = runLockActive(projectDir, false);
  return { state: config.state === "stopped" ? "stopped" : stopping ? "stopping" : running ? "running" : "active", runs: config.runs, best: config.best, confidence, providerCap: config.providerCap!,
    branch: config.branch, next: config.state === "stopped" ? config.stopReason ?? "stopped" : stopping ? fs.existsSync(runPath(projectDir)) ? "log the last experiment to finish stopping" : "current experiment is finishing; do not start another" : running ? "measurement is running" : fs.existsSync(runPath(projectDir)) ? "log the last experiment" : "propose one idea, then run it",
    config: { maxExperiments: config.maxExperiments, unit: config.unit, stopRequested: config.stopRequested, stopReason: config.stopReason } };
}
export function stopAuto(projectDir: string): void {
  const config = readConfig(projectDir);
  if (runLockActive(projectDir) || fs.existsSync(runPath(projectDir))) {
    config.stopRequested = true; config.stopReason = "operator stop requested";
  } else { config.state = "stopped"; config.stopRequested = false; config.stopReason = "operator stopped"; }
  writeConfig(config);
}

/** Return the bounded retry count only for an active auto session with transient provider errors. */
export function autoProviderRetryCount(projectDir: string): number | null {
  try {
    const config = readConfig(projectDir);
    return config.state === "active" && !config.stopRequested && config.providerFailure === "transient"
      && (config.providerTransientRetries ?? 0) < 3 ? config.providerTransientRetries ?? 0 : null;
  } catch { return null; }
}

/** Persist provider failures without retaining provider text, which may contain sensitive data. */
export function recordAutoProviderOutcome(projectDir: string, message: { stopReason?: string; errorMessage?: string } | null): void {
  let config: AutoConfig;
  try { config = readConfig(projectDir); } catch { return; }
  const text = `${message?.stopReason ?? ""} ${message?.errorMessage ?? ""}`;
  if (!message || (!message.stopReason && !message.errorMessage)) {
    if (config.providerTransientRetries || config.providerFailure) {
      config.providerTransientRetries = 0; config.providerFailure = null; writeConfig(config);
    }
    return;
  }
  const quota = /quota|billing|insufficient[_ ]credit|usage limit|limit reached|maximum.{0,20}(tokens|spend)|payment required|out of credits/i.test(text);
  const transient = /429|rate.?limit|too many requests|\b5\d\d\b|temporar|overloaded|timed? ?out/i.test(text);
  if (!quota && !transient) {
    if (config.providerTransientRetries || config.providerFailure) { config.providerTransientRetries = 0; config.providerFailure = null; writeConfig(config); }
    return;
  }
  config.providerFailure = quota ? "quota" : "transient";
  config.providerTransientRetries = quota ? config.providerTransientRetries ?? 0 : (config.providerTransientRetries ?? 0) + 1;
  if (quota) {
    if (runLockActive(projectDir) || fs.existsSync(runPath(projectDir))) { config.stopRequested = true; config.stopReason = "provider cap/quota rejected the request; stopping after the pending run is logged"; }
    else { config.state = "stopped"; config.stopReason = "provider cap/quota rejected the request"; }
  } else if (config.providerTransientRetries >= 3) {
    if (runLockActive(projectDir) || fs.existsSync(runPath(projectDir))) { config.stopRequested = true; config.stopReason = "three transient provider failures; stopping after the pending run is logged"; }
    else { config.state = "stopped"; config.stopReason = "three transient provider failures"; }
  }
  writeConfig(config);
}
