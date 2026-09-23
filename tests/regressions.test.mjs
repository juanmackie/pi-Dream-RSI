/**
 * Regressions for the P1/P2 punch list.
 *
 * Each test reproduces a reported failure and asserts the fixed behavior, so the same bug cannot come
 * back silently. Pure-function checks stay cheap; the integration checks run the real engine on a
 * throwaway project with stub agents.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { deployShippedPolicy, jump, makeProject, writeTaskJson } from "./fixtures.mjs";

const { interpretEvaluation, runLiveEpisode } = await jump("engine/live.ts");
const { runDreamPhase } = await jump("engine/dream.ts");
const { normalizeTask } = await jump("engine/task.ts");
const { copyWorkspace, runShellCommand } = await jump("agent/runner.ts");
const {
  archivePolicyVersion,
  claimCurrentManifest,
  liveMethodPath,
  pruneWorkspaces,
  versionedPolicyPath,
  writeJson,
} = await jump("engine/world.ts");
const { readPolicyViolations, scanPolicySource } = await jump("policy/runner.ts");
const { recoverInterruptedRuns, reserveIterations } = await jump("state.ts");
const { makeReplayProbe } = await jump("engine/replay.ts");
const { DiscoveryTree } = await jump("engine/tree.ts");
const { findCandidate } = await jump("engine/improvements.ts");
const { resolveWithinRoot } = await jump("index.ts");

const OK_COMMAND = {
  ok: true,
  code: 0,
  signal: null,
  timedOut: false,
  spawnError: null,
  durationMs: 1,
  stdoutTail: "",
  stderrTail: "",
  logPath: null,
};

/** One live cycle on a stub project, with the task's own agent. */
async function runOneLiveCycle(project, grid = { branch_count: 1, refine_count: 1 }) {
  return await runLiveEpisode({
    dreamRoot: project.dreamRoot,
    projectDir: project.projectDir,
    task: project.task,
    iteration: 1,
    bakedBeta: 0.6,
    grid,
    baselineScore: null,
  });
}

test("a non-zero evaluator exit is an eval_error even when a score file is present", () => {
  const task = normalizeTask(makeProject().task);
  const outcome = interpretEvaluation(
    task,
    { ...OK_COMMAND, ok: false, code: 4, stderrTail: "boom" },
    { score: 200, valid: true, fail_class: "ok" },
  );
  assert.equal(outcome.fail_class, "eval_error");
  assert.equal(outcome.score, null);
  assert.equal(outcome.valid, false);
});

test("a failed evaluator cannot reuse a score file inherited from the seed", async () => {
  const project = makeProject({ scorer: "score-fail.mjs" });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    // The seed carries a successful score; every attempt inherits it before the scorer runs.
    fs.mkdirSync(path.join(project.seed, "eval"), { recursive: true });
    fs.writeFileSync(
      path.join(project.seed, "eval", "score.json"),
      JSON.stringify({ score: 999, valid: true, fail_class: "ok", error: null }),
      "utf8",
    );
    const episode = await runOneLiveCycle(project);
    assert.equal(episode.manifest.best_score, null, "the inherited 999 must not validate a failed attempt");
    const nodes = episode.tree.list();
    assert.ok(nodes.length > 0);
    assert.ok(nodes.every((node) => node.fail_class === "eval_error"), nodes.map((n) => n.fail_class).join(","));
  } finally {
    project.cleanup();
  }
});

test("findCandidate resolves the requested iteration and cell, including a runner-up", async () => {
  const project = makeProject();
  try {
    await writeTaskJson(project);
    const task = normalizeTask(project.task);
    const addIteration = (iteration, cells) => {
      const dir = path.join(project.dreamRoot, "trace_pool", `iter${String(iteration).padStart(4, "0")}`);
      fs.mkdirSync(dir, { recursive: true });
      const tree = new DiscoveryTree({ baselineScore: null, branchCount: 1, refineCount: 3 });
      tree.addBranchSlot(0);
      for (const cell of cells) {
        if (cell.cell !== "b0a0") tree.addChild("b0a0", 0, 1);
        const workspace = path.join(project.dreamRoot, "work", `r${String(iteration).padStart(4, "0")}`, cell.cell);
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(path.join(workspace, "solution.py"), `# ${cell.cell}\n`, "utf8");
        tree.setOutcome(cell.cell, {
          evaluated: true,
          valid: true,
          fail_class: "ok",
          error: null,
          score: cell.score,
          raw_score: cell.score,
          workspace: path.relative(project.projectDir, workspace),
        });
      }
      writeJson(path.join(dir, "tree.json"), tree.toJSON());
      writeJson(path.join(dir, "live_cycle_manifest.json"), { iteration, status: "complete" });
    };
    addIteration(1, [
      { cell: "b0a0", score: 200 },
      { cell: "b0a1", score: 120 },
    ]);
    addIteration(2, [{ cell: "b0a0", score: 120 }]);

    // The same cell id exists in both iterations: the iteration must be honoured.
    assert.equal(findCandidate(project.dreamRoot, task, project.projectDir, 1, "b0a0")?.score, 200);
    assert.equal(findCandidate(project.dreamRoot, task, project.projectDir, 2, "b0a0")?.score, 120);
    // A runner-up that is not its iteration's winner is still selectable.
    assert.equal(findCandidate(project.dreamRoot, task, project.projectDir, 1, "b0a1")?.score, 120);
  } finally {
    project.cleanup();
  }
});

test("a development agent that deletes its file cannot break the deployed policy", async () => {
  const project = makeProject({ task: { revisions: 3 } });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    await runOneLiveCycle(project);
    const before = fs.readFileSync(liveMethodPath(project.dreamRoot), "utf8");
    project.task.agent = { ...project.task.agent, args: [project.script("developer-delete.mjs")] };
    const dream = await runDreamPhase({
      dreamRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task: project.task,
      iteration: 1,
    });
    assert.equal(dream.ok, true, dream.error ?? "");
    assert.equal(fs.readFileSync(liveMethodPath(project.dreamRoot), "utf8"), before, "the deployed policy is intact");
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "policy", "staging.ts")), false, "staging is cleaned up");
  } finally {
    project.cleanup();
  }
});

test("each policy revision can read the replay feedback that guides it", async () => {
  const project = makeProject({ task: { revisions: 3 } });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    await runOneLiveCycle(project);
    project.task.agent = { ...project.task.agent, args: [project.script("developer-reads-feedback.mjs")] };
    const dream = await runDreamPhase({
      dreamRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task: project.task,
      iteration: 1,
    });
    assert.equal(dream.ok, true, dream.error ?? "");
    const lines = fs.readFileSync(path.join(project.dreamRoot, "feedback.log"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "one development call per revision after pi_0");
    assert.ok(lines.every((line) => line === "sweep traces"), lines.join("; "));
  } finally {
    project.cleanup();
  }
});

test("recovery leaves another session's live claim alone and reclaims a dead one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-own-"));
  try {
    const root = path.join(dir, ".dream-rsi");
    const owner = { session_id: "other-session", pid: process.pid, claimed_at: new Date().toISOString() };
    assert.deepEqual(reserveIterations(root, 1, 1, owner), [1]);
    assert.deepEqual(
      recoverInterruptedRuns(root, [], { sessionId: "me", isAlive: () => true }),
      [],
      "a claim owned by a live process is not interrupted",
    );
    assert.deepEqual(
      recoverInterruptedRuns(root, [], { sessionId: "me", isAlive: () => false }),
      [1],
      "a claim whose owner is confirmed dead is reclaimed",
    );
    // Atomic claim: the same iteration number cannot be claimed twice.
    const manifest = {
      iteration: 9,
      status: "running",
      created_at: new Date().toISOString(),
      completed_at: null,
      baked_beta: 0,
      policy_version: "",
      policy_name: null,
      grid: { branch_count: 0, refine_count: 0 },
      decision_rounds: 0,
      attempts: 0,
      baseline_score: null,
      best_score: null,
      previous_best_score: null,
      stopped: null,
      error: null,
      note: null,
    };
    assert.equal(claimCurrentManifest(root, manifest), true);
    assert.equal(claimCurrentManifest(root, manifest), false, "an existing claim cannot be overwritten");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("aborting a run kills the process tree and reports it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-abort-"));
  try {
    const script = path.join(dir, "hang.mjs");
    fs.writeFileSync(script, "setInterval(() => {}, 1000);\n", "utf8");
    const controller = new AbortController();
    const started = Date.now();
    const pending = runShellCommand(`node "${script}"`, { cwd: dir, timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 250);
    const result = await pending;
    assert.equal(result.aborted, true);
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 15_000, "abort is bounded, not a full timeout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("apply boundary resolution rejects a link that escapes the workspace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-boundary-"));
  try {
    const root = path.join(dir, "workspace");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.py"), "secret\n", "utf8");
    fs.writeFileSync(path.join(root, "app.py"), "app\n", "utf8");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      fs.symlinkSync(outside, path.join(root, "evil"), linkType);
    } catch {
      return; // platform refuses directory links: nothing to regress here
    }
    assert.ok(resolveWithinRoot(root, "app.py"), "an ordinary path resolves");
    assert.equal(resolveWithinRoot(root, "evil/secret.py"), null, "a link escape is refused");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replay never reveals a branch slot that live never executed", async () => {
  const world = new DiscoveryTree({ branchCount: 2, refineCount: 2 });
  world.addBranchSlot(0);
  world.addBranchSlot(1);
  world.setOutcome("b0a0", { evaluated: true, fail_class: "ok", error: null, score: 5 });
  const revealed = new Set();
  const probe = makeReplayProbe(world, (cell) => revealed.has(cell));
  const first = await probe(["b0a0"], 1);
  assert.deepEqual(first.map((record) => record.cell), ["b0a0"]);
  revealed.add("b0a0");
  const second = await probe(["b1a0"], 2);
  assert.deepEqual(second, [], "an unexecuted slot reveals nothing and charges no probe");
});

test("archived policy versions are immutable across cycles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-versions-"));
  try {
    const root = path.join(dir, ".dream-rsi");
    const a = archivePolicyVersion(root, 1, 0, "cycle-one");
    const b = archivePolicyVersion(root, 2, 0, "cycle-two");
    assert.notEqual(a, b);
    assert.equal(fs.readFileSync(a, "utf8"), "cycle-one");
    assert.equal(fs.readFileSync(b, "utf8"), "cycle-two");
    assert.notEqual(versionedPolicyPath(root, 1, 0), versionedPolicyPath(root, 2, 0));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the purity scan closes dynamic, re-export and helper-import gaps", () => {
  assert.match(scanPolicySource('const fs = await import("fs");')[0] ?? "", /bare module specifier/);
  assert.match(scanPolicySource('export { readFileSync } from "node:fs";')[0] ?? "", /node:fs/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-purity-"));
  try {
    fs.writeFileSync(path.join(dir, "helper.ts"), 'import * as fs from "node:fs";\nexport const x = 1;\n', "utf8");
    const policy = path.join(dir, "method.ts");
    fs.writeFileSync(policy, 'import { x } from "./helper.ts";\nexport const y = x;\n', "utf8");
    const violations = readPolicyViolations(policy);
    assert.ok(
      violations.some((violation) => /helper\.ts/.test(violation) && /node:fs/.test(violation)),
      violations.join("; "),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("copying a workspace with a directory link cycle terminates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-linkcycle-"));
  try {
    const src = path.join(dir, "src");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "app.py"), "print(1)\n", "utf8");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      fs.symlinkSync(src, path.join(src, "sub", "loop"), linkType);
    } catch {
      return; // platform refuses directory links: nothing to regress here
    }
    const dest = path.join(dir, "dest");
    await copyWorkspace(src, dest);
    assert.ok(fs.existsSync(path.join(dest, "app.py")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed log stream is a controlled outcome, not a crash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-log-"));
  try {
    const script = path.join(dir, "hello.mjs");
    fs.writeFileSync(script, "process.stdout.write('hi');\n", "utf8");
    const logPath = path.join(dir, "logdir");
    fs.mkdirSync(logPath); // a directory where the log file should be: opening it for write fails
    const result = await runShellCommand(`node "${script}"`, { cwd: dir, timeoutMs: 20_000, logPath });
    assert.equal(result.ok, true, result.spawnError ?? result.logError ?? "");
    assert.ok(typeof result.logError === "string" && result.logError.length > 0, "the log failure is reported");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace retention prunes only old iterations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-retention-"));
  try {
    const root = path.join(dir, ".dream-rsi");
    for (const n of [1, 2, 3]) fs.mkdirSync(path.join(root, "work", `r000${n}`), { recursive: true });
    assert.deepEqual(pruneWorkspaces(root, 2, 3), [1]);
    assert.ok(fs.existsSync(path.join(root, "work", "r0003")));
    assert.equal(fs.existsSync(path.join(root, "work", "r0001")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("copy_exclude keeps named directories out of an attempt workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-exclude-"));
  try {
    const src = path.join(dir, "src");
    fs.mkdirSync(path.join(src, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(src, "node_modules", "dep.js"), "dep\n", "utf8");
    fs.writeFileSync(path.join(src, "app.py"), "app\n", "utf8");
    const dest = path.join(dir, "dest");
    await copyWorkspace(src, dest, { exclude: [path.join(src, "node_modules")] });
    assert.ok(fs.existsSync(path.join(dest, "app.py")));
    assert.equal(fs.existsSync(path.join(dest, "node_modules")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
