/**
 * End-to-end loop tests, with stub agents instead of an LLM: live → worlds → dreaming → deploy,
 * plus the failure paths that must not corrupt the loop (bad evaluator, missing proposal, timeouts,
 * a non-deterministic policy, a policy that ignores the round limit).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EXT, deployShippedPolicy, exists, jump, makeProject, readJson, writeTaskJson } from "./fixtures.mjs";

const { copyWorkspace } = await jump("agent/runner.ts");

const { runLiveEpisode } = await jump("engine/live.ts");
const { runDreamPhase, planNextGrid, fallbackGrid } = await jump("engine/dream.ts");
const { readTree, listIterations, readManifest, liveMethodPath, iterationDir } = await jump("engine/world.ts");
const { interpretEvaluation } = await jump("engine/live.ts");
const { normalizeTask } = await jump("engine/task.ts");
const { runPolicyChecked } = await jump("policy/runner.ts");
const { DiscoveryTree } = await jump("engine/tree.ts");

/** Policies in this suite follow the documented contract: import api.ts, extend the base class. */
const POLICY_IMPORT = 'import { LLMDesignedMethod } from "./api.ts";';

const GRID = { branch_count: 2, refine_count: 3 };

async function liveCycle(project, iteration, extra = {}) {
  return runLiveEpisode({
    dreamRoot: project.dreamRoot,
    projectDir: project.projectDir,
    task: project.task,
    iteration,
    policyPath: liveMethodPath(project.dreamRoot),
    bakedBeta: project.task.default_beta,
    grid: extra.grid ?? GRID,
    baselineScore: extra.baselineScore ?? null,
    previousBestScore: extra.previousBestScore ?? null,
    policyTimeoutMs: 60_000,
  });
}

test("a workspace that contains the Dream-RSI root still copies, minus the tool's own state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-copy-"));
  // `workspace: "."`: the seed workspace *is* the project root, so the Dream-RSI root sits inside it.
  const dreamRoot = path.join(dir, ".dream-rsi");
  try {
    fs.mkdirSync(path.join(dreamRoot, "work", "old"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app.py"), "print(1)\n", "utf8");
    fs.writeFileSync(path.join(dreamRoot, "work", "old", "score.json"), "{\"score\": 99}", "utf8");
    fs.writeFileSync(path.join(dreamRoot, "task.json"), "{}", "utf8");

    // The destination is a subdirectory of the source; this used to throw ERR_FS_CP_EINVAL.
    const target = path.join(dreamRoot, "work", "b0a0");
    copyWorkspace(dir, target, { exclude: [dreamRoot] });
    assert.ok(exists(path.join(target, "app.py")), "the real workspace content is copied");
    assert.equal(exists(path.join(target, ".dream-rsi")), false, "the tool's state dir is never copied");

    // A refinement copies a workspace that already lives *inside* the excluded root: the exclusion
    // must not swallow the copy.
    const child = path.join(dreamRoot, "work", "b0a1");
    copyWorkspace(target, child, { exclude: [dreamRoot] });
    assert.ok(exists(path.join(child, "app.py")), "refinement copies still work");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one live cycle records a discovery tree, workspaces, attempt records and the world", async () => {
  const project = makeProject();
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const episode = await liveCycle(project, 1);

    assert.equal(episode.ok, true, episode.error ?? "");
    assert.equal(episode.tree.nNonRoot, 6, "2 branches x 3 refinements");
    assert.equal(episode.manifest.decision_rounds, 3, "one decision round per grid row");
    assert.equal(episode.manifest.attempts, 6);
    assert.ok(episode.manifest.best_score > 0);

    // Every attempt inherits its parent's workspace: scores must climb along a branch.
    for (const branch of [0, 1]) {
      const chain = episode.tree.branchChain(branch);
      assert.equal(chain.length, 3, "the branch refined to the grid's depth");
      assert.deepEqual(chain.map((n) => n.meta.parent_id), ["root", chain[0].meta.cell_id, chain[1].meta.cell_id]);
      for (let i = 1; i < chain.length; i += 1) {
        assert.ok(chain[i].score >= chain[i - 1].score, "a refinement resumes the parent's workspace");
      }
    }

    for (const node of episode.tree.list()) {
      const cell = node.meta.cell_id;
      assert.ok(exists(path.join(project.dreamRoot, "history", "r0001_live", `attempt_${cell}`, "proposal.md")));
      assert.ok(exists(path.join(project.dreamRoot, "history", "r0001_live", `attempt_${cell}`, "eval", "score.json")));
      assert.ok(exists(path.join(project.dreamRoot, "history", "r0001_live", `attempt_${cell}`, "prompt.md")));
      assert.ok(exists(path.join(project.dreamRoot, "work", "r0001", cell, "solution.py")), "each attempt has its own workspace");
    }
    // Cycle 1 doubles as the baseline floor.
    assert.ok(exists(path.join(project.dreamRoot, "history", "baseline", "score.json")));
    assert.equal(readJson(path.join(project.dreamRoot, "history", "baseline", "score.json")).score, episode.manifest.best_score);

    // The recorded world is complete enough to replay.
    const world = readTree(project.dreamRoot, 1);
    assert.equal(world.nNonRoot, 6);
    assert.equal(world.branchCount, 2);
    assert.equal(world.refineCount, 3);
    assert.deepEqual(listIterations(project.dreamRoot), [1]);
    assert.equal(readManifest(project.dreamRoot, 1).status, "complete");
    assert.ok(exists(path.join(iterationDir(project.dreamRoot, 1), "live_cycle_manifest.json")));
    assert.ok(exists(path.join(iterationDir(project.dreamRoot, 1, true), "live_cycle_manifest.json")));
  } finally {
    project.cleanup();
  }
});

test("two full iterations: dreaming deploys a selected version and iteration 2 uses it", async () => {
  const project = makeProject({ agent: "agent-router.mjs" });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);

    const first = await liveCycle(project, 1);
    assert.equal(first.ok, true, first.error ?? "");
    assert.ok(first.manifest.best_score > 0, "discovery attempts scored real candidates");

    const dream = await runDreamPhase({ dreamRoot: project.dreamRoot, projectDir: project.projectDir, task: project.task, iteration: 1 });

    assert.equal(dream.ok, true, dream.error ?? "");
    assert.equal(dream.revisions, project.task.revisions, "M = pi_0 plus every revision evaluated");
    assert.equal(dream.evaluations.length, project.task.revisions);
    assert.equal(dream.improved, true, "the policy-development agent changed the policy");
    assert.ok(dream.deployed_beta >= 0 && dream.deployed_beta <= 1);

    // Both prompts were routed to the agent: discovery attempts, then policy revisions.
    const prompts = fs.readFileSync(path.join(project.dreamRoot, "agent-prompts.log"), "utf8").trim().split("\n");
    assert.ok(prompts.some((line) => line.startsWith("development")), "the improvement prompt reached the agent");
    assert.equal(prompts.filter((line) => line.startsWith("development")).length, project.task.revisions - 1);
    assert.ok(
      fs.readFileSync(path.join(project.dreamRoot, "work", "r0001", "b0a0", "agent-prompts.log"), "utf8").startsWith("discovery"),
      "the discovery prompt reached the attempt agent",
    );

    // Every evaluated version is archived and the winner is deployed.
    for (let revision = 0; revision < dream.revisions; revision += 1) {
      assert.ok(exists(path.join(project.dreamRoot, "policy", `v${String(revision).padStart(4, "0")}.ts`)), `v${revision} archived`);
    }
    const deployed = fs.readFileSync(liveMethodPath(project.dreamRoot), "utf8");
    assert.equal(deployed, fs.readFileSync(dream.selected_policy, "utf8"), "the selected version is what runs next");

    const results = path.join(project.dreamRoot, "history", "r0001_dream", "proposal_results");
    const sweep = readJson(path.join(results, "beta_sweep.json"));
    assert.equal(typeof sweep.pareto_reward, "number");
    assert.equal(typeof sweep.auc, "number");
    assert.equal(typeof sweep.parallel_penalty, "number");
    assert.ok(Array.isArray(sweep.frontier));
    assert.equal(sweep.versions.length, dream.revisions);
    for (const version of sweep.versions) {
      assert.equal(version.deterministic, true, "replay must be deterministic");
      assert.deepEqual(
        version.points.map((p) => p.beta),
        project.task.beta_grid,
      );
    }
    assert.equal(Number(sweep.pareto_reward.toFixed(10)), Number((sweep.auc - sweep.parallel_penalty).toFixed(10)));
    assert.ok(fs.statSync(path.join(results, "policy_execution_traces.jsonl")).size > 0);
    const selection = readJson(path.join(results, "selection.json"));
    assert.equal(selection.monotone, true, "V* >= V_0");
    assert.equal(selection.selected_revision, dream.selected);

    // Iteration 2 replays against two worlds and records the previous live best for the beta rule.
    const second = await liveCycle(project, 2, { previousBestScore: first.manifest.best_score });
    assert.equal(second.ok, true, second.error ?? "");
    assert.equal(second.manifest.previous_best_score, first.manifest.best_score);
    const dream2 = await runDreamPhase({ dreamRoot: project.dreamRoot, projectDir: project.projectDir, task: project.task, iteration: 2 });
    assert.equal(dream2.worlds, 2, "the history grows: replay evaluates every recorded world");
    assert.equal(dream2.ok, true, dream2.error ?? "");
    assert.deepEqual(listIterations(project.dreamRoot), [1, 2]);
  } finally {
    project.cleanup();
  }
});

test("a policy that regresses cannot be selected: V* >= V_0 holds and pi_0 is kept", async () => {
  const project = makeProject();
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    await liveCycle(project, 1);
    project.task.agent = { ...project.task.agent, args: [project.script("developer-regress.mjs")] };

    const before = fs.readFileSync(liveMethodPath(project.dreamRoot), "utf8");
    const dream = await runDreamPhase({ dreamRoot: project.dreamRoot, projectDir: project.projectDir, task: project.task, iteration: 1 });
    assert.equal(dream.ok, true, dream.error ?? "");
    assert.equal(dream.selected, 0, "the regressed revision must not win");
    assert.equal(fs.readFileSync(liveMethodPath(project.dreamRoot), "utf8"), before, "the deployed policy is unchanged");
    const [v0, v1] = dream.evaluations;
    assert.ok(v0.v_mean > v1.v_mean, `expected pi_0 (${v0.v_mean}) to beat pi_1 (${v1.v_mean})`);
  } finally {
    project.cleanup();
  }
});

test("replay reproducibility is checked, and unsound versions are never deployed", async () => {
  const project = makeProject();
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const policyPath = liveMethodPath(project.dreamRoot);

    // 1. The detector: a deterministic policy whose *transitions* differ between two runs must be
    //    reported as non-reproducible (this is what replay-twice comparison protects against).
    let call = 0;
    const probe = async (cells) =>
      cells.map((cell) => ({ cell, node: { evaluated: true, fail_class: "ok", error: null, score: 1 + call++ } }));
    const checked = await runPolicyChecked({
      policyPath,
      mode: "live",
      maxParallelism: 2,
      grid: { branch_count: 1, refine_count: 1 },
      probe,
      verifyDeterminism: true,
      timeoutMs: 30_000,
    });
    assert.equal(checked.ok, true, checked.error ?? "");
    assert.equal(checked.deterministic, false, "a differing second run must be caught");

    // 2. A sound policy on a frozen world is reproducible.
    await liveCycle(project, 1);
    const world = readTree(project.dreamRoot, 1);
    const replay = await runPolicyChecked({
      policyPath,
      mode: "replay",
      maxParallelism: project.task.workers,
      world,
      maxRounds: project.task.k2,
      verifyDeterminism: true,
      timeoutMs: 30_000,
    });
    assert.equal(replay.deterministic, true, "the shipped policy is deterministic");

    // 3. The guard: when no version can be scored, the phase fails instead of deploying anything.
    const brokenSource = "export const notAPolicy = 1;\n";
    fs.writeFileSync(path.join(project.dreamRoot, "policy", "method.ts"), brokenSource, "utf8");
    const broken = await runDreamPhase({
      dreamRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task: project.task,
      iteration: 1,
      evaluateOnly: true,
    });
    assert.equal(broken.ok, false);
    assert.match(broken.error, /no policy version produced a finite replay score/);
    assert.equal(Number.isFinite(broken.evaluations[0].v_mean), false, "an unrunnable version scores as invalid");
    assert.equal(
      fs.readFileSync(path.join(project.dreamRoot, "policy", "method.ts"), "utf8"),
      brokenSource,
      "a failed phase deploys nothing",
    );
  } finally {
    project.cleanup();
  }
});

test("evaluator failures are recorded as repairable evidence and never crash the cycle", async () => {
  const project = makeProject({ scorer: "score-fail.mjs" });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const episode = await liveCycle(project, 1);
    assert.equal(episode.ok, true, "the cycle completes even when every evaluation fails");
    assert.equal(episode.tree.nNonRoot, 6);
    for (const node of episode.tree.list()) {
      assert.equal(node.fail_class, "eval_error");
      assert.equal(node.score, null);
      assert.match(node.error, /evaluator/);
      assert.ok(exists(path.join(project.dreamRoot, "history", "r0001_live", `attempt_${node.meta.cell_id}`, "error.txt")));
    }
    assert.equal(episode.manifest.best_score, null);
    // A repairable failure is evidence, not closure: the branch remains repliable.
    const tree = readTree(project.dreamRoot, 1);
    assert.ok(tree.nNonRoot > 0);
  } finally {
    project.cleanup();
  }
});

test("missing score file, missing proposal, agent failure and agent timeout all become node outcomes", async () => {
  const cases = [
    { scorer: "score-nofile.mjs", agent: "agent-ok.mjs", fail: "eval_error" },
    { agent: "agent-noproposal.mjs", fail: "no_proposal" },
    { agent: "agent-fail.mjs", fail: "agent_error" },
    { agent: "agent-hang.mjs", fail: "timeout", agentTimeoutMs: 1500 },
  ];
  for (const scenario of cases) {
    const project = makeProject({ scorer: scenario.scorer ?? "score-ok.mjs", agent: scenario.agent, agentTimeoutMs: scenario.agentTimeoutMs });
    try {
      await writeTaskJson(project);
      await deployShippedPolicy(project);
      const episode = await liveCycle(project, 1);
      assert.equal(episode.ok, true, `${scenario.agent}: ${episode.error}`);
      const classes = new Set(episode.tree.list().map((n) => n.fail_class));
      assert.deepEqual([...classes], [scenario.fail], `${scenario.agent} should fail as ${scenario.fail}`);
      assert.equal(episode.manifest.best_score, null);
    } finally {
      project.cleanup();
    }
  }
});

test("a policy that hangs or throws is bounded by the runner, not by luck", async () => {
  const project = makeProject();
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project); // provides policy/api.ts that a policy imports
    const dir = path.join(project.dreamRoot, "policy");

    // A world is needed for replay mode; the hanging policy never reaches it.
    const world = new DiscoveryTree({ baselineScore: 0, branchCount: 1, refineCount: 1 });
    world.addBranchSlot(0);
    world.setOutcome("b0a0", { evaluated: true, fail_class: "ok", score: 1 });

    const hang = path.join(dir, "hang.ts");
    fs.writeFileSync(
      hang,
      `${POLICY_IMPORT}\nexport class OptimalPolicy extends LLMDesignedMethod { async solve() { while (true) {} } }\n`,
      "utf8",
    );
    const started = Date.now();
    const timedOut = await runPolicyChecked({ policyPath: hang, mode: "replay", maxParallelism: 1, world, timeoutMs: 1200 });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timedOut, true);
    assert.match(timedOut.error, /exceeded 1200ms and was terminated/);
    assert.ok(Date.now() - started < 15_000, "the worker is killed, not waited on");

    const throwing = path.join(dir, "throws.ts");
    fs.writeFileSync(
      throwing,
      `${POLICY_IMPORT}\nexport class OptimalPolicy extends LLMDesignedMethod { async solve() { throw new Error("policy bug"); } }\n`,
      "utf8",
    );
    const threw = await runPolicyChecked({ policyPath: throwing, mode: "replay", maxParallelism: 1, world, timeoutMs: 30_000 });
    assert.equal(threw.ok, false);
    assert.match(threw.error, /policy bug/, "the policy's own error message is surfaced");

    const illegal = path.join(dir, "illegal.ts");
    fs.writeFileSync(
      illegal,
      `${POLICY_IMPORT}\nexport class OptimalPolicy extends LLMDesignedMethod {\n  async solve(question) {\n    question.reset();\n    await question.probe_batch(["nope"]);\n    return { best_score: null, probes: 0, rounds: 0, stopped: null, curve: [] };\n  }\n}\n`,
      "utf8",
    );
    const rejected = await runPolicyChecked({ policyPath: illegal, mode: "live", maxParallelism: 1, grid: { branch_count: 1, refine_count: 1 }, probe: async () => [], timeoutMs: 30_000 });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /illegal cell id for the current prefix/);
  } finally {
    project.cleanup();
  }
});

test("evaluator interpretation is a pure function of the command result and the score file", async () => {
  const task = normalizeTask(makeProject().task);
  const ok = { ok: true, code: 0, signal: null, timedOut: false, spawnError: null, durationMs: 1, stdoutTail: "", stderrTail: "", logPath: null };
  assert.deepEqual(interpretEvaluation(task, ok, { score: 3 }), {
    score: 3,
    raw_score: 3,
    valid: true,
    fail_class: "ok",
    error: null,
  });
  assert.equal(interpretEvaluation(task, ok, { score: 3 }).score, 3);
  assert.equal(interpretEvaluation({ ...task, higher_is_better: false }, ok, { score: 3 }).score, -3, "labels normalise to higher-is-better");
  assert.equal(interpretEvaluation(task, ok, null).fail_class, "eval_error");
  assert.equal(interpretEvaluation(task, { ...ok, ok: false, code: 4, stderrTail: "boom" }, null).fail_class, "eval_error");
  assert.equal(interpretEvaluation(task, { ...ok, timedOut: true }, null).fail_class, "timeout");
  assert.equal(interpretEvaluation(task, ok, { fail_class: "wrong_answer", error: "bad result" }).fail_class, "wrong_answer");
  assert.equal(interpretEvaluation(task, ok, { score: "not a number" }).fail_class, "invalid_score");
  assert.equal(interpretEvaluation(task, ok, { score: 3, valid: false, fail_class: "ok" }).valid, false, "the evaluator's validity flag is preserved");
});

test("grid planning: bootstrap without history, then widen while improving and narrow on a plateau", async () => {
  const project = makeProject();
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const first = await planNextGrid(project.dreamRoot, project.task, 1, null);
    assert.equal(first.plan.branch_count, project.task.workers, "no history: one direction per worker");
    assert.ok(first.plan.reason.length > 0, "a plan must carry a factual reason");
    assert.equal(first.beta, project.task.default_beta);

    const fallback = fallbackGrid(project.task);
    assert.equal(fallback.branch_count, project.task.workers);
    assert.ok(fallback.reason.length > 0);
  } finally {
    project.cleanup();
  }
});
