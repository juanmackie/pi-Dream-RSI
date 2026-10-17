import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { ledgerDigest, readLedger, type LedgerEntry } from "./ledger.ts";

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
  kind: "session-failure" | "slow-command" | "post-failure-edits" | "session-tool-error" | "repeated-tool-retry" | "aborted-session" | "session-compaction" | "session-model-change" | "dream-improve" | "git-hotspot" | "git-churn" | "evaluator" | "campaign-failure" | "campaign-rejection" | "campaign-health";
  summary: string;
  evidence: SignalEvidence[];
  suggestedMetric: string;
  /**
   * Project-relative files edited right after recorded command failures in the
   * sessions where this command failed. Command levers use them as the patch
   * scope, so a failing command can become a campaign without inventing a
   * scope that no recorded evidence supports. Absent when no such edit exists.
   */
  scopeHints?: string[];
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

/** Collect only bounded same-project campaign facts; digest consumers never receive ledger paths. */
export function collectLedgerEntries(projectDir: string): LedgerEntry[] {
  const root = path.join(path.resolve(projectDir), ".dream-rsi", "campaigns");
  let campaigns: string[];
  try { campaigns = fs.readdirSync(root).sort().slice(-50); } catch { return []; }
  const entries: LedgerEntry[] = [];
  for (const campaign of campaigns) entries.push(...readLedger(path.join(root, campaign, "history", "ledger.jsonl")).entries);
  return entries;
}

export function collectCampaignDigest(projectDir: string, maxChars = 1500): string {
  return ledgerDigest(collectLedgerEntries(projectDir), maxChars);
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
  /** Files edited right after a failure of each head, keyed by that head. */
  editsByHead: Map<string, Map<string, number>>;
  structural: Map<string, number>;
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
  // Other JS runners execute the same package scripts; bucket them with npm test.
  if (/^(?:yarn|pnpm|bun)(?:\.exe)?\s+test(?=$|[\s;&|])/i.test(command)) return "npm test";
  if (/^(?:python(?:3(?:\.\d+)?)?\s+-m\s+pytest|pytest)(?=$|[\s;&|])/i.test(command)) return "pytest";
  // Language-agnostic test heads: safe canonical labels only, never raw command text.
  if (/^cargo(?:\.exe)?\s+bench(?=$|[\s;&|])/i.test(command)) return "cargo benchmark";
  if (/^cargo(?:\.exe)?\s+(?:test|nextest)(?=$|[\s;&|])/i.test(command)) return "cargo test";
  if (/^go(?:\.exe)?\s+test(?=$|[\s;&|])/i.test(command)) return "go test";
  if (/^(?:mvn(?:\.cmd|\.exe)?|mvnw(?:\.cmd)?)\s+(?:[^\s;&|]+\s+)*test(?=$|[\s;&|])/i.test(command)) return "maven test";
  if (/^(?:gradle(?:\.exe|\.bat)?|gradlew(?:\.bat)?)(?=$|[\s;&|])/i.test(command) && /(^|[\s;&|])test(?=$|[\s;&|])/i.test(command)) return "gradle test";
  if (/^dotnet(?:\.exe)?\s+test(?=$|[\s;&|])/i.test(command)) return "dotnet test";
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
  const editsByHead = new Map<string, Map<string, number>>();
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
    const head = commandHead(failed.call.args.command ?? failed.call.args.script);
    const laterCalls = calls.filter((next) => next.order > failed.result.order).slice(0, 3);
    for (const next of laterCalls) {
      if (next.name !== "edit" && next.name !== "write") continue;
      const outcome = callResults.get(next.id);
      if (!outcome || outcome.result.message.isError === true) continue;
      const file = safeProjectPath(projectDir, next.args.path);
      if (!file) continue;
      edits.set(file, (edits.get(file) ?? 0) + 1);
      const bucket = editsByHead.get(head) ?? new Map<string, number>();
      bucket.set(file, (bucket.get(file) ?? 0) + 1);
      editsByHead.set(head, bucket);
    }
  }
  const structural = new Map<string, number>();
  const bump = (key: string): void => { structural.set(key, (structural.get(key) ?? 0) + 1); };
  const retryCounts = new Map<string, number>();
  for (const { call, result } of callResults.values()) {
    const isError = result.message.isError === true;
    if (isError) bump("tool-error");
    // Hash arguments only; neither raw arguments nor hashes leave this in-memory mining pass.
    const argsHash = createHash("sha256").update(JSON.stringify(call.args)).digest("hex");
    if (isError) retryCounts.set(`${call.name}:${argsHash}`, (retryCounts.get(`${call.name}:${argsHash}`) ?? 0) + 1);
    if (call.name === "dream_rsi_improve" || call.name === "dream-rsi-improve") bump("dream-improve");
  }
  structural.set("repeated-retries", [...retryCounts.values()].filter((count) => count >= 3).length);
  const models = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "compaction_summary") bump("compaction");
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;
    if (["aborted", "error", "length"].includes(String(message.stopReason))) bump(`stop-${message.stopReason}`);
    if (typeof message.model === "string") models.add(message.model);
  }
  if (models.size > 1) structural.set("model-change", models.size - 1);
  return { failures, durations, edits, editsByHead, structural };
}

function aggregateSessionFacts(facts: SessionFacts[]): SessionFacts {
  const aggregate: SessionFacts = { failures: new Map(), durations: new Map(), edits: new Map(), editsByHead: new Map(), structural: new Map() };
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
    for (const [head, files] of session.editsByHead) {
      const bucket = aggregate.editsByHead.get(head) ?? new Map<string, number>();
      for (const [file, count] of files) bucket.set(file, (bucket.get(file) ?? 0) + count);
      aggregate.editsByHead.set(head, bucket);
    }
    for (const [key, value] of session.structural) aggregate.structural.set(key, (aggregate.structural.get(key) ?? 0) + value);
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
  // Per-command edit hints: files edited right after a failure of this very
  // head. Command levers use them as the patch scope, so a failing command can
  // become a campaign without inventing a scope that no evidence supports.
  const scopeHintsFor = (head: string): string[] => [...(aggregate.editsByHead.get(head) ?? new Map<string, number>())]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([file]) => file);
  const weaknesses: SignalWeakness[] = [];
  for (const [head, failure] of [...aggregate.failures].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))) {
    const lastSeen = new Date(failure.lastSeen).toISOString();
    const hints = scopeHintsFor(head);
    weaknesses.push({
      kind: "session-failure",
      summary: `${head} failed ${failure.count} times; last seen ${lastSeen}.${failure.error ? ` First error: ${failure.error}` : ""}`,
      evidence: [{ source: "session", ref: head, count: failure.count }],
      suggestedMetric: `Reduce failed ${head} runs in recent session logs.`,
      ...(hints.length > 0 ? { scopeHints: hints } : {}),
    });
  }
  for (const [head, duration] of [...aggregate.durations].sort((a, b) => b[1].max - a[1].max || a[0].localeCompare(b[0])).slice(0, 3)) {
    const hints = scopeHintsFor(head);
    weaknesses.push({
      kind: "slow-command",
      summary: `${head} took up to ${Math.round(duration.max)} ms across ${duration.count} recorded calls.`,
      evidence: [{ source: "session", ref: head, count: duration.count }],
      suggestedMetric: `Reduce the duration of ${head}.`,
      ...(hints.length > 0 ? { scopeHints: hints } : {}),
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
  const structuralLabels: Record<string, { kind: SignalWeakness["kind"]; summary: (count: number) => string; metric: string }> = {
    "tool-error": { kind: "session-tool-error", summary: (count) => `${count} tool errors were recorded across recent sessions.`, metric: "Reduce tool errors across recent sessions." },
    "repeated-retries": { kind: "repeated-tool-retry", summary: (count) => `${count} tool and argument combinations failed at least three times.`, metric: "Avoid repeating an unchanged failing tool call." },
    "stop-aborted": { kind: "aborted-session", summary: (count) => `${count} assistant runs ended as aborted.`, metric: "Reduce aborted assistant runs." },
    "stop-error": { kind: "aborted-session", summary: (count) => `${count} assistant runs ended with an error stop reason.`, metric: "Reduce assistant runs ending with an error." },
    "stop-length": { kind: "aborted-session", summary: (count) => `${count} assistant runs stopped at the output limit.`, metric: "Reduce assistant runs reaching the output limit." },
    compaction: { kind: "session-compaction", summary: (count) => `${count} session compactions were recorded.`, metric: "Reduce repeated context compaction where possible." },
    "model-change": { kind: "session-model-change", summary: (count) => `${count} model transitions were recorded in sessions.`, metric: "Keep model changes deliberate and observable." },
    "dream-improve": { kind: "dream-improve", summary: (count) => `${count} Dream-RSI improvement tool calls were recorded.`, metric: "Review Dream-RSI improvement outcomes against confirms." },
  };
  for (const [key, count] of aggregate.structural) {
    if (count <= 0) continue;
    const label = structuralLabels[key];
    if (label) weaknesses.push({ kind: label.kind, summary: label.summary(count), evidence: [{ source: "session", ref: key, count }], suggestedMetric: label.metric });
  }
  return weaknesses;
}

/** Discover recent project roots from session headers; returned paths stay in-process for mining only. */
export function discoverSessionProjects(sessionDir: string | undefined, now = new Date()): string[] {
  if (!sessionDir) return [];
  let names: string[];
  try {
    if (!fs.lstatSync(sessionDir).isDirectory()) return [];
    names = fs.readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
  } catch { return []; }
  const oldest = now.getTime() - SESSION_AGE_MS;
  const candidates = names.flatMap((name) => {
    const file = path.join(sessionDir, name);
    try {
      const stats = fs.lstatSync(file);
      if (!stats.isFile() || stats.size > SESSION_MAX_BYTES || stats.mtimeMs < oldest || stats.mtimeMs > now.getTime()) return [];
      return [{ file, modified: stats.mtimeMs }];
    } catch { return []; }
  }).sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file)).slice(0, SESSION_LIMIT);
  const projects = new Set<string>();
  for (const candidate of candidates) {
    const content = readBoundedRegularFile(candidate.file, SESSION_MAX_BYTES);
    if (content === null) continue;
    try {
      const entries = parseSessionEntries(content);
      if (!Array.isArray(entries)) continue;
      const header = entries.find((entry) => isRecord(entry) && entry.type === "session");
      if (!isRecord(header) || typeof header.cwd !== "string") continue;
      const real = fs.realpathSync(header.cwd);
      if (fs.statSync(real).isDirectory()) projects.add(real);
    } catch { /* An unreadable or stale project is simply not a mining source. */ }
  }
  return [...projects].sort();
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
  // Language-agnostic manifests: presence of a standard build file implies its
  // conventional test entry point (cargo test, go test, mvn test, ...). Only
  // claim a benchmark target when the manifest names one.
  const manifestTests: Array<{ file: string }> = [
    { file: "Cargo.toml" },
    { file: "go.mod" },
    { file: "pom.xml" },
    { file: "build.gradle" },
    { file: "build.gradle.kts" },
    { file: "composer.json" },
    { file: "Gemfile" },
    { file: "mix.exs" },
  ];
  for (const { file } of manifestTests) {
    try {
      if (!fs.lstatSync(path.join(projectDir, file)).isFile()) continue;
    } catch { continue; }
    if (file === "Cargo.toml") {
      const content = readBoundedRegularFile(path.join(projectDir, file), SMALL_FILE_MAX_BYTES);
      if (content !== null && /\[\[bench\]\]|criterion/i.test(content)) {
        const value = categories.get("benchmark") ?? { source: file, count: 0 };
        categories.set("benchmark", { source: value.source, count: value.count + 1 });
      }
    }
    const value = categories.get("test") ?? { source: file, count: 0 };
    categories.set("test", { source: value.source, count: value.count + 1 });
  }
  try {
    const top = fs.readdirSync(projectDir, { withFileTypes: true });
    if (top.some((entry) => entry.isFile() && /\.(csproj|sln)$/i.test(entry.name))) {
      const value = categories.get("test") ?? { source: "dotnet", count: 0 };
      categories.set("test", { source: value.source, count: value.count + 1 });
    }
  } catch { /* An unreadable project directory simply yields no dotnet signal. */ }
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
  const ledger = collectLedgerEntries(projectDir);
  if (ledger.length) {
    const timeouts = ledger.filter((item) => item.kind === "attempt" && (item.outcome === "timeout" || item.facts?.timedOut === true)).length;
    const noEdits = ledger.filter((item) => item.kind === "attempt" && (item.editCount ?? 0) === 0).length;
    const agents = new Set(ledger.flatMap((item) => item.agent ? [item.agent] : []));
    output.push({ kind: "campaign-health", summary: `Prior campaign ledgers record ${ledger.length} events, ${timeouts} timeouts, ${noEdits} no-edit attempts, and ${agents.size} agents.`, evidence: [{ source: "campaign", ref: "ledger events", count: ledger.length }], suggestedMetric: "Improve confirmation rate while reducing timeout and no-edit attempts." });
  }
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
    case "session-tool-error": return 2;
    case "repeated-tool-retry": return 3;
    case "aborted-session": return 4;
    case "dream-improve": return 5;
    case "slow-command": return 6;
    case "session-compaction": return 7;
    case "session-model-change": return 8;
    case "campaign-failure": return 9;
    case "campaign-health": return 10;
    case "campaign-rejection": return 11;
    case "git-hotspot": return 12;
    case "git-churn": return 13;
    case "evaluator": return 14;
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
