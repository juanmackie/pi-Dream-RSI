/** Campaign extension surface, command safety, and task validation. */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { EXT, exists, makeProject, mockPi, readJson } from "./fixtures.mjs";

const { default: dreamRsi } = await import("../extensions/pi-dream-rsi/index.ts");
const { defaultTask, normalizeTask, validateTask, formatCandidateBrief } = await import("../extensions/pi-dream-rsi/engine/task.ts");

async function boot(project) {
  const { pi, context, harness } = mockPi();
  dreamRsi(pi);
  context.cwd = project.projectDir;
  await harness.handlers.get("session_start")({}, context);
  return { pi, context, harness };
}

test("registers only the campaign controller and lifecycle hooks", async () => {
  const project = makeProject();
  try {
    const { harness } = await boot(project);
    assert.deepEqual([...harness.tools.keys()], ["dream_rsi_improve", "dream_rsi_signals", "dream_rsi_loop"]);
    assert.deepEqual([...harness.commands.keys()], ["dream-rsi"]);
    for (const event of ["session_start", "session_tree", "session_shutdown", "resources_discover", "input"]) {
      assert.equal(typeof harness.handlers.get(event), "function", `${event} hook registered`);
    }
    // The skill is contributed by the extension itself, so it is discoverable however we were loaded.
    const resources = await harness.handlers.get("resources_discover")({ cwd: project.projectDir, reason: "startup" }, null);
    assert.deepEqual(resources.skillPaths, [path.join(EXT, "..", "..", "skills")]);
    assert.ok(exists(path.join(resources.skillPaths[0], "dream-rsi", "SKILL.md")));
    assert.ok(exists(path.join(resources.skillPaths[0], "dream-rsi-assess", "SKILL.md")));
    assert.ok(exists(path.join(resources.skillPaths[0], "dream-rsi-improve", "SKILL.md")));
  } finally {
    project.cleanup();
  }
});

test("campaign intake validates a direct target and lower-only call caps without configuring legacy state", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const improve = harness.tools.get("dream_rsi_improve");
    const idle = await improve.execute("status-empty", { action: "status" }, undefined, undefined, context);
    assert.match(idle.content[0].text, /No campaign yet\. Run \/dream-rsi assess/);
    const gated = await improve.execute("start-off", { action: "start", goal: "Improve score" }, undefined, undefined, context);
    assert.match(gated.content[0].text, /requires an explicit improvement request/);
    await harness.handlers.get("input")({ type: "input", source: "interactive", text: "Use Dream-RSI to improve the fixture benchmark" }, context);
    const invalid = await improve.execute("bad-cap", {
      action: "start",
      goal: "Increase verified score while keeping correctness",
      task: {
        name: "external fixture",
        workspace: "seed",
        eval_program: "solution.py",
        score_program: project.task.score_program,
        higher_is_better: true,
        agent_command: "node",
        agent_args: [project.script("agent-ok.mjs")],
      },
      verifier_inputs: ["score-ok.mjs"],
      max_cycles: 6,
    }, undefined, undefined, context);
    assert.match(invalid.content[0].text, /max_cycles must be an integer from 1 to 5/);
    const invalidGain = await improve.execute("bad-gain", {
      action: "start",
      goal: "Increase verified score while keeping correctness",
      task: {
        name: "external fixture",
        workspace: "seed",
        eval_program: "solution.py",
        score_program: project.task.score_program,
        higher_is_better: true,
        agent_command: "node",
        agent_args: [project.script("agent-ok.mjs")],
      },
      verifier_inputs: ["score-ok.mjs"],
      minimum_gain: -0.01,
    }, undefined, undefined, context);
    assert.match(invalidGain.content[0].text, /minimum_gain must be a finite non-negative score delta/);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "task.json")), false, "direct campaign intake never writes legacy task.json");
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "campaigns")), false, "invalid intake does not create campaign state");
    const unready = await improve.execute("unready-lever", {
      action: "start",
      lever: { goal: "reduce latency", scope_files: ["solution.py"], metric: "p95 ms", evaluator_kind: "command", readiness: "needs_setup" },
      task: { name: "fixture", workspace: "seed", eval_program: "solution.py", score_program: project.task.score_program, higher_is_better: true },
    }, undefined, undefined, context);
    assert.match(unready.content[0].text, /only ready levers can start/);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "campaigns")), false, "unready assessed lever starts no agent or campaign");
  } finally { project.cleanup(); }
});

test("command completion exposes only campaign verbs", async () => {
  const project = makeProject();
  try {
    const { harness } = await boot(project);
    const complete = harness.commands.get("dream-rsi").getArgumentCompletions;
    const verbs = complete("").map((item) => item.value);
    assert.ok(verbs.includes("watch"));
    assert.ok(verbs.includes("assess"));
    assert.ok(verbs.includes("improve"));
    assert.ok(verbs.includes("loop"));
    assert.ok(verbs.includes("start"));
    assert.ok(verbs.includes("status"));
    assert.ok(verbs.includes("stop"));
    assert.ok(!verbs.includes("create"));
    assert.ok(!verbs.includes("suggest"));
    assert.ok(!verbs.includes("live"));
    assert.deepEqual(complete("res").map((item) => item.value), ["resume"]);
    assert.deepEqual(complete("start").map((item) => item.value), ["start"]);
    assert.deepEqual(complete("ass").map((item) => item.value), ["assess"]);
    assert.deepEqual(complete("imp").map((item) => item.value), ["improve"]);
    assert.deepEqual(complete("watch").map((item) => item.value), ["watch"]);
    assert.equal(complete("improve my program"), null, "free-text goals remain free text");
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(fs.existsSync(project.dreamRoot), false, "completion does not create task state");
  } finally { project.cleanup(); }
});

test("start intake JSON rejects obsolete forced campaign controls before starting", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const intakePath = path.join(project.projectDir, "intake.json");
    fs.writeFileSync(intakePath, JSON.stringify({
      goal: "reduce latency", task: { name: "task", workspace: "seed", eval_program: "solution.py", score_program: "node score.mjs", higher_is_better: false },
      workers: 4,
    }));
    await harness.commands.get("dream-rsi").handler("start intake.json", context);
    assert.match(harness.notifications.at(-1), /unknown intake field: workers/);
    assert.equal(harness.sentMessages.length, 0);
    fs.writeFileSync(intakePath, JSON.stringify({
      goal: "reduce latency", task: { name: "task", workspace: "seed", eval_program: "solution.py", score_program: "node score.mjs" },
    }));
    await harness.commands.get("dream-rsi").handler("start intake.json", context);
    assert.match(harness.notifications.at(-1), /higher_is_better must be explicitly/);
    assert.equal(harness.sentMessages.length, 0);
  } finally { project.cleanup(); }
});

test("assess is read-only and works without a configured Dream-RSI task", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.commands.get("dream-rsi").handler("assess src/cache.ts", context);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].content, "/skill:dream-rsi-assess src/cache.ts");
    assert.deepEqual([...harness.tools.keys()], ["dream_rsi_improve", "dream_rsi_signals", "dream_rsi_loop"]);
    assert.equal(fs.existsSync(project.dreamRoot), false);
  } finally { project.cleanup(); }
});

test("only explicit Dream-RSI improve intent enables campaign mode from ordinary input", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const input = harness.handlers.get("input");
    for (const text of [
      "What should we improve?",
      "How does improvement work?",
      "Assess what to optimize with Dream-RSI",
      "What should we improve with Dream-RSI?",
    ]) {
      await input({ type: "input", source: "interactive", text }, context);
    }
    await input({ type: "input", source: "extension", text: "Use Dream-RSI to improve this project" }, context);
    const tool = harness.tools.get("dream_rsi_improve");
    const guarded = await tool.execute("guarded", { action: "start" }, undefined, undefined, context);
    assert.match(guarded.content[0].text, /requires an explicit improvement request/);
    await input({ type: "input", source: "interactive", text: "Use Dream-RSI to improve this project" }, context);
    const allowed = await tool.execute("allowed", { action: "start" }, undefined, undefined, context);
    assert.match(allowed.content[0].text, /requires a concrete measurable goal/);
    assert.equal(fs.existsSync(project.dreamRoot), false, "enabling mode creates no task or campaign state");
  } finally { project.cleanup(); }
});

test("explicit improve request routes to intake and enables the campaign controller", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.commands.get("dream-rsi").handler("improve src/cache.ts", context);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].content, "/skill:dream-rsi-improve src/cache.ts");
    assert.equal(harness.tools.has("dream_rsi_improve"), true);
    assert.equal(fs.existsSync(project.dreamRoot), false, "intake does not create a campaign before the skill calls the controller");
  } finally { project.cleanup(); }
});

test("loop tool starts unattended only after explicit intent and reports durable state", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const loop = harness.tools.get("dream_rsi_loop");
    const idle = await loop.execute("loop-status", { action: "status" }, undefined, undefined, context);
    assert.match(idle.content[0].text, /No loop state yet\. Run \/dream-rsi loop/);
    assert.match(idle.content[0].text, /No active campaign\./);
    const gated = await loop.execute("loop-gated", { action: "start" }, undefined, undefined, context);
    assert.match(gated.content[0].text, /requires an explicit improvement request/);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "a gated start creates no loop state");
    await harness.handlers.get("input")({ type: "input", source: "interactive", text: "Use Dream-RSI to improve the fixture benchmark" }, context);
    const result = await loop.execute("loop-start", { action: "start", include_logs: false, max_campaigns: 1, max_agent_starts: 3, max_evaluator_runs: 5, deadline_minutes: 1 }, undefined, undefined, context);
    assert.match(result.content[0].text, /Dream-RSI loop finished: (empty inventory|no verifiable lever)/);
    assert.equal(result.details.loop.campaigns, 0);
    assert.equal(result.details.loop.wins, 0);
    assert.equal(result.details.loop.evaluatorRuns, 0);
    assert.match(result.content[0].text, /durable caps: 0\/1 campaigns, 0\/3 agent starts, 0\/5 evaluator runs/);
    const status = await loop.execute("loop-status-after", { action: "status" }, undefined, undefined, context);
    assert.match(status.content[0].text, /Dream-RSI loop budget \(durable\): 0\/1 campaigns, 0\/3 agent starts, 0\/5 evaluator runs\./);
    assert.match(status.content[0].text, /Loop memory:/);
  } finally { project.cleanup(); }
});

test("loop state is keyed to the named project, not the calling directory", async () => {
  const project = makeProject();
  const other = makeProject();
  try {
    const { context, harness } = await boot(project);
    const loop = harness.tools.get("dream_rsi_loop");
    await harness.handlers.get("input")({ type: "input", source: "interactive", text: "Use Dream-RSI to improve the fixture benchmark" }, context);
    const started = await loop.execute("loop-other-start", { action: "start", project_dir: other.projectDir, include_logs: false, max_campaigns: 1, max_agent_starts: 3, max_evaluator_runs: 5, deadline_minutes: 1 }, undefined, undefined, context);
    assert.match(started.content[0].text, /Dream-RSI loop finished: (empty inventory|no verifiable lever)/);
    assert.equal(path.resolve(started.details.loop.memoryPath), path.join(other.dreamRoot, "loop", "memory.json"), "durable state lands under the named project");
    assert.equal(fs.existsSync(path.join(other.dreamRoot, "loop", "budget.json")), true);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop")), false, "the calling project's loop state stays untouched");

    const otherStatus = await loop.execute("loop-other-status", { action: "status", project_dir: other.projectDir }, undefined, undefined, context);
    assert.match(otherStatus.content[0].text, /Dream-RSI loop budget \(durable\): 0\/1 campaigns, 0\/3 agent starts, 0\/5 evaluator runs\./);
    assert.equal(path.resolve(otherStatus.details.loop.budgetPath), path.join(other.dreamRoot, "loop", "budget.json"));

    const callerStatus = await loop.execute("loop-caller-status", { action: "status" }, undefined, undefined, context);
    assert.match(callerStatus.content[0].text, /No loop state yet\. Run \/dream-rsi loop/);
  } finally { project.cleanup(); other.cleanup(); }
});

test("the advertised stop reaches a loop that runs in another project", async () => {
  const project = makeProject();
  const other = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.handlers.get("input")({ type: "input", source: "interactive", text: "Use Dream-RSI to improve the fixture benchmark" }, context);
    const loop = harness.tools.get("dream_rsi_loop");
    await loop.execute("loop-target-start", { action: "start", project_dir: other.projectDir, include_logs: false, max_campaigns: 1, max_agent_starts: 1, max_evaluator_runs: 1, deadline_minutes: 1 }, undefined, undefined, context);
    // Fabricate the loop target's running campaign, then stop it through the command
    // issued from the caller directory.
    const campaignRoot = path.join(other.dreamRoot, "campaigns", "aaaaaaaaaaaaaaaa");
    fs.mkdirSync(campaignRoot, { recursive: true });
    fs.writeFileSync(path.join(other.dreamRoot, "campaigns", "active.json"), JSON.stringify({ id: "aaaaaaaaaaaaaaaa" }));
    fs.writeFileSync(path.join(campaignRoot, "campaign.json"), JSON.stringify({
      version: 1, id: "aaaaaaaaaaaaaaaa", campaignRoot, baseRoot: other.dreamRoot, projectDir: other.projectDir, goal: "fixture goal", scope: [], task: {},
      verifierInputs: [], gates: [], noGainCycles: 0, bestScore: 0, baselineScore: 0, completedCycles: [], rejections: [],
      state: { kind: "running", phase: "live", iteration: "iter1", reason: "running" },
      limits: { maxCycles: 2, maxAgentStarts: 1, maxEvaluatorRuns: 1, deadlineMs: 1000, plateauCycles: 1, maxCandidatesPerCycle: 1 },
      createdAt: new Date().toISOString(), deadlineAt: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(campaignRoot, "campaign-processes.json"), JSON.stringify({
      version: 1, agent_limit: 1, evaluator_limit: 1, agent_starts: 0, evaluator_runs: 0, last_start: null,
    }));
    await harness.commands.get("dream-rsi").handler("stop", context);
    assert.equal(fs.existsSync(path.join(campaignRoot, "stop.request")), true, "the stop request lands in the loop target's campaign");
    assert.match(harness.injectedMessages.at(-1).message.content, /Stop requested for the loop target/, "the report names the loop target it stopped");
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "campaigns")), false, "the calling project gains no campaign state");
  } finally { project.cleanup(); other.cleanup(); }
});

test("loop command routes to the unattended loop and enables it", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.commands.get("dream-rsi").handler("loop make the parser faster", context);
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0].content, /dream_rsi_loop/);
    assert.match(harness.sentMessages[0].content, /make the parser faster/);
    const loop = harness.tools.get("dream_rsi_loop");
    const started = await loop.execute("loop-after-command", { action: "start", include_logs: false, max_campaigns: 1, max_agent_starts: 1, max_evaluator_runs: 1, deadline_minutes: 1 }, undefined, undefined, context);
    assert.doesNotMatch(started.content[0].text, /requires an explicit improvement request/, "the loop command activates the loop");
    assert.match(started.content[0].text, /Dream-RSI loop finished: (empty inventory|no verifiable lever)/);
  } finally { project.cleanup(); }
});

test("headless help and retired manual verbs report without activating model work", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const command = harness.commands.get("dream-rsi");
    for (const mode of ["print", "rpc", "json"]) {
      context.mode = mode;
      await command.handler("help", context);
      const help = harness.injectedMessages.at(-1).message.content;
      assert.deepEqual(harness.injectedMessages.at(-1).options, { triggerTurn: false }, "idle hosts receive the report immediately, without waiting for another turn");
      assert.match(help, /arXiv 2609\.14858/);
      assert.match(help, /assess/);
      assert.match(help, /--no-logs/);
      assert.match(help, /Ctrl\+Shift\+D/);
      assert.doesNotMatch(help, /^\s*\/dream-rsi (?:create|suggest|best|live|dream|run|off)\b/im);
      await command.handler("watch", context);
      assert.match(harness.notifications.at(-1), /No campaign yet\. Run \/dream-rsi assess\./);
      await command.handler("watch legacy", context);
      assert.equal(harness.notifications.at(-1), "watch legacy was removed in 1.0. Use /dream-rsi improve <what you want>.");
      for (const verb of ["create", "suggest", "best", "live", "dream", "run", "off"]) {
        await command.handler(verb, context);
        assert.equal(harness.notifications.at(-1), `${verb} was removed in 1.0. Use /dream-rsi improve <what you want>.`);
      }
      await command.handler("resume 1", context);
      assert.equal(harness.notifications.at(-1), "resume 1 was removed in 1.0. Use /dream-rsi improve <what you want>.");
    }
    assert.equal(harness.sentMessages.length, 0, "read-only reports and invalid arguments never start an agent turn");
    fs.mkdirSync(path.join(project.dreamRoot, "history"), { recursive: true });
    fs.writeFileSync(path.join(project.dreamRoot, "task.json"), "preserve this old file", "utf8");
    await command.handler("status", context);
    assert.match(harness.notifications.at(-1), /Manual-loop data from an earlier version is in \.dream-rsi\/ \(task\.json, history\/\)\. 1\.0 does not use it\./);
    assert.equal(fs.readFileSync(path.join(project.dreamRoot, "task.json"), "utf8"), "preserve this old file");
    assert.deepEqual([...harness.tools.keys()], ["dream_rsi_improve", "dream_rsi_signals", "dream_rsi_loop"]);
    assert.equal(fs.existsSync(project.dreamRoot), true, "status reports legacy data without removing it");
    context.mode = "tui";
    const before = harness.injectedMessages.length;
    await command.handler("?", context);
    assert.match(harness.notifications.at(-1), /arXiv 2609\.14858/);
    assert.equal(harness.injectedMessages.length, before, "terminal help uses the UI notification");
  } finally { project.cleanup(); }
});

test("signals tool is read-only and receives the active session directory", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const signals = harness.tools.get("dream_rsi_signals");
    assert.ok(signals);
    assert.match(signals.description, /read-only/i);
    assert.equal(signals.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(signals.parameters.properties), ["focus", "include_logs"]);
    const result = await signals.execute("signals", { include_logs: false }, undefined, undefined, context);
    assert.equal(result.details.signals.diagnostics.some((item) => /session/i.test(item)), false);
    assert.ok(result.details.signals.weaknesses.length <= 10);
    assert.equal(fs.existsSync(project.dreamRoot), false, "signals do not create campaign state");
  } finally { project.cleanup(); }
});

test("tool parameter schemas stay validatable and strict", async () => {
  const project = makeProject();
  try {
    const { harness } = await boot(project);
    assert.equal(harness.tools.size, 3);
    for (const [name, tool] of harness.tools) {
      const schema = tool.parameters;
      assert.equal(schema.type, "object", `${name}: parameters must be an object schema`);
      assert.equal(schema.additionalProperties, false, `${name}: unknown parameters must be rejected`);
      const properties = Object.keys(schema.properties ?? {});
      assert.ok(properties.length > 0, `${name}: has properties`);
      for (const key of schema.required ?? []) {
        assert.ok(properties.includes(key), `${name}: required "${key}" must be declared`);
      }
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        assert.ok(typeof property.type === "string" || Array.isArray(property.type), `${name}.${key}: needs a type`);
        if (property.type === "array") assert.ok(property.items?.type, `${name}.${key}: needs item types`);
        assert.ok(typeof property.description === "string" && property.description.length > 0, `${name}.${key}: needs a description`);
      }
      assert.ok(typeof tool.description === "string" && tool.description.length > 40, `${name}: needs a real description`);
      assert.ok(typeof tool.promptSnippet === "string", `${name}: needs a prompt snippet`);
    }
    // Every guideline must name its own tool (pi appends them flat to the Guidelines section).
    for (const [name, tool] of harness.tools) {
      for (const guideline of tool.promptGuidelines ?? []) {
        assert.ok(guideline.includes(name), `guideline for ${name} must name the tool: ${guideline}`);
      }
    }
    const improve = harness.tools.get("dream_rsi_improve");
    assert.match(improve.parameters.properties.minimum_gain.description, /omit.*preflight-resolved threshold/i);
    assert.match(improve.promptGuidelines.join(" "), /review.*agent budget/i);
    assert.match(improve.promptGuidelines.join(" "), /active session model.*each agent call/i);
    assert.match(improve.description, /check.*before start/i);
    assert.match(improve.description, /reviewed/i);
  } finally {
    project.cleanup();
  }
});

test("task normalization fills defaults and rejects nonsense", () => {
  const normalized = normalizeTask({ name: "t", workspace: "seed", eval_program: "solution.py", score_program: "node score.mjs", higher_is_better: true });
  assert.equal(normalized.score_path, "eval/score.json");
  assert.equal(normalized.score_field, "score");
  assert.equal(normalized.workers, 4);
  assert.equal(normalized.k1, 6);
  assert.equal(normalized.k2, 8);
  assert.equal(normalized.revisions, 3);
  assert.equal(normalized.higher_is_better, true);
  assert.equal(normalized.agent.command, "pi");
  assert.ok(normalized.agent.args.includes("-p"));
  assert.ok(defaultTask().agent.args.includes("--no-context-files"), "attempts must not inherit context files");
  assert.ok(defaultTask().agent.args.includes("--no-prompt-templates"), "attempts must not inherit prompt templates");
  const customAgent = normalizeTask({
    name: "t",
    workspace: "seed",
    eval_program: "solution.py",
    score_program: "node score.mjs",
    higher_is_better: true,
    agent: { command: "pi", args: ["-p"], thinking: null, prompt_via: "stdin" },
  });
  assert.deepEqual(customAgent.agent.args, ["-p"], "stored agent_args pass through verbatim");
  assert.equal(normalized.agent.model, null, "no session snapshot is baked into task.json");
  assert.equal(normalized.agent.thinking, null);
  assert.deepEqual(normalized.beta_grid, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.equal(defaultTask().evaluator_timeout_ms, 300_000);
  assert.match(formatCandidateBrief({ goal: "reduce latency", direction: "minimize", metric: "p95 latency (ms)", minimumGain: "3%", scope: ["src/"], gates: ["npm test"], timeBudgetMs: 60_000 }), /Minimum gain: 3%/);

  assert.throws(() => normalizeTask({ name: "x", workspace: "", eval_program: "p", score_program: "c" }), /workspace must be a non-empty path/);
  assert.throws(() => normalizeTask({ name: "", workspace: "s", eval_program: "p", score_program: "c" }), /name must be a non-empty string/);
  assert.throws(() => normalizeTask({ name: "x", workspace: "s", eval_program: "p", score_program: "c", higher_is_better: true, beta_grid: [] }), /beta_grid/);
  assert.throws(() => normalizeTask({ name: "x", workspace: "s", eval_program: "p", score_program: "c", higher_is_better: true, k2: -1 }), /k2/);
  assert.match(validateTask({ ...defaultTask(), higher_is_better: undefined }).join("\n"), /higher_is_better must be explicitly/);
  assert.throws(() => normalizeTask({ name: "x", workspace: "s", eval_program: "p", score_program: "c" }), /higher_is_better must be explicitly/);
  assert.throws(
    () => normalizeTask({ name: "x", workspace: "s", eval_program: "p", score_program: "c", agent: { command: "pi", args: [], thinking: "purple", prompt_via: "stdin" } }),
    /agent\.thinking/,
  );
});
