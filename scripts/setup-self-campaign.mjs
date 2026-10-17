#!/usr/bin/env node
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { countCodeTokens } from "../eval/purity.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGE_MARKER = "prompts/discovery-agent.md";
const PROBLEM = "PROBLEM.md";
const POLICY_GATE = `import { readPolicyViolations } from "../extensions/pi-dream-rsi/policy/runner.ts";\n\nconst target = process.argv[2] ?? "policy/method.ts";\nconst violations = readPolicyViolations(target);\nif (violations.length > 0) {\n  console.error(violations.join("\\n"));\n  process.exitCode = 1;\n} else {\n  console.log("policy contract passed");\n}\n`;
const GENERATED = new Map([
  ["package.json", `${JSON.stringify({ name: "dream-rsi-self-verifier", private: true, type: "module" }, null, 2)}\n`],
  [".auto/policy-gate.mjs", POLICY_GATE],
]);
const STATIC_SPECIFIER = /\b(?:import|export)\s+(?:[^"'()]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function moduleFiles(root, entries) {
  const found = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const relative = pending.pop().replaceAll("\\", "/");
    if (found.has(relative)) continue;
    const absolute = path.resolve(root, relative);
    const rel = path.relative(root, absolute);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`verifier import escapes package root: ${relative}`);
    }
    const source = GENERATED.has(relative)
      ? GENERATED.get(relative)
      : fs.readFileSync(absolute, "utf8");
    found.add(relative);
    if (!/\.[cm]?[jt]sx?$/.test(relative)) continue;
    for (const match of source.matchAll(STATIC_SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(absolute), specifier);
      const targetRelative = path.relative(root, target);
      if (targetRelative === ".." || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) {
        throw new Error(`verifier import escapes package root: ${relative} -> ${specifier}`);
      }
      if (!fs.existsSync(target)) throw new Error(`verifier import is missing: ${relative} -> ${specifier}`);
      if (fs.statSync(target).isFile()) pending.push(targetRelative.replaceAll("\\", "/"));
    }
  }
  return found;
}

function verifierInputs(root) {
  const files = moduleFiles(root, [
    ".auto/score.mjs",
    "extensions/pi-dream-rsi/worker/policy-worker.ts", // worker path is constructed with new URL at runtime
    "extensions/pi-dream-rsi/policy/api.ts", // copied by ensurePolicyRuntime using a filename list
    "extensions/pi-dream-rsi/policy/observation-signal.ts", // copied by ensurePolicyRuntime using a filename list
    ".auto/policy-gate.mjs",
  ]);
  for (const required of [PACKAGE_MARKER, PROBLEM]) {
    if (!fs.existsSync(path.join(root, required))) throw new Error(`required protected input is missing: ${required}`);
    files.add(required);
  }
  for (const [relative, content] of GENERATED) {
    if (!files.has(relative)) files.add(relative);
    // The manifest hashes generated content without writing it into the source repository.
    if (typeof content !== "string") throw new Error(`invalid generated input: ${relative}`);
  }
  return [...files].sort().map((relative) => {
    const bytes = GENERATED.has(relative)
      ? Buffer.from(GENERATED.get(relative), "utf8")
      : fs.readFileSync(path.join(root, ...relative.split("/")));
    return { relative, bytes, sha256: sha256(bytes) };
  });
}

function snapshotHash(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.relative, "utf8");
    hash.update("\0");
    hash.update(String(file.bytes.length), "utf8");
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function verifyExisting(destination, files, expectedHash) {
  const manifestPath = path.join(destination, "snapshot.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.hash !== expectedHash) throw new Error(`snapshot hash mismatch at ${destination}`);
  const expected = new Map(files.map(({ relative, sha256: digest }) => [relative, digest]));
  const recorded = new Map(manifest.files.map(({ path: relative, sha256: digest }) => [relative, digest]));
  if (expected.size !== recorded.size || [...expected].some(([relative, digest]) => recorded.get(relative) !== digest)) {
    throw new Error(`snapshot file list mismatch at ${destination}`);
  }
  for (const [relative, digest] of expected) {
    const file = path.join(destination, ...relative.split("/"));
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== digest) {
      throw new Error(`existing verifier snapshot was changed and will not be overwritten: ${file}`);
    }
  }
}

function writeSnapshot(destination, files, hash) {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.staging-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(staging);
  try {
    for (const { relative, bytes } of files) {
      const target = path.join(staging, ...relative.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: "wx" });
    }
    const manifest = {
      version: 1,
      hash,
      files: files.map(({ relative, sha256: digest }) => ({ path: relative, sha256: digest })),
    };
    fs.writeFileSync(path.join(staging, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(staging, destination);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function quoted(value) {
  if (process.platform === "win32") {
    if (/["%\r\n]/.test(value)) throw new Error("verifier paths containing quotes, percent signs or newlines cannot be passed safely through the Windows command shell");
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function setupSelfCampaign(projectDir = PACKAGE_ROOT, sourceRoot = PACKAGE_ROOT, options = {}) {
  if (typeof options === "string") options = { target: options };
  const target = options.target ?? "measure";
  if (!["measure", "policy", "controller", "prompts"].includes(target)) throw new Error(`unsupported self-campaign target: ${target}`);
  if (target === "prompts" && (!Number.isSafeInteger(options.tier2Budget) || options.tier2Budget < 1 || typeof options.tier2Model !== "string" || !options.tier2Model.trim() || typeof options.tier2Baseline !== "string")) {
    throw new Error("prompts target requires --tier2-budget, --tier2-model and --tier2-baseline from an explicit real-model evaluation");
  }
  const canonicalProject = fs.realpathSync(projectDir);
  const canonicalSource = fs.realpathSync(sourceRoot);
  for (const key of [".auto/controller-config.json", ".auto/prompts-config.json"]) GENERATED.delete(key);
  if (target === "controller") {
    const relative = "extensions/pi-dream-rsi/engine/campaign.ts";
    GENERATED.set(".auto/controller-config.json", `${JSON.stringify({ candidate_path: relative, baseline_sha256: sha256(fs.readFileSync(path.join(canonicalSource, relative))) })}\n`);
  }
  if (target === "prompts") {
    const report = JSON.parse(fs.readFileSync(path.resolve(options.tier2Baseline), "utf8"));
    if (report.model !== options.tier2Model || !report.promptHashes || !report.rates) throw new Error("Tier2 baseline must contain its model, promptHashes, and measured rates");
    for (const name of ["discovery-agent.md", "policy-improvement.md", "adversarial-review.md"]) {
      if (report.promptHashes[name] !== sha256(fs.readFileSync(path.join(canonicalProject, "prompts", name)))) throw new Error(`Tier2 baseline does not describe the current prompt: ${name}`);
    }
    for (const key of ["meanWinRate", "proposalRate", "editRate", "timeoutRate"]) if (!Number.isFinite(report.rates[key]) || report.rates[key] < 0 || report.rates[key] > 1) throw new Error(`Tier2 baseline has an invalid ${key}`);
    const availableFixtures = fs.readdirSync(path.join(canonicalSource, "eval", "fixtures"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const selectedFixtures = report.selectedFixtures ?? availableFixtures;
    if (!Array.isArray(selectedFixtures) || selectedFixtures.length === 0 || selectedFixtures.some((name) => typeof name !== "string" || !name.trim()) || new Set(selectedFixtures).size !== selectedFixtures.length) {
      throw new Error("Tier2 baseline selectedFixtures must be a non-empty list of unique fixture names");
    }
    const unknownFixtures = selectedFixtures.filter((name) => !availableFixtures.includes(name));
    if (unknownFixtures.length) throw new Error(`Tier2 baseline names unknown fixture(s): ${unknownFixtures.join(", ")}`);
    GENERATED.set(".auto/prompts-config.json", `${JSON.stringify({ model: options.tier2Model, total_agent_budget: options.tier2Budget,
      budget_file: path.join(canonicalProject, ".dream-rsi", "self-improvement", "prompt-budget.json"), baseline: report.rates,
      baselinePromptHashes: report.promptHashes, fixtureRoot: "eval/fixtures", fixtures: selectedFixtures })}\n`);
  }
  if (target === "measure") {
    const baselinePath = path.join(canonicalSource, "extensions", "pi-dream-rsi", "engine", "measure.ts");
    const baseline = fs.readFileSync(baselinePath);
    const typeScriptPath = createRequire(path.join(canonicalSource, "package.json")).resolve("typescript");
    const puritySource = fs.readFileSync(path.join(canonicalSource, "eval", "purity.mjs"), "utf8");
    const rewrittenPurity = puritySource.replace('import ts from "typescript";', `import ts from ${JSON.stringify(pathToFileURL(typeScriptPath).href)};`);
    if (rewrittenPurity === puritySource) throw new Error("purity verifier no longer has its expected TypeScript parser import");
    GENERATED.set("eval/purity.mjs", rewrittenPurity);
    GENERATED.set(".auto/measure-config.json", `${JSON.stringify({ version: 1,
      baseline_sha256: sha256(baseline), baseline_tokens: countCodeTokens(baseline.toString("utf8")),
      candidate_path: "extensions/pi-dream-rsi/engine/measure.ts", alpha: 0.01,
      heldout_tolerance: 0.005, bloat_penalty: 0.01, bloat_token_unit: 50,
    }, null, 2)}\n`);
  } else {
    GENERATED.delete(".auto/measure-config.json");
    GENERATED.delete("eval/purity.mjs");
  }
  const files = verifierInputs(canonicalSource);
  let testGate;
  if (fs.existsSync(path.join(canonicalSource, "tests"))) {
    const kit = [];
    const capture = (relative) => {
      const absolute = path.join(canonicalSource, relative);
      if (!fs.existsSync(absolute)) return;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) for (const entry of fs.readdirSync(absolute)) capture(`${relative}/${entry}`);
      else if (stat.isFile() && /\.(?:[cm]?[jt]sx?|json|md|py|sh|patch)$/.test(relative)) {
        const bytes = fs.readFileSync(absolute);
        kit.push(relative);
        files.push({ relative: `test-kit/${relative}`, bytes, sha256: sha256(bytes) });
      }
    };
    for (const relative of ["tests", "scripts", "eval", "adapter", ".auto", "package.json", "package-lock.json", "tsconfig.json"]) capture(relative);
    const script = `import fs from "node:fs"; import path from "node:path"; import {fileURLToPath} from "node:url"; import {spawnSync} from "node:child_process";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const workspace=fs.realpathSync(process.cwd());
for(const relative of ${JSON.stringify(kit)}) { const destination=path.resolve(workspace,relative); if(!destination.startsWith(workspace+path.sep))throw new Error("test kit path escapes gate workspace"); fs.mkdirSync(path.dirname(destination),{recursive:true}); fs.copyFileSync(path.join(root,"test-kit",relative),destination); }
const result=spawnSync("npm",["test"],{cwd:workspace,stdio:"inherit",shell:process.platform==="win32",windowsHide:true});
if(result.error)throw result.error;process.exitCode=result.status??1;
`;
    const bytes = Buffer.from(script);
    files.push({ relative: ".auto/test-gate.mjs", bytes, sha256: sha256(bytes) });
    testGate = ".auto/test-gate.mjs";
  }
  if (target === "controller" || target === "prompts") {
    const entries = target === "controller" ? ["eval/self-controller.mjs", "eval/controller.mjs", "docs/controller-problem.md", "extensions/pi-dream-rsi/engine/campaign.ts"]
      : ["eval/prompt-score.mjs", "eval/tier2.mjs", "eval/controller.mjs", "prompts/discovery-agent.md", "prompts/policy-improvement.md", "prompts/adversarial-review.md"];
    const extras = moduleFiles(canonicalSource, entries);
    const fixtureFiles = (dir) => fs.readdirSync(path.join(canonicalSource, dir), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? fixtureFiles(`${dir}/${entry.name}`) : entry.isFile() ? [`${dir}/${entry.name}`] : []);
    if (target === "prompts") for (const file of fixtureFiles("eval/fixtures")) extras.add(file);
    for (const relative of extras) if (!files.some((file) => file.relative === relative)) {
      const bytes = fs.readFileSync(path.join(canonicalSource, relative));
      files.push({ relative, bytes, sha256: sha256(bytes) });
    }
    files.sort((a, b) => a.relative.localeCompare(b.relative));
  }
  if (target === "measure") {
    for (const relative of ["eval/self-score.mjs", "eval/purity.mjs", "eval/bench.mjs", "eval/scenarios.json", "docs/measure-problem.md", "extensions/pi-dream-rsi/engine/measure.ts", ".auto/measure-config.json"]) {
      if (!fs.existsSync(path.join(canonicalSource, ...relative.split("/"))) && !GENERATED.has(relative)) throw new Error(`required measure verifier input is missing: ${relative}`);
      files.push({ relative, bytes: GENERATED.has(relative) ? Buffer.from(GENERATED.get(relative), "utf8") : fs.readFileSync(path.join(canonicalSource, ...relative.split("/"))),
        sha256: sha256(GENERATED.has(relative) ? Buffer.from(GENERATED.get(relative), "utf8") : fs.readFileSync(path.join(canonicalSource, ...relative.split("/")))) });
    }
    const unique = new Map(files.map((file) => [file.relative, file]));
    files.splice(0, files.length, ...[...unique.values()].sort((a, b) => a.relative.localeCompare(b.relative)));
    if (options.scenarioConfig !== undefined) {
      const scenarios = Buffer.from(`${JSON.stringify(options.scenarioConfig, null, 2)}\n`, "utf8");
      const scenarioFile = files.find((file) => file.relative === "eval/scenarios.json");
      if (!scenarioFile) throw new Error("measure scenario verifier input is missing");
      scenarioFile.bytes = scenarios;
      scenarioFile.sha256 = sha256(scenarios);
    }
  }
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const hash = snapshotHash(files);
  const verifierRoot = path.join(canonicalProject, ".dream-rsi", "verifier", hash);
  if (fs.existsSync(verifierRoot)) verifyExisting(verifierRoot, files, hash);
  else writeSnapshot(verifierRoot, files, hash);

  const baseRoot = path.join(canonicalProject, ".dream-rsi");
  const scorer = path.join(verifierRoot, target === "measure" ? "eval/self-score.mjs" : target === "controller" ? "eval/self-controller.mjs" : target === "prompts" ? "eval/prompt-score.mjs" : ".auto/score.mjs");
  const gate = path.join(verifierRoot, ".auto", "policy-gate.mjs");
  const snapshotFiles = files.map(({ relative }) => path.join(verifierRoot, ...relative.split("/")));
  const correctnessGate = testGate ? `node ${quoted(path.join(verifierRoot, testGate))}` : "npm test";
  const candidatePath = target === "measure" ? "extensions/pi-dream-rsi/engine/measure.ts"
    : target === "controller" ? "extensions/pi-dream-rsi/engine/campaign.ts" : target === "prompts" ? "prompts/discovery-agent.md" : "extensions/pi-dream-rsi/policy/method.ts";
  const intake = {
    action: "start",
    goal: target === "measure" ? "Improve statistical measurement and confirmation decisions while preserving validity and false-accept controls."
      : target === "controller" ? "Improve campaign selection and budget control against the candidate-backed campaign scenarios."
        : target === "prompts" ? "Improve agent proposal, edit, timeout and verified-win rates across protected real-model fixture repositories."
        : "Improve exploration-policy replay score while preserving determinism and the policy contract.",
    project_dir: canonicalProject,
    task: {
      name: target === "measure" ? "Dream-RSI measurement decisions" : target === "controller" ? "Dream-RSI campaign controller" : "Dream-RSI exploration policy",
      workspace: ".",
      eval_program: candidatePath,
      score_program: target === "policy" ? `node ${quoted(scorer)} --benchmark-version=2` : `node ${quoted(scorer)}`,
      higher_is_better: true,
      problem_file: target === "measure" ? path.relative(canonicalProject, path.join(verifierRoot, "docs/measure-problem.md")) : target === "controller" ? path.relative(canonicalProject, path.join(verifierRoot, "docs/controller-problem.md")) : path.relative(canonicalProject, path.join(verifierRoot, PROBLEM)),
      evaluator_timeout_ms: target === "policy" ? 300_000 : 600_000,
      agent_timeout_ms: 300_000,
      copy_exclude: ["node_modules"],
    },
    scope: target === "prompts" ? ["prompts/discovery-agent.md", "prompts/policy-improvement.md", "prompts/adversarial-review.md"] : [candidatePath],
    verifier_inputs: [...snapshotFiles, path.join(verifierRoot, "snapshot.json")],
    gates: target === "measure" ? [`node ${quoted(path.join(verifierRoot, "eval/purity.mjs"))} ${candidatePath}`, correctnessGate]
      : target === "policy" ? [`node ${quoted(gate)} ${candidatePath}`, correctnessGate] : ["npm run typecheck", correctnessGate],
    minimum_gain: undefined,
  };
  const intakePath = path.join(baseRoot, `self-campaign-${hash}.json`);
  const serialized = `${JSON.stringify(intake, null, 2)}\n`;
  fs.mkdirSync(baseRoot, { recursive: true });
  if (fs.existsSync(intakePath) && fs.readFileSync(intakePath, "utf8") !== serialized) {
    throw new Error(`existing campaign intake was not changed: ${intakePath}`);
  }
  if (!fs.existsSync(intakePath)) fs.writeFileSync(intakePath, serialized, { flag: "wx" });
  return { hash, verifierRoot, intakePath, intake };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const project = args.find((arg) => !arg.startsWith("--"));
    const options = Object.fromEntries(args.filter((arg) => arg.startsWith("--")).map((arg) => {
      const [key, ...rest] = arg.slice(2).split("=");
      return [key.replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase()), rest.join("=") || true];
    }));
    if (options.tier2Budget) options.tier2Budget = Number(options.tier2Budget);
    const result = setupSelfCampaign(project ? path.resolve(project) : PACKAGE_ROOT, PACKAGE_ROOT, options);
    console.log(JSON.stringify({ snapshot: result.verifierRoot, hash: result.hash, intake: result.intakePath }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
