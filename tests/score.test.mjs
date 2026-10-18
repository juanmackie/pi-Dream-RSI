import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { interpretEvaluation, readScoreFile } from "../extensions/pi-dream-rsi/engine/score.ts";
import { defaultTask, normalizeTask } from "../extensions/pi-dream-rsi/engine/task.ts";

const task = normalizeTask(defaultTask());
const ok = { ok: true, code: 0, signal: null, timedOut: false, spawnError: null, durationMs: 1, stdoutTail: "", stderrTail: "", logPath: null };

test("evaluator interpretation normalizes direction and preserves validity", () => {
  assert.deepEqual(interpretEvaluation(task, ok, { score: 3 }), {
    score: 3, raw_score: 3, valid: true, fail_class: "ok", error: null,
  });
  assert.equal(interpretEvaluation({ ...task, higher_is_better: false }, ok, { score: 3 }).score, -3);
  assert.equal(interpretEvaluation(task, ok, { score: 3, valid: false, fail_class: "ok" }).valid, false);
});

test("failed and timed out evaluator commands never accept stale score output", () => {
  assert.deepEqual(interpretEvaluation(task, { ...ok, ok: false, code: 4, stderrTail: "boom" }, { score: 200, valid: true }), {
    score: null, raw_score: null, valid: false, fail_class: "eval_error", error: "evaluator exited with code 4: boom",
  });
  assert.equal(interpretEvaluation(task, { ...ok, timedOut: true }, null).fail_class, "timeout");
  assert.equal(interpretEvaluation(task, { ...ok, spawnError: "missing" }, null).fail_class, "eval_error");
});

test("invalid score fields and evaluator failure classes are reported directly", () => {
  assert.equal(interpretEvaluation(task, ok, null).fail_class, "eval_error");
  assert.equal(interpretEvaluation(task, ok, { score: "not a number" }).fail_class, "invalid_score");
  assert.equal(interpretEvaluation(task, ok, { fail_class: "wrong_answer", error: "bad result" }).error, "bad result");
});

test("score files are read only when they contain a JSON object", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-score-"));
  try {
    fs.mkdirSync(path.dirname(path.join(dir, task.score_path)), { recursive: true });
    fs.writeFileSync(path.join(dir, task.score_path), JSON.stringify({ score: 4, valid: true }), "utf8");
    assert.deepEqual(readScoreFile(dir, task), { score: 4, valid: true });
    fs.writeFileSync(path.join(dir, task.score_path), "not json", "utf8");
    assert.equal(readScoreFile(dir, task), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
