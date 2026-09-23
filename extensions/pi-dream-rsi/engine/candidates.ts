/**
 * Candidate ranking, and the suggestion built from it.
 *
 * The loop never writes to your source tree, so the useful question after a cycle is not "what is the
 * best score" but "which candidate should I take, and what am I taking on". Score alone answers neither:
 * a candidate can win by caching what the benchmark repeats, or by trading a guarantee the scorer cannot
 * see. So each candidate is enriched with facts that are already on disk — secondary metrics the scorer
 * wrote, files that differ from your seed workspace, and the risk words its own proposal mentions — and
 * the ordering stays deterministic: same disk state, same recommendation.
 *
 * Everything here is a read. Nothing in this module runs an agent or a scorer.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { DiscoveryTree, type TreeJSON } from "./tree.ts";
import { attemptDir, iterationDir, readJson, readManifest } from "./world.ts";
import {
  appliedLogPath,
  readApplied,
  readSeedMeasurement,
  seedMatchesTask,
  type SeedMeasurement,
} from "./improvements.ts";
import { readTask, scoreMatchesDirection, scoringFingerprint, type TaskConfig } from "./task.ts";

/** A candidate has to beat the reference by this much before it is worth recommending. */
export const MIN_IMPROVEMENT_RATIO = 0.01;

/** `safest` keeps candidates that capture at least this share of the leader's improvement. */
export const MIN_WIN_FRACTION = 0.95;

/**
 * Words that mean "read this proposal before you apply it", never "this is wrong".
 * Tiered on purpose: a memo/cache is a mechanism, while a bounded staleness window or an approximation
 * is a *trade the scorer cannot see* — which is what the `safest` preference sorts on.
 */
const RISK_WORDS = ["cache", "cached", "memo", "memoize", "heuristic", "stale", "staleness", "window", "approx", "todo", "temporar"];
const HIGH_RISK_WORDS = new Set(["stale", "staleness", "window", "approx", "todo", "temporar"]);

/** Files that are data rather than code: reported, but never counted as a scoped edit. */
const DATA_EXTENSIONS = new Set([
  "db", "wal", "sqlite", "sqlite3", "bin", "parquet", "gz", "zip", "tar", "so", "dll", "pyc", "exe",
]);

/** Directories that are never part of a candidate's code change. */
const SKIP_DIRS = new Set([".git", ".dream-rsi", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv"]);
/** Scorer output and the attempt's own report: not candidate code. */
const SKIP_FILES = new Set(["proposal.md", "error.txt"]);

const ENGINE_KEYS = new Set(["score", "raw_score", "valid", "fail_class", "error"]);

export type PreferenceKind = "score" | "safe" | "simple";

export interface Preference {
  kind: PreferenceKind | null;
  /** What the operator's words were understood as. */
  label: string;
}

export interface ChangedFile {
  relative: string;
  before: number;
  after: number;
  /** Why this is data rather than code (database/binary/large), or null for a reviewable edit. */
  data_reason: string | null;
}

export interface RankedCandidate {
  iteration: number;
  cell: string;
  /** Normalised score: higher is better, whatever the scorer's own direction was. */
  score: number;
  raw_score: number | null;
  fail_class: string;
  workspace: string | null;
  program: string | null;
  /** Absolute path of the attempt record, when it exists. */
  record: string | null;
  delta_vs_seed: number | null;
  gain_pct: number | null;
  already_applied: boolean;
  applicable: boolean;
  /** Extra fields the scorer reported (search_p99_ms, assert_ok, …). */
  metrics: Record<string, number | string | boolean | null>;
  /** Reviewable code changes only. */
  changed_files: ChangedFile[];
  /** Files that differ but are data rather than code: disclosed, never counted as a scoped edit. */
  data_changed_files: ChangedFile[];
  out_of_scope_files: string[];
  proposal_summary: string | null;
  mentions: string[];
  /** Mentions that admit a trade the scorer cannot see (staleness window, approximation). */
  high_risk_mentions: string[];
  /** Ordering helper for the `safe` preference: lower is less to take on. */
  risk: number;
}

export interface Relevance {
  taskSummary: string;
  aligned: boolean;
}

export interface Ranking {
  goal: string | null;
  preference: Preference;
  relevance: Relevance | null;
  seed: SeedMeasurement | null;
  candidates: RankedCandidate[];
  /** Best candidate that beats the reference and has not been applied. */
  pending: RankedCandidate | null;
  /** Why there is nothing to recommend, when there is not. */
  reason: string;
}

/** Map the operator's words onto one of the three preferences. Unknown text is context, not a filter. */
export function parsePreference(goal?: string | null): Preference {
  const text = (goal ?? "").toLowerCase();
  if (/\b(fastest|fast|best|top|score|highest|quickest)\b/.test(text)) {
    return { kind: "score", label: "fastest — strict score order" };
  }
  if (/\b(safe|safest|conservative|smallest|least|minimal|careful)\b/.test(text)) {
    return { kind: "safe", label: `safest — keeps ≥${MIN_WIN_FRACTION * 100}% of the best win, less to take on first` };
  }
  if (/\b(simplest|simple|fewest|tidiest|cleanest)\b/.test(text)) {
    return { kind: "simple", label: "simplest — fewest changed files first" };
  }
  return { kind: null, label: "none understood — ranked by score" };
}

function filesUnder(root: string): Map<string, { size: number; hash: string }> {
  const out = new Map<string, { size: number; hash: string }>();
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (prefix === "" && entry.name === "eval") continue; // scorer output lives here
        walk(path.join(dir, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILES.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      try {
        const buffer = fs.readFileSync(file);
        out.set(relative, { size: buffer.length, hash: crypto.createHash("sha1").update(buffer).digest("hex") });
      } catch {
        // unreadable file: treat as unchanged rather than inventing a difference
      }
    }
  };
  walk(root, "");
  return out;
}

function lineCount(file: string): number {
  try {
    return fs.readFileSync(file, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Data files (databases, binaries, big blobs) differ for boring reasons — a rewritten SQLite corpus is
 * not an edit a candidate made. Reported separately instead of triggering a bogus "out of scope" warning.
 */
function dataReason(file: string, size: number): string | null {
  const extension = file.split(".").pop()?.toLowerCase() ?? "";
  if (DATA_EXTENSIONS.has(extension) || DATA_EXTENSIONS.has(extension.replace(/^.*-(wal|shm)$/, "$1"))) return "database/binary";
  if (size > 1024 * 1024) return "large file (>1 MB)";
  try {
    if (fs.readFileSync(file).subarray(0, 8192).includes(0)) return "binary";
  } catch {
    return null;
  }
  return null;
}

/** Files that differ from the seed workspace — the honest measure of what taking the candidate means. */
function changedFilesAgainst(
  candidate: string,
  seed: string,
  inventories: { seed: Map<string, { size: number; hash: string }>; candidate: Map<string, { size: number; hash: string }> },
): ChangedFile[] {
  const seedInventory = inventories.seed;
  const candidateInventory = inventories.candidate;
  const changed: ChangedFile[] = [];
  // Compare the union of both sides: a file the candidate *deleted* is a change too. Walking only the
  // candidate hid deletions, so a destructive candidate could look simpler (and safer) than it is.
  const relatives = new Set<string>([...candidateInventory.keys(), ...seedInventory.keys()]);
  for (const relative of relatives) {
    const before = seedInventory.get(relative);
    const after = candidateInventory.get(relative);
    if (before && after && before.hash === after.hash) continue;
    const info = after ?? before;
    if (!info) continue;
    const absolute = after ? path.join(candidate, relative) : path.join(seed, relative);
    changed.push({
      relative,
      before: before ? lineCount(path.join(seed, relative)) : 0,
      after: after ? lineCount(path.join(candidate, relative)) : 0,
      data_reason: dataReason(absolute, info.size),
    });
  }
  changed.sort((a, b) => a.relative.localeCompare(b.relative));
  return changed;
}

function readMetrics(record: string | null): Record<string, number | string | boolean | null> {
  if (!record) return {};
  const parsed = readJson<Record<string, unknown>>(path.join(record, "eval", "score.json"));
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, number | string | boolean | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (ENGINE_KEYS.has(key)) continue;
    if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

function readProposal(record: string | null): { summary: string | null; mentions: string[] } {
  if (!record) return { summary: null, mentions: [] };
  const file = path.join(record, "proposal.md");
  if (!fs.existsSync(file)) return { summary: null, mentions: [] };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { summary: null, mentions: [] };
  }
  const lower = text.toLowerCase();
  const mentions = [...new Set(RISK_WORDS.filter((word) => lower.includes(word)))];
  const summary =
    text
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line !== "") ?? null;
  return { summary: summary === null ? null : summary.slice(0, 120), mentions };
}

/** What the configured task is about, for the relevance check. */
function taskSummary(task: TaskConfig, projectDir: string): string {
  const problem = task.problem_file ? path.resolve(projectDir, task.problem_file) : null;
  if (problem && fs.existsSync(problem)) {
    try {
      const line = fs
        .readFileSync(problem, "utf8")
        .split("\n")
        .map((text) => text.replace(/^#+\s*/, "").trim())
        .find((text) => text !== "");
      if (line) return line.slice(0, 120);
    } catch {
      // fall through to the task name
    }
  }
  return `${task.name} (${task.eval_program})`;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "without", "to", "of", "in", "on", "my", "our", "this", "that",
  "make", "get", "run", "use", "using", "please", "then", "than", "best", "good", "goal", "task", "dream", "rsi",
  "fastest", "safest", "simplest", "score", "faster",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Does the goal look like it is about this task at all? A candidate can only be "best for <goal>" if the
 * task it came from addresses that goal; otherwise the honest answer is to say so.
 */
function relevanceCheck(task: TaskConfig, projectDir: string, goal: string | null): Relevance | null {
  const summary = taskSummary(task, projectDir);
  if (!goal) return null;
  const goalWords = new Set(words(goal));
  const taskWords = new Set(words(`${summary} ${task.name} ${task.eval_program}`));
  if (goalWords.size === 0) return { taskSummary: summary, aligned: true };
  const overlap = [...goalWords].filter((word) => taskWords.has(word));
  return { taskSummary: summary, aligned: overlap.length > 0 };
}

function riskOf(candidate: {
  high_risk_mentions: string[];
  out_of_scope_files: string[];
  changed_files: ChangedFile[];
}): number {
  // A mechanism (memo/cache) is cheap risk; an admitted trade (staleness window) is the expensive kind.
  return candidate.high_risk_mentions.length * 10 + candidate.out_of_scope_files.length * 5 + candidate.changed_files.length;
}

/**
 * How much of the leader's *win* a candidate captures, measured against the reference it improves on.
 *
 * The band has to be in win-fraction, not in score magnitude: for a cost metric, 0.003 ms and 0.0097 ms
 * are 3x apart in score but only 1.5% apart in the improvement they represent — and "1.5% worse for far
 * less to take on" is exactly the choice `safest` exists to surface.
 */
function winFraction(candidate: RankedCandidate, leader: RankedCandidate): number | null {
  if (leader.delta_vs_seed === null || leader.delta_vs_seed <= 0) return null;
  if (candidate.delta_vs_seed === null || candidate.delta_vs_seed <= 0) return 0;
  return candidate.delta_vs_seed / leader.delta_vs_seed;
}

function orderCandidates(candidates: RankedCandidate[], preference: Preference): RankedCandidate[] {
  const byScore = [...candidates].sort(
    (a, b) => b.score - a.score || a.iteration - b.iteration || a.cell.localeCompare(b.cell),
  );
  if (preference.kind === "simple") {
    return [...candidates].sort(
      (a, b) => a.changed_files.length - b.changed_files.length || b.score - a.score || a.cell.localeCompare(b.cell),
    );
  }
  if (preference.kind !== "safe" || byScore.length === 0) return byScore;
  // Keep at least MIN_WIN_FRACTION of the leader's win, then prefer the candidate with less to take on.
  const leader = byScore[0];
  const close: RankedCandidate[] = [];
  const far: RankedCandidate[] = [];
  for (const candidate of byScore) {
    const fraction = winFraction(candidate, leader);
    (fraction === null || fraction >= MIN_WIN_FRACTION ? close : far).push(candidate);
  }
  close.sort((a, b) => a.risk - b.risk || b.score - a.score || a.cell.localeCompare(b.cell));
  return [...close, ...far];
}

/** Rank every successful candidate recorded under this dream root. Pure reads. */
export function rankCandidates(options: {
  dreamRoot: string;
  task?: TaskConfig;
  projectDir: string;
  goal?: string | null;
}): Ranking {
  const task = options.task ?? readTask(options.dreamRoot);
  const projectDir = options.projectDir;
  const goal = options.goal?.trim() ? options.goal.trim() : null;
  const preference = parsePreference(goal);
  const rawSeed = readSeedMeasurement(options.dreamRoot);
  // A baseline from another scoring contract is not a reference point for this one: report it as
  // absent, so candidates are never ranked as "better than your code" against an unrelated number.
  const seed = rawSeed && seedMatchesTask(rawSeed, task) ? rawSeed : null;
  const staleBaseline = rawSeed !== null && seed === null;
  const fingerprint = scoringFingerprint(task);
  const appliedRecords = readApplied(options.dreamRoot).filter(
    (record) => record.fingerprint === undefined || record.fingerprint === fingerprint,
  );
  const appliedCells = new Set(appliedRecords.map((record) => `${record.iteration}:${record.cell}`));
  const appliedBest =
    appliedRecords.map((record) => record.score).filter((score): score is number => typeof score === "number").length > 0
      ? Math.max(...(appliedRecords.map((record) => record.score).filter((score): score is number => typeof score === "number") as number[]))
      : null;
  const seedWorkspace = path.resolve(projectDir, task.workspace);
  // Read the seed inventory once for the whole ranking: every candidate compares against the same seed,
  // and re-walking (and re-hashing) a large seed workspace per candidate was the ranking bottleneck.
  const seedFiles = fs.existsSync(seedWorkspace) ? filesUnder(seedWorkspace) : new Map<string, { size: number; hash: string }>();
  const candidateInventories = new Map<string, Map<string, { size: number; hash: string }>>();

  const dir = path.join(options.dreamRoot, "trace_pool");
  const iterations = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .map((name) => /^iter(\d+)$/.exec(name))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => Number(match[1]))
        .sort((a, b) => a - b)
    : [];

  const candidates: RankedCandidate[] = [];
  for (const iteration of iterations) {
    // Worlds recorded under a different scoring contract are not comparable with this task: their
    // scores are on another scale (in the report, an old positive +79 outranked the new -54).
    const manifest = readManifest(options.dreamRoot, iteration);
    if (manifest?.task_fingerprint !== undefined && manifest.task_fingerprint !== fingerprint) continue;
    const json = readJson<TreeJSON>(path.join(iterationDir(options.dreamRoot, iteration), "tree.json"));
    if (!json) continue;
    const tree = DiscoveryTree.fromJSON(json);
    for (const node of tree.list()) {
      if (typeof node.score !== "number") continue;
      if (node.error !== null || node.fail_class !== "ok") continue;
      // Same direction check for worlds recorded before manifests carried a fingerprint: a stored
      // score that is not `higher ? raw : -raw` under the current task came from a flipped direction.
      if (!scoreMatchesDirection(task, node.score, node.raw_score)) continue;
      const workspace = node.workspace ? path.resolve(projectDir, node.workspace) : null;
      const program = workspace ? path.join(workspace, task.eval_program) : null;
      const record = fs.existsSync(attemptDir(options.dreamRoot, iteration, node.meta.cell_id))
        ? attemptDir(options.dreamRoot, iteration, node.meta.cell_id)
        : null;
      const candidateInventory = workspace ? candidateInventories.get(workspace) ?? filesUnder(workspace) : null;
      if (workspace && candidateInventory) candidateInventories.set(workspace, candidateInventory);
      const changed =
        workspace && candidateInventory ? changedFilesAgainst(workspace, seedWorkspace, { seed: seedFiles, candidate: candidateInventory }) : [];
      const programRelative = task.eval_program.replaceAll("\\", "/");
      const { summary, mentions } = readProposal(record);
      const reference = appliedBest !== null && seed?.score !== null && seed?.score !== undefined && appliedBest > seed.score ? appliedBest : (seed?.score ?? null);
      const delta = reference === null ? null : node.score - reference;
      candidates.push({
        iteration,
        cell: node.meta.cell_id,
        score: node.score,
        raw_score: node.raw_score,
        fail_class: node.fail_class,
        workspace,
        program: program && fs.existsSync(program) ? program : null,
        record,
        delta_vs_seed: delta,
        gain_pct: delta === null || reference === null || reference === 0 ? null : Math.round(((delta / Math.abs(reference)) * 100) * 10) / 10,
        already_applied: appliedCells.has(`${iteration}:${node.meta.cell_id}`),
        applicable: Boolean(program && fs.existsSync(program)),
        metrics: readMetrics(record),
        changed_files: changed.filter((file) => file.data_reason === null),
        data_changed_files: changed.filter((file) => file.data_reason !== null),
        out_of_scope_files: changed
          .filter((file) => file.data_reason === null && file.relative !== programRelative)
          .map((file) => file.relative),
        proposal_summary: summary,
        mentions,
        high_risk_mentions: mentions.filter((word) => HIGH_RISK_WORDS.has(word)),
        risk: 0,
      });
    }
  }
  for (const candidate of candidates) candidate.risk = riskOf(candidate);

  const ordered = orderCandidates(candidates, preference);
  const reference = appliedBest !== null && (seed?.score ?? null) !== null && appliedBest > (seed?.score as number) ? appliedBest : (seed?.score ?? null);
  const threshold = reference === null ? null : reference + Math.abs(reference) * MIN_IMPROVEMENT_RATIO;
  const pending =
    ordered.find((candidate) => !candidate.already_applied && candidate.applicable && threshold !== null && candidate.score > threshold) ?? null;

  const reason =
    candidates.length === 0
      ? "no successful candidate recorded yet — the suggestion appears automatically after the first cycle"
      : staleBaseline
        ? "the recorded baseline was measured under a different scoring configuration — run dream_rsi_init to re-measure your code"
        : threshold === null
          ? "your own code has not been measured yet, so there is no reference point (run dream_rsi_init)"
          : pending === null
            ? `nothing beats ${appliedBest !== null && appliedBest > (seed?.score ?? 0) ? "the last applied candidate" : "your measured code"} by ${MIN_IMPROVEMENT_RATIO * 100}%`
            : "improvement pending";

  return {
    goal,
    preference,
    relevance: relevanceCheck(task, projectDir, goal),
    seed,
    candidates: ordered,
    pending,
    reason,
  };
}

function formatScore(value: number | null): string {
  if (value === null) return "n/a";
  const rounded = Math.abs(value) < 10 ? Math.round(value * 1e4) / 1e4 : Math.round(value * 100) / 100;
  return String(rounded);
}

function formatGain(candidate: RankedCandidate): string {
  // `gain_pct` is computed on the normalised score (higher is better), so a plus always means "better"
  // whatever direction the scorer's own metric has — saying "-99%" for a 99% speedup reads as a loss.
  if (candidate.gain_pct !== null) return `${candidate.gain_pct >= 0 ? "+" : ""}${candidate.gain_pct}%`;
  if (candidate.delta_vs_seed === null) return "n/a";
  return `${candidate.delta_vs_seed > 0 ? "+" : ""}${formatScore(candidate.delta_vs_seed)}`;
}

function runnerUpNote(candidate: RankedCandidate): string {
  const bits: string[] = [formatGain(candidate)];
  bits.push(
    candidate.high_risk_mentions.length === 0
      ? "no staleness/approximation mentions"
      : `admits: ${candidate.high_risk_mentions.join(", ")}`,
  );
  if (candidate.changed_files.length > 0) bits.push(`${candidate.changed_files.length} file${candidate.changed_files.length === 1 ? "" : "s"}`);
  if (candidate.out_of_scope_files.length > 0) bits.push(`out of scope: ${candidate.out_of_scope_files.join(", ")}`);
  return bits.join("  ");
}

/**
 * The recommendation, as text the user can act on. Used by `create`, `suggest`, the cycle reports and
 * `status` — one renderer, one source of truth.
 */
export function renderSuggestion(ranking: Ranking, options: { compact?: boolean } = {}): string {
  const pending = ranking.pending;
  const pick = pending ?? ranking.candidates[0] ?? null;
  const seedRaw = ranking.seed?.raw_score ?? ranking.seed?.score ?? null;
  if (!pick) {
    return `Nothing to apply: ${ranking.reason}.`;
  }
  // Nothing to take: the best on record is either already in your code or inside the noise band. Showing
  // an apply command here would invite taking an inferior candidate, so don't.
  if (!pending && options.compact) {
    return `Nothing to apply: ${ranking.reason}`;
  }

  const metrics = Object.entries(pick.metrics)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("  ");
  const changed =
    pick.changed_files.length === 0
      ? "no code files differ from your seed"
      : pick.changed_files.map((file) => `${file.relative} (${file.before} → ${file.after} lines)`).join(", ");
  const dataNote =
    pick.data_changed_files.length === 0
      ? null
      : `plus ${pick.data_changed_files.length} data file${pick.data_changed_files.length === 1 ? "" : "s"} the scorer rewrites (${pick.data_changed_files
          .map((file) => file.relative)
          .join(", ")})`;
  const apply = `dream_rsi_apply cell=${pick.cell} iteration=${pick.iteration} confirm=true`;

  if (options.compact) {
    const pickLine =
      `top pick: ${pick.cell} (iteration ${pick.iteration}) ${formatScore(pick.raw_score)}` +
      `${seedRaw === null ? "" : ` vs your code ${formatScore(seedRaw)}`} ${formatGain(pick)}` +
      `${pick.mentions.length > 0 ? `  mentions: ${pick.mentions.join(", ")}` : ""}  -> ${apply}`;
    // Keep the same headline as the full block: "there is something to take" is the one fact that must
    // not get lost in a compact listing.
    return `⚠️ IMPROVEMENT READY — NOT APPLIED\n${pickLine}`;
  }

  const lines = [
    pending ? "⚠️ IMPROVEMENT READY — NOT APPLIED" : `Nothing to apply: ${ranking.reason}. best on record: ${pick.cell}`,
    `${pending ? "TOP PICK " : "BEST RECORD"} ${pick.cell}  (iteration ${pick.iteration})   score ${formatScore(pick.raw_score)}` +
      `${seedRaw === null ? "" : `  vs your code ${formatScore(seedRaw)}`}   ${formatGain(pick)}`,
    metrics ? `  metrics:  ${metrics}` : null,
    `  changed:  ${changed}`,
    dataNote ? `  data:     ${dataNote}` : null,
    pick.proposal_summary ? `  proposal: "${pick.proposal_summary}"` : null,
    pick.mentions.length > 0
      ? `  mentions: ${pick.mentions.join(", ")}${
          pick.high_risk_mentions.length > 0 ? "   <- admits a trade the scorer cannot see; read the proposal" : ""
        }`
      : null,
    pending ? `  apply:    ${apply}` : null,
  ].filter((line): line is string => line !== null);

  const others = ranking.candidates.filter((candidate) => candidate.cell !== pick.cell).slice(0, 2);
  if (others.length > 0) {
    lines.push(pending ? "runner-ups:" : "others on record:");
    for (const candidate of others) {
      lines.push(`  ${candidate.cell}  ${formatScore(candidate.raw_score)}  ${runnerUpNote(candidate)}`);
    }
  }
  lines.push(`preference: ${ranking.preference.label}${ranking.goal ? `  (goal: "${ranking.goal}")` : ""}`);
  if (pending) {
    lines.push("your code is unchanged. Report this to the user and ask whether to apply it; call dream_rsi_apply only after they say yes.");
  }
  return lines.join("\n");
}

export { appliedLogPath };
