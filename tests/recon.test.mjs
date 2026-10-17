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

import { normalizeRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";
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

test("a planted causal bottleneck is measured and becomes the scoped lever", async () => {
  const dir = project(NODE_PROJECT);
  const runContract = contract();
  const recon = await reconProject({
    projectDir: dir,
    contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: command.category === "benchmark" ? 1200 : 40, timedOut: false, error: null }),
  });
  assert.equal(recon.probes.length, 1, "the benchmark is the measured workload; the test command is a gate");
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
