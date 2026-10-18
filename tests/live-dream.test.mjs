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
const { runDreamPhase } = await jump("engine/dream.ts");
const { readTree, listIterations, readManifest, liveMethodPath, iterationDir, writeJson } = await jump("engine/world.ts");
const { interpretEvaluation } = await jump("engine/live.ts");
const { normalizeTask, scoringFingerprint } = await jump("engine/task.ts");
const { runPolicyChecked } = await jump("policy/runner.ts");
const { loadPrompt } = await jump("engine/prompt.ts");
const { readProgress } = await jump("engine/progress.ts");
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
    ...(extra.promptTemplate ? { promptTemplate: extra.promptTemplate } : {}),
    ...(extra.researchOrgPolicy ? { researchOrgPolicy: extra.researchOrgPolicy } : {}),
    policyTimeoutMs: 60_000,
  });
}

test("live episodes use a generation-pinned discovery prompt", async () => {
  const project = makeProject({ agent: "agent-router.mjs" });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const promptTemplate = "GENERATION_DISCOVERY_MARKER\n";
    const researchOrgPolicy = "GENERATION_RESEARCH_ORG_MARKER\n";
    const episode = await liveCycle(project, 1, { grid: { branch_count: 1, refine_count: 1 }, promptTemplate, researchOrgPolicy });

    assert.equal(episode.ok, true, episode.error ?? "");
    const attemptPrompt = fs.readFileSync(path.join(project.dreamRoot, "history", "r0001_live", "attempt_b0a0", "prompt.md"), "utf8");
    assert.match(attemptPrompt, /GENERATION_DISCOVERY_MARKER/);
    assert.match(attemptPrompt, /GENERATION_RESEARCH_ORG_MARKER/);
  } finally { project.cleanup(); }
});

test("a workspace that contains the Dream-RSI root still copies, minus the tool's own state", async () => {
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
    await copyWorkspace(dir, target, { exclude: [dreamRoot] });
    assert.ok(exists(path.join(target, "app.py")), "the real workspace content is copied");    assert.equal(exists(path.join(target, ".dream-rsi")), false, "the tool's state dir is never copied");

    // A refinement copies a workspace that already lives *inside* the excluded root: the exclusion
    // must not swallow the copy.
    const child = path.join(dreamRoot, "work", "b0a1");
    await copyWorkspace(target, child, { exclude: [dreamRoot] });
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

    // Bulk run state is self-ignored, while the useful record stays versionable.
    const ignore = fs.readFileSync(path.join(project.dreamRoot, ".gitignore"), "utf8");
    assert.match(ignore, /^work\/$/m);
    assert.match(ignore, /^trace_pool\/$/m);
    assert.doesNotMatch(ignore, /^history\/$/m, "history stays visible: it is the evidence");
    assert.doesNotMatch(ignore, /^policy\/$/m);
    assert.doesNotMatch(ignore, /^task\.json$/m);

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

    const policyImprovementPrompt = `${loadPrompt("policy-improvement.md")}\nGENERATION_IMPROVEMENT_MARKER\n`;
    const dream = await runDreamPhase({ dreamRoot: project.dreamRoot, projectDir: project.projectDir, task: project.task, iteration: 1, policyImprovementPrompt });

    assert.equal(dream.ok, true, dream.error ?? "");
    assert.equal(dream.revisions, project.task.revisions, "M = pi_0 plus every revision evaluated");
    assert.equal(dream.evaluations.length, project.task.revisions);
    assert.equal(dream.improved, true, "the policy-development agent changed the policy");
    assert.ok(dream.deployed_beta >= 0 && dream.deployed_beta <= 1);
    // The reported beta is what the next episode actually runs at, not an unapplied adjustment.
    const betaSidecar = readJson(path.join(project.dreamRoot, "policy", "deployed_beta.json"));
    assert.equal(betaSidecar.beta, dream.deployed_beta, "the deployed beta is recorded for the next episode");

    // Both prompts were routed to the agent: discovery attempts, then policy revisions.
    const dreamProgress = readProgress(project.dreamRoot, 1, "dream");
    const prompts = Object.values(dreamProgress?.attempts ?? {}).map((attempt) => attempt.agent_tail);
    assert.ok(prompts.some((tail) => /development/.test(tail)), "the improvement prompt reached the agent");
    assert.ok(prompts.some((tail) => /development .*marker=true/.test(tail)), "the generation-pinned improvement prompt reached the agent");
    assert.equal(prompts.filter((tail) => /development/.test(tail)).length, project.task.revisions - 1);
    assert.ok(
      fs.readFileSync(path.join(project.dreamRoot, "work", "r0001", "b0a0", "agent-prompts.log"), "utf8").startsWith("discovery"),
      "the discovery prompt reached the attempt agent",
    );

    // Every evaluated version is archived and the winner is deployed.
    for (let revision = 0; revision < dream.revisions; revision += 1) {
      assert.ok(
        exists(path.join(project.dreamRoot, "policy", `r0001_v${String(revision).padStart(4, "0")}.ts`)),
        `v${revision} archived`,
      );
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
    assert.equal(second.manifest.baked_beta, dream.deployed_beta, "iteration 2 runs at the deployed beta");
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
    assert.equal(episode.tree.nNonRoot, 4, "two branch openings plus one recovery in each remaining round");
    assert.equal(episode.manifest.decision_rounds, 3);
    const trace = fs.readFileSync(
      path.join(project.dreamRoot, "history", "r0001_live", "policy_execution_traces.jsonl"), "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(trace.map((decision) => decision.batch.length), [2, 1, 1],
      "failed branches share one recovery slot per batch");
    for (const node of episode.tree.list()) {
      assert.equal(node.fail_class, "eval_error");
      assert.equal(node.score, null);
      assert.match(node.error, /evaluator/);
      assert.ok(exists(path.join(project.dreamRoot, "history", "r0001_live", `attempt_${node.meta.cell_id}`, "error.txt")));
    }
    assert.equal(episode.manifest.best_score, null);
    // A repairable failure is evidence, not closure: the branch remains repliable.
    const tree = readTree(project.dreamRoot, 1);
    assert.deepEqual(tree.legalActions().sort(), ["b0a1", "b1a1"],
      "both repairable branches remain eligible after their retries");
  } finally {
    project.cleanup();
  }
});

test("missing score file, missing proposal, agent failure and agent timeout all become node outcomes", async () => {
  const cases = [
    { scorer: "score-nofile.mjs", agent: "agent-ok.mjs", fail: "eval_error" },
    { agent: "agent-noproposal.mjs", fail: "no_proposal" },
    { agent: "agent-fail.mjs", fail: "agent_error" },
    // Marker-2 timeouts are assessed: a silent hang with an unchanged workspace
    // scores 0 via score-ok, becoming timeout_scored with ordinary scores still null.
    { agent: "agent-hang.mjs", fail: "timeout_scored", agentTimeoutMs: 5000 },
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
      if (scenario.fail === "timeout_scored") {
        // The error has to carry the evidence (duration, and that nothing was printed): an empty
        // agent.log plus a bare "timed out" is what made the original report guess for an hour.
        const node = episode.tree.list().find((n) => n.fail_class === "timeout_scored");
        assert.match(node.error, /timed out after \d+(\.\d+)?s/);
        assert.match(node.error, /no output at all/);
        assert.equal(node.score, null);
        assert.equal(node.partial, true);
        assert.ok(node.agent_timeout);
        assert.equal(node.timeout_assessment.fail_class, "ok");
        assert.equal(node.timeout_assessment.score, 0, "numeric zero is retained, not treated as missing");
      }
    } finally {
      project.cleanup();
    }
  }
});

test("dreaming replays only worlds recorded under the current scoring contract", async () => {
  const project = makeProject({ agent: "agent-router.mjs" });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const first = await liveCycle(project, 1);
    assert.equal(first.ok, true, first.error ?? "");

    // Pretend the recorded world came from a previous objective: it must not enter this V table.
    const manifestPath = path.join(iterationDir(project.dreamRoot, 1), "live_cycle_manifest.json");
    const manifest = readJson(manifestPath);
    manifest.task_fingerprint = "deadbeef";
    writeJson(manifestPath, manifest);

    await assert.rejects(
      runDreamPhase({ dreamRoot: project.dreamRoot, projectDir: project.projectDir, task: project.task, iteration: 1 }),
      /different scoring configuration/,
    );

    // With the fingerprint the task actually has, the world replays as usual.
    manifest.task_fingerprint = scoringFingerprint(normalizeTask(project.task));
    writeJson(manifestPath, manifest);
    const dream = await runDreamPhase({
      dreamRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task: project.task,
      iteration: 1,
    });
    assert.equal(dream.ok, true, dream.error ?? "");
  } finally {
    project.cleanup();
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

test("per-batch ledger memory delivers timeout outcomes with identical sibling prompts", async () => {
  const project = makeProject({ agent: "agent-hang.mjs", agentTimeoutMs: 5000, task: { k1: 2 } });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const { readCheckpoint } = await jump("engine/checkpoint.ts");
    const episode = await liveCycle(project, 1, { grid: { branch_count: 2, refine_count: 2 } });
    assert.equal(episode.ok, true, episode.error ?? "");
    const cp = readCheckpoint(project.dreamRoot, 1);
    assert.equal(cp.timeout_recovery_version, 2, "new phase-2 cycles receive marker 2");
    assert.ok(cp.batches.length >= 2, "two rounds produce two batches");
    const [first, second] = cp.batches;
    assert.match(first.direction_guidance ?? "", /0 factual events/);
    // Second batch was rendered before its siblings ran: it sees the first round's timeouts.
    // Marker-2 first-round timeouts are assessed (timeout_scored with silent diagnostics).
    assert.match(second.direction_guidance ?? "", /timeout/);
    assert.match(second.direction_guidance ?? "", /2 timeouts/);
    // Sibling prompts share the identical saved guidance despite different completion times.
    const secondCells = second.attempts.map((a) => a.cell).filter(Boolean);
    assert.ok(secondCells.length >= 1, "second batch has attempts");
    for (const cell of secondCells) {
      const prompt = fs.readFileSync(path.join(project.dreamRoot, "history", "r0001_live", `attempt_${cell}`, "prompt.md"), "utf8");
      assert.ok(prompt.includes(second.direction_guidance), `${cell} uses the batch guidance`);
    }
    if (secondCells.length >= 2) {
      const promptA = fs.readFileSync(path.join(project.dreamRoot, "history", "r0001_live", `attempt_${secondCells[0]}`, "prompt.md"), "utf8");
      const promptB = fs.readFileSync(path.join(project.dreamRoot, "history", "r0001_live", `attempt_${secondCells[1]}`, "prompt.md"), "utf8");
      assert.ok(promptA.includes(second.direction_guidance), "first sibling uses the batch guidance");
      assert.ok(promptB.includes(second.direction_guidance), "second sibling uses the same batch guidance");
    }
    // Timeout diagnostics reach the prompt; ordinary scores stay null.
    for (const node of episode.tree.list()) {
      assert.ok(node.fail_class === "timeout" || node.fail_class === "timeout_scored");
      assert.equal(node.score, null);
      assert.equal(node.raw_score, null);
      assert.equal(node.valid, false);
      assert.match(node.error, /discovery agent timed out after/);
    }
  } finally {
    project.cleanup();
  }
});

test("phase-1 checkpoints with marker 1 do not assess timeout workspaces", async () => {
  const project = makeProject({ agent: "agent-hang.mjs", agentTimeoutMs: 5000, task: { guidance: "summary", k1: 1 } });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const { readCheckpoint, saveCheckpoint } = await jump("engine/checkpoint.ts");
    // Force a phase-1 checkpoint: marker 1 means refresh guidance without evaluation.
    // Run one cycle then downgrade its marker to simulate a pre-phase-2 checkpoint.
    const episode = await liveCycle(project, 1, { grid: { branch_count: 1, refine_count: 1 } });
    assert.equal(episode.ok, true);
    const cp = readCheckpoint(project.dreamRoot, 1);
    assert.equal(cp.timeout_recovery_version, 2);
    // A preserved phase-1 checkpoint (marker 1) stays phase-1 after phase 2 ships:
    // its timeout nodes carry no diagnostic assessment fields.
    const downgraded = { ...cp, timeout_recovery_version: 1 };
    for (const batch of downgraded.batches) {
      for (const attempt of batch.attempts) {
        if (attempt.record) {
          delete attempt.record.node.partial;
          delete attempt.record.node.agent_timeout;
          delete attempt.record.node.timeout_assessment;
          if (attempt.record.node.fail_class === "timeout_scored") {
            attempt.record.node.fail_class = "timeout";
          }
        }
      }
    }
    saveCheckpoint(project.dreamRoot, downgraded);
    const reloaded = readCheckpoint(project.dreamRoot, 1);
    assert.equal(reloaded.timeout_recovery_version, 1, "phase-1 marker is preserved");
    assert.equal(reloaded.batches[0].attempts[0].record.node.timeout_assessment, undefined);
  } finally {
    project.cleanup();
  }
});

test("new episodes receive factual ledger context without a guidance configuration flag", async () => {
  const project = makeProject({ agent: "agent-hang.mjs", agentTimeoutMs: 5000, task: { k1: 1 } });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const { readCheckpoint } = await jump("engine/checkpoint.ts");
    const episode = await liveCycle(project, 1, { grid: { branch_count: 2, refine_count: 1 } });
    assert.equal(episode.ok, true, episode.error ?? "");
    const cp = readCheckpoint(project.dreamRoot, 1);
    assert.match(cp.batches[0].direction_guidance, /0 factual events/, "an empty history remains factual");
    const prompt = fs.readFileSync(path.join(project.dreamRoot, "history", "r0001_live", "attempt_b0a0", "prompt.md"), "utf8");
    assert.doesNotMatch(prompt, /Direction guidance:/);
  } finally {
    project.cleanup();
  }
});

test("agent had_output distinguishes silent hangs from output-producing hangs", async () => {
  const noisy = "agent-noisy-hang.mjs";
  for (const scenario of [
    { agent: "agent-hang.mjs", silent: true },
    { agent: noisy, silent: false },
  ]) {
    const project = makeProject({ agent: scenario.agent, agentTimeoutMs: 5000 });
    try {
      if (scenario.agent === noisy) {
        fs.writeFileSync(project.script(noisy), `process.stdin.on("data", () => {});\nprocess.stdin.on("end", () => { console.log("working..."); setInterval(() => {}, 1000); });\n`, "utf8");
      }
      await writeTaskJson(project);
      await deployShippedPolicy(project);
      const episode = await liveCycle(project, 1, { grid: { branch_count: 1, refine_count: 1 } });
      const node = episode.tree.list().find((n) => n.fail_class === "timeout" || n.fail_class === "timeout_scored");
      assert.ok(node, "hang becomes a timeout");
      if (scenario.silent) {
        assert.match(node.error, /with no output at all/);
      } else {
        assert.match(node.error, /with output/);
        assert.doesNotMatch(node.error, /no output at all/);
      }
      // The runner records the fact explicitly; older results fall back to tails.
      const { runAgent } = await jump("agent/runner.ts");
      const script = scenario.agent === noisy ? project.script(noisy) : project.script("agent-hang.mjs");
      const probe = await runAgent({
        agent: { command: "node", args: [script], model: null, thinking: null, prompt_via: "stdin" },
        cwd: project.seed,
        prompt: "hi",
        timeoutMs: 3000,
        logPath: null,
      });
      assert.equal(probe.timedOut, true);
      assert.equal(probe.hadOutput, !scenario.silent);
    } finally {
      project.cleanup();
    }
  }
});

test("unsupported timeout recovery markers fail before launching agents", async () => {
  const project = makeProject({ task: { k1: 1 } });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const { readCheckpoint, saveCheckpoint } = await jump("engine/checkpoint.ts");
    const callsFile = path.join(project.projectDir, "calls.jsonl");
    fs.writeFileSync(
      path.join(project.projectDir, "counting.mjs"),
      `import * as fs from 'node:fs';\nlet p='';process.stdin.on('data',d=>p+=d);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(callsFile)},'call\\n');});\n`,
      "utf8",
    );
    project.task.agent = { command: "node", args: [path.join(project.projectDir, "counting.mjs")], model: null, prompt_via: "stdin" };
    const abort = new AbortController();
    const run = runLiveEpisode({
      dreamRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task: project.task,
      iteration: 1,
      policyPath: liveMethodPath(project.dreamRoot),
      bakedBeta: 0.6,
      grid: { branch_count: 1, refine_count: 1 },
      baselineScore: null,
      signal: abort.signal,
    });
    // Interrupt after the first batch is checkpointed but before it completes.
    const timer = setTimeout(() => abort.abort(), 300);
    await run;
    clearTimeout(timer);
    const cp = readCheckpoint(project.dreamRoot, 1);
    cp.timeout_recovery_version = 99;
    saveCheckpoint(project.dreamRoot, cp);
    const before = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8") : "";
    await assert.rejects(
      runLiveEpisode({
        dreamRoot: project.dreamRoot,
        projectDir: project.projectDir,
        task: project.task,
        iteration: 1,
        policyPath: liveMethodPath(project.dreamRoot),
        bakedBeta: 0.6,
        grid: { branch_count: 1, refine_count: 1 },
        baselineScore: null,
        resume: true,
      }),
      /unsupported timeout recovery version/,
    );
    const after = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8") : "";
    assert.equal(after, before, "rejected checkpoints spend zero extra agent calls");
  } finally {
    project.cleanup();
  }
});

test("legacy checkpoints without a marker resume with legacy prompt behavior", async () => {
  const project = makeProject({ task: { k1: 1, guidance: "summary" } });
  try {
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const { readCheckpoint, saveCheckpoint } = await jump("engine/checkpoint.ts");
    // Simulate a legacy checkpoint: no marker, no per-batch guidance, episode-level vars only.
    const episode = await liveCycle(project, 1, { grid: { branch_count: 1, refine_count: 1 } });
    assert.equal(episode.ok, true);
    const cp = readCheckpoint(project.dreamRoot, 1);
    assert.equal(cp.timeout_recovery_version, 2);
    assert.ok(typeof cp.batches[0].direction_guidance === "string");
    const stripped = { ...cp };
    delete stripped.timeout_recovery_version;
    for (const batch of stripped.batches) delete batch.direction_guidance;
    saveCheckpoint(project.dreamRoot, stripped);
    const reloaded = readCheckpoint(project.dreamRoot, 1);
    assert.equal(reloaded.timeout_recovery_version, undefined, "legacy absence is preserved");
    assert.equal(reloaded.batches[0].direction_guidance, undefined);
    // Validation accepts the legacy marker absence.
    const { validateCheckpoint } = await jump("engine/checkpoint.ts");
    const { normalizeTask: normalize } = await jump("engine/task.ts");
    await validateCheckpoint(project.dreamRoot, project.projectDir, normalize(project.task), 1);
  } finally {
    project.cleanup();
  }
});

test("timeout classification is pure: scored only for accepted numeric assessments", async () => {
  const { classifyAgentTimeout } = await jump("engine/timeout.ts");
  const agent = { duration_ms: 480000, had_output: true };
  const err = "discovery agent timed out after 480s with output (see agent.log)";
  const scored = classifyAgentTimeout(err, agent, { score: 0.72, raw_score: 0.72, valid: true, fail_class: "ok", error: null });
  assert.equal(scored.fail_class, "timeout_scored");
  assert.equal(scored.partial, true);
  assert.equal(scored.valid, false);
  assert.equal(scored.error, err);
  assert.deepEqual(scored.agent_timeout, agent);
  assert.deepEqual(scored.timeout_assessment, { score: 0.72, raw_score: 0.72, valid: true, fail_class: "ok", error: null });
  // Numeric zero is a measured assessment, never missing.
  const zero = classifyAgentTimeout(err, agent, { score: 0, raw_score: 0, valid: true, fail_class: "ok", error: null });
  assert.equal(zero.fail_class, "timeout_scored");
  assert.equal(zero.timeout_assessment.score, 0);
  // Evaluator valid:false is preserved but still scored when otherwise accepted.
  const soft = classifyAgentTimeout(err, agent, { score: 5, raw_score: 5, valid: false, fail_class: "ok", error: null });
  assert.equal(soft.fail_class, "timeout_scored");
  assert.equal(soft.timeout_assessment.valid, false);
  // All failure modes stay timeout with an unresolved assessment, never zero.
  for (const evalOutcome of [
    { score: null, raw_score: null, valid: false, fail_class: "eval_error", error: "evaluator exited with code 4" },
    { score: null, raw_score: null, valid: false, fail_class: "eval_error", error: "evaluator wrote no eval/score.json" },
    { score: null, raw_score: null, valid: false, fail_class: "invalid_score", error: 'score field "score" is missing or not a finite number' },
    { score: null, raw_score: null, valid: false, fail_class: "timeout", error: "evaluator timed out" },
    { score: null, raw_score: 3, valid: false, fail_class: "wrong_answer", error: "bad result" },
    { score: null, raw_score: null, valid: false, fail_class: "ok", error: "stale" },
    { score: NaN, raw_score: NaN, valid: true, fail_class: "ok", error: null },
    { score: Infinity, raw_score: Infinity, valid: true, fail_class: "ok", error: null },
  ]) {
    const unresolved = classifyAgentTimeout(err, agent, evalOutcome);
    assert.equal(unresolved.fail_class, "timeout");
    assert.equal(unresolved.partial, true);
    assert.equal(unresolved.valid, false);
    assert.equal(unresolved.error, err);
    assert.notEqual(unresolved.timeout_assessment.score, 0, "missing assessments are never replaced with zero");
  }
});

test("an agent that edits then hangs gets a fresh diagnostic assessment without proposal.md", async () => {
  const project = makeProject({ agentTimeoutMs: 5000, task: { k1: 1 } });
  try {
    fs.writeFileSync(project.script("agent-edit-hang.mjs"), `import { appendFileSync } from "node:fs";\nlet p="";process.stdin.on("data",d=>p+=d);process.stdin.on("end",()=>{appendFileSync("solution.py","xxxx\\n");console.log("edited");setInterval(()=>{},1000);});\n`, "utf8");
    project.task.agent = { command: "node", args: [project.script("agent-edit-hang.mjs")], model: null, prompt_via: "stdin" };
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const episode = await liveCycle(project, 1, { grid: { branch_count: 1, refine_count: 1 } });
    assert.equal(episode.ok, true, episode.error ?? "");
    const node = episode.tree.list()[0];
    assert.equal(node.fail_class, "timeout_scored");
    assert.equal(node.score, null);
    assert.equal(node.raw_score, null);
    assert.equal(node.valid, false);
    assert.equal(node.partial, true);
    assert.equal(node.agent_timeout.had_output, true);
    assert.equal(typeof node.agent_timeout.duration_ms, "number");
    // Fresh scorer value for the edited workspace (seed 0 x + 4 x).
    assert.equal(node.timeout_assessment.fail_class, "ok");
    assert.equal(node.timeout_assessment.raw_score, 4);
    assert.equal(node.timeout_assessment.score, 4);
    // No proposal.md was required for the assessment.
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "history", "r0001_live", "attempt_b0a0", "proposal.md")), false);
    assert.ok(fs.existsSync(path.join(project.dreamRoot, "history", "r0001_live", "attempt_b0a0", "eval", "score.json")));
  } finally {
    project.cleanup();
  }
});

test("silent edits are still assessed; untouched workspaces record a baseline-like zero", async () => {
  for (const [name, edit] of [["silent-edit", true], ["no-edit", false]]) {
    const project = makeProject({ agentTimeoutMs: 5000, task: { k1: 1 } });
    try {
      const script = project.script(`agent-${name}.mjs`);
      fs.writeFileSync(script, edit
        ? `import { appendFileSync } from "node:fs";\nprocess.stdin.on("data",()=>{});process.stdin.on("end",()=>{appendFileSync("solution.py","xx\\n");setInterval(()=>{},1000);});\n`
        : `process.stdin.on("data",()=>{});process.stdin.on("end",()=>{setInterval(()=>{},1000);});\n`, "utf8");
      project.task.agent = { command: "node", args: [script], model: null, prompt_via: "stdin" };
      await writeTaskJson(project);
      await deployShippedPolicy(project);
      const episode = await liveCycle(project, 1, { grid: { branch_count: 1, refine_count: 1 } });
      const node = episode.tree.list()[0];
      assert.equal(node.fail_class, "timeout_scored");
      assert.equal(node.partial, true);
      if (edit) {
        assert.equal(node.agent_timeout.had_output, false);
        assert.equal(node.timeout_assessment.raw_score, 2);
      } else {
        // Unchanged workspace is still assessable; the zero does not claim progress.
        assert.equal(node.timeout_assessment.raw_score, 0);
        assert.equal(node.score, null, "top-level score stays null so no progress is claimed");
      }
    } finally {
      project.cleanup();
    }
  }
});

test("lower-is-better timeout assessments normalize for policy use and keep raw for reporting", async () => {
  const project = makeProject({ agentTimeoutMs: 5000, task: { k1: 1, higher_is_better: false } });
  try {
    fs.writeFileSync(project.script("agent-edit-hang.mjs"), `import { appendFileSync } from "node:fs";\nprocess.stdin.on("data",()=>{});process.stdin.on("end",()=>{appendFileSync("solution.py","xxxx\\n");setInterval(()=>{},1000);});\n`, "utf8");
    project.task.agent = { command: "node", args: [project.script("agent-edit-hang.mjs")], model: null, prompt_via: "stdin" };
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const episode = await liveCycle(project, 1, { grid: { branch_count: 1, refine_count: 1 } });
    const node = episode.tree.list()[0];
    assert.equal(node.fail_class, "timeout_scored");
    assert.equal(node.timeout_assessment.raw_score, 4);
    assert.equal(node.timeout_assessment.score, -4, "normalized to higher-is-better for policy use");
  } finally {
    project.cleanup();
  }
});

test("failed timeout evaluations stay unresolved with distinct agent and evaluator deadlines", async () => {
  const cases = [
    { name: "crash", scorer: "score-fail.mjs", match: /eval_error/ },
    { name: "nofile", scorer: "score-nofile.mjs", match: /wrote no/ },
    { name: "malformed", scorer: null, match: /not a finite number/ },
    { name: "wrong", scorer: null, match: /wrong_answer/ },
  ];
  for (const c of cases) {
    const project = makeProject({ agent: "agent-hang.mjs", agentTimeoutMs: 5000, scorer: c.scorer ?? "score-ok.mjs", task: { k1: 1 } });
    try {
      if (c.name === "malformed") {
        fs.writeFileSync(project.script("score-bad.mjs"), `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("eval",{recursive:true});writeFileSync("eval/score.json",JSON.stringify({score:"nan",valid:true,fail_class:"ok",error:null}));\n`, "utf8");
        project.task.score_program = `node "${project.script("score-bad.mjs")}"`;
      }
      if (c.name === "wrong") {
        fs.writeFileSync(project.script("score-wrong.mjs"), `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("eval",{recursive:true});writeFileSync("eval/score.json",JSON.stringify({score:1,valid:false,fail_class:"wrong_answer",error:"bad result"}));\n`, "utf8");
        project.task.score_program = `node "${project.script("score-wrong.mjs")}"`;
      }
      await writeTaskJson(project);
      await deployShippedPolicy(project);
      const episode = await liveCycle(project, 1, { grid: { branch_count: 1, refine_count: 1 } });
      const node = episode.tree.list()[0];
      assert.equal(node.fail_class, "timeout", `${c.name} retains the agent timeout class`);
      assert.equal(node.partial, true);
      assert.ok(node.agent_timeout, "agent diagnostics are still recorded");
      assert.match(node.error, /discovery agent timed out/);
      assert.equal(node.score, null);
      assert.match(`${node.timeout_assessment.fail_class}: ${node.timeout_assessment.error ?? ""}`, c.match);
    } finally {
      project.cleanup();
    }
  }
  // Evaluator timeout keeps the agent deadline separate from the evaluator deadline.
  const slow = makeProject({ agent: "agent-hang.mjs", agentTimeoutMs: 5000, task: { k1: 1 }, evaluatorTimeoutMs: 2000 });
  try {
    fs.writeFileSync(slow.script("score-slow.mjs"), `setInterval(()=>{},1000);\n`, "utf8");
    slow.task.score_program = `node "${slow.script("score-slow.mjs")}"`;
    await writeTaskJson(slow);
    await deployShippedPolicy(slow);
    const episode = await liveCycle(slow, 1, { grid: { branch_count: 1, refine_count: 1 } });
    const node = episode.tree.list()[0];
    assert.equal(node.fail_class, "timeout");
    assert.match(node.error, /discovery agent timed out/);
    assert.equal(node.timeout_assessment.fail_class, "timeout");
    assert.match(node.timeout_assessment.error, /evaluator timed out/);
  } finally {
    slow.cleanup();
  }
});

test("an inherited score file cannot supply a timeout assessment", async () => {
  const project = makeProject({ agentTimeoutMs: 5000, scorer: "score-nofile.mjs", task: { k1: 1 } });
  try {
    // Parent would score highly if its file leaked; the child scorer writes nothing.
    fs.writeFileSync(project.script("agent-edit-hang.mjs"), `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";\nprocess.stdin.on("data",()=>{});process.stdin.on("end",()=>{appendFileSync("solution.py","xxxx\\n");mkdirSync("eval",{recursive:true});writeFileSync("eval/score.json",JSON.stringify({score:99,valid:true,fail_class:"ok",error:null}));setInterval(()=>{},1000);});\n`, "utf8");
    project.task.agent = { command: "node", args: [project.script("agent-edit-hang.mjs")], model: null, prompt_via: "stdin" };
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const episode = await liveCycle(project, 1, { grid: { branch_count: 1, refine_count: 1 } });
    const node = episode.tree.list()[0];
    assert.equal(node.fail_class, "timeout");
    assert.equal(node.timeout_assessment.fail_class, "eval_error");
    assert.notEqual(node.timeout_assessment.raw_score, 99);
  } finally {
    project.cleanup();
  }
});

test("timeout assessments preserve the evaluator valid:false flag", async () => {
  const project = makeProject({ agentTimeoutMs: 5000, task: { k1: 1 } });
  try {
    fs.writeFileSync(project.script("agent-edit-hang.mjs"), `import { appendFileSync } from "node:fs";\nprocess.stdin.on("data",()=>{});process.stdin.on("end",()=>{appendFileSync("solution.py","x\\n");setInterval(()=>{},1000);});\n`, "utf8");
    project.task.agent = { command: "node", args: [project.script("agent-edit-hang.mjs")], model: null, prompt_via: "stdin" };
    fs.writeFileSync(project.script("score-soft.mjs"), `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("eval",{recursive:true});writeFileSync("eval/score.json",JSON.stringify({score:7,valid:false,fail_class:"ok",error:null}));\n`, "utf8");
    project.task.score_program = `node "${project.script("score-soft.mjs")}"`;
    await writeTaskJson(project);
    await deployShippedPolicy(project);
    const episode = await liveCycle(project, 1, { grid: { branch_count: 1, refine_count: 1 } });
    const node = episode.tree.list()[0];
    assert.equal(node.fail_class, "timeout_scored");
    assert.equal(node.timeout_assessment.valid, false);
    assert.equal(node.timeout_assessment.score, 7);
  } finally {
    project.cleanup();
  }
});
