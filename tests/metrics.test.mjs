import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { commandForHead, synthesizeMetric } from "../extensions/pi-dream-rsi/engine/metrics.ts";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-metrics-"));
}

/** Minimal lever proposal: only the fields metrics.ts consumes. */
function lever(overrides) {
  return {
    id: "abc123abc123",
    sourceKind: "session-failure",
    goal: "Make the command pass.",
    mechanism: "test fixture",
    metric: "failures (lower is better)",
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

function writeControlPatch(projectDir) {
  const file = path.join(projectDir, "control.patch");
  fs.writeFileSync(file, "diff --git a/FIXED b/FIXED\nnew file mode 100644\n--- /dev/null\n+++ b/FIXED\n@@ -0,0 +1 @@\n+1\n");
  return file;
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
      controlPatchPath: writeControlPatch(projectDir),
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
    fs.writeFileSync(slow, `const start = Date.now();\nwhile (Date.now() - start < 250) { /* busy */ }\n`);
    const plan = await synthesizeMetric({
      projectDir,
      lever: lever({ metricKind: "command-duration", metric: "duration (ms, lower is better)", estimates: { expectedGain: 1, costSeconds: 1, confidence: 0.5, readiness: 0.9 } }),
      controlPatchPath: writeControlPatch(projectDir),
      commandOverrides: { "npm test": [process.execPath, slow] },
    });
    assert.equal(plan.ready, true, plan.rejections.join("; "));
    assert.equal(plan.unit, "ms");

    const slowScore = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(slowScore.valid, true);
    assert.ok(slowScore.score >= 200 && slowScore.score < 5_000, `duration score ${slowScore.score} ms`);
    assert.equal(slowScore.samples.length, 3, "warmup is excluded from the reported samples");

    fs.writeFileSync(slow, `const start = Date.now();\nwhile (Date.now() - start < 30) { /* busy */ }\n`);
    const fastScore = runEvaluator(projectDir, plan.evaluatorPath);
    assert.ok(fastScore.score < slowScore.score, `faster variant ${fastScore.score} ms < ${slowScore.score} ms`);

    fs.writeFileSync(slow, `process.exit(2);\n`);
    const broken = runEvaluator(projectDir, plan.evaluatorPath);
    assert.equal(broken.valid, false, "a duration metric cannot be scored on a command that fails");
    assert.equal(broken.fail_class, "command_failed");
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

test("missing, absent, or empty control patches reject the lever, and unmeasurable levers never synthesize", async () => {
  const projectDir = tempDir();
  try {
    fs.writeFileSync(path.join(projectDir, "package.json"), "{}");
    const noControl = await synthesizeMetric({ projectDir, lever: lever({}) });
    assert.equal(noControl.ready, false);
    assert.ok(noControl.rejections.some((line) => /no known-better control patch/.test(line)));

    const missingControl = await synthesizeMetric({ projectDir, lever: lever({}), controlPatchPath: "nowhere.patch" });
    assert.equal(missingControl.ready, false);
    assert.ok(missingControl.rejections.some((line) => /not found/.test(line)));

    const emptyControl = path.join(projectDir, "empty.patch");
    fs.writeFileSync(emptyControl, "\n");
    const empty = await synthesizeMetric({ projectDir, lever: lever({}), controlPatchPath: emptyControl });
    assert.equal(empty.ready, false);
    assert.ok(empty.rejections.some((line) => /empty/.test(line)));

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
      controlPatchPath: writeControlPatch(projectDir),
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
      controlPatchPath: writeControlPatch(projectDir),
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
      controlPatchPath: writeControlPatch(projectDir),
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
