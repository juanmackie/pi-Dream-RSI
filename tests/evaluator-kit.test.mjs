import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { measure, parseArgs } from "../evaluators/measure.mjs";

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
