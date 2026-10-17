/**
 * Cold-start discovery.
 *
 * A repository the loop has never seen has no session history, no evaluator and
 * no control patch. Recon therefore starts from the two things every project
 * does have: declared commands in its manifests, and its own source. It runs a
 * declared workload once to measure it, then walks that workload's local import
 * graph so the proposed patch scope is the code the measurement actually
 * exercises — not every file that happened to be touched recently.
 *
 * Bounded by design: a file cap, a depth cap, no dependency directories, no
 * secret-shaped paths, no network, and a restricted environment. Repository text
 * is evidence; it never authorizes a command.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { runShellCommand } from "../agent/runner.ts";
import { restrictedEnvironment, type CommandCategory, type RunContract } from "./intake.ts";
import type { LeverAttempt, LeverInventory, LeverProposal } from "./levers.ts";
import { leverId } from "./levers.ts";

const MAX_SCANNED_FILES = 2000;
const MAX_GRAPH_FILES = 200;
const MAX_GRAPH_DEPTH = 6;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 120_000;

/** Never walked, read or proposed as patch scope. */
const SKIP_DIRS = new Set([
  ".git", ".dream-rsi", "node_modules", "vendor", ".venv", "venv", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", "target", ".gradle", "dist", "build", ".next", ".turbo", "coverage",
]);

/** Path shapes that are never read or proposed: secrets, keys, private data. */
const SECRET_PATH = /(?:^|[\\/])(?:\.env(?:\.|$)|secrets?|credentials?|id_rsa|id_ed25519|\.npmrc|\.netrc)(?:[\\/._-]|$)|(?:^|[\\/])[^\\/]*(?:key|token|secret|credential|password)[^\\/]*(?:$|[\\/])|\.(?:pem|p12|pfx|keystore)$/i;

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".cs"]);

export interface DiscoveredCommand {
  /** Human-readable label, also the canonical metric name. */
  label: string;
  /** Exact argv used to run it; never rebuilt from a redacted label. */
  argv: string[];
  /** The argv exactly as the manifest declares it, kept for reporting and review. */
  declaredArgv: string[];
  category: CommandCategory;
  /** Manifest evidence, for example `package.json#scripts.bench`. */
  source: string;
  /** True when argv[0] is a package-manager shim that needs the command interpreter on Windows. */
  shim: boolean;
  /** Project-relative entry file the workload runs, when the declared script names one. */
  entry: string | null;
}

/**
 * The direct interpreter invocation for a script body that is nothing but
 * `<runner> <file>`. Running the file directly measures the project's work; going
 * through a package manager adds several hundred milliseconds of its own startup
 * to every reading, which can dominate a small workload and hide real change.
 *
 * Only an exact, unambiguous body is reduced. Anything with flags, pipes, `&&`,
 * environment prefixes or extra arguments keeps the declared command.
 */
export function directArgv(body: string, projectDir: string): string[] | null {
  const tokens = (body.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((value) => value.replace(/^(["'])(.*)\1$/, "$2"));
  if (tokens.length !== 2) return null;
  const [runner, file] = tokens;
  if (!/^(?:node|nodejs|tsx|ts-node|bun|deno|python3?(?:\.\d+)?)$/i.test(runner)) return null;
  const absolute = path.resolve(projectDir, file);
  if (!isInside(projectDir, absolute)) return null;
  try {
    if (!fs.statSync(absolute).isFile()) return null;
  } catch { return null; }
  const normalizedRunner = /^python3?(?:\.\d+)?$/i.test(runner) ? (process.platform === "win32" ? "python" : "python3") : runner.toLowerCase();
  return [normalizedRunner, file];
}

export interface ReconFile {
  path: string;
  bytes: number;
  lines: number;
}

export interface ProbeReading {
  label: string;
  ok: boolean;
  /** Wall-clock milliseconds, or null when the probe did not complete. */
  durationMs: number | null;
  timedOut: boolean;
  error: string | null;
}

export interface ReconResult {
  commands: DiscoveredCommand[];
  probes: ProbeReading[];
  /** Union of every measured workload's local import graph, project-relative. */
  graph: string[];
  /**
   * The local import graph of each measured workload, keyed by label. A lever's
   * patch scope comes from its own workload's graph, so two declared benchmarks
   * with disjoint code do not borrow each other's files.
   */
  graphs: Record<string, string[]>;
  files: ReconFile[];
  notes: string[];
  /** Why a declared command was not usable; reported instead of silently skipped. */
  blockers: string[];
}

export interface ReconOptions {
  projectDir: string;
  contract: RunContract;
  /** Called immediately before each probe process starts, for durable accounting. */
  beforeProbe?: (command: DiscoveredCommand) => void;
  /** Cap on probes in one recon pass. */
  maxProbes?: number;
  probeTimeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Test seam replacing the probe process. */
  probeImpl?: (command: DiscoveredCommand) => Promise<ProbeReading>;
}

function isSecretPath(relative: string): boolean {
  return SECRET_PATH.test(relative.replace(/\\/g, "/"));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readText(file: string, limit: number): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > limit) return null;
    return fs.readFileSync(file, "utf8");
  } catch { return null; }
}

function relativeOf(projectDir: string, file: string): string {
  return path.relative(projectDir, file).replace(/\\/g, "/");
}

/** Bounded walk of the project's own files, for the recon report. */
function scanFiles(projectDir: string): ReconFile[] {
  const files: ReconFile[] = [];
  const walk = (directory: string, prefix: string): void => {
    if (files.length >= MAX_SCANNED_FILES) return;
    let names: fs.Dirent[];
    try { names = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      if (isSecretPath(relative)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(absolute, relative); continue; }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        && !["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Makefile", "pom.xml", "build.gradle", "composer.json", "Gemfile", "mix.exs"].includes(entry.name)) continue;
      let stat: fs.Stats;
      try { stat = fs.lstatSync(absolute); } catch { continue; }
      const text = readText(absolute, MAX_SOURCE_BYTES);
      files.push({ path: relative, bytes: stat.size, lines: text === null ? 0 : text.split(/\r?\n/).length });
    }
  };
  walk(projectDir, "");
  return files;
}

function packageManager(projectDir: string): { name: string; shim: boolean } {
  if (fs.existsSync(path.join(projectDir, "bun.lockb")) || fs.existsSync(path.join(projectDir, "bun.lock"))) return { name: "bun", shim: true };
  if (fs.existsSync(path.join(projectDir, "pnpm-lock.yaml"))) return { name: "pnpm", shim: true };
  if (fs.existsSync(path.join(projectDir, "yarn.lock"))) return { name: "yarn", shim: true };
  return { name: "npm", shim: true };
}

/** Classify a manifest script by name. Only these names are treated as declared workloads. */
export function scriptCategory(name: string): CommandCategory {
  const lower = name.toLowerCase();
  if (/^test(?::|$)|^spec(?::|$)/.test(lower)) return "test";
  if (/^bench(?:mark)?(?::|$)|^perf(?:ormance)?(?::|$)|^profile(?::|$)/.test(lower)) return "benchmark";
  if (/^build(?::|$)|^compile(?::|$)/.test(lower)) return "build";
  return "custom";
}

/**
 * The project-relative file a declared script actually executes, when the script
 * names one (`node bench.mjs`, `python -m pytest` has none).
 */
export function scriptEntry(script: string, projectDir: string): string | null {
  const tokens = script.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const unquote = (value: string): string => value.replace(/^(["'])(.*)\1$/, "$2");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = unquote(tokens[index]);
    if (/^(?:node|nodejs|tsx|ts-node|bun|deno)$/i.test(token)) {
      const next = tokens[index + 1];
      if (!next) continue;
      const candidate = unquote(next);
      if (candidate.startsWith("-")) continue;
      const absolute = path.resolve(projectDir, candidate);
      if (!isInside(projectDir, absolute)) continue;
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return relativeOf(projectDir, absolute);
      // `node scripts/run.mjs` with an extension omitted is not worth guessing about.
    }
    if (/^python(?:3(?:\.\d+)?)?$/i.test(token)) {
      const next = tokens[index + 1] ? unquote(tokens[index + 1]) : "";
      if (next.startsWith("-")) continue;
      const absolute = path.resolve(projectDir, next);
      if (next && isInside(projectDir, absolute) && fs.existsSync(absolute)) return relativeOf(projectDir, absolute);
    }
  }
  return null;
}

/** Declared commands from the project's manifests, filtered by the approved categories. */
export function discoverCommands(projectDir: string, contract: RunContract): { commands: DiscoveredCommand[]; blockers: string[]; notes: string[] } {
  const commands: DiscoveredCommand[] = [];
  const blockers: string[] = [];
  const notes: string[] = [];
  const allowed = new Set(contract.execution.allowedCommandCategories);
  const manager = packageManager(projectDir);

  const add = (command: DiscoveredCommand): void => {
    if (!allowed.has(command.category)) {
      notes.push(`declared ${command.category} command "${command.label}" is outside the approved command categories.`);
      return;
    }
    if (commands.some((existing) => existing.label === command.label)) return;
    commands.push(command);
  };

  const manifest = readText(path.join(projectDir, "package.json"), MAX_MANIFEST_BYTES);
  if (manifest !== null) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(manifest); } catch { blockers.push("package.json is not valid JSON, so its scripts cannot be read"); }
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
    if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
      const hasHook = (name: string): boolean => Object.hasOwn(scripts as Record<string, unknown>, `pre${name}`)
        || Object.hasOwn(scripts as Record<string, unknown>, `post${name}`);
      for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
        if (typeof body !== "string" || !body.trim()) continue;
        const entry = scriptEntry(body, projectDir);
        const direct = hasHook(name) ? null : directArgv(body, projectDir);
        add({
          label: `${manager.name} run ${name}`,
          argv: direct ?? [manager.name, "run", name],
          declaredArgv: [manager.name, "run", name],
          category: scriptCategory(name),
          source: `package.json#scripts.${name}`,
          shim: direct ? false : manager.shim,
          entry,
        });
      }
    }
  }

  if (fs.existsSync(path.join(projectDir, "pyproject.toml"))) {
    add({ label: "pytest", argv: [process.platform === "win32" ? "python" : "python3", "-m", "pytest"], declaredArgv: [process.platform === "win32" ? "python" : "python3", "-m", "pytest"], category: "test", source: "pyproject.toml", shim: false, entry: null });
  }
  if (fs.existsSync(path.join(projectDir, "Cargo.toml"))) {
    add({ label: "cargo test", argv: ["cargo", "test"], declaredArgv: ["cargo", "test"], category: "test", source: "Cargo.toml", shim: false, entry: null });
    add({ label: "cargo bench", argv: ["cargo", "bench"], declaredArgv: ["cargo", "bench"], category: "benchmark", source: "Cargo.toml", shim: false, entry: null });
  }
  if (fs.existsSync(path.join(projectDir, "go.mod"))) {
    add({ label: "go test", argv: ["go", "test", "./..."], declaredArgv: ["go", "test", "./..."], category: "test", source: "go.mod", shim: false, entry: null });
  }
  const makefile = readText(path.join(projectDir, "Makefile"), MAX_MANIFEST_BYTES);
  if (makefile !== null) {
    const lines = makefile.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = /^([A-Za-z0-9_.-]+):(?!=)/.exec(line);
      if (!match) continue;
      const target = match[1];
      const category = scriptCategory(target);
      if (category === "custom") continue;
      // A target's first recipe line usually names the program it runs, which is
      // how a Makefile-declared benchmark gets an attributable entry file.
      const recipe = lines.slice(index + 1).find((candidate) => candidate.startsWith("\t"));
      const entry = recipe ? scriptEntry(recipe.trim(), projectDir) : null;
      add({ label: `make ${target}`, argv: ["make", target], declaredArgv: ["make", target], category, source: `Makefile#${target}`, shim: false, entry });
    }
  }

  if (commands.length === 0 && blockers.length === 0) {
    blockers.push("no declared command matches the approved command categories, so there is nothing to measure");
  }
  return { commands, blockers, notes };
}

function resolveSpecifier(projectDir: string, fromFile: string, specifier: string): string | null {
  const base = path.resolve(projectDir, path.dirname(fromFile), specifier);
  if (!isInside(projectDir, base)) return null;
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`, `${base}.py`,
    path.join(base, "index.mjs"), path.join(base, "index.js"), path.join(base, "index.ts"), path.join(base, "__init__.py")];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return relativeOf(projectDir, candidate);
    } catch { /* try the next candidate */ }
  }
  return null;
}

function staticImports(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

function pythonImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/^\s*from\s+([.\w]+)\s+import\b/gm)) found.push(match[1]);
  for (const match of source.matchAll(/^\s*import\s+([.\w]+)/gm)) found.push(match[1]);
  return found;
}

/**
 * Bounded walk of one workload's local import graph. Only project files are
 * followed: a dependency or a standard-library import ends the branch.
 */
export function importGraph(projectDir: string, entry: string): { files: string[]; truncated: boolean } {
  const seen = new Set<string>();
  let truncated = false;
  const queue: Array<{ file: string; depth: number }> = [{ file: entry.replace(/\\/g, "/"), depth: 0 }];
  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (seen.has(file) || seen.size >= MAX_GRAPH_FILES) { if (seen.size >= MAX_GRAPH_FILES) truncated = true; continue; }
    if (isSecretPath(file)) continue;
    const text = readText(path.join(projectDir, ...file.split("/")), MAX_SOURCE_BYTES);
    if (text === null) { seen.add(file); continue; }
    seen.add(file);
    if (depth >= MAX_GRAPH_DEPTH) continue;
    const isPython = file.endsWith(".py");
    if (isPython) {
      for (const name of pythonImports(text)) {
        const modulePath = name.replace(/^\.+/, "").replaceAll(".", "/");
        if (!modulePath) continue;
        const resolved = resolveSpecifier(projectDir, file, modulePath) ?? resolveSpecifier(projectDir, `${path.dirname(file)}/placeholder`, `../${modulePath}`);
        if (resolved) queue.push({ file: resolved, depth: depth + 1 });
      }
      continue;
    }
    for (const specifier of staticImports(text)) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;
      const resolved = resolveSpecifier(projectDir, file, specifier);
      if (resolved) queue.push({ file: resolved, depth: depth + 1 });
    }
  }
  return { files: [...seen].sort(), truncated };
}

/** Run one declared workload once, in a restricted environment. */
export async function probeCommand(options: ReconOptions, command: DiscoveredCommand): Promise<ProbeReading> {
  options.beforeProbe?.(command);
  const commandLine = command.argv.map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '""')}"` : part)).join(" ");
  const result = await runShellCommand(commandLine, {
    cwd: options.projectDir,
    timeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
    envOnly: true,
    env: restrictedEnvironment(options.contract),
    logPath: null,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const durationMs = result.durationMs;
  const timedOut = result.timedOut;
  const error = result.spawnError ?? (timedOut ? "probe timed out" : result.ok ? null : (result.stderrTail.trim().split(/\r?\n/, 1)[0] || `exit ${result.code}`));
  return { label: command.label, ok: result.ok, durationMs, timedOut, error };
}

/**
 * Discover the project's declared workloads, measure one pass of each, and walk
 * the import graph of the most relevant measured workload.
 */
export async function reconProject(options: ReconOptions): Promise<ReconResult> {
  const projectDir = path.resolve(options.projectDir);
  const files = scanFiles(projectDir);
  const discovered = discoverCommands(projectDir, options.contract);
  const notes = [...discovered.notes];
  const blockers = [...discovered.blockers];
  const progress = options.onProgress ?? (() => {});

  const measurable = discovered.commands.filter((command) => command.category === "benchmark" || command.category === "custom");
  for (const command of discovered.commands) {
    if (!measurable.includes(command)) notes.push(`"${command.label}" is a ${command.category} command; it is available as a gate, not as the measured outcome.`);
  }
  if (measurable.length === 0) {
    blockers.push("no benchmark or custom workload is declared, so no duration or throughput can be measured");
  }

  const limit = Math.max(1, options.maxProbes ?? 3);
  const probes: ProbeReading[] = [];
  for (const command of measurable.slice(0, limit)) {
    if (options.signal?.aborted) break;
    progress(`recon: probing "${command.label}"`);
    const reading = options.probeImpl
      ? await options.probeImpl(command)
      : await probeCommand(options, command);
    probes.push(reading);
    if (!reading.ok) blockers.push(`the declared workload "${command.label}" did not complete: ${reading.error ?? "unknown failure"}`);
  }

  const graph = new Set<string>();
  const graphs: Record<string, string[]> = {};
  let truncated = false;
  for (const command of measurable.slice(0, limit)) {
    if (!command.entry) continue;
    const walked = importGraph(projectDir, command.entry);
    truncated = truncated || walked.truncated;
    graphs[command.label] = walked.files;
    for (const file of walked.files) graph.add(file);
  }
  if (measurable.length > 0 && graph.size === 0) {
    blockers.push("the declared workload does not name a local entry file, so its patch scope cannot be attributed to measured code");
  }
  if (truncated) notes.push(`the import graph reached the ${MAX_GRAPH_FILES}-file cap; later candidates may be incomplete.`);

  return { commands: discovered.commands, probes, graph: [...graph].sort(), graphs, files, notes, blockers };
}

export interface ReconInventoryOptions {
  contract: RunContract;
  recon: ReconResult;
  attempts?: LeverAttempt[];
}

/**
 * Turn recon evidence into ranked levers. The measured workload with the largest
 * attributable duration becomes a duration lever scoped to the code the
 * measurement actually exercises; a declared test command becomes the gate.
 * Everything else is rejected with the reason, never silently dropped.
 */
export function buildReconInventory(options: ReconInventoryOptions): LeverInventory {
  const { contract, recon } = options;
  const attempts = options.attempts ?? [];
  const attemptByLever = new Map(attempts.map((attempt) => [attempt.leverId, attempt]));
  const levers: LeverProposal[] = [];
  const rejected: LeverInventory["rejected"] = [];
  const diagnostics: string[] = [...recon.notes];
  const gates = recon.commands.filter((command) => command.category === "test").map((command) => command.label);
  if (gates.length > 0) diagnostics.push(`Declared test gates: ${gates.join(", ")}.`);

  const measured = recon.commands
    .filter((command) => command.category === "benchmark" || command.category === "custom")
    .map((command) => ({ command, probe: recon.probes.find((probe) => probe.label === command.label) ?? null }))
    .filter((entry) => entry.probe !== null);

  for (const { command, probe } of measured) {
    const id = leverId("recon-command", [command.label, command.source]);
    // Scope comes from this workload's own imports, not from every measured workload.
    const workloadGraph = recon.graphs[command.label] ?? [];
    const inScope = workloadGraph.filter((file) => within(contract, file) && !protectedAsset(contract, file));
    const outOfScope = workloadGraph.filter((file) => !inScope.includes(file));
    if (!probe!.ok || probe!.durationMs === null) {
      rejected.push({ id, sourceKind: "recon-command", reason: `"${command.label}" could not be measured: ${probe!.error ?? "no duration"}`, readiness: 0.2 });
      continue;
    }
    if (inScope.length === 0) {
      rejected.push({
        id, sourceKind: "recon-command", readiness: 0.3,
        reason: `"${command.label}" is measurable but no file it imports is inside the approved editable scope (${contract.scope.roots.join(", ") || "whole workspace"})`,
      });
      continue;
    }
    const attempt = attemptByLever.get(id);
    const demotion = attempt ? (attempt.outcome === "win" ? 0.15 : attempt.outcome === "no-win" ? 0.5 : attempt.outcome === "rejected" ? 0.35 : 0.6) : 1;
    // Uncalibrated prior: a slower measured workload has more attributable headroom,
    // with the same saturating shape the signal inventory uses.
    const expectedGain = Math.min(1, probe!.durationMs / 30_000);
    const costSeconds = Math.max(5, Math.min(600, probe!.durationMs / 1000));
    const readiness = gates.length > 0 ? 0.9 : 0.75;
    const score = demotion * (expectedGain * readiness) / Math.pow(costSeconds, 0.25);
    levers.push({
      id,
      sourceKind: "recon-command",
      goal: `Reduce the wall-clock duration of "${command.label}" without changing its observable results.`,
      mechanism: `optimize the code that "${command.label}" actually executes`,
      metric: `"${command.label}" wall-clock duration (ms, lower is better)`,
      metricKind: "command-duration",
      scopeFiles: inScope.slice(0, 8),
      gates: [...gates],
      estimates: { expectedGain, costSeconds, confidence: 0.6, readiness },
      score,
      evidence: [{ source: "evaluator", ref: command.source, count: 1 }],
      reasons: [
        `measured: "${command.label}" completed in ${Math.round(probe!.durationMs)} ms (${command.source})`,
        `scope: ${inScope.length} file(s) reached from the measured workload's entry ${command.entry ?? "unknown"}; ${outOfScope.length} measured file(s) excluded by the approved scope`,
        gates.length > 0 ? `gate: ${gates.join(", ")}` : "no declared test gate; correctness must be established by the metric's own oracle",
        attempt ? `history: prior outcome ${attempt.outcome} for this lever; score adjusted.` : "history: no prior outcome for this lever",
      ],
      command: { argv: [...command.argv], shim: command.shim, source: command.source, entry: command.entry },
    });
  }

  for (const blocker of recon.blockers) {
    diagnostics.push(`blocker: ${blocker}`);
    // A blocker is a named refusal, not an unexplained empty inventory: it carries
    // its own id and reason so status, memory and reporting can explain the stop.
    rejected.push({ id: leverId("recon-command", [blocker]), sourceKind: "recon-command", reason: blocker, readiness: 0 });
  }

  levers.sort((a, b) => b.score - a.score || b.estimates.expectedGain - a.estimates.expectedGain || a.id.localeCompare(b.id));
  return { levers, rejected, diagnostics };
}

function within(contract: RunContract, relative: string): boolean {
  const roots = contract.scope.roots.map((root) => root.replace(/\\/g, "/")).filter((root) => root !== "" && root !== ".");
  if (roots.length === 0) return true;
  const candidate = relative.replace(/\\/g, "/");
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

function protectedAsset(contract: RunContract, relative: string): boolean {
  const candidate = relative.replace(/\\/g, "/");
  return contract.scope.protectedAssets.some((asset) => {
    const normalized = asset.replace(/\\/g, "/").replace(/\/$/, "");
    return candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}
