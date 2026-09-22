/**
 * Candidate ranking: ordering, preferences, evidence extraction, and the guarantee that it only reads.
 *
 * Built on a hand-made `.dream-rsi` state so the numbers are exact: two good candidates (one that admits
 * a staleness trade, one that does not), one failed, one worse than the baseline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { jump } from "./fixtures.mjs";

const { rankCandidates, renderSuggestion, parsePreference, MIN_WIN_FRACTION } = await jump("engine/candidates.ts");
const { DiscoveryTree } = await jump("engine/tree.ts");
const { normalizeTask, writeTask, scoringFingerprint, scoreMatchesDirection } = await jump("engine/task.ts");
const { improvements, seedMatchesTask } = await jump("engine/improvements.ts");
const { writeJson } = await jump("engine/world.ts");
const { buildAgentArgs, piSelfInvocation, runAgent, describeSpawnError } = await jump("agent/runner.ts");

/** A project with a recorded cycle: baseline 100, best candidate 200. */
function makeRankedProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-rank-"));
  const projectDir = path.join(dir, "proj");
  const dreamRoot = path.join(projectDir, ".dream-rsi");
  const seed = path.join(projectDir, "seed");
  fs.mkdirSync(seed, { recursive: true });
  const task = normalizeTask({
    name: "throughput",
    workspace: "seed",
    eval_program: "prog.py",
    score_program: "node score.mjs", // never run by the ranker
    problem_file: "PROBLEM.md",
    workers: 2,
    k1: 2,
    k2: 2,
    revisions: 1,
  });
  fs.writeFileSync(path.join(seed, "prog.py"), "print('seed')\n", "utf8");
  fs.writeFileSync(path.join(projectDir, "PROBLEM.md"), "# Maximize recall throughput of the search loop\n", "utf8");
  fs.writeFileSync(path.join(projectDir, "score.mjs"), "console.log('unused')\n", "utf8");
  writeTask(dreamRoot, task);
  fs.mkdirSync(path.join(dreamRoot, "trace_pool", "iter0001"), { recursive: true });
  writeJson(path.join(dreamRoot, "history", "seed", "score.json"), {
    score: 100,
    raw_score: 100,
    fail_class: "ok",
    error: null,
    measured_at: new Date(0).toISOString(),
    workspace: "seed",
    seconds: 0.1,
  });

  const tree = new DiscoveryTree({ baselineScore: null, branchCount: 2, refineCount: 2 });
  tree.addBranchSlot(0);
  tree.addBranchSlot(1);
  const candidates = [
    { cell: "b0a0", score: 200, mentions: "cache, stale, window" },
    { cell: "b1a0", score: 196, mentions: "" },
    { cell: "b1a1", parent: "b1a0", score: 120, mentions: "", fail: true },
    { cell: "b0a1", parent: "b0a0", score: 80, mentions: "" },
  ];
  for (const candidate of candidates) {
    if (candidate.parent) {
      const branch = Number(/^b(\d+)/.exec(candidate.cell)[1]);
      tree.addChild(candidate.parent, branch, 1);
    }
    const workspace = path.join(dreamRoot, "work", "r0001", candidate.cell);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "prog.py"), `print('${candidate.cell}')\n`, "utf8");
    const record = path.join(dreamRoot, "history", "r0001_live", `attempt_${candidate.cell}`);
    fs.mkdirSync(path.join(record, "eval"), { recursive: true });
    fs.writeFileSync(
      path.join(record, "proposal.md"),
      `# Proposal: ${candidate.cell} mechanism\n\n${candidate.mentions ? `Admits: ${candidate.mentions}` : "No caveats."}\n`,
      "utf8",
    );
    writeJson(path.join(record, "eval", "score.json"), {
      score: candidate.score,
      valid: true,
      fail_class: candidate.fail ? "eval_error" : "ok",
      error: candidate.fail ? "boom" : null,
      p99_ms: 12.5,
    });
    tree.setOutcome(candidate.cell, {
      evaluated: true,
      valid: !candidate.fail,
      fail_class: candidate.fail ? "eval_error" : "ok",
      error: candidate.fail ? "boom" : null,
      score: candidate.score,
      raw_score: candidate.score,
      workspace: path.relative(projectDir, workspace),
      proposal: path.relative(projectDir, path.join(workspace, "proposal.md")),
      duration_ms: 1000,
    });
  }
  // A data file the scorer rewrites: differs, but is not a candidate edit.
  fs.writeFileSync(path.join(dreamRoot, "work", "r0001", "b0a0", "corpus.db"), Buffer.from([0, 1, 2, 3, 0, 255]));
  writeJson(path.join(dreamRoot, "trace_pool", "iter0001", "tree.json"), tree.toJSON());
  writeJson(path.join(dreamRoot, "trace_pool", "iter0001", "live_cycle_manifest.json"), { iteration: 1, status: "complete" });
  return { dir, projectDir, dreamRoot, seed, task };
}

function hashTree(root) {
  const hash = crypto.createHash("sha1");
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else hash.update(entry.name).update(fs.readFileSync(file));
    }
  };
  walk(root);
  return hash.digest("hex");
}

test("rank order follows the score, the best candidate is the pending one, failures are excluded", () => {
  const project = makeRankedProject();
  try {
    const ranking = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir });
    assert.deepEqual(
      ranking.candidates.map((candidate) => candidate.cell),
      ["b0a0", "b1a0", "b0a1"],
      "failed candidate b1a1 is not a candidate",
    );
    assert.equal(ranking.pending.cell, "b0a0");
    assert.equal(ranking.pending.delta_vs_seed, 100);
    assert.equal(ranking.pending.gain_pct, 100);
    assert.equal(ranking.candidates[1].delta_vs_seed, 96);
    assert.equal(ranking.candidates.find((c) => c.cell === "b0a1").delta_vs_seed, -20);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("evidence comes from disk: secondary metrics, scoped files, admitted trades", () => {
  const project = makeRankedProject();
  try {
    const ranking = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir });
    const best = ranking.candidates[0];
    assert.equal(best.metrics.p99_ms, 12.5, "secondary metrics are read from the archived score.json");
    assert.deepEqual(best.changed_files.map((file) => file.relative), ["prog.py"], "only code counts as a change");
    assert.deepEqual(best.data_changed_files.map((file) => file.relative), ["corpus.db"], "data files are disclosed, not counted");
    assert.deepEqual(best.out_of_scope_files, [], "a data file is not an out-of-scope edit");
    assert.deepEqual(best.high_risk_mentions, ["stale", "window"], "the admitted trade is extracted from the proposal");
    assert.equal(best.applicable, true);
    assert.equal(best.already_applied, false);
    assert.match(best.proposal_summary ?? "", /b0a0 mechanism/);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("preferences: fastest keeps the leader, safest buys less risk inside the win band", () => {
  const project = makeRankedProject();
  try {
    const fastest = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir, goal: "fastest" });
    assert.equal(fastest.preference.kind, "score");
    assert.equal(fastest.pending.cell, "b0a0");

    // b1a0 gives up 4% of the win (96 vs 100) — inside the band — and admits nothing.
    const safest = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir, goal: "safest" });
    assert.equal(safest.preference.kind, "safe");
    assert.equal(safest.candidates[0].cell, "b1a0", "the candidate with less to take on wins inside the band");
    assert.equal(safest.pending.cell, "b1a0");
    assert.ok(safest.pending.high_risk_mentions.length === 0);
    assert.ok(MIN_WIN_FRACTION <= 0.96, "the fixture stays inside the win band");

    const unknown = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir, goal: "make the widget nicer" });
    assert.equal(unknown.preference.kind, null, "unknown goals do not filter candidates");
    assert.equal(unknown.candidates.length, fastest.candidates.length);
    assert.equal(unknown.relevance.aligned, false, "a goal with nothing in common with the task is flagged");
    assert.match(unknown.relevance.taskSummary, /recall throughput/);

    const aligned = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir, goal: "improve recall throughput" });
    assert.equal(aligned.relevance.aligned, true);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("an applied candidate stops being pending, and the renderer never invites an inferior pick", () => {
  const project = makeRankedProject();
  try {
    fs.writeFileSync(
      path.join(project.dreamRoot, "history", "applied.jsonl"),
      `${JSON.stringify({ iteration: 1, cell: "b0a0", score: 200, applied_at: new Date(0).toISOString(), paths: ["prog.py"], target: "seed" })}\n`,
      "utf8",
    );
    const ranking = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir });
    assert.equal(ranking.candidates[0].already_applied, true);
    assert.equal(ranking.pending, null, "nothing on record beats what was applied");
    assert.match(ranking.reason, /nothing beats the last applied candidate/);

    const text = renderSuggestion(ranking);
    assert.match(text, /Nothing to apply:/);
    assert.doesNotMatch(text, /dream_rsi_apply/, "no apply command for a candidate that is not worth taking");
    const compact = renderSuggestion(ranking, { compact: true });
    assert.match(compact, /^Nothing to apply:/);
    assert.doesNotMatch(compact, /dream_rsi_apply/);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("rendering a pending pick carries the numbers, the caveats and the apply call", () => {
  const project = makeRankedProject();
  try {
    const ranking = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir, goal: "fastest" });
    const text = renderSuggestion(ranking);
    assert.match(text, /IMPROVEMENT READY — NOT APPLIED/);
    assert.match(text, /TOP PICK  b0a0/);
    assert.match(text, /score 200  vs your code 100/);
    assert.match(text, /prog\.py \(2 → 2 lines\)/, "line counts come from the workspace files");
    assert.match(text, /mentions: cache, stale, window/);
    assert.match(text, /dream_rsi_apply cell=b0a0 confirm=true/);
    assert.match(text, /runner-ups:/);
    assert.match(text, /preference: fastest/);
    assert.match(text, /data file the scorer rewrites \(corpus\.db\)/);
    assert.match(renderSuggestion(ranking, { compact: true }), /^⚠️ IMPROVEMENT READY — NOT APPLIED\n/);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("an empty history says so instead of inventing a recommendation", () => {
  const project = makeRankedProject();
  try {
    fs.rmSync(path.join(project.dreamRoot, "trace_pool", "iter0001"), { recursive: true, force: true });
    const ranking = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir });
    assert.equal(ranking.candidates.length, 0);
    assert.equal(ranking.pending, null);
    assert.match(ranking.reason, /no successful candidate recorded yet/);
    assert.match(renderSuggestion(ranking), /^Nothing to apply: no successful candidate/);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("ranking is deterministic and writes nothing", () => {
  const project = makeRankedProject();
  try {
    const before = hashTree(project.projectDir);
    const first = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir, goal: "safest" });
    const second = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir, goal: "safest" });
    assert.deepEqual(
      first.candidates.map((candidate) => [candidate.cell, candidate.score]),
      second.candidates.map((candidate) => [candidate.cell, candidate.score]),
    );
    renderSuggestion(first);
    renderSuggestion(first, { compact: true });
    assert.equal(hashTree(project.projectDir), before, "ranking and rendering never touch the project");
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("parsePreference maps words and stays silent about anything else", () => {
  assert.equal(parsePreference("fastest").kind, "score");
  assert.equal(parsePreference("give me the best one").kind, "score");
  assert.equal(parsePreference("safest option").kind, "safe");
  assert.equal(parsePreference("least invasive please").kind, "safe");
  assert.equal(parsePreference("simplest change").kind, "simple");
  assert.equal(parsePreference("fewest files").kind, "simple");
  assert.equal(parsePreference("cut recall latency").kind, null);
  assert.equal(parsePreference(null).kind, null);
});

test("the configured model is actually passed to attempts", () => {
  const base = { command: "pi", args: ["-p", "--no-session"], model: null, thinking: null, prompt_via: "stdin" };
  assert.deepEqual(buildAgentArgs(base), ["-p", "--no-session"], "no model, no flag");
  assert.deepEqual(buildAgentArgs({ ...base, model: "opencode-go/deepseek-v4.1-flash" }), [
    "-p",
    "--no-session",
    "--model",
    "opencode-go/deepseek-v4.1-flash",
  ], "a configured model is appended when the args carry no placeholder");
  assert.deepEqual(buildAgentArgs({ ...base, args: ["-p", "--model", "{model}"], model: "x/y" }), ["-p", "--model", "x/y"], "placeholder wins");
  assert.deepEqual(buildAgentArgs({ ...base, args: ["-p"], model: null }), ["-p"]);
});

test("the session thinking level is passed to attempts", () => {
  const base = { command: "pi", args: ["-p", "--no-session"], model: null, thinking: null, prompt_via: "stdin" };
  assert.deepEqual(buildAgentArgs({ ...base, thinking: "high" }), ["-p", "--no-session", "--thinking", "high"]);
  assert.deepEqual(
    buildAgentArgs({ ...base, args: ["-p", "--thinking={thinking}"], thinking: "low" }),
    ["-p", "--thinking=low"],
    "placeholder wins",
  );
  assert.deepEqual(
    buildAgentArgs({ ...base, args: ["-p", "--thinking", "max"], thinking: "low" }),
    ["-p", "--thinking", "max"],
    "an explicit --thinking wins",
  );
  assert.deepEqual(buildAgentArgs({ ...base, model: "x/y", thinking: "high" }), [
    "-p",
    "--no-session",
    "--model",
    "x/y",
    "--thinking",
    "high",
  ], "model and thinking travel together");
});

test("the default pi agent re-spawns the running pi instead of trusting PATH", () => {
  const argv1 = "/opt/pi/dist/bundle/cli.js";
  const exists = (candidate) => candidate === argv1;
  assert.deepEqual(
    piSelfInvocation({ insidePi: true, argv1, execPath: "/usr/bin/node", exists }),
    { command: "/usr/bin/node", args: [argv1] },
    "node + the running cli.js is PATH-independent",
  );
  assert.equal(
    piSelfInvocation({ insidePi: false, argv1, execPath: "/usr/bin/node", exists }),
    null,
    "outside pi (SDK host, tests) the caller falls back to `pi`",
  );
  assert.deepEqual(
    piSelfInvocation({ insidePi: true, argv1: "/$bunfs/root/cli.js", execPath: "/usr/local/bin/pi", exists: () => true }),
    { command: "/usr/local/bin/pi", args: [] },
    "a bun virtual script is not a real path; the compiled binary is re-run directly",
  );
  assert.equal(
    piSelfInvocation({ insidePi: true, argv1: "/no/such/cli.js", execPath: "/usr/bin/node", exists: () => false }),
    null,
    "generic runtime with no real script falls back to `pi`",
  );
});

test("only a real pi entry point is re-spawned, never the host process that inherited pi's markers", () => {
  // pi sets PI_CODING_AGENT/AI_AGENT on its CLI and RPC entries and every child inherits them, so a host
  // app that embeds pi (or anything launched from inside pi) is `insidePi` while argv1 is its own entry.
  // Re-running that argv1 spawns the host as the "agent": it writes nothing, and the attempt dies 30
  // minutes later as a silent `timeout` with an empty agent.log.
  const exists = () => true;
  for (const host of ["/srv/pi-web/server.js", "/opt/web/sessiond.mjs", "/app/index.cjs", "/app/worker.ts"]) {
    assert.equal(
      piSelfInvocation({ insidePi: true, argv1: host, execPath: "/usr/bin/node", exists }),
      null,
      `${host} is not pi, so it must not be spawned as the discovery agent`,
    );
  }
  for (const entry of [
    "/opt/pi/dist/cli.js",
    "/opt/pi/dist/bundle/cli.js",
    "/opt/pi/dist/bundle/cli-runtime.js",
    "/src/cli.ts",
  ]) {
    assert.deepEqual(
      piSelfInvocation({ insidePi: true, argv1: entry, execPath: "/usr/bin/node", exists }),
      { command: "/usr/bin/node", args: [entry] },
      `${entry} is pi's own entry point`,
    );
  }
});

test("rpc-entry re-spawns as its sibling CLI, never as an RPC server that ignores -p", () => {
  // rpc-entry.js hardcodes `--mode rpc`, which wins over our `-p`: spawned as the agent it waits
  // for JSON-RPC frames, writes nothing, and burns the attempt as a silent timeout with an empty log.
  // Paths go through path.join, so build expectations with the platform's separators.
  const distDir = path.dirname("/opt/pi/dist/rpc-entry.js");
  const siblingCli = path.join(distDir, "cli.js");
  const rpcEntry = path.join(distDir, "rpc-entry.js");
  const realDist = (candidate) => candidate === siblingCli || candidate === rpcEntry;
  assert.deepEqual(
    piSelfInvocation({ insidePi: true, argv1: rpcEntry, execPath: "/usr/bin/node", exists: realDist }),
    { command: "/usr/bin/node", args: [siblingCli] },
    "the CLI entry beside rpc-entry runs print mode",
  );
  // No sibling CLI on disk: fall back to PATH resolution instead of spawning an RPC server.
  assert.equal(
    piSelfInvocation({ insidePi: true, argv1: rpcEntry, execPath: "/usr/bin/node", exists: (c) => c === rpcEntry }),
    null,
    "without a sibling CLI the caller falls back to `pi` rather than spawning rpc mode",
  );
});

test("a missing agent CLI reports the command and the fix instead of a bare ENOENT", async () => {
  const enoent = Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" });
  assert.match(describeSpawnError(enoent, true), /spawn pi ENOENT/);
  assert.doesNotMatch(describeSpawnError(enoent, true), /agent\.command/, "a shell already named the command");
  assert.match(describeSpawnError(enoent, false), /spawn pi ENOENT/);
  assert.match(describeSpawnError(enoent, false), /agent\.command/, "a shell-free miss says how to pin the CLI");
  const other = Object.assign(new Error("spawn pi EPERM"), { code: "EPERM" });
  assert.equal(describeSpawnError(other, false), "spawn pi EPERM", "only a miss gets the hint");

  // POSIX-only wiring check: a custom command spawns without a shell there, so a missing CLI raises ENOENT.
  if (process.platform === "win32") return;
  const result = await runAgent({
    agent: { command: "/nonexistent/dream-rsi-agent", args: [], prompt_via: "stdin" },
    cwd: os.tmpdir(),
    prompt: "propose something",
    timeoutMs: 10_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false, "a missing CLI fails immediately, it must not look like a hang");
  assert.match(result.spawnError, /agent\.command/);
});

test("an npm-installed package runs its worker from the project, not from node_modules", async () => {
  // Node refuses to strip TypeScript types under node_modules, and that is exactly where npm puts the
  // package. The worker entry must therefore be mirrored into the project before it is spawned.
  const { runPolicyChecked } = await jump("policy/runner.ts");
  const { ensurePolicyRuntime, deployPolicy, ensureWorkerRuntime } = await jump("engine/world.ts");
  const { EXT } = await import("./fixtures.mjs");
  const path = await import("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-npmlayout-"));
  try {
    // A faithful npm layout: the extension inside node_modules/pi-dream-rsi/extensions/pi-dream-rsi.
    const installRoot = path.join(dir, "consumer", "node_modules", "pi-dream-rsi");
    fs.mkdirSync(installRoot, { recursive: true });
    for (const entry of ["extensions", "prompts", "skills", "package.json"]) {
      fs.cpSync(path.join(EXT, "..", "..", entry), path.join(installRoot, entry), { recursive: true });
    }
    const installedExt = path.join(installRoot, "extensions", "pi-dream-rsi");

    // Deploy that copy's policy into a project the way dream_rsi_init does.
    const dreamRoot = path.join(dir, "consumer", ".dream-rsi");
    fs.mkdirSync(path.join(dir, "consumer", "seed"), { recursive: true });
    ensurePolicyRuntime(dreamRoot, path.join(installedExt, "policy"));
    deployPolicy(dreamRoot, fs.readFileSync(path.join(installedExt, "policy", "method.ts"), "utf8"));

    // Spawning the package copy directly is what used to happen, and it throws.
    const { Worker } = await import("node:worker_threads");
    const spawnPackageWorker = () =>
      new Promise((_resolve, reject) => {
        const worker = new Worker(path.join(installedExt, "worker", "policy-worker.ts"), {
          execArgv: process.features?.typescript ? [] : ["--experimental-strip-types"],
          workerData: { policyPath: path.join(dreamRoot, "policy", "method.ts"), mode: "grid", maxParallelism: 1, config: {} },
        });
        worker.on("error", reject);
        worker.on("exit", () => _resolve(undefined));
      });
    await assert.rejects(spawnPackageWorker(), /node_modules/);

    // Mirrored into the project, the same policy runs.
    const mirrored = ensureWorkerRuntime(dreamRoot, installedExt);
    assert.ok(mirrored && fs.existsSync(mirrored), "the worker is mirrored into the project");
    assert.ok(mirrored.includes(`${path.sep}.dream-rsi${path.sep}runtime${path.sep}`));
    for (const relative of ["worker/policy-worker.ts", "engine/tree.ts", "engine/replay.ts", "policy/host.ts", "policy/api.ts"]) {
      assert.ok(fs.existsSync(path.join(dreamRoot, "runtime", relative)), `${relative} came along`);
    }

    const tree = new DiscoveryTree({ baselineScore: 0, branchCount: 1, refineCount: 1 });
    tree.addBranchSlot(0);
    const run = await runPolicyChecked({
      policyPath: path.join(dreamRoot, "policy", "method.ts"),
      mode: "replay",
      maxParallelism: 1,
      world: tree,
      maxRounds: 2,
      verifyDeterminism: true,
    });
    assert.equal(run.ok, true, run.error ?? "");
    assert.equal(run.deterministic, true, "and the mirrored worker is deterministic");
    assert.ok(!mirrored.includes("node_modules"), "never spawns from node_modules");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the scoring fingerprint follows the contract, not the budgets", () => {
  const base = normalizeTask({ name: "t", workspace: "seed", eval_program: "prog.py", score_program: "node s.mjs" });
  const budgetOnly = normalizeTask({ ...base, workers: 8, k1: 2, revisions: 5, default_beta: 0.2, max_loops: 4 });
  assert.equal(scoringFingerprint(base), scoringFingerprint(budgetOnly), "budgets never invalidate recorded scores");
  assert.notEqual(scoringFingerprint(base), scoringFingerprint(normalizeTask({ ...base, higher_is_better: false })));
  assert.notEqual(scoringFingerprint(base), scoringFingerprint(normalizeTask({ ...base, score_program: "node other.mjs" })));
  assert.notEqual(scoringFingerprint(base), scoringFingerprint(normalizeTask({ ...base, workspace: "seed2" })));
});

test("a stored score that contradicts the current direction is recognized", () => {
  const higher = normalizeTask({ name: "t", workspace: "seed", eval_program: "prog.py", score_program: "node s.mjs" });
  const lower = normalizeTask({ ...higher, higher_is_better: false });
  assert.equal(scoreMatchesDirection(higher, 79, 79), true);
  assert.equal(scoreMatchesDirection(higher, -79, 79), false);
  assert.equal(scoreMatchesDirection(lower, -79, 79), true);
  // The bug report's mix: an old +79 candidate and new -54 candidates cannot both be "best".
  assert.equal(scoreMatchesDirection(lower, 79, 79), false);
  assert.equal(scoreMatchesDirection(lower, -54, 54), true);
  assert.equal(scoreMatchesDirection(lower, -79, null), true, "an unknown raw score cannot be judged");
});

test("candidates recorded under another scoring contract are not ranked", () => {
  const project = makeRankedProject();
  try {
    // A world recorded under a previous objective, with a score that would otherwise win outright.
    const foreign = path.join(project.dreamRoot, "trace_pool", "iter0002");
    fs.mkdirSync(foreign, { recursive: true });
    const tree = new DiscoveryTree({ baselineScore: null, branchCount: 1, refineCount: 1 });
    tree.addBranchSlot(0);
    tree.setOutcome("b0a0", { evaluated: true, valid: true, fail_class: "ok", error: null, score: 999, raw_score: 999 });
    writeJson(path.join(foreign, "tree.json"), tree.toJSON());
    writeJson(path.join(foreign, "live_cycle_manifest.json"), {
      iteration: 2,
      status: "complete",
      task_fingerprint: "deadbeef",
    });

    const ranking = rankCandidates({ dreamRoot: project.dreamRoot, task: project.task, projectDir: project.projectDir });
    assert.ok(ranking.candidates.length > 0, "same-contract candidates stay");
    assert.ok(!ranking.candidates.some((candidate) => candidate.iteration === 2), "the foreign world is skipped");
    assert.notEqual(ranking.pending.cell, "b0a1");

    // A direction flip invalidates the same-contract world too: every stored score is now the wrong sign.
    const flipped = normalizeTask({ ...project.task, higher_is_better: false });
    writeTask(project.dreamRoot, flipped);
    const afterFlip = rankCandidates({ dreamRoot: project.dreamRoot, task: flipped, projectDir: project.projectDir });
    assert.deepEqual(afterFlip.candidates, [], "worlds recorded under the opposite direction are excluded");
    assert.equal(afterFlip.pending, null);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("a baseline from another contract is reported as stale instead of used as a reference", () => {
  const project = makeRankedProject();
  try {
    writeJson(path.join(project.dreamRoot, "history", "seed", "score.json"), {
      score: 79,
      raw_score: 79,
      fail_class: "ok",
      error: null,
      measured_at: new Date(0).toISOString(),
      workspace: "seed",
      fingerprint: "deadbeef",
      seconds: 0.1,
    });
    const foreignSeed = { fingerprint: "deadbeef", score: 79, raw_score: 79, fail_class: "ok", error: null, measured_at: "", workspace: "seed", seconds: 0.1 };
    assert.equal(seedMatchesTask(foreignSeed, project.task), false, "a foreign fingerprint never matches");

    const report = improvements(project.dreamRoot, project.task, project.projectDir);
    assert.equal(report.seed, null, "an incomparable baseline is not a reference point");
    assert.equal(report.pending, null);
    assert.match(report.reason, /different scoring configuration/);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("a spawned agent does not inherit the host session identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-env-"));
  const script = path.join(dir, "env-probe.mjs");
  fs.writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync("env.json", JSON.stringify({\n` +
      `  sid: process.env.PI_SESSION_ID ?? null,\n` +
      `  file: process.env.PI_SESSION_FILE ?? null,\n` +
      `  web: process.env.PI_WEB_SESSION ?? null,\n` +
      `  keep: process.env.DREAM_TEST_KEEP ?? null,\n` +
      `}));\n`,
    "utf8",
  );
  const sessionVars = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_WEB_SESSION"];
  const saved = new Map(sessionVars.map((key) => [key, process.env[key]]));
  process.env.PI_SESSION_ID = "parent-session";
  process.env.PI_SESSION_FILE = "/tmp/parent-session.jsonl";
  process.env.PI_WEB_SESSION = "1";
  const agent = { command: "node", args: [script], model: null, thinking: null, prompt_via: "stdin" };
  try {
    const first = await runAgent({ agent, cwd: dir, prompt: "hello", timeoutMs: 10_000 });
    assert.equal(first.ok, true, first.spawnError ?? first.stderrTail);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8")), {
      sid: null,
      file: null,
      web: null,
      keep: null,
    });

    // A task that genuinely needs one can put it back via `agent.env` (task.json's documented escape hatch).
    const withEnv = { ...agent, env: { PI_SESSION_FILE: "explicit" } };
    const second = await runAgent({ agent: withEnv, cwd: dir, prompt: "hello", timeoutMs: 10_000 });
    assert.equal(second.ok, true, second.spawnError ?? second.stderrTail);
    const seen = JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8"));
    assert.equal(seen.file, "explicit");
    assert.equal(seen.sid, null, "stripping is per variable");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
