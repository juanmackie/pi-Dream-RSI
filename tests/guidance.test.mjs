/**
 * Opt-in direction guidance (experiment 2-b): deterministic, bounded,
 * prompt-only summary of evaluated history. No LLM involved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDirectionGuidance, GUIDANCE_MAX_CHARS } from "../extensions/pi-dream-rsi/engine/guidance.ts";
import { renderHandoffSummary, HANDOFF_MAX_CHARS, HANDOFF_MAX_RUN_ENTRIES } from "../extensions/pi-dream-rsi/engine/handoff.ts";
import {
  defaultTask,
  normalizeTask,
  scoringFingerprint,
  validateTask,
} from "../extensions/pi-dream-rsi/engine/task.ts";

function node(cell_id, { evaluated = true, score = 1, fail_class = "ok", error = null } = {}) {
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
    duration_ms: 5,
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
    node("b0a1", { score: null, fail_class: "timeout", error: "timed out" }),
  ]);
  assert.match(out, /1 repairable failure/);
  assert.match(out, /b0a1 failed \/ timeout/);
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
