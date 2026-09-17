/**
 * Extension surface: tool registration, mode gating, the four tools end to end (with stub agents), and
 * the session-prompt injection. The pi API is mocked — no TUI, no LLM.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { EXT, exists, jump, makeProject, mockPi, readJson } from "./fixtures.mjs";

const { default: dreamRsi } = await jump("index.ts");
const { normalizeTask } = await jump("engine/task.ts");
const { activeRuns } = await jump("state.ts");

async function boot(project) {
  const { pi, context, harness } = mockPi();
  dreamRsi(pi);
  context.cwd = project.projectDir;
  await harness.handlers.get("session_start")({}, context);
  return { pi, context, harness };
}

function initParams(project, extra = {}) {
  return {
    name: "fixture",
    workspace: "seed",
    eval_program: "solution.py",
    score_program: project.task.score_program,
    problem_file: "PROBLEM.md",
    workers: 2,
    k1: 3,
    k2: 4,
    revisions: 2,
    beta_grid: [0, 0.6],
    agent_command: "node",
    agent_args: [project.script("agent-router.mjs")],
    ...extra,
  };
}

test("registers four tools, one command and the lifecycle hooks", async () => {
  const project = makeProject();
  try {
    const { harness } = await boot(project);
    assert.deepEqual([...harness.tools.keys()], ["dream_rsi_init", "dream_rsi_live", "dream_rsi_dream", "dream_rsi_status"]);
    assert.deepEqual([...harness.commands.keys()], ["dream-rsi"]);
    for (const event of ["session_start", "session_tree", "session_shutdown", "before_agent_start", "agent_start", "resources_discover"]) {
      assert.equal(typeof harness.handlers.get(event), "function", `${event} hook registered`);
    }
    // The skill is contributed by the extension itself, so it is discoverable however we were loaded.
    const resources = await harness.handlers.get("resources_discover")({ cwd: project.projectDir, reason: "startup" }, null);
    assert.deepEqual(resources.skillPaths, [path.join(EXT, "..", "..", "skills")]);
    assert.ok(exists(path.join(resources.skillPaths[0], "dream-rsi", "SKILL.md")));
  } finally {
    project.cleanup();
  }
});

test("init writes task.json, seeds the policy runtime, and gates the expensive tools", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    assert.equal(harness.activeTools.includes("dream_rsi_live"), false, "expensive tools start disabled");

    const result = await harness.tools.get("dream_rsi_init").execute("c1", initParams(project, { default_beta: 0.4 }), undefined, undefined, context);
    assert.match(result.content[0].text, /Dream-RSI configured/);

    const task = readJson(path.join(project.dreamRoot, "task.json"));
    assert.equal(task.name, "fixture");
    assert.equal(task.workers, 2);
    assert.equal(task.default_beta, 0.4);
    assert.equal(task.score_path, "eval/score.json", "defaults are filled in");
    assert.equal(task.agent.command, "node");

    // The seeded policy carries the configured beta and its relative imports.
    for (const name of ["method.ts", "api.ts", "observation-signal.ts"]) {
      assert.ok(exists(path.join(project.dreamRoot, "policy", name)), `${name} seeded`);
    }
    assert.match(fs.readFileSync(path.join(project.dreamRoot, "policy", "method.ts"), "utf8"), /default_beta = 0\.4;/);
    assert.equal(harness.activeTools.includes("dream_rsi_live"), true, "init activates Dream-RSI mode");
    assert.equal(harness.activeTools.includes("dream_rsi_dream"), true);
    assert.ok(harness.statuses.some(([key, value]) => key === "dream-rsi" && value === "dream-rsi: active"));

    // A second init keeps the existing policy unless a reset is requested.
    fs.writeFileSync(path.join(project.dreamRoot, "policy", "method.ts"), "// operator tweak\n", "utf8");
    await harness.tools.get("dream_rsi_init").execute("c2", initParams(project), undefined, undefined, context);
    assert.equal(fs.readFileSync(path.join(project.dreamRoot, "policy", "method.ts"), "utf8"), "// operator tweak\n");
    await harness.tools.get("dream_rsi_init").execute("c3", initParams(project, { reset: true }), undefined, undefined, context);
    assert.match(fs.readFileSync(path.join(project.dreamRoot, "policy", "method.ts"), "utf8"), /EVOLVE-BLOCK-START/);
  } finally {
    project.cleanup();
  }
});

test("init refuses an unusable configuration instead of writing it", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const bad = await harness.tools
      .get("dream_rsi_init")
      .execute("c1", initParams(project, { workspace: "does-not-exist" }), undefined, undefined, context);
    assert.match(bad.content[0].text, /workspace does not exist/);
    assert.equal(exists(path.join(project.dreamRoot, "task.json")), false);

    const invalid = await harness.tools.get("dream_rsi_init").execute("c2", initParams(project, { workers: 0 }), undefined, undefined, context);
    assert.match(invalid.content[0].text, /workers must be a number/);
  } finally {
    project.cleanup();
  }
});

test("live then dream through the tools, with status reporting the recorded world", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);

    const updates = [];
    const live = await harness.tools
      .get("dream_rsi_live")
      .execute("c2", {}, undefined, (u) => updates.push(u.content[0].text), context);
    assert.match(live.content[0].text, /Live cycle 1/);
    assert.equal(live.details.attempts, 6);
    assert.equal(live.details.rounds, 3);
    assert.ok(live.details.best > 0);
    assert.ok(updates.some((text) => /grid 2 branches x 3 refinements/.test(text)), "progress streams the plan");
    assert.ok(updates.some((text) => /round 1: attempt/.test(text)), "progress streams each attempt");

    const dream = await harness.tools.get("dream_rsi_dream").execute("c3", {}, undefined, undefined, context);
    assert.match(dream.content[0].text, /Dreaming phase 1 complete/);
    assert.equal(dream.details.ok, true);
    assert.equal(dream.details.worlds, 1);
    assert.equal(dream.details.improved, true);

    const status = await harness.tools.get("dream_rsi_status").execute("c4", { detail: "full" }, undefined, undefined, context);
    assert.match(status.content[0].text, /iterations \(world t, best, beta, attempts, rounds\)/);
    assert.match(status.content[0].text, /t=1: status=complete/);
    assert.match(status.content[0].text, /sweep pareto\.reward=/);
    assert.match(status.content[0].text, /pi_1: V=/);
    assert.match(status.content[0].text, /policy\\method\.ts \(versions: v0000\.ts, v0001\.ts\)/);

    // The system prompt carries the protocol note and the live status.
    const injected = await harness.handlers.get("before_agent_start")({ systemPrompt: "BASE" }, context);
    assert.ok(injected.systemPrompt.startsWith("BASE"));
    assert.match(injected.systemPrompt, /Dream-RSI Mode \(ACTIVE\)/);
    assert.match(injected.systemPrompt, /t=1: status=complete/);
  } finally {
    project.cleanup();
  }
});

test("an explicit grid overrides plan_grid, and a malformed one falls back with a reason", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);

    const explicit = await harness.tools.get("dream_rsi_live").execute("c2", { grid: "3x2" }, undefined, undefined, context);
    assert.deepEqual(explicit.details.grid, { branch_count: 3, refine_count: 2, reason: explicit.details.grid.reason });
    assert.match(explicit.details.grid.reason, /explicit grid from the operator/);
    assert.equal(explicit.details.attempts, 6);

    const malformed = await harness.tools.get("dream_rsi_live").execute("c3", { grid: "wide" }, undefined, undefined, context);
    assert.match(malformed.details.grid.reason, /not understood/);
  } finally {
    project.cleanup();
  }
});

test("gated tools refuse to run before a task exists, and off-mode disables them again", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const early = await harness.tools.get("dream_rsi_live").execute("c1", {}, undefined, undefined, context);
    assert.match(early.content[0].text, /no task\.json/);

    await harness.tools.get("dream_rsi_init").execute("c2", initParams(project), undefined, undefined, context);
    assert.equal(harness.activeTools.includes("dream_rsi_live"), true);
    await harness.commands.get("dream-rsi").handler("off", context);
    assert.equal(harness.activeTools.includes("dream_rsi_live"), false, "off-mode disables the expensive tools");
    assert.equal(harness.activeTools.includes("dream_rsi_status"), true, "read-only tools stay available");

    await harness.commands.get("dream-rsi").handler("status", context);
    assert.match(harness.notifications.at(-1), /Dream-RSI — fixture/);
    await harness.commands.get("dream-rsi").handler("", context);
    assert.match(harness.notifications.at(-1), /arXiv 2609\.14858/);
  } finally {
    project.cleanup();
  }
});

test("mode survives a session rebuild from custom entries, and in-flight cycles are visible", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);

    // Fresh runtime (as after /reload or resume): state must come back from the entries.
    const second = mockPi();
    dreamRsi(second.pi);
    second.context.cwd = project.projectDir;
    second.harness.entries.push(...harness.entries);
    await second.harness.handlers.get("session_start")({}, second.context);
    assert.equal(second.harness.activeTools.includes("dream_rsi_live"), true, "mode restored from the session entries");

    // A mode recorded on another branch must not leak into the current one.
    const third = mockPi();
    dreamRsi(third.pi);
    third.context.cwd = project.projectDir;
    third.harness.entries.push(...harness.entries);
    third.harness.branch = []; // entries exist in the log, but not on this branch
    await third.harness.handlers.get("session_start")({}, third.context);
    assert.equal(third.harness.activeTools.includes("dream_rsi_live"), false, "branch-local state stays local");

    // A crashed cycle leaves its `_current` mirror behind; status must not pretend everything is fine.
    const iterationDir = path.join(project.dreamRoot, "trace_pool", "iter0001_current");
    fs.mkdirSync(iterationDir, { recursive: true });
    fs.writeFileSync(
      path.join(iterationDir, "live_cycle_manifest.json"),
      JSON.stringify({ iteration: 1, status: "running", attempts: 0, best_score: null, baked_beta: 0.6 }),
      "utf8",
    );
    assert.deepEqual(activeRuns(project.dreamRoot), ["live cycle 0001 (in flight)"]);
    const status = await second.harness.tools.get("dream_rsi_status").execute("c2", {}, undefined, undefined, second.context);
    assert.match(status.content[0].text, /in flight: live cycle 0001/);
  } finally {
    project.cleanup();
  }
});

test("path arguments tolerate a leading @ from the model", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const result = await harness.tools
      .get("dream_rsi_init")
      .execute("c1", initParams(project, { workspace: "@seed", problem_file: "@PROBLEM.md" }), undefined, undefined, context);
    assert.match(result.content[0].text, /Dream-RSI configured/);
    const task = readJson(path.join(project.dreamRoot, "task.json"));
    assert.equal(task.workspace, "seed");
    assert.equal(task.problem_file, "PROBLEM.md");
  } finally {
    project.cleanup();
  }
});

test("tool parameter schemas stay validatable and strict", async () => {
  const project = makeProject();
  try {
    const { harness } = await boot(project);
    assert.equal(harness.tools.size, 4);
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
  assert.deepEqual(normalized.beta_grid, [0, 0.2, 0.4, 0.6, 0.8, 1]);

  assert.throws(() => normalizeTask({ name: "x", workspace: "", eval_program: "p", score_program: "c" }), /workspace must be a non-empty path/);
  assert.throws(() => normalizeTask({ name: "", workspace: "s", eval_program: "p", score_program: "c" }), /name must be a non-empty string/);
  assert.throws(() => normalizeTask({ name: "x", workspace: "s", eval_program: "p", score_program: "c", beta_grid: [] }), /beta_grid/);
  assert.throws(() => normalizeTask({ name: "x", workspace: "s", eval_program: "p", score_program: "c", k2: -1 }), /k2/);
});

test("a policy that reaches outside the prefix is blocked before it runs", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    fs.writeFileSync(
      path.join(project.dreamRoot, "policy", "method.ts"),
      'import * as fs from "node:fs";\nexport class OptimalPolicy { async solve() { return { best_score: null, probes: 0, rounds: 0, stopped: null, curve: [] }; } }\n',
      "utf8",
    );

    const live = await harness.tools.get("dream_rsi_live").execute("c2", {}, undefined, undefined, context);
    assert.match(live.content[0].text, /FAILED|failed/, "a non-prefix-only policy must not run");
    const manifest = readJson(path.join(project.dreamRoot, "trace_pool", "iter0001", "live_cycle_manifest.json"));
    assert.equal(manifest.status, "failed");
    assert.match(manifest.note, /node:fs/);
  } finally {
    project.cleanup();
  }
});
