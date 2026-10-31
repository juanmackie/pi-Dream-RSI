/**
 * The durable project card.
 *
 * One bounded, read-only pass over a repository records what the project is
 * made of: languages, package managers, declared test and benchmark commands,
 * CI commands, import hotspots, complexity signals, dependency declarations,
 * architecture smells, and the magnitude candidates those signals imply.
 *
 * The card is advisory evidence. It does not run project commands, qualify an
 * instrument, or grant edit scope. The loop uses it to rank search and to show
 * an operator what it believes about the project; the evaluator and gates still
 * decide every promotion.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileAtomic } from "./fsutil.ts";
import { estimateMagnitude, estimateScopeMagnitude, magnitudeUtility, type ScopeFileSignals } from "./magnitude.ts";
import type { CampaignType, LeverMagnitude } from "./levers.ts";

export const PROJECT_CARD_VERSION = 1;
export const PROJECT_CARD_FILE = ".dream-rsi/project-card.json";

const MAX_FILES = 4000;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_HOTSPOTS = 12;
const MAX_MAGNITUDE_CANDIDATES = 10;
const MAX_CI_COMMANDS = 20;

const SKIP_DIRS = new Set([
  ".git", ".dream-rsi", ".dream-rsi-harness", "node_modules", ".venv", "venv", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", "target", ".gradle", "dist", "build", ".next",
  ".turbo", "coverage", "out", "bin", "obj", "vendor", "pods", "deriveddata", ".idea", ".vscode",
]);

const SECRET_PATH = /(?:^|[\\/])(?:\.env(?:\.|$)|secrets?|credentials?|id_rsa|id_ed25519|\.npmrc|\.netrc)(?:[\\/._-]|$)|(?:^|[\\/])[^\\/]*(?:key|token|secret|credential|password)[^\\/]*(?:$|[\\/])|\.(?:pem|p12|pfx|keystore)$/i;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".py": "Python", ".pyi": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin", ".kts": "Kotlin",
  ".cs": "C#", ".fs": "F#", ".fsx": "F#",
  ".rb": "Ruby",
  ".php": "PHP",
  ".swift": "Swift",
  ".scala": "Scala", ".sc": "Scala",
  ".ex": "Elixir", ".exs": "Elixir",
  ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hpp": "C++",
};

const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".json"];

export interface ProjectLanguage {
  name: string;
  files: number;
  share: number;
}

export interface ProjectHotspot {
  path: string;
  score: number;
  lines: number;
  inboundImports: number;
  reasons: string[];
}

export interface ProjectDependencySignal {
  manifest: string;
  declared: number;
  /** No upper bound, a wildcard, or a floating tag. */
  unpinned: number;
  /** A declared 0.x range, which is pre-1.0 and changes without a major bump. */
  preMajor: number;
  /** The same dependency is declared at two different major versions. */
  duplicateMajors: number;
}

export interface ProjectArchitectureSmell {
  kind: "god-file" | "deep-nesting" | "import-cycle" | "unreachable-module";
  path: string;
  detail: string;
}

export interface ProjectMagnitudeCandidate {
  campaignType: CampaignType;
  path: string;
  expectedGainMultiplier: number;
  confidence: number;
  reason: string;
}

export interface ProjectCard {
  version: 1;
  digest: string;
  generatedAt: string;
  scanned: { files: number; bytes: number; truncated: boolean };
  languages: ProjectLanguage[];
  packageManagers: string[];
  testRunners: string[];
  benchmarkCommands: string[];
  ciCommands: string[];
  entryPoints: string[];
  hotspots: ProjectHotspot[];
  dependencies: ProjectDependencySignal[];
  architecture: ProjectArchitectureSmell[];
  magnitudeCandidates: ProjectMagnitudeCandidate[];
}

interface SourceFile {
  path: string;
  absolute: string;
  language: string;
  bytes: number;
  lines: number;
  text: string;
}

type ComplexityKind = "nested-loops" | "linear-scan-in-loop" | "sync-io-in-loop" | "serial-await"
  | "branch-heavy" | "large-file" | "god-file";

interface FileComplexity {
  path: string;
  lines: number;
  functions: number;
  branches: number;
  loops: number;
  kinds: Set<ComplexityKind>;
  inbound: number;
  entry: boolean;
  test: boolean;
  exported: boolean;
}

function isSecretPath(relative: string): boolean {
  return SECRET_PATH.test(relative.replace(/\\/g, "/"));
}

function languageOf(file: string): string | null {
  return LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()] ?? null;
}

function readText(file: string, limit: number): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > limit) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function walkSources(projectDir: string): { files: SourceFile[]; scanned: ProjectCard["scanned"] } {
  const root = path.resolve(projectDir);
  const files: SourceFile[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let readBytes = 0;
  let truncated = false;
  const queue: string[] = [""];
  while (queue.length > 0 && !truncated) {
    const relative = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); }
    catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (scannedFiles >= MAX_FILES || scannedBytes >= MAX_TOTAL_BYTES) { truncated = true; break; }
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (next.split("/").length > MAX_DEPTH) continue;
        queue.push(next);
        continue;
      }
      if (!entry.isFile() || isSecretPath(next)) continue;
      const absolute = path.join(root, ...next.split("/"));
      let stat: fs.Stats;
      try { stat = fs.lstatSync(absolute); }
      catch { continue; }
      scannedFiles += 1;
      scannedBytes += stat.size;
      const language = languageOf(entry.name);
      if (!language) continue;
      const text = stat.size <= MAX_TEXT_BYTES && readBytes + stat.size <= MAX_READ_BYTES
        ? readText(absolute, MAX_TEXT_BYTES)
        : null;
      if (text !== null) readBytes += Buffer.byteLength(text, "utf8");
      files.push({
        path: next,
        absolute,
        language,
        bytes: stat.size,
        lines: text === null ? Math.max(1, Math.round(stat.size / 40)) : countLines(text),
        text: text ?? "",
      });
    }
  }
  return { files, scanned: { files: scannedFiles, bytes: scannedBytes, truncated } };
}

interface ResolveContext {
  byPath: Map<string, SourceFile>;
  byDir: Map<string, SourceFile[]>;
  byBasename: Map<string, SourceFile[]>;
  goModule: string | null;
  rustRoot: string | null;
}

function basenameOf(file: string): string {
  return path.posix.basename(file).replace(/\.[^.]+$/, "");
}

function dirnameOf(file: string): string {
  const dir = path.posix.dirname(file);
  return dir === "." ? "" : dir;
}

function buildContext(projectDir: string, files: SourceFile[]): ResolveContext {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const byDir = new Map<string, SourceFile[]>();
  const byBasename = new Map<string, SourceFile[]>();
  for (const file of files) {
    const dir = dirnameOf(file.path);
    const bucket = byDir.get(dir) ?? [];
    bucket.push(file);
    byDir.set(dir, bucket);
    const base = basenameOf(file.path);
    const named = byBasename.get(base) ?? [];
    named.push(file);
    byBasename.set(base, named);
  }
  const goMod = readText(path.join(projectDir, "go.mod"), 64 * 1024);
  const goModule = goMod ? /^\s*module\s+(\S+)\s*$/m.exec(goMod)?.[1] ?? null : null;
  const rustRoot = files.find((file) => file.path === "src/lib.rs" || file.path === "src/main.rs")
    ? "src"
    : null;
  return { byPath, byDir, byBasename, goModule, rustRoot };
}

function resolveRelative(from: string, spec: string, extensions: string[], context: ResolveContext): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(dirnameOf(from), spec));
  if (base === ".." || base.startsWith("../")) return null;
  const candidates = [
    base,
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => context.byPath.has(candidate)) ?? null;
}

function uniqueBasename(base: string, context: ResolveContext): string | null {
  const matches = context.byBasename.get(base) ?? [];
  return matches.length === 1 ? matches[0]!.path : null;
}

function jsEdges(file: SourceFile, context: ResolveContext): string[] {
  const specs = [
    ...[...file.text.matchAll(/(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]!),
    ...[...file.text.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]!),
    ...[...file.text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]!),
  ];
  return specs.flatMap((spec) => {
    const resolved = resolveRelative(file.path, spec, JS_EXTENSIONS, context);
    return resolved ? [resolved] : [];
  });
}

function pythonEdges(file: SourceFile, context: ResolveContext): string[] {
  const edges: string[] = [];
  const fromRelative = [...file.text.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\b/gm)];
  for (const match of fromRelative) {
    let base = dirnameOf(file.path);
    const dots = match[1]!.length;
    for (let index = 1; index < dots; index += 1) base = path.posix.dirname(base);
    if (base === ".") base = "";
    const module = match[2]!.replace(/\./g, "/");
    const stem = module ? path.posix.join(base, module) : base;
    for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) {
      if (context.byPath.has(candidate)) edges.push(candidate);
    }
  }
  const fromAbsolute = [...file.text.matchAll(/^\s*from\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+import\b/gm)]
    .map((match) => match[1]!);
  const plain = [...file.text.matchAll(/^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/gm)]
    .flatMap((match) => match[1]!.split(",").map((entry) => entry.trim()));
  for (const spec of [...fromAbsolute, ...plain]) {
    const module = spec.replace(/\./g, "/");
    const roots = [""];
    let current = dirnameOf(file.path);
    while (current && roots.length < 5) { roots.push(current); current = path.posix.dirname(current); }
    for (const root of roots) {
      const stem = path.posix.join(root, module);
      for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) {
        if (context.byPath.has(candidate)) edges.push(candidate);
      }
    }
  }
  return [...new Set(edges)];
}

function goEdges(file: SourceFile, context: ResolveContext): string[] {
  if (!context.goModule) return [];
  const specs = [
    ...[...file.text.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)].map((match) => match[1]!),
    ...[...file.text.matchAll(/import\s*\(([\s\S]*?)\)/g)].flatMap((match) =>
      [...match[1]!.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!)),
  ];
  const edges: string[] = [];
  for (const spec of specs) {
    if (spec !== context.goModule && !spec.startsWith(`${context.goModule}/`)) continue;
    const dir = spec === context.goModule ? "" : spec.slice(context.goModule.length + 1);
    for (const candidate of context.byDir.get(dir) ?? []) {
      if (candidate.path.endsWith(".go") && !candidate.path.endsWith("_test.go")) edges.push(candidate.path);
    }
  }
  return [...new Set(edges)];
}

function rustEdges(file: SourceFile, context: ResolveContext): string[] {
  const edges: string[] = [];
  const root = context.rustRoot ?? (file.path.startsWith("src/") ? "src" : dirnameOf(file.path));
  const add = (base: string): void => {
    for (const candidate of [`${base}.rs`, `${base}/mod.rs`]) {
      if (context.byPath.has(candidate)) edges.push(candidate);
    }
  };
  for (const match of file.text.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) {
    add(path.posix.join(dirnameOf(file.path), match[1]!));
  }
  for (const match of file.text.matchAll(/^\s*use\s+((?:crate|super|self)(?:::\w+)+)/gm)) {
    const parts = match[1]!.split("::").filter(Boolean);
    let base = parts[0] === "crate" ? root : parts[0] === "super" ? path.posix.dirname(dirnameOf(file.path)) : dirnameOf(file.path);
    for (const part of parts.slice(1)) {
      add(path.posix.join(base, part));
      base = path.posix.join(base, part);
    }
  }
  return [...new Set(edges)];
}

function jvmEdges(file: SourceFile, context: ResolveContext): string[] {
  const edges: string[] = [];
  for (const match of file.text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+);/gm)) {
    const parts = match[1]!.split(".");
    const base = parts.at(-1);
    if (base) {
      const resolved = uniqueBasename(base, context);
      if (resolved) edges.push(resolved);
    }
  }
  return [...new Set(edges)];
}

function scriptEdges(file: SourceFile, context: ResolveContext): string[] {
  const edges: string[] = [];
  for (const match of file.text.matchAll(/require_relative\s+["']([^"']+)["']/g)) {
    const resolved = resolveRelative(file.path, match[1]!, [".rb"], context);
    if (resolved) edges.push(resolved);
  }
  for (const match of file.text.matchAll(/(?:require|include|include_once|require_once)\s*\(?\s*["']([^"']+)["']/g)) {
    const spec = match[1]!;
    if (spec.startsWith(".")) {
      const resolved = resolveRelative(file.path, spec, [".rb", ".php"], context);
      if (resolved) edges.push(resolved);
    } else {
      const resolved = uniqueBasename(path.posix.basename(spec).replace(/\.[^.]+$/, ""), context);
      if (resolved) edges.push(resolved);
    }
  }
  return [...new Set(edges)];
}

function cEdges(file: SourceFile, context: ResolveContext): string[] {
  const edges: string[] = [];
  for (const match of file.text.matchAll(/^\s*#include\s+"([^"]+)"/gm)) {
    const spec = match[1]!;
    const resolved = resolveRelative(file.path, spec.startsWith(".") ? spec : `./${spec}`, [".h", ".hpp", ".c", ".cc", ".cpp"], context)
      ?? resolveRelative(file.path, `../${spec}`, [".h", ".hpp"], context);
    if (resolved) edges.push(resolved);
  }
  return [...new Set(edges)];
}

function localEdges(file: SourceFile, context: ResolveContext): string[] {
  switch (file.language) {
    case "JavaScript":
    case "TypeScript": return jsEdges(file, context);
    case "Python": return pythonEdges(file, context);
    case "Go": return goEdges(file, context);
    case "Rust": return rustEdges(file, context);
    case "Java":
    case "Kotlin": return jvmEdges(file, context);
    case "Ruby":
    case "PHP": return scriptEdges(file, context);
    case "C":
    case "C++": return cEdges(file, context);
    default: return [];
  }
}

const NESTED_LOOP = /\b(?:for|while)\s*\([^)]{0,200}\)[^{;]{0,200}\{(?:[^{}]|\{[^{}]{0,200}\}){0,400}?\b(?:for|while)\s*\(/s;
const NESTED_LOOP_PYTHON = /^\s*(?:async\s+)?for\b[^\n]*:\s*\n(?:[ \t]+[^\n]*\n){0,12}?[ \t]+(?:async\s+)?for\b/m;
const LINEAR_SCAN_IN_LOOP = /\b(?:for|while)\s*\([^)]{0,200}\)[^{;]{0,200}\{(?:[^{}]|\{[^{}]{0,200}\}){0,500}?\.(?:includes|indexOf|lastIndexOf|find|findIndex|filter|some|every)\s*\(/s;
const LINEAR_SCAN_IN_LOOP_PYTHON = /^\s*(?:async\s+)?for\b[^\n]*:\s*\n(?:[ \t]+[^\n]*\n){0,12}?[ \t]+[^\n]*(?:\bin\s+[\w.[\]()]+\s*:|\.index\s*\(|\.find\s*\()/m;
const SYNC_IO_IN_LOOP = /\b(?:for|while)\s*\([^)]{0,200}\)[^{;]{0,200}\{(?:[^{}]|\{[^{}]{0,200}\}){0,500}?(?:readFileSync|writeFileSync|readdirSync|statSync|execSync|spawnSync)\s*\(/s;
const SYNC_IO_IN_LOOP_PYTHON = /^\s*(?:async\s+)?for\b[^\n]*:\s*\n(?:[ \t]+[^\n]*\n){0,12}?[ \t]+[^\n]*(?:\bopen\s*\(|\brequests\.|\burllib\.|\bsubprocess\.)/m;

function complexityOf(file: SourceFile): FileComplexity {
  const text = file.text;
  const lines = file.lines;
  const functions = countFunctions(file);
  const branches = (text.match(/\bif\b|\belse\b|\bswitch\b|\bcase\b|\bcatch\b|\bexcept\b|&&|\|\||\?\s*[^:\s]/g) ?? []).length;
  const loops = (text.match(/\bfor\b|\bwhile\b|\.forEach\s*\(|\.map\s*\(|\.filter\s*\(/g) ?? []).length;
  const kinds = new Set<ComplexityKind>();
  if (NESTED_LOOP.test(text) || NESTED_LOOP_PYTHON.test(text)) kinds.add("nested-loops");
  if (LINEAR_SCAN_IN_LOOP.test(text) || LINEAR_SCAN_IN_LOOP_PYTHON.test(text)) kinds.add("linear-scan-in-loop");
  if (SYNC_IO_IN_LOOP.test(text) || SYNC_IO_IN_LOOP_PYTHON.test(text)) kinds.add("sync-io-in-loop");
  if ((text.match(/\bawait\b/g) ?? []).length >= 3 && !/\bPromise\.all\b|\basyncio\.gather\b|\bTaskGroup\b/.test(text)) kinds.add("serial-await");
  if (lines >= 80 && (branches / lines) * 100 >= 20) kinds.add("branch-heavy");
  if (lines >= 800) kinds.add("large-file");
  if (lines >= 1200 || (lines >= 500 && functions >= 40)) kinds.add("god-file");
  const exported = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\b|^\s*(?:async\s+)?def\s+[A-Za-z]|^\s*class\s+[A-Za-z]|^\s*pub\s+(?:fn|struct|enum|trait|mod)\b|^\s*func\s+[A-Z]/m.test(text);
  return {
    path: file.path,
    lines,
    functions,
    branches,
    loops,
    kinds,
    inbound: 0,
    entry: false,
    test: isTestPath(file.path),
    exported,
  };
}

function countFunctions(file: SourceFile): number {
  switch (file.language) {
    case "JavaScript":
    case "TypeScript":
      return (file.text.match(/\bfunction\s+\w+|\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(|\bclass\s+\w+/g) ?? []).length;
    case "Python":
      return (file.text.match(/^\s*(?:async\s+)?def\s+\w+/gm) ?? []).length;
    case "Go":
      return (file.text.match(/^func\s+(?:\([^)]*\)\s*)?\w+/gm) ?? []).length;
    case "Rust":
      return (file.text.match(/^\s*(?:pub\s+)?fn\s+\w+/gm) ?? []).length;
    case "Java":
    case "Kotlin":
      return (file.text.match(/\b(?:public|private|protected|internal)\s+[\w<>[\], ?]+\s+\w+\s*\(|\bfun\s+\w+\s*\(/g) ?? []).length;
    case "Ruby":
      return (file.text.match(/^\s*def\s+\w+/gm) ?? []).length;
    case "PHP":
      return (file.text.match(/\bfunction\s+\w+/g) ?? []).length;
    case "C":
    case "C++":
      return (file.text.match(/^\s*[\w:*&<>]+\s+\w+\s*\([^;]*\)\s*\{/gm) ?? []).length;
    default:
      return 0;
  }
}

function isTestPath(file: string): boolean {
  return /(?:^|\/)(?:test|tests|spec|specs|__tests__)\/|(?:^|[._-])(?:test|spec)\.[^.]+$|_test\.(?:go|py|rs)$/i.test(file);
}

function isEntryPath(file: string): boolean {
  return /(?:^|\/)(?:main|index|lib|app|server|manage|__main__)\.[^.]+$|(?:^|\/)cmd\/[^/]+\/main\.go$|(?:^|\/)src\/main\/java\/[^/]+\/Main\.java$/i.test(file);
}

function packageManagers(projectDir: string): string[] {
  const found: string[] = [];
  const has = (name: string): boolean => fs.existsSync(path.join(projectDir, name));
  // package.json without another lockfile is still an npm project.
  if (has("package-lock.json")
    || (has("package.json") && !has("pnpm-lock.yaml") && !has("yarn.lock") && !has("bun.lockb") && !has("bun.lock"))) found.push("npm");
  if (has("pnpm-lock.yaml")) found.push("pnpm");
  if (has("yarn.lock")) found.push("yarn");
  if (has("bun.lockb") || has("bun.lock")) found.push("bun");
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) found.push("pip");
  if (has("poetry.lock")) found.push("poetry");
  if (has("uv.lock")) found.push("uv");
  if (has("Cargo.toml")) found.push("cargo");
  if (has("go.mod")) found.push("go modules");
  if (has("pom.xml")) found.push("maven");
  if (has("build.gradle") || has("build.gradle.kts")) found.push("gradle");
  if (has("Gemfile")) found.push("bundler");
  if (has("composer.json")) found.push("composer");
  if (has("Package.swift")) found.push("swift package manager");
  if (has("mix.exs")) found.push("mix");
  if (has("build.sbt")) found.push("sbt");
  try {
    if (fs.readdirSync(projectDir, { withFileTypes: true }).some((entry) => entry.isFile() && /\.(?:cs|fs)proj$/i.test(entry.name))) found.push("dotnet");
  } catch { /* an unreadable root leaves the list empty, not guessed */ }
  return [...new Set(found)];
}

interface DeclaredDependency {
  name: string;
  version: string;
}

/** Strip range operators and a Go-style `v` prefix so `==0.3.0` and `v0.3.0` read as 0.x. */
function versionCore(version: string): string {
  return version.trim().replace(/^[~^=<>!\s]*v?/i, "");
}

function dependencySignal(manifest: string, declared: DeclaredDependency[]): ProjectDependencySignal {
  let unpinned = 0;
  let preMajor = 0;
  const majors = new Map<string, Set<string>>();
  for (const entry of declared) {
    const version = entry.version.trim();
    if (!version || version === "*" || /^latest$/i.test(version) || /^>/.test(version)) unpinned += 1;
    if (/^0\./.test(versionCore(version))) preMajor += 1;
    const major = /(\d+)/.exec(version)?.[1];
    if (entry.name && major) {
      const set = majors.get(entry.name) ?? new Set<string>();
      set.add(major);
      majors.set(entry.name, set);
    }
  }
  return {
    manifest,
    declared: declared.length,
    unpinned,
    preMajor,
    duplicateMajors: [...majors.values()].filter((set) => set.size > 1).length,
  };
}

function parsePythonRequirement(entry: string): DeclaredDependency {
  const cleaned = entry.split(";")[0]!.trim();
  const match = /^([A-Za-z0-9_.-]+)\s*(.*)$/.exec(cleaned);
  return { name: match?.[1] ?? cleaned, version: (match?.[2] ?? "").trim() };
}

function packageJsonDependencies(projectDir: string): ProjectDependencySignal | null {
  const text = readText(path.join(projectDir, "package.json"), 512 * 1024);
  if (text === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const groups = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .map((key) => record[key]).filter((value): value is Record<string, string> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
  const versions = new Map<string, string[]>();
  for (const group of groups) for (const [name, version] of Object.entries(group)) {
    if (typeof version !== "string") continue;
    const list = versions.get(name) ?? [];
    list.push(version);
    versions.set(name, list);
  }
  let unpinned = 0;
  let preMajor = 0;
  let duplicateMajors = 0;
  for (const list of versions.values()) {
    for (const version of list) {
      if (!version.trim() || version === "*" || /^latest$/i.test(version) || /^>/.test(version)) unpinned += 1;
      if (/^0\./.test(versionCore(version))) preMajor += 1;
    }
    const majors = new Set(list.map((version) => /(\d+)/.exec(version)?.[1]).filter((major): major is string => Boolean(major)));
    if (majors.size > 1) duplicateMajors += 1;
  }
  return { manifest: "package.json", declared: versions.size, unpinned, preMajor, duplicateMajors };
}

function lineDependencies(projectDir: string, manifest: string, isDependencyLine: (line: string) => boolean): ProjectDependencySignal | null {
  const text = readText(path.join(projectDir, manifest), 512 * 1024);
  if (text === null) return null;
  const declared = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("//") && isDependencyLine(line))
    .map(parsePythonRequirement);
  if (declared.length === 0) return null;
  return dependencySignal(manifest, declared);
}

function dependencySignals(projectDir: string): ProjectDependencySignal[] {
  const signals: ProjectDependencySignal[] = [];
  const packageJson = packageJsonDependencies(projectDir);
  if (packageJson) signals.push(packageJson);
  const requirements = lineDependencies(projectDir, "requirements.txt", (line) => !line.startsWith("-"));
  if (requirements) signals.push(requirements);
  const pyproject = readText(path.join(projectDir, "pyproject.toml"), 512 * 1024);
  if (pyproject) {
    const block = /dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(pyproject)?.[1] ?? "";
    const declared = [...block.matchAll(/["']([^"']+)["']/g)].map((match) => parsePythonRequirement(match[1]!));
    if (declared.length > 0) signals.push(dependencySignal("pyproject.toml", declared));
  }
  const cargo = readText(path.join(projectDir, "Cargo.toml"), 512 * 1024);
  if (cargo) {
    const declared: DeclaredDependency[] = [];
    let inDependencies = false;
    for (const line of cargo.split(/\r?\n/)) {
      if (/^\s*\[(?:dev-|build-)?dependencies\]\s*$/.test(line)) { inDependencies = true; continue; }
      if (/^\s*\[/.test(line)) { inDependencies = false; continue; }
      if (inDependencies && /^\s*[\w-]+\s*=/.test(line)) {
        const name = /^\s*([\w-]+)\s*=/.exec(line)?.[1] ?? "";
        const quoted = /["']([^"']+)["']/.exec(line);
        declared.push({ name, version: quoted?.[1] ?? (/\*\s*$/.test(line) ? "*" : "") });
      }
    }
    if (declared.length > 0) signals.push(dependencySignal("Cargo.toml", declared));
  }
  const goMod = readText(path.join(projectDir, "go.mod"), 512 * 1024);
  if (goMod) {
    const declared = [...goMod.matchAll(/^\s*(?:require\s+)?([\w.\-/]+)\s+(v[\w.\-+]+)/gm)]
      .map((match) => ({ name: match[1]!, version: match[2]! }));
    if (declared.length > 0) signals.push(dependencySignal("go.mod", declared));
  }
  return signals;
}

function packageScripts(projectDir: string): Record<string, string> | null {
  const text = readText(path.join(projectDir, "package.json"), 512 * 1024);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) return null;
    return Object.fromEntries(Object.entries(parsed.scripts as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return null; }
}

function testRunners(projectDir: string, scripts: Record<string, string> | null): string[] {
  const runners: string[] = [];
  if (scripts) {
    for (const [name, body] of Object.entries(scripts)) {
      if (!/^test(?::|$)|^spec(?::|$)/.test(name)) continue;
      runners.push(`package.json#${name}`);
      for (const runner of ["jest", "vitest", "mocha", "ava", "tap", "node --test", "playwright", "cypress"]) {
        if (body.includes(runner)) runners.push(runner);
      }
    }
  }
  const has = (name: string): boolean => fs.existsSync(path.join(projectDir, name));
  if (has("pyproject.toml") || has("setup.cfg") || has("tox.ini") || has("pytest.ini")) runners.push("pytest");
  if (has("Cargo.toml")) runners.push("cargo test");
  if (has("go.mod")) runners.push("go test");
  if (has("pom.xml")) runners.push("maven test");
  if (has("build.gradle") || has("build.gradle.kts")) runners.push("gradle test");
  if (has("Gemfile")) runners.push("rspec or minitest");
  if (has("composer.json")) runners.push("phpunit");
  if (has("Package.swift")) runners.push("swift test");
  if (has("mix.exs")) runners.push("mix test");
  try {
    if (fs.readdirSync(projectDir, { withFileTypes: true }).some((entry) => entry.isFile() && /\.(?:cs|fs)proj$/i.test(entry.name))) runners.push("dotnet test");
  } catch { /* no project-file guess */ }
  return [...new Set(runners)];
}

function benchmarkCommands(projectDir: string, scripts: Record<string, string> | null): string[] {
  const commands: string[] = [];
  if (scripts) {
    const manager = fs.existsSync(path.join(projectDir, "pnpm-lock.yaml")) ? "pnpm"
      : fs.existsSync(path.join(projectDir, "yarn.lock")) ? "yarn"
        : fs.existsSync(path.join(projectDir, "bun.lockb")) || fs.existsSync(path.join(projectDir, "bun.lock")) ? "bun" : "npm";
    for (const name of Object.keys(scripts)) {
      if (/^bench(?:mark)?(?::|$)|^perf(?:ormance)?(?::|$)|^profile(?::|$)/i.test(name)) commands.push(`${manager} run ${name}`);
    }
  }
  if (fs.existsSync(path.join(projectDir, "Cargo.toml"))) commands.push("cargo bench");
  if (fs.existsSync(path.join(projectDir, "go.mod"))) commands.push("go test -bench . ./...");
  const makefile = readText(path.join(projectDir, "Makefile"), 512 * 1024);
  if (makefile) {
    for (const match of makefile.matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gm)) {
      if (/^bench(?:mark)?(?::|$)|^perf(?:ormance)?(?::|$)|^profile(?::|$)/i.test(match[1]!)) commands.push(`make ${match[1]}`);
    }
  }
  return [...new Set(commands)];
}

function ciCommands(projectDir: string): string[] {
  const files: string[] = [];
  const workflowDir = path.join(projectDir, ".github", "workflows");
  try {
    for (const entry of fs.readdirSync(workflowDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(path.posix.join(".github/workflows", entry.name));
    }
  } catch { /* no GitHub workflows */ }
  for (const candidate of [".gitlab-ci.yml", "azure-pipelines.yml", ".circleci/config.yml"]) {
    if (fs.existsSync(path.join(projectDir, candidate))) files.push(candidate);
  }
  const commands: string[] = [];
  for (const file of files.slice(0, 12)) {
    const text = readText(path.join(projectDir, file), 256 * 1024);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = /^\s*-?\s*run:\s*(.*)$/.exec(line);
      if (match) {
        const value = match[1]!.trim().replace(/^["']|["']$/g, "");
        if (value && value !== "|" && value !== ">" && !value.includes("${{")) commands.push(value);
        if (value === "|" || value === ">") {
          const indent = line.search(/\S/);
          const block: string[] = [];
          for (let next = index + 1; next < lines.length; next += 1) {
            const candidate = lines[next]!;
            if (candidate.trim() && candidate.search(/\S/) <= indent) break;
            if (candidate.trim()) block.push(candidate.trim());
          }
          if (block.length > 0 && !block.join(" ").includes("${{")) commands.push(block.join(" && "));
        }
      }
      const script = /^\s*script:\s*$/.exec(line);
      if (script) {
        const indent = line.search(/\S/);
        for (let next = index + 1; next < lines.length; next += 1) {
          const candidate = lines[next]!;
          if (candidate.trim() && candidate.search(/\S/) <= indent) break;
          const item = /^\s*-\s+(.+)$/.exec(candidate);
          if (item && !item[1]!.includes("$CI_") && !item[1]!.includes("$" + "{")) commands.push(item[1]!.trim());
        }
      }
    }
  }
  return [...new Set(commands)].slice(0, MAX_CI_COMMANDS);
}

function entryPoints(projectDir: string, files: SourceFile[], scripts: Record<string, string> | null): string[] {
  const entries = new Set<string>();
  for (const file of files) if (isEntryPath(file.path)) entries.add(file.path);
  const packageText = readText(path.join(projectDir, "package.json"), 512 * 1024);
  if (packageText) {
    try {
      const parsed = JSON.parse(packageText) as { main?: unknown; module?: unknown; bin?: unknown };
      for (const value of [parsed.main, parsed.module]) if (typeof value === "string") entries.add(value.replace(/^\.\//, ""));
      if (typeof parsed.bin === "string") entries.add(parsed.bin.replace(/^\.\//, ""));
      else if (parsed.bin && typeof parsed.bin === "object" && !Array.isArray(parsed.bin)) {
        for (const value of Object.values(parsed.bin)) if (typeof value === "string") entries.add(value.replace(/^\.\//, ""));
      }
    } catch { /* a malformed manifest is reported by dependency scanning, not guessed here */ }
  }
  if (scripts) {
    for (const [name, body] of Object.entries(scripts)) {
      if (!/^(?:start|dev|serve|bench|benchmark|test)$/i.test(name)) continue;
      const match = /(?:node|tsx|ts-node|bun|deno)\s+([^\s;|&]+)/.exec(body);
      if (match && files.some((file) => file.path === match[1])) entries.add(match[1]!);
    }
  }
  return [...entries].filter((entry) => files.some((file) => file.path === entry)).sort().slice(0, 20);
}

function findImportCycle(edges: Map<string, string[]>): string[] | null {
  const colors = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    colors.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) continue;
      const color = colors.get(next) ?? 0;
      if (color === 0) {
        const found = visit(next);
        if (found) return found;
      } else if (color === 1) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
    }
    stack.pop();
    colors.set(node, 2);
    return null;
  };
  for (const node of [...edges.keys()].sort()) {
    if ((colors.get(node) ?? 0) === 0) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

function stableCard(card: Omit<ProjectCard, "digest">): string {
  const { generatedAt: _generatedAt, ...rest } = card;
  return stableJson(rest);
}

/** Content digest of a card, excluding the timestamp and the digest itself. */
export function projectCardDigest(card: Omit<ProjectCard, "digest">): string {
  return hash(stableCard(card));
}

function magnitudeFor(complexity: FileComplexity): ReturnType<typeof estimateMagnitude> {
  return estimateMagnitude({
    nestedLoops: complexity.kinds.has("nested-loops"),
    linearScanInLoop: complexity.kinds.has("linear-scan-in-loop"),
    syncIoInLoop: complexity.kinds.has("sync-io-in-loop"),
    serialAwait: complexity.kinds.has("serial-await"),
    branchHeavy: complexity.kinds.has("branch-heavy"),
    largeFile: complexity.kinds.has("large-file"),
    godFile: complexity.kinds.has("god-file"),
    inboundImports: complexity.inbound,
    lines: complexity.lines,
  });
}

const MAX_SCOPE_MAGNITUDE_FILES = 8;

function sourceFileAt(projectDir: string, relative: string): SourceFile | null {
  const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized) || isSecretPath(normalized)) return null;
  const language = languageOf(normalized);
  if (!language) return null;
  const absolute = path.join(projectDir, ...normalized.split("/"));
  let stat: fs.Stats;
  try { stat = fs.lstatSync(absolute); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
  const text = readText(absolute, MAX_TEXT_BYTES);
  if (text === null) return null;
  return { path: normalized, absolute, language, bytes: stat.size, lines: countLines(text), text };
}

/**
 * Estimate the magnitude of one lever's editable scope.
 *
 * The scope is a small set of files the measured workload actually reaches, so
 * the estimate describes the code a candidate could change, not the whole
 * repository. The project card supplies inbound-import counts when it has them.
 * A missing or unreadable file contributes no signal rather than a guess.
 */
export function magnitudeForScope(projectDir: string, scopeFiles: string[], card?: ProjectCard | null): LeverMagnitude {
  const inbound = new Map((card?.hotspots ?? []).map((hotspot) => [hotspot.path, hotspot.inboundImports]));
  const signals: ScopeFileSignals[] = [];
  for (const relative of scopeFiles.slice(0, MAX_SCOPE_MAGNITUDE_FILES)) {
    const file = sourceFileAt(projectDir, relative);
    if (file === null) continue;
    const complexity = complexityOf(file);
    complexity.inbound = inbound.get(file.path) ?? 0;
    signals.push({
      path: file.path,
      signals: {
        nestedLoops: complexity.kinds.has("nested-loops"),
        linearScanInLoop: complexity.kinds.has("linear-scan-in-loop"),
        syncIoInLoop: complexity.kinds.has("sync-io-in-loop"),
        serialAwait: complexity.kinds.has("serial-await"),
        branchHeavy: complexity.kinds.has("branch-heavy"),
        largeFile: complexity.kinds.has("large-file"),
        godFile: complexity.kinds.has("god-file"),
        inboundImports: complexity.inbound,
        lines: complexity.lines,
      },
    });
  }
  return estimateScopeMagnitude(signals);
}

/** Build the card. This reads files and manifests only; it runs no project command. */
export function buildProjectCard(projectDir: string, options: { now?: Date } = {}): ProjectCard {
  const { files, scanned } = walkSources(projectDir);
  const context = buildContext(projectDir, files);
  const edges = new Map<string, string[]>();
  for (const file of files) edges.set(file.path, localEdges(file, context));
  const inbound = new Map<string, number>();
  for (const targets of edges.values()) for (const target of targets) inbound.set(target, (inbound.get(target) ?? 0) + 1);
  const complexities = files.map((file) => {
    const complexity = complexityOf(file);
    complexity.inbound = inbound.get(file.path) ?? 0;
    complexity.entry = isEntryPath(file.path);
    return complexity;
  });
  const scripts = packageScripts(projectDir);
  const entries = entryPoints(projectDir, files, scripts);

  const languages = [...files.reduce((counts, file) => counts.set(file.language, (counts.get(file.language) ?? 0) + 1), new Map<string, number>())]
    .map(([name, count]) => ({ name, files: count, share: files.length ? Math.round((count / files.length) * 1000) / 1000 : 0 }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name));

  const hotspots = complexities
    .map((complexity) => ({
      complexity,
      score: complexity.inbound * 2 + Math.min(20, complexity.lines / 100) + complexity.kinds.size * 4
        + (entries.includes(complexity.path) ? 3 : 0) - (complexity.test ? 2 : 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.complexity.path.localeCompare(right.complexity.path))
    .slice(0, MAX_HOTSPOTS)
    .map(({ complexity, score }) => ({
      path: complexity.path,
      score: Math.round(score * 100) / 100,
      lines: complexity.lines,
      inboundImports: complexity.inbound,
      reasons: [
        `${complexity.inbound} local importer(s)`,
        `${complexity.lines} line(s)`,
        ...(complexity.kinds.size ? [`signals: ${[...complexity.kinds].sort().join(", ")}`] : []),
      ],
    }));

  const architecture: ProjectArchitectureSmell[] = [];
  for (const complexity of complexities) {
    if (complexity.kinds.has("god-file")) architecture.push({ kind: "god-file", path: complexity.path, detail: `${complexity.lines} lines, ${complexity.functions} function(s)` });
    if (complexity.path.split("/").length > 6) architecture.push({ kind: "deep-nesting", path: complexity.path, detail: `${complexity.path.split("/").length} path segments` });
    if (complexity.inbound === 0 && complexity.exported && !complexity.entry && !complexity.test && !/^(?:index|main|lib|app|__init__)\./i.test(path.posix.basename(complexity.path))) {
      architecture.push({ kind: "unreachable-module", path: complexity.path, detail: "exports a symbol but no local module imports it" });
    }
  }
  const cycle = findImportCycle(edges);
  if (cycle) architecture.push({ kind: "import-cycle", path: cycle.join(" -> "), detail: `${cycle.length - 1} file(s) in the cycle` });

  const magnitudeCandidates = complexities
    .map((complexity) => ({ complexity, magnitude: magnitudeFor(complexity) }))
    .filter((entry) => entry.magnitude.campaignType !== "local-hill")
    .sort((left, right) => magnitudeUtility(right.magnitude) - magnitudeUtility(left.magnitude)
      || left.complexity.path.localeCompare(right.complexity.path))
    .slice(0, MAX_MAGNITUDE_CANDIDATES)
    .map(({ complexity, magnitude }) => ({
      campaignType: magnitude.campaignType,
      path: complexity.path,
      expectedGainMultiplier: magnitude.expectedGainMultiplier,
      confidence: magnitude.confidence,
      reason: magnitude.rationale[0] ?? magnitude.campaignType,
    }));

  const cardWithoutDigest: Omit<ProjectCard, "digest"> = {
    version: PROJECT_CARD_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    scanned,
    languages,
    packageManagers: packageManagers(projectDir),
    testRunners: testRunners(projectDir, scripts),
    benchmarkCommands: benchmarkCommands(projectDir, scripts),
    ciCommands: ciCommands(projectDir),
    entryPoints: entries,
    hotspots,
    dependencies: dependencySignals(projectDir),
    architecture: architecture.sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path)),
    magnitudeCandidates,
  };
  return { ...cardWithoutDigest, digest: projectCardDigest(cardWithoutDigest) };
}

/** Persist the card under `.dream-rsi/`, where loop state lives. */
export function writeProjectCard(projectDir: string, card: ProjectCard): string {
  const file = path.join(projectDir, PROJECT_CARD_FILE);
  writeFileAtomic(file, `${JSON.stringify(card, null, 2)}\n`, true);
  return file;
}

function validCard(value: unknown): value is ProjectCard {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const card = value as Partial<ProjectCard>;
  return card.version === PROJECT_CARD_VERSION && typeof card.digest === "string"
    && typeof card.generatedAt === "string" && Array.isArray(card.languages) && Array.isArray(card.hotspots)
    && Array.isArray(card.dependencies) && Array.isArray(card.architecture) && Array.isArray(card.magnitudeCandidates)
    && Array.isArray(card.testRunners) && Array.isArray(card.benchmarkCommands) && Array.isArray(card.ciCommands)
    && Array.isArray(card.entryPoints) && Array.isArray(card.packageManagers) && Boolean(card.scanned);
}

/** Read a persisted card. A corrupt or stale digest is treated as absent, never as evidence. */
export function readProjectCard(projectDir: string): ProjectCard | null {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(path.join(projectDir, PROJECT_CARD_FILE), "utf8")); }
  catch { return null; }
  if (!validCard(parsed)) return null;
  const { digest, ...rest } = parsed;
  return projectCardDigest(rest) === digest ? parsed : null;
}

/** A short, honest summary for status output. */
export function projectCardSummary(card: ProjectCard): string[] {
  const languages = card.languages.slice(0, 4).map((entry) => `${entry.name} ${Math.round(entry.share * 100)}%`).join(", ");
  const lines = [
    `Project card: ${languages || "no recognized source language"}; ${card.scanned.files} file(s) scanned${card.scanned.truncated ? " (bounded scan truncated)" : ""}.`,
    `  package managers: ${card.packageManagers.join(", ") || "none detected"}; test runners: ${card.testRunners.slice(0, 4).join(", ") || "none detected"}.`,
  ];
  if (card.benchmarkCommands.length > 0) lines.push(`  declared benchmarks: ${card.benchmarkCommands.slice(0, 4).join(", ")}.`);
  if (card.ciCommands.length > 0) lines.push(`  CI commands (not run): ${card.ciCommands.slice(0, 3).join(" | ")}.`);
  if (card.magnitudeCandidates.length > 0) {
    lines.push(`  magnitude candidates: ${card.magnitudeCandidates.slice(0, 3).map((candidate) =>
      `${candidate.campaignType} ~${candidate.expectedGainMultiplier}x at ${Math.round(candidate.confidence * 100)}% (${candidate.path})`).join("; ")}.`);
  }
  const smells = card.architecture.filter((smell) => smell.kind === "import-cycle" || smell.kind === "god-file").slice(0, 2);
  if (smells.length > 0) lines.push(`  architecture smells: ${smells.map((smell) => `${smell.kind} ${smell.path}`).join("; ")}.`);
  return lines;
}

/** Test seam: the language detector is part of the public card contract. */
export function projectLanguageOf(file: string): string | null {
  return languageOf(file);
}
