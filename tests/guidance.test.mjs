/**
 * Opt-in direction guidance (experiment 2-b): deterministic, bounded,
 * prompt-only summary of evaluated history. No LLM involved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDirectionGuidance, diagnoseTimeout, GUIDANCE_MAX_CHARS } from "../extensions/pi-dream-rsi/engine/guidance.ts";
import { renderHandoffSummary, HANDOFF_MAX_CHARS, HANDOFF_MAX_RUN_ENTRIES } from "../extensions/pi-dream-rsi/engine/handoff.ts";
import {
  defaultTask,
  normalizeTask,
  scoringFingerprint,
  validateTask,
} from "../extensions/pi-dream-rsi/engine/task.ts";

function node(cell_id, { evaluated = true, score = 1, fail_class = "ok", error = null, duration_ms = 5 } = {}) {
  return {
    meta: { cell_id, branch: 0, attempt: 0, parent_id: null, seq: 0, tags: [] },
    evaluated,
    valid: true,
    fail_class,
    error,
    score,
    raw_score: score,
    workspace: `work/r0001/${cell_id}`,
    proposal: `history/r0001_live/attempt_${cell_id}/proposal.md`,
    artifacts: [],
    duration_ms,
  };
}

test("guidance defaults off and validates strictly", () => {
  assert.equal(defaultTask("t").guidance, "off");
  assert.deepEqual(validateTask({ ...defaultTask("t") }), []);
  assert.deepEqual(validateTask({ ...defaultTask("t"), guidance: "summary" }), []);
  assert.match(validateTask({ ...defaultTask("t"), guidance: "bogus" }).join("\n"), /guidance/);
  assert.equal(normalizeTask({ name: "t" }).guidance, "off");
});

test("guidance flag is prompt-only: excluded from the scoring fingerprint", () => {
  const a = normalizeTask({ name: "t" });
  const b = normalizeTask({ name: "t", guidance: "summary" });
  assert.equal(scoringFingerprint(a), scoringFingerprint(b));
});

test("empty history renders a short explore-broadly note", () => {
  const out = renderDirectionGuidance([]);
  assert.ok(out.length > 0 && out.length < 200);
  assert.match(out, /no evaluated attempts/i);
});

test("summary is deterministic and cell-ordered", () => {
  const cells = [node("b1a1", { score: 3 }), node("b0a0", { score: 9 }), node("b0a1", { score: 5 })];
  const a = renderDirectionGuidance(cells);
  const b = renderDirectionGuidance([...cells].reverse());
  assert.equal(a, b);
  const ids = [...a.matchAll(/- (b\da\d+)/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["b0a0", "b0a1", "b1a1"]);
  assert.match(a, /best score 9 \(b0a0\)/);
});

test("failures are marked repairable and successes keep scores", () => {
  const out = renderDirectionGuidance([
    node("b0a0", { score: 4 }),
    node("b0a1", { score: null, fail_class: "timeout", error: "timed out", duration_ms: 12300 }),
  ]);
  assert.match(out, /1 repairable failure/);
  // Unrecognized legacy timeout: neutral wording with attempt duration, no silence claim.
  assert.match(out, /b0a1 timeout: did not finish \(attempt took 12\.3s\)/);
  assert.match(out, /best score 4 \(b0a0\)/);
});

test("recognizable silent and output-producing agent timeouts render differently", () => {
  const silent = renderDirectionGuidance([
    node("b1a0", { score: null, fail_class: "timeout", error: "discovery agent timed out after 480s with no output at all (empty agent.log)", duration_ms: 999999 }),
  ]);
  const withOutput = renderDirectionGuidance([
    node("b0a1", { score: null, fail_class: "timeout", error: "discovery agent timed out after 480s with output (see agent.log)", duration_ms: 999999 }),
  ]);
  assert.match(silent, /b1a0 timeout: agent produced no output during 480s/);
  assert.match(withOutput, /b0a1 timeout: agent ran 480s with output but did not finish/);
  assert.notEqual(silent, withOutput);
  // Agent runtime comes from the error, never from node duration_ms.
  assert.doesNotMatch(silent, /999999/);
  assert.doesNotMatch(withOutput, /999999/);
});

test("evaluator timeouts are not described as silent agents", () => {
  assert.deepEqual(diagnoseTimeout("evaluator timed out", "timeout").kind, "evaluator");
  const out = renderDirectionGuidance([
    node("b0a0", { score: null, fail_class: "timeout", error: "evaluator timed out", duration_ms: 5000 }),
  ]);
  assert.match(out, /b0a0 failed \/ timeout/);
  assert.doesNotMatch(out, /no output/);
  assert.doesNotMatch(out, /agent ran/);
  assert.doesNotMatch(out, /agent produced/);
});

test("unknown legacy diagnostics remain neutral and never claim silence", () => {
  assert.deepEqual(diagnoseTimeout("timed out", "timeout").kind, "agent-unknown");
  assert.deepEqual(diagnoseTimeout("discovery agent timed out after 480s", "timeout").kind, "agent-unknown");
  assert.deepEqual(diagnoseTimeout(null, "timeout").kind, "agent-unknown");
  assert.deepEqual(diagnoseTimeout("discovery agent timed out after 1.5s with no output at all (empty agent.log)", "timeout"), {
    kind: "agent-silent",
    durationSeconds: 1.5,
  });
  assert.deepEqual(diagnoseTimeout("discovery agent timed out after 480s with output (see agent.log)", "timeout"), {
    kind: "agent-with-output",
    durationSeconds: 480,
  });
  assert.deepEqual(diagnoseTimeout("ok", "ok").kind, "not-timeout");
  const out = renderDirectionGuidance([
    node("b0a0", { score: null, fail_class: "timeout", error: "discovery agent timed out after 480s", duration_ms: 480000 }),
  ]);
  // Recognizable duration but missing output marking: neutral, uses attempt duration wording.
  assert.match(out, /b0a0 timeout: did not finish \(attempt took 480s\)/);
  assert.doesNotMatch(out, /no output/);
  assert.doesNotMatch(out, /with output/);
});

test("timeout diagnostics preserve ordering, truncation and success counts", () => {
  const cells = [
    node("b0a0", { score: 9 }),
    node("b0a1", { score: null, fail_class: "timeout", error: "discovery agent timed out after 10s with output (see agent.log)", duration_ms: 10000 }),
    node("b1a0", { score: null, fail_class: "timeout", error: "discovery agent timed out after 20s with no output at all (empty agent.log)", duration_ms: 20000 }),
    node("b1a1", { score: 3 }),
  ];
  const out = renderDirectionGuidance(cells);
  const ids = [...out.matchAll(/- (b\da\d+)/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["b0a0", "b0a1", "b1a0", "b1a1"]);
  assert.match(out, /4 evaluated attempt\(s\), 2 successful/);
  assert.match(out, /best score 9 \(b0a0\)/);
  assert.match(out, /2 repairable failure/);
  assert.match(out, /b0a1 timeout: agent ran 10s with output/);
  assert.match(out, /b1a0 timeout: agent produced no output during 20s/);
  assert.ok(out.length <= GUIDANCE_MAX_CHARS);
});

test("timeout_scored guidance shows the diagnostic partial score and stays a failure", () => {
  const scored = {
    ...node("b0a1", { score: null, fail_class: "timeout_scored", error: "discovery agent timed out after 480s with output (see agent.log)", duration_ms: 500000 }),
    partial: true,
    agent_timeout: { duration_ms: 480000, had_output: true },
    timeout_assessment: { score: 0.72, raw_score: 0.72, valid: true, fail_class: "ok", error: null },
  };
  const out = renderDirectionGuidance([node("b0a0", { score: 1 }), scored]);
  assert.match(out, /1 successful/);
  assert.match(out, /2 repairable failure|1 repairable failure/);
  assert.match(out, /b0a1 timeout_scored: agent ran 480s with output; diagnostic partial score 0\.72; unfinished/);
  assert.match(out, /best score 1 \(b0a0\)/, "partial scores never enter the best-score summary");
  assert.ok(out.length <= GUIDANCE_MAX_CHARS);
});

test("timeout_scored preserves an evaluator valid:false flag in diagnostics", () => {
  const scored = {
    ...node("b0a1", { score: null, fail_class: "timeout_scored", error: "discovery agent timed out after 10s with output (see agent.log)", duration_ms: 12000 }),
    partial: true,
    agent_timeout: { duration_ms: 10000, had_output: true },
    timeout_assessment: { score: 5, raw_score: 5, valid: false, fail_class: "ok", error: null },
  };
  const out = renderDirectionGuidance([scored]);
  assert.match(out, /diagnostic partial score 5.*\(valid:false\)/);
  assert.match(out, /unfinished/);
});

test("unresolved timeout assessments remain readable and never synthesize zero", () => {
  const unresolved = {
    ...node("b0a1", { score: null, fail_class: "timeout", error: "discovery agent timed out after 10s with output (see agent.log)", duration_ms: 12000 }),
    partial: true,
    agent_timeout: { duration_ms: 10000, had_output: true },
    timeout_assessment: { score: null, raw_score: null, valid: false, fail_class: "eval_error", error: "evaluator exploded" },
  };
  const out = renderDirectionGuidance([unresolved]);
  assert.match(out, /b0a1 timeout: agent ran 10s with output; assessment eval_error: evaluator exploded; unfinished/);
  assert.doesNotMatch(out, /partial score 0(?!\.)/, "missing assessments are never replaced with zero");
});

test("output is bounded and never leaks workspaces or proposals", () => {
  const cells = Array.from({ length: 300 }, (_, i) => node(`b${i}a0`, { score: i }));
  const out = renderDirectionGuidance(cells);
  assert.ok(out.length <= GUIDANCE_MAX_CHARS, `length ${out.length}`);
  assert.match(out, /omitted for length/);
  assert.ok(!out.includes("work/r0001"), "workspace paths must not leak");
  assert.ok(!out.includes("attempt_b"), "per-attempt paths must not leak");
});

test("automatic handoff stays bounded and keeps live recovery details ahead of old history", () => {
  const history = Array.from({ length: 400 }, (_, i) => `    t=${i + 1}: status=complete best=${i} beta=0.6 attempts=6 rounds=3`);
  const summary = [
    "Dream-RSI — fixture", "  root: /tmp/project", "  budgets: W=4 K1=3 K2=4 loops<=20", "  scoring: score.mjs -> score.value", "  policy: policy/method.ts (versions: r1, r2)",
    "  recoverable: 402, 401, 400 — /dream-rsi resume [iteration]", "  live 403: running | round 2/3 | workers 3/4 | completed 5 | best 9", "  in flight: live cycle 403 (in flight)", "  worlds: 400 recorded (t=1,2,3)", ...history,
  ].join("\n");
  const handoff = renderHandoffSummary(summary, { iteration: 403, kind: "active", owner: "live owner session test, pid 12", checkpoint: "/tmp/project/trace_pool/iter0403_current/checkpoint.json" });
  assert.ok(handoff.length <= HANDOFF_MAX_CHARS);
  assert.match(handoff, /budgets: W=4 K1=3 K2=4 loops<=20/);
  assert.match(handoff, /live 403: running/);
  assert.match(handoff, /selected iteration: 403 \(active\)/);
  assert.match(handoff, /owner: iteration 403, live owner session test, pid 12/);
  assert.match(handoff, /checkpoint: iteration 403, \/tmp\/project\/trace_pool\/iter0403_current\/checkpoint.json/);
  assert.match(handoff, /next safe action: inspect or wait for the active owner/);
  assert.match(handoff, /t=400: status=complete/);
  assert.doesNotMatch(handoff, /t=1: status=complete/);
  assert.match(handoff, new RegExp(`recoverable: 402, 401, 400`));
  assert.ok(HANDOFF_MAX_RUN_ENTRIES >= 1);
});

test("interrupted-only handoff invites explicit resume and keeps its action under pathological metadata", () => {
  const huge = "x".repeat(20_000);
  const summary = ["Dream-RSI — fixture", `  root: ${huge}`, "  budgets: W=2 K1=3 K2=4 loops<=5", "  scoring: score.mjs -> score.value", "  policy: policy/method.ts", "  recoverable: 7 — /dream-rsi resume [iteration]", `  in flight: ${huge}`].join("\n");
  const handoff = renderHandoffSummary(summary, { iteration: 7, kind: "recoverable", owner: huge, checkpoint: huge });
  assert.ok(handoff.length <= HANDOFF_MAX_CHARS);
  assert.match(handoff, /selected iteration: 7 \(recoverable\)/);
  assert.match(handoff, /next safe action: review the interrupted checkpoint and resume only when the user requests continuation/);
});

test("unevaluated cells are excluded", () => {
  const out = renderDirectionGuidance([
    { ...node("b0a0", { score: 2 }), evaluated: false, score: null },
  ]);
  assert.match(out, /no evaluated attempts/i);
});
