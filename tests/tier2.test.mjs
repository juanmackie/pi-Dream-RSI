import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadFixtures, parseArgs, reserveAgentBudget, runTier2, selectFixtures, summarizeRates } from "../eval/tier2.mjs";
import { hashPrompts, scorePromptCandidate, validatePromptScoreConfig } from "../eval/prompt-score.mjs";
import { jump } from "./fixtures.mjs";

test("Tier2 defaults to an inert run and requires explicit model and retained output for real runs", () => {
  assert.equal(parseArgs([]).run, false);
  assert.throws(() => parseArgs(["--run"]), /require --model/);
  assert.throws(() => parseArgs(["--run", "--model=x", "--agent-budget=2", "--evaluator-budget=5"]), /--output/);
  assert.throws(() => parseArgs(["--run", "--model=x", "--agent-budget=2", "--evaluator-budget=5", "--output=out", "--global-agent-budget=3"]), /must be supplied together/);
  assert.throws(() => parseArgs(["--run", "--model=x", "--agent-budget=2", "--evaluator-budget=2", "--output=out"]), /including two independent ground-truth runs/);
  assert.deepEqual(parseArgs(["--fixtures=node-index,python-csv"]).fixtures, ["node-index", "python-csv"]);
  assert.throws(() => parseArgs(["--fixtures=node-index,,python-csv"]), /unique fixture names/);
});

test("fixture filter validates all requested names before campaign setup", () => {
  const fixtures = [{ name: "node-index" }, { name: "python-csv" }, { name: "query-parser" }];
  assert.deepEqual(selectFixtures(fixtures, ["python-csv", "node-index"]), [fixtures[1], fixtures[0]]);
  assert.throws(() => selectFixtures(fixtures, ["node-index", "missing"]), /unknown fixture name/);
});

test("Tier2 validates copy_exclude as workspace-relative paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-copy-exclude-validation-"));
  try {
    fs.cpSync(path.resolve("eval/fixtures/node-index"), path.join(root, "sample"), { recursive: true });
    const manifestPath = path.join(root, "sample", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.copy_exclude = ["../outside"];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => loadFixtures(root), /workspace-relative paths/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("global Tier2 budget remains cumulative and refuses exhausted or changed limits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-tier2-budget-"));
  try {
    const file = path.join(root, "counter.json");
    assert.equal(reserveAgentBudget(file, 2).spent, 1);
    assert.equal(reserveAgentBudget(file, 2).spent, 2);
    assert.throws(() => reserveAgentBudget(file, 2), /exhausted/);
    assert.throws(() => reserveAgentBudget(file, 3), /immutable limit/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Tier2 charges the global budget only from the pre-spawn callback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-tier2-hook-"));
  try {
    const packageRoot = path.join(root, "candidate");
    const engineDir = path.join(packageRoot, "extensions", "pi-dream-rsi", "engine");
    fs.mkdirSync(engineDir, { recursive: true });
    fs.cpSync(path.resolve("prompts"), path.join(packageRoot, "prompts"), { recursive: true });
    const module = path.join(engineDir, "campaign.ts");
    fs.writeFileSync(module, `export async function runCampaign(options) {
 options.resolveAgent({ command: "unused", args: [] });
 if (process.env.TEST_CALL_PRESPAWN === "1") options.beforeAgentSpawn("live:test");
 return { campaignRoot: options.baseRoot, evaluatorRuns: 1, state: { kind: "complete" }, currentScore: 0, copyExclude: options.task.copy_exclude };
}\n`);
    const fixtureRoot = path.resolve("eval/fixtures");
    const makeOptions = (output, budgetFile, fixtures = ["node-index"]) => ({ run: true, model: "offline/no-spawn", agentBudget: 4, evaluatorBudget: 6,
      globalAgentBudget: 2, budgetFile, output, packageRoot, fixtureRoot, fixtures, maxCycles: 1, minimumGain: 0 });
    const noSpawnBudget = path.join(root, "no-spawn.json");
    const noSpawnSummary = await runTier2(makeOptions(path.join(root, "no-spawn-output"), noSpawnBudget));
    assert.equal(fs.existsSync(noSpawnBudget), false, "resolving agent config does not charge budget");
    assert.deepEqual(noSpawnSummary.campaigns[0].result.copyExclude, []);
    const spawnBudget = path.join(root, "spawn.json");
    process.env.TEST_CALL_PRESPAWN = "1";
    try { await runTier2(makeOptions(path.join(root, "spawn-output"), spawnBudget)); }
    finally { delete process.env.TEST_CALL_PRESPAWN; }
    assert.equal(JSON.parse(fs.readFileSync(spawnBudget, "utf8")).spent, 1);
    const pythonSummary = await runTier2(makeOptions(path.join(root, "python-output"), path.join(root, "python-budget.json"), ["python-csv"]));
    assert.deepEqual(pythonSummary.campaigns[0].result.copyExclude, ["__pycache__"]);
  } finally { delete process.env.TEST_CALL_PRESPAWN; fs.rmSync(root, { recursive: true, force: true }); }
});

test("Python bytecode exclusion allows scoped source patches but does not admit ordinary out-of-scope files", async () => {
  const fixture = loadFixtures().find(({ name }) => name === "python-csv");
  assert.deepEqual(fixture.manifest.copy_exclude, ["__pycache__"]);
  const { buildCandidatePatch } = await jump("engine/campaign-patch.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-pycache-patch-"));
  try {
    const seed = path.join(root, "seed"); const target = path.join(root, "target"); const candidate = path.join(root, "candidate");
    for (const directory of [seed, target, candidate]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(seed, "row_parser.py"), "def parse_row(): return 1\n");
    fs.copyFileSync(path.join(seed, "row_parser.py"), path.join(target, "row_parser.py"));
    fs.writeFileSync(path.join(candidate, "row_parser.py"), "def parse_row(): return 2\n");
    fs.mkdirSync(path.join(candidate, "__pycache__"));
    fs.writeFileSync(path.join(candidate, "__pycache__", "row_parser.cpython-311.pyc"), Buffer.from([0, 1, 2]));
    const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate,
      scope: fixture.manifest.scope_files, exclude: fixture.manifest.copy_exclude });
    assert.deepEqual(patch.map(({ relative }) => relative), ["row_parser.py"]);
    fs.writeFileSync(path.join(candidate, "generated.py"), "bad = True\n");
    assert.throws(() => buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate,
      scope: fixture.manifest.scope_files, exclude: fixture.manifest.copy_exclude }), /outside declared scope: generated.py/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("prompt score config requires baseline hashes from protected original prompts", () => {
  const baselinePromptHashes = hashPrompts(path.resolve("."));
  const config = { model: "offline/test", total_agent_budget: 10, budget_file: path.join(os.tmpdir(), "budget.json"),
    baseline: { meanWinRate: 0.1, proposalRate: 0.2, editRate: 0.1, timeoutRate: 0 }, baselinePromptHashes, fixtures: ["node-index", "python-csv"] };
  assert.equal(validatePromptScoreConfig(config).model, "offline/test");
  assert.deepEqual(validatePromptScoreConfig(config).fixtures, ["node-index", "python-csv"]);
  assert.deepEqual(validatePromptScoreConfig({ ...config, fixtures: undefined }).fixtures.sort(), ["node-index", "python-csv", "query-parser"]);
  assert.throws(() => validatePromptScoreConfig({ ...config, fixtures: ["node-index", "node-index"] }), /unique names/);
  assert.throws(() => validatePromptScoreConfig({ ...config, fixtures: ["unknown"] }), /unknown fixture/);
  assert.throws(() => validatePromptScoreConfig({ ...config, baselinePromptHashes: {} }), /hashes do not match/);
  assert.throws(() => validatePromptScoreConfig({ ...config, total_agent_budget: 0 }), /positive total_agent_budget/);
});

test("prompt candidate scoring hard-fails false applies and regressions in measured rates", () => {
  const baseline = { meanWinRate: 0.1, proposalRate: 0.4, editRate: 0.2, timeoutRate: 0.1 };
  const make = (controller) => ({ campaigns: [{ controller }] });
  assert.equal(scorePromptCandidate(make({ trueWins: 1, falseApplies: 0, agentStarts: 2, proposals: 1, editCount: 1, timeouts: 0 }), baseline, 10).passed, true);
  assert.equal(scorePromptCandidate({ ...make({ trueWins: 2, falseApplies: 0, agentStarts: 2, proposals: 2, editCount: 1, timeouts: 0 }), budgetExhausted: true }, baseline, 10).exhausted, true);
  assert.equal(scorePromptCandidate(make({ trueWins: 2, falseApplies: 1, agentStarts: 2, proposals: 2, editCount: 1, timeouts: 0 }), baseline, 10).passed, false);
  assert.equal(scorePromptCandidate(make({ trueWins: 0, falseApplies: 0, agentStarts: 2, proposals: 0, editCount: 0, timeouts: 1 }), baseline, 10).passed, false);
});

test("Tier2 baseline rates are measured from campaign outcomes and actual attempt telemetry", () => {
  assert.deepEqual(summarizeRates([{ controller: { trueWins: 1, falseApplies: 0, agentStarts: 4, proposals: 2, editCount: 1, timeouts: 1 } }]),
    { meanWinRate: 0.25, proposalRate: 0.5, editRate: 0.25, timeoutRate: 0.25 });
});

test("Tier2 manifests accept future language commands without code changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-tier2-generic-"));
  try {
    fs.cpSync(path.resolve("eval/fixtures/node-index"), path.join(root, "rust-parse"), { recursive: true });
    const manifestPath = path.join(root, "rust-parse", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.evaluator_kind = "timed Rust command";
    manifest.interpreter = "cargo";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const fixtures = loadFixtures(root);
    assert.equal(fixtures[0].manifest.evaluator_kind, "timed Rust command");
    assert.equal(fixtures[0].manifest.interpreter, "cargo");
    manifest.interpreter = "cargo test";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => loadFixtures(root), /bare executable name/);
    manifest.interpreter = "cargo";
    manifest.evaluator_kind = "timed Rust benchmark";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => loadFixtures(root), /command description/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
