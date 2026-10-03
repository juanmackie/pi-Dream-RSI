/**
 * Behavioral scorer regressions: no model calls, candidate code isolated from the trusted harness.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { POLICY_RELATIVE_PATH, parseArgs, scorePolicy } from "../.auto/score.mjs";
import { createReplayWorlds } from "../.auto/replay-worlds.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const SHIPPED = fs.readFileSync(path.join(REPO, POLICY_RELATIVE_PATH), "utf8");
const IDLE = `
import { LLMDesignedMethod, finalize_result } from "./api.ts";
export class OptimalPolicy extends LLMDesignedMethod {
  default_beta = 0.6;
  async solve(question) { question.reset(); return finalize_result(question); }
}
`;

function candidate(source = SHIPPED) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-scorer-test-"));
  const workspace = path.join(root, "candidate workspace");
  const policy = path.join(workspace, POLICY_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  fs.writeFileSync(policy, source);
  return { root, workspace, policy, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("behavioral scoring distinguishes exploration from idle and derives Eq. 1 from actual probes", async () => {
  const fixture = candidate();
  try {
    const result = await scorePolicy(fixture.workspace);
    assert.equal(result.valid, true, result.error ?? "");
    assert.equal(result.fail_class, "ok");
    assert.equal(result.benchmark_version, 2);
    assert.deepEqual(result.per_world.map((world) => world.id), ["deep", "breadth", "recovery", "plateau"]);
    assert.ok(result.per_world.every((world) => world.ok && world.deterministic));
    const deep = result.per_world[0];
    assert.equal(deep.attainment, 9);
    assert.equal(deep.probes, 6);
    assert.equal(deep.rounds, 3);
    assert.ok(Math.abs(deep.value - (9 - 0.01 * 6 + 0.01 * 6 / 3)) < 1e-10);
    assert.equal(result.score, result.per_world.reduce((sum, world) => sum + world.value, 0) / 4);

    fs.writeFileSync(fixture.policy, IDLE);
    const idle = await scorePolicy(fixture.workspace);
    assert.equal(idle.valid, true, idle.error ?? "");
    assert.equal(idle.score, 0);
    assert.ok(idle.per_world.every((world) => world.probes === 0 && world.attainment === 0));
    assert.ok(result.score > idle.score);
  } finally { fixture.cleanup(); }
});

test("scores repeat across fresh workers and source tokens add no quality points", async () => {
  const fixture = candidate();
  try {
    const first = await scorePolicy(fixture.workspace);
    assert.equal(first.valid, true, first.error ?? "");
    fs.appendFileSync(fixture.policy, "\n// solve() plan_grid default_beta; a comment earns no points.\n");
    const repeat = await scorePolicy(fixture.workspace);
    assert.deepEqual(repeat, first);
  } finally { fixture.cleanup(); }
});

test("candidate copies of scorer, engine and helpers cannot alter the verdict", async () => {
  const fixture = candidate();
  try {
    const first = await scorePolicy(fixture.workspace);
    assert.equal(first.valid, true, first.error ?? "");
    for (const relative of [
      ".auto/score.mjs", ".auto/replay-worlds.mjs",
      "extensions/pi-dream-rsi/engine/replay.ts",
      "extensions/pi-dream-rsi/engine/reward.ts",
      "extensions/pi-dream-rsi/policy/api.ts",
      "extensions/pi-dream-rsi/policy/observation-signal.ts",
    ]) {
      const file = path.join(fixture.workspace, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'throw new Error("candidate harness was imported");\n');
    }
    assert.deepEqual(await scorePolicy(fixture.workspace), first);
    // Evaluation writes only its temporary staging area; the candidate policy stays untouched.
    assert.equal(fs.readFileSync(fixture.policy, "utf8"), SHIPPED);
    assert.equal(fs.existsSync(path.join(fixture.workspace, "eval")), false);
  } finally { fixture.cleanup(); }
});

test("forged policy result numbers never contribute to the score", async () => {
  const fixture = candidate(IDLE.replace("return finalize_result(question);",
    "return { best_score: 99999, probes: 999, rounds: 1, stopped: null, curve: [] };"));
  try {
    const result = await scorePolicy(fixture.workspace);
    assert.equal(result.valid, true, result.error ?? "");
    assert.equal(result.score, 0);
    assert.ok(result.per_world.every((world) => world.probes === 0));
  } finally { fixture.cleanup(); }
});

test("syntax, guardrail, grid and illegal-batch failures invalidate the entire evaluation", async () => {
  const sources = [
    "export class OptimalPolicy extends {",
    IDLE + '\nimport * as fs from "node:fs";\n',
    IDLE.replace("default_beta = 0.6;", "default_beta = 0.6; plan_grid() { return { branch_count: NaN, refine_count: 2 }; }"),
    IDLE.replace("return finalize_result(question);", 'await question.probe_batch(["b0a0", "b0a0"]); return finalize_result(question);'),
    // The first world passes; failure on the breadth world must discard the earlier quality.
    IDLE.replace("return finalize_result(question);",
      'if (question.legal_roots().length > 2) throw new Error("breadth failure"); await question.probe_batch(question.legal_roots()); return finalize_result(question);'),
  ];
  for (const source of sources) {
    const fixture = candidate(source);
    try {
      const result = await scorePolicy(fixture.workspace);
      assert.equal(result.valid, false);
      assert.equal(result.score, 0);
      assert.notEqual(result.fail_class, "ok");
      assert.equal(typeof result.error, "string");
    } finally { fixture.cleanup(); }
  }
});

test("hanging policies are terminated and nondeterministic traces cannot score", async () => {
  const hanging = candidate(IDLE.replace("return finalize_result(question);", "while (true) {}"));
  try {
    const result = await scorePolicy(hanging.workspace, { timeoutMs: 1_000 });
    assert.equal(result.valid, false);
    assert.equal(result.fail_class, "timeout", result.error ?? "");
  } finally { hanging.cleanup(); }

  const random = candidate(IDLE.replace("return finalize_result(question);", `
    await question.probe_batch(["b0a0"]);
    // Hidden state in the host-recorded trace must fail the independent-worker check.
    question.decisions[0].best_after = Math.random();
    return finalize_result(question);
  `));
  try {
    const result = await scorePolicy(random.workspace);
    assert.equal(result.valid, false);
    assert.equal(result.fail_class, "non_deterministic", result.error ?? "");
    assert.equal(result.score, 0);
  } finally { random.cleanup(); }
});

test("benchmark worlds are fresh and retain a repairable failure followed by success", () => {
  const worlds = createReplayWorlds();
  const recovery = worlds.find((world) => world.id === "recovery").world;
  assert.equal(recovery.get("b0a0").fail_class, "eval_error");
  assert.equal(recovery.get("b0a1").score, 3);
  recovery.setOutcome("b0a1", { score: 999 });
  assert.equal(createReplayWorlds().find((world) => world.id === "recovery").world.get("b0a1").score, 3);
});

test("versioned CLI runs from another cwd and replaces stale verdicts", () => {
  const fixture = candidate(IDLE);
  try {
    const scorer = path.join(REPO, ".auto", "score.mjs");
    const out = path.join(fixture.workspace, "eval", "score.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ score: 130, valid: true, fail_class: "ok" }));
    const run = spawnSync(process.execPath, [scorer, fixture.workspace, "--benchmark-version=2"], {
      cwd: fixture.root, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(result.score, 0);
    assert.equal(result.valid, true);
    assert.equal(result.benchmark_version, 2);
    const wrongVersion = spawnSync(process.execPath, [scorer, fixture.workspace, "--benchmark-version=1"], {
      cwd: fixture.root, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(wrongVersion.status, 0, wrongVersion.stderr);
    assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).valid, false);
    assert.equal(parseArgs(["--benchmark-version=2", fixture.workspace]), fixture.workspace);
    assert.throws(() => parseArgs(["--benchmark-version=1"]), /expected/);
  } finally { fixture.cleanup(); }
});

test("Python wrapper uses its own scorer location and writes fresh crash/timeout verdicts", () => {
  const fixture = candidate(IDLE);
  const python = process.platform === "win32" ? "python" : "python3";
  try {
    const wrapper = path.join(REPO, ".auto", "score.py");
    const out = path.join(fixture.workspace, "eval", "score.json");
    const run = spawnSync(python, [wrapper, fixture.workspace, "--benchmark-version=2"], {
      cwd: fixture.root, encoding: "utf8", timeout: 35_000,
    });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).score, 0);

    const script = `
import importlib.util, pathlib, subprocess, sys
from unittest.mock import patch
sys.argv = [sys.argv[1], sys.argv[2], "--benchmark-version=2"]
spec = importlib.util.spec_from_file_location("replay_scorer", sys.argv[0])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for error in [OSError("node unavailable"), subprocess.TimeoutExpired("node", 30)]:
    module.output.write_text('{"score": 130, "valid": true}', encoding="utf-8")
    with patch.object(module.subprocess, "run", side_effect=error):
        assert module.main() == 1
    data = module.json.loads(module.output.read_text(encoding="utf-8"))
    assert data["valid"] is False and data["fail_class"] == "scorer_crash"
    assert data["score"] == 0 and data["benchmark_version"] == 2
`;
    const failures = spawnSync(python, ["-c", script, wrapper, fixture.workspace], {
      cwd: fixture.root, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(failures.status, 0, failures.stderr || failures.error?.message);
  } finally { fixture.cleanup(); }
});
