/**
 * Cold-start discovery.
 *
 * Recon must reach a planted causal bottleneck from the project's own manifests
 * and source, measure it, and attribute the measurement to the code the workload
 * actually imports. Files that merely look busy — unrelated modules, dependency
 * trees, secret-shaped paths, and code outside the approved scope — must not
 * become the suggested patch scope.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { contractIdentity, normalizeRunContract, validateRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";
import {
  buildReconInventory, discoverCommands, importGraph, reconProject, scriptCategory, scriptEntry,
} from "../extensions/pi-dream-rsi/engine/recon.ts";

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-recon-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

function contract(overrides = {}) {
  return normalizeRunContract({
    version: 1,
    outcome: { statement: "reduce benchmark duration", unit: "ms", higherIsBetter: false, minimumUsefulGain: "10%" },
    preserved: { gates: [] },
    scope: { roots: ["src"], protectedAssets: [] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    models: { providers: ["fixture"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 20, maxEvaluatorRuns: 60, deadlineMs: 60_000, falseAcceptBudget: 0.01 },
    ...overrides,
  });
}

const NODE_PROJECT = {
  "package.json": `${JSON.stringify({
    name: "recon-fixture", private: true, type: "module",
    scripts: { test: "node test.mjs", bench: "node bench.mjs", build: "node -e 0", deploy: "./deploy.sh" },
  }, null, 2)}\n`,
  "bench.mjs": 'import { run } from "./src/hot.mjs";\nrun();\n',
  "test.mjs": 'import { run } from "./src/hot.mjs";\nrun();\n',
  "src/hot.mjs": 'import { helper } from "./lib/util.mjs";\nexport const run = () => helper();\n',
  "src/lib/util.mjs": "export const helper = () => 1;\n",
  "src/unrelated.mjs": "export const noise = 1;\n",
  "node_modules/leftpad/index.js": "module.exports = () => 1;\n",
  ".env.local": "API_KEY=secret\n",
};

test("manifest scripts become declared commands with exact argv, category, and entry file", () => {
  const dir = project(NODE_PROJECT);
  const discovered = discoverCommands(dir, contract());
  const labels = discovered.commands.map((command) => command.label);
  assert.deepEqual(labels.sort(), ["npm run bench", "npm run test"], "only approved categories become commands; build and deploy do not");
  const bench = discovered.commands.find((command) => command.label === "npm run bench");
  assert.deepEqual(bench.declaredArgv, ["npm", "run", "bench"], "the manifest declaration is preserved verbatim");
  assert.deepEqual(bench.argv, ["node", "bench.mjs"], "an unambiguous `node <file>` body runs directly, without package-manager startup in every reading");
  assert.equal(bench.category, "benchmark");
  assert.equal(bench.source, "package.json#scripts.bench");
  assert.equal(bench.entry, "bench.mjs", "the declared script's entry file is resolved");
  assert.ok(discovered.notes.some((note) => note.includes("build")), "a declared but unapproved command is reported, not hidden");
});

test("a lockfile changes the package-manager argv instead of assuming npm", () => {
  const dir = project({ ...NODE_PROJECT, "pnpm-lock.yaml": "lockfileVersion: 9\n" });
  const discovered = discoverCommands(dir, contract());
  const bench = discovered.commands.find((command) => command.label === "pnpm run bench");
  assert.ok(bench, "the pnpm label replaces npm");
  assert.deepEqual(bench.declaredArgv, ["pnpm", "run", "bench"], "the declared form keeps the resolved package manager");
  assert.deepEqual(bench.argv, ["node", "bench.mjs"], "the direct body is used for measurement regardless of manager");
});

test("common JVM, .NET, Swift, Elixir, PHP, and Ruby manifests expose declared test and benchmark commands", () => {
  const dir = project({
    "pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n",
    "build.gradle.kts": "plugins { java }\n",
    "gradlew.bat": "@echo off\n",
    "App.csproj": "<Project />\n",
    "Package.swift": "// swift-tools-version: 5.9\n",
    "mix.exs": "defmodule Fixture.MixProject do end\n",
    "composer.json": `${JSON.stringify({ scripts: { test: "phpunit", bench: "php bench.php", deploy: "php ship.php" } }, null, 2)}\n`,
    Gemfile: "source 'https://rubygems.org'\n",
    Rakefile: "task :test do\nend\ntask :bench do\nend\ntask :deploy do\nend\n",
    "src/bench.php": "<?php echo 1;\n",
    "src/app.swift": "func run() {}\n",
    "src/App.cs": "class App {}\n",
  });
  const discovered = discoverCommands(dir, contract());
  const byLabel = new Map(discovered.commands.map((command) => [command.label, command]));
  assert.equal(byLabel.get("maven test")?.category, "test");
  assert.deepEqual(byLabel.get("gradle test")?.argv, ["gradlew.bat", "test"]);
  assert.equal(byLabel.get("dotnet test")?.source, "*.csproj or *.fsproj");
  assert.equal(byLabel.get("swift test")?.category, "test");
  assert.equal(byLabel.get("mix test")?.category, "test");
  assert.equal(byLabel.get("composer test")?.category, "test");
  assert.equal(byLabel.get("composer bench")?.category, "benchmark");
  assert.deepEqual(byLabel.get("composer bench")?.argv, ["composer", "run-script", "bench"]);
  assert.equal(byLabel.get("rake test")?.category, "test");
  assert.equal(byLabel.get("rake bench")?.category, "benchmark");
  assert.equal(byLabel.has("composer deploy"), false, "unrecognized scripts are never run as recon commands");
  assert.equal(byLabel.has("rake deploy"), false, "unrecognized rake tasks are never run as recon commands");
});

test("a script that is more than a plain runner and file keeps its declared command", () => {
  const dir = project({
    "package.json": `${JSON.stringify({
      name: "hooks", private: true, type: "module",
      scripts: {
        bench: "node bench.mjs",
        "bench:hook": "node bench.mjs",
        "bench:args": "node bench.mjs --fast",
        "bench:env": "NODE_ENV=production node bench.mjs",
      },
    }, null, 2)}\n`,
    "bench.mjs": "console.log(1);\n",
  });
  const discovered = discoverCommands(dir, contract());
  const byLabel = (name) => discovered.commands.find((command) => command.label === `npm run ${name}`);
  assert.deepEqual(byLabel("bench").argv, ["node", "bench.mjs"]);
  assert.deepEqual(byLabel("bench:args").argv, ["npm", "run", "bench:args"], "extra arguments keep the declared command");
  assert.deepEqual(byLabel("bench:env").argv, ["npm", "run", "bench:env"], "an environment prefix keeps the declared command");

  // A pre/post hook would be skipped by running the file directly, so the declared
  // package-manager command is kept instead.
  const hooked = project({
    ...filesOf(dir),
    "package.json": `${JSON.stringify({
      name: "hooks", private: true, type: "module",
      scripts: { prebench: "node prepare.mjs", bench: "node bench.mjs" },
    }, null, 2)}\n`,
  });
  const hookedBench = discoverCommands(hooked, contract()).commands.find((command) => command.label === "npm run bench");
  assert.deepEqual(hookedBench.argv, ["npm", "run", "bench"], "a lifecycle hook keeps the declared command");
});

test("a declared Go benchmark keeps its package path and attributes its local imports", () => {
  const dir = project({
    "package.json": `${JSON.stringify({ scripts: { bench: "go run ./cmd/bench" } }, null, 2)}\n`,
    "go.mod": "module example.test/app\n",
    "cmd/bench/main.go": "package main\nimport \"example.test/app/internal/work\"\nfunc main() { work.Run() }\n",
    "internal/work/work.go": "package work\nfunc Run() {}\n",
  });
  const command = discoverCommands(dir, contract()).commands.find((entry) => entry.label === "npm run bench");
  assert.ok(command);
  assert.deepEqual(command.argv, ["go", "run", "./cmd/bench"], "the direct Go invocation omits package-manager startup");
  assert.equal(command.entry, "cmd/bench/main.go");
  assert.deepEqual(importGraph(dir, command.entry).files, ["cmd/bench/main.go", "internal/work/work.go"]);
});

function filesOf(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else out[relative] = fs.readFileSync(path.join(dir, entry.name), "utf8");
    }
  };
  walk(root, "");
  return out;
}

test("script classification and entry detection stay narrow", () => {
  assert.equal(scriptCategory("test"), "test");
  assert.equal(scriptCategory("test:unit"), "test");
  assert.equal(scriptCategory("bench"), "benchmark");
  assert.equal(scriptCategory("benchmark:parse"), "benchmark");
  assert.equal(scriptCategory("perf"), "benchmark");
  assert.equal(scriptCategory("build"), "build");
  assert.equal(scriptCategory("release"), "custom");

  const dir = project(NODE_PROJECT);
  assert.equal(scriptEntry("node bench.mjs", dir), "bench.mjs");
  assert.equal(scriptEntry("node -e 0", dir), null, "inline code is not an entry file");
  assert.equal(scriptEntry("pytest", dir), null, "a test runner without a file is not an entry");
  assert.equal(scriptEntry("node ../outside.mjs", dir), null, "an entry outside the project is refused");
});

test("the import graph follows local source and never enters dependencies or secrets", () => {
  const dir = project(NODE_PROJECT);
  const walked = importGraph(dir, "bench.mjs");
  assert.deepEqual(walked.files, ["bench.mjs", "src/hot.mjs", "src/lib/util.mjs"], "the causal chain from the entry is reached");
  assert.ok(!walked.files.includes("src/unrelated.mjs"), "an unrelated module is not part of the measured workload");
  assert.ok(!walked.files.some((file) => file.includes("node_modules")), "a dependency branch ends the walk");
  assert.ok(!walked.files.some((file) => file.includes(".env")), "a secret-shaped path is never read");
});

test("the import graph follows Rust modules, Go module packages, and JVM imports within the repository", () => {
  const rust = project({
    "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n",
    "src/lib.rs": "pub mod engine;\n",
    "src/engine.rs": "mod parser;\npub fn run() { parser::parse(); }\n",
    "src/engine/parser.rs": "pub fn parse() {}\n",
    "vendor/ignored.rs": "pub fn ignored() {}\n",
  });
  assert.deepEqual(importGraph(rust, "src/lib.rs").files, ["src/engine.rs", "src/engine/parser.rs", "src/lib.rs"]);

  const go = project({
    "go.mod": "module example.test/service\n\ngo 1.22\n",
    "cmd/server/main.go": "package main\nimport \"example.test/service/internal/core\"\nfunc main() { core.Run() }\n",
    "internal/core/core.go": "package core\nfunc Run() {}\n",
    "internal/core/helper.go": "package core\nfunc helper() {}\n",
    "vendor/example.test/other/other.go": "package other\n",
  });
  assert.deepEqual(importGraph(go, "cmd/server/main.go").files, [
    "cmd/server/main.go", "internal/core/core.go", "internal/core/helper.go",
  ]);

  const jvm = project({
    "pom.xml": "<project />\n",
    "src/main/java/org/example/Main.java": "package org.example;\nimport org.example.core.Worker;\nclass Main { Worker worker; }\n",
    "src/main/java/org/example/core/Worker.java": "package org.example.core;\npublic class Worker {}\n",
    "src/test/java/org/example/MainTest.java": "package org.example;\nclass MainTest {}\n",
  });
  assert.deepEqual(importGraph(jvm, "src/main/java/org/example/Main.java").files, [
    "src/main/java/org/example/Main.java", "src/main/java/org/example/core/Worker.java",
  ]);
});

test("a planted causal bottleneck is measured and becomes the scoped lever", async () => {
  const dir = project(NODE_PROJECT);
  const runContract = contract();
  const recon = await reconProject({
    projectDir: dir,
    contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: command.category === "benchmark" ? 1200 : 40, timedOut: false, error: null }),
  });
  assert.equal(recon.probes.length, 2, "recon probes one measured workload and the test gate");
  assert.equal(recon.commands.filter((command) => command.category === "test").length, 1);

  const inventory = buildReconInventory({ contract: runContract, recon });
  assert.equal(inventory.levers.length, 1);
  const lever = inventory.levers[0];
  assert.equal(lever.sourceKind, "recon-command");
  assert.equal(lever.metricKind, "command-duration");
  assert.deepEqual(lever.scopeFiles.sort(), ["src/hot.mjs", "src/lib/util.mjs"], "scope is the measured import chain inside the approved root");
  assert.ok(!lever.scopeFiles.includes("src/unrelated.mjs"), "an unrelated file is not proposed as patch scope");
  assert.ok(!lever.scopeFiles.includes("bench.mjs"), "the workload entry sits outside the approved root and is excluded");
  assert.deepEqual(lever.gates, ["npm run test"], "the declared test command becomes the correctness gate");
  assert.deepEqual(lever.command.argv, ["node", "bench.mjs"]);
  assert.deepEqual(lever.command.source, "package.json#scripts.bench", "the lever still cites the manifest declaration");
  assert.ok(lever.reasons.some((reason) => /measured: .*1200 ms/.test(reason)), "the lever cites its own measurement");
});

test("matching usage signals rank the measured lever and remain visible as evidence", async () => {
  const dir = project(NODE_PROJECT);
  const runContract = contract();
  const recon = await reconProject({
    projectDir: dir, contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: command.category === "benchmark" ? 1200 : 40, timedOut: false, error: null }),
  });
  const baseline = buildReconInventory({ contract: runContract, recon }).levers[0];
  const ranked = buildReconInventory({ contract: runContract, recon, signals: [{
    kind: "slow-command", summary: "Repeated benchmark failures", suggestedMetric: "duration",
    evidence: [{ source: "session", ref: "npm run bench", count: 5 }],
  }] }).levers[0];
  assert.equal(ranked.score, baseline.score * 2);
  assert.ok(ranked.evidence.some((item) => item.source === "session" && item.ref === "slow-command:npm run bench" && item.count === 5));
  assert.ok(ranked.reasons.some((reason) => /ranking multiplier 2\.00/.test(reason)));
});

test("a workload whose measured code is all outside the approved scope is rejected with the reason", async () => {
  const dir = project({
    ...NODE_PROJECT,
    "package.json": `${JSON.stringify({ name: "x", private: true, type: "module", scripts: { bench: "node bench.mjs" } }, null, 2)}\n`,
  });
  const runContract = contract({ scope: { roots: ["docs"], protectedAssets: [] } });
  const recon = await reconProject({
    projectDir: dir, contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 900, timedOut: false, error: null }),
  });
  const inventory = buildReconInventory({ contract: runContract, recon });
  assert.equal(inventory.levers.length, 0);
  assert.match(inventory.rejected[0].reason, /no file it imports is inside the approved editable scope \(docs\)/);
});

test("a failing or absent workload is reported as a blocker, never guessed around", async () => {
  const dir = project(NODE_PROJECT);
  const runContract = contract();
  const failing = await reconProject({
    projectDir: dir, contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: false, durationMs: 12, timedOut: false, error: "MissingScript: bench" }),
  });
  assert.ok(failing.blockers.some((blocker) => blocker.includes("did not complete") && blocker.includes("MissingScript: bench")));
  const inventory = buildReconInventory({ contract: runContract, recon: failing });
  assert.equal(inventory.levers.length, 0);
  assert.ok(inventory.rejected.some((entry) => /could not be measured/.test(entry.reason)));
});

test("a test that fails on the unchanged tree becomes a scoped suite-failures lever", async () => {
  const dir = project({
    ...NODE_PROJECT,
    "package.json": `${JSON.stringify({ name: "failing-suite", private: true, type: "module", scripts: { test: "node test.mjs", bench: "node bench.mjs" } }, null, 2)}\n`,
  });
  const runContract = contract();
  const recon = await reconProject({
    projectDir: dir, contract: runContract,
    probeImpl: async (command) => command.category === "test"
      ? { label: command.label, ok: false, durationMs: 20, timedOut: false, error: "assertion failed", exitCode: 1, spawnFailed: false }
      : { label: command.label, ok: true, durationMs: 1200, timedOut: false, error: null, exitCode: 0, spawnFailed: false },
  });
  const inventory = buildReconInventory({ contract: runContract, recon });
  const lever = inventory.levers.find((candidate) => candidate.metricKind === "suite-failures");
  assert.ok(lever, "an ordinary nonzero test exit is actionable evidence");
  assert.deepEqual(lever.scopeFiles, ["src/hot.mjs", "src/lib/util.mjs"]);
  assert.deepEqual(lever.command.argv, ["node", "test.mjs"]);
  assert.deepEqual(lever.gates, []);
  assert.equal(inventory.levers.some((candidate) => candidate.metricKind === "command-duration"), true);
});

test("failing tests do not become correctness gates when a separate passing test exists", async () => {
  const dir = project({
    "package.json": `${JSON.stringify({ name: "test-gates", private: true, type: "module", scripts: { "test:broken": "node broken.mjs", "test:smoke": "node smoke.mjs" } }, null, 2)}\n`,
    "broken.mjs": 'import { work } from "./src/work.mjs";\nwork();\n',
    "smoke.mjs": 'import { work } from "./src/work.mjs";\nwork();\n',
    "src/work.mjs": "export const work = () => 1;\n",
  });
  const runContract = contract();
  const recon = await reconProject({
    projectDir: dir, contract: runContract,
    probeImpl: async (command) => command.label === "npm run test:broken"
      ? { label: command.label, ok: false, durationMs: 20, timedOut: false, error: "assertion failed", exitCode: 1, spawnFailed: false }
      : { label: command.label, ok: true, durationMs: 20, timedOut: false, error: null, exitCode: 0, spawnFailed: false },
  });
  const inventory = buildReconInventory({ contract: runContract, recon });
  const lever = inventory.levers.find((candidate) => candidate.metricKind === "suite-failures");
  assert.ok(lever);
  assert.deepEqual(lever.gates, ["npm run test:smoke"]);
});

test("test timeouts and launch failures do not become failure-count levers", async () => {
  const dir = project(NODE_PROJECT);
  const runContract = contract();
  for (const failedProbe of [
    { label: "npm run test", ok: false, durationMs: null, timedOut: true, error: "timeout", exitCode: null, spawnFailed: false },
    { label: "npm run test", ok: false, durationMs: null, timedOut: false, error: "ENOENT", exitCode: null, spawnFailed: true },
  ]) {
    const recon = await reconProject({
      projectDir: dir, contract: runContract,
      probeImpl: async (command) => command.category === "test" ? failedProbe :
        { label: command.label, ok: true, durationMs: 1200, timedOut: false, error: null, exitCode: 0, spawnFailed: false },
    });
    assert.equal(buildReconInventory({ contract: runContract, recon }).levers.some((candidate) => candidate.metricKind === "suite-failures"), false);
  }
});

test("a project with no declared workload produces a named refusal, not an empty inventory", async () => {
  const dir = project({ "package.json": `${JSON.stringify({ name: "bare", private: true })}\n`, "src/a.js": "export const a = 1;\n" });
  const runContract = contract();
  const recon = await reconProject({ projectDir: dir, contract: runContract });
  assert.ok(recon.blockers.some((blocker) => /no declared command matches the approved command categories/.test(blocker)));
  const inventory = buildReconInventory({ contract: runContract, recon });
  assert.equal(inventory.levers.length, 0);
  assert.ok(inventory.rejected.length > 0, "the refusal is a recorded rejection");
  assert.ok(inventory.diagnostics.some((line) => line.startsWith("blocker:")), "the diagnostic explains the stop");
});

// ---------------------------------------------------------------------------
// W10: contract-declared score evaluator
// ---------------------------------------------------------------------------

function rawContract(overrides = {}) {
  return {
    version: 1,
    outcome: { statement: "reduce benchmark duration", unit: "ms", higherIsBetter: false, minimumUsefulGain: "10%" },
    preserved: { gates: [] },
    scope: { roots: ["src"], protectedAssets: [] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    models: { providers: ["fixture"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 20, maxEvaluatorRuns: 60, deadlineMs: 60_000, falseAcceptBudget: 0.01 },
    ...overrides,
  };
}

function evaluatorOutcome(overrides = {}) {
  return {
    statement: "raise the benchmark accuracy",
    unit: "points",
    higherIsBetter: true,
    minimumUsefulGain: "10%",
    evaluator: { argv: ["node", "eval/score.mjs"], output: "score-json", inputs: ["eval/score.mjs"] },
    ...overrides,
  };
}

function scoreContract(overrides = {}) {
  return normalizeRunContract(rawContract({ outcome: evaluatorOutcome(), ...overrides }));
}

/** A declared workload plus a declared score evaluator that reads the editable code. */
const SCORE_PROJECT = {
  ...NODE_PROJECT,
  "package.json": `${JSON.stringify({
    name: "score-fixture", private: true, type: "module",
    scripts: { test: "node test.mjs", bench: "node bench.mjs" },
  }, null, 2)}\n`,
  "bench.mjs": 'import { accuracy } from "./src/model.mjs";\nconsole.log(accuracy());\n',
  "src/model.mjs": "export const accuracy = () => 0.62;\n",
  "eval/score.mjs": 'import { accuracy } from "../src/model.mjs";\nconsole.log(JSON.stringify({ score: accuracy(), valid: true }));\n',
};

test("a declared outcome evaluator is validated, normalized, and changes the contract identity", () => {
  const contract = scoreContract();
  assert.deepEqual(contract.outcome.evaluator, {
    argv: ["node", "eval/score.mjs"],
    output: "score-json",
    inputs: ["eval/score.mjs"],
  }, "the evaluator is normalized onto the frozen outcome");

  const identity = contractIdentity(contract);
  assert.equal(contractIdentity(scoreContract()), identity, "the same evaluator keeps the same identity");
  assert.notEqual(
    contractIdentity(scoreContract({ outcome: evaluatorOutcome({ evaluator: { argv: ["node", "eval/score.mjs"], output: "stdout-number" } }) })),
    identity,
    "changing how the score is reported changes what a measurement means",
  );
  assert.notEqual(
    contractIdentity(scoreContract({ outcome: evaluatorOutcome({ evaluator: { argv: ["node", "eval/other.mjs"], output: "score-json" } }) })),
    identity,
    "changing the evaluator changes the instrument identity",
  );
  assert.equal(contractIdentity(normalizeRunContract(rawContract())).length, 16);
});

test("an invalid evaluator declaration is refused with a specific reason", () => {
  const errorsFor = (evaluator) => validateRunContract(rawContract({ outcome: evaluatorOutcome({ evaluator }) }));
  assert.match(errorsFor({ argv: [], output: "score-json" }).join("; "), /outcome\.evaluator\.argv/);
  assert.match(errorsFor({ argv: ["node", ""], output: "score-json" }).join("; "), /outcome\.evaluator\.argv/);
  assert.match(errorsFor({ argv: ["node", "eval/score.mjs"], output: "elapsed" }).join("; "), /outcome\.evaluator\.output/);
  assert.match(errorsFor({ argv: ["node", "eval/score.mjs"], output: "score-json", inputs: "eval/score.mjs" }).join("; "), /outcome\.evaluator\.inputs/);
  assert.match(errorsFor({ argv: ["node", "eval/score.mjs"], output: "score-json", inputs: [""] }).join("; "), /outcome\.evaluator\.inputs/);
  assert.match(errorsFor({ argv: ["node", "eval/score.mjs"], output: "score-json", inputs: ["../outside.mjs"] }).join("; "), /outcome\.evaluator\.inputs/);
  assert.deepEqual(errorsFor({ argv: ["node", "eval/score.mjs"], output: "stdout-number", inputs: [] }), [], "an empty inputs list is acceptable");
});

test("a declared score evaluator becomes the primary lever, with the contract's direction and unit", async () => {
  const dir = project(SCORE_PROJECT);
  const runContract = scoreContract();
  const recon = await reconProject({
    projectDir: dir,
    contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 300, timedOut: false, error: null }),
  });
  const inventory = buildReconInventory({ contract: runContract, recon });
  const lever = inventory.levers[0];
  assert.ok(lever, `expected a score lever, got ${JSON.stringify(inventory.rejected)}`);
  assert.equal(lever.metricKind, "score", "the declared evaluator decides what is measured");
  assert.equal(lever.sourceKind, "recon-command");
  assert.match(lever.metric, /points/, "the unit comes from the approved outcome");
  assert.match(lever.metric, /higher is better/, "the direction comes from the approved outcome");
  assert.match(lever.goal, /raise the benchmark accuracy/);
  assert.deepEqual(lever.command.argv, ["node", "eval/score.mjs"], "the lever measures the declared evaluator, never wall time");
  assert.equal(lever.command.source, "contract.outcome.evaluator");
  assert.deepEqual(lever.scopeFiles, ["src/model.mjs"], "scope is the code the declared workload exercises inside the approved root");
  assert.ok(!lever.scopeFiles.includes("eval/score.mjs"), "pinned evaluator code is never candidate-editable");
  assert.deepEqual(lever.gates, ["npm run test"], "declared test commands remain the correctness gates");
  assert.ok(lever.reasons.some((reason) => /declared score evaluator/.test(reason)), "the lever explains the instrument");
  assert.ok(lever.reasons.some((reason) => /pin/.test(reason)), "the lever reports that evaluator inputs are pinned");
  assert.ok(
    inventory.rejected.some((entry) => /wall-clock duration/.test(entry.reason) && /proxy/i.test(entry.reason)),
    "a duration lever for a non-time outcome is rejected with the proxy reason, not silently dropped",
  );
});

test("a non-time outcome cannot fall back to a wall-clock duration lever without a proxy justification", async () => {
  const dir = project(NODE_PROJECT);
  const nonTime = contract({ outcome: { statement: "raise the benchmark accuracy", unit: "points", higherIsBetter: true, minimumUsefulGain: "10%" } });
  const recon = await reconProject({
    projectDir: dir, contract: nonTime,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 900, timedOut: false, error: null }),
  });
  const refused = buildReconInventory({ contract: nonTime, recon });
  assert.equal(refused.levers.length, 0, "wall time is not the declared outcome");
  assert.match(refused.rejected[0].reason, /wall-clock duration/);
  assert.match(refused.rejected[0].reason, /proxyJustification/);

  const proxy = contract({ outcome: { statement: "raise the benchmark accuracy", unit: "points", higherIsBetter: true, minimumUsefulGain: "10%", proxyJustification: "wall-clock duration tracks the accuracy of the same model" } });
  const proxied = buildReconInventory({ contract: proxy, recon });
  assert.equal(proxied.levers[0]?.metricKind, "command-duration", "an explicit proxy justification permits the duration lever");

  const timeLike = contract({ outcome: { statement: "reduce p95 latency", unit: "ms", higherIsBetter: false, minimumUsefulGain: "10%" } });
  const timed = buildReconInventory({ contract: timeLike, recon });
  assert.equal(timed.levers[0]?.metricKind, "command-duration", "a time-like unit needs no justification");
});

test("a declared evaluator excludes alternate metrics even when a proxy justification exists", async () => {
  const dir = project(SCORE_PROJECT);
  const runContract = scoreContract({
    outcome: evaluatorOutcome({ proxyJustification: "wall-clock duration tracks the same model's accuracy" }),
  });
  const recon = await reconProject({
    projectDir: dir,
    contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 300, timedOut: false, error: null }),
  });
  const inventory = buildReconInventory({ contract: runContract, recon });
  assert.deepEqual(inventory.levers.map((lever) => lever.metricKind), ["score"], "qualification failure must not substitute a proxy for the declared instrument");
  assert.ok(inventory.rejected.some((entry) => /declared evaluator is authoritative/.test(entry.reason)), "alternate measurements are rejected with an explicit reason");
});

test("an importless evaluator can claim explicit roots without borrowing unrelated manifest graphs", async () => {
  const dir = project({
    "package.json": `${JSON.stringify({ name: "dynamic-score", private: true, type: "module", scripts: { bench: "node bench.mjs" } }, null, 2)}\n`,
    "bench.mjs": 'import "./docs/unrelated.mjs";\n',
    "docs/unrelated.mjs": "export const unrelated = true;\n",
    "src/model.mjs": "export const accuracy = () => 0.5;\n",
    "eval/score.mjs": 'console.log(JSON.stringify({ score: 1, valid: true }));\n',
  });
  const runContract = scoreContract();
  const recon = await reconProject({
    projectDir: dir,
    contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 300, timedOut: false, error: null }),
  });
  assert.ok(recon.graphs["npm run bench"].includes("docs/unrelated.mjs"), "the unrelated manifest graph is present but must not be borrowed");
  const inventory = buildReconInventory({ contract: runContract, recon });
  assert.equal(inventory.levers.length, 1, `expected an explicitly rooted dynamic claim, got ${JSON.stringify(inventory.rejected)}`);
  assert.deepEqual(inventory.levers[0].scopeFiles, ["src/model.mjs"]);
  assert.ok(inventory.levers[0].reasons.some((reason) => /unverified dynamic claim/i.test(reason)));
  assert.deepEqual(inventory.levers[0].command.argv, ["node", "eval/score.mjs"], "the evaluator remains pinned");
});

test("an importless evaluator with whole-workspace scope cannot nominate arbitrary files", async () => {
  const dir = project({
    "package.json": `${JSON.stringify({ name: "unscoped-score", private: true, type: "module" }, null, 2)}\n`,
    "src/model.mjs": "export const accuracy = () => 0.5;\n",
    "eval/score.mjs": 'console.log(JSON.stringify({ score: 1, valid: true }));\n',
  });
  const runContract = scoreContract({ scope: { roots: [], protectedAssets: [] } });
  const recon = await reconProject({
    projectDir: dir, contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 300, timedOut: false, error: null }),
  });
  const inventory = buildReconInventory({ contract: runContract, recon });
  assert.equal(inventory.levers.length, 0);
  assert.match(inventory.rejected[0].reason, /no statically reached implementation.*no explicit nonempty editable roots/i);
});

test("a score evaluator whose exercised code is all outside the approved scope is rejected with the reason", async () => {
  const dir = project(SCORE_PROJECT);
  const runContract = scoreContract({ scope: { roots: ["docs"], protectedAssets: [] } });
  const recon = await reconProject({
    projectDir: dir,
    contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 300, timedOut: false, error: null }),
  });
  const inventory = buildReconInventory({ contract: runContract, recon });
  assert.equal(inventory.levers.length, 0);
  assert.ok(
    inventory.rejected.some((entry) => /score evaluator/.test(entry.reason) && /approved editable scope/.test(entry.reason)),
    `expected a scoped score rejection, got ${JSON.stringify(inventory.rejected)}`,
  );
});

test("a python project's local imports are walked, and pytest becomes the gate", async () => {
  const dir = project({
    "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
    "Makefile": "bench:\n\tpython bench.py\n\ntest:\n\tpython -m pytest\n",
    "bench.py": "from app.core import work\nwork()\n",
    "app/__init__.py": "",
    "app/core.py": "from app.util import leaf\n\ndef work():\n    return leaf()\n",
    "app/util.py": "def leaf():\n    return 1\n",
    "tests/test_app.py": "from app.core import work\n\ndef test_work():\n    assert work() == 1\n",
  });
  const runContract = contract({ scope: { roots: ["app"], protectedAssets: [] } });
  const discovered = discoverCommands(dir, runContract);
  assert.ok(discovered.commands.some((command) => command.label === "pytest" && command.category === "test"), "pytest is discovered from pyproject");
  const makeBench = discovered.commands.find((command) => command.label === "make bench");
  assert.ok(makeBench, "the Makefile-declared benchmark is discovered");
  assert.equal(makeBench.entry, "bench.py", "the recipe line names the workload entry");
  assert.equal(scriptEntry("python bench.py", dir), "bench.py");
  const recon = await reconProject({
    projectDir: dir, contract: runContract, maxProbes: 3,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 500, timedOut: false, error: null }),
  });
  assert.ok(recon.graph.includes("app/core.py"), `expected the python import chain, got ${JSON.stringify(recon.graph)}`);
});
