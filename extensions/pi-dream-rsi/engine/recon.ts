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
import {
  restrictedEnvironment, type CommandCategory, type RunContract, type RunContractScoreEvaluator,
} from "./intake.ts";
import type { LeverAttempt, LeverInventory, LeverProposal } from "./levers.ts";
import { attemptDemotion, leverId } from "./levers.ts";
import { pathWithin } from "./scope.ts";
import type { SignalsResult } from "./signals.ts";

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

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".fs", ".fsx", ".swift", ".php", ".ex", ".exs", ".scala", ".sc", ".c", ".h", ".cc", ".cpp", ".hpp"]);

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
  if (tokens.length === 3 && /^go$/i.test(tokens[0]) && tokens[1] === "run") {
    const absoluteGoFile = path.resolve(projectDir, tokens[2]);
    if (!isInside(projectDir, absoluteGoFile)) return null;
    try {
      const stat = fs.statSync(absoluteGoFile);
      const runnable = stat.isFile() && absoluteGoFile.endsWith(".go")
        || stat.isDirectory() && fs.readdirSync(absoluteGoFile, { withFileTypes: true }).some((entry) => entry.isFile() && entry.name.endsWith(".go"));
      if (runnable) {
        return ["go", "run", tokens[2]];
      }
    } catch { return null; }
  }
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
  /** Present when the process launched; distinguishes a test failure from a missing runner. */
  exitCode?: number | null;
  spawnFailed?: boolean;
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
  /** Run repository workloads from disposable, OS-contained copies. */
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
        && !["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Makefile", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "Rakefile", "mix.exs", "Package.swift", "build.sbt", "CMakeLists.txt"].includes(entry.name)
        && !entry.name.toLowerCase().endsWith(".csproj") && !entry.name.toLowerCase().endsWith(".fsproj")) continue;
      let stat: fs.Stats;
      try { stat = fs.lstatSync(absolute); } catch { continue; }
      const text = readText(absolute, MAX_SOURCE_BYTES);
      files.push({ path: relative, bytes: stat.size, lines: text === null ? 0 : text.split(/\r?\n/).length });
    }
  };
  walk(projectDir, "");
  return files;
}

/** Read-only preparation evidence. Suggestions are not executable approvals or qualified instruments. */
export function discoverMeasurementOptions(projectDir: string, contract: RunContract) {
  const declared = discoverCommands(projectDir, contract);
  const scripts = scanFiles(projectDir)
    .filter(file => /(?:measure|benchmark|score|evaluator|(?:^|\/)bench\.)/i.test(file.path) && /\.(?:py|mjs|cjs|js)$/.test(file.path))
    .slice(0, 32)
    .map(file => {
      const source = readText(path.join(projectDir, file.path), MAX_SOURCE_BYTES) ?? "";
      const outputHint = /score\.json/.test(source) ? "score-json"
        : /JSON\.stringify|json\.dumps/.test(source) && /(?:["']score["']|\bscore\s*:)/.test(source) ? "stdout-json" : null;
      return {
        source: file.path, argv: [file.path.endsWith(".py") ? (process.platform === "win32" ? "python" : "python3") : "node", file.path],
        outputHint, qualification: "not-run" as const,
        implementationFiles: importGraph(projectDir, file.path).files.filter(entry => entry !== file.path),
        notes: ["Source-based suggestion only; inspect arguments, output, interpreter and pinned inputs before declaring it.",
          ...(/--benchmark|--emit-reference/.test(source) ? ["Diagnostic/reference-write modes are mentioned; the suggested argv does not enable them."] : [])],
      };
    });
  return {
    evaluator: contract.outcome.evaluator ?? null,
    scripts, commands: declared.commands, diagnostics: [...declared.blockers, ...declared.notes],
    recommendation: contract.outcome.evaluator ? "reuse-declared-evaluator" : scripts.length ? "inspect-existing-instruments" : "inspect-declared-workloads-or-propose-setup",
  };
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
      if (/^bun$/i.test(token) && candidate === "test" && tokens[index + 2]) {
        const testFile = unquote(tokens[index + 2]);
        const absoluteTestFile = path.resolve(projectDir, testFile);
        if (isInside(projectDir, absoluteTestFile) && fs.existsSync(absoluteTestFile) && fs.statSync(absoluteTestFile).isFile()) {
          return relativeOf(projectDir, absoluteTestFile);
        }
      }
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
    if (/^go$/i.test(token) && tokens[index + 1] === "run") {
      const target = tokens[index + 2] ? unquote(tokens[index + 2]) : "";
      if (!target || target.startsWith("-")) continue;
      const absolute = path.resolve(projectDir, target);
      if (!isInside(projectDir, absolute)) continue;
      try {
        const stat = fs.statSync(absolute);
        if (stat.isFile() && absolute.endsWith(".go")) return relativeOf(projectDir, absolute);
        if (stat.isDirectory()) {
          const source = fs.readdirSync(absolute, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".go"))
            .sort((left, right) => (left.name === "main.go" ? -1 : right.name === "main.go" ? 1 : left.name.localeCompare(right.name)))[0];
          if (source) return relativeOf(projectDir, path.join(absolute, source.name));
        }
      } catch { /* unresolved Go package paths remain unattributed */ }
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
  if (fs.existsSync(path.join(projectDir, "pom.xml"))) {
    const wrapper = process.platform === "win32" ? "mvnw.cmd" : "./mvnw";
    const executable = fs.existsSync(path.join(projectDir, wrapper)) ? wrapper : "mvn";
    add({ label: "maven test", argv: [executable, "test"], declaredArgv: [executable, "test"], category: "test", source: fs.existsSync(path.join(projectDir, wrapper)) ? "mvnw" : "pom.xml", shim: process.platform === "win32", entry: null });
  }
  if (fs.existsSync(path.join(projectDir, "build.gradle")) || fs.existsSync(path.join(projectDir, "build.gradle.kts"))) {
    const wrapper = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
    const executable = fs.existsSync(path.join(projectDir, wrapper)) ? wrapper : "gradle";
    add({ label: "gradle test", argv: [executable, "test"], declaredArgv: [executable, "test"], category: "test", source: fs.existsSync(path.join(projectDir, wrapper)) ? "gradle wrapper" : "build.gradle", shim: process.platform === "win32", entry: null });
  }
  if (fs.existsSync(path.join(projectDir, "Package.swift"))) {
    add({ label: "swift test", argv: ["swift", "test"], declaredArgv: ["swift", "test"], category: "test", source: "Package.swift", shim: false, entry: null });
  }
  if (fs.existsSync(path.join(projectDir, "build.sbt"))) {
    add({ label: "sbt test", argv: ["sbt", "test"], declaredArgv: ["sbt", "test"], category: "test", source: "build.sbt", shim: process.platform === "win32", entry: null });
  }
  if (fs.existsSync(path.join(projectDir, "mix.exs"))) {
    add({ label: "mix test", argv: ["mix", "test"], declaredArgv: ["mix", "test"], category: "test", source: "mix.exs", shim: process.platform === "win32", entry: null });
  }
  if (fs.existsSync(path.join(projectDir, "composer.json"))) {
    const composer = readText(path.join(projectDir, "composer.json"), MAX_MANIFEST_BYTES);
    try {
      const parsed = composer ? JSON.parse(composer) as { scripts?: unknown } : null;
      const scripts = parsed?.scripts;
      if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
        for (const name of Object.keys(scripts as Record<string, unknown>)) {
          if (!/^(?:test(?::|$)|spec(?::|$)|bench(?:mark)?(?::|$)|perf(?:ormance)?(?::|$)|profile(?::|$)|build(?::|$)|compile(?::|$))/i.test(name)) continue;
          add({ label: `composer ${name}`, argv: ["composer", "run-script", name], declaredArgv: ["composer", "run-script", name], category: scriptCategory(name), source: `composer.json#scripts.${name}`, shim: process.platform === "win32", entry: null });
        }
      }
    } catch { blockers.push("composer.json is not valid JSON, so its scripts cannot be read"); }
  }
  const rakefile = readText(path.join(projectDir, "Rakefile"), MAX_MANIFEST_BYTES);
  if (rakefile !== null) {
    for (const match of rakefile.matchAll(/^\s*(?:task\s+[:'\"]|Rake::TestTask\.new\s*\(?\s*[:'\"])([A-Za-z0-9_.-]+)/gm)) {
      const name = match[1];
      const category = scriptCategory(name);
      if (category === "custom") continue;
      const command = fs.existsSync(path.join(projectDir, "Gemfile")) ? ["bundle", "exec", "rake", name] : ["rake", name];
      add({ label: `rake ${name}`, argv: command, declaredArgv: command, category, source: `Rakefile#${name}`, shim: process.platform === "win32", entry: null });
    }
  }
  let hasDotnetProject = false;
  try { hasDotnetProject = fs.readdirSync(projectDir, { withFileTypes: true }).some((entry) => entry.isFile() && /\.(?:cs|fs)proj$/i.test(entry.name)); }
  catch { blockers.push("the repository root could not be scanned for .NET project files"); }
  if (hasDotnetProject) {
    add({ label: "dotnet test", argv: ["dotnet", "test"], declaredArgv: ["dotnet", "test"], category: "test", source: "*.csproj or *.fsproj", shim: false, entry: null });
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
  const candidates = [base, ...[".mjs", ".js", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".kt", ".cs"].map((extension) => `${base}${extension}`),
    ...["index.mjs", "index.js", "index.ts", "__init__.py", "mod.rs"].map((name) => path.join(base, name))];
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

function rustModules(source: string): string[] {
  return [...source.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm)].map((match) => match[1]);
}

function resolveRustModule(projectDir: string, fromFile: string, module: string): string | null {
  const directory = path.posix.dirname(fromFile);
  const basename = path.posix.basename(fromFile);
  const moduleDirectory = /^(?:lib|main|mod)\.rs$/.test(basename)
    ? directory
    : path.posix.join(directory, path.posix.basename(fromFile, ".rs"));
  const base = path.resolve(projectDir, moduleDirectory, module);
  if (!isInside(projectDir, base)) return null;
  for (const candidate of [`${base}.rs`, path.join(base, "mod.rs")]) {
    try { if (fs.statSync(candidate).isFile()) return relativeOf(projectDir, candidate); }
    catch { /* try Rust's alternate module layout */ }
  }
  return null;
}

function goImports(source: string): string[] {
  return [...source.matchAll(/^\s*import\s+(?:\([^)]*\)|(?:[A-Za-z_][A-Za-z0-9_]*\s+)?"[^"]+")/gms)]
    .flatMap(([clause]) => [...clause.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}

function goModulePath(projectDir: string): string | null {
  const goMod = readText(path.join(projectDir, "go.mod"), MAX_MANIFEST_BYTES);
  return goMod?.match(/^\s*module\s+([^\s]+)\s*$/m)?.[1] ?? null;
}

function jvmImports(source: string): string[] {
  return [...source.matchAll(/^\s*import\s+(static\s+)?([A-Za-z_][A-Za-z0-9_.$*]*)\s*;?/gm)]
    .map((match) => match[1] ? match[2].split(".").slice(0, -1).join(".") : match[2]);
}

function localGoFiles(projectDir: string, relativeDirectory: string): string[] {
  const directory = path.resolve(projectDir, relativeDirectory);
  if (!isInside(projectDir, directory)) return [];
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".go") && !isSecretPath(path.join(relativeDirectory, entry.name)))
      .map((entry) => relativeOf(projectDir, path.join(directory, entry.name)));
  } catch { return []; }
}

function resolveJvmImport(projectDir: string, specifier: string): string | null {
  const classPath = specifier.replaceAll(".", "/");
  if (classPath.endsWith("/*")) return null;
  for (const sourceRoot of ["src/main/java", "src/test/java", "src/main/kotlin", "src/test/kotlin", "src"] ) {
    for (const extension of [".java", ".kt", ".kts"]) {
      const candidate = path.join(projectDir, `${sourceRoot}/${classPath}${extension}`);
      try { if (fs.statSync(candidate).isFile()) return relativeOf(projectDir, candidate); }
      catch { /* check the next conventional source root */ }
    }
  }
  return null;
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
    if (file.endsWith(".rs")) {
      for (const module of rustModules(text)) {
        const resolved = resolveRustModule(projectDir, file, module);
        if (resolved) queue.push({ file: resolved, depth: depth + 1 });
      }
      continue;
    }
    if (file.endsWith(".go")) {
      const module = goModulePath(projectDir);
      if (!module) continue;
      for (const specifier of goImports(text)) {
        if (specifier !== module && !specifier.startsWith(`${module}/`)) continue;
        const packagePath = specifier === module ? "." : specifier.slice(module.length + 1);
        for (const imported of localGoFiles(projectDir, packagePath)) queue.push({ file: imported, depth: depth + 1 });
      }
      continue;
    }
    if (/\.(?:java|kt|kts)$/.test(file)) {
      for (const specifier of jvmImports(text)) {
        const resolved = resolveJvmImport(projectDir, specifier);
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
      redactEnvKeys: options.contract.execution.envAllowlist,
      logPath: null,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  const durationMs = result.durationMs;
  const timedOut = result.timedOut;
  const error = result.spawnError ?? (timedOut ? "probe timed out" : result.ok ? null : (result.stderrTail.trim().split(/\r?\n/, 1)[0] || `exit ${result.code}`));
  return { label: command.label, ok: result.ok, durationMs, timedOut, error, exitCode: result.code, spawnFailed: result.spawnError !== null };
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
  const tests = discovered.commands.filter((command) => command.category === "test");
  for (const command of discovered.commands) {
    if (!measurable.includes(command)) notes.push(`"${command.label}" is a ${command.category} command; it is available as a gate, not as the measured outcome.`);
  }
  const limit = Math.max(1, options.maxProbes ?? 3);
  // Keep one measured workload for duration levers, then spend the remaining
  // bounded probes checking declared tests. A failing test is useful evidence;
  // timeout or spawn failure is not.
  const firstMeasuredCount = Math.min(1, measurable.length, limit);
  const testProbes = tests.slice(0, Math.max(0, limit - firstMeasuredCount));
  const additionalMeasuredCount = Math.max(0, limit - firstMeasuredCount - testProbes.length);
  const probeCommands = [
    ...measurable.slice(0, firstMeasuredCount),
    ...testProbes,
    ...measurable.slice(firstMeasuredCount, firstMeasuredCount + additionalMeasuredCount),
  ];
  const probes: ProbeReading[] = [];
  for (const command of probeCommands) {
    if (options.signal?.aborted) break;
    progress(`recon: probing "${command.label}"`);
    const reading = options.probeImpl
      ? await options.probeImpl(command)
      : await probeCommand(options, command);
    probes.push(reading);
    if (!reading.ok && command.category !== "test") blockers.push(`the declared workload "${command.label}" did not complete: ${reading.error ?? "unknown failure"}`);
    if (!reading.ok && command.category === "test") notes.push(`test command "${command.label}" failed during recon${reading.exitCode !== undefined ? ` with exit ${reading.exitCode}` : ""}; it becomes a failure lever only when the process launched and exited normally.`);
  }

  const hasMeasuredProbe = probeCommands.some((command) => measurable.includes(command) && probes.some((probe) => probe.label === command.label));
  const hasFailingTest = tests.some((command) => {
    const probe = probes.find((item) => item.label === command.label);
    return probe !== undefined && !probe.ok && !probe.timedOut && probe.spawnFailed !== true && probe.exitCode !== null && probe.exitCode !== undefined;
  });
  if (measurable.length === 0 && !hasFailingTest) blockers.push("no benchmark or custom workload is declared, so no duration or throughput can be measured");

  const graph = new Set<string>();
  const graphs: Record<string, string[]> = {};
  let truncated = false;
  for (const command of probeCommands) {
    if (!command.entry) continue;
    const walked = importGraph(projectDir, command.entry);
    truncated = truncated || walked.truncated;
    graphs[command.label] = walked.files;
    if (measurable.includes(command)) for (const file of walked.files) graph.add(file);
  }
  const evaluatorGraph = new Set<string>();
  for (const token of argvPathTokens(options.contract.outcome.evaluator?.argv ?? [])) {
    const absolute = path.resolve(projectDir, token);
    if (!isInside(projectDir, absolute) || readText(absolute, MAX_SOURCE_BYTES) === null) continue;
    const walked = importGraph(projectDir, relativeOf(projectDir, absolute));
    truncated = truncated || walked.truncated;
    for (const file of walked.files) evaluatorGraph.add(file);
  }
  if (evaluatorGraph.size > 0) graphs["contract.outcome.evaluator"] = [...evaluatorGraph].sort();
  if (hasMeasuredProbe && graph.size === 0) {
    blockers.push("the declared workload does not name a local entry file, so its patch scope cannot be attributed to measured code");
  }
  if (truncated) notes.push(`the import graph reached the ${MAX_GRAPH_FILES}-file cap; later candidates may be incomplete.`);

  return { commands: discovered.commands, probes, graph: [...graph].sort(), graphs, files, notes, blockers };
}

export interface ReconInventoryOptions {
  contract: RunContract;
  recon: ReconResult;
  attempts?: LeverAttempt[];
  signals?: SignalsResult["weaknesses"];
}

/** Words that make a wall-clock duration an honest measure of the approved outcome. */
const TIME_LIKE_WORDS = /(?:^|[^a-z])(?:ms|milliseconds?|seconds?|secs?|time|latency|durations?|minutes?|hours?)(?:[^a-z]|$)/i;

/** True when the approved outcome is itself about time, so duration is not a proxy for it. */
export function timeLikeOutcome(outcome: RunContract["outcome"]): boolean {
  return TIME_LIKE_WORDS.test(outcome.unit) || TIME_LIKE_WORDS.test(outcome.statement);
}

/**
 * Why a wall-clock duration lever is not an honest measure of this outcome, or
 * null when it is (the outcome is time-like, or the operator justified the proxy).
 */
export function durationProxyRefusal(contract: RunContract): string | null {
  if (timeLikeOutcome(contract.outcome)) return null;
  if (contract.outcome.proxyJustification) return null;
  return `wall-clock duration is a proxy for the approved outcome ("${contract.outcome.statement}", ${contract.outcome.unit}); supply outcome.proxyJustification or approve a time-like unit/statement before measuring duration`;
}

/** Normalized path tokens from an evaluator argv/inputs declaration. */
function pathTokens(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((value) => value !== "" && !value.startsWith("-"));
}

/** Only the argv entries that name a project file, not the interpreter or flags. */
function argvPathTokens(argv: string[]): string[] {
  // An absolute interpreter path can be inside the project (.venv/bin/python).
  // It is runtime infrastructure, not measured implementation source. Keep argv[0]
  // only when it is itself a source-script entry point.
  const files = argv.filter((token, index) => index > 0 || SOURCE_EXTENSIONS.has(path.extname(token).toLowerCase()) || /\.(?:sh|ps1)$/i.test(token));
  return pathTokens(files).filter((token) => token.includes("/")
    || /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|py|rb|go|rs|java|kt|cs|sh|ps1|json|ya?ml|toml|csv|txt)$/i.test(token));
}

/** True when a project-relative file is part of the pinned evaluator (never candidate-editable). */
function pinnedEvaluatorFile(evaluator: RunContractScoreEvaluator, file: string): boolean {
  const candidate = file.replace(/\\/g, "/");
  const tokens = [...pathTokens(evaluator.inputs), ...argvPathTokens(evaluator.argv)];
  return tokens.some((token) => candidate === token || candidate.startsWith(`${token.replace(/\/$/, "")}/`));
}

interface ScoreLeverBuild {
  lever?: LeverProposal;
  reason?: string;
}

/**
 * The declared score evaluator is the primary instrument: a lever that measures
 * its number, scoped to the code the measured workload exercises, with direction
 * and unit taken from the approved outcome rather than guessed.
 */
function scoreEvaluatorLever(options: {
  contract: RunContract;
  evaluator: RunContractScoreEvaluator;
  recon: ReconResult;
  gates: string[];
  attempt: LeverAttempt | undefined;
}): ScoreLeverBuild {
  const { contract, evaluator } = options;
  const id = leverId("recon-command", ["contract.outcome.evaluator", evaluator.output, ...evaluator.argv]);
  // Trace the evaluator first. Only an evaluator's own static imports establish
  // static attribution; unrelated manifest command graphs cannot stand in for it.
  const evaluatorGraph = options.recon.graphs["contract.outcome.evaluator"] ?? [];
  const reachedImplementation = evaluatorGraph.some((file) => !pinnedEvaluatorFile(evaluator, file));
  const attributable = reachedImplementation
    ? evaluatorGraph
    // Without a reached implementation, explicit roots are only a candidate
    // nomination. Qualification must prove the evaluator responds to edits.
    : contract.scope.roots.length > 0 ? options.recon.files.map((file) => file.path) : [];
  const inScope = attributable.filter((file) => pathWithin(file, contract.scope.roots)
    && !protectedAsset(contract, file)
    && !pinnedEvaluatorFile(evaluator, file));
  const outOfScope = attributable.filter((file) => !inScope.includes(file));
  if (inScope.length === 0) {
    return {
      reason: reachedImplementation
        ? `the declared score evaluator ${evaluator.argv.join(" ")} statically reaches implementation code, but none is inside the approved editable scope (${contract.scope.roots.join(", ") || "whole workspace"}), so no patch can be attributed to it`
        : `the declared score evaluator ${evaluator.argv.join(" ")} has no statically reached implementation and no explicit nonempty editable roots nominate candidate files; no patch can be attributed to it`,
    };
  }
  const attempt = options.attempt;
  const demotion = attemptDemotion(attempt?.outcome);
  const measuredDurations = options.recon.probes
    .filter((probe) => probe.ok && probe.durationMs !== null)
    .map((probe) => probe.durationMs as number);
  const costSeconds = measuredDurations.length > 0
    ? Math.max(5, Math.min(600, Math.max(...measuredDurations) / 1000))
    : 60;
  const expectedGain = 0.5;
  const readiness = options.gates.length > 0 ? 0.9 : 0.75;
  const score = demotion * (expectedGain * readiness) / Math.pow(costSeconds, 0.25);
  const direction = contract.outcome.higherIsBetter ? "maximize" : "minimize";
  const pinned = [...new Set(pathTokens(evaluator.inputs))];
  const lever: LeverProposal = {
    id,
    sourceKind: "recon-command",
    goal: contract.outcome.statement,
    mechanism: "improve the code the declared score evaluator exercises, measured by the evaluator itself",
    metric: `${contract.outcome.statement} (${contract.outcome.unit}, ${contract.outcome.higherIsBetter ? "higher" : "lower"} is better)`,
    metricKind: "score",
    scopeFiles: inScope.slice(0, 8),
    gates: [...options.gates],
    estimates: { expectedGain, costSeconds, confidence: 0.6, readiness },
    score,
    evidence: [{ source: "evaluator", ref: `contract.outcome.evaluator:${evaluator.output}`, count: 1 }],
    reasons: [
      `declared score evaluator: ${evaluator.argv.join(" ")} reports ${evaluator.output}; direction ${direction}, unit ${contract.outcome.unit} (from the approved outcome)`,
      `evaluator argv and inputs are pinned verifier inputs and never candidate-editable${pinned.length > 0 ? `: ${pinned.join(", ")}` : ""}`,
      reachedImplementation
        ? `scope: ${inScope.length} file(s) from the evaluator's static import graph inside the approved editable scope; ${outOfScope.length} out-of-scope or pinned file(s) excluded`
        : `unverified dynamic claim: ${inScope.length} candidate file(s) nominated by the explicit editable roots, not static attribution; qualification must verify sensitivity`,
      options.gates.length > 0
        ? `gate: ${options.gates.join(", ")}`
        : "no declared test gate; the declared evaluator's own validity verdict is the only oracle",
      attempt ? `history: prior outcome ${attempt.outcome} for this lever; score adjusted.` : "history: no prior outcome for this lever",
    ],
    command: { argv: [...evaluator.argv], shim: false, source: "contract.outcome.evaluator", entry: null },
  };
  return { lever };
}


/**
 * Turn recon evidence into ranked levers. A declared score evaluator becomes the
 * only instrument because it measures the approved outcome directly; otherwise the
 * measured workload with the largest attributable duration becomes a duration
 * lever scoped to the code the measurement actually exercises. A declared test
 * command becomes the gate. Everything else is rejected with the reason, never
 * silently dropped.
 */
export function buildReconInventory(options: ReconInventoryOptions): LeverInventory {
  const { contract, recon } = options;
  const attempts = options.attempts ?? [];
  const attemptByLever = new Map(attempts.map((attempt) => [attempt.leverId, attempt]));
  const levers: LeverProposal[] = [];
  const rejected: LeverInventory["rejected"] = [];
  const diagnostics: string[] = [...recon.notes];
  const passingTests = recon.commands.filter((command) => command.category === "test" && recon.probes.some((probe) => probe.label === command.label && probe.ok));
  const gates = passingTests.map((command) => command.label);
  if (gates.length > 0) diagnostics.push(`Declared test gates: ${gates.join(", ")}.`);

  // A declared score evaluator fixes what the number means and its direction.
  // Other measurements can be diagnostics, but cannot replace it on failure.
  let scoreLever: LeverProposal | null = null;
  if (contract.outcome.evaluator) {
    const evaluator = contract.outcome.evaluator;
    diagnostics.push(`Declared score evaluator: ${evaluator.argv.join(" ")} (${evaluator.output}, ${contract.outcome.unit}, ${contract.outcome.higherIsBetter ? "higher" : "lower"} is better).`);
    const id = leverId("recon-command", ["contract.outcome.evaluator", evaluator.output, ...evaluator.argv]);
    const built = scoreEvaluatorLever({ contract, evaluator, recon, gates, attempt: attemptByLever.get(id) });
    if (built.lever) scoreLever = built.lever;
    else if (built.reason) rejected.push({ id, sourceKind: "recon-command", reason: built.reason, readiness: 0.1 });
  }

  const measured = recon.commands
    .filter((command) => command.category === "benchmark" || command.category === "custom")
    .map((command) => ({ command, probe: recon.probes.find((probe) => probe.label === command.label) ?? null }))
    .filter((entry) => entry.probe !== null);

  for (const command of recon.commands.filter((item) => item.category === "test")) {
    const probe = recon.probes.find((item) => item.label === command.label);
    if (!probe || probe.ok || probe.timedOut || probe.spawnFailed === true || probe.exitCode === null || probe.exitCode === undefined) continue;
    const id = leverId("recon-command", [command.label, command.source, "suite-failures"]);
    const workloadGraph = recon.graphs[command.label] ?? [];
    const inScope = workloadGraph.filter((file) => pathWithin(file, contract.scope.roots) && !protectedAsset(contract, file));
    if (inScope.length === 0) {
      rejected.push({ id, sourceKind: "recon-command", readiness: 0.25,
        reason: `"${command.label}" exits with ${probe.exitCode}, but its test entry imports no file inside the approved editable scope (${contract.scope.roots.join(", ") || "whole workspace"})` });
      continue;
    }
    const attempt = attemptByLever.get(id);
    const demotion = attemptDemotion(attempt?.outcome);
    const signalMatches = (options.signals ?? []).filter((signal) => signal.evidence.some((item) =>
      item.ref.toLowerCase().includes(command.label.toLowerCase()) || inScope.some((file) => file.toLowerCase() === item.ref.toLowerCase())));
    const signalCount = signalMatches.reduce((sum, signal) => sum + signal.evidence.reduce((total, item) => total + item.count, 0), 0);
    const signalMultiplier = 1 + Math.min(1, signalCount / 5);
    const costSeconds = Math.max(5, Math.min(600, (probe.durationMs ?? 30_000) / 1000));
    const readiness = gates.length > 0 ? 0.9 : 0.5;
    levers.push({
      id, sourceKind: "recon-command",
      goal: `Reduce the number of failures reported by "${command.label}" without weakening its assertions.`,
      mechanism: `fix the code exercised by the failing test command "${command.label}"`,
      metric: `"${command.label}" failure count (failures, lower is better)`,
      metricKind: "suite-failures",
      scopeFiles: inScope.slice(0, 8),
      gates: [...gates],
      estimates: { expectedGain: Math.min(1, Math.max(0.1, Math.abs(probe.exitCode))), costSeconds, confidence: 0.6, readiness },
      score: demotion * signalMultiplier * (Math.min(1, Math.max(0.1, Math.abs(probe.exitCode))) * readiness) / Math.pow(costSeconds, 0.25),
      evidence: [{ source: "evaluator", ref: command.source, count: Math.max(1, Math.abs(probe.exitCode)) },
        ...signalMatches.flatMap((signal) => signal.evidence.map((item) => ({ ...item, ref: `${signal.kind}:${item.ref}` })))],
      reasons: [
        `failed on the unchanged tree with exit ${probe.exitCode}${probe.error ? `: ${probe.error}` : ""}`,
        `scope: ${inScope.length} file(s) reached from the test entry ${command.entry ?? "unknown"}`,
        gates.length > 0 ? `passing correctness gate(s): ${gates.join(", ")}` : "no passing independent test gate was found; metric qualification may refuse this lever",
        attempt ? `history: prior outcome ${attempt.outcome} for this lever; score adjusted.` : "history: no prior outcome for this lever",
        ...(signalCount > 0 ? [`usage signals: ${signalCount} matching event(s), ranking multiplier ${signalMultiplier.toFixed(2)}`] : []),
      ],
      command: { argv: [...command.argv], shim: command.shim, source: command.source, entry: command.entry },
    });
  }

  for (const { command, probe } of measured) {
    const id = leverId("recon-command", [command.label, command.source]);
    // Scope comes from this workload's own imports, not from every measured workload.
    const workloadGraph = recon.graphs[command.label] ?? [];
    const inScope = workloadGraph.filter((file) => pathWithin(file, contract.scope.roots) && !protectedAsset(contract, file));
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
    // Wall time is only the outcome when the contract says so; otherwise it is a
    // proxy that the operator has to justify explicitly.
    const proxyRefusal = durationProxyRefusal(contract);
    if (proxyRefusal) {
      rejected.push({
        id, sourceKind: "recon-command", readiness: 0.2,
        reason: `"${command.label}" would measure wall-clock duration: ${proxyRefusal}`,
      });
      continue;
    }
    const attempt = attemptByLever.get(id);
    const demotion = attemptDemotion(attempt?.outcome);
    // Uncalibrated prior: a slower measured workload has more attributable headroom,
    // with the same saturating shape the signal inventory uses.
    const expectedGain = Math.min(1, probe!.durationMs / 30_000);
    const costSeconds = Math.max(5, Math.min(600, probe!.durationMs / 1000));
    const readiness = gates.length > 0 ? 0.9 : 0.75;
    const matchingSignals = (options.signals ?? []).filter((signal) => signal.evidence.some((item) =>
      item.ref.toLowerCase().includes(command.label.toLowerCase())
      || command.label.toLowerCase().includes(item.ref.toLowerCase())
      || inScope.some((file) => file.toLowerCase() === item.ref.toLowerCase())));
    const signalCount = matchingSignals.reduce((sum, signal) => sum + signal.evidence.reduce((total, item) => total + item.count, 0), 0);
    const signalMultiplier = 1 + Math.min(1, signalCount / 5);
    const score = demotion * signalMultiplier * (expectedGain * readiness) / Math.pow(costSeconds, 0.25);
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
      evidence: [{ source: "evaluator", ref: command.source, count: 1 }, ...matchingSignals.flatMap((signal) => signal.evidence.map((item) => ({ ...item, ref: `${signal.kind}:${item.ref}` })))],
      reasons: [
        `measured: "${command.label}" completed in ${Math.round(probe!.durationMs)} ms (${command.source})`,
        `scope: ${inScope.length} file(s) reached from the measured workload's entry ${command.entry ?? "unknown"}; ${outOfScope.length} measured file(s) excluded by the approved scope`,
        gates.length > 0 ? `gate: ${gates.join(", ")}` : "no declared test gate; correctness must be established by the metric's own oracle",
        attempt ? `history: prior outcome ${attempt.outcome} for this lever; score adjusted.` : "history: no prior outcome for this lever",
        ...(signalCount > 0 ? [`usage signals: ${signalCount} matching event(s), ranking multiplier ${signalMultiplier.toFixed(2)}`] : []),
      ],
      command: { argv: [...command.argv], shim: command.shim, source: command.source, entry: command.entry },
    });
  }

  for (const blocker of recon.blockers) {
    diagnostics.push(`blocker: ${blocker}`);
    // A blocker is a named refusal, not an unexplained lack of eligible levers: it carries
    // its own id and reason so status, memory and reporting can explain the stop.
    rejected.push({ id: leverId("recon-command", [blocker]), sourceKind: "recon-command", reason: blocker, readiness: 0 });
  }

  if (contract.outcome.evaluator) {
    for (const lever of levers) rejected.push({ id: lever.id, sourceKind: lever.sourceKind, readiness: 0,
      reason: `The declared evaluator is authoritative; ${lever.metricKind} is an alternate measurement and cannot be used as a proxy fallback if that evaluator fails qualification.` });
    return { levers: scoreLever ? [scoreLever] : [], rejected, diagnostics };
  }
  levers.sort((a, b) => b.score - a.score || b.estimates.expectedGain - a.estimates.expectedGain || a.id.localeCompare(b.id));
  return { levers, rejected, diagnostics };
}

function protectedAsset(contract: RunContract, relative: string): boolean {
  const candidate = relative.replace(/\\/g, "/");
  return contract.scope.protectedAssets.some((asset) => {
    const normalized = asset.replace(/\\/g, "/").replace(/\/$/, "");
    return candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}
