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
    assert.deepEqual(loop.parameters.properties.action.enum, ["start", "status", "stop", "resume"]);
    assert.equal(loop.parameters.properties.include_logs.type, "boolean", "the loop retains its session-log privacy opt-out");
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

test("task defaults contain no removed policy controls", () => {
  const defaults = defaultTask();
  for (const field of ["workers", "max_loops", "k1", "k2", "revisions", "beta1", "beta2", "beta_grid", "default_beta", "work_retention"]) {
    assert.equal(field in defaults, false, field);
  }
  const migrated = normalizeTask({ ...defaults, workers: 4, beta_grid: [0, 0.5] });
  assert.equal("workers" in migrated, false);
  assert.equal("beta_grid" in migrated, false);
});
