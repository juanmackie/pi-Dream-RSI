import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { makeProject, mockPi } from "./fixtures.mjs";

const { default: dreamRsi, campaignUpdate } = await import("../extensions/pi-dream-rsi/index.ts");
const { defaultTask, normalizeTask } = await import("../extensions/pi-dream-rsi/engine/task.ts");
const { normalizeRunContract, approveRunContract, contractFile } = await import("../extensions/pi-dream-rsi/engine/intake.ts");
const { runCampaign } = await import("../extensions/pi-dream-rsi/engine/campaign.ts");
const { readOrCreateLoopBudget } = await import("../extensions/pi-dream-rsi/engine/budget.ts");

function saveLoopApproval(project) {
  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "Optimize CAD rendering", unit: "ms", higherIsBetter: false, minimumUsefulGain: "10%" },
    preserved: { gates: ["node src/check.mjs"] }, scope: { roots: ["src"], protectedAssets: ["src/fixtures"] },
    execution: { consent: true, envAllowlist: ["LANG"], allowedCommandCategories: ["test", "benchmark"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 20, deadlineMs: 600_000, falseAcceptBudget: 0.01 },
  });
  const loopRoot = path.join(project.dreamRoot, "loop");
  fs.mkdirSync(loopRoot, { recursive: true });
  fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...approveRunContract(project.projectDir, contract) })}\n`);
  return { contract, loopRoot };
}

async function boot(project) {
  const { pi, context, harness } = mockPi();
  dreamRsi(pi);
  context.cwd = project.projectDir;
  await harness.handlers.get("session_start")({}, context);
  return { context, harness };
}

async function preparePausedLoop(project) {
  const result = await runCampaign({
    baseRoot: project.dreamRoot, projectDir: project.projectDir, task: project.task,
    goal: "Increase valid markers for the loop lifecycle fixture.", scope: ["solution.py"],
    verifierInputs: [project.script("score-ok.mjs")],
    limits: { maxCycles: 1, maxAgentStarts: 18, maxEvaluatorRuns: 48, deadlineMs: 60_000 },
  });
  const recordPath = path.join(result.campaignRoot, "campaign.json");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.state = { kind: "paused", phase: "experiment", iteration: 1, reason: "fixture resume" };
  record.pendingConfirmation = {
    iteration: 1, candidate: { cell: "fixture-cell" }, patch: [], patchHash: "fixture-hash",
    evidenceDir: path.join(result.campaignRoot, "history"), confirmationIdentity: "fixture-identity",
    targetDigest: "fixture-digest", pairs: 1, maxPairs: 2,
  };
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  const budgets = { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 40, deadlineMs: 600_000 };
  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "fixture loop resume", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%" },
    preserved: { gates: [] }, scope: { roots: [], protectedAssets: [] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test"] },
    models: { providers: ["local"] },
    budgets: { ...budgets, falseAcceptBudget: 0.1 },
  });
  const loopRoot = path.join(project.dreamRoot, "loop");
  fs.mkdirSync(loopRoot, { recursive: true });
  const approved = approveRunContract(project.projectDir, contract);
  fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...approved }, null, 2)}\n`);
  readOrCreateLoopBudget(path.join(loopRoot, "budget.json"), budgets);
}

function waitFor(predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for the detached loop"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("registers assessment and loop tools with the v3 command surface", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    assert.deepEqual([...harness.tools.keys()], ["dream_rsi_signals", "dream_rsi_loop"]);
    assert.deepEqual([...harness.commands.keys()], ["dream-rsi"]);
    const loop = harness.tools.get("dream_rsi_loop");
    assert.deepEqual(loop.parameters.properties.action.enum, ["prepare", "start", "status", "stop", "resume", "confirm"]);
    assert.equal(loop.parameters.properties.include_logs.type, "boolean", "the loop retains its session-log privacy opt-out");
    assert.deepEqual(loop.parameters.properties.commit_policy.enum, ["commit-per-accepted-change", "squash-per-campaign", "no-commit"]);
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
    const missing = await loop.execute("missing-consent", { action: "start", replace_contract: true, focus: "reduce runtime" }, undefined, undefined, context);
    assert.match(missing.content[0].text, /consent must be true/);
    const declined = await loop.execute("declined-consent", { action: "start", consent: false, replace_contract: true, focus: "reduce runtime" }, undefined, undefined, context);
    assert.match(declined.content[0].text, /consent must be true/);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
  } finally {
    project.cleanup();
  }
});

test("a natural-language loop command owns preparation without writing loop state", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { context, harness } = await boot(project);
  context.hasUI = false; context.mode = "tui"; harness.idle = false;
  const handler = harness.commands.get("dream-rsi").handler;
  await handler('loop "reduce startup time" --consent --no-logs --replace-contract', context);
  const message = harness.sentMessages.at(-1);
  assert.match(message.content, /^\/skill:dream-rsi-loop/);
  assert.equal(message.options.expandPromptTemplates, true);
  assert.equal(message.options.deliverAs, "followUp", "busy sessions queue preparation, not an engine run");
  const request = JSON.parse(message.content.slice(message.content.indexOf("{")));
  assert.equal(request.focus, "reduce startup time");
  assert.equal(request.include_logs, false);
  assert.equal(request.project_dir, project.projectDir);
  assert.equal(request.consent, true);
  assert.equal(request.replacement_requested, true, "a request to replace is not approval of an unseen proposal");
  assert.equal(typeof request.preparation_id, "string");
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
  const status = await harness.tools.get("dream_rsi_loop").execute("preparing", { action: "status" }, undefined, undefined, context);
  assert.equal(status.details.activity.phase, "preparation");
  await handler("loop another goal --consent", context);
  assert.equal(harness.sentMessages.length, 1, "a duplicate command cannot replace queued preparation");
  assert.match(harness.notifications.at(-1), /already.*prepar|already running/i);
  await handler("stop", context);
  const stale = await harness.tools.get("dream_rsi_loop").execute("stale", { action: "start", consent: true, preparation_id: request.preparation_id }, undefined, undefined, context);
  assert.equal(stale.details.ok, false);
  assert.match(stale.content[0].text, /preparation.*expired|preparation.*cancelled/i);
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "a queued handoff cannot start after Stop");
});

test("prepared settings use the guarded tool path and reach a local campaign", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  fs.mkdirSync(path.join(project.projectDir, "src"));
  fs.mkdirSync(path.join(project.projectDir, "scripts"));
  fs.writeFileSync(path.join(project.projectDir, "src/work.mjs"), "export const answer = () => 7;\n");
  fs.writeFileSync(path.join(project.projectDir, "scripts/measure.mjs"), 'import { answer } from "../src/work.mjs"; console.log(JSON.stringify({score: answer(), valid: answer() === 7}));\n');
  fs.writeFileSync(path.join(project.projectDir, "scripts/check.mjs"), 'import { answer } from "../src/work.mjs"; if(answer() !== 7) process.exit(1);\n');
  fs.writeFileSync(path.join(project.projectDir, "noop-agent.mjs"), 'process.stdin.resume(); process.stdin.on("end", () => console.log("ok"));\n');
  const { context, harness } = await boot(project);
  await harness.commands.get("dream-rsi").handler("loop increase the answer score without changing correctness --consent --no-logs", context);
  const message = harness.sentMessages.at(-1).content;
  const request = JSON.parse(message.slice(message.indexOf("{")));
  const tool = harness.tools.get("dream_rsi_loop");
  const discovered = await tool.execute("find-instrument", { action: "prepare", focus: request.focus, unit: "points", higher_is_better: true }, undefined, undefined, context);
  const existing = discovered.details.measurementOptions.scripts.find(script => script.source === "scripts/measure.mjs");
  assert.ok(existing, "standalone evaluator is visible without a manifest benchmark");
  assert.equal(existing.outputHint, "stdout-json");
  assert.ok(existing.implementationFiles.includes("src/work.mjs"));
  assert.equal(existing.qualification, "not-run");
  assert.equal(discovered.details.measurementOptions.recommendation, "inspect-existing-instruments");
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "instrument discovery does not execute or approve it");
  context.sessionManager.getSessionDir = () => { throw new Error("session logs must not be accessed after --no-logs"); };
  await harness.tools.get("dream_rsi_signals").execute("privacy", { include_logs: true }, undefined, undefined, context);
  for (const patch of [{ project_dir: project.dir }, { focus: "a different objective" }, { preparation_id: undefined }]) {
    const rejected = await tool.execute("wrong-handoff", { action: "start", consent: true, preparation_id: request.preparation_id, ...patch }, undefined, undefined, context);
    assert.equal(rejected.details.ok, false);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
  }
  const incomplete = await tool.execute("incomplete", { action: "start", consent: true, preparation_id: request.preparation_id }, undefined, undefined, context);
  assert.equal(incomplete.details.ok, false);
  assert.match(incomplete.content[0].text, /prepared settings.*unit|preparation.*unit/i);
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "incomplete preparation cannot record an approval or spend");
  const disabledBootstrap = await tool.execute("disabled-bootstrap", {
    action: "start", consent: true, preparation_id: request.preparation_id,
    unit: "ms", higher_is_better: false, scope_roots: ["src"], protected_assets: [], gates: [],
    evaluator_bootstrap: { authorized: false, paths: ["unused.mjs"] },
  }, undefined, undefined, context);
  assert.equal(disabledBootstrap.details.ok, false, "a disabled bootstrap is not an approved instrument/setup/discovery choice");
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "a disabled setup cannot trigger default discovery");
  const prepared = {
    action: "start", consent: true, preparation_id: request.preparation_id,
    focus: request.focus, unit: "points", higher_is_better: true,
    evaluator: { argv: [process.execPath, "scripts/measure.mjs"], output: "stdout-json", inputs: ["scripts/measure.mjs"] },
    scope_roots: ["src"], gates: ["node scripts/check.mjs"], protected_assets: ["scripts"],
    include_logs: true, agent_command: process.execPath, agent_args: [path.join(project.projectDir, "noop-agent.mjs")],
    max_campaigns: 1, max_agent_starts: 14, max_evaluator_runs: 60, deadline_minutes: 30,
  };
  const review = await tool.execute("review-prepared", prepared, undefined, undefined, context);
  assert.equal(review.details.needsApproval, true, "host consent does not approve an unseen proposal");
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
  const waiting = await tool.execute("review-status", { action: "status" }, undefined, undefined, context);
  assert.equal(waiting.details.activity.state, "awaiting-approval");
  assert.match(waiting.content[0].text, /Pending proposal:.*not a saved approval/);
  assert.match(waiting.content[0].text, /scope: src; metric: points/);
  fs.appendFileSync(path.join(project.projectDir, "src/work.mjs"), "// source changed during review\n");
  const stale = await tool.execute("stale-proposal", { ...prepared, approve_proposal: true, proposal_id: review.details.proposal_id }, undefined, undefined, context);
  assert.equal(stale.details.needsApproval, true, "source changes invalidate a reviewed proposal");
  assert.notEqual(stale.details.proposal_id, review.details.proposal_id);
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
  const result = await tool.execute("prepared", { ...prepared, approve_proposal: true, proposal_id: stale.details.proposal_id }, undefined, undefined, context);
  assert.equal(result.details.loop.campaigns, 1, result.content[0].text);
  assert.equal(result.details.loop.wins, 0, "a no-op fixture cannot fabricate a win");
  const saved = JSON.parse(fs.readFileSync(path.join(project.dreamRoot, "loop/contract.json"), "utf8")).contract;
  assert.equal(saved.outcome.statement, request.focus);
  assert.deepEqual(saved.scope.roots, ["src"]);
  const status = await tool.execute("finished", { action: "status" }, undefined, undefined, context);
  assert.equal(status.details.activity, null, "the handoff releases its slot after engine work finishes");
  const replay = await tool.execute("replay", { action: "start", consent: true, preparation_id: request.preparation_id }, undefined, undefined, context);
  assert.equal(replay.details.ok, false, "a preparation ID is single use");
});

test("preparation corrections are bounded and never execute or renew a budget", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { context, harness } = await boot(project);
  await harness.commands.get("dream-rsi").handler("loop Reduce runtime --consent --no-logs", context);
  const message = harness.sentMessages.at(-1).content;
  const request = JSON.parse(message.slice(message.indexOf("{")));
  const tool = harness.tools.get("dream_rsi_loop");
  for (const remaining of [2, 1, 0]) {
    const result = await tool.execute("invalid-proposal", { action: "start", consent: true, preparation_id: request.preparation_id }, undefined, undefined, context);
    assert.equal(result.details.remaining_preparation_attempts, remaining);
    assert.equal(result.details.recovery.category, "configuration");
    assert.equal(result.details.recovery.automatic_retries, 0);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
  }
  const stale = await tool.execute("no-more-retries", { action: "start", consent: true, preparation_id: request.preparation_id }, undefined, undefined, context);
  assert.match(stale.content[0].text, /expired|cancelled/);
  const status = await tool.execute("after-invalid", { action: "status" }, undefined, undefined, context);
  assert.equal(status.details.activity, null);
});

test("headless config consent preserves complete settings in a cancellable handoff", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { context, harness } = await boot(project);
  const settings = { focus: "Reduce configured runtime", unit: "ms", higher_is_better: false,
    evaluator: { argv: ["node", "scripts/measure.mjs"], output: "stdout-json" },
    scope_roots: ["src"], gates: ["node scripts/check.mjs"], protected_assets: ["fixtures"],
    agent_command: process.execPath, agent_args: ["local-agent.mjs"], max_campaigns: 1, max_agent_starts: 8, max_evaluator_runs: 20, deadline_minutes: 2 };
  fs.writeFileSync(path.join(project.projectDir, "settings with spaces.json"), JSON.stringify(settings));
  await harness.commands.get("dream-rsi").handler('loop --config "settings with spaces.json" --replace-contract --no-logs', context);
  const message = harness.sentMessages.at(-1).content;
  assert.match(message, /^\/skill:dream-rsi-loop/);
  const request = JSON.parse(message.slice(message.indexOf("{")));
  assert.deepEqual(request.proposed_settings, settings);
  assert.equal(request.focus, settings.focus);
  assert.equal(request.consent, false);
  assert.equal(request.include_logs, false);
  assert.equal(request.replacement_requested, true);
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
  await harness.commands.get("dream-rsi").handler("stop", context);
  const expired = await harness.tools.get("dream_rsi_loop").execute("old-config", { ...settings, action: "start", consent: true, preparation_id: request.preparation_id }, undefined, undefined, context);
  assert.equal(expired.details.ok, false);
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
});

test("setup review binds write policy but not irrelevant JSON key order", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { context, harness } = await boot(project);
  const tool = harness.tools.get("dream_rsi_loop");
  const generated = await tool.execute("generated-plan", { action: "prepare", setup_harness: true,
    focus: "Reduce runtime", unit: "ms", higher_is_better: false, scope_roots: ["seed"] }, undefined, undefined, context);
  assert.ok(generated.content[0].text.includes(generated.details.proposal_id), "the model-facing text includes the actionable full digest");
  assert.ok(generated.content[0].text.includes('"settings"'), "unexpanded reusable settings are model-visible, not only UI metadata");
  const roundTrip = await tool.execute("repeat-generated-plan", { ...generated.details.proposal.settings, action: "prepare" }, undefined, undefined, context);
  assert.equal(roundTrip.details.proposal_id, generated.details.proposal_id, "preview settings can be submitted again without conflicting expanded setup fields");
  const customSettings = { ...generated.details.proposal.params };
  delete customSettings.setup_harness;
  delete customSettings.harness_language;
  const custom = await tool.execute("custom-plan", customSettings, undefined, undefined, context);
  assert.notEqual(custom.details.proposal_id, generated.details.proposal_id, "create-only and overwrite-capable setup cannot share an approval");
  assert.equal(generated.details.proposal.setup.writePolicy, "create-only");
  assert.equal(custom.details.proposal.setup.writePolicy, "replace-authorized");
  const reordered = await tool.execute("reordered-plan", { ...customSettings, evaluator_bootstrap: { paths: customSettings.evaluator_bootstrap.paths, authorized: true } }, undefined, undefined, context);
  assert.equal(reordered.details.proposal_id, custom.details.proposal_id, "object key order has no executable meaning");
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
});

test("exhausted budget recovery is consistent live and after status reload", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  const file = path.join(loopRoot, "budget.json");
  const budget = readOrCreateLoopBudget(file, contract.budgets);
  fs.writeFileSync(file, JSON.stringify({ ...budget, campaigns: budget.max_campaigns }));
  const { context, harness } = await boot(project);
  const tool = harness.tools.get("dream_rsi_loop");
  const result = await tool.execute("spent", { action: "start", consent: true, include_logs: false }, undefined, undefined, context);
  assert.equal(result.details.loop.stopCode, "budget-exhausted");
  assert.equal(result.details.recovery.category, "budget");
  assert.equal(result.details.loop.agentStarts, 0);
  assert.equal(result.details.loop.evaluatorRuns, 0);
  const status = await tool.execute("spent-status", { action: "status" }, undefined, undefined, context);
  assert.match(status.content[0].text, /Historical recovery: budget/);
});

test("a branch change during initial consent cannot queue preparation", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { context, harness } = await boot(project);
  context.hasUI = true;
  let answer;
  context.ui.confirm = () => new Promise(resolve => { answer = resolve; });
  const running = harness.commands.get("dream-rsi").handler("loop Optimize routing --no-logs", context);
  await waitFor(() => answer !== undefined);
  await harness.handlers.get("session_tree")({}, context);
  answer(true);
  await running;
  assert.equal(harness.sentMessages.length, 0, "consent from an abandoned branch cannot create a live handoff");
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
});

test("a branch change during prepared replacement approval cancels startup", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  const before = fs.readFileSync(contractFile(loopRoot), "utf8");
  const { context, harness } = await boot(project);
  context.hasUI = true;
  await harness.commands.get("dream-rsi").handler("loop Optimize routing --consent --no-logs", context);
  const message = harness.sentMessages.at(-1).content;
  const request = JSON.parse(message.slice(message.indexOf("{")));
  let answer;
  context.ui.select = () => new Promise(resolve => { answer = resolve; });
  const running = harness.tools.get("dream_rsi_loop").execute("prepared-approval", {
    action: "start", consent: true, preparation_id: request.preparation_id,
    focus: request.focus, unit: "ms", higher_is_better: false,
    scope_roots: contract.scope.roots, protected_assets: contract.scope.protectedAssets,
    gates: contract.preserved.gates, command_categories: contract.execution.allowedCommandCategories,
  }, undefined, undefined, context);
  await waitFor(() => answer !== undefined);
  await harness.handlers.get("session_tree")({}, context);
  answer("Approve replacement");
  const result = await running;
  assert.equal(fs.readFileSync(contractFile(loopRoot), "utf8"), before, "approval from an abandoned branch cannot replace the contract");
  assert.equal(fs.existsSync(path.join(loopRoot, "budget.json")), false, "cancellation before engine start creates no durable budget");
  assert.match(result.content[0].text, /stopped|cancelled/i);
});

for (const event of ["session_shutdown", "session_tree"]) test(`preparation expires on ${event}`, async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { context, harness } = await boot(project);
  await harness.commands.get("dream-rsi").handler("loop optimize the fixture --consent --no-logs", context);
  const message = harness.sentMessages.at(-1).content;
  const request = JSON.parse(message.slice(message.indexOf("{")));
  await harness.handlers.get(event)({}, context);
  const result = await harness.tools.get("dream_rsi_loop").execute("old-branch", { action: "start", consent: true, preparation_id: request.preparation_id }, undefined, undefined, context);
  assert.equal(result.details.ok, false);
  assert.match(result.content[0].text, /preparation.*expired|preparation.*cancelled/i);
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
});

test("an explicit settings command still starts directly without a model handoff", async () => {
  const project = makeProject();
  const empty = path.join(project.dir, "empty");
  fs.mkdirSync(empty);
  try {
    const { context, harness } = await boot(project);
    context.cwd = empty;
    context.hasUI = false;
    context.mode = "tui";
    fs.writeFileSync(path.join(empty, "settings.json"), "{}");
    await harness.commands.get("dream-rsi").handler("loop reduce startup time --config settings.json --consent --no-logs", context);
    assert.equal(harness.sentMessages.length, 0, "no chat message asks an LLM to call dream_rsi_loop");
    assert.equal(harness.uiPrompts.length, 0, "an explicit flag needs no dialog");
    await waitFor(() => harness.injectedMessages.some((entry) => entry.message.customType === "dream-rsi/loop"));
    const finished = harness.injectedMessages.find((entry) => entry.message.customType === "dream-rsi/loop").message.content;
    assert.match(finished, /Dream-RSI loop finished/);
    assert.ok(harness.entries.some((entry) => entry.customType === "pi-dream-rsi/mode" && entry.data?.active === true),
      "the command enters loop mode before the detached run");
    assert.equal(harness.statuses.at(-1)?.[1], "dream-rsi: active",
      "the status returns to the normal active state after the loop finishes");
  } finally {
    project.cleanup();
  }
});

test("a tool-started TUI loop animates and the tool stop cancels it", async () => {
  const project = makeProject();
  fs.writeFileSync(path.join(project.projectDir, "bench.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync('bench.started', 'yes'); setTimeout(() => {}, 60000);\n");
  fs.writeFileSync(path.join(project.projectDir, "package.json"), `${JSON.stringify({
    name: "tool-loop", private: true, scripts: { benchmark: "node bench.mjs" },
  }, null, 2)}\n`);
  let context;
  let harness;
  let tool;
  let run;
  let settled = false;
  try {
    ({ context, harness } = await boot(project));
    context.hasUI = false;
    context.mode = "tui";
    tool = harness.tools.get("dream_rsi_loop");
    run = tool.execute("tool-start", { action: "start", consent: true, include_logs: false }, undefined, undefined, context);
    run.then(() => { settled = true; }, () => { settled = true; });
    await waitFor(() => fs.existsSync(path.join(project.projectDir, "bench.started")));
    await waitFor(() => harness.statuses.filter(([, status]) => /dream-rsi: [◳◲◱◰] looping/.test(status ?? "")).length >= 2);
    const live = await tool.execute("tool-status", { action: "status" }, undefined, undefined, context);
    assert.match(live.content[0].text, /Active loop: running/);
    assert.match(live.content[0].text, /phase: discovery/);
    assert.match(live.content[0].text, /probing/i);
    assert.doesNotMatch(live.content[0].text, /No active campaign\./, "a missing campaign must not hide active preflight work");
    const leasePath = path.join(project.dreamRoot, "loop/lease.json");
    const leaseBeforeRead = fs.readFileSync(leasePath, "utf8");
    const observer = await boot(project);
    const observed = await observer.harness.tools.get("dream_rsi_loop").execute("other-session-status", { action: "status" }, undefined, undefined, observer.context);
    assert.match(observed.content[0].text, /Active loop: running; phase: discovery/);
    assert.match(observed.content[0].text, /probing/i);
    assert.equal(fs.readFileSync(leasePath, "utf8"), leaseBeforeRead, "observing live work never rewrites its lease");
    const watching = harness.commands.get("dream-rsi").handler("watch", context);
    await waitFor(() => harness.customViews.length > 0);
    const watch = harness.customViews.at(-1).view;
    try {
      const visible = watch.render(100).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      assert.match(visible, /Active loop: running/);
      assert.match(visible, /discovery/);
    } finally { watch.handleInput("\x1b"); await watching; }
    const stopped = await tool.execute("tool-stop", { action: "stop" }, undefined, undefined, context);
    assert.match(stopped.content[0].text, /asked to stop/i);
    const stopping = await tool.execute("stopping-status", { action: "status" }, undefined, undefined, context);
    assert.match(stopping.content[0].text, /Active loop: stopping/);
    const result = await run;
    assert.match(result.content[0].text, /cancelled/i);
    assert.equal(harness.statuses.at(-1)?.[1], "dream-rsi: active", "the indicator is restored after tool cancellation");
    const finished = await tool.execute("finished-status", { action: "status" }, undefined, undefined, context);
    assert.doesNotMatch(finished.content[0].text, /Active loop: running/);
    assert.match(finished.content[0].text, /Previous run report.*cancelled/);
  } finally {
    for (const custom of harness?.customViews ?? []) custom.view.dispose?.();
    if (run && !settled && tool && context) {
      await tool.execute("cleanup-stop", { action: "stop" }, undefined, undefined, context);
      await run;
    }
    project.cleanup();
  }
});

test("tool stop reports a project mismatch and can cancel a command-started run", async () => {
  const project = makeProject();
  fs.writeFileSync(path.join(project.projectDir, "bench.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync('bench.started', 'yes'); setTimeout(() => {}, 60000);\n");
  fs.writeFileSync(path.join(project.projectDir, "package.json"), `${JSON.stringify({
    name: "cross-path-loop", private: true, scripts: { benchmark: "node bench.mjs" },
  }, null, 2)}\n`);
  const otherProject = path.join(project.dir, "other-project");
  fs.mkdirSync(otherProject);
  let context;
  let harness;
  let tool;
  let started = false;
  try {
    ({ context, harness } = await boot(project));
    context.hasUI = false;
    context.mode = "tui";
    tool = harness.tools.get("dream_rsi_loop");
    await harness.commands.get("dream-rsi").handler("loop --consent --no-logs", context);
    started = true;
    await waitFor(() => fs.existsSync(path.join(project.projectDir, "bench.started")));
    await waitFor(() => harness.statuses.some(([, status]) => /dream-rsi: [◳◲◱◰] looping/.test(status ?? "")));

    const mismatch = await tool.execute("wrong-project-stop", { action: "stop", project_dir: otherProject }, undefined, undefined, context);
    assert.equal(mismatch.details.aborted, false);
    assert.match(mismatch.content[0].text, /still running in this session.*was not stopped/i);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(harness.injectedMessages.some((entry) => entry.message.customType === "dream-rsi/loop"), false,
      "a stop for another project does not cancel the session-owned loop");

    const stopped = await tool.execute("stop-command-run", { action: "stop" }, undefined, undefined, context);
    assert.equal(stopped.details.aborted, true);
    assert.match(stopped.content[0].text, /asked to stop/i);
    await waitFor(() => harness.injectedMessages.some((entry) => entry.message.customType === "dream-rsi/loop"), 60_000);
    const report = harness.injectedMessages.find((entry) => entry.message.customType === "dream-rsi/loop").message.content;
    assert.match(report, /cancelled/i);
    assert.equal(harness.statuses.at(-1)?.[1], "dream-rsi: active");
  } finally {
    if (started && context && tool && !harness.injectedMessages.some((entry) => entry.message.customType === "dream-rsi/loop")) {
      await tool.execute("cleanup-stop", { action: "stop" }, undefined, undefined, context);
      await waitFor(() => harness.injectedMessages.some((entry) => entry.message.customType === "dream-rsi/loop"), 60_000);
    }
    project.cleanup();
  }
});

test("status, watch and its shortcut follow the live loop target before a campaign exists", async (t) => {
  const caller = makeProject(); const target = makeProject();
  t.after(caller.cleanup); t.after(target.cleanup);
  fs.writeFileSync(path.join(target.projectDir, "bench.mjs"), "import {writeFileSync} from 'node:fs'; writeFileSync('started','yes'); setTimeout(()=>{},60000);\n");
  fs.writeFileSync(path.join(target.projectDir, "package.json"), JSON.stringify({name: "remote-target", scripts: {benchmark: "node bench.mjs"}}));
  fs.mkdirSync(path.join(target.dreamRoot, "loop"), {recursive:true});
  fs.writeFileSync(path.join(target.dreamRoot, "loop/latest-report.json"), JSON.stringify({version:1, at:"2000-01-01T00:00:00Z", stopCode:"blocked",stopReason:"An obsolete scope error",campaigns:0,wins:1,evaluatorRuns:0,agentStarts:0,lastWin:{leverId:"fixture-lever",verifiedGain:12,unit:"points"},autoCommits:[{hash:"0123456789abcdef0123456789abcdef01234567",branch:"dream-rsi/improve",files:["src/work.mjs"]},{hash:"not-a-git-hash",branch:"dream-rsi/improve",files:[]}]}));
  fs.writeFileSync(path.join(target.dreamRoot, "loop/last-run.md"), "# Prior run summary\n");
  fs.mkdirSync(path.join(caller.dreamRoot, "loop"), { recursive: true });
  fs.writeFileSync(path.join(caller.dreamRoot, "loop/status.json"), JSON.stringify({
    version: 1, state: "stopped", updatedAt: "2026-10-29T00:00:00.000Z", branch: "dream-rsi/improve",
    branchTip: "0123456789abcdef0123456789abcdef01234567",
    effectiveAgent: { command: "pi-bolt", model: "anthropic/claude-sonnet", modelSource: "saved" },
  }));
  const {context,harness} = await boot(caller);
  const tool = harness.tools.get("dream_rsi_loop");
  const run = tool.execute("target-start", {action:"start",consent:true,project_dir:target.projectDir,include_logs:false},undefined,undefined,context);
  try {
    await waitFor(()=>fs.existsSync(path.join(target.projectDir,"started")));
    const current = await tool.execute("target-status", {action:"status"},undefined,undefined,context);
    assert.equal(current.details.activity.phase,"discovery");
    assert.ok(current.content[0].text.includes(`Project: ${target.projectDir}`));
    assert.match(current.content[0].text,/Historical run report.*not the active run/);
    assert.equal(current.details.loop.lastRunPath, path.join(target.dreamRoot, "loop/last-run.md"));
    assert.equal(current.details.loop.statusPath, path.join(target.dreamRoot, "loop/status.json"));
    assert.ok(current.content[0].text.includes(current.details.loop.lastRunPath));
    assert.ok(current.content[0].text.includes(current.details.loop.statusPath));
    assert.match(current.content[0].text, /Last verified win: fixture-lever \(12 points gain\)/);
    assert.match(current.content[0].text, /Remaining allowance:/);
    assert.match(current.content[0].text, /Undo on dream-rsi\/improve: `git revert 0123456789abcdef0123456789abcdef01234567`/);
    assert.doesNotMatch(current.content[0].text, /git revert not-a-git-hash/, "only valid object ids become copyable shell commands");
    const other = await tool.execute("caller-status", {action:"status",project_dir:caller.projectDir},undefined,undefined,context);
    assert.equal(other.details.activity,null,"an explicit project must not inherit another target's activity");
    assert.match(other.content[0].text, /Latest recorded RSI branch tip: 0123456789abcdef0123456789abcdef01234567 on dream-rsi\/improve/);
    assert.match(other.content[0].text, /Latest child agent: command "pi-bolt", model "anthropic\/claude-sonnet" \(saved\)\./);
    fs.writeFileSync(path.join(caller.dreamRoot, "loop/status.json"), JSON.stringify({
      version: 1, state: "running\ninjected", updatedAt: "2026-10-29T00:00:00.000Z\ninjected",
      branch: "dream-rsi/improve\ninjected", branchTip: "0123456789abcdef0123456789abcdef01234567",
    }));
    const malformedStatus = await tool.execute("caller-malformed-status", { action: "status", project_dir: caller.projectDir }, undefined, undefined, context);
    assert.match(malformedStatus.content[0].text, /on dream-rsi\/improve injected \(observed unknown time; status unknown\)/);
    assert.doesNotMatch(malformedStatus.content[0].text, /\ninjected/);
    for (const invalidSnapshot of [
      { version: 99, effectiveAgent: { command: "bogus", model: 17, modelSource: "session" } },
      { version: 1, effectiveAgent: { command: "bogus", model: 17, modelSource: "session" } },
    ]) {
      fs.writeFileSync(path.join(caller.dreamRoot, "loop/status.json"), JSON.stringify(invalidSnapshot));
      const invalid = await tool.execute("caller-invalid-agent", { action: "status", project_dir: caller.projectDir }, undefined, undefined, context);
      assert.doesNotMatch(invalid.content[0].text, /Latest child agent:/, "unsupported or inconsistent agent metadata must not be reported as fact");
    }
    await harness.commands.get("dream-rsi").handler("watch",context);
    assert.ok(harness.injectedMessages.at(-1).message.content.includes(`Project: ${target.projectDir}`));
    await harness.shortcuts.get("ctrl+shift+d").handler(context);
    assert.ok(harness.injectedMessages.at(-1).message.content.includes(`Project: ${target.projectDir}`));
  } finally {
    await tool.execute("target-stop", {action:"stop"},undefined,undefined,context);
    await run;
  }
});

test("rejected resume and confirm requests do not enable loop mode", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    context.mode = "tui";
    const tool = harness.tools.get("dream_rsi_loop");
    for (const action of ["resume", "confirm"]) {
      const result = await tool.execute(`missing-${action}`, { action }, undefined, undefined, context);
      assert.match(result.content[0].text, /No paused campaign is available/i);
    }
    assert.equal(harness.entries.some((entry) => entry.customType === "pi-dream-rsi/mode" && entry.data?.active === true), false);
    assert.equal(harness.statuses.at(-1)?.[1], null, "rejected actions leave the status inactive");
  } finally {
    project.cleanup();
  }
});

test("resume explicitly continues an idle saved continuous loop using its existing budget", async () => {
  const project = makeProject();
  try {
    const contract = normalizeRunContract({
      version: 1,
      outcome: { statement: "Reduce declared workload duration", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%" },
      preserved: { gates: [] }, scope: { roots: [], protectedAssets: [] },
      execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["test"] },
      budgets: { maxCampaigns: 1, maxAgentStarts: 8, maxEvaluatorRuns: 20, deadlineMs: 60_000, falseAcceptBudget: 0.1 },
      continuation: { plateauCampaigns: 3, minimumCampaignIntervalMs: 60_000 },
    });
    const loopRoot = path.join(project.dreamRoot, "loop");
    fs.mkdirSync(loopRoot, { recursive: true });
    fs.writeFileSync(contractFile(loopRoot), JSON.stringify({ version: 1, ...approveRunContract(project.projectDir, contract) }));
    readOrCreateLoopBudget(path.join(loopRoot, "budget.json"), { maxCampaigns: 1, maxAgentStarts: 8, maxEvaluatorRuns: 20, deadlineMs: 60_000 });
    const { context, harness } = await boot(project);
    const result = await harness.tools.get("dream_rsi_loop").execute("continue-idle-loop", { action: "resume" }, undefined, undefined, context);
    assert.equal(result.details.loop.stopCode, "blocked", "resume entered the saved loop instead of rejecting the absent paused campaign");
    assert.match(result.content[0].text, /Resumed Dream-RSI loop \(blocked\)/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(loopRoot, "budget.json"), "utf8")).campaigns, 0, "explicit continuation does not renew or spend budget when preflight blocks");
  } finally {
    project.cleanup();
  }
});

test("resume and confirm use the TUI lifecycle and restore status on saved-context failure", async () => {
  const project = makeProject();
  try {
    await preparePausedLoop(project);
    const { context, harness } = await boot(project);
    context.hasUI = false;
    context.mode = "tui";
    const tool = harness.tools.get("dream_rsi_loop");
    for (const action of ["resume", "confirm"]) {
      const result = await tool.execute(`fixture-${action}`, { action, include_logs: false }, undefined, undefined, context);
      assert.match(result.content[0].text, /resume failed/i, `${action} reports the intentionally missing saved loop context`);
      assert.ok(harness.statuses.some(([, status]) => /dream-rsi: [◳◲◱◰] looping/.test(status ?? "")), `${action} enters the shared TUI lifecycle`);
      assert.equal(harness.statuses.at(-1)?.[1], "dream-rsi: active", `${action} restores active status after failure`);
    }
  } finally {
    project.cleanup();
  }
});

test("resume routes a terminal campaign with retained post-apply context through recovery", async () => {
  const project = makeProject();
  try {
    await preparePausedLoop(project);
    const activeCampaignPath = path.join(project.dreamRoot, "campaigns", "active.json");
    const { id } = JSON.parse(fs.readFileSync(activeCampaignPath, "utf8"));
    const campaignPath = path.join(project.dreamRoot, "campaigns", id, "campaign.json");
    const campaign = JSON.parse(fs.readFileSync(campaignPath, "utf8"));
    campaign.state = { kind: "complete", reason: "campaign applied; post-apply check interrupted" };
    delete campaign.pendingConfirmation;
    fs.writeFileSync(campaignPath, JSON.stringify(campaign));
    const contextPath = path.join(project.dreamRoot, "loop", "active.json");
    fs.writeFileSync(contextPath, "{}\n");

    const { context, harness } = await boot(project);
    const result = await harness.tools.get("dream_rsi_loop").execute("resume-post-apply", { action: "resume" }, undefined, undefined, context);
    assert.match(result.content[0].text, /resume failed: saved loop resume context is missing or invalid/i);
    assert.equal(fs.readFileSync(contextPath, "utf8"), "{}\n", "failed recovery preserves the frozen context instead of overwriting it with new search state");
  } finally {
    project.cleanup();
  }
});

test("a changed goal does not inherit the previous evaluator or proxy justification", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const loopRoot = path.join(project.dreamRoot, "loop");
  fs.mkdirSync(loopRoot, { recursive: true });
  const original = normalizeRunContract({
    version: 1,
    outcome: { statement: "Optimize CAD rendering", unit: "ms", higherIsBetter: false, minimumUsefulGain: "10%",
      proxyJustification: "Render time tracks the canvas node count", evaluator: { argv: ["node", "web/score.mjs"], output: "score-json", inputs: ["web/score.mjs"] } },
    preserved: { gates: ["node src/check.mjs"] }, scope: { roots: ["web"], protectedAssets: [] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["test"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 20, deadlineMs: 600_000, falseAcceptBudget: 0.01 },
  });
  fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...approveRunContract(project.projectDir, original) })}\n`);
  const { context, harness } = await boot(project);
  const tool = harness.tools.get("dream_rsi_loop");
  const unchanged = await tool.execute("same-goal", { action: "start", consent: true, include_logs: false }, undefined, undefined, context);
  assert.ok(unchanged.details.loop.contract, unchanged.content[0].text);
  assert.deepEqual(JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract.outcome.evaluator, original.outcome.evaluator, "an unchanged goal keeps its instrument");
  const changed = await tool.execute("new-goal", { action: "start", consent: true, replace_contract: true, focus: "Optimize design generation", include_logs: false }, undefined, undefined, context);
  const saved = JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract;
  assert.equal(saved.outcome.statement, "Optimize design generation");
  assert.equal(saved.outcome.evaluator, undefined, "the old instrument is not reused for a different objective");
  assert.equal(saved.outcome.proxyJustification, undefined, "the old proxy justification does not authorize a new objective");
  assert.match(changed.content[0].text, /goal changed, so the previous evaluator and proxy justification are not inherited/i);
  assert.ok(changed.details.loop.preflight.status === "blocked", "without an instrument the run blocks instead of guessing");
  assert.equal(changed.details.loop.inventory?.levers.some(lever => lever.metricKind === "score"), false, "no score lever can be built from the dropped instrument");
  assert.equal(changed.details.loop.campaigns, 0);
});

test("proposal preview and execution share validation without granting consent or spending", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { context, harness } = await boot(project);
  const tool = harness.tools.get("dream_rsi_loop");
  const settings = { focus: "Reduce workload duration", unit: "ms", higher_is_better: false, scope_roots: ["seed"], gates: [], protected_assets: [], false_accept_budget: 0.02 };
  const preview = await tool.execute("preview", { ...settings, action: "prepare", consent: true }, undefined, undefined, context);
  assert.equal(preview.details.proposal.contract.execution.consent, false);
  assert.ok(preview.content[0].text.includes(preview.details.proposal_id));
  assert.equal(preview.details.proposal.settings.consent, undefined);
  assert.equal(preview.details.proposal.settings.action, undefined);
  assert.equal(preview.details.proposal.contract.budgets.falseAcceptBudget, 0.02);
  assert.deepEqual(preview.details.proposal.execution.evaluator_timeout_ms, {
    policy: "qualified-workload-derived", maximum_ms: 3_605_000,
  }, "the reviewed proposal binds the engine-derived timeout policy instead of an unenforced default number");
  const explicitTimeout = await tool.execute("explicit-timeout", {
    ...settings, action: "prepare", evaluator_timeout_ms: 900_000,
  }, undefined, undefined, context);
  assert.equal(explicitTimeout.details.proposal.execution.evaluator_timeout_ms, 900_000, "explicit reviewed limits remain exact");
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "preview writes no approval, lease, report, or budget");
  for (const patch of [{ focus: 7 }, { include_logs: "false" }, { agent_timeout_ms: -1 }, { agent_timeout_ms: 0.5 }, { evaluator_timeout_ms: 2147483648 }, { evaluator: { argv: ["node", "x.mjs"], output: "stdout-json", typo: true } }, { unexpected: true }]) {
    for (const action of ["prepare", "start"]) {
      const result = await tool.execute("invalid", { ...settings, ...patch, action, consent: true }, undefined, undefined, context);
      assert.equal(result.details.ok, false, result.content[0].text);
      assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
    }
  }
  for (const [bootstrapPath, expectedReason] of [["tests/measure.py", /outside editable scope/i], ["src/fixtures/measure.py", /protected/i]]) {
    const invalidBootstrap = await tool.execute(`bootstrap-${bootstrapPath}`, {
      ...settings, action: "prepare", scope_roots: ["src"], evaluator_bootstrap: { authorized: true, paths: [bootstrapPath] },
      protected_assets: ["src/fixtures"],
    }, undefined, undefined, context);
    assert.equal(invalidBootstrap.details.ok, false, invalidBootstrap.content[0].text);
    assert.match(invalidBootstrap.content[0].text, expectedReason);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "invalid bootstrap writes are rejected before approval or budget creation");
  }
  const started = await tool.execute("start", { ...settings, action: "start", consent: true, include_logs: false }, undefined, undefined, context);
  const saved = JSON.parse(fs.readFileSync(path.join(project.dreamRoot, "loop/contract.json"), "utf8")).contract;
  assert.deepEqual({ ...saved, execution: { ...saved.execution, consent: false } }, preview.details.proposal.contract, started.content[0].text);
});

test("a reviewed settings file carries evaluator, scope and gates through the command", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  saveLoopApproval(project);
  fs.mkdirSync(path.join(project.projectDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(project.projectDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(project.projectDir, "scripts/measure.py"), "import json; print(json.dumps({'score': 1, 'valid': True}))\n");
  fs.writeFileSync(path.join(project.projectDir, "proposal.json"), JSON.stringify({
    focus: "Optimize design generation on the pinned floor", unit: "ms", higher_is_better: false,
    evaluator: { argv: ["python", "scripts/measure.py"], output: "stdout-json" },
    scope_roots: ["src"], gates: ["python -m unittest tests.test_layout"],
  }));
  const { context, harness } = await boot(project);
  await harness.commands.get("dream-rsi").handler("loop --config proposal.json --replace-contract --consent --no-logs", context);
  const saved = JSON.parse(fs.readFileSync(path.join(project.dreamRoot, "loop/contract.json"), "utf8")).contract;
  assert.equal(saved.outcome.statement, "Optimize design generation on the pinned floor");
  assert.deepEqual(saved.outcome.evaluator, { argv: ["python", "scripts/measure.py"], output: "stdout-json" });
  assert.deepEqual(saved.scope.roots, ["src"]);
  assert.deepEqual(saved.preserved.gates, ["python -m unittest tests.test_layout"]);
  const finished = harness.injectedMessages.find(entry => entry.message.customType === "dream-rsi/loop").message.content;
  assert.match(finished, /declared evaluator/);
  assert.doesNotMatch(finished, /requested objective:.*--config/);
});

test("a versioned contract proposal maps settings without importing its consent", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  fs.mkdirSync(path.join(project.projectDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(project.projectDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(project.projectDir, "scripts/measure.py"), "import json; print(json.dumps({'score': 1, 'valid': True}))\\n");
  fs.writeFileSync(path.join(project.projectDir, "proposal.json"), JSON.stringify({
    version: 1,
    contract: {
      version: 1,
      outcome: { statement: "Optimize design generation", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%", evaluator: { argv: ["python", "scripts/measure.py"], output: "stdout-json" } },
      scope: { roots: ["src"], protectedAssets: ["fixtures/reference.json"] },
      preserved: { gates: ["python -m unittest tests.test_layout"] },
      execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
      budgets: { maxCampaigns: 1, maxAgentStarts: 8, maxEvaluatorRuns: 20, deadlineMs: 60000, falseAcceptBudget: 0.02 },
      git: { autoCommit: false, branch: "dream-rsi/improve" },
      continuation: { plateauCampaigns: 4, minimumCampaignIntervalMs: 120000 },
      agent: { command: process.execPath, args: [], model: null, thinking: null, prompt_via: "stdin" },
    },
  }));
  const { context, harness } = await boot(project);
  await harness.commands.get("dream-rsi").handler("loop --config proposal.json --replace-contract --consent --no-logs", context);
  const saved = JSON.parse(fs.readFileSync(path.join(project.dreamRoot, "loop/contract.json"), "utf8")).contract;
  assert.equal(saved.outcome.statement, "Optimize design generation");
  assert.deepEqual(saved.outcome.evaluator.argv, ["python", "scripts/measure.py"]);
  assert.deepEqual(saved.scope.protectedAssets, ["fixtures/reference.json"]);
  assert.deepEqual(saved.preserved.gates, ["python -m unittest tests.test_layout"]);
  assert.equal(saved.execution.consent, true, "consent came from the explicit CLI action, not the file");
  assert.equal(saved.budgets.maxCampaigns, 1);
  assert.equal(saved.budgets.falseAcceptBudget, 0.02, "statistical limits survive the envelope import");
  assert.deepEqual(saved.git, { autoCommit: false, branch: "dream-rsi/improve" }, "Git policy survives the envelope import");
  assert.deepEqual(saved.continuation, { plateauCampaigns: 4, minimumCampaignIntervalMs: 120000, agentStartsPerHour: 36, evaluatorRunsPerHour: 96 }, "continuous mode and rolling process limits survive the envelope import");
  assert.equal(saved.agent.command, process.execPath);
  assert.deepEqual(saved.agent.args, []);
});

test("settings files are validated before any loop state is created", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { context, harness } = await boot(project);
  const handler = harness.commands.get("dream-rsi").handler;
  const cases = [
    ["missing.json", "does not exist"],
    ["badkey.json", "unknown keys"],
    ["action.json", "cannot set"],
    ["array.json", "one JSON object"],
    ["nested-key.json", "outcome has unknown keys"],
    ["handoff.json", "cannot set"],
  ];
  fs.writeFileSync(path.join(project.projectDir, "badkey.json"), JSON.stringify({ focus: "x", secret_flag: true }));
  fs.writeFileSync(path.join(project.projectDir, "action.json"), JSON.stringify({ focus: "x", consent: true, replace_contract: true }));
  fs.writeFileSync(path.join(project.projectDir, "array.json"), JSON.stringify([{ focus: "x" }]));
  fs.writeFileSync(path.join(project.projectDir, "handoff.json"), JSON.stringify({ preparation_id: "not-a-file-approval" }));
  fs.writeFileSync(path.join(project.projectDir, "nested-key.json"), JSON.stringify({ version: 1, contract: {
    version: 1, outcome: { statement: "x", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%", unrecognized_metric: true },
    scope: { roots: ["src"] }, preserved: { gates: [] },
  } }));
  for (const [file, expected] of cases) {
    await handler(`loop --config ${file} --consent --no-logs`, context);
    assert.match(harness.notifications.at(-1), new RegExp(expected, "i"), file);
  }
  fs.writeFileSync(path.join(project.projectDir, "big.json"), " ".repeat(70 * 1024));
  await handler("loop --config big.json --consent", context);
  assert.match(harness.notifications.at(-1), /exceeds/);
  await handler("loop --config", context);
  assert.match(harness.notifications.at(-1), /needs a settings file path/);
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "invalid settings create no approval or budget");
});

test("the loop command finishes the run before a one-shot session ends", async () => {
  const project = makeProject();
  const empty = path.join(project.dir, "empty");
  fs.mkdirSync(empty);
  try {
    const { context, harness } = await boot(project);
    context.cwd = empty;
    context.hasUI = false;
    context.mode = "print";
    const written = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return original(chunk, ...rest); };
    try {
      await harness.commands.get("dream-rsi").handler("loop --consent --no-logs", context);
    } finally {
      process.stderr.write = original;
    }
    const finished = harness.injectedMessages.find((entry) => entry.message.customType === "dream-rsi/loop");
    assert.ok(finished, "the one-shot session reports the result before it ends");
    assert.match(finished.message.content, /Dream-RSI loop finished/);
    assert.equal(harness.sentMessages.length, 0, "no chat message asks an LLM to call dream_rsi_loop");
    assert.ok(written.some((text) => /Dream-RSI loop finished/.test(text)),
      "a print session shows the report on the standard error stream");
    assert.equal(harness.statuses.every(([, status]) => !/looping/.test(status ?? "")), true,
      "a non-TUI session never shows the animated status");
  } finally {
    project.cleanup();
  }
});

test("a stop during the consent dialog keeps the loop from starting", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    context.hasUI = true;
    context.mode = "tui";
    let answer;
    context.ui.confirm = async (title, message) => {
      harness.uiPrompts.push({ kind: "confirm", title, message });
      return new Promise((resolve) => { answer = resolve; });
    };
    const running = harness.commands.get("dream-rsi").handler("loop reduce startup time", context);
    await waitFor(() => Boolean(answer));
    await harness.commands.get("dream-rsi").handler("stop", context);
    answer(true);
    await running;
    assert.match(harness.notifications.at(-1), /stopped before it started/i,
      "a stop during the consent dialog prevents the run");
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "no loop state is created");
  } finally {
    project.cleanup();
  }
});

test("the loop command stops the running loop when no campaign exists yet", async () => {
  const project = makeProject();
  try {
    // A declared workload that never finishes keeps the loop busy while the stop arrives.
    fs.writeFileSync(path.join(project.projectDir, "bench.mjs"), "setTimeout(() => {}, 60000);\n");
    fs.writeFileSync(path.join(project.projectDir, "package.json"), `${JSON.stringify({
      name: "slow-loop", private: true, scripts: { bench: "node bench.mjs" },
    }, null, 2)}\n`);
    const { context, harness } = await boot(project);
    context.hasUI = false;
    context.mode = "tui";
    await harness.commands.get("dream-rsi").handler("loop --consent --no-logs", context);
    await waitFor(() => harness.statuses.filter(([, status]) => /dream-rsi: [◳◲◱◰] looping/.test(status ?? "")).length >= 2);
    const frames = new Set(harness.statuses.map(([, status]) => status).filter((status) => /dream-rsi: [◳◲◱◰] looping/.test(status ?? "")));
    assert.ok(frames.size > 1, "the white-square status animates while the loop is active");
    await harness.commands.get("dream-rsi").handler("stop", context);
    assert.match(harness.notifications.at(-1), /running Dream-RSI loop was asked to stop/i,
      "the stop reaches the detached run even before a campaign record exists");
    await waitFor(() => harness.injectedMessages.some((entry) => entry.message.customType === "dream-rsi/loop"), 60_000);
    const report = harness.injectedMessages.find((entry) => entry.message.customType === "dream-rsi/loop").message.content;
    assert.match(report, /cancelled/i, "the aborted run reports a cancellation");
    assert.equal(harness.statuses.at(-1)?.[1], "dream-rsi: active", "the indicator is cleared after a stopped loop");
  } finally {
    project.cleanup();
  }
});

test("overlapping tool actions cannot replace the animation for an active command run", async () => {
  const project = makeProject();
  fs.writeFileSync(path.join(project.projectDir, "bench.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync('bench.started', 'yes'); setTimeout(() => {}, 60000);\n");
  fs.writeFileSync(path.join(project.projectDir, "package.json"), `${JSON.stringify({
    name: "overlapping-loop", private: true, scripts: { benchmark: "node bench.mjs" },
  }, null, 2)}\n`);
  let started = false;
  let context;
  let harness;
  try {
    ({ context, harness } = await boot(project));
    context.hasUI = false;
    context.mode = "tui";
    await harness.commands.get("dream-rsi").handler("loop --consent --no-logs", context);
    started = true;
    await waitFor(() => fs.existsSync(path.join(project.projectDir, "bench.started")));
    await waitFor(() => harness.statuses.filter(([, status]) => /dream-rsi: [◳◲◱◰] looping/.test(status ?? "")).length >= 2);
    const tool = harness.tools.get("dream_rsi_loop");
    const before = harness.statuses.filter(([, status]) => /dream-rsi: [◳◲◱◰] looping/.test(status ?? "")).length;
    const overlaps = [];
    for (const action of ["resume", "confirm", "start"]) {
      overlaps.push(await tool.execute(`overlap-${action}`, { action, consent: true, include_logs: false }, undefined, undefined, context));
    }
    const afterCall = harness.statuses.filter(([, status]) => /dream-rsi: [◳◲◱◰] looping/.test(status ?? "")).length;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const afterWait = harness.statuses.filter(([, status]) => /dream-rsi: [◳◲◱◰] looping/.test(status ?? "")).length;
    assert.ok(afterWait > afterCall && afterCall >= before, "the original run keeps animating after overlapping tool actions return");
    for (const overlap of overlaps) {
      assert.equal(overlap.details?.ok, false, "a second run is rejected before touching the active indicator");
      assert.match(overlap.content[0].text, /already running/i);
    }
  } finally {
    if (started && context && harness) {
      await harness.commands.get("dream-rsi").handler("stop", context);
      await waitFor(() => harness.injectedMessages.some((entry) => entry.message.customType === "dream-rsi/loop"), 60_000);
    }
    project.cleanup();
  }
});

test("campaign updates preserve the loop animation while still publishing campaign details", () => {
  const statuses = [];
  const updates = [];
  const ctx = { ui: { setStatus: (...args) => statuses.push(args) } };
  let animating = true;
  const update = campaignUpdate(ctx, (value) => updates.push(value), () => false, () => animating);
  const campaign = {
    state: { kind: "running", phase: "experiment", iteration: 1 }, completedCycles: [],
    limits: { maxCycles: 2, maxAgentStarts: 10, maxEvaluatorRuns: 20 }, goal: "fixture goal",
    projectDir: "/fixture", scope: [], noGainCycles: 0, bestScore: 1, agentStarts: 0, evaluatorRuns: 0,
    effectiveEvaluatorTimeoutMs: 1000, deadlineAt: new Date().toISOString(), rejections: [],
  };
  update(campaign);
  assert.equal(statuses.length, 0, "campaign phase status does not overwrite the active animation");
  assert.equal(updates.length, 1, "campaign details still reach the tool update callback");
  animating = false;
  update(campaign);
  assert.equal(statuses.at(-1)?.[1], "dream-rsi: experiment (0/2)", "campaign status resumes after animation ownership ends");
});

test("session shutdown clears the loop animation and aborts the running loop", async () => {
  const project = makeProject();
  fs.writeFileSync(path.join(project.projectDir, "bench.mjs"), "setTimeout(() => {}, 60000);\n");
  fs.writeFileSync(path.join(project.projectDir, "package.json"), `${JSON.stringify({
    name: "shutdown-loop", private: true, scripts: { bench: "node bench.mjs" },
  }, null, 2)}\n`);
  try {
    const { context, harness } = await boot(project);
    context.hasUI = false;
    context.mode = "tui";
    await harness.commands.get("dream-rsi").handler("loop --consent --no-logs", context);
    await waitFor(() => harness.statuses.some(([, status]) => /looping$/.test(status ?? "")));
    await harness.handlers.get("session_shutdown")({}, context);
    const countAtShutdown = harness.statuses.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(harness.statuses.length, countAtShutdown, "no animation ticks occur after shutdown");
    await waitFor(() => fs.existsSync(path.join(project.dreamRoot, "loop", "latest-report.json")), 60_000);
    assert.match(fs.readFileSync(path.join(project.dreamRoot, "loop", "latest-report.json"), "utf8"), /\"stopCode\":\s*\"cancelled\"/,
      "cleanup waits until the aborted loop has written its final cancellation report");
  } finally {
    project.cleanup();
  }
});

test("the loop command confirms through the UI before starting", async () => {
  const project = makeProject();
  const empty = path.join(project.dir, "empty");
  fs.mkdirSync(empty);
  try {
    const { context, harness } = await boot(project);
    context.cwd = empty;
    context.hasUI = true;
    context.mode = "tui";
    harness.uiAnswers.confirm.push(true);
    harness.uiAnswers.select.push("Approve proposal");
    await harness.commands.get("dream-rsi").handler("loop", context);
    assert.equal(harness.uiPrompts[0]?.kind, "confirm", "the UI is asked for host-access consent");
    assert.equal(harness.sentMessages.length, 0, "a confirmed start does not fall back to the chat path");
    await waitFor(() => harness.injectedMessages.some((entry) => entry.message.customType === "dream-rsi/loop"));
    assert.match(harness.injectedMessages.find((entry) => entry.message.customType === "dream-rsi/loop").message.content, /Dream-RSI loop finished/);
  } finally {
    project.cleanup();
  }
});

test("the loop command does not start when UI consent is declined or no UI accepts it", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    context.hasUI = true;
    harness.uiAnswers.confirm.push(false);
    await harness.commands.get("dream-rsi").handler("loop reduce runtime", context);
    assert.equal(harness.uiPrompts[0]?.kind, "confirm");
    assert.match(harness.notifications.at(-1), /not started.*consent/i);
    assert.equal(harness.sentMessages.length, 0, "a declined dialog does not ask the LLM to continue");
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "no loop state is created");

    context.hasUI = false;
    await harness.commands.get("dream-rsi").handler("loop reduce runtime", context);
    assert.equal(harness.sentMessages.length, 1, "a headless caller keeps the in-chat consent fallback");
    assert.match(harness.sentMessages[0].content, /Ask the user for explicit trusted-local consent first/,
      "the fallback asks for consent instead of asserting it");
    assert.match(harness.sentMessages[0].content, /Only after the user confirms.*consent=true/);
    assert.match(harness.notifications.at(-1), /needs consent.*--consent/i);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "the fallback does not spawn before consent");
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

for (const withBudget of [false, true]) test(`command status exposes saved setup without a campaign or writes (budget present: ${withBudget})`, async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  if (withBudget) readOrCreateLoopBudget(path.join(loopRoot, "budget.json"), contract.budgets);
  fs.writeFileSync(path.join(loopRoot, "latest-report.json"), JSON.stringify({
    version: 1, at: "2000-01-01T00:00:00.000Z", stopCode: "blocked", stopReason: "A pinned workload must be declared", campaigns: 0, wins: 0, evaluatorRuns: 0, agentStarts: 0,
    preflight: { status: "blocked", checks: [{ name: "workload", status: "blocked", reason: "No workload exists", remedy: "Declare the evaluator" }] },
  }));
  const snapshot = () => fs.readdirSync(loopRoot).sort().map(name => [name, fs.readFileSync(path.join(loopRoot, name), "utf8")]);
  const before = snapshot();
  const { context, harness } = await boot(project);
  const toolResult = await harness.tools.get("dream_rsi_loop").execute("inspect", { action: "status" }, undefined, undefined, context);
  await harness.commands.get("dream-rsi").handler("status", context);
  assert.match(harness.notifications.at(-1), /Optimize CAD rendering/);
  assert.match(harness.notifications.at(-1), /A pinned workload must be declared/);
  assert.match(harness.notifications.at(-1), /Declare the evaluator/);
  assert.match(harness.notifications.at(-1), /Historical run report \(predates current approval\)/);
  assert.match(harness.notifications.at(-1), /Historical remedy:/);
  assert.ok(harness.notifications.at(-1).includes(toolResult.content[0].text));
  assert.deepEqual(snapshot(), before, "status never rewrites approval, reports, budgets, or memory");
});

for (const wait of ["consent", "approval"]) test(`status exposes an active ${wait} wait before campaign startup`, async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  if (wait === "approval") saveLoopApproval(project);
  const { context, harness } = await boot(project);
  context.hasUI = true; context.mode = "tui";
  let respond;
  if (wait === "consent") context.ui.confirm = () => new Promise(resolve => { respond = resolve; });
  else context.ui.select = () => new Promise(resolve => { respond = resolve; });
  const tool = harness.tools.get("dream_rsi_loop");
  const starting = wait === "consent"
    ? harness.commands.get("dream-rsi").handler("loop optimize runtime --no-logs", context)
    : tool.execute("approve-start", { action: "start", consent: true, focus: "Optimize routing", include_logs: false }, undefined, undefined, context);
  try {
    await waitFor(() => respond !== undefined);
    const status = await tool.execute("waiting-status", { action: "status" }, undefined, undefined, context);
    assert.match(status.content[0].text, new RegExp(`Active loop: awaiting-${wait}`));
    assert.match(status.content[0].text, /Waiting for/);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop/lease.json")), false, "an approval dialog is session activity, not engine work");
  } finally { respond?.(wait === "consent" ? false : "Cancel"); await starting; }
  const finished = await tool.execute("after-wait", { action: "status" }, undefined, undefined, context);
  assert.doesNotMatch(finished.content[0].text, /Active loop: awaiting-/);
});

test("a saved contract conflict is actionable and never reports a rejected contract as recorded", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const first = normalizeRunContract({
    version: 1,
    outcome: { statement: "Optimize CAD canvas rendering", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%" },
    preserved: { gates: [] }, scope: { roots: ["src"], protectedAssets: [] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    budgets: { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: 7_200_000, falseAcceptBudget: 0.1 },
  });
  const loopRoot = path.join(project.dreamRoot, "loop");
  fs.mkdirSync(loopRoot, { recursive: true });
  const stored = `${JSON.stringify({ version: 1, ...approveRunContract(project.projectDir, first) })}\n`;
  fs.writeFileSync(contractFile(loopRoot), stored);
  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("conflict", {
    action: "start", consent: true, focus: "Optimize routing search", include_logs: false,
  }, undefined, undefined, context);
  assert.equal(result.details.loop.stopCode, "blocked", result.content[0].text);
  assert.equal(result.details.loop.contract, null, "rejected approval is not an accepted contract");
  assert.match(result.content[0].text, /Optimize CAD canvas rendering/);
  assert.match(result.content[0].text, /replace_contract|--replace-contract/);
  assert.doesNotMatch(result.content[0].text, /trusted-local contract recorded/);
  assert.equal(result.details.loop.agentStarts, 0);
  assert.equal(result.details.loop.evaluatorRuns, 0);
  assert.equal(fs.readFileSync(contractFile(loopRoot), "utf8"), stored);
  const report = JSON.parse(fs.readFileSync(result.details.loop.reportPath, "utf8"));
  assert.match(JSON.stringify(report.preflight), /Optimize CAD canvas rendering/);
});

test("partial contract settings preserve saved boundaries instead of rebuilding defaults", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("partial", {
    action: "start", consent: true, focus: contract.outcome.statement, include_logs: false,
  }, undefined, undefined, context);
  assert.ok(result.details.loop.contract, result.content[0].text);
  assert.match(result.content[0].text, /requested objective: Optimize CAD rendering/);
  assert.match(result.content[0].text, /editable scope: src/);
  assert.match(result.content[0].text, /correctness gates: 1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract, contract);
  assert.equal(fs.existsSync(path.join(loopRoot, "contract.previous.json")), false);
  const changed = await harness.tools.get("dream_rsi_loop").execute("permission-change", {
    action: "start", consent: true, focus: contract.outcome.statement, env_allowlist: [], include_logs: false,
  }, undefined, undefined, context);
  assert.equal(changed.details.loop.contract, null, "even a permission-only change needs replacement approval");
  assert.equal(changed.details.loop.stopCode, "blocked");
  assert.deepEqual(JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract.execution.envAllowlist, ["LANG"]);
});

test("explicit replacement raises a durable cap without resetting spend and retains one previous contract", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  const budgetFile = path.join(loopRoot, "budget.json");
  const initial = readOrCreateLoopBudget(budgetFile, contract.budgets);
  fs.writeFileSync(budgetFile, JSON.stringify({ ...initial, campaigns: 1, agent_starts: 2, evaluator_runs: 9, wall_ms: 100 }));
  const { context, harness } = await boot(project);
  const tool = harness.tools.get("dream_rsi_loop");
  for (const [goal, previous] of [["Optimize routing", contract.outcome.statement], ["Optimize sizing", "Optimize routing"]]) {
    const result = await tool.execute("replace", {
      action: "start", consent: true, replace_contract: true, focus: goal, include_logs: false,
      ...(goal === "Optimize routing" ? { max_evaluator_runs: 34 } : {}),
      scope_roots: ["src"], gates: [],
    }, undefined, undefined, context);
    assert.ok(result.details.loop.contract, result.content[0].text);
    const saved = JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract;
    assert.equal(saved.outcome.statement, goal);
    assert.equal(saved.budgets.maxEvaluatorRuns, 34);
    assert.equal(JSON.parse(fs.readFileSync(path.join(loopRoot, "contract.previous.json"), "utf8")).contract.outcome.statement, previous);
    const after = JSON.parse(fs.readFileSync(budgetFile, "utf8"));
    assert.deepEqual([after.campaigns, after.agent_starts, after.evaluator_runs], [1, 2, 9]);
    assert.deepEqual([after.max_campaigns, after.max_agent_starts, after.max_evaluator_runs], [2, 10, 34]);
    assert.ok(after.wall_ms >= 100);
  }
});

test("raising campaign cap after campaigns start is blocked before contract or allowance changes", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  const budgetFile = path.join(loopRoot, "budget.json");
  const initial = readOrCreateLoopBudget(budgetFile, contract.budgets);
  fs.writeFileSync(budgetFile, JSON.stringify({ ...initial, campaigns: 1, agent_starts: 2, evaluator_runs: 9 }));
  const savedContract = fs.readFileSync(contractFile(loopRoot), "utf8");
  const savedBudget = JSON.parse(fs.readFileSync(budgetFile, "utf8"));
  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("raise-campaign-cap", {
    action: "start", consent: true, replace_contract: true, focus: contract.outcome.statement,
    max_campaigns: 4, include_logs: false,
  }, undefined, undefined, context);
  assert.equal(result.details.loop.stopCode, "blocked", result.content[0].text);
  assert.match(result.content[0].text, /campaign cap.*statistical|statistical.*campaign cap/i);
  assert.equal(fs.readFileSync(contractFile(loopRoot), "utf8"), savedContract, "reject before writing the replacement contract");
  const after = JSON.parse(fs.readFileSync(budgetFile, "utf8"));
  assert.deepEqual([after.max_campaigns, after.max_agent_starts, after.max_evaluator_runs, after.campaigns, after.agent_starts, after.evaluator_runs],
    [savedBudget.max_campaigns, savedBudget.max_agent_starts, savedBudget.max_evaluator_runs, savedBudget.campaigns, savedBudget.agent_starts, savedBudget.evaluator_runs],
    "reject before changing durable caps or spend");

  const fresh = makeProject(); t.after(fresh.cleanup);
  const { contract: freshContract, loopRoot: freshLoopRoot } = saveLoopApproval(fresh);
  const freshSession = await boot(fresh);
  const raised = await freshSession.harness.tools.get("dream_rsi_loop").execute("raise-before-campaigns", {
    action: "start", consent: true, replace_contract: true, focus: "Optimize CAD rendering",
    max_campaigns: 3, include_logs: false,
  }, undefined, undefined, freshSession.context);
  assert.equal(JSON.parse(fs.readFileSync(contractFile(freshLoopRoot), "utf8")).contract.budgets.maxCampaigns, 3,
    raised.content[0].text || freshContract.outcome.statement);
});

test("an interrupted approved cap extension recovers the contract and budget without resetting spend", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  const previous = approveRunContract(project.projectDir, contract);
  const nextContract = normalizeRunContract({ ...contract, budgets: { ...contract.budgets, maxEvaluatorRuns: 34 } });
  const next = approveRunContract(project.projectDir, nextContract);
  const budgetFile = path.join(loopRoot, "budget.json");
  const initial = readOrCreateLoopBudget(budgetFile, contract.budgets);
  fs.writeFileSync(budgetFile, JSON.stringify({ ...initial, campaigns: 1, agent_starts: 2, evaluator_runs: 9 }));
  fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...next })}\n`);
  fs.writeFileSync(path.join(loopRoot, "budget-extension.json"), JSON.stringify({ version: 1, previous, next,
    previousCaps: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 20 },
    nextCaps: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 34 } }));

  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("recover-extension", {
    action: "start", consent: true, replace_contract: true, focus: nextContract.outcome.statement, include_logs: false,
    scope_roots: ["src"], gates: [],
  }, undefined, undefined, context);

  assert.ok(result.details.loop.contract, result.content[0].text);
  const recovered = JSON.parse(fs.readFileSync(budgetFile, "utf8"));
  assert.deepEqual([recovered.campaigns, recovered.agent_starts, recovered.evaluator_runs], [1, 2, 9]);
  assert.equal(recovered.max_evaluator_runs, 34);
  assert.equal(fs.existsSync(path.join(loopRoot, "budget-extension.json")), false);
});

test("malformed budget-extension caps fail closed before recovery writes", async (t) => {
  const invalidTransactions = [
    ["missing previous cap", (transaction) => ({ ...transaction, previousCaps: { maxCampaigns: 2, maxEvaluatorRuns: 20 } })],
    ["missing next caps", (transaction) => ({ ...transaction, nextCaps: undefined })],
    ["fractional cap", (transaction) => ({ ...transaction, nextCaps: { ...transaction.nextCaps, maxEvaluatorRuns: 34.5 } })],
  ];
  for (const [label, corrupt] of invalidTransactions) {
    const project = makeProject(); t.after(project.cleanup);
    const { contract, loopRoot } = saveLoopApproval(project);
    const previous = approveRunContract(project.projectDir, contract);
    const nextContract = normalizeRunContract({ ...contract, budgets: { ...contract.budgets, maxEvaluatorRuns: 34 } });
    const next = approveRunContract(project.projectDir, nextContract);
    const budgetFile = path.join(loopRoot, "budget.json");
    const initial = readOrCreateLoopBudget(budgetFile, contract.budgets);
    fs.writeFileSync(budgetFile, JSON.stringify({ ...initial, campaigns: 1, agent_starts: 2, evaluator_runs: 9 }));
    fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...next })}\n`);
    const transaction = { version: 1, previous, next,
      previousCaps: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 20 },
      nextCaps: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 34 } };
    fs.writeFileSync(path.join(loopRoot, "budget-extension.json"), JSON.stringify(corrupt(transaction)));

    const { context, harness } = await boot(project);
    await assert.rejects(harness.tools.get("dream_rsi_loop").execute(`invalid-${label}`, {
      action: "start", consent: true, replace_contract: true, focus: nextContract.outcome.statement, include_logs: false,
      scope_roots: ["src"], gates: [],
    }, undefined, undefined, context), /budget-extension transaction is invalid/, label);
    const after = JSON.parse(fs.readFileSync(budgetFile, "utf8"));
    assert.deepEqual([after.campaigns, after.agent_starts, after.evaluator_runs, after.max_evaluator_runs], [1, 2, 9, 20], label);
    assert.equal(fs.existsSync(path.join(loopRoot, "budget-extension.json")), true, `${label}: preserve transaction for manual inspection`);
    assert.equal(fs.existsSync(path.join(loopRoot, "contract.previous.json")), false, `${label}: do not write a backup before validation`);
  }
});

test("initial approval shows the complete boundary and rejects source changes during review", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { context, harness } = await boot(project);
  context.hasUI = true;
  context.ui.select = async (title, options) => {
    assert.match(title, /Complete|complete/);
    assert.ok(title.includes('"protectedAssets"') && title.includes('"allowedCommandCategories"') && title.includes('"maxEvaluatorRuns"') && title.includes('"agent_timeout_ms"'));
    assert.ok(options.includes("Approve proposal"));
    fs.writeFileSync(path.join(project.projectDir, "changed-during-review.txt"), "new source state");
    return "Approve proposal";
  };
  const result = await harness.tools.get("dream_rsi_loop").execute("changed-review", { action: "start", consent: true, focus: "Reduce runtime", include_logs: false }, undefined, undefined, context);
  assert.equal(result.details.needsApproval, true);
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
});

test("dismissed replacement review is a cancellation before engine startup", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  const { context, harness } = await boot(project);
  context.hasUI = true;
  harness.uiAnswers.select.push(undefined);
  const tool = harness.tools.get("dream_rsi_loop");
  const dismissed = await tool.execute("dismiss", { action: "start", consent: true, focus: "Optimize routing", include_logs: false }, undefined, undefined, context);
  assert.equal(dismissed.details.cancelled, true);
  assert.match(dismissed.content[0].text, /replacement review was cancelled; the loop was not started/i);
  assert.equal(JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract.outcome.statement, contract.outcome.statement);
  assert.equal(fs.existsSync(path.join(loopRoot, "budget.json")), false, "dismissal must not create or charge durable engine state");
});

test("interactive replacement permits full inspection and cancellation before explicit approval", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  const { context, harness } = await boot(project);
  context.hasUI = true;
  harness.uiAnswers.select.push("Inspect full contracts", "Cancel");
  const tool = harness.tools.get("dream_rsi_loop");
  const request = { action: "start", consent: true, focus: "Optimize routing", include_logs: false };
  const refused = await tool.execute("cancel", request, undefined, undefined, context);
  assert.equal(refused.details.cancelled, true);
  assert.match(refused.content[0].text, /replacement review was cancelled; the loop was not started/i);
  assert.equal(JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract.outcome.statement, contract.outcome.statement);
  assert.equal(fs.existsSync(path.join(loopRoot, "budget.json")), false, "declining replacement must not start the engine or create a durable budget");
  assert.ok(harness.uiPrompts.some(prompt => prompt.kind === "confirm" && prompt.message.includes('"proposed"') && prompt.message.includes('"envAllowlist"')));
  harness.uiAnswers.select.push("Approve replacement");
  const accepted = await tool.execute("approve", request, undefined, undefined, context);
  assert.ok(accepted.details.loop.contract, accepted.content[0].text);
  assert.equal(JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract.outcome.statement, "Optimize routing");
});

for (const scopeOverride of [undefined, []]) test(`harness replacement inherits saved boundaries before setup (explicit scope: ${scopeOverride !== undefined})`, async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  fs.mkdirSync(path.join(project.projectDir, "src"));
  fs.writeFileSync(path.join(project.projectDir, "src/check.mjs"), "process.exit(0);\n");
  const agent = path.join(project.projectDir, "setup-agent.mjs");
  fs.writeFileSync(agent, `import { mkdirSync, writeFileSync } from "node:fs";
process.stdin.resume(); process.stdin.on("end", () => {
  mkdirSync(".dream-rsi-harness", {recursive: true});
  writeFileSync(".dream-rsi-harness/measure.mjs", 'console.log(JSON.stringify({score: 1, valid: true}));');
  writeFileSync(".dream-rsi-harness/check.mjs", 'process.exit(0);');
});\n`);
  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("replace-harness", {
    action: "start", consent: true, replace_contract: true, setup_harness: true, include_logs: false,
    focus: "Optimize the same measured behavior", unit: "ms", higher_is_better: false,
    agent_command: process.execPath, agent_args: [agent],
    ...(scopeOverride === undefined ? {} : { scope_roots: scopeOverride }),
  }, undefined, undefined, context);
  assert.ok(result.details.loop?.contract, result.content[0].text);
  const saved = JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract;
  assert.deepEqual(saved.scope.roots, [...(scopeOverride === undefined ? contract.scope.roots : ["."]), ".dream-rsi-harness"]);
  assert.deepEqual(saved.preserved.gates, [...contract.preserved.gates, "node .dream-rsi-harness/check.mjs"]);
  assert.deepEqual(saved.scope.protectedAssets, contract.scope.protectedAssets);
  assert.deepEqual(saved.budgets, contract.budgets);
});

test("an evaluator-only replacement inherits the saved metric unit and direction", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  const { context, harness } = await boot(project);
  const evaluator = { argv: ["node", "missing-score.mjs"], output: "stdout-json", inputs: ["missing-score.mjs"] };
  const result = await harness.tools.get("dream_rsi_loop").execute("replace-evaluator", {
    action: "start", consent: true, replace_contract: true, evaluator, include_logs: false,
  }, undefined, undefined, context);
  assert.ok(result.details.loop?.contract, result.content[0].text);
  const saved = JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract;
  assert.equal(saved.outcome.unit, contract.outcome.unit);
  assert.equal(saved.outcome.higherIsBetter, contract.outcome.higherIsBetter);
  assert.deepEqual(saved.outcome.evaluator, evaluator);
  assert.deepEqual(saved.scope, contract.scope);
  assert.deepEqual(saved.preserved, contract.preserved);
  assert.equal(result.details.loop.campaigns, 0, "a missing evaluator still cannot start experiments");
  const fresh = makeProject(); t.after(fresh.cleanup);
  const session = await boot(fresh);
  const undeclared = await session.harness.tools.get("dream_rsi_loop").execute("new-evaluator", {
    action: "start", consent: true, evaluator, include_logs: false,
  }, undefined, undefined, session.context);
  assert.equal(undeclared.details.ok, false, "new sessions still require explicit metric settings");
  assert.match(undeclared.content[0].text, /unit and higher_is_better/);
});

test("harness replacement honors inherited protected assets before saving", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { loopRoot } = saveLoopApproval(project);
  const saved = JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8"));
  saved.contract.scope.protectedAssets.push(".dream-rsi-harness");
  fs.writeFileSync(contractFile(loopRoot), JSON.stringify(saved));
  const before = fs.readFileSync(contractFile(loopRoot), "utf8");
  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("protected-harness", {
    action: "start", consent: true, replace_contract: true, setup_harness: true, include_logs: false,
  }, undefined, undefined, context);
  assert.equal(result.details.ok, false);
  assert.match(result.content[0].text, /protected/);
  assert.equal(fs.readFileSync(contractFile(loopRoot), "utf8"), before);
  assert.equal(fs.existsSync(path.join(project.projectDir, ".dream-rsi-harness")), false);
});

test("replacement rejects an approval that became stale during its confirmation dialog", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { contract, loopRoot } = saveLoopApproval(project);
  const { context, harness } = await boot(project);
  context.hasUI = true;
  const concurrent = { ...contract, outcome: { ...contract.outcome, statement: "Another approved objective" } };
  context.ui.select = async () => {
    fs.writeFileSync(contractFile(loopRoot), JSON.stringify({ version: 1, ...approveRunContract(project.projectDir, concurrent) }));
    return "Approve replacement";
  };
  const result = await harness.tools.get("dream_rsi_loop").execute("stale", {
    action: "start", consent: true, focus: "Optimize routing", include_logs: false,
  }, undefined, undefined, context);
  assert.equal(result.details.loop.contract, null);
  assert.match(result.content[0].text, /changed after replacement approval/);
  assert.equal(JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract.outcome.statement, concurrent.outcome.statement);
  assert.equal(result.details.loop.evaluatorRuns, 0);
});

for (const blocker of ["unsettled", "backup-failure", "corrupt", "cancelled"]) test(`replacement fails closed for ${blocker}`, async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { loopRoot } = saveLoopApproval(project);
  const file = contractFile(loopRoot);
  if (blocker === "corrupt") fs.writeFileSync(file, "not json");
  const before = fs.readFileSync(file, "utf8");
  if (blocker === "unsettled") fs.writeFileSync(path.join(loopRoot, "active.json"), JSON.stringify({ version: 1, phase: "post-apply" }));
  if (blocker === "backup-failure") fs.mkdirSync(path.join(loopRoot, "contract.previous.json"));
  const { context, harness } = await boot(project);
  const abort = new AbortController(); if (blocker === "cancelled") abort.abort();
  const result = await harness.tools.get("dream_rsi_loop").execute("refuse", {
    action: "start", consent: true, replace_contract: true, focus: "Optimize routing", include_logs: false,
  }, abort.signal, undefined, context);
  assert.equal(fs.readFileSync(file, "utf8"), before, result.content[0].text);
  assert.equal(result.details.loop?.contract ?? null, null);
  assert.match(result.content[0].text, /paused|awaiting|could not be saved|budget|cannot be read|cancelled/i);
  if (result.details.loop) assert.equal(result.details.loop.evaluatorRuns, 0);
});

test("the command forwards explicit replacement without adding the flag to the goal", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { loopRoot } = saveLoopApproval(project);
  const { context, harness } = await boot(project);
  fs.writeFileSync(path.join(project.projectDir, "settings.json"), JSON.stringify({ focus: "Optimize routing" }));
  await harness.commands.get("dream-rsi").handler("loop --config settings.json --replace-contract --consent --no-logs", context);
  const current = JSON.parse(fs.readFileSync(contractFile(loopRoot), "utf8")).contract;
  assert.equal(current.outcome.statement, "Optimize routing");
  assert.equal(fs.existsSync(path.join(loopRoot, "contract.previous.json")), true);
  assert.ok(harness.injectedMessages.some(entry => entry.message.customType === "dream-rsi/loop"));
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

for (const existingWorkload of ["none", "same", "unrelated", "external-gate", "external-gate-fails", "inherited-agent", "git-autocommit"]) test(`session setup authors and qualifies a pinned measurement harness (existing workload: ${existingWorkload})`, async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  fs.mkdirSync(path.join(project.projectDir, "src"));
  fs.writeFileSync(path.join(project.projectDir, "src/work.mjs"), "export const answer = () => 7;\n");
  fs.writeFileSync(path.join(project.projectDir, "package.json"), JSON.stringify({ name: "harness-fixture", type: "module", scripts: existingWorkload !== "none" ? { benchmark: "node bench.mjs" } : {} }));
  const externalGate = existingWorkload.startsWith("external-gate");
  if (existingWorkload === "same" || externalGate) fs.writeFileSync(path.join(project.projectDir, "bench.mjs"), 'import { answer } from "./src/work.mjs"; console.log(answer());\n');
  if (externalGate) {
    fs.mkdirSync(path.join(project.projectDir, "tests"));
    fs.writeFileSync(path.join(project.projectDir, "tests/check.mjs"), `import { answer } from "../src/work.mjs"; if (answer() !== ${existingWorkload === "external-gate-fails" ? 8 : 7}) process.exit(1);\n`);
  }
  if (existingWorkload === "unrelated") {
    fs.mkdirSync(path.join(project.projectDir, "other"));
    fs.writeFileSync(path.join(project.projectDir, "other/unrelated.mjs"), "export const unrelated = () => 42;\n");
    fs.writeFileSync(path.join(project.projectDir, "bench.mjs"), 'import { unrelated } from "./other/unrelated.mjs"; console.log(unrelated());\n');
  }
  const agentScript = path.join(project.projectDir, "harness-agent.mjs");
  fs.writeFileSync(agentScript, `import { mkdirSync, writeFileSync } from "node:fs";
let prompt = ""; process.stdin.on("data", chunk => prompt += chunk);
process.stdin.on("end", () => {
  if (!prompt.includes("measurement harness")) { console.log("ok"); return; }
  mkdirSync(".dream-rsi-harness", { recursive: true });
  writeFileSync(".dream-rsi-harness/measure.mjs", 'import { answer } from "../src/work.mjs";\\nconsole.log(JSON.stringify({score: answer(), valid: answer() === 7}));\\n');
  writeFileSync(".dream-rsi-harness/check.mjs", 'import { answer } from "../src/work.mjs";\\nif (answer() !== 7) process.exit(1);\\n');
});\n`);
  if (existingWorkload === "git-autocommit") {
    fs.writeFileSync(path.join(project.projectDir, ".gitignore"), ".dream-rsi/\n.dream-rsi-harness/\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project.projectDir });
    execFileSync("git", ["config", "user.name", "Dream RSI Test"], { cwd: project.projectDir });
    execFileSync("git", ["config", "user.email", "dream-rsi-test@example.invalid"], { cwd: project.projectDir });
    execFileSync("git", ["add", "-A"], { cwd: project.projectDir });
    execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: project.projectDir });
  }
  if (existingWorkload === "inherited-agent") {
    const contract = normalizeRunContract({
      version: 1, outcome: { statement: "Increase the answer score while preserving its valid result", unit: "points", higherIsBetter: true, minimumUsefulGain: "5%" },
      scope: { roots: ["src"], protectedAssets: [] }, preserved: { gates: [] },
      execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark", "build", "custom"] },
      budgets: { maxCampaigns: 1, maxAgentStarts: 14, maxEvaluatorRuns: 60, deadlineMs: 30 * 60000, falseAcceptBudget: 0.1 },
      agent: { command: process.execPath, args: [agentScript], model: null, thinking: null, prompt_via: "stdin" },
    });
    const root = path.join(project.dreamRoot, "loop");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(contractFile(root), JSON.stringify({ version: 1, ...approveRunContract(project.projectDir, contract) }));
  }
  const { context, harness } = await boot(project);
  const tool = harness.tools.get("dream_rsi_loop");
  assert.equal(tool.parameters.properties.setup_harness?.type, "boolean");
  const settings = {
    action: "start", consent: true, setup_harness: true, include_logs: false,
    focus: "Increase the answer score while preserving its valid result", unit: "points", higher_is_better: true,
    scope_roots: ["src"], gates: externalGate ? ["node tests/check.mjs"] : [], protected_assets: externalGate ? ["tests"] : [],
    ...(existingWorkload === "inherited-agent" ? { replace_contract: true } : { agent_command: process.execPath, agent_args: [agentScript] }),
    max_campaigns: 1, max_agent_starts: 14, max_evaluator_runs: 60, deadline_minutes: 30,
  };
  let result;
  if (existingWorkload === "none") {
    await harness.commands.get("dream-rsi").handler(`loop ${settings.focus} --consent --no-logs`, context);
    const message = harness.sentMessages.at(-1).content;
    const request = JSON.parse(message.slice(message.indexOf("{")));
    const preview = await tool.execute("prepare-setup", { ...settings, action: "prepare", preparation_id: request.preparation_id }, undefined, undefined, context);
    assert.equal(fs.existsSync(path.join(project.projectDir, ".dream-rsi-harness")), false);
    result = await tool.execute("approved-setup", { ...settings, preparation_id: request.preparation_id, proposal_id: preview.details.proposal_id, approve_proposal: true }, undefined, undefined, context);
  } else result = await tool.execute("setup", settings, undefined, undefined, context);
  if (existingWorkload === "git-autocommit") {
    assert.equal(result.details.ok, false);
    assert.match(result.content[0].text, /auto_commit cannot be combined with evaluator bootstrap/i);
    assert.equal(fs.existsSync(path.join(project.projectDir, ".dream-rsi-harness")), false, "the conflicting harness is rejected before writing files");
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "the conflict is rejected before durable loop state is created");
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: project.projectDir, encoding: "utf8" }).trim(), "main");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: project.projectDir, encoding: "utf8" }).trim(), "");
    return;
  }
  const loop = result.details.loop;
  assert.ok(fs.existsSync(path.join(project.projectDir, ".dream-rsi-harness/measure.mjs")), result.content[0].text);
  const saved = JSON.parse(fs.readFileSync(path.join(project.dreamRoot, "loop/contract.json"), "utf8")).contract;
  assert.equal(saved.outcome.unit, "points");
  assert.equal(saved.outcome.higherIsBetter, true);
  assert.deepEqual(saved.outcome.evaluator.argv, ["node", ".dream-rsi-harness/measure.mjs"]);
  assert.deepEqual(saved.outcome.evaluator.inputs, [".dream-rsi-harness"]);
  assert.ok(saved.preserved.gates.includes("node .dream-rsi-harness/check.mjs"));
  assert.ok(loop.inventory.levers.some(lever => lever.metricKind === "score" && lever.scopeFiles.includes("src/work.mjs") && lever.scopeFiles.every(file => !file.startsWith(".dream-rsi-harness/"))));
  const budget = JSON.parse(fs.readFileSync(loop.budgetPath, "utf8"));
  assert.equal(budget.phases.qualification.agent_starts, 2, "setup and the agent liveness probe each use one durable agent start");
  assert.ok(loop.preflightEvaluatorRuns > 0, `the generated instrument is independently exercised: ${result.content[0].text}`);
  assert.ok(loop.preflight.checks.some(check => check.name === "evaluator" && check.status === "passed"), result.content[0].text);
  assert.equal(loop.campaigns, 1, "the qualified generated harness reaches a real campaign");
  if (externalGate) {
    assert.deepEqual(saved.scope.roots, ["src", ".dream-rsi-harness"], "read-only verification does not expand edit permission");
    assert.ok(saved.preserved.gates.includes("node tests/check.mjs"));
    assert.ok(loop.preflight.checks.some(check => check.name === "scope" && check.status === "passed"));
  }
  if (existingWorkload === "external-gate-fails") {
    assert.equal(loop.wins, 0);
    const campaign = JSON.parse(fs.readFileSync(path.join(loop.records[0].campaignRoot, "campaign.json"), "utf8"));
    assert.ok(campaign.checkReport.gateRuns.some(gate => gate.command === "node tests/check.mjs" && gate.code !== null && gate.passed === false), "the out-of-scope gate is still executed and its failure is not reported as passing");
    assert.equal(fs.readFileSync(path.join(project.projectDir, "src/work.mjs"), "utf8"), "export const answer = () => 7;\n");
  }
});

test("harness preview selects an installed project Python without executing or overwriting it", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const interpreter = path.join(project.projectDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  fs.mkdirSync(path.dirname(interpreter), { recursive: true });
  fs.writeFileSync(interpreter, "not executable: preview must not run this fixture\n");
  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("plan-harness", {
    action: "prepare", setup_harness: true, harness_language: "python", focus: "Reduce runtime without changing results", unit: "ms", higher_is_better: false, scope_roots: ["seed"],
  }, undefined, undefined, context);
  assert.equal(result.details.proposal.contract.outcome.evaluator.argv[0], interpreter);
  assert.ok(result.details.proposal.contract.preserved.gates[0].includes("check.py"));
  assert.equal(fs.existsSync(path.join(project.projectDir, ".dream-rsi-harness")), false);
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false);
});

test("harness setup refuses ambiguous metrics, conflicting setup, protected files and existing unapproved harnesses", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const { context, harness } = await boot(project);
  const tool = harness.tools.get("dream_rsi_loop");
  const base = { action: "start", consent: true, setup_harness: true, focus: "Improve accuracy", include_logs: false };
  for (const [extra, expected] of [
    [{}, /unit and higher_is_better/],
    [{ setup_harness: "yes" }, /must be a boolean/],
    [{ focus: "", unit: "percent", higher_is_better: true }, /explicit improvement goal/],
    [{ unit: "percent", higher_is_better: true, evaluator: { argv: ["node", "score.mjs"], output: "stdout-json" } }, /cannot combine/i],
    [{ unit: "percent", higher_is_better: true, evaluator_bootstrap: { authorized: true, paths: ["x.mjs"] } }, /cannot combine/i],
    [{ unit: "percent", higher_is_better: true, protected_assets: [".dream-rsi-harness"] }, /protected/i],
  ]) {
    const result = await tool.execute("invalid-setup", { ...base, ...extra }, undefined, undefined, context);
    assert.equal(result.details.ok, false, result.content[0].text);
    assert.match(result.content[0].text, expected);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "invalid setup creates no loop state");
  }
  fs.mkdirSync(path.join(project.projectDir, ".dream-rsi-harness"));
  fs.writeFileSync(path.join(project.projectDir, ".dream-rsi-harness/measure.mjs"), "// user work\n");
  const result = await tool.execute("existing-setup", { ...base, unit: "percent", higher_is_better: true }, undefined, undefined, context);
  assert.equal(result.details.ok, false);
  assert.match(result.content[0].text, /already exists/i);
  assert.equal(fs.readFileSync(path.join(project.projectDir, ".dream-rsi-harness/measure.mjs"), "utf8"), "// user work\n");
});

test("generated constant scores and ineffective checks cannot admit experiments", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  fs.mkdirSync(path.join(project.projectDir, "src"));
  fs.writeFileSync(path.join(project.projectDir, "src/work.mjs"), "export const answer = () => 7;\n");
  const agentScript = path.join(project.projectDir, "bad-harness-agent.mjs");
  fs.writeFileSync(agentScript, `import { mkdirSync, writeFileSync } from "node:fs";
process.stdin.resume(); process.stdin.on("end", () => {
  mkdirSync(".dream-rsi-harness", { recursive: true });
  writeFileSync(".dream-rsi-harness/measure.mjs", 'console.log(JSON.stringify({score: 7, valid: true}));');
  writeFileSync(".dream-rsi-harness/check.mjs", 'process.exit(0);');
});\n`);
  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("bad-harness", {
    action: "start", consent: true, setup_harness: true, include_logs: false,
    focus: "Improve the answer score", unit: "points", higher_is_better: true, scope_roots: ["src"],
    agent_command: process.execPath, agent_args: [agentScript],
    max_campaigns: 1, max_agent_starts: 14, max_evaluator_runs: 60, deadline_minutes: 30,
  }, undefined, undefined, context);
  assert.equal(result.details.loop.stopCode, "blocked", result.content[0].text);
  assert.equal(result.details.loop.campaigns, 0);
  assert.match(result.content[0].text, /oracle|sensitivity|direction|inert/i);
  assert.equal(result.details.recovery.category, "instrument");
  assert.equal(result.details.recovery.automatic_retries, 0);
  assert.equal(fs.readFileSync(path.join(project.projectDir, "src/work.mjs"), "utf8"), "export const answer = () => 7;\n");
});

test("a failed generated runtime evaluator cannot fall back to an existing benchmark", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  fs.mkdirSync(path.join(project.projectDir, "src"));
  fs.writeFileSync(path.join(project.projectDir, "src/work.mjs"), "export const answer = () => 7;\n");
  fs.writeFileSync(path.join(project.projectDir, "package.json"), JSON.stringify({ name: "no-fallback", scripts: { benchmark: "node bench.mjs" } }));
  fs.writeFileSync(path.join(project.projectDir, "bench.mjs"), 'import { answer } from "./src/work.mjs"; console.log(answer());\n');
  const agentScript = path.join(project.projectDir, "constant-runtime-agent.mjs");
  fs.writeFileSync(agentScript, `import { mkdirSync, writeFileSync } from "node:fs";
process.stdin.resume(); process.stdin.on("end", () => {
  mkdirSync(".dream-rsi-harness", { recursive: true });
  writeFileSync(".dream-rsi-harness/measure.mjs", 'console.log(JSON.stringify({score: 100, valid: true}));');
  writeFileSync(".dream-rsi-harness/check.mjs", 'import { answer } from "../src/work.mjs"; if (answer() !== 7) process.exit(1);');
});\n`);
  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("no-fallback", {
    action: "start", consent: true, setup_harness: true, include_logs: false,
    focus: "Reduce answer runtime without changing results", unit: "ms", higher_is_better: false, scope_roots: ["src"],
    agent_command: process.execPath, agent_args: [agentScript],
    max_campaigns: 1, max_agent_starts: 14, max_evaluator_runs: 60, deadline_minutes: 30,
  }, undefined, undefined, context);
  assert.deepEqual(result.details.loop.inventory.levers.map(lever => lever.metricKind), ["score"], "declaring an evaluator excludes all metric fallbacks");
  assert.equal(result.details.loop.stopCode, "blocked", result.content[0].text);
  assert.equal(result.details.loop.campaigns, 0);
  assert.match(result.content[0].text, /sensitivity|direction|inert/i);
});

test("harness copy-back preserves concurrent user files and removes its own partial setup", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const target = path.join(project.projectDir, ".dream-rsi-harness");
  const agentScript = path.join(project.projectDir, "racing-harness-agent.mjs");
  fs.writeFileSync(agentScript, `import { mkdirSync, writeFileSync } from "node:fs";
process.stdin.resume(); process.stdin.on("end", () => {
  mkdirSync(".dream-rsi-harness", { recursive: true });
  writeFileSync(".dream-rsi-harness/measure.mjs", 'console.log(JSON.stringify({score: 7, valid: true}));');
  writeFileSync(".dream-rsi-harness/check.mjs", 'process.exit(0);');
  mkdirSync(${JSON.stringify(target)}, { recursive: true });
  writeFileSync(${JSON.stringify(path.join(target, "check.mjs"))}, "// concurrent user edit\\n");
});\n`);
  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("racing-harness", {
    action: "start", consent: true, setup_harness: true, include_logs: false,
    focus: "Improve the answer score", unit: "points", higher_is_better: true,
    agent_command: process.execPath, agent_args: [agentScript],
    max_campaigns: 1, max_agent_starts: 5, max_evaluator_runs: 30, deadline_minutes: 2,
  }, undefined, undefined, context);
  assert.equal(result.details.loop.stopCode, "blocked");
  assert.equal(result.details.loop.campaigns, 0);
  assert.match(result.content[0].text, /bootstrap failed/i);
  assert.equal(fs.readFileSync(path.join(target, "check.mjs"), "utf8"), "// concurrent user edit\n");
  assert.equal(fs.existsSync(path.join(target, "measure.mjs")), false, "the first new setup file is rolled back");
});

test("commit-policy command flag is explicit and does not become part of the objective", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const { context, harness } = await boot(project);
  context.hasUI = false;
  await harness.commands.get("dream-rsi").handler("loop reduce runtime --commit-policy no-commit --no-logs", context);
  const message = harness.sentMessages.at(-1).content;
  const request = JSON.parse(message.slice(message.indexOf("{")));
  assert.equal(request.proposed_settings.commit_policy, "no-commit");
  assert.doesNotMatch(JSON.stringify(harness.sentMessages), /focused on: reduce runtime --commit-policy/);
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "policy review does not bypass trusted-local consent");
});

test("the setup-harness command flag is explicit and does not become part of the objective", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const { context, harness } = await boot(project);
  context.hasUI = false;
  await harness.commands.get("dream-rsi").handler("loop reduce runtime --setup-harness --no-logs", context);
  const message = harness.sentMessages.at(-1).content;
  const request = JSON.parse(message.slice(message.indexOf("{")));
  assert.equal(request.proposed_settings.setup_harness, true);
  assert.equal(request.proposed_settings.unit, "ms");
  assert.equal(request.proposed_settings.higher_is_better, false);
  assert.doesNotMatch(JSON.stringify(harness.sentMessages), /focused on: reduce runtime --setup-harness/);
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "setup waits for trusted-local consent");
});

test("harness setup authors and qualifies a Python harness using the project venv in a spaced path", async (t) => {
  const project = makeProject({ projectName: "Python project" }); t.after(project.cleanup);
  const venv = path.join(project.projectDir, ".venv");
  const created = spawnSync(process.platform === "win32" ? "python" : "python3", ["-m", "venv", "--without-pip", venv], { encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.equal(created.status, 0, `local stdlib venv creation failed: ${created.stderr}`);
  fs.mkdirSync(path.join(project.projectDir, "src/pkg"), { recursive: true });
  fs.writeFileSync(path.join(project.projectDir, "pyproject.toml"), "[project]\nname = 'fixture'\nversion = '0.1.0'\n");
  fs.writeFileSync(path.join(project.projectDir, "src/pkg/__init__.py"), "");
  fs.writeFileSync(path.join(project.projectDir, "src/pkg/work.py"), "def answer():\n    return 7\n");
  const agent = path.join(project.projectDir, "python-harness-agent.mjs");
  const measurePy = [
    "import json, sys",
    "from pathlib import Path",
    "sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))",
    "from pkg.work import answer",
    "value = answer()",
    "print(json.dumps({'score': value, 'valid': value == 7}))",
  ].join("\n") + "\n";
  const checkPy = [
    "import sys",
    "from pathlib import Path",
    "sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))",
    "from pkg.work import answer",
    "sys.exit(0 if answer() == 7 else 1)",
  ].join("\n") + "\n";
  fs.writeFileSync(agent, `import { mkdirSync, writeFileSync } from "node:fs";
process.stdin.resume(); process.stdin.on("end", () => {
  mkdirSync(".dream-rsi-harness", { recursive: true });
  writeFileSync(".dream-rsi-harness/measure.py", ${JSON.stringify(measurePy)});
  writeFileSync(".dream-rsi-harness/check.py", ${JSON.stringify(checkPy)});
});\n`);
  const { context, harness } = await boot(project);
  const result = await harness.tools.get("dream_rsi_loop").execute("python-harness", {
    action: "start", consent: true, setup_harness: true, include_logs: false,
    focus: "Increase the answer score without changing correctness", unit: "points", higher_is_better: true,
    scope_roots: ["src"], agent_command: process.execPath, agent_args: [agent],
    max_campaigns: 1, max_agent_starts: 14, max_evaluator_runs: 60, deadline_minutes: 30,
  }, undefined, undefined, context);
  const saved = JSON.parse(fs.readFileSync(path.join(project.dreamRoot, "loop/contract.json"), "utf8")).contract;
  const python = path.join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  assert.deepEqual(saved.outcome.evaluator.argv, [python, ".dream-rsi-harness/measure.py"], result.content[0].text);
  assert.ok(saved.preserved.gates.some(gate => gate.endsWith(" .dream-rsi-harness/check.py") && gate.includes(python)));
  assert.equal(fs.existsSync(path.join(project.projectDir, ".dream-rsi-harness/measure.py")), true);
  assert.equal(fs.existsSync(path.join(project.projectDir, ".dream-rsi-harness/measure.mjs")), false, "a Python project gets a Python harness");
  assert.equal(result.details.loop.campaigns, 1, result.content[0].text);
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
