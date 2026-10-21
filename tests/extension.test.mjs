import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { makeProject, mockPi } from "./fixtures.mjs";

const { default: dreamRsi } = await import("../extensions/pi-dream-rsi/index.ts");
const { defaultTask, normalizeTask } = await import("../extensions/pi-dream-rsi/engine/task.ts");
const { normalizeRunContract, approveRunContract, contractFile } = await import("../extensions/pi-dream-rsi/engine/intake.ts");

async function boot(project) {
  const { pi, context, harness } = mockPi();
  dreamRsi(pi);
  context.cwd = project.projectDir;
  await harness.handlers.get("session_start")({}, context);
  return { context, harness };
}

test("registers assessment and loop tools with the v3 command surface", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    assert.deepEqual([...harness.tools.keys()], ["dream_rsi_signals", "dream_rsi_loop"]);
    assert.deepEqual([...harness.commands.keys()], ["dream-rsi"]);
    const loop = harness.tools.get("dream_rsi_loop");
    assert.deepEqual(loop.parameters.properties.action.enum, ["start", "status", "stop", "resume", "confirm"]);
    assert.equal(loop.parameters.properties.include_logs.type, "boolean", "the loop retains its session-log privacy opt-out");
    assert.deepEqual(loop.parameters.properties.evaluator_bootstrap.required, ["authorized", "paths"], "bootstrap requires explicit authorization and an exact path allowlist");
    assert.equal(loop.parameters.additionalProperties, false);
    const resources = await harness.handlers.get("resources_discover")({ cwd: project.projectDir, reason: "startup" }, null);
    const root = resources.skillPaths[0];
    for (const skill of ["dream-rsi", "dream-rsi-assess", "dream-rsi-loop"]) {
      assert.ok(path.join(root, skill, "SKILL.md"));
    }
    assert.equal(fs.existsSync(path.join(root, "dream-rsi-improve")), false);
    await harness.commands.get("dream-rsi").handler("improve parser", context);
    assert.match(harness.notifications.at(-1), /removed in 3\.0.*use \/dream-rsi loop/i);
    await harness.commands.get("dream-rsi").handler("start", context);
    assert.match(harness.notifications.at(-1), /removed in 3\.0.*use \/dream-rsi loop/i);
  } finally {
    project.cleanup();
  }
});

test("loop start requires trusted-local consent before creating state", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const loop = harness.tools.get("dream_rsi_loop");
    const missing = await loop.execute("missing-consent", { action: "start", focus: "reduce runtime" }, undefined, undefined, context);
    assert.match(missing.content[0].text, /consent must be true/);
    const declined = await loop.execute("declined-consent", { action: "start", consent: false, focus: "reduce runtime" }, undefined, undefined, context);
    assert.match(declined.content[0].text, /consent must be true/);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
  } finally {
    project.cleanup();
  }
});

test("a start without contract fields reuses the stored contract and its durable limits", async () => {
  const project = makeProject();
  try {
    const stored = normalizeRunContract({
      version: 1,
      outcome: { statement: "stored objective", unit: "ms", higherIsBetter: false, minimumUsefulGain: "10%" },
      preserved: { gates: [] }, scope: { roots: [], protectedAssets: [] },
      execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test"] },
      models: { providers: ["local"] },
      budgets: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 20, deadlineMs: 600_000, falseAcceptBudget: 0.1 },
    });
    const approved = approveRunContract(project.projectDir, stored);
    const loopRoot = path.join(project.dreamRoot, "loop");
    fs.mkdirSync(loopRoot, { recursive: true });
    fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...approved }, null, 2)}\n`);
    const { context, harness } = await boot(project);
    const signal = new AbortController();
    signal.abort();
    const result = await harness.tools.get("dream_rsi_loop").execute("reuse-contract", {
      action: "start", consent: true,
    }, signal.signal, undefined, context);
    assert.equal(result.details.loop.contract.fingerprint, approved.fingerprint);
    const budget = JSON.parse(fs.readFileSync(path.join(loopRoot, "budget.json"), "utf8"));
    assert.equal(budget.max_campaigns, 2);
    assert.equal(budget.max_agent_starts, 10);
    assert.equal(budget.max_evaluator_runs, 20);
  } finally {
    project.cleanup();
  }
});

test("authorized extension bootstrap creates and executes its pinned benchmark before ranking", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const initialPackage = JSON.stringify({ name: "bootstrap-integration", scripts: { test: "node -e 0", benchmark: "node bench.mjs" } });
  fs.writeFileSync(path.join(project.projectDir, "package.json"), initialPackage);
  fs.writeFileSync(path.join(project.projectDir, "bench.mjs"), "throw new Error('broken initial benchmark');\n");
  const agentScript = path.join(project.projectDir, "bootstrap-agent.mjs");
  fs.writeFileSync(agentScript, `import { readFileSync, writeFileSync } from "node:fs";\nprocess.stdin.resume();\nprocess.stdin.on("end", () => {\n  const pkg = JSON.parse(readFileSync("package.json", "utf8"));\n  pkg.scripts.benchmark = "node bench.mjs";\n  writeFileSync("package.json", JSON.stringify(pkg));\n  writeFileSync("bench.mjs", "console.log('pinned benchmark ran');\\n");\n});\n`);
  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("bootstrap", {
    action: "start", consent: true, focus: "Measure deterministic pinned benchmark runtime", unit: "ms", higher_is_better: false,
    minimum_gain: "50%", scope_roots: [], gates: ["node -e 0"], command_categories: ["test", "benchmark"],
    agent_command: process.execPath, agent_args: [agentScript],
    evaluator_bootstrap: { authorized: true, paths: ["package.json", "bench.mjs"] },
    max_campaigns: 1, max_agent_starts: 5, max_evaluator_runs: 30, deadline_minutes: 2,
  }, undefined, undefined, context);
  const loop = result.details.loop;
  const parameterSchema = harness.tools.get("dream_rsi_loop").parameters.properties;
  for (const key of ["action", "consent", "focus", "unit", "higher_is_better", "minimum_gain", "scope_roots", "gates", "command_categories", "agent_command", "agent_args", "evaluator_bootstrap", "max_campaigns", "max_agent_starts", "max_evaluator_runs", "deadline_minutes"]) {
    assert.ok(key in parameterSchema, `integration input uses a registered parameter: ${key}`);
  }
  assert.equal(fs.existsSync(path.join(project.projectDir, "bench.mjs")), true, result.content[0].text);
  assert.equal(fs.readFileSync(path.join(project.projectDir, "package.json"), "utf8"), initialPackage, "unchanged allowlisted manifests are validated without requiring a rewrite");
  assert.ok(loop.preflightEvaluatorRuns >= 1, "the bootstrapped benchmark is measured during discovery");
  assert.ok(loop.preflight.checks.some((check) => check.name === "workload" && check.status === "passed"), `${loop.stopCode}: ${loop.stopReason}; ${JSON.stringify(loop.preflight)}`);
  assert.equal(loop.campaignEvaluatorRuns, 0, "benchmark bootstrap and discovery happen before campaign launch");
  assert.equal(loop.campaigns, 0, "an ineffective oracle cannot qualify as a correctness gate");
  assert.equal(loop.stopCode, "blocked", "unusable qualification instrumentation is not no-verifiable-lever");
  assert.equal(loop.preflight.status, "blocked");
  assert.ok(loop.preflight.checks.some((check) => check.name === "gates" && check.status === "blocked"));
  assert.match(loop.stopReason, /oracle|gate|correctness/i);
  const budget = JSON.parse(fs.readFileSync(loop.budgetPath, "utf8"));
  assert.equal(budget.phases.qualification.agent_starts, 1, "bootstrap agent use is charged before dispatch");
  assert.equal(budget.phases.discovery.evaluator_runs + budget.phases.qualification.evaluator_runs, loop.preflightEvaluatorRuns);
});

test("task defaults contain no removed policy controls", () => {
  const defaults = defaultTask();
  for (const field of ["workers", "max_loops", "k1", "k2", "revisions", "beta1", "beta2", "beta_grid", "default_beta", "work_retention"]) {
    assert.equal(field in defaults, false, field);
  }
  const migrated = normalizeTask({ ...defaults, workers: 4, beta_grid: [0, 0.5] });
  assert.equal("workers" in migrated, false);
  assert.equal("beta_grid" in migrated, false);
});
