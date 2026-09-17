/**
 * Reward math (Eq. 1 and the sweep ranking), the policy contract, and the guardrail scan.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  paretoReward,
  replayValue,
  sweepAuc,
  sweepSummary,
  traceMetrics,
} from "../extensions/pi-dream-rsi/engine/reward.ts";
import { readPolicyViolations, scanPolicySource } from "../extensions/pi-dream-rsi/policy/runner.ts";
import { LLMDesignedMethod, _budget_done, _record_curve, finalize_result, newSimResult, resolveBeta } from "../extensions/pi-dream-rsi/policy/api.ts";
import { PolicyHost } from "../extensions/pi-dream-rsi/policy/host.ts";
import { branch_best_for, branch_failed_hard, branch_stale_for, probe_improved_vs_parent, repairable_failures } from "../extensions/pi-dream-rsi/policy/observation-signal.ts";

const cfg = { maxParallelism: 2, beta1: 0.01, beta2: 0.01, lambda: 1, baselineScore: null };

function decision(round, batch, revealed) {
  return { round, observed: [], batch, revealed, best_after: null };
}

test("Eq. 1: V = max s_v - beta1*N + beta2*N/max(1, k*)", () => {
  // No probes at all: the root's baseline is still the attainment, and N = k* = 0.
  const idle = traceMetrics([], { ...cfg, baselineScore: 5 });
  assert.equal(idle.probes, 0);
  assert.equal(idle.rounds, 0);
  assert.equal(idle.value, 5, "max(1, k*) guards the division and N = 0 removes both cost terms");

  // Three rounds, seven revealed nodes, best score 9, baseline 0.
  const trace = [
    decision(1, ["b0a0", "b1a0"], {
      b0a0: { score: 2, evaluated: true, valid: true, fail_class: "ok", error: null, delta_vs_baseline: 2, delta_vs_parent: 2, branch: 0, attempt: 0, n_valid: 1, n_total: 1 },
      b1a0: { score: 1, evaluated: true, valid: true, fail_class: "ok", error: null, delta_vs_baseline: 1, delta_vs_parent: 1, branch: 1, attempt: 0, n_valid: 1, n_total: 1 },
    }),
    decision(2, ["b0a0", "b1a0"], {
      b0a1: { score: 9, evaluated: true, valid: true, fail_class: "ok", error: null, delta_vs_baseline: 9, delta_vs_parent: 7, branch: 0, attempt: 1, n_valid: 2, n_total: 2 },
      b1a1: { score: null, evaluated: true, valid: false, fail_class: "eval_error", error: "boom", delta_vs_baseline: null, delta_vs_parent: null, branch: 1, attempt: 1, n_valid: 1, n_total: 2 },
    }),
    decision(3, ["b0a1"], {
      b0a2: { score: 4, evaluated: true, valid: true, fail_class: "ok", error: null, delta_vs_baseline: 4, delta_vs_parent: -5, branch: 0, attempt: 2, n_valid: 3, n_total: 3 },
    }),
  ];
  const metrics = traceMetrics(trace, { ...cfg, baselineScore: 0 });
  assert.equal(metrics.probes, 5, "N counts revealed non-root nodes");
  assert.equal(metrics.rounds, 3, "k* counts non-empty decision rounds");
  assert.equal(metrics.attainment, 9);
  const expected = 9 - 0.01 * 5 + (0.01 * 5) / 3;
  assert.equal(Number(metrics.value.toFixed(10)), Number(expected.toFixed(10)));
  assert.equal(replayValue(9, 5, 3, { ...cfg, baselineScore: 0 }), metrics.value);

  // A wasted round (batch selected, nothing revealed) still costs a decision round for the bonus.
  const wasted = traceMetrics([...trace, decision(4, ["b1a1"], {})], { ...cfg, baselineScore: 0 });
  assert.equal(wasted.rounds, 4);
  assert.equal(wasted.probes, 5);
  assert.equal(wasted.value, 9 - 0.01 * 5 + (0.01 * 5) / 4);
});

test("pareto.auc = mean attainment per probe; parallel_penalty approaches 1/W when batches are full", () => {
  const trace = [
    decision(1, ["b0a0", "b1a0"], {
      b0a0: { score: 2, evaluated: true, valid: true, fail_class: "ok", error: null, delta_vs_baseline: 2, delta_vs_parent: 2, branch: 0, attempt: 0, n_valid: 1, n_total: 1 },
      b1a0: { score: 2, evaluated: true, valid: true, fail_class: "ok", error: null, delta_vs_baseline: 2, delta_vs_parent: 2, branch: 1, attempt: 0, n_valid: 1, n_total: 1 },
    }),
    decision(2, ["b0a0", "b1a0"], {
      b0a1: { score: 6, evaluated: true, valid: true, fail_class: "ok", error: null, delta_vs_baseline: 6, delta_vs_parent: 4, branch: 0, attempt: 1, n_valid: 2, n_total: 2 },
      b1a1: { score: 6, evaluated: true, valid: true, fail_class: "ok", error: null, delta_vs_baseline: 6, delta_vs_parent: 4, branch: 1, attempt: 1, n_valid: 2, n_total: 2 },
    }),
  ];
  const full = traceMetrics(trace, { ...cfg, baselineScore: 0 });
  assert.equal(full.auc, (2 + 2 + 6 + 6) / 4);
  assert.equal(full.parallel_penalty, 0.5, "two full batches of W=2 in 4 probes => 1/W");

  // The same work probed serially is penalised by the parallelism term.
  const serialTrace = trace.flatMap((d) => Object.entries(d.revealed).map(([cell, obs]) => decision(0, [cell], { [cell]: obs })));
  const serial = traceMetrics(serialTrace, { ...cfg, baselineScore: 0 });
  assert.equal(serial.probes, 4);
  assert.equal(serial.parallel_penalty, 1, "a serial policy sits at 1");
  assert.ok(serial.parallel_penalty > full.parallel_penalty);
});

test("beta sweep: pareto.reward = pareto.auc - lambda * parallel_penalty, with a real frontier", () => {
  const points = [
    { beta: 0, attainment: 4, work: 4, parallelism: 2, value: 3, penalty: 0.5, trace_auc: 3, errors: [] },
    { beta: 0.6, attainment: 8, work: 10, parallelism: 2, value: 6, penalty: 0.3, trace_auc: 4, errors: [] },
    { beta: 1, attainment: 8, work: 16, parallelism: 2, value: 4, penalty: 0.2, trace_auc: 3, errors: [] },
  ];
  const auc = sweepAuc(points);
  // Trapezoid over work: (4+8)/2*6 + (8+8)/2*6 = 84, normalised by the work range 12.
  assert.equal(auc, 7);
  const summary = sweepSummary(points, 1);
  assert.equal(Number(summary.pareto_reward.toFixed(6)), Number((auc - (0.5 + 0.3 + 0.2) / 3).toFixed(6)));
  assert.equal(paretoReward(1, 0.5, 2), 0);
  assert.deepEqual(summary.frontier.map((p) => p.beta), [0, 0.6], "the widest beta is dominated");
});

test("guardrail scan: a prefix-only policy may not import I/O or exit the process", () => {
  assert.deepEqual(scanPolicySource('import { LLMDesignedMethod } from "./api.ts";\nexport class OptimalPolicy extends LLMDesignedMethod {}'), []);
  assert.match(scanPolicySource('import * as fs from "node:fs";')[0], /node:fs/);
  assert.match(scanPolicySource("process.exit(1);")[0], /process\.exit/);
  assert.match(scanPolicySource('import { x } from "fs";')[0], /bare module specifier/);
  // A docstring that merely mentions the forbidden name is not a violation.
  assert.deepEqual(scanPolicySource("/** Never touches node:fs or process.exit. */\nexport class OptimalPolicy {}"), []);
  assert.deepEqual(readPolicyViolations("this/path/does/not/exist.ts").length, 1);
});

test("beta is one scalar: forced value wins, otherwise the policy's baked-in default", () => {
  class A extends LLMDesignedMethod {}
  class B extends LLMDesignedMethod {
    default_beta = 0.85;
  }
  assert.equal(resolveBeta(new A({}), {}), 0.6, "default when nothing declares a beta");
  assert.equal(resolveBeta(new B({}), {}), 0.85, "the subclass field initializer runs after super()");
  assert.equal(resolveBeta(new B({}), { beta: 0.2 }), 0.2, "the runtime's forced beta wins");
  assert.equal(resolveBeta(new B({}), { beta: 5 }), 1, "clamped to [0, 1]");
  assert.equal(resolveBeta(new B({}), { beta: -3 }), 0);
  const schedule = LLMDesignedMethod.schedule(1);
  const cautious = LLMDesignedMethod.schedule(0);
  assert.ok(schedule.open_root_bias > cautious.open_root_bias, "high beta opens more width");
  assert.ok(schedule.prune_after_consecutive_failures < cautious.prune_after_consecutive_failures, "high beta prunes later");
  assert.ok(schedule.stale_rounds_before_park > cautious.stale_rounds_before_park, "high beta is more patient");
});

test("budget helpers: replay has no cap, so a policy must stop on its own", async () => {
  const host = new PolicyHost({ mode: "replay", maxParallelism: 1, slots: [0], probe: async () => [] });
  assert.equal(_budget_done(host, null), false, "budget=None never ends on its own");
  assert.equal(_budget_done(host, { rounds: 0 }), true);
  assert.equal(_budget_done(host, { attempts: 0 }), true);
  const res = newSimResult();
  _record_curve(res, host);
  assert.deepEqual(res.curve, [{ round: 0, probes: 0, best: null }]);
  const result = finalize_result(host, res);
  assert.deepEqual(result.curve, res.curve);
  assert.equal(result.probes, 0);
});

test("prefix signals: repairable failures stay eligible; closure needs cumulative evidence", () => {
  const prefix = {
    b0a0: { branch: 0, attempt: 0, score: 3, evaluated: true, valid: true, fail_class: "ok", error: null, delta_vs_baseline: 3, delta_vs_parent: 3, n_valid: 1, n_total: 1 },
    b1a0: { branch: 1, attempt: 0, score: null, evaluated: true, valid: false, fail_class: "eval_error", error: "shape mismatch", delta_vs_baseline: null, delta_vs_parent: null, n_valid: 0, n_total: 1 },
    b1a1: { branch: 1, attempt: 1, score: null, evaluated: true, valid: false, fail_class: "compile_other", error: "undefined symbol", delta_vs_baseline: null, delta_vs_parent: null, n_valid: 0, n_total: 2 },
  };
  assert.equal(branch_best_for(prefix, 0), 3);
  assert.equal(branch_best_for(prefix, 1), null);
  assert.equal(branch_stale_for(prefix, 1), 2);
  assert.deepEqual(repairable_failures(prefix).sort(), ["b1a0", "b1a1"]);
  assert.equal(branch_failed_hard(prefix, "b1a1", { baseline_score: 3 }, 2), true, "two failures with no anchor");
  assert.equal(branch_failed_hard(prefix, "b1a1", { baseline_score: 3 }, 3), false, "thresholds are explicit");
  assert.ok(probe_improved_vs_parent(prefix.b0a0));
  assert.equal(probe_improved_vs_parent(prefix.b1a1), false, "an unsuccessful evaluation never counts as a gain");
  // A later success must protect the branch, whatever came before.
  const reopened = { ...prefix, b1a2: { branch: 1, attempt: 2, score: 7, evaluated: true, valid: true, fail_class: "ok", error: null, delta_vs_baseline: 4, delta_vs_parent: 4, n_valid: 1, n_total: 3 } };
  assert.equal(branch_best_for(reopened, 1), 7);
  assert.equal(branch_failed_hard(reopened, "b1a2", { baseline_score: 3 }, 2), false);
});
