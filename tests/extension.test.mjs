import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { makeProject, mockPi } from "./fixtures.mjs";

const { default: dreamRsi, campaignUpdate } = await import("../extensions/pi-dream-rsi/index.ts");
const { defaultTask, normalizeTask } = await import("../extensions/pi-dream-rsi/engine/task.ts");
const { normalizeRunContract, approveRunContract, contractFile } = await import("../extensions/pi-dream-rsi/engine/intake.ts");
const { runCampaign } = await import("../extensions/pi-dream-rsi/engine/campaign.ts");
const { readOrCreateLoopBudget } = await import("../extensions/pi-dream-rsi/engine/budget.ts");

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

test("the loop command starts directly with --consent and never asks the LLM to call the tool", async () => {
  const project = makeProject();
  const empty = path.join(project.dir, "empty");
  fs.mkdirSync(empty);
  try {
    const { context, harness } = await boot(project);
    context.cwd = empty;
    context.hasUI = false;
    context.mode = "tui";
    await harness.commands.get("dream-rsi").handler("loop reduce startup time --consent --no-logs", context);
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
    const stopped = await tool.execute("tool-stop", { action: "stop" }, undefined, undefined, context);
    assert.match(stopped.content[0].text, /asked to stop/i);
    const result = await run;
    assert.match(result.content[0].text, /cancelled/i);
    assert.equal(harness.statuses.at(-1)?.[1], "dream-rsi: active", "the indicator is restored after tool cancellation");
  } finally {
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

test("rejected resume and confirm requests do not enable loop mode", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    context.mode = "tui";
    const tool = harness.tools.get("dream_rsi_loop");
    for (const action of ["resume", "confirm"]) {
      const result = await tool.execute(`missing-${action}`, { action }, undefined, undefined, context);
      assert.match(result.content[0].text, /No paused or interrupted campaign/i);
    }
    assert.equal(harness.entries.some((entry) => entry.customType === "pi-dream-rsi/mode" && entry.data?.active === true), false);
    assert.equal(harness.statuses.at(-1)?.[1], null, "rejected actions leave the status inactive");
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
      await harness.commands.get("dream-rsi").handler("loop reduce startup time --consent --no-logs", context);
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
