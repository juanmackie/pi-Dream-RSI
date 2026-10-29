/**
 * Unattended loop end-to-end acceptance harness.
 *
 * Each win fixture goes through the production path: fresh clone -> session-signal
 * contract-bounded recon -> instrument qualification -> bounded
 * campaign with stub agents -> adversarially reviewed, verified patch applied to the
 * clone's working tree. The applied state is then verified independently of the
 * loop's own measurement by running the fixture command again.
 *
 * Variation: real runners (npm, pytest, and the npm-test head resolved to bun from
 * lockfile evidence), single- and multi-file scopes, and repeats for cost
 * variability. A known-negative fixture (noise edits plus an out-of-scope cheat)
 * must apply nothing, scripted scenario stubs must keep false applies at zero,
 * The held-out fixtures run only with
 * DREAM_RSI_HELDOUT=1 so their first observation is the acceptance sweep: one
 * fixed instance and one instance randomized from DREAM_RSI_HELDOUT_SEED (or a
 * random seed reported in the test output).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { runLoop } from "../extensions/pi-dream-rsi/engine/loop.ts";
import { normalizeRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";

const HELDOUT = process.env.DREAM_RSI_HELDOUT === "1";
const REPEATS = Math.max(1, Number(process.env.DREAM_RSI_LOOP_E2E_REPEATS ?? "3"));
const COMSHELL = process.env.ComSpec ?? "cmd.exe";

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Run a command. `shellShim` routes through the platform shell so npm-style shims
 * resolve: the Windows command interpreter on Windows, /bin/sh elsewhere. Using
 * cmd.exe unconditionally makes every shimmed command fail with ENOENT on POSIX.
 */
function runCommand(command, args, cwd, shellShim = false) {
  const posix = process.platform !== "win32";
  const file = !shellShim ? command : posix ? "/bin/sh" : COMSHELL;
  const argv = !shellShim ? args : posix ? ["-c", [command, ...args].join(" ")] : ["/d", "/s", "/c", [command, ...args].join(" ")];
  const result = spawnSync(file, argv, { cwd, encoding: "utf8", timeout: 120_000, windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ?? null };
}

function git(args, cwd) {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  return result.stdout ?? "";
}

function hasTool(commandLine) {
  const result = process.platform === "win32"
    ? spawnSync(COMSHELL, ["/d", "/s", "/c", commandLine], { encoding: "utf8", windowsHide: true, timeout: 60_000 })
    : spawnSync("/bin/sh", ["-c", commandLine], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Session fixtures (shapes proven by tests/loop.test.mjs)
// ---------------------------------------------------------------------------

function toolEntry(id, name, arguments_, time) {
  return {
    type: "message", id: `entry-${id}`, parentId: null, timestamp: new Date(time).toISOString(),
    message: {
      role: "assistant", content: [{ type: "toolCall", id, name, arguments: arguments_ }],
      timestamp: time, provider: "fixture", model: "fixture", api: "fixture", usage: {}, stopReason: "toolUse",
    },
  };
}

function toolResult(id, name, text, time, { isError = false } = {}) {
  return {
    type: "message", id: `result-${id}`, parentId: null, timestamp: new Date(time).toISOString(),
    message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: time },
  };
}

function writeSession(sessionDir, projectDir, entries, name = "session.jsonl") {
  fs.mkdirSync(sessionDir, { recursive: true });
  const header = { type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: projectDir };
  fs.writeFileSync(path.join(sessionDir, name), [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

/** Failing-command runs interleaved with edits on the spec's targets: the loop's scoped lever. */
function writeFixtureSessions(sessionDir, projectDir, spec) {
  const base = Date.now() - 60_000;
  const entries = [];
  spec.editTargets.forEach((target, index) => {
    const at = base + index * 1_000;
    entries.push(toolEntry(`fail-${index}`, "bash", { command: spec.sessionCommand }, at));
    entries.push(toolResult(`fail-${index}`, "bash", `Error: ${spec.sessionCommand} failed`, at + 80, { isError: true }));
    entries.push(toolEntry(`edit-${index}`, "edit", { path: target, edits: [{ oldText: "a", newText: "b" }] }, at + 120));
    entries.push(toolResult(`edit-${index}`, "edit", "edited", at + 160));
  });
  writeSession(sessionDir, projectDir, entries);
}

// ---------------------------------------------------------------------------
// Fixture repositories
// ---------------------------------------------------------------------------

/** The stub agent: applies the fixture's fix or a noise/cheat candidate, and accepts the scripted review. */
function agentSource(replacements, mode = "fix") {
  return `import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
let prompt = ""; process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (/Dream-RSI agent liveness probe/i.test(prompt)) { process.stdout.write("ok\\n"); return; }
  if (/Perform an adversarial review/i.test(prompt)) {
    writeFileSync("review.json", JSON.stringify({ verdict: "accept", reasons: [] }));
    return;
  }
  const REPLACEMENTS = ${JSON.stringify(replacements)};
  const MODE = ${JSON.stringify(mode)};
  const SKIP = new Set([".git", ".dream-rsi", "node_modules", "__pycache__", ".pytest_cache", "e2e-agent.mjs"]);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const file = path.join(dir, name);
      let stats;
      try { stats = statSync(file); } catch { continue; }
      if (stats.isDirectory()) { walk(file); continue; }
      files.push(file);
    }
  };
  walk(".");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    let next = text;
    if (MODE === "noise") {
      if (path.basename(file) === "test.mjs") next = next.split('"NEEDS_FIX"').join('"ALWAYS_OK"');
      else if (path.basename(file) === "parser.js") next = next + "// reviewed-no-change\\n";
    } else {
      for (const pair of REPLACEMENTS) next = next.split(pair[0]).join(pair[1]);
    }
    if (next !== text) writeFileSync(file, next);
  }
  writeFileSync("proposal.md", MODE === "noise" ? "# Reviewed candidate without measurable change\\n" : "# Apply the marked fix\\n");
});
`;
}

const NPM_TEST = `import { readFileSync } from "node:fs";
const source = readFileSync("src/parser.js", "utf8");
process.exit(source.includes("NEEDS_FIX") ? 1 : 0);
`;

const FIXTURES = {
  fixes: {
    name: "fixes",
    files: {
      "package.json": JSON.stringify({ name: "loop-e2e-fixes", private: true, scripts: { test: "node test.mjs", "test:gate": "node gate.mjs" } }, null, 2) + "\n",
      "test.mjs": NPM_TEST,
      "gate.mjs": `import { parse } from "./src/parser.js";\nif (typeof parse !== "function") process.exit(1);\n`,
      "src/parser.js": "// NEEDS_FIX\nexport const parse = (text) => text.trim();\n",
    },
    fixed: { "src/parser.js": "// FIXED\nexport const parse = (text) => text.trim();\n" },
    replacements: [["// NEEDS_FIX", "// FIXED"]],
    sessionCommand: "npm test",
    editTargets: ["src/parser.js", "src/parser.js"],
    verify: { command: "npm", args: ["test"], shim: true },
  },
  multifix: {
    name: "multifix",
    files: {
      "package.json": JSON.stringify({ name: "loop-e2e-multifix", private: true, scripts: { test: "node test.mjs", "test:gate": "node gate.mjs" } }, null, 2) + "\n",
      "gate.mjs": `import { alpha } from "./src/alpha.js";\nimport { beta } from "./src/core/beta.js";\nif (typeof alpha !== "function" || typeof beta !== "function") process.exit(1);\n`,
      "test.mjs": `import { readFileSync } from "node:fs";
const alpha = readFileSync("src/alpha.js", "utf8");
const beta = readFileSync("src/core/beta.js", "utf8");
process.exit(alpha.includes("NEEDS_FIX") || beta.includes("NEEDS_FIX") ? 1 : 0);
`,
      "src/alpha.js": "// NEEDS_FIX\nexport const alpha = () => 1;\n",
      "src/core/beta.js": "// NEEDS_FIX\nexport const beta = () => 2;\n",
    },
    fixed: {
      "src/alpha.js": "// FIXED\nexport const alpha = () => 1;\n",
      "src/core/beta.js": "// FIXED\nexport const beta = () => 2;\n",
    },
    replacements: [["// NEEDS_FIX", "// FIXED"]],
    sessionCommand: "npm test",
    editTargets: ["src/alpha.js", "src/core/beta.js", "src/alpha.js"],
    verify: { command: "npm", args: ["test"], shim: true },
  },
  pytest: {
    name: "pytest",
    files: {
      "pyproject.toml": `[tool.pytest.ini_options]\ntestpaths = ["tests"]\npythonpath = ["."]\nasyncio_default_fixture_loop_scope = "function"\n`,
      "app/__init__.py": "",
      "app/main.py": `NEEDS_FIX = True\n\n\ndef double(x):\n    return x * (3 if NEEDS_FIX else 2)\n`,
      "tests/test_app.py": `from app.main import double\n\n\ndef test_double():\n    assert double(2) == 4\n`,
      "tests/test_gate.py": `from app.main import double\n\n\ndef test_double_returns_a_number():\n    assert isinstance(double(2), int)\n`,
      "package.json": JSON.stringify({ private: true, scripts: { "test:gate": "python -m pytest tests/test_gate.py -q" } }, null, 2) + "\n",
    },
    fixed: { "app/main.py": `NEEDS_FIX = False\n\n\ndef double(x):\n    return x * (3 if NEEDS_FIX else 2)\n` },
    replacements: [["NEEDS_FIX = True", "NEEDS_FIX = False"]],
    sessionCommand: "pytest",
    editTargets: ["app/main.py", "app/main.py"],
    verify: { command: "python", args: ["-m", "pytest", "-q"], shim: false },
  },
  bunlock: {
    name: "bunlock",
    files: {
      "package.json": JSON.stringify({ name: "loop-e2e-bun", private: true, scripts: { test: "bun test test/value.test.js", "test:gate": "node gate.mjs" } }, null, 2) + "\n",
      "bun.lock": "",
      "gate.mjs": `import { value } from "./src/value.js";\nif (typeof value() !== "number") process.exit(1);\n`,
      "src/value.js": "const NEEDS_FIX = true;\nexport const value = () => (NEEDS_FIX ? 3 : 4);\n",
      "test/value.test.js": `import { expect, test } from "bun:test";
import { value } from "../src/value.js";

test("value", () => {
  expect(value()).toBe(4);
});
`,
    },
    fixed: { "src/value.js": "const NEEDS_FIX = false;\nexport const value = () => (NEEDS_FIX ? 3 : 4);\n" },
    replacements: [["const NEEDS_FIX = true", "const NEEDS_FIX = false"]],
    sessionCommand: "npm test",
    editTargets: ["src/value.js", "src/value.js"],
    verify: { command: "bun", args: ["test"], shim: false },
  },
  noise: {
    name: "noise",
    mode: "noise",    files: {
      "package.json": JSON.stringify({ name: "loop-e2e-noise", private: true, scripts: { test: "node test.mjs", "test:gate": "node gate.mjs" } }, null, 2) + "\n",
      "test.mjs": NPM_TEST,
      "gate.mjs": `import { parse } from "./src/parser.js";\nif (parse(" x ") !== "x") process.exit(1);\n`,
      "src/parser.js": "// NEEDS_FIX\nexport const parse = (text) => text.trim();\n",
    },
    fixed: { "src/parser.js": "// FIXED\nexport const parse = (text) => text.trim();\n" },
    replacements: [],
    sessionCommand: "npm test",
    editTargets: ["src/parser.js", "src/parser.js"],
    verify: { command: "npm", args: ["test"], shim: true },
  },
  // A process that answers the liveness probe but reports a provider error on every
  // experiment attempt. The loop must stop after three consecutive non-editing errors
  // instead of spending the campaign allowance on attempts that can only fail.
  breaker: {
    name: "breaker",
    agentSource: `const ok = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } };
const done = { type: "message_end", message: { model: "fixture/breaker", stopReason: "stop" } };
const failed = { type: "message_end", message: { model: "fixture/breaker", stopReason: "error", errorMessage: "fixture provider failed" } };
let prompt = ""; process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  for (const line of /Dream-RSI agent liveness probe/i.test(prompt) ? [ok, done] : [failed]) console.log(JSON.stringify(line));
});
`,
    agentOutputFormat: "pi-json",
    agentModel: "fixture/breaker",
    files: {
      "package.json": JSON.stringify({ name: "loop-e2e-breaker", private: true, scripts: { test: "node test.mjs", "test:gate": "node gate.mjs" } }, null, 2) + "\n",
      "test.mjs": NPM_TEST,
      "gate.mjs": `import { parse } from "./src/parser.js";\nif (typeof parse !== "function") process.exit(1);\n`,
      "src/parser.js": "// NEEDS_FIX\nexport const parse = (text) => text.trim();\n",
    },
    fixed: { "src/parser.js": "// FIXED\nexport const parse = (text) => text.trim();\n" },
    replacements: [],
    sessionCommand: "npm test",
    editTargets: ["src/parser.js", "src/parser.js"],
    verify: { command: "npm", args: ["test"], shim: true },
  },
  heldout: {
    name: "heldout",
    files: {
      "package.json": JSON.stringify({ name: "loop-e2e-heldout", private: true, scripts: { test: "node scripts/check.mjs", "test:gate": "node scripts/gate.mjs" } }, null, 2) + "\n",
      "scripts/check.mjs": `import { readFileSync } from "node:fs";
const paths = ["packages/core/src/alpha.mjs", "packages/core/src/gamma.mjs", "packages/util/src/beta.mjs"];
const broken = paths.filter((file) => readFileSync(file, "utf8").includes("NEEDS_FIX"));
process.exit(broken.length === 0 ? 0 : 1);
`,
      "scripts/gate.mjs": `import { readFileSync } from "node:fs";\nconst paths = ["packages/core/src/alpha.mjs", "packages/core/src/gamma.mjs", "packages/util/src/beta.mjs"];\nif (!paths.every((file) => readFileSync(file, "utf8").includes("export const"))) process.exit(1);\n`,
      "packages/core/src/alpha.mjs": "// NEEDS_FIX\nexport const alpha = () => 1;\n",
      "packages/core/src/gamma.mjs": "// NEEDS_FIX\nexport const gamma = () => 3;\n",
      "packages/util/src/beta.mjs": "// NEEDS_FIX\nexport const beta = () => 2;\n",
      "TODO": "notes\n",
    },
    fixed: {
      "packages/core/src/alpha.mjs": "// FIXED\nexport const alpha = () => 1;\n",
      "packages/core/src/gamma.mjs": "// FIXED\nexport const gamma = () => 3;\n",
      "packages/util/src/beta.mjs": "// FIXED\nexport const beta = () => 2;\n",
    },
    replacements: [["// NEEDS_FIX", "// FIXED"]],
    sessionCommand: "npm test",
    editTargets: ["packages/core/src/alpha.mjs", "TODO", "packages/core/src/gamma.mjs", "packages/util/src/beta.mjs"],
    verify: { command: "npm", args: ["test"], shim: true },
  },
};

/** Build the fixture source repository at its intentionally failing baseline. */
function buildFixtureRepo(dir, spec) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (relative, content) => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  for (const [relative, content] of Object.entries(spec.files)) write(relative, content);
  const targets = Object.keys(spec.fixed);
  write("dream-e2e-score.mjs", `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";\nconst targets=${JSON.stringify(targets)};\nconst source=targets.map(file=>readFileSync(file,"utf8"));\nconst broken=source.filter(text=>text.includes("NEEDS_FIX")&&!/(?:=\\s*false|=\\s*False)/.test(text)).length;\nconst valid=!source.some(text=>text.includes("export {};")||text.includes("# inert qualification stub"));\nmkdirSync("eval",{recursive:true});\nwriteFileSync("eval/score.json",JSON.stringify({score:targets.length-broken,valid,fail_class:valid?"ok":"wrong_answer",error:valid?null:"inert code"}));\n`);
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "loop-e2e@example.invalid"], dir);
  git(["config", "user.name", "loop e2e"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "fixture"], dir);
  git(["checkout", "--", "."], dir);
  write("e2e-agent.mjs", spec.agentSource ?? agentSource(spec.replacements, spec.mode ?? "fix"));
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "stub agent"], dir);
}

/** Fresh clone per run: the loop must start from a clean working tree it never saw before. */
function cloneFixture(sourceDir, cloneDir) {
  spawnSync("git", ["-c", "core.autocrlf=false", "clone", "-q", sourceDir, cloneDir], { encoding: "utf8", windowsHide: true });
  assert.ok(fs.existsSync(path.join(cloneDir, "e2e-agent.mjs")), "clone carries the stub agent");
  return cloneDir;
}

function runSpecCommand(spec, cwd) {
  return runCommand(spec.verify.command, spec.verify.args, cwd, spec.verify.shim);
}

/** One trusted-local contract run on a fresh clone, with no supplied winning patch. */
async function executeFixture(spec, fixtureDir, { limits, campaignDefaults, autoCommit = false } = {}) {
  const sourceDir = path.join(fixtureDir, "source");
  buildFixtureRepo(sourceDir, spec);
  const cloneDir = cloneFixture(sourceDir, path.join(fixtureDir, "clone"));
  const before = runSpecCommand(spec, cloneDir);
  assert.notEqual(before.status, 0, `fixture ${spec.name} must start broken (status ${before.status})`);
  const scorePath = path.join(cloneDir, "dream-e2e-score.mjs");
  const targets = Object.keys(spec.fixed);
  fs.writeFileSync(scorePath, `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";\nconst targets=${JSON.stringify(targets)};\nconst source=targets.map(file=>readFileSync(file,"utf8"));\nconst broken=source.filter(text=>text.includes("NEEDS_FIX")&&!/(?:=\\s*false|=\\s*False)/.test(text)).length;\nconst valid=!source.some(text=>text.includes("export {};")||text.includes("# inert qualification stub"));\nmkdirSync("eval",{recursive:true});\nwriteFileSync("eval/score.json",JSON.stringify({score:targets.length-broken,valid,fail_class:valid?"ok":"wrong_answer",error:valid?null:"inert code"}));\n`);
  const scopeRoots = [...new Set(targets.map((file) => path.dirname(file).replaceAll("\\", "/")))];
  const gates = [`${spec.verify.command} ${spec.verify.args.join(" ")}`];
  const contract = normalizeRunContract({
    version: 1, projectDir: cloneDir,
    outcome: { statement: `reduce broken markers in the ${spec.name} fixture without breaking its declared test command`, unit: "markers", higherIsBetter: true, minimumUsefulGain: 0.5,
      evaluator: { argv: [process.execPath, scorePath], output: "score-json", inputs: ["dream-e2e-score.mjs"] } },
    preserved: { gates },
    scope: { roots: scopeRoots, protectedAssets: ["package.json", "e2e-agent.mjs", "dream-e2e-score.mjs", ...targets.filter((file) => /(^|\/)test(s)?(\/|\.)/.test(file))] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "build", "custom"] },
    models: { providers: ["local"] },
    ...(autoCommit ? { git: { autoCommit: true, branch: "dream-rsi/improve" } } : {}),
    budgets: { maxCampaigns: limits?.maxCampaigns ?? 1, maxAgentStarts: limits?.maxAgentStarts ?? 36,
      maxEvaluatorRuns: limits?.maxEvaluatorRuns ?? 100, deadlineMs: limits?.deadlineMs ?? 1_800_000, falseAcceptBudget: 0.1 },
    agent: { command: process.execPath, args: [path.join(cloneDir, "e2e-agent.mjs")], prompt_via: "stdin", model: spec.agentModel ?? null, thinking: null,
      ...(spec.agentOutputFormat ? { output_format: spec.agentOutputFormat } : {}) },
  });
  const sessionDir = path.join(fixtureDir, "sessions");
  writeFixtureSessions(sessionDir, cloneDir, spec);
  const wallStart = Date.now();
  const result = await runLoop({
    projectDir: cloneDir,
    sessionDir,
    limits: { maxCampaigns: limits?.maxCampaigns ?? 1, maxAgentStarts: limits?.maxAgentStarts ?? 36,
      maxEvaluatorRuns: limits?.maxEvaluatorRuns ?? 100, deadlineMs: limits?.deadlineMs ?? 1_800_000, plateauK: 2 },
    campaignDefaults: campaignDefaults ?? { maxCycles: 2, maxAgentStarts: 24, maxEvaluatorRuns: 48, deadlineMs: 600_000 },
    includeLogs: true,
    contract,
    taskDefaults: { agent_timeout_ms: 20_000, evaluator_timeout_ms: 60_000 },
  });
  return { cloneDir, sessionDir, result, wallMs: Date.now() - wallStart };
}

// ---------------------------------------------------------------------------
// Assertions and reporting
// ---------------------------------------------------------------------------

function readLedger(campaignRoot) {
  const file = path.join(campaignRoot, "history", "ledger.jsonl");
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function readApplied(campaignRoot) {
  const file = path.join(campaignRoot, "history", "applied.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
}

/** A win means: applied ledger entry, working tree carries the fix, and the fixture command now passes. */
function assertVerifiedWin(spec, run) {
  const { cloneDir, result } = run;
  assert.equal(result.campaigns, 1, `campaigns: ${result.campaigns}; stopped: ${result.stopReason}; levers: ${JSON.stringify(result.inventory?.levers)}; rejected: ${JSON.stringify(result.inventory?.rejected)}; notes: ${JSON.stringify(result.memory?.notes)}`);
  assert.equal(result.wins, 1, `wins: ${result.wins}; records ${JSON.stringify(result.records)}`);
  assert.equal(result.stopReason, "budget", "the single-campaign budget is the only stop after a win");
  const record = result.records.find((entry) => entry.outcome === "win");
  assert.ok(record && record.campaignRoot, "a win record with a campaign root");
  assert.ok(readApplied(record.campaignRoot).length >= 1, "the verified candidate reaches applied.jsonl");
  const ledger = readLedger(record.campaignRoot);
  assert.ok(ledger.some((entry) => entry.kind === "apply" && entry.outcome === "success"), "the apply ledger records success");
  assert.ok(ledger.some((entry) => entry.kind === "review" && entry.outcome === "accept"), "the applied patch passed the adversarial review stage");
  assert.ok(ledger.some((entry) => entry.kind === "confirm" && entry.outcome === "success"), "the paired confirmation recorded the verified gain");
  const attempts = ledger.filter((entry) => entry.kind === "attempt");
  assert.ok(attempts.length > 0 && attempts.some((entry) => entry.editCount > 0), "candidate attempts carried observed diffs");
  assert.ok(result.agentStarts >= 2 && result.agentStarts <= 24, `agent starts ${result.agentStarts} within the campaign grant`);
  assert.ok(result.evaluatorRuns >= 6 && result.evaluatorRuns <= 48, `evaluator runs ${result.evaluatorRuns} within the campaign grant`);
  const after = runSpecCommand(spec, cloneDir);
  assert.equal(after.status, 0, `the applied patch must make ${spec.name} pass: ${after.stderr.slice(0, 400)}`);
  for (const [relative, content] of Object.entries(spec.fixed)) {
    const actual = fs.readFileSync(path.join(cloneDir, relative), "utf8").replace(/\r\n/g, "\n");
    assert.equal(actual, content, `${relative} carries the applied fix`);
  }
}

function reportCosts(t, label, costs) {
  const walls = costs.map((cost) => cost.wallMs).sort((a, b) => a - b);
  const median = walls[Math.floor(walls.length / 2)];
  t.diagnostic(`${label}: repeats=${costs.length} agentStarts=[${costs.map((cost) => cost.agentStarts).join(", ")}] evaluatorRuns=[${costs.map((cost) => cost.evaluatorRuns).join(", ")}] wallMs min/median/max=${walls[0]}/${median}/${walls[walls.length - 1]}`);
}

async function withFixtureDir(prefix, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dream-rsi-e2e-${prefix}-`));
  try {
    return await body(dir);
  } finally {
    if (process.env.DREAM_RSI_E2E_KEEP === "1") console.error(`# kept fixture dir: ${dir}`);
    else fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Win fixtures
// ---------------------------------------------------------------------------

test(`loop wins on fresh clones of the npm fixes fixture (${REPEATS} repeats)`, async (t) => {
  const costs = [];
  for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
    await withFixtureDir("fixes", async (dir) => {
      const run = await executeFixture(FIXTURES.fixes, dir);
      assertVerifiedWin(FIXTURES.fixes, run);
      costs.push({ agentStarts: run.result.agentStarts, evaluatorRuns: run.result.evaluatorRuns, wallMs: run.wallMs });
    });
  }
  reportCosts(t, "fixes (npm)", costs);
});

test("verified multi-file wins continue on the dedicated local auto-commit branch", async (t) => {
  await withFixtureDir("multifix-autocommit", async (dir) => {
    const run = await executeFixture(FIXTURES.multifix, dir, { autoCommit: true });
    assertVerifiedWin(FIXTURES.multifix, run);
    assert.equal(run.result.autoCommits.length, 1, "one verified campaign produces one local commit");
    const receipt = run.result.autoCommits[0];
    assert.equal(receipt.branch, "dream-rsi/improve");
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: run.cloneDir, encoding: "utf8" }).trim(), "dream-rsi/improve");
    assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: run.cloneDir, encoding: "utf8" }).trim(), execFileSync("git", ["rev-parse", `${receipt.hash}^`], { cwd: run.cloneDir, encoding: "utf8" }).trim(), "main remains unchanged");
    assert.deepEqual(execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", receipt.hash], { cwd: run.cloneDir, encoding: "utf8" }).split("\0").filter(Boolean), receipt.files);
    const lastRun = fs.readFileSync(path.join(path.dirname(run.result.budgetPath), "last-run.md"), "utf8");
    assert.match(lastRun, /Last verified win: .+ gain/);
    assert.ok(lastRun.includes(receipt.hash), "the operator summary links the verified commit");
    assert.match(lastRun, /Next action/);
    reportCosts(t, "multifix auto-commit (npm, two files)", [{ agentStarts: run.result.agentStarts, evaluatorRuns: run.result.evaluatorRuns, wallMs: run.wallMs }]);
  });
});

const PYTEST_AVAILABLE = hasTool("python -m pytest --version");
test("loop wins on fresh clones of the pytest fixture", { skip: PYTEST_AVAILABLE ? false : "pytest is not available on PATH" }, async (t) => {
  const costs = [];
  for (let repeat = 1; repeat <= Math.min(REPEATS, 2); repeat += 1) {
    await withFixtureDir("pytest", async (dir) => {
      const run = await executeFixture(FIXTURES.pytest, dir);
      assertVerifiedWin(FIXTURES.pytest, run);
      costs.push({ agentStarts: run.result.agentStarts, evaluatorRuns: run.result.evaluatorRuns, wallMs: run.wallMs });
    });
  }
  reportCosts(t, "pytest (python)", costs);
});

const BUN_AVAILABLE = hasTool("bun --version");
test("loop wins on a bun-backed project with a declared evaluator", { skip: BUN_AVAILABLE ? false : "bun is not available on PATH" }, async (t) => {
  await withFixtureDir("bunlock", async (dir) => {
    const run = await executeFixture(FIXTURES.bunlock, dir);
    assertVerifiedWin(FIXTURES.bunlock, run);
    reportCosts(t, "bunlock (bun via lockfile)", [{ agentStarts: run.result.agentStarts, evaluatorRuns: run.result.evaluatorRuns, wallMs: run.wallMs }]);
  });
});

// ---------------------------------------------------------------------------
// Known-negative
// ---------------------------------------------------------------------------

test("known-negative: noise edits and an out-of-scope cheat apply nothing", async (t) => {
  await withFixtureDir("noise", async (dir) => {
    const run = await executeFixture(FIXTURES.noise, dir, {
      autoCommit: true,
      limits: { maxCampaigns: 2, plateauK: 2 },
      campaignDefaults: { maxCycles: 1 },
    });
    assert.equal(run.result.wins, 0, "no verified win exists in the noise/cheat fixture");
    assert.deepEqual(run.result.autoCommits, [], "unverified candidates never create commits");
    assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: run.cloneDir, encoding: "utf8" }).trim(), execFileSync("git", ["rev-parse", "dream-rsi/improve"], { cwd: run.cloneDir, encoding: "utf8" }).trim(), "the dedicated branch has no commit without a win");
    assert.equal(run.result.campaigns, 2, "both budgeted campaigns ran and rejected");
    assert.equal(run.result.stopReason, "budget");
    assert.ok(run.result.records.every((record) => record.outcome !== "win"));
    for (const record of run.result.records) {
      if (record.campaignRoot) assert.equal(readApplied(record.campaignRoot).length, 0, "nothing is applied");
    }
    // The working tree stays byte-identical where it matters: the out-of-scope cheat never lands.
    const testSource = fs.readFileSync(path.join(run.cloneDir, "test.mjs"), "utf8");
    assert.match(testSource, /NEEDS_FIX/, "the test file was not rewritten by the forged candidate");
    assert.doesNotMatch(testSource, /ALWAYS_OK/);
    assert.match(fs.readFileSync(path.join(run.cloneDir, "src", "parser.js"), "utf8"), /NEEDS_FIX/);
    // The candidate really tried and was stopped by scope, not by inertness: the promotion
    // patch builder saw a real edit to test.mjs (outside the lever's scope) and rejected it.
    const ledger = run.result.records
      .filter((record) => record.campaignRoot && fs.existsSync(path.join(record.campaignRoot, "history", "ledger.jsonl")))
      .flatMap((record) => readLedger(record.campaignRoot));
    assert.ok(ledger.some((entry) => entry.kind === "agent_result" && entry.agentRole === "experiment" && entry.outcome === "success"),
      "the noise candidate ran as a recorded experiment attempt");
    assert.ok(ledger.some((entry) => entry.kind === "skip" && entry.outcome === "rejected"
      && /score|scope/i.test(entry.facts?.reason ?? "")),
      "the candidate was rejected before promotion because it lacked a scoped, measurable gain");
    const after = runSpecCommand(FIXTURES.noise, run.cloneDir);
    assert.notEqual(after.status, 0, "the fixture still fails: nothing was applied");
    t.diagnostic(`noise: agentStarts=${run.result.agentStarts} evaluatorRuns=${run.result.evaluatorRuns} wallMs=${run.wallMs}`);
  });
});

// ---------------------------------------------------------------------------
// Dead-agent circuit breaker
// ---------------------------------------------------------------------------

test("a dead agent stops the loop after three consecutive errored attempts", async (t) => {
  await withFixtureDir("breaker", async (dir) => {
    const run = await executeFixture(FIXTURES.breaker, dir, {
      limits: { maxCampaigns: 1, maxAgentStarts: 12, maxEvaluatorRuns: 60, deadlineMs: 600_000 },
      campaignDefaults: { maxCycles: 2, maxAgentStarts: 12, maxEvaluatorRuns: 60, deadlineMs: 600_000 },
    });
    assert.equal(run.result.stopCode, "blocked", `stop: ${run.result.stopReason}; records: ${JSON.stringify(run.result.records)}`);
    assert.match(run.result.stopReason, /3 consecutive non-editing agent attempts/);
    assert.match(run.result.stopReason, /command ".*node.*" model "fixture\/breaker"/,
      "the stop names the command and effective model");
    const failed = run.result.records.find((record) => record.outcome === "error");
    assert.ok(failed?.campaignRoot, "the failed campaign retains its root for diagnosis");
    const attempts = readLedger(failed.campaignRoot).filter((entry) => entry.kind === "attempt");
    assert.equal(attempts.length, 3, "the breaker stops at the third errored attempt");
    assert.ok(attempts.every((entry) => entry.outcome === "agent_error" && entry.editCount === 0),
      `each attempt is classified as a non-editing agent error: ${JSON.stringify(attempts)}`);
    assert.doesNotMatch(fs.readFileSync(path.join(run.cloneDir, "src", "parser.js"), "utf8"), /FIXED/,
      "no candidate was applied");
    t.diagnostic(`breaker: agentStarts=${run.result.agentStarts} evaluatorRuns=${run.result.evaluatorRuns} wallMs=${run.wallMs}`);
  });
});

// ---------------------------------------------------------------------------
// Held-out fixture (first observation is the acceptance sweep)
// ---------------------------------------------------------------------------

test("held-out nested fixture wins from a fresh clone", { skip: HELDOUT ? false : "set DREAM_RSI_HELDOUT=1 for the held-out acceptance run" }, async (t) => {
  await withFixtureDir("heldout", async (dir) => {
    const run = await executeFixture(FIXTURES.heldout, dir);
    assertVerifiedWin(FIXTURES.heldout, run);
    reportCosts(t, "heldout (npm, nested, noise signals)", [{ agentStarts: run.result.agentStarts, evaluatorRuns: run.result.evaluatorRuns, wallMs: run.wallMs }]);
  });
});

/** Deterministic PRNG: one seed reproduces exactly one fixture. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The fixed held-out mechanism (a marker the test command scans for) with every
 * identifier randomized from the seed: directory names, file names, the marker
 * and the package name. No path or answer in it can be special-cased in advance.
 */
function randomizedHeldoutFixture(seed) {
  const random = mulberry32(seed);
  const token = (length) => Array.from({ length }, () => Math.floor(random() * 36).toString(36)).join("");
  const marker = `NEEDS_FIX_${token(8).toUpperCase()}`;
  const roots = ["zephyr", "quill", "marrow"].map((name) => `${name}-${token(4)}`);
  const targets = roots.map((root, index) => `${root}/src/unit-${index + 1}-${token(3)}.mjs`);
  const checkScript = `scripts/check-${token(5)}.mjs`;
  const files = {
    "package.json": `${JSON.stringify({ name: `loop-e2e-${token(6)}`, private: true, scripts: { test: `node ${checkScript}`, "test:gate": "node scripts/gate.mjs" } }, null, 2)}\n`,
    [checkScript]: `import { readFileSync } from "node:fs";
const paths = ${JSON.stringify(targets)};
const broken = paths.filter((file) => readFileSync(file, "utf8").includes(${JSON.stringify(marker)}));
process.exit(broken.length === 0 ? 0 : 1);
`,
    "scripts/gate.mjs": `import { readFileSync } from "node:fs";\nconst paths = ${JSON.stringify(targets)};\nif (!paths.every((file) => readFileSync(file, "utf8").includes("export const"))) process.exit(1);\n`,
    [`notes-${token(4)}.md`]: "review notes\n",
  };
  const fixed = {};
  targets.forEach((target, index) => {
    files[target] = `// ${marker}\nexport const unit${index + 1} = () => ${index + 1};\n`;
    fixed[target] = `// FIXED\nexport const unit${index + 1} = () => ${index + 1};\n`;
  });
  return {
    name: `heldout-random-${seed}`,
    files,
    fixed,
    replacements: [[`// ${marker}`, "// FIXED"]],
    sessionCommand: "npm test",
    editTargets: targets.flatMap((target) => [target, target]),
    verify: { command: "npm", args: ["test"], shim: true },
  };
}

test("held-out randomized instance wins from a fresh clone", { skip: HELDOUT ? false : "set DREAM_RSI_HELDOUT=1 for the held-out acceptance run" }, async (t) => {
  const envSeed = Number(process.env.DREAM_RSI_HELDOUT_SEED);
  const seed = Number.isSafeInteger(envSeed) && envSeed > 0 ? envSeed : Math.floor(Math.random() * 0x7FFFFFFF);
  const spec = randomizedHeldoutFixture(seed);
  t.diagnostic(`heldout-random: seed=${seed} fixture=${spec.name}`);
  await withFixtureDir("heldout-random", async (dir) => {
    const run = await executeFixture(spec, dir);
    assertVerifiedWin(spec, run);
    reportCosts(t, `heldout-random (npm, seed ${seed})`, [{ agentStarts: run.result.agentStarts, evaluatorRuns: run.result.evaluatorRuns, wallMs: run.wallMs }]);
  });
});
