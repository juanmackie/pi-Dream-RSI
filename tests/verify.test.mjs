/**
 * Independent post-apply verification.
 *
 * The campaign proved its own instrument moved. This check starts from a fresh
 * copy of the resulting tree, runs the declared correctness commands, and
 * measures the same workload again. A promoted change that does not survive it
 * must stop the run rather than become the next baseline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { normalizeRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";
import { readEvaluatorReading, verifyPostApply } from "../extensions/pi-dream-rsi/engine/verify.ts";

test("stdout-json requires a valid evaluator verdict and finite score", () => {
  assert.equal(readEvaluatorReading({ cwd: ".", output: "stdout-json", stdout: '{"valid":true,"score":4,"fail_class":"ok"}' }), 4);
  assert.equal(readEvaluatorReading({ cwd: ".", output: "stdout-json", stdout: '{"valid":false,"score":4}' }), null);
  assert.equal(readEvaluatorReading({ cwd: ".", output: "stdout-json", stdout: '{"valid":true,"score":null}' }), null);
  assert.equal(readEvaluatorReading({ cwd: ".", output: "stdout-json", stdout: '{"valid":true,"score":4,"fail_class":null}' }), null);
});

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

function contract(overrides = {}) {
  return normalizeRunContract({
    version: 1,
    outcome: { statement: "reduce benchmark duration", unit: "ms", higherIsBetter: false, minimumUsefulGain: "20%" },
    preserved: { gates: [] },
    scope: { roots: ["src"], protectedAssets: [] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    models: { providers: ["fixture"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 20, maxEvaluatorRuns: 80, deadlineMs: 120_000, falseAcceptBudget: 0.01 },
    ...overrides,
  });
}

/** Deterministic busy work, so a stubbed reading is not needed to make the workload real. */
const WORK = `export function work(ms) {
  const until = performance.now() + ms;
  let spins = 0;
  while (performance.now() < until) spins += 1;
  return spins;
}
`;
const BENCH = `import { work } from "./src/work.mjs";
if (work(40) <= 0) process.exit(1);
`;
const TEST_OK = `import { work } from "./src/work.mjs";
if (work(1) <= 0) process.exit(1);
`;
const TEST_FAILS = `console.error("behaviour regressed");
process.exit(1);
`;

function fixture({ testScript = TEST_OK } = {}) {
  return project({
    "package.json": `${JSON.stringify({ name: "verify", private: true, type: "module", scripts: { test: "node test.mjs", bench: "node bench.mjs" } }, null, 2)}\n`,
    "bench.mjs": BENCH,
    "test.mjs": testScript,
    "src/work.mjs": WORK,
  });
}

test("a real improvement clears the useful gain against the pre-campaign baseline", async () => {
  const projectDir = fixture();
  const baseline = [520, 530, 540];
  const result = await verifyPostApply({
    projectDir,
    contract: contract(),
    argv: ["node", "bench.mjs"],
    gates: ["npm run test"],
    baseline,
    minimumUsefulGain: "20%",
    unit: "ms",
    higherIsBetter: false,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    measureImpl: async () => 120,
  });

  assert.equal(result.passed, true, result.reason ?? "");
  assert.equal(result.gain, 410, "the gain is measured against the recorded baseline median");
  assert.match(result.detail, /1 gate\(s\) passed/);
  assert.match(result.detail, /workload 530 -> 120 ms/);
});

test("an improvement smaller than the useful gain is not accepted", async () => {
  const projectDir = fixture();
  const result = await verifyPostApply({
    projectDir,
    contract: contract(),
    argv: ["node", "bench.mjs"],
    gates: [],
    baseline: [500, 500, 500],
    minimumUsefulGain: "20%",
    unit: "ms",
    higherIsBetter: false,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    measureImpl: async () => 460,
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /short of the useful gain 100 ms/);
});

test("a regressed correctness gate fails the check before the workload is even measured", async () => {
  const projectDir = fixture({ testScript: TEST_FAILS });
  let measured = false;
  const result = await verifyPostApply({
    projectDir,
    contract: contract(),
    argv: ["node", "bench.mjs"],
    gates: ["npm run test"],
    baseline: [500, 500, 500],
    minimumUsefulGain: "20%",
    unit: "ms",
    higherIsBetter: false,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    measureImpl: async () => { measured = true; return 10; },
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /the applied state fails "npm run test"/);
  assert.equal(measured, false, "a broken gate is decisive; the workload is not consulted");
});

test("a workload that does not complete on the applied state fails the check", async () => {
  const projectDir = fixture();
  const result = await verifyPostApply({
    projectDir,
    contract: contract(),
    argv: ["node", "missing-bench.mjs"],
    gates: [],
    baseline: [500, 500, 500],
    minimumUsefulGain: "20%",
    unit: "ms",
    higherIsBetter: false,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 30_000,
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /did not complete on the applied state/);
});

test("a higher-is-better objective takes the opposite gain direction", async () => {
  const projectDir = fixture();
  const result = await verifyPostApply({
    projectDir,
    contract: contract({ outcome: { statement: "raise the benchmark score", unit: "points", higherIsBetter: true, minimumUsefulGain: "20%" } }),
    argv: ["node", "bench.mjs"],
    gates: [],
    baseline: [100, 100, 100],
    minimumUsefulGain: "20%",
    unit: "points",
    higherIsBetter: true,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    measureImpl: async () => 300,
  });
  assert.equal(result.passed, true, result.reason ?? "");
  assert.equal(result.gain, 200);
});

// ---------------------------------------------------------------------------
// W10: post-apply verification through a declared score evaluator
// ---------------------------------------------------------------------------

function scoreContract(overrides = {}) {
  return contract({
    outcome: { statement: "raise the benchmark accuracy", unit: "points", higherIsBetter: true, minimumUsefulGain: "10%" },
    ...overrides,
  });
}

const SCORE_JSON_EVALUATOR = `import { accuracy } from "../src/model.mjs";
import * as fs from "node:fs";
fs.mkdirSync("eval", { recursive: true });
fs.writeFileSync("eval/score.json", JSON.stringify({ score: accuracy(), raw_score: accuracy(), valid: true, fail_class: "ok", error: null }));
`;
const SCORE_STDOUT_EVALUATOR = `import { accuracy } from "../src/model.mjs";\nconsole.log(String(accuracy()));\n`;

function scoreFixture({ evaluator = SCORE_JSON_EVALUATOR, testScript = TEST_OK } = {}) {
  return project({
    "package.json": `${JSON.stringify({ name: "verify-score", private: true, type: "module", scripts: { test: "node test.mjs", bench: "node bench.mjs" } }, null, 2)}\n`,
    "bench.mjs": 'import { accuracy } from "./src/model.mjs";\nconsole.log(accuracy());\n',
    "test.mjs": testScript,
    "src/model.mjs": "export const accuracy = () => 0.62;\n",
    "eval/score.mjs": evaluator,
  });
}

function scoreExpectation(projectDir, overrides = {}) {
  return {
    projectDir,
    contract: scoreContract(),
    kind: "score",
    evaluator: { argv: ["node", "eval/score.mjs"], output: "score-json" },
    argv: ["node", "bench.mjs"],
    gates: [],
    baseline: [0.5, 0.5, 0.5],
    minimumUsefulGain: "10%",
    unit: "points",
    higherIsBetter: true,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    ...overrides,
  };
}

test("a score-json evaluator measures the applied state in the declared units", async () => {
  const projectDir = scoreFixture();
  const result = await verifyPostApply(scoreExpectation(projectDir));

  assert.equal(result.passed, true, result.reason ?? "");
  assert.ok(Math.abs(result.gain - 0.12) < 1e-9, `expected the gain in points, got ${result.gain}`);
  assert.match(result.detail, /evaluator 0\.5 -> 0\.62 points/);
  assert.match(result.detail, /0 gate\(s\) passed/);
});

test("a stdout-number evaluator is read from the applied state", async () => {
  const projectDir = scoreFixture({ evaluator: SCORE_STDOUT_EVALUATOR });
  const result = await verifyPostApply(scoreExpectation(projectDir, {
    evaluator: { argv: ["node", "eval/score.mjs"], output: "stdout-number" },
  }));

  assert.equal(result.passed, true, result.reason ?? "");
  assert.ok(Math.abs(result.gain - 0.12) < 1e-9);
});

test("a score gain below the useful gain is refused, and a lower-is-better outcome takes the opposite direction", async () => {
  const projectDir = scoreFixture();
  const short = await verifyPostApply(scoreExpectation(projectDir, {
    baseline: [0.6, 0.6, 0.6],
    minimumUsefulGain: "20%",
  }));
  assert.equal(short.passed, false);
  assert.match(short.reason, /short of the useful gain/);

  const lower = await verifyPostApply(scoreExpectation(projectDir, {
    kind: "score",
    evaluator: { argv: ["node", "eval/score.mjs"], output: "score-json" },
    higherIsBetter: false,
    unit: "error rate",
    baseline: [12, 12, 12],
    minimumUsefulGain: "20%",
    evaluateImpl: async () => 9,
  }));
  assert.equal(lower.passed, true, lower.reason ?? "");
  assert.equal(lower.gain, 3, "a minimizing outcome gains before - after");
});

test("the evaluator seam drives the score check without spawning, and records one independent reading", async () => {
  const projectDir = scoreFixture();
  let calls = 0;
  const result = await verifyPostApply(scoreExpectation(projectDir, {
    baseline: [0.4, 0.4],
    evaluateImpl: async (spec, cwd) => {
      calls += 1;
      assert.deepEqual(spec.argv, ["node", "eval/score.mjs"]);
      assert.equal(spec.output, "score-json");
      assert.ok(cwd !== path.resolve(projectDir), "the evaluator runs against a throwaway copy of the applied state");
      assert.equal(fs.existsSync(path.join(cwd, "eval", "score.mjs")), true, "the copy carries the pinned evaluator");
      return 0.62;
    },
  }));
  assert.equal(result.passed, true, result.reason ?? "");
  assert.ok(Math.abs(result.gain - 0.22) < 1e-9);
  assert.equal(calls, 1, "a score reading is one evaluator process, not a duration series");
});

test("a failing correctness gate is decisive before the evaluator runs", async () => {
  const projectDir = scoreFixture({ testScript: TEST_FAILS });
  let evaluated = false;
  const result = await verifyPostApply(scoreExpectation(projectDir, {
    gates: ["npm run test"],
    evaluateImpl: async () => { evaluated = true; return 0.99; },
  }));
  assert.equal(result.passed, false);
  assert.match(result.reason, /the applied state fails "npm run test"/);
  assert.equal(evaluated, false, "the score is not consulted when correctness already failed");
});

test("a score check without the declared evaluator fails closed instead of falling back to wall time", async () => {
  const projectDir = scoreFixture();
  let measured = false;
  const result = await verifyPostApply(scoreExpectation(projectDir, {
    evaluator: undefined,
    measureImpl: async () => { measured = true; return 10; },
  }));
  assert.equal(result.passed, false);
  assert.match(result.reason, /requires the declared evaluator/);
  assert.equal(measured, false);
});

test("the duration path ignores an evaluator: a declared instrument changes nothing about wall-clock checks", async () => {
  const projectDir = fixture();
  const result = await verifyPostApply({
    projectDir,
    contract: contract(),
    kind: "command-duration",
    evaluator: { argv: ["node", "eval/score.mjs"], output: "score-json" },
    argv: ["node", "bench.mjs"],
    gates: [],
    baseline: [500, 500, 500],
    minimumUsefulGain: "20%",
    unit: "ms",
    higherIsBetter: false,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    measureImpl: async () => 100,
    evaluateImpl: async () => { throw new Error("the duration path must not consult a score evaluator"); },
  });
  assert.equal(result.passed, true, result.reason ?? "");
  assert.match(result.detail, /workload 500 -> 100 ms/, "the existing duration detail is unchanged");
});

test("non-duration kinds other than score also measure through their evaluator", async () => {
  const projectDir = scoreFixture();
  const result = await verifyPostApply(scoreExpectation(projectDir, {
    kind: "suite-failures",
    evaluator: { argv: ["node", ".dream-rsi/loop/metrics/id/evaluate.mjs"], output: "score-json" },
    unit: "failures",
    higherIsBetter: false,
    baseline: [9, 9, 9],
    minimumUsefulGain: 4,
    evaluateImpl: async () => 5,
  }));
  assert.equal(result.passed, true, result.reason ?? "");
  assert.equal(result.gain, 4);
  assert.match(result.detail, /failures/);
});

test("the evaluator reading is validated by the declared output form", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-reading-"));
  try {
    fs.mkdirSync(path.join(dir, "eval"), { recursive: true });
    fs.writeFileSync(path.join(dir, "eval", "score.json"), JSON.stringify({ score: 3, valid: true }));
    assert.equal(readEvaluatorReading({ cwd: dir, output: "score-json" }), 3);
    fs.writeFileSync(path.join(dir, "eval", "score.json"), JSON.stringify({ score: 3, valid: false, error: "no" }));
    assert.equal(readEvaluatorReading({ cwd: dir, output: "score-json" }), null, "an invalid verdict is not a score");
    fs.writeFileSync(path.join(dir, "eval", "score.json"), "not json");
    assert.equal(readEvaluatorReading({ cwd: dir, output: "score-json" }), null);
    fs.rmSync(path.join(dir, "eval", "score.json"));
    assert.equal(readEvaluatorReading({ cwd: dir, output: "score-json" }), null, "a missing score file is not a zero");

    assert.equal(readEvaluatorReading({ cwd: dir, output: "stdout-number", stdout: " 42.5 \n" }), 42.5);
    assert.equal(readEvaluatorReading({ cwd: dir, output: "stdout-number", stdout: "" }), null);
    assert.equal(readEvaluatorReading({ cwd: dir, output: "stdout-number", stdout: "1\n2" }), null, "the contract is one number");
    assert.equal(readEvaluatorReading({ cwd: dir, output: "stdout-number", stdout: "Infinity" }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the check runs the gates against a copy and leaves the project untouched", async () => {
  const projectDir = fixture({ testScript: "import { writeFileSync } from \"node:fs\";\nwriteFileSync(\"gate-ran\", \"x\");\n" });
  await verifyPostApply({
    projectDir,
    contract: contract(),
    argv: ["node", "bench.mjs"],
    gates: ["npm run test"],
    baseline: [500, 500, 500],
    minimumUsefulGain: "20%",
    unit: "ms",
    higherIsBetter: false,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    measureImpl: async () => 10,
  });
  assert.equal(fs.existsSync(path.join(projectDir, "gate-ran")), false, "gate side effects stay inside the throwaway copy");
});
