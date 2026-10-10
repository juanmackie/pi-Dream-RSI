/**
 * Opt-in direction guidance (experiment 2-b): deterministic, bounded,
 * prompt-only summary of evaluated history. No LLM involved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDirectionGuidance, GUIDANCE_MAX_CHARS } from "../extensions/pi-dream-rsi/engine/guidance.ts";
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

test("unevaluated cells are excluded", () => {
  const out = renderDirectionGuidance([
    { ...node("b0a0", { score: 2 }), evaluated: false, score: null },
  ]);
  assert.match(out, /no evaluated attempts/i);
});
