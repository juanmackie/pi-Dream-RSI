#!/usr/bin/env node
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setupSelfCampaign } from "./setup-self-campaign.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const STRUCTURAL_KINDS = new Set(["session-tool-error", "repeated-tool-retry", "aborted-session", "session-compaction", "session-model-change", "dream-improve"]);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function parseArguments(args) {
  const options = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [rawKey, ...tail] = arg.slice(2).split("=");
      const value = tail.join("=");
      options[rawKey.replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value || true;
    } else if (options.projectDir === undefined) options.projectDir = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (options.tier2Budget !== undefined) options.tier2Budget = Number(options.tier2Budget);
  if (options.target === undefined) options.target = "measure";
  if (options.noSessionLogs === true || options.includeLogs === "false") options.includeLogs = false;
  else if (options.includeLogs === undefined) options.includeLogs = true;
  if (!["measure", "policy", "controller", "prompts"].includes(options.target)) throw new Error(`unsupported target: ${options.target}`);
  return options;
}

function configuredSessionRoot(options) {
  if (options.sessionDir) return { root: options.sessionDir, flat: true };
  if (process.env.PI_SESSION_DIR) return { root: process.env.PI_SESSION_DIR, flat: true };
  const agentRoot = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return { root: path.join(agentRoot, "sessions"), flat: false };
}

function sessionDirectories(root, flat, now) {
  if (!root) return [];
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory()) return [];
    const names = fs.readdirSync(root);
    const flatFiles = names.some((name) => name.endsWith(".jsonl"));
    if (flat || flatFiles) return [root];
    return names.map((name) => {
      const directory = path.join(root, name);
      try {
        const stats = fs.lstatSync(directory);
        return stats.isDirectory() && !stats.isSymbolicLink() && stats.mtimeMs <= now.getTime()
          ? { directory, modified: stats.mtimeMs } : null;
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.modified - a.modified || a.directory.localeCompare(b.directory))
      .slice(0, 12).map((entry) => entry.directory);
  } catch { return []; }
}

function mapProjectSessions(sessionDirs, discoverSessionProjects, now) {
  const mapping = new Map();
  for (const sessionDir of sessionDirs) {
    for (const project of discoverSessionProjects(sessionDir, now)) {
      const directories = mapping.get(project) ?? new Set();
      directories.add(sessionDir);
      mapping.set(project, directories);
    }
  }
  return mapping;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* completed rename removed it */ }
  }
}

function canonicalProject(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

export function buildMinedScenarios(baseConfig, observations) {
  const fixed = structuredClone(baseConfig);
  const already = new Set(fixed.scenarios.map((scenario) => scenario.name));
  const grouped = new Map();
  for (const feature of observations.features) {
    if (feature.count < 1) continue;
    const key = `${feature.source}:${feature.feature}`;
    const group = grouped.get(key) ?? { source: feature.source, feature: feature.feature, project_ids: [], count: 0 };
    group.project_ids.push(feature.project_id);
    group.count += feature.count;
    grouped.set(key, group);
  }
  const derived = [];
  for (const group of [...grouped.values()].sort((a, b) => `${a.source}:${a.feature}`.localeCompare(`${b.source}:${b.feature}`))) {
    const total = Math.min(32, group.count);
    const intensity = Math.min(0.12, 0.04 + Math.log2(total + 1) * 0.01);
    const id = hash(`${group.source}:${group.feature}:${[...new Set(group.project_ids)].sort().join(":")}`).slice(0, 16);
    const nullName = `mined-null-${id}`;
    if (!already.has(nullName)) {
      derived.push({ name: nullName, kind: "student", df: 5, effect: 0, noise_sd: intensity,
        higher_is_better: true, derived_from: group.feature, derivation: "structural-count heuristic; synthetic stress case, not measured noise" });
      already.add(nullName);
    }
    if (["aborted-session", "session-compaction", "gate", "review"].includes(group.feature)) {
      const boundaryName = `mined-drift-boundary-${id}`;
      if (!already.has(boundaryName)) {
        derived.push({ name: boundaryName, kind: "drift", effect: baseConfig.threshold, noise_sd: 0.06,
          drift_per_run: Math.min(0.01, 0.001 * Math.log2(total + 1)), higher_is_better: true,
          derived_from: group.feature, derivation: "structural-count heuristic; synthetic stress case, not measured drift" });
        already.add(boundaryName);
      }
    }
  }
  return { ...fixed, scenarios: [...fixed.scenarios, ...derived] };
}

export async function prepareSelfImprovement(options = {}) {
  const projectDir = canonicalProject(options.projectDir ?? PACKAGE_ROOT);
  const includeLogs = options.noSessionLogs !== true && options.includeLogs !== false;
  const now = options.now instanceof Date ? options.now : new Date();
  const { collectSignals, collectLedgerEntries, discoverSessionProjects } = await import("../extensions/pi-dream-rsi/engine/signals.ts");
  const projects = new Set([projectDir]);
  const sessionConfig = includeLogs ? configuredSessionRoot(options) : null;
  const sessionDirs = sessionConfig ? sessionDirectories(sessionConfig.root, sessionConfig.flat, now) : [];
  const projectSessions = includeLogs ? mapProjectSessions(sessionDirs, discoverSessionProjects, now) : new Map();
  for (const discovered of projectSessions.keys()) projects.add(canonicalProject(discovered));
  const projectRows = [];
  const features = [];
  for (const sourceProject of [...projects].sort()) {
    const projectId = hash(sourceProject).slice(0, 24);
    const counts = new Map();
    const associatedSessionDirs = includeLogs ? [...(projectSessions.get(sourceProject) ?? [])] : [];
    for (const sessionDir of associatedSessionDirs) {
      const signals = await collectSignals({ projectDir: sourceProject, includeLogs: true, sessionDir, now });
      for (const weakness of signals.weaknesses) {
        if (!STRUCTURAL_KINDS.has(weakness.kind)) continue;
        counts.set(weakness.kind, (counts.get(weakness.kind) ?? 0) + weakness.evidence.reduce((sum, entry) => sum + entry.count, 0));
      }
    }
    // Keep non-session observations (git/evaluator/campaign ledgers) available even
    // when session mining is opted out, without asking the collector to touch logs.
    const signals = await collectSignals({ projectDir: sourceProject, includeLogs: false, now });
    for (const weakness of signals.weaknesses) if (STRUCTURAL_KINDS.has(weakness.kind))
      counts.set(weakness.kind, (counts.get(weakness.kind) ?? 0) + weakness.evidence.reduce((sum, entry) => sum + entry.count, 0));
    const ledger = collectLedgerEntries(sourceProject);
    for (const entry of ledger) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    projectRows.push({ project_id: projectId, structural_features: counts.size });
    for (const [feature, count] of counts) features.push({ project_id: projectId, source: STRUCTURAL_KINDS.has(feature) ? "session" : "ledger", feature, count });
  }
  const observations = { version: 1, derivation: "Numeric structural counts only; mined scenarios use deterministic synthetic stress heuristics, not estimated project noise.",
    projects: projectRows, features: features.sort((a, b) => `${a.project_id}:${a.source}:${a.feature}`.localeCompare(`${b.project_id}:${b.source}:${b.feature}`)) };
  const root = path.join(projectDir, ".dream-rsi", "self-improvement");
  const observationsPath = path.join(root, "observations.json");
  writeJsonAtomic(observationsPath, observations);
  let scenarioConfig;
  let scenarioPath;
  if ((options.target ?? "measure") === "measure") {
    const base = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "eval", "scenarios.json"), "utf8"));
    scenarioConfig = buildMinedScenarios(base, observations);
    scenarioPath = path.join(root, "eval", "scenarios.json");
    writeJsonAtomic(scenarioPath, scenarioConfig);
  }
  const setup = setupSelfCampaign(projectDir, PACKAGE_ROOT, {
    target: options.target ?? "measure", tier2Budget: options.tier2Budget, tier2Model: options.tier2Model, tier2Baseline: options.tier2Baseline, scenarioConfig,
  });
  return { ...setup, observationsPath, scenarioPath, scenarioCount: scenarioConfig?.scenarios.length ?? 0,
    derivedScenarioCount: scenarioConfig ? scenarioConfig.scenarios.length - JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "eval", "scenarios.json"), "utf8")).scenarios.length : 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await prepareSelfImprovement(parseArguments(process.argv.slice(2)));
    console.log(result.intakePath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
