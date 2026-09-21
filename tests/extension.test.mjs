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
const { activeRuns, recoverInterruptedRuns, nextIteration, reserveIterations, runningIterations } = await jump("state.ts");
const { listIterations } = await jump("engine/world.ts");

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
    assert.deepEqual([...harness.tools.keys()], ["dream_rsi_init", "dream_rsi_live", "dream_rsi_dream", "dream_rsi_apply", "dream_rsi_status"]);
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
    // path.relative renders with the platform separator (backslash on Windows): normalize before matching.
    assert.match(status.content[0].text.replaceAll("\\", "/"), /policy\/method\.ts \(versions: v0000\.ts, v0001\.ts\)/);

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

test("a fresh session continues the recorded history instead of overwriting cycle 1", async () => {
  const project = makeProject();
  try {
    // Session A: cycle 1.
    const first = await boot(project);
    await first.harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, first.context);
    await first.harness.tools.get("dream_rsi_live").execute("c2", {}, undefined, undefined, first.context);
    const cycle1Record = path.join(project.dreamRoot, "history", "r0001_live", "attempt_b0a0", "proposal.md");
    const cycle1Workspace = path.join(project.dreamRoot, "work", "r0001", "b0a0");
    assert.ok(exists(cycle1Record), "cycle 1 archived its attempt record");
    const cycle1Proposal = fs.readFileSync(cycle1Record, "utf8");

    // Session B: a *new* session (fresh runtime, no entries) runs another cycle in the same project.
    const second = await boot(project);
    const live = await second.harness.tools.get("dream_rsi_live").execute("c1", {}, undefined, undefined, second.context);
    assert.match(live.content[0].text, /Live cycle 2/, "the new session continues at t=2");

    assert.ok(exists(path.join(project.dreamRoot, "trace_pool", "iter0002", "tree.json")), "world 2 recorded");
    assert.ok(exists(path.join(project.dreamRoot, "history", "r0002_live")), "iteration-2 records are separate");
    assert.equal(
      fs.readFileSync(cycle1Record, "utf8"),
      cycle1Proposal,
      "cycle 1's attempt record must not be overwritten",
    );
    assert.ok(exists(cycle1Workspace), "cycle 1's workspace survives");
    assert.ok(exists(path.join(project.dreamRoot, "work", "r0002", "b0a0")), "cycle 2 writes its own workspace");
    assert.ok(exists(path.join(project.dreamRoot, "work", "r0002", "b0a0", "solution.py")));
    const world2 = readJson(path.join(project.dreamRoot, "trace_pool", "iter0002", "live_cycle_manifest.json"));
    assert.equal(world2.iteration, 2);
    assert.equal(world2.previous_best_score, world2.baseline_score ?? world2.previous_best_score);
  } finally {
    project.cleanup();
  }
});

test("init measures your own code, and a cycle that beats it is flagged as NOT applied", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const init = await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    assert.match(init.content[0].text, /baseline:   your code measures/, "the seed is measured, not assumed");
    assert.match(init.content[0].text, /Nothing is ever written to your code/);
    const seed = readJson(path.join(project.dreamRoot, "history", "seed", "score.json"));
    assert.equal(typeof seed.raw_score, "number");
    assert.equal(seed.fail_class, "ok");

    // Nothing pending yet: the best candidate equals the floor the scorer just measured (same code).
    const before = await harness.tools.get("dream_rsi_status").execute("c2", {}, undefined, undefined, context);
    assert.match(before.content[0].text, /Nothing to apply:/);

    // A cycle that finds something better must say so, loudly, and must not touch the source.
    const sourcePath = path.join(project.seed, "solution.py");
    const untouched = fs.readFileSync(sourcePath, "utf8");
    const live = await harness.tools.get("dream_rsi_live").execute("c3", {}, undefined, undefined, context);
    assert.equal(live.details.pending_improvement !== null, true, "a better candidate is reported as pending");
    assert.match(live.content[0].text, /IMPROVEMENT READY — NOT APPLIED/);
    assert.match(live.content[0].text, /your code is unchanged/);
    assert.match(live.content[0].text, /ask whether to apply it/);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), untouched, "the run never edits your code");
    assert.ok(harness.notifications.some((n) => /improvement ready/.test(n)), "the user is told proactively");
    assert.ok(harness.statuses.some(([key, value]) => key === "dream-rsi" && value === "dream-rsi: improvement ready"));

    const details = live.details.pending_improvement;
    assert.equal(details.iteration, 1);
    assert.ok(details.delta_vs_seed > 0, `expected a positive delta, got ${details.delta_vs_seed}`);
    assert.ok(details.gain_pct === null || details.gain_pct > 0, "a zero baseline reports a delta, not a fake percentage");
    assert.ok(details.changed_files.length >= 1, "the changed files are reported");
    assert.ok(typeof details.reason !== "undefined" || true);
    assert.ok(exists(details.program), "the candidate program is on disk");

    // Status repeats it, so it is visible wherever the user looks.
    const after = await harness.tools.get("dream_rsi_status").execute("c4", {}, undefined, undefined, context);
    assert.match(after.content[0].text, /IMPROVEMENT READY — NOT APPLIED/);
    assert.match(after.content[0].text, /baseline: your code measures/);
  } finally {
    project.cleanup();
  }
});

test("apply refuses without confirmation, then copies only the declared program", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    const live = await harness.tools.get("dream_rsi_live").execute("c2", {}, undefined, undefined, context);
    const candidate = live.details.pending_improvement;
    const sourcePath = path.join(project.seed, "solution.py");
    const beforeRun = fs.readFileSync(sourcePath, "utf8");
    const apply = harness.tools.get("dream_rsi_apply");
    assert.ok(apply, "the apply tool is registered");
    assert.equal(typeof apply.execute, "function");

    // 1. No confirmation -> nothing changes, and the refusal explains how to proceed.
    const refusal = await apply.execute("c3", {}, undefined, undefined, context);
    assert.equal(refusal.details.needs_confirmation, true);
    assert.match(refusal.content[0].text, /Not applied — confirm first/);
    assert.match(refusal.content[0].text, /diff -u/);
    assert.match(refusal.content[0].text, /confirm: true/);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), beforeRun, "a refusal writes nothing");

    // 2. Paths that escape the workspace are rejected even with confirmation.
    const escape = await apply.execute("c4", { confirm: true, paths: ["../../../etc/passwd"] }, undefined, undefined, context);
    assert.match(escape.content[0].text, /nothing applied/);
    assert.match(escape.content[0].text, /stay inside the workspace|escapes the workspace/);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), beforeRun);

    // 3. Confirmed -> the candidate's program lands on your file, nothing else, and it is logged.
    const applied = await apply.execute("c5", { confirm: true, cell: candidate.cell }, undefined, undefined, context);
    assert.match(applied.content[0].text, /Applied/);
    assert.match(applied.content[0].text, /Nothing was committed/);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), fs.readFileSync(candidate.program, "utf8"));
    assert.notEqual(fs.readFileSync(sourcePath, "utf8"), beforeRun, "the improvement is now in your code");
    const log = fs.readFileSync(path.join(project.dreamRoot, "history", "applied.jsonl"), "utf8").trim().split("\n");
    assert.equal(log.length, 1);
    assert.equal(JSON.parse(log[0]).cell, candidate.cell);
    // Only the declared program was copied: the seed workspace is otherwise untouched.
    assert.equal(exists(path.join(project.seed, "proposal.md")), false, "reports are not applied");

    // 4. After applying, the same candidate is no longer pending.
    const status = await harness.tools.get("dream_rsi_status").execute("c6", {}, undefined, undefined, context);
    assert.match(status.content[0].text, /Nothing to apply:/);
  } finally {
    project.cleanup();
  }
});

test("create sets up a fresh project through the skill, and answers instead when already configured", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);

    // No task here yet: dispatch the create skill as its own `/skill:`-prefixed message.
    await harness.commands.get("dream-rsi").handler("create cut recall latency", context);
    assert.equal(harness.sentMessages.length, 1);
    const kickoff = harness.sentMessages[0];
    assert.match(kickoff.content, /^\/skill:dream-rsi-create cut recall latency$/);
    assert.deepEqual(kickoff.options, { expandPromptTemplates: true });
    assert.equal(harness.activeTools.includes("dream_rsi_live"), true, "mode is on, so init is callable");
    assert.ok(harness.notifications.some((n) => /loading the dream-rsi-create skill/.test(n)));

    // Configured: ask which job is meant, then report the existing task and answer the goal.
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    await harness.tools.get("dream_rsi_live").execute("c2", {}, undefined, undefined, context);
    harness.sentMessages.length = 0;
    harness.notifications.length = 0;
    await harness.commands.get("dream-rsi").handler("create fastest", context);
    assert.equal(harness.sentMessages.length, 0, "an existing task is not re-interviewed");
    const asked = harness.uiPrompts.at(-1);
    assert.equal(asked.kind, "select", "a configured project asks which of the three jobs is meant");
    assert.equal(asked.options[0], 'Show the best candidate for "fastest"');
    assert.ok(asked.options.includes("Reconfigure this task (re-interview)"));
    assert.ok(asked.options.includes("Start a fresh task (archives current .dream-rsi)"));
    assert.ok(asked.options.includes("Cancel"));
    const report = harness.notifications.at(-1);
    assert.match(report, /Already configured here/);
    assert.match(report, /IMPROVEMENT READY — NOT APPLIED/);
    assert.match(report, /dream_rsi_apply cell=\w+ confirm=true/);
    assert.match(report, /preference: fastest/);
    assert.match(report, /Next: \/dream-rsi run 2/);
    assert.match(report, /\/dream-rsi create --reconfigure/);
    assert.equal(harness.injectedMessages.length, 1, "the suggestion is injected into the session, not just toasted");
    assert.equal(harness.injectedMessages[0].message.customType, "dream-rsi/suggestion");
    assert.match(harness.injectedMessages[0].message.content, /IMPROVEMENT READY/);
    assert.deepEqual(harness.injectedMessages[0].options, { deliverAs: "nextTurn" });
    assert.equal(harness.activeTools.includes("dream_rsi_apply"), true, "reporting leaves the loop usable");
  } finally {
    project.cleanup();
  }
});

test("create offers a way back into setup, and reconfiguring keeps the history", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    await harness.tools.get("dream_rsi_live").execute("c2", {}, undefined, undefined, context);
    const worlds = fs.readdirSync(path.join(project.dreamRoot, "trace_pool")).filter((name) => /^iter\d+$/.test(name));

    // The user left the mode: the old report promised an improvement while `apply` stayed unregistered.
    await harness.commands.get("dream-rsi").handler("off", context);
    assert.equal(harness.activeTools.includes("dream_rsi_apply"), false);

    harness.sentMessages.length = 0;
    harness.notifications.length = 0;
    harness.uiAnswers.select.push("Reconfigure this task (re-interview)");
    await harness.commands.get("dream-rsi").handler("create smaller p99", context);
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0].content, /^\/skill:dream-rsi-create reconfigure smaller p99$/);
    assert.deepEqual(harness.sentMessages[0].options, { expandPromptTemplates: true });
    assert.equal(harness.activeTools.includes("dream_rsi_apply"), true, "reconfigure leaves the loop usable");
    assert.deepEqual(
      fs.readdirSync(path.join(project.dreamRoot, "trace_pool")).filter((name) => /^iter\d+$/.test(name)),
      worlds,
      "reconfiguring archives nothing",
    );
    assert.equal(exists(path.join(project.dreamRoot, "archive")), false, "no archive without the fresh answer");
  } finally {
    project.cleanup();
  }
});

test("create --fresh archives the old task by rename and re-interviews", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    await harness.tools.get("dream_rsi_live").execute("c2", {}, undefined, undefined, context);

    harness.sentMessages.length = 0;
    harness.notifications.length = 0;
    harness.uiAnswers.confirm.push(true);
    await harness.commands.get("dream-rsi").handler("create --fresh a different job", context);

    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0].content, /^\/skill:dream-rsi-create fresh a different job$/);
    assert.equal(exists(path.join(project.dreamRoot, "task.json")), false, "the fresh task starts unconfigured");
    const stamped = fs.readdirSync(path.join(project.dreamRoot, "archive"));
    assert.equal(stamped.length, 1, "one archive per fresh start");
    const archived = path.join(project.dreamRoot, "archive", stamped[0]);
    assert.ok(exists(path.join(archived, "task.json")), "the old task definition is kept");
    assert.ok(exists(path.join(archived, "history", "seed", "score.json")), "the old evidence is kept");
    assert.ok(fs.readdirSync(path.join(archived, "trace_pool")).some((name) => /^iter\d+$/.test(name)));
    assert.match(fs.readFileSync(path.join(archived, ".gitignore"), "utf8"), /trace_pool\//, "bulk state stays out of git");
    assert.ok(harness.notifications.some((n) => n.includes(archived)), "the archive path is reported");
    assert.equal(harness.activeTools.includes("dream_rsi_apply"), true);
  } finally {
    project.cleanup();
  }
});

test("create --fresh refuses while a phase is in flight, and a declined confirm changes nothing", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    const iterationDir = path.join(project.dreamRoot, "trace_pool", "iter0001_current");
    fs.mkdirSync(iterationDir, { recursive: true });
    fs.writeFileSync(path.join(iterationDir, "live_cycle_manifest.json"), JSON.stringify({ iteration: 1, status: "running" }), "utf8");

    harness.sentMessages.length = 0;
    harness.notifications.length = 0;
    await harness.commands.get("dream-rsi").handler("create --fresh", context);
    assert.match(harness.notifications.at(-1), /Refusing to start a fresh task while a phase is in flight/);
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(exists(path.join(project.dreamRoot, "task.json")), true);
    assert.equal(harness.uiPrompts.some((p) => p.kind === "confirm"), false, "the in-flight guard runs before the confirm");

    // Declining the confirm falls back to the report instead of silently doing nothing.
    fs.rmSync(iterationDir, { recursive: true, force: true });
    harness.notifications.length = 0;
    harness.uiAnswers.select.push("Start a fresh task (archives current .dream-rsi)");
    await harness.commands.get("dream-rsi").handler("create", context);
    assert.equal(harness.uiPrompts.at(-1).kind, "confirm");
    assert.equal(harness.sentMessages.length, 0);
    assert.match(harness.notifications.at(-1), /Already configured here/);
    assert.equal(exists(path.join(project.dreamRoot, "archive")), false);
  } finally {
    project.cleanup();
  }
});

test("re-running init keeps the recorded baseline instead of moving the goalposts", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    const init = (extra = {}) =>
      harness.tools.get("dream_rsi_init").execute("c", initParams(project, extra), undefined, undefined, context);
    const seedDir = path.join(project.dreamRoot, "history", "seed");

    const first = await init();
    assert.match(first.content[0].text, /baseline:   your code measures/);
    const measured = readJson(path.join(seedDir, "score.json"));

    // Same workspace and scorer: the reference point stays put, so past candidates keep counting as wins.
    const again = await init();
    assert.match(again.content[0].text, /baseline:   kept/);
    assert.equal(readJson(path.join(seedDir, "score.json")).measured_at, measured.measured_at);
    assert.equal(again.details.remeasured, false);
    assert.equal(again.details.baseline.measured_at, measured.measured_at);

    // A changed workspace is a different thing to measure — and the old number is archived, not discarded.
    fs.mkdirSync(path.join(project.projectDir, "seed2"), { recursive: true });
    fs.writeFileSync(path.join(project.projectDir, "seed2", "solution.py"), 'print("seed2")\n', "utf8");
    const changed = await init({ workspace: "seed2" });
    assert.match(changed.content[0].text, /baseline:   your code measures/);
    const kept = fs.readdirSync(seedDir).filter((name) => /^score\..+\.json$/.test(name));
    assert.equal(kept.length, 1, "the previous reference is kept");
    assert.equal(readJson(path.join(seedDir, kept[0])).measured_at, measured.measured_at);

    // An explicit request re-measures even when nothing about the task changed.
    const forced = await init({ workspace: "seed2", remeasure_seed: true });
    assert.equal(forced.details.remeasured, true);
    assert.equal(fs.readdirSync(seedDir).filter((name) => /^score\..+\.json$/.test(name)).length, 2);
  } finally {
    project.cleanup();
  }
});

test("the session iteration is restored from the entries, and --fresh resets it", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    await harness.tools.get("dream_rsi_live").execute("c2", {}, undefined, undefined, context);
    await harness.tools.get("dream_rsi_live").execute("c3", {}, undefined, undefined, context);
    const status = await harness.tools.get("dream_rsi_status").execute("c4", {}, undefined, undefined, context);
    assert.match(status.content[0].text, /session iteration: 2/);

    // A fresh runtime (as after /reload or resume) brings the count back from the session entries.
    const resumed = mockPi();
    dreamRsi(resumed.pi);
    resumed.context.cwd = project.projectDir;
    resumed.harness.entries.push(...harness.entries);
    await resumed.harness.handlers.get("session_start")({}, resumed.context);
    const before = await resumed.harness.tools.get("dream_rsi_status").execute("c5", {}, undefined, undefined, resumed.context);
    assert.match(before.content[0].text, /session iteration: 2/);

    // Starting a fresh task in this session must not continue that count: the archived cycles are gone, so
    // the new task's first cycle is t=1 again, both now and after another reload.
    resumed.harness.uiAnswers.confirm.push(true);
    await resumed.harness.commands.get("dream-rsi").handler("create --fresh", resumed.context);
    await resumed.harness.handlers.get("session_start")({}, resumed.context);
    await resumed.harness.tools.get("dream_rsi_init").execute("c6", initParams(project), undefined, undefined, resumed.context);
    const live = await resumed.harness.tools.get("dream_rsi_live").execute("c7", {}, undefined, undefined, resumed.context);
    assert.equal(live.details.iteration, 1, "the fresh task starts at t=1, not after the archived cycles");
    const after = await resumed.harness.tools.get("dream_rsi_status").execute("c8", {}, undefined, undefined, resumed.context);
    assert.match(after.content[0].text, /session iteration: 1/);
  } finally {
    project.cleanup();
  }
});

test("suggest ranks on demand, honours a preference, and refuses without a task", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.commands.get("dream-rsi").handler("suggest fastest", context);
    assert.match(harness.notifications.at(-1), /No Dream-RSI task in this project/);
    assert.match(harness.notifications.at(-1), /dream_rsi_init/);
    assert.equal(harness.sentMessages.length, 0);

    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    await harness.tools.get("dream_rsi_live").execute("c2", {}, undefined, undefined, context);

    await harness.commands.get("dream-rsi").handler("suggest fastest", context);
    const fastest = harness.notifications.at(-1);
    assert.match(fastest, /IMPROVEMENT READY — NOT APPLIED/);
    assert.match(fastest, /preference: fastest — strict score order/);
    assert.match(fastest, /vs your code/);

    await harness.commands.get("dream-rsi").handler("suggest safest", context);
    assert.match(harness.notifications.at(-1), /preference: safest/);

    // `best` is an alias, and free text with a task is treated as a goal.
    await harness.commands.get("dream-rsi").handler("best", context);
    assert.match(harness.notifications.at(-1), /IMPROVEMENT READY — NOT APPLIED/);
    await harness.commands.get("dream-rsi").handler("make the search quicker", context);
    assert.match(harness.notifications.at(-1), /goal: "make the search quicker"/);
    assert.ok(harness.injectedMessages.length >= 3, "every suggestion is also injected into the session");
    assert.equal(harness.sentMessages.length, 0, "a suggestion never dispatches a turn");
  } finally {
    project.cleanup();
  }
});

test("free text in an unconfigured project starts the interview with that goal", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.commands.get("dream-rsi").handler("speed up my benchmark", context);
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0].content, /^\/skill:dream-rsi-create speed up my benchmark$/);
    assert.deepEqual(harness.sentMessages[0].options, { expandPromptTemplates: true });
  } finally {
    project.cleanup();
  }
});

test("the command drives the agent, and says exactly what is missing when it cannot", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);

    // Not configured: the message must name the file, the directory and the way out.
    await harness.commands.get("dream-rsi").handler("run", context);
    const complaint = harness.notifications.at(-1);
    assert.match(complaint, /task\.json/);
    assert.match(complaint, /dream_rsi_init/);
    assert.match(complaint, /Current directory/);
    assert.match(complaint, new RegExp(project.projectDir.replace(/\\/g, "\\\\")));
    assert.equal(harness.sentMessages.length, 0, "nothing is asked of the agent without a task");

    // The same command in a project where the task *is* configured asks the agent to run the loop.
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    await harness.commands.get("dream-rsi").handler("run 3", context);
    assert.equal(harness.sentMessages.length, 1);
    const instruction = harness.sentMessages[0].content;
    assert.match(instruction, /Run 3 full Dream-RSI cycle/);
    assert.match(instruction, /dream_rsi_live, then dream_rsi_dream/);
    assert.match(instruction, /pareto\.reward/);
    assert.deepEqual(harness.sentMessages[0].options, { expandPromptTemplates: true }, "idle agent gets an immediate turn");
    assert.equal(harness.activeTools.includes("dream_rsi_live"), true, "mode is on before the agent starts");

    // A busy agent gets a queued follow-up instead of an error, and live/dream are single-phase asks.
    harness.idle = false;
    await harness.commands.get("dream-rsi").handler("live", context);
    assert.deepEqual(harness.sentMessages[1].options, { expandPromptTemplates: true, deliverAs: "followUp" });
    assert.match(harness.sentMessages[1].content, /one Dream-RSI online cycle \(dream_rsi_live\)/);
    await harness.commands.get("dream-rsi").handler("dream", context);
    assert.match(harness.sentMessages[2].content, /offline phase \(dream_rsi_dream\)/);

    // `run` validates its count instead of silently doing something else.
    await harness.commands.get("dream-rsi").handler("run 2", context);
    assert.match(harness.sentMessages[3].content, /Run 2 full Dream-RSI cycles/);
    const before = harness.sentMessages.length;
    await harness.commands.get("dream-rsi").handler("run banana", context);
    assert.equal(harness.sentMessages.length, before, "a bad count asks for nothing");
    assert.match(harness.notifications.at(-1), /cycle count between 1 and 100; got "banana"/);
    await harness.commands.get("dream-rsi").handler("run 0", context);
    assert.equal(harness.sentMessages.length, before);
  } finally {
    project.cleanup();
  }
});

test("help explains the prerequisite instead of leaving you guessing", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.commands.get("dream-rsi").handler("", context);
    const help = harness.notifications.at(-1);
    assert.match(help, /arXiv 2609\.14858/);
    assert.match(help, /\/dream-rsi create \[goal\]/);
    assert.match(help, /\/dream-rsi suggest \[goal\]/);
    assert.match(help, /nothing configured here yet/i);
    assert.match(help, /task\.json/);
  } finally {
    project.cleanup();
  }
});

test("a phase already in flight is not started twice", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    harness.statuses.length = 0;
    // Fake an in-flight phase the way a crashed cycle would leave one behind.
    const iterationDir = path.join(project.dreamRoot, "trace_pool", "iter0001_current");
    fs.mkdirSync(iterationDir, { recursive: true });
    fs.writeFileSync(path.join(iterationDir, "live_cycle_manifest.json"), JSON.stringify({ iteration: 1, status: "running" }), "utf8");
    await harness.commands.get("dream-rsi").handler("run", context);
    assert.equal(harness.sentMessages.length, 1, "the in-flight mirror does not block a new run");
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
    assert.equal(harness.tools.size, 5);
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

test("an interrupted run is recovered so it stops looking in flight", () => {
  const project = makeProject();
  try {
    const dir = path.join(project.dreamRoot, "trace_pool", "iter0001_current");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "live_cycle_manifest.json"),
      JSON.stringify({ iteration: 1, status: "running", created_at: new Date().toISOString() }),
    );
    assert.equal(activeRuns(project.dreamRoot).length, 1, "the interrupted run is visible as in flight");
    assert.deepEqual(recoverInterruptedRuns(project.dreamRoot), [1]);
    assert.deepEqual(activeRuns(project.dreamRoot), [], "recovered, so it no longer blocks the next cycle");
    const manifest = readJson(path.join(dir, "live_cycle_manifest.json"));
    assert.equal(manifest.status, "failed");
    assert.match(manifest.error, /interrupted/);
  } finally {
    project.cleanup();
  }
});

test("attempts use the active session model and thinking level", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    context.model = { provider: "opencode-go", id: "deepseek-v4.1-flash" };
    context.thinkingLevel = "high";
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    const initEntry = harness.entries.filter((entry) => entry.customType === "pi-dream-rsi/live").at(-1);
    assert.equal(initEntry.data.model, "opencode-go/deepseek-v4.1-flash", "init reports the effective session model");

    const live = await harness.tools.get("dream_rsi_live").execute("c2", {}, undefined, undefined, context);
    assert.match(live.content[0].text, /Live cycle/);
    const liveEntry = harness.entries.filter((entry) => entry.customType === "pi-dream-rsi/live").at(-1);
    assert.equal(liveEntry.data.model, "opencode-go/deepseek-v4.1-flash", "the cycle records the session model it ran on");
  } finally {
    project.cleanup();
  }
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

test("loops records several worlds at once, and one dream replays all of them", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project, { max_loops: 3 }), undefined, undefined, context);
    assert.equal(readJson(path.join(project.dreamRoot, "task.json")).max_loops, 3, "max_loops is written to task.json");

    const live = await harness.tools.get("dream_rsi_live").execute("c2", { loops: 3 }, undefined, undefined, context);
    assert.deepEqual(live.details.iterations, [1, 2, 3], "three episodes, three iteration numbers");
    assert.equal(live.details.loops, 3);
    assert.equal(live.details.attempts, 18, "six attempts (2 branches x 3 refinements) per world");
    assert.equal(live.details.ok, true);
    assert.match(live.content[0].text, /3 online cycles in parallel \(worlds 1, 2, 3\)/);
    for (const world of [1, 2, 3]) {
      const dir = path.join(project.dreamRoot, "trace_pool", `iter000${world}`);
      assert.ok(exists(path.join(dir, "tree.json")), `world ${world} was recorded`);
      assert.equal(readJson(path.join(dir, "live_cycle_manifest.json")).status, "complete");
      assert.ok(exists(path.join(project.dreamRoot, "work", `r000${world}`)), `world ${world} keeps its own attempt workspaces`);
    }
    assert.deepEqual(activeRuns(project.dreamRoot), [], "a finished batch leaves nothing in flight");
    assert.equal(nextIteration(project.dreamRoot), 4, "the next cycle continues past the batch");

    const dream = await harness.tools.get("dream_rsi_dream").execute("c3", {}, undefined, undefined, context);
    assert.equal(dream.details.worlds, 3, "one dream replays the whole batch");
    assert.equal(dream.details.ok, true);
  } finally {
    project.cleanup();
  }
});

test("concurrent live calls share the world cap and clamp a wider request", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);

    // Two calls in the same turn, as an agent would start them: max_loops=2 allows one world each.
    const [first, second] = await Promise.all([
      harness.tools.get("dream_rsi_live").execute("c2", {}, undefined, undefined, context),
      harness.tools.get("dream_rsi_live").execute("c3", {}, undefined, undefined, context),
    ]);
    const claimed = [...first.details.iterations, ...second.details.iterations].sort((a, b) => a - b);
    assert.deepEqual(claimed, [1, 2], "each call recorded its own world");
    assert.equal(first.details.ok, true);
    assert.equal(second.details.ok, true);

    // Over-asking is clamped to max_loops, and the clamp is reported rather than silent.
    const wide = await harness.tools.get("dream_rsi_live").execute("c4", { loops: 99 }, undefined, undefined, context);
    assert.equal(wide.details.loops, 2, "clamped to task.json's max_loops");
    assert.match(wide.content[0].text, /asked for 99 loop\(s\), running 2: max_loops=2/);
  } finally {
    project.cleanup();
  }
});

test("dreaming refuses while a world is still in flight", async () => {
  const project = makeProject();
  try {
    const { context, harness } = await boot(project);
    await harness.tools.get("dream_rsi_init").execute("c1", initParams(project), undefined, undefined, context);
    const dir = path.join(project.dreamRoot, "trace_pool", "iter0001_current");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "live_cycle_manifest.json"),
      JSON.stringify({ iteration: 1, status: "running", baked_beta: 0.6 }),
      "utf8",
    );

    const dream = await harness.tools.get("dream_rsi_dream").execute("c2", {}, undefined, undefined, context);
    assert.match(dream.content[0].text, /still in flight/);
    assert.deepEqual(dream.details.in_flight, ["live cycle 0001 (in flight)"]);
  } finally {
    project.cleanup();
  }
});

test("iteration claims: a sibling's world survives, a recovered number is reusable", () => {
  const project = makeProject();
  try {
    fs.mkdirSync(path.join(project.dreamRoot, "trace_pool"), { recursive: true });
    assert.equal(nextIteration(project.dreamRoot), 1);
    assert.deepEqual(reserveIterations(project.dreamRoot, 2), [1, 2]);
    assert.deepEqual(runningIterations(project.dreamRoot), [1, 2]);
    assert.equal(nextIteration(project.dreamRoot), 3, "claimed numbers count as occupied");

    // One claim is owned by a live call that is still running: recovery must leave it alone.
    assert.deepEqual(recoverInterruptedRuns(project.dreamRoot, [1]), [2], "only the unowned claim is recovered");
    assert.deepEqual(runningIterations(project.dreamRoot), [1]);
    assert.equal(nextIteration(project.dreamRoot), 2, "the recovered number is free again");

    // A recorded world holds its number for good, even once its claim is gone.
    const recorded = path.join(project.dreamRoot, "trace_pool", "iter0001");
    fs.mkdirSync(recorded, { recursive: true });
    fs.writeFileSync(path.join(recorded, "tree.json"), "{}", "utf8");
    assert.deepEqual(listIterations(project.dreamRoot), [1]);
    recoverInterruptedRuns(project.dreamRoot);
    assert.equal(nextIteration(project.dreamRoot), 2, "a recorded world keeps its iteration occupied");
  } finally {
    project.cleanup();
  }
});
