#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rankLeverReadiness, readLedgerEntries, scoreControllerCampaign } from "./controller.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, "fixtures");

export function parseArgs(argv) {
  const options = { run: false, list: false, fixtures: null, agentBudget: null, evaluatorBudget: null, globalAgentBudget: null, budgetFile: null, model: null, output: null, packageRoot: null, fixtureRoot: null, maxCycles: 1, minimumGain: 0 };
  for (const arg of argv) {
    if (arg === "--run") options.run = true;
    else if (arg === "--list") options.list = true;
    else {
      const match = /^--([a-z-]+)=(.*)$/.exec(arg);
      if (!match) throw new Error(`unknown argument ${arg}`);
      if (match[1] === "agent-budget") options.agentBudget = Number(match[2]);
      else if (match[1] === "evaluator-budget") options.evaluatorBudget = Number(match[2]);
      else if (match[1] === "model") options.model = match[2];
      else if (match[1] === "output") options.output = match[2];
      else if (match[1] === "global-agent-budget") options.globalAgentBudget = Number(match[2]);
      else if (match[1] === "budget-file") options.budgetFile = match[2];
      else if (match[1] === "package-root") options.packageRoot = match[2];
      else if (match[1] === "fixture-root") options.fixtureRoot = match[2];
      else if (match[1] === "fixtures") {
        options.fixtures = match[2].split(",").map((name) => name.trim());
        if (!options.fixtures.length || options.fixtures.some((name) => !name) || new Set(options.fixtures).size !== options.fixtures.length) throw new Error("fixtures must be a comma-separated list of unique fixture names");
      }
      else if (match[1] === "max-cycles") options.maxCycles = Number(match[2]);
      else if (match[1] === "minimum-gain") options.minimumGain = match[2].includes("%") ? match[2] : Number(match[2]);
      else throw new Error(`unknown option --${match[1]}`);
    }
  }
  if (options.run) {
    if (!options.model) throw new Error("real runs require --model=<provider/model>");
    if (!Number.isSafeInteger(options.agentBudget) || options.agentBudget < 1 || options.agentBudget > 36) throw new Error("real runs require --agent-budget from 1 to 36 per fixture");
    if (!Number.isSafeInteger(options.evaluatorBudget) || options.evaluatorBudget < 3 || options.evaluatorBudget > 100) throw new Error("real runs require --evaluator-budget from 3 to 100 per fixture (including two independent ground-truth runs)");
    if (!options.output) throw new Error("real runs require --output=<new-directory> to retain results");
    if ((options.globalAgentBudget === null) !== (options.budgetFile === null)) throw new Error("global-agent-budget and budget-file must be supplied together");
    if (options.globalAgentBudget !== null && (!Number.isSafeInteger(options.globalAgentBudget) || options.globalAgentBudget < 1)) throw new Error("global-agent-budget must be a positive integer");
    if (!Number.isSafeInteger(options.maxCycles) || options.maxCycles < 1 || options.maxCycles > 5) throw new Error("max-cycles must be from 1 to 5");
    if (typeof options.minimumGain === "number" && (!Number.isFinite(options.minimumGain) || options.minimumGain < 0)) throw new Error("minimum-gain must be non-negative");
    if (typeof options.minimumGain === "string" && !/^\d+(?:\.\d+)?%$/.test(options.minimumGain)) throw new Error("minimum-gain percentage must look like 3%");
  }
  return options;
}

export function loadFixtures(fixtureRoot = FIXTURE_ROOT) {
  fixtureRoot = path.resolve(fixtureRoot);
  return fs.readdirSync(fixtureRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const root = path.join(fixtureRoot, entry.name);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    validateManifest(manifest, entry.name, fixtureRoot);
    return { name: entry.name, root, manifest };
  });
}

function validateManifest(value, name, fixtureRoot = FIXTURE_ROOT) {
  const required = ["goal", "metric", "direction", "workspace", "scope_files", "candidate_program", "evaluator", "gate", "evaluator_kind", "interpreter", "readiness", "baseline_gate_passes", "verifier_inputs", "control_patch", "levers"];
  for (const key of required) if (!(key in value)) throw new Error(`${name} manifest is missing ${key}`);
  if (!value.goal.trim() || !value.metric.trim() || !["maximize", "minimize"].includes(value.direction)) throw new Error(`${name} manifest has invalid goal, metric, or direction`);
  if (!Array.isArray(value.scope_files) || !value.scope_files.length || value.scope_files.some((item) => typeof item !== "string")) throw new Error(`${name} scope_files must be non-empty strings`);
  if (value.copy_exclude !== undefined && (!Array.isArray(value.copy_exclude) || value.copy_exclude.some((item) => !isWorkspaceRelativePath(item)))) {
    throw new Error(`${name} copy_exclude must contain only workspace-relative paths`);
  }
  if (typeof value.evaluator_kind !== "string" || !value.evaluator_kind.trim() || value.evaluator_kind.length > 100
    || !value.evaluator_kind.trim().toLowerCase().endsWith("command")) throw new Error(`${name} evaluator_kind must be a command description such as "deterministic command"`);
  if (typeof value.interpreter !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.interpreter)) throw new Error(`${name} interpreter must be a bare executable name such as node or python`);
  if (value.readiness !== "ready") throw new Error(`${name} fixture is not ready: ${value.readiness}`);
  if (typeof value.baseline_gate_passes !== "boolean") throw new Error(`${name} baseline_gate_passes must be boolean`);
  rankLeverReadiness(value.levers);
  for (const file of [value.workspace, value.evaluator, value.gate, value.control_patch, ...value.verifier_inputs]) {
    const resolved = path.resolve(path.join(fixtureRoot, name), file);
    if (!resolved.startsWith(`${path.resolve(path.join(fixtureRoot, name))}${path.sep}`) || !fs.existsSync(resolved)) throw new Error(`${name} fixture path is missing or escapes fixture root: ${file}`);
  }
}

function isWorkspaceRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !/^[a-zA-Z]:/.test(normalized) && !normalized.split("/").some((segment) => segment === ".." || segment === "." || segment === "");
}

export function listFixtures(fixtureRoot = FIXTURE_ROOT) {
  const fixtures = loadFixtures(fixtureRoot);
  return { fixtures: fixtures.map(({ name, manifest }) => ({ name, goal: manifest.goal, metric: manifest.metric, direction: manifest.direction, readiness: manifest.readiness })), top3: rankLeverReadiness(fixtures.flatMap(({ manifest }) => manifest.levers)) };
}

function quoteArg(value) {
  return process.platform === "win32" ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'"'"'`)}'`;
}

function evaluatorCommand(manifest, script) {
  const interpreter = manifest.interpreter === "node" ? "node"
    : manifest.interpreter === "python" ? (process.platform === "win32" ? "python" : "python3")
    : manifest.interpreter;
  return `${interpreter} ${quoteArg(script)}`;
}

export async function runTier2(options) {
  const fixtureRoot = path.resolve(options.fixtureRoot ?? FIXTURE_ROOT);
  const allFixtures = loadFixtures(fixtureRoot);
  const fixtures = selectFixtures(allFixtures, options.fixtures);
  const outputRoot = path.resolve(options.output);
  if (fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length > 0) throw new Error(`output directory must be new or empty: ${outputRoot}`);
  fs.mkdirSync(outputRoot, { recursive: true });
  const campaigns = [];
  let budgetExhausted = false;
  const fixtureTreeHash = hashFixtureTree(fixtureRoot);
  const packageRoot = path.resolve(options.packageRoot ?? path.join(HERE, ".."));
  const { runCampaign } = await import(pathToFileURL(path.join(packageRoot, "extensions", "pi-dream-rsi", "engine", "campaign.ts")).href);
  if (options.globalAgentBudget !== undefined && options.globalAgentBudget !== null && !options.budgetFile) throw new Error("a durable budgetFile is required with globalAgentBudget");
  for (const { name, root, manifest } of fixtures) {
    const projectDir = path.join(outputRoot, name);
    fs.cpSync(root, projectDir, { recursive: true });
    const workspace = path.join(projectDir, manifest.workspace);
    const baselineWorkspace = path.join(projectDir, ".ground-truth-original");
    fs.cpSync(workspace, baselineWorkspace, { recursive: true });
    const baselineHashBefore = hashWorkspace(baselineWorkspace, manifest.scope_files);
    const evaluator = path.join(projectDir, manifest.evaluator);
    const gate = path.join(projectDir, manifest.gate);
    const controlPatch = path.join(projectDir, manifest.control_patch);
    const verifierFiles = [evaluator, gate, controlPatch, ...manifest.verifier_inputs.map((file) => path.join(projectDir, file))];
    const verifierHashes = verifierFiles.map((file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    const scoreProgram = evaluatorCommand(manifest, evaluator);
    const task = {
      name: manifest.name,
      workspace: manifest.workspace,
      eval_program: manifest.candidate_program,
      score_program: scoreProgram,
      score_path: "eval/score.json",
      score_field: "score",
      valid_field: "valid",
      fail_class_field: "fail_class",
      error_field: "error",
      copy_exclude: manifest.copy_exclude ?? [],
      higher_is_better: manifest.direction === "maximize",
      evaluator_timeout_ms: 300_000,
      agent_timeout_ms: 8 * 60_000,
      agent: {
        command: "pi",
        args: ["-p", "--no-session", "-na", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"],
        model: options.model,
        thinking: "minimal",
        prompt_via: "stdin",
        output_format: "auto",
      },
    };
    let observedAgentStarts = 0;
    const result = await runCampaign({
      baseRoot: path.join(projectDir, ".dream-rsi"),
      projectDir,
      task,
      goal: manifest.goal,
      scope: manifest.scope_files,
      verifierInputs: manifest.verifier_inputs.map((file) => path.join(projectDir, file)),
      gates: [evaluatorCommand(manifest, gate)],
      minimumGain: options.minimumGain,
      controlPatch,
      limits: { maxCycles: options.maxCycles, maxAgentStarts: options.agentBudget, maxEvaluatorRuns: options.evaluatorBudget - 2, deadlineMs: 60 * 60_000, plateauCycles: 2 },
      beforeAgentSpawn: () => {
        if (options.globalAgentBudget != null) {
          try { reserveAgentBudget(options.budgetFile, options.globalAgentBudget); }
          catch (error) { if (/budget exhausted/.test(String(error))) budgetExhausted = true; throw error; }
        }
        observedAgentStarts += 1;
      },
      resolveAgent: (saved) => ({ ...saved, model: options.model, thinking: "minimal" }),
    });
    const groundTruth = await measureTier2Outcome({ workspace, baselineWorkspace, projectDir, manifest,
      hashesStable: hashWorkspace(baselineWorkspace, manifest.scope_files) === baselineHashBefore &&
        verifierFiles.every((file, index) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === verifierHashes[index]) });
    const attempts = readLedgerEntries(result.campaignRoot).filter((entry) => entry.kind === "attempt");
    const controller = scoreControllerCampaign(groundTruth, Array.from({ length: observedAgentStarts }, () => ({ kind: "agent", role: "live" })));
    controller.proposals = attempts.filter((entry) => typeof entry.title === "string" && entry.title.length > 0).length;
    controller.editCount = attempts.filter((entry) => Number.isSafeInteger(entry.editCount) && entry.editCount > 0).length;
    controller.timeouts = attempts.filter((entry) => entry.facts?.timedOut === true).length;
    const campaignEvaluatorRuns = Number.isSafeInteger(result.evaluatorRuns) ? result.evaluatorRuns : 0;
    campaigns.push({ fixture: name, goal: manifest.goal, metric: manifest.metric, direction: manifest.direction, result,
      controller, groundTruthEvaluatorRuns: 2, totalEvaluatorRuns: campaignEvaluatorRuns + 2 });
  }
  const rates = summarizeRates(campaigns);
  const promptHashes = hashPromptFiles(packageRoot);
  const summary = {
    version: 1,
    model: options.model,
    budgetsPerFixture: { agentStarts: options.agentBudget, totalEvaluatorRuns: options.evaluatorBudget,
      campaignEvaluatorRuns: options.evaluatorBudget - 2, groundTruthEvaluatorRuns: 2 },
    selectedFixtures: fixtures.map(({ name }) => name),
    globalAgentBudget: options.globalAgentBudget ?? null,
    durableBudgetFile: options.budgetFile ? path.resolve(options.budgetFile) : null,
    budgetExhausted: budgetExhausted || budgetReachedLimit(options.budgetFile, options.globalAgentBudget),
    inputIntegrity: hashFixtureTree(fixtureRoot) === fixtureTreeHash,
    fixtureTreeHash,
    promptHashes,
    rates,
    top3LeverReadiness: rankLeverReadiness(allFixtures.flatMap(({ manifest }) => manifest.levers)),
    campaigns,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outputRoot, "tier2-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export function selectFixtures(fixtures, names) {
  if (!names) return fixtures;
  const available = new Set(fixtures.map(({ name }) => name));
  const unknown = names.filter((name) => !available.has(name));
  if (unknown.length) throw new Error(`unknown fixture name(s): ${unknown.join(", ")}`);
  return names.map((name) => fixtures.find((fixture) => fixture.name === name));
}

export function summarizeRates(campaigns) {
  const totals = campaigns.reduce((sum, item) => {
    for (const key of ["trueWins", "falseApplies", "agentStarts", "proposals", "editCount", "timeouts"]) sum[key] += Number(item.controller?.[key] ?? 0);
    return sum;
  }, { trueWins: 0, falseApplies: 0, agentStarts: 0, proposals: 0, editCount: 0, timeouts: 0 });
  const denom = Math.max(1, totals.agentStarts);
  return { meanWinRate: totals.trueWins / denom, proposalRate: totals.proposals / denom,
    editRate: totals.editCount / denom, timeoutRate: totals.timeouts / denom };
}

function hashPromptFiles(packageRoot) {
  const files = ["discovery-agent.md", "policy-improvement.md", "adversarial-review.md"];
  return Object.fromEntries(files.map((name) => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(packageRoot, "prompts", name))).digest("hex")]));
}

export function hashFixtureTree(root) {
  const hash = crypto.createHash("sha256");
  const visit = (directory, relative = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(relative, entry.name);
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full, rel);
      else if (entry.isFile()) hash.update(rel).update("\0").update(fs.readFileSync(full));
    }
  };
  visit(root);
  return hash.digest("hex");
}

function budgetReachedLimit(file, limit) {
  if (!file || limit == null || !fs.existsSync(file)) return false;
  try { return JSON.parse(fs.readFileSync(file, "utf8")).spent >= limit; } catch { return true; }
}

export function reserveAgentBudget(budgetFile, limit) {
  const file = path.resolve(budgetFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let lockHandle;
  try { lockHandle = fs.openSync(lock, "wx"); }
  catch (error) { if (error?.code === "EEXIST") throw new Error("global agent budget counter is already in use"); throw error; }
  try {
    let state = { version: 1, limit, spent: 0 };
    if (fs.existsSync(file)) {
      try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("global agent budget file is corrupt; refusing to reset it"); }
      if (state.version !== 1 || state.limit !== limit || !Number.isSafeInteger(state.spent) || state.spent < 0) throw new Error("global agent budget file does not match configured immutable limit");
    }
    if (state.spent >= limit) throw new Error("global agent budget exhausted");
    state.spent += 1;
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temp, file);
    return state;
  } finally { fs.closeSync(lockHandle); fs.rmSync(lock, { force: true }); }
}

async function measureTier2Outcome({ workspace, baselineWorkspace, projectDir, manifest, hashesStable }) {
  const finalWorkspace = path.join(projectDir, ".ground-truth-final");
  fs.cpSync(workspace, finalWorkspace, { recursive: true });
  const baseline = await runGroundTruth(manifest, baselineWorkspace);
  const current = await runGroundTruth(manifest, finalWorkspace);
  return {
    scenario: "truewin",
    baseline: hashWorkspace(baselineWorkspace, manifest.scope_files),
    final: hashWorkspace(finalWorkspace, manifest.scope_files),
    higherIsBetter: manifest.direction === "maximize",
    baselineValid: baseline.valid,
    finalValid: current.valid,
    measuredGain: baseline.valid && current.valid ? manifest.direction === "maximize" ? current.score - baseline.score : baseline.score - current.score : null,
    gatePassed: current.gatePassed,
    hashesStable,
  };
}

async function runGroundTruth(manifest, cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  const interpreter = manifest.interpreter === "node" ? process.execPath
    : manifest.interpreter === "python" ? (process.platform === "win32" ? "python" : "python3")
    : manifest.interpreter;
  const run = (script) => new Promise((resolve) => {
    const child = spawn(interpreter, [path.resolve(cwd, "..", script)], { cwd, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false }); }, 30_000);
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0 }); });
  });
  const evaluated = await run(manifest.evaluator);
  let score = null; let valid = false;
  try { const data = JSON.parse(fs.readFileSync(path.join(cwd, "eval", "score.json"), "utf8")); score = data.score; valid = evaluated.ok && data.valid === true && Number.isFinite(score); } catch {}
  const gate = await run(manifest.gate);
  return { score, valid, gatePassed: gate.ok };
}

function hashWorkspace(workspace, files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(fs.readFileSync(path.join(workspace, file)));
  return hash.digest("hex");
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.list) { process.stdout.write(`${JSON.stringify(listFixtures(), null, 2)}\n`); return; }
  if (!options.run) {
    process.stdout.write("Tier2 is opt-in and made no model calls. Use --list to inspect fixtures. For a real run, pass --run, --model, per-fixture agent/evaluator budgets, and an output directory.\n");
    return;
  }
  const result = await runTier2(options);
  process.stdout.write(`${JSON.stringify({ output: path.resolve(options.output), model: result.model, campaigns: result.campaigns.map(({ fixture, controller }) => ({ fixture, ...controller })) }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
