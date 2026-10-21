import assert from "node:assert/strict";
import test from "node:test";
import { jump } from "./fixtures.mjs";

test("admission reserves one noisy first look without requiring the maximum sample", async () => {
  const { planAdmission } = await jump("engine/admission.ts");
  const plan = planAdmission({
    remaining: { agentStarts: 12, evaluatorRuns: 10, wallMs: 10 * 60_000 },
    expectedReadMs: 60_000,
    gates: 1,
    deterministic: false,
    baselineReuse: true,
    postApplyRuns: 1,
    promotionAgentStarts: 3,
    search: { agentStarts: 2, evaluatorRuns: 1, wallMs: 60_000 },
  });
  assert.equal(plan.feasible, true);
  assert.equal(plan.confirmation.firstLookPairs, 2);
  assert.equal(plan.confirmation.firstLookRuns, 4);
  assert.equal(plan.confirmation.maxPairs, 2);
  assert.equal(plan.reserve.evaluatorRuns, 6);
  assert.equal(plan.shortfall, null);
});

test("admission reports the first complete-promotion shortfall before spending", async () => {
  const { planAdmission } = await jump("engine/admission.ts");
  const plan = planAdmission({
    remaining: { agentStarts: 8, evaluatorRuns: 3, wallMs: 60_000 },
    expectedReadMs: 60_000,
    gates: 1,
    deterministic: false,
    baselineReuse: true,
    postApplyRuns: 1,
    promotionAgentStarts: 3,
    search: { agentStarts: 2, evaluatorRuns: 1, wallMs: 30_000 }
  });
  assert.equal(plan.feasible, false);
  assert.equal(plan.shortfall.code, "confirmation-budget");
  assert.equal(plan.shortfall.requiredEvaluatorRuns, 7);
});
