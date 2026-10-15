/** Campaign extension surface, command safety, and task validation. */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { EXT, exists, makeProject, mockPi, readJson } from "./fixtures.mjs";

const { default: dreamRsi } = await import("../extensions/pi-dream-rsi/index.ts");
const { defaultTask, normalizeTask } = await import("../extensions/pi-dream-rsi/engine/task.ts");

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
    assert.deepEqual([...harness.tools.keys()], ["dream_rsi_improve", "dream_rsi_signals"]);
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
        agent_command: "node",
        agent_args: [project.script("agent-ok.mjs")],
      },
      verifier_inputs: ["score-ok.mjs"],
      minimum_gain: -0.01,
    }, undefined, undefined, context);
    assert.match(invalidGain.content[0].text, /minimum_gain must be a finite, non-negative normalized-score delta/);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "task.json")), false, "direct campaign intake never writes legacy task.json");
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "campaigns")), false, "invalid intake does not create campaign state");
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
    assert.ok(verbs.includes("status"));
    assert.ok(verbs.includes("stop"));
    assert.ok(!verbs.includes("create"));
    assert.ok(!verbs.includes("suggest"));
    assert.ok(!verbs.includes("live"));
    assert.deepEqual(complete("res").map((item) => item.value), ["resume"]);
    assert.deepEqual(complete("ass").map((item) => item.value), ["assess"]);
    assert.deepEqual(complete("imp").map((item) => item.value), ["improve"]);
    assert.deepEqual(complete("watch").map((item) => item.value), ["watch"]);
    assert.equal(complete("improve my program"), null, "free-text goals remain free text");
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(fs.existsSync(project.dreamRoot), false, "completion does not create task state");
  } finally { project.cleanup(); }
});

test("assess is read-only and works without a configured Dream-RSI task", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.commands.get("dream-rsi").handler("assess src/cache.ts", context);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].content, "/skill:dream-rsi-assess src/cache.ts");
    assert.deepEqual([...harness.tools.keys()], ["dream_rsi_improve", "dream_rsi_signals"]);
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
    assert.deepEqual([...harness.tools.keys()], ["dream_rsi_improve", "dream_rsi_signals"]);
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
    assert.equal(harness.tools.size, 2);
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
        assert.ok(typeof property.type === "string", `${name}.${key}: needs a type`);
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
    assert.match(improve.parameters.properties.minimum_gain.description, /omit.*calibrat/i);
    assert.match(improve.promptGuidelines.join(" "), /review.*agent budget/i);
    assert.match(improve.promptGuidelines.join(" "), /active session model.*each agent call/i);
    assert.match(improve.description, /check.*before start/i);
    assert.match(improve.description, /reviewed/i);
  } finally {
    project.cleanup();
  }
});

test("task normalization fills defaults and rejects nonsense", () => {
  const normalized = normalizeTask({ name: "t", workspace: "seed", eval_program: "solution.py", score_program: "node score.mjs" });
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
    agent: { command: "pi", args: ["-p"], thinking: null, prompt_via: "stdin" },
  });
  assert.deepEqual(customAgent.agent.args, ["-p"], "stored agent_args pass through verbatim");
  assert.equal(normalized.agent.model, null, "no session snapshot is baked into task.json");
  assert.equal(normalized.agent.thinking, null);
  assert.deepEqual(normalized.beta_grid, [0, 0.2, 0.4, 0.6, 0.8, 1]);

  assert.throws(() => normalizeTask({ name: "x", workspace: "", eval_program: "p", score_program: "c" }), /workspace must be a non-empty path/);
  assert.throws(() => normalizeTask({ name: "", workspace: "s", eval_program: "p", score_program: "c" }), /name must be a non-empty string/);
  assert.throws(() => normalizeTask({ name: "x", workspace: "s", eval_program: "p", score_program: "c", beta_grid: [] }), /beta_grid/);
  assert.throws(() => normalizeTask({ name: "x", workspace: "s", eval_program: "p", score_program: "c", k2: -1 }), /k2/);
  assert.throws(
    () => normalizeTask({ name: "x", workspace: "s", eval_program: "p", score_program: "c", agent: { command: "pi", args: [], thinking: "purple", prompt_via: "stdin" } }),
    /agent\.thinking/,
  );
});
