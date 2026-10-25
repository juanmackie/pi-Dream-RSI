import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { commandForHead, removeScratchDirectory, synthesizeMetric } from "../extensions/pi-dream-rsi/engine/metrics.ts";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-metrics-"));
}

test("scratch cleanup retries transient Windows locks without losing a valid measurement", async () => {
  const root = tempDir();
  const scratch = path.join(root, "qualify-transient-lock");
  fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(scratch, "measurement.json"), JSON.stringify({ valid: true, score: 0.875 }));
  const measured = JSON.parse(fs.readFileSync(path.join(scratch, "measurement.json"), "utf8"));
  let attempts = 0;
  try {
    await removeScratchDirectory(scratch, (target, options) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("temporarily locked");
        error.code = "EBUSY";
        throw error;
      }
      fs.rmSync(target, options);
    });
    assert.equal(attempts, 2, "cleanup retries the transient lock once");
    assert.equal(fs.existsSync(scratch), false, "the scratch copy is removed after retry");
    assert.deepEqual(measured, { valid: true, score: 0.875 }, "the already-valid evaluator result remains usable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scratch cleanup reports the retained path after persistent lock errors", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-retained-scratch-"));
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    await removeScratchDirectory(scratch, () => {
      const error = new Error("still locked");
      error.code = "EPERM";
      throw error;
    });
    assert.equal(fs.existsSync(scratch), true, "cleanup leaves the locked directory for later removal");
    assert.equal(errors.length, 1, "persistent cleanup failure is reported once");
    assert.ok(errors[0].includes(scratch), "the warning identifies the retained scratch directory");
    assert.match(errors[0], /manually/);
  } finally {
    console.error = originalError;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

/** Minimal lever proposal: only the fields metrics.ts consumes. */
function lever(overrides) {
  return {
    id: "abc123abc123",
    sourceKind: "session-failure",
    goal: "Make the command pass.",
    mechanism: "test fixture",
    metric: '"npm test" failure count (failures, lower is better)',
    metricKind: "command-success",
    scopeFiles: [],
    gates: [],
    estimates: { expectedGain: 0.5, costSeconds: 30, confidence: 0.5, readiness: 0.9 },
    score: 0.1,
    evidence: [{ source: "session", ref: "npm test", count: 3 }],
    reasons: [],
    ...overrides,
  };
}

function runEvaluator(projectDir, evaluatorPath) {
  const result = spawnSync(process.execPath, [path.join(projectDir, evaluatorPath)], { cwd: projectDir, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(path.join(projectDir, "eval", "score.json"), "utf8"));
}

test("failure-count evaluator measures the real command, with and without the fix as controls", async () => {
  const projectDir = tempDir();
  try {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "node check.mjs" } }));
    const check = path.join(projectDir, "check.mjs");
    fs.writeFileSync(check, `import * as fs from "node:fs";\nprocess.exit(fs.existsSync("FIXED") ? 0 : 1);\n`);
    const plan = await synthesizeMetric({
      projectDir,
      lever: lever({ estimator: undefined, estimates: { expectedGain: 0.5, costSeconds: 30, confidence: 0.5, readiness: 0.9 } }),
      commandOverrides: { "npm test": [process.execPath, check] },
    });
    assert.equal(plan.ready, true, plan.rejections.join("; "));
    assert.match(plan.evaluatorPath, /^\.dream-rsi\/loop\/metrics\/abc123abc123\/evaluate\.mjs$/);
    assert.equal(plan.unit, "failures");
    assert.equal(plan.higherIsBetter, false);
    assert.deepEqual(plan.argv, [process.execPath, check]);

    const unfixed = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(unfixed.valid, true);
    assert.equal(unfixed.score, 3, "every repeat fails before the fix (negative control)");
    assert.deepEqual(unfixed.samples, [1, 1, 1]);

    fs.writeFileSync(path.join(projectDir, "FIXED"), "1\n");
    const fixed = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(fixed.valid, true);
    assert.equal(fixed.score, 0, "the same evaluator scores zero failures once the fix exists (positive control)");
    assert.ok(fixed.score < unfixed.score, "improvement is visible to the evaluator");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("duration evaluator reports median wall-clock, detects a faster variant, and fails closed on a broken command", async () => {
  const projectDir = tempDir();
  try {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "node slow.mjs" } }));
    const slow = path.join(projectDir, "slow.mjs");
    fs.writeFileSync(slow, `const start = Date.now();\nwhile (Date.now() - start < 1000) { /* busy */ }\n`);
    const plan = await synthesizeMetric({
      projectDir,
      lever: lever({ metricKind: "command-duration", metric: "duration (ms, lower is better)", estimates: { expectedGain: 1, costSeconds: 1, confidence: 0.5, readiness: 0.9 } }),
      commandOverrides: { "npm test": [process.execPath, slow] },
    });
    assert.equal(plan.ready, true, plan.rejections.join("; "));
    assert.equal(plan.unit, "ms");

    const slowScore = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(slowScore.valid, true);
    assert.ok(slowScore.score >= 200 && slowScore.score < 5_000, `duration score ${slowScore.score} ms`);
    assert.equal(slowScore.samples.length, 3, "warmup is excluded from the reported samples");

    fs.writeFileSync(slow, `const start = Date.now();\nwhile (Date.now() - start < 5) { /* busy */ }\n`);
    const fastScore = runEvaluator(projectDir, plan.evaluatorPath);
    assert.ok(fastScore.score < slowScore.score, `faster variant ${fastScore.score} ms < ${slowScore.score} ms`);

    fs.writeFileSync(slow, `process.exit(2);\n`);
    const broken = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(broken.valid, false, "a duration metric cannot be scored on a command that fails");
    assert.equal(broken.fail_class, "command_failed");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

function writeScoreEvaluator(projectDir, body) {
  const target = path.join(projectDir, "eval", "score.mjs");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return target;
}

function scoreLever(overrides = {}) {
  return lever({
    metricKind: "score",
    sourceKind: "recon-command",
    metric: "raise benchmark accuracy (points, higher is better)",
    evidence: [{ source: "evaluator", ref: "contract.outcome.evaluator", count: 1 }],
    ...overrides,
  });
}

function scoreSpec(overrides = {}) {
  return {
    argv: ["node", "eval/score.mjs"],
    output: "score-json",
    inputs: ["eval/score.mjs"],
    unit: "points",
    higherIsBetter: true,
    ...overrides,
  };
}

const SCORE_JSON_WRITER = (score) => `import * as fs from "node:fs";
fs.mkdirSync("eval", { recursive: true });
fs.writeFileSync("eval/score.json", JSON.stringify({ score: ${score}, raw_score: ${score}, valid: true, fail_class: "ok", error: null }));
`;

test("the score metric template runs the declared evaluator and reads eval/score.json", async () => {
  const projectDir = tempDir();
  try {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ private: true }));
    writeScoreEvaluator(projectDir, SCORE_JSON_WRITER("0.75"));
    const plan = await synthesizeMetric({
      projectDir,
      lever: scoreLever(),
      scoreEvaluator: scoreSpec(),
    });
    assert.equal(plan.ready, true, plan.rejections.join("; "));
    assert.equal(plan.metricKind, "score", "the declared score evaluator selects the score template");
    assert.equal(plan.unit, "points", "the unit comes from the approved outcome, not a synthesized default");
    assert.equal(plan.higherIsBetter, true);
    assert.equal(plan.direction, "maximize");
    assert.deepEqual(plan.argv, ["node", "eval/score.mjs"], "the declared evaluator argv is measured verbatim");
    assert.deepEqual(plan.evaluatorInputs, ["eval/score.mjs"], "evaluator code is pinned as a verifier input");
    assert.equal(plan.evaluatorOutput, "score-json");
    assert.ok(plan.sampleTimeoutMs >= 30_000);
    assert.ok(plan.notes.some((note) => /score evaluator/.test(note)), "the plan explains the score instrument");

    const reading = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(reading.valid, true, reading.error ?? "");
    assert.equal(reading.score, 0.75, "the score is the declared evaluator's number, not wall time");
    assert.equal(reading.mode, "score");
    assert.deepEqual(reading.samples, [0.75], "one repeat and no warmup for a score metric");

    writeScoreEvaluator(projectDir, SCORE_JSON_WRITER("0.5"));
    const changed = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(changed.valid, true);
    assert.equal(changed.score, 0.5, "the same instrument observes a different score without re-synthesis");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("the score metric template reads a single number on stdout and fails closed on anything else", async () => {
  const projectDir = tempDir();
  try {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ private: true }));
    writeScoreEvaluator(projectDir, `console.log("0.8125");\n`);
    const plan = await synthesizeMetric({
      projectDir,
      lever: scoreLever(),
      scoreEvaluator: scoreSpec({ output: "stdout-number", higherIsBetter: false, unit: "error rate" }),
    });
    assert.equal(plan.ready, true, plan.rejections.join("; "));
    assert.equal(plan.direction, "minimize", "the direction comes from the approved outcome");
    assert.equal(plan.evaluatorOutput, "stdout-number");

    const reading = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(reading.valid, true, reading.error ?? "");
    assert.equal(reading.score, 0.8125, "a single numeric stdout is the score");
    assert.equal(reading.unit, "error rate");

    writeScoreEvaluator(projectDir, `console.log("not a number");\n`);
    const malformed = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(malformed.valid, false, "text on stdout is not a score");
    assert.equal(malformed.fail_class, "invalid_output");

    writeScoreEvaluator(projectDir, `console.log("0.5");\nconsole.log("0.6");\n`);
    const ambiguous = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(ambiguous.valid, false, "the declared contract is one number, not a series");
    assert.equal(ambiguous.fail_class, "invalid_output");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("a declared evaluator that fails or reports itself invalid cannot produce a score", async () => {
  const projectDir = tempDir();
  try {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ private: true }));
    writeScoreEvaluator(projectDir, `process.exit(2);\n`);
    const plan = await synthesizeMetric({
      projectDir,
      lever: scoreLever(),
      scoreEvaluator: scoreSpec(),
    });
    assert.equal(plan.ready, true, plan.rejections.join("; "));

    const failed = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(failed.valid, false, "a crashing evaluator is not a zero score");
    assert.equal(failed.fail_class, "evaluator_error");

    writeScoreEvaluator(projectDir, `import * as fs from "node:fs";
fs.mkdirSync("eval", { recursive: true });
fs.writeFileSync("eval/score.json", JSON.stringify({ score: 0, valid: false, fail_class: "invalid_output", error: "model did not run" }));
`);
    const refused = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(refused.valid, false, "the evaluator's own validity verdict is honoured");
    assert.match(refused.error ?? "", /model did not run/);

    writeScoreEvaluator(projectDir, `import * as fs from "node:fs";\nfs.writeFileSync("eval/score.json", "{not json");\n`);
    const unreadable = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(unreadable.valid, false);
    assert.equal(unreadable.fail_class, "invalid_output");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("a score lever without the contract's declared evaluator is refused, not guessed", async () => {
  const projectDir = tempDir();
  try {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ private: true }));
    const plan = await synthesizeMetric({
      projectDir,
      lever: scoreLever(),
    });
    assert.equal(plan.ready, false);
    assert.equal(plan.metricKind, "score");
    assert.match(plan.rejections.join("; "), /score metric kind requires the contract's declared outcome\.evaluator/);
    assert.equal(plan.evaluatorPath, "", "no evaluator is written when the score instrument is undefined");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("runner resolution follows standard lockfile evidence and nothing else", () => {
  const projectDir = tempDir();
  try {
    assert.deepEqual(commandForHead("npm test", projectDir), ["npm", "test"]);
    fs.writeFileSync(path.join(projectDir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    assert.deepEqual(commandForHead("npm test", projectDir), ["pnpm", "test"]);
    fs.rmSync(path.join(projectDir, "pnpm-lock.yaml"));
    fs.writeFileSync(path.join(projectDir, "bun.lockb"), "");
    assert.deepEqual(commandForHead("npm test", projectDir), ["bun", "test"]);
    fs.rmSync(path.join(projectDir, "bun.lockb"));
    fs.writeFileSync(path.join(projectDir, "yarn.lock"), "");
    assert.deepEqual(commandForHead("npm test", projectDir), ["yarn", "test"]);
    assert.deepEqual(commandForHead("pytest", projectDir), process.platform === "win32" ? ["python", "-m", "pytest"] : ["python3", "-m", "pytest"]);
    assert.deepEqual(commandForHead("go test", projectDir), ["go", "test", "./..."]);
    assert.equal(commandForHead("node", projectDir), null, "generic heads stay unreconstructible");
    assert.equal(commandForHead("git", projectDir), null);
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("unmeasurable levers never synthesize an evaluator", async () => {
  const projectDir = tempDir();
  try {
    fs.writeFileSync(path.join(projectDir, "package.json"), "{}");
    const unmeasurable = await synthesizeMetric({ projectDir, lever: lever({ metricKind: "unmeasurable" }) });
    assert.equal(unmeasurable.ready, false);
    assert.ok(unmeasurable.rejections.some((line) => /no measurable metric kind/.test(line)));
    assert.equal(unmeasurable.evaluatorPath, "", "no evaluator is written without a measurable metric");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("the generated evaluator spawns the real platform runner resolved from the canonical head", async () => {
  const projectDir = tempDir();
  try {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ private: true, scripts: { test: "node check.mjs" } }));
    fs.writeFileSync(path.join(projectDir, "check.mjs"), `import * as fs from "node:fs";\nprocess.exit(fs.existsSync("FIXED") ? 0 : 1);\n`);
    const plan = await synthesizeMetric({
      projectDir,
      lever: lever({
        sourceKind: "post-failure-edits",
        metricKind: "suite-failures",
        evidence: [{ source: "session", ref: "src/parser.ts", count: 2 }],
        gates: ["npm test"],
      }),
    });
    assert.equal(plan.ready, true, plan.rejections.join("; "));
    assert.deepEqual(plan.argv, ["npm", "test"], "the canonical head resolves to the platform runner without overrides");

    const unfixed = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(unfixed.valid, true, `the platform runner must spawn (fail_class ${unfixed.fail_class}: ${unfixed.error ?? "no error"})`);
    assert.equal(unfixed.score, 3, "every repeat fails before the fix (negative control)");

    fs.writeFileSync(path.join(projectDir, "FIXED"), "1\n");
    const fixed = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(fixed.valid, true);
    assert.equal(fixed.score, 0, "the same generated evaluator sees the fix (positive control)");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("suite levers take their command from the declared gate, not from file scopes", async () => {
  const projectDir = tempDir();
  try {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "node check.mjs" } }));
    const check = path.join(projectDir, "check.mjs");
    fs.writeFileSync(check, "process.exit(0);\n");
    const plan = await synthesizeMetric({
      projectDir,
      lever: lever({
        sourceKind: "post-failure-edits",
        metricKind: "suite-failures",
        evidence: [{ source: "session", ref: "src/parser.ts", count: 2 }],
        gates: ["npm test"],
      }),
      commandOverrides: { "npm test": [process.execPath, check] },
    });
    assert.equal(plan.ready, true, plan.rejections.join("; "));
    assert.equal(plan.headCommand, "npm test");
    assert.deepEqual(plan.argv, [process.execPath, check]);
    assert.deepEqual(plan.gates, [], "the metric command is excluded from gates for failure-count metrics");
    assert.ok(plan.notes.some((line) => /is the metric command itself/.test(line)));
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("the Windows shim path refuses arguments the command interpreter could reinterpret", { skip: process.platform !== "win32" }, async () => {
  const projectDir = tempDir();
  try {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ private: true, scripts: { test: "node -e 0" } }));
    const plan = await synthesizeMetric({
      projectDir,
      lever: lever({}),
      commandOverrides: { "npm test": ["npm", "test", "&", "node", "marker.mjs"] },
    });
    assert.equal(plan.ready, true, plan.rejections.join("; "));
    assert.deepEqual(plan.argv, ["npm", "test", "&", "node", "marker.mjs"]);

    const blocked = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(blocked.valid, false, "an unsafe shim command is never scored");
    assert.equal(blocked.fail_class, "spawn_error");
    assert.match(blocked.error, /not safe for the Windows command interpreter/);
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});
