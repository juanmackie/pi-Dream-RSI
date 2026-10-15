import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const SESSION_MAX_BYTES = 20 * 1024 * 1024;
const SESSION_LIMIT = 30;
const SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const GIT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const SMALL_FILE_MAX_BYTES = 256 * 1024;
const CAMPAIGN_FILE_MAX_BYTES = 128 * 1024;
const GIT_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_WEAKNESSES = 10;

export interface SignalEvidence {
  source: "session" | "git" | "evaluator" | "campaign";
  ref: string;
  count: number;
}

export interface SignalWeakness {
  kind: "session-failure" | "slow-command" | "post-failure-edits" | "git-hotspot" | "git-churn" | "evaluator" | "campaign-failure" | "campaign-rejection";
  summary: string;
  evidence: SignalEvidence[];
  suggestedMetric: string;
}

export interface SignalsResult {
  weaknesses: SignalWeakness[];
  diagnostics: string[];
}

export interface CollectSignalsOptions {
  projectDir: string;
  focus?: string;
  includeLogs?: boolean;
  /** Supplied by the active session manager; never inferred from a project path. */
  sessionDir?: string;
  now: Date;
}

interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  timestamp: number | null;
  order: number;
}

interface ToolResultRecord {
  id: string;
  name: string;
  message: Record<string, unknown>;
  timestamp: number | null;
  order: number;
}

interface SessionFacts {
  failures: Map<string, { count: number; lastSeen: number; error: string }>;
  durations: Map<string, { count: number; total: number; max: number }>;
  edits: Map<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && Number.isFinite(new Date(value).getTime())) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function suspiciousPath(value: string): boolean {
  return /(?:^|[\\/])(?:\.env(?:\.|$)|secrets?|credentials?|tokens?|private|auth)(?:[\\/._-]|$)/i.test(value)
    || /(?:^|[\\/])(?:customers?|clients?)[-_]/i.test(value)
    || /[\r\n\0]/.test(value)
    || /(?:^|[\\/])[A-Za-z0-9_-]{24,}(?:\.[A-Za-z0-9]+)?(?:$|[\\/])/i.test(value)
    || /(?:^|[\\/])(?:sk|pk|ghp|github_pat|xox[baprs])-[-_A-Za-z0-9]{8,}(?:\.[A-Za-z0-9]+)?(?:$|[\\/])/i.test(value)
    || /(?:^|[\\/])[^\\/]*(?:key|token|secret|credential|password)[^\\/]*(?:$|[\\/])/i.test(value)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value);
}

function safeProjectPath(projectDir: string, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const absolute = path.resolve(projectDir, raw);
  if (!isPathInside(projectDir, absolute)) return null;
  const relative = path.relative(projectDir, absolute).replace(/\\/g, "/");
  if (!relative || relative === "." || suspiciousPath(relative)) return null;
  return relative;
}

function cleanError(raw: string): string {
  const line = raw.split(/\r?\n/, 1)[0];
  const errorClass = /\b(TypeError|ReferenceError|SyntaxError|RangeError|AssertionError|Error)\b/.exec(line)?.[1] ?? "Error";
  const category = /timeout|timed out/i.test(line) ? "timeout"
    : /permission denied|access denied/i.test(line) ? "permission denied"
      : /not found|enoent|cannot find module/i.test(line) ? "missing file or module"
        : /syntaxerror|parse error|unexpected token/i.test(line) ? "syntax or parse error"
          : /assert|test failed|failed assertion/i.test(line) ? "test assertion failed"
            : /authorization|unauthorized|\b401\b|\b403\b/i.test(line) ? "authorization failure"
              : /network|econn|connection refused/i.test(line) ? "network failure" : "tool reported an error";
  return `${errorClass}: ${category} [details redacted]`.slice(0, 160);
}

function commandHead(value: unknown): string {
  if (typeof value !== "string") return "shell command";
  const command = value.trim();
  if (/^npm\s+test(?=$|[\s;&|])/i.test(command)) return "npm test";
  const match = /^npm\s+run\s+(test(?::[A-Za-z0-9_-]+)?|bench(?:[A-Za-z0-9:_-]*)|perf(?:[A-Za-z0-9:_-]*))(?=$|[\s;&|])/i.exec(command);
  if (match) {
    const script = match[1].toLowerCase();
    if (script.startsWith("test")) return "npm test";
    if (script.startsWith("bench")) return "npm benchmark";
    return "npm performance";
  }
  if (/^(?:python(?:3(?:\.\d+)?)?\s+-m\s+pytest|pytest)(?=$|[\s;&|])/i.test(command)) return "pytest";
  if (/^node(?:\.exe)?(?=$|[\s;&|])/i.test(command)) return "node";
  if (/^git(?:\.exe)?(?=$|[\s;&|])/i.test(command)) return "git";
  return "shell command";
}

function messageText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content.filter(isTextBlock).map((block) => block.text).join("\n");
}

function getDuration(call: ToolCallRecord, result: ToolResultRecord): number | null {
  const details = result.message.details;
  if (isRecord(details) && typeof details.durationMs === "number" && Number.isFinite(details.durationMs) && details.durationMs >= 0) {
    return details.durationMs;
  }
  const resultTime = timestamp(result.message.timestamp) ?? result.timestamp;
  if (call.timestamp !== null && resultTime !== null && resultTime >= call.timestamp) return resultTime - call.timestamp;
  return null;
}

function readBoundedRegularFile(file: string, maxBytes: number): string | null {
  let handle: number | null = null;
  try {
    const linkStats = fs.lstatSync(file);
    if (!linkStats.isFile() || linkStats.size > maxBytes) return null;
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    handle = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const stats = fs.fstatSync(handle);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
    let total = 0;
    while (total < maxBytes) {
      const size = Math.min(buffer.length, maxBytes - total);
      const bytesRead = fs.readSync(handle, buffer, 0, size, total);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
    }
    const after = fs.fstatSync(handle);
    if (after.size > maxBytes) return null;
    return Buffer.concat(chunks, total).toString("utf8");
  } catch {
    return null;
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

function collectOneSession(projectDir: string, content: string): SessionFacts | null {
  const untrusted: unknown = parseSessionEntries(content);
  if (!Array.isArray(untrusted)) return null;
  const entries = untrusted.filter(isRecord);
  const header = entries.find((entry) => entry.type === "session");
  if (!header || typeof header.cwd !== "string" || !samePath(projectDir, header.cwd)) return null;

  const calls: ToolCallRecord[] = [];
  const results: ToolResultRecord[] = [];
  let order = 0;
  for (const entry of entries) {
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    const entryTime = timestamp(entry.timestamp);
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.arguments)) continue;
        calls.push({ id: block.id, name: block.name, args: block.arguments, timestamp: timestamp(message.timestamp) ?? entryTime, order: order++ });
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string" && typeof message.toolName === "string") {
      results.push({ id: message.toolCallId, name: message.toolName, message, timestamp: timestamp(message.timestamp) ?? entryTime, order: order++ });
    }
  }

  const resultById = new Map(results.map((result) => [result.id, result]));
  const failures = new Map<string, { count: number; lastSeen: number; error: string }>();
  const durations = new Map<string, { count: number; total: number; max: number }>();
  const edits = new Map<string, number>();
  const callResults = new Map<string, { call: ToolCallRecord; result: ToolResultRecord }>();
  for (const call of calls) {
    const result = resultById.get(call.id);
    if (!result || result.name !== call.name) continue;
    callResults.set(call.id, { call, result });
    const duration = call.name === "bash" || call.name === "powershell" ? getDuration(call, result) : null;
    if (duration !== null) {
      const head = commandHead(call.args.command ?? call.args.script);
      const old = durations.get(head) ?? { count: 0, total: 0, max: 0 };
      durations.set(head, { count: old.count + 1, total: old.total + duration, max: Math.max(old.max, duration) });
    }
    if (result.message.isError === true && (call.name === "bash" || call.name === "powershell")) {
      const head = commandHead(call.args.command ?? call.args.script);
      const error = cleanError(messageText(result.message));
      const lastSeen = result.timestamp ?? call.timestamp ?? 0;
      const old = failures.get(head);
      failures.set(head, { count: (old?.count ?? 0) + 1, lastSeen: Math.max(old?.lastSeen ?? 0, lastSeen), error: old?.error || error });
    }
  }

  for (const call of calls) {
    const failed = callResults.get(call.id);
    if (!failed || failed.result.message.isError !== true || (call.name !== "bash" && call.name !== "powershell")) continue;
    const laterCalls = calls.filter((next) => next.order > failed.result.order).slice(0, 3);
    for (const next of laterCalls) {
      if (next.name !== "edit" && next.name !== "write") continue;
      const outcome = callResults.get(next.id);
      if (!outcome || outcome.result.message.isError === true) continue;
      const file = safeProjectPath(projectDir, next.args.path);
      if (file) edits.set(file, (edits.get(file) ?? 0) + 1);
    }
  }
  return { failures, durations, edits };
}

function aggregateSessionFacts(facts: SessionFacts[]): SessionFacts {
  const aggregate: SessionFacts = { failures: new Map(), durations: new Map(), edits: new Map() };
  for (const session of facts) {
    for (const [key, value] of session.failures) {
      const current = aggregate.failures.get(key);
      aggregate.failures.set(key, {
        count: (current?.count ?? 0) + value.count,
        lastSeen: Math.max(current?.lastSeen ?? 0, value.lastSeen),
        error: current?.error || value.error,
      });
    }
    for (const [key, value] of session.durations) {
      const current = aggregate.durations.get(key) ?? { count: 0, total: 0, max: 0 };
      aggregate.durations.set(key, { count: current.count + value.count, total: current.total + value.total, max: Math.max(current.max, value.max) });
    }
    for (const [key, value] of session.edits) aggregate.edits.set(key, (aggregate.edits.get(key) ?? 0) + value);
  }
  return aggregate;
}

function collectSessionSignals(projectDir: string, sessionDir: string | undefined, now: Date, diagnostics: string[]): SignalWeakness[] {
  if (!sessionDir) {
    diagnostics.push("Session-log signals were skipped because the active session directory is unavailable.");
    return [];
  }
  let names: string[];
  try {
    const directory = fs.lstatSync(sessionDir);
    if (!directory.isDirectory()) throw new Error("not a directory");
    names = fs.readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    diagnostics.push("Session-log signals were skipped because the supplied session directory could not be read.");
    return [];
  }
  const oldest = now.getTime() - SESSION_AGE_MS;
  let skipped = 0;
  const candidates = names.flatMap((name) => {
    const file = path.join(sessionDir, name);
    try {
      const stats = fs.lstatSync(file);
      if (!stats.isFile()) return [];
      if (stats.size > SESSION_MAX_BYTES) { skipped += 1; return []; }
      const modified = stats.mtimeMs;
      if (!Number.isFinite(modified) || modified < oldest || modified > now.getTime()) return [];
      return [{ file, modified }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file)).slice(0, SESSION_LIMIT);
  const facts: SessionFacts[] = [];
  for (const candidate of candidates) {
    const content = readBoundedRegularFile(candidate.file, SESSION_MAX_BYTES);
    if (content === null) { skipped += 1; continue; }
    try {
      const parsed = collectOneSession(projectDir, content);
      if (parsed) facts.push(parsed);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) diagnostics.push(`Session-log signals skipped ${skipped} unreadable, oversized, or unrelated session files.`);
  const aggregate = aggregateSessionFacts(facts);
  const weaknesses: SignalWeakness[] = [];
  for (const [head, failure] of [...aggregate.failures].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))) {
    const lastSeen = new Date(failure.lastSeen).toISOString();
    weaknesses.push({
      kind: "session-failure",
      summary: `${head} failed ${failure.count} times; last seen ${lastSeen}.${failure.error ? ` First error: ${failure.error}` : ""}`,
      evidence: [{ source: "session", ref: head, count: failure.count }],
      suggestedMetric: `Reduce failed ${head} runs in recent session logs.`,
    });
  }
  for (const [head, duration] of [...aggregate.durations].sort((a, b) => b[1].max - a[1].max || a[0].localeCompare(b[0])).slice(0, 3)) {
    weaknesses.push({
      kind: "slow-command",
      summary: `${head} took up to ${Math.round(duration.max)} ms across ${duration.count} recorded calls.`,
      evidence: [{ source: "session", ref: head, count: duration.count }],
      suggestedMetric: `Reduce the duration of ${head}.`,
    });
  }
  const topEdits = [...aggregate.edits].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  if (topEdits.length > 0) {
    weaknesses.push({
      kind: "post-failure-edits",
      summary: `Files edited within three tool calls after failures: ${topEdits.map(([file, count]) => `${file} (${count})`).join(", ")}.`,
      evidence: topEdits.map(([file, count]) => ({ source: "session", ref: file, count })),
      suggestedMetric: "Reduce failures that require follow-up file edits.",
    });
  }
  return weaknesses;
}

interface GitCommit {
  subject: string;
  paths: string[];
}

function parseGitLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const block of output.split("\x1e")) {
    if (!block.trim()) continue;
    const lines = block.replace(/^\r?\n/, "").split(/\r?\n/);
    const subject = lines.shift()?.trim() ?? "";
    const paths = lines.map((line) => line.trim()).filter(Boolean);
    if (subject) commits.push({ subject, paths });
  }
  return commits;
}

function commitCategories(subject: string): string[] {
  const lower = subject.toLowerCase();
  const categories: string[] = [];
  for (const category of ["fix", "revert", "regress", "flaky", "slow", "perf", "timeout"]) {
    if (new RegExp(`\\b${category}(?:ed|s|ing)?\\b`, "i").test(lower)) categories.push(category);
  }
  return categories;
}

function safeGitPath(projectDir: string, raw: string): string | null {
  if (path.isAbsolute(raw) || raw.includes("\\") || raw.startsWith("-") || raw.split("/").some((part) => part === ".." || part === ".")) return null;
  return safeProjectPath(projectDir, raw);
}

async function collectGitSignals(projectDir: string, now: Date, diagnostics: string[]): Promise<SignalWeakness[]> {
  const cutoff = new Date(now.getTime() - GIT_AGE_MS).toISOString();
  try {
    const { stdout } = await execFileAsync("git", ["log", `--since=${cutoff}`, "--name-only", "--pretty=format:%x1e%s"], {
      cwd: projectDir,
      windowsHide: true,
      maxBuffer: GIT_OUTPUT_MAX_BYTES,
      timeout: 5_000,
    });
    const commits = parseGitLog(stdout);
    const categoryCounts = new Map<string, number>();
    const pathCounts = new Map<string, number>();
    for (const commit of commits) {
      for (const category of commitCategories(commit.subject)) categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      for (const rawPath of commit.paths) {
        const safePath = safeGitPath(projectDir, rawPath);
        if (safePath) pathCounts.set(safePath, (pathCounts.get(safePath) ?? 0) + 1);
      }
    }
    const weaknesses: SignalWeakness[] = [];
    for (const [category, count] of [...categoryCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      const weakness: SignalWeakness = {
        kind: "git-hotspot",
        summary: `${count} recent commits mention ${category}-related work.`,
        evidence: [{ source: "git", ref: category, count }],
        suggestedMetric: `Measure whether ${category}-related changes reduce the observed issue.`,
      };
      privateFocusText.set(weakness, commits.filter((commit) => commitCategories(commit.subject).includes(category)).map((commit) => commit.subject).join(" "));
      weaknesses.push(weakness);
    }
    const topPaths = [...pathCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
    if (topPaths.length > 0) {
      weaknesses.push({
        kind: "git-churn",
        summary: `Most changed safe paths in the last 90 days: ${topPaths.map(([file, count]) => `${file} (${count})`).join(", ")}.`,
        evidence: topPaths.map(([file, count]) => ({ source: "git", ref: file, count })),
        suggestedMetric: "Measure the goal-specific outcome in the most frequently changed code.",
      });
    }
    return weaknesses;
  } catch {
    diagnostics.push("Git history signals are unavailable because git could not read this project.");
    return [];
  }
}

function readJsonFile(file: string, limit: number): unknown {
  const content = readBoundedRegularFile(file, limit);
  if (content === null) return null;
  try { return JSON.parse(content); } catch { return null; }
}

function evaluatorSignals(projectDir: string, diagnostics: string[]): SignalWeakness[] {
  const categories = new Map<string, { source: string; count: number }>();
  const packageJson = readJsonFile(path.join(projectDir, "package.json"), SMALL_FILE_MAX_BYTES);
  if (isRecord(packageJson) && isRecord(packageJson.scripts)) {
    for (const key of Object.keys(packageJson.scripts)) {
      const lower = key.toLowerCase();
      const category = lower === "test" || lower.startsWith("test:") ? "test"
        : lower.startsWith("bench") ? "benchmark"
          : lower.startsWith("perf") ? "performance" : null;
      if (category) {
        const value = categories.get(category) ?? { source: "package.json", count: 0 };
        categories.set(category, { source: value.source, count: value.count + 1 });
      }
    }
  }
  for (const file of ["pyproject.toml", "Makefile"] as const) {
    const content = readBoundedRegularFile(path.join(projectDir, file), SMALL_FILE_MAX_BYTES);
    if (content === null) continue;
    if (file === "pyproject.toml") {
      if (/\[tool\.pytest(?:ini|\.ini)?\]/i.test(content) || /\[tool\.pytest\./i.test(content)) categories.set("pytest", { source: file, count: 1 });
      if (/\[tool\.(?:pytest|asv|benchmark)[^\]]*\]/i.test(content)) categories.set("benchmark", { source: file, count: 1 });
    } else {
      for (const match of content.matchAll(/^([A-Za-z0-9_.:-]+)\s*:/gm)) {
        const key = match[1].toLowerCase();
        const category = key === "test" || key.startsWith("test:") ? "test"
          : key.startsWith("bench") ? "benchmark"
            : key.startsWith("perf") ? "performance" : null;
        if (category) {
          const value = categories.get(category) ?? { source: file, count: 0 };
          categories.set(category, { source: value.source, count: value.count + 1 });
        }
      }
    }
  }
  if (fs.existsSync(path.join(projectDir, "package.json")) && packageJson === null) diagnostics.push("Evaluator signals skipped an unreadable or oversized package.json.");
  return [...categories].map(([category, value]) => ({
    kind: "evaluator",
    summary: `The project declares ${value.count} ${category} evaluator target${value.count === 1 ? "" : "s"}.`,
    evidence: [{ source: "evaluator", ref: `${value.source}:${category}`, count: value.count }],
    suggestedMetric: `Use the existing ${category} evaluator as a correctness gate or measurement input.`,
  }));
}

function classifyCampaignReason(value: unknown): string {
  if (typeof value !== "string") return "unknown failure";
  const lower = value.toLowerCase();
  if (/timeout|timed out/.test(lower)) return "timeout";
  if (/evaluator|scorer|score_program/.test(lower)) return "evaluator failure";
  if (/gate|test/.test(lower)) return "gate failure";
  if (/review|reject/.test(lower)) return "review rejection";
  if (/agent|provider|model/.test(lower)) return "agent failure";
  if (/baseline|noise|spread/.test(lower)) return "baseline variance";
  return "campaign failure";
}

function collectCampaignSignals(projectDir: string, diagnostics: string[]): SignalWeakness[] {
  const root = path.join(projectDir, ".dream-rsi", "campaigns");
  let directories: string[];
  try {
    if (!fs.lstatSync(root).isDirectory()) return [];
    directories = fs.readdirSync(root).sort((a, b) => a.localeCompare(b)).slice(-50).filter((name) => {
      try { return fs.lstatSync(path.join(root, name)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
  const failures = new Map<string, number>();
  const rejections = new Map<string, number>();
  let skipped = 0;
  let skippedRejectionFiles = 0;
  for (const directory of directories) {
    const campaignRoot = path.join(root, directory);
    const campaign = readJsonFile(path.join(campaignRoot, "campaign.json"), CAMPAIGN_FILE_MAX_BYTES);
    if (campaign === null) { skipped += 1; continue; }
    if (isRecord(campaign) && isRecord(campaign.state) && campaign.state.kind === "failed") {
      const category = classifyCampaignReason(campaign.state.reason);
      failures.set(category, (failures.get(category) ?? 0) + 1);
    }
    const rejectionFile = path.join(campaignRoot, "history", "rejections.jsonl");
    const raw = readBoundedRegularFile(rejectionFile, CAMPAIGN_FILE_MAX_BYTES);
    if (raw === null) {
      try { fs.lstatSync(rejectionFile); skippedRejectionFiles += 1; } catch { /* No rejection history is normal. */ }
      continue;
    }
    for (const line of raw.trim().split(/\r?\n/).slice(-100)) {
      try {
        const item: unknown = JSON.parse(line);
        if (!isRecord(item)) continue;
        const category = typeof item.stage === "string" && ["metric", "gate", "review"].includes(item.stage.toLowerCase())
          ? item.stage.toLowerCase() : "candidate rejection";
        rejections.set(category, (rejections.get(category) ?? 0) + 1);
      } catch { /* Ignore an incomplete final line. */ }
    }
  }
  if (skipped > 0) diagnostics.push(`Campaign history skipped ${skipped} unreadable campaign records.`);
  if (skippedRejectionFiles > 0) diagnostics.push(`Campaign history skipped ${skippedRejectionFiles} unreadable or oversized rejection files.`);
  const output: SignalWeakness[] = [];
  for (const [category, count] of failures) {
    output.push({ kind: "campaign-failure", summary: `${count} past campaigns ended with ${category}.`, evidence: [{ source: "campaign", ref: category, count }], suggestedMetric: `Resolve the recurring ${category} before another campaign.` });
  }
  for (const [category, count] of rejections) {
    output.push({ kind: "campaign-rejection", summary: `${count} candidate rejections were recorded at the ${category} stage.`, evidence: [{ source: "campaign", ref: category, count }], suggestedMetric: `Reduce candidate rejection at the ${category} stage.` });
  }
  return output;
}

const privateFocusText = new WeakMap<SignalWeakness, string>();

function focusScore(weakness: SignalWeakness, focus: string): number {
  const terms = focus.toLowerCase().match(/[a-z0-9]+/g)?.filter((term) => term.length > 1) ?? [];
  if (terms.length === 0) return 0;
  const evidence = weakness.evidence.map((item) => item.ref.toLowerCase()).join(" ");
  const summary = weakness.summary.toLowerCase();
  const privateText = privateFocusText.get(weakness)?.toLowerCase() ?? "";
  return terms.reduce((score, term) => score + (evidence.includes(term) ? 2 : 0) + (summary.includes(term) ? 1 : 0) + (privateText.includes(term) ? 1 : 0), 0);
}

function signalPriority(weakness: SignalWeakness): number {
  switch (weakness.kind) {
    case "session-failure": return 0;
    case "post-failure-edits": return 1;
    case "slow-command": return 2;
    case "campaign-failure": return 3;
    case "campaign-rejection": return 4;
    case "git-hotspot": return 5;
    case "git-churn": return 6;
    case "evaluator": return 7;
  }
}

function evidenceCount(weakness: SignalWeakness): number {
  return weakness.evidence.reduce((total, item) => total + item.count, 0);
}

export async function collectSignals(options: CollectSignalsOptions): Promise<SignalsResult> {
  const projectDir = path.resolve(options.projectDir);
  const now = options.now;
  const diagnostics: string[] = [];
  const weaknesses = [
    ...(options.includeLogs === false ? [] : collectSessionSignals(projectDir, options.sessionDir, now, diagnostics)),
    ...(await collectGitSignals(projectDir, now, diagnostics)),
    ...evaluatorSignals(projectDir, diagnostics),
    ...collectCampaignSignals(projectDir, diagnostics),
  ];
  const focus = options.focus?.trim() ?? "";
  weaknesses.sort((a, b) => focusScore(b, focus) - focusScore(a, focus)
    || signalPriority(a) - signalPriority(b)
    || evidenceCount(b) - evidenceCount(a)
    || a.kind.localeCompare(b.kind)
    || a.summary.localeCompare(b.summary));
  return { weaknesses: weaknesses.slice(0, MAX_WEAKNESSES), diagnostics };
}
