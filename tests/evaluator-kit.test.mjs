import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { measure, parseArgs } from "../evaluators/measure.mjs";
import { loadFixtures } from "../eval/tier2.mjs";

test("generic measurement supports warmup, repeats, median, samples, and score output", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-measure-"));
  try {
    assert.equal(measure(["--mode=stdout-number", "--warmup=1", "--repeats=3", "--", process.execPath, "-e", "process.stdout.write('7')"], cwd), 0);
    const score = JSON.parse(fs.readFileSync(path.join(cwd, "eval/score.json"), "utf8"));
    assert.equal(score.score, 7);
    assert.deepEqual(score.samples, [7, 7, 7]);
    assert.equal(score.valid, true);
    assert.equal(score.repeats, 3);
    assert.equal(parseArgs(["--mode=elapsed", "--", process.execPath, "-e", ""]).options.mode, "elapsed");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("measurement errors replace stale scores with an invalid verdict", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-measure-error-"));
  try {
    fs.mkdirSync(path.join(cwd, "eval"));
    fs.writeFileSync(path.join(cwd, "eval/score.json"), '{"score":99,"valid":true}');
    assert.equal(measure(["--mode=stdout-number", "--warmup=0", "--repeats=1", "--", process.execPath, "-e", "process.stdout.write('nope')"], cwd), 1);
    const score = JSON.parse(fs.readFileSync(path.join(cwd, "eval/score.json"), "utf8"));
    assert.equal(score.valid, false);
    assert.equal(score.fail_class, "invalid_output");
    assert.equal(score.score, 0);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("numeric stdout rejects empty output instead of coercing it to zero", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-measure-empty-"));
  try {
    assert.equal(measure(["--mode=stdout-number", "--warmup=0", "--repeats=1", "--", process.execPath, "-e", ""], cwd), 1);
    const score = JSON.parse(fs.readFileSync(path.join(cwd, "eval/score.json"), "utf8"));
    assert.equal(score.valid, false);
    assert.equal(score.fail_class, "invalid_output");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("measurement timeout must fit spawnSync's supported integer range", () => {
  assert.throws(() => parseArgs(["--timeout=2147483648", "--", process.execPath, "-e", ""]), /integer from 1 to 2147483647/);
  assert.throws(() => parseArgs(["--timeout=1.5", "--", process.execPath, "-e", ""]), /integer from 1 to 2147483647/);
  assert.equal(parseArgs(["--timeout=2147483647", "--", process.execPath, "-e", ""]).options.timeout, 2147483647);
});

test("Tier 2 repositories have a known baseline and a control patch that improves the metric and passes held-out gates", async (t) => {
  // Awaiting each subtest keeps the parent alive until they finish. A synchronous
  // parent that merely registers them can complete first, and the runner then
  // cancels the stragglers as `cancelledByParent` on slower machines.
  for (const fixture of loadFixtures()) await t.test(fixture.name, () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), `dream-rsi-${fixture.name}-`));
    try {
      fs.cpSync(fixture.root, project, { recursive: true });
      const workspace = path.join(project, fixture.manifest.workspace);
      const run = (script) => {
        const command = fixture.manifest.interpreter === "node" ? "node" : process.platform === "win32" ? "python" : "python3";
        return spawnSync(command, [path.join(project, script)], { cwd: workspace, encoding: "utf8", timeout: 30_000, windowsHide: true });
      };
      const readScore = () => JSON.parse(fs.readFileSync(path.join(workspace, "eval", "score.json"), "utf8"));
      const baselineScoreRun = run(fixture.manifest.evaluator);
      assert.equal(baselineScoreRun.status, 0, baselineScoreRun.stderr);
      const baseline = readScore();
      assert.equal(baseline.valid, true);
      const baselineGate = run(fixture.manifest.gate);
      assert.equal(baselineGate.status === 0, fixture.manifest.baseline_gate_passes, baselineGate.stderr);
      const apply = spawnSync("git", ["apply", `--directory=${fixture.manifest.workspace}`, path.join(project, fixture.manifest.control_patch)], {
        cwd: project, encoding: "utf8", timeout: 10_000, windowsHide: true,
      });
      assert.equal(apply.status, 0, apply.stderr);
      const controlScoreRun = run(fixture.manifest.evaluator);
      assert.equal(controlScoreRun.status, 0, controlScoreRun.stderr);
      const control = readScore();
      assert.equal(control.valid, true);
      assert.ok(fixture.manifest.direction === "maximize" ? control.score > baseline.score : control.score < baseline.score,
        `control score ${control.score} should improve on baseline ${baseline.score}`);
      const controlGate = run(fixture.manifest.gate);
      assert.equal(controlGate.status, 0, controlGate.stderr);
      if (fixture.name === "query-parser") assert.equal(typeof control.output_bytes, "number", "size remains an observable auxiliary measurement");
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
  });
});
