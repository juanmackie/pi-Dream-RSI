import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { jump } from "./fixtures.mjs";
import { runBench } from "../eval/bench.mjs";

test("threshold parsing preserves absolute units and resolves relative direction", async () => {
  const { parseThreshold, resolveThreshold } = await jump("engine/measure.ts");
  assert.deepEqual(parseThreshold(2), { kind: "absolute", value: 2 });
  assert.deepEqual(parseThreshold("5%"), { kind: "relative", value: 0.05 });
  assert.ok(Math.abs(resolveThreshold(parseThreshold("5%"), 100, true) - Math.log(1.05)) < 1e-12);
  assert.ok(Math.abs(resolveThreshold(parseThreshold("5%"), 100, false) + Math.log(0.95)) < 1e-12);
  assert.throws(() => parseThreshold("100%"), /\[0%, 100%\)/);
});

test("deterministic confirmation uses one exact pair and rejects invalid or insufficient gains", async () => {
  const { planTest, runPaired } = await jump("engine/measure.ts");
  const plan = planTest({ baseline: [10, 10, 10], higherIsBetter: true, threshold: 2, maxCycles: 5, deterministic: true });
  let calls = 0;
  const result = await runPaired({ plan, instrument: ({ condition }) => { calls += 1; return condition === "after" ? 13 : 10; } });
  assert.equal(calls, 2);
  assert.equal(result.decision.decision, "accept");
  assert.equal(result.pairs[0].gain, 3);
  const invalid = await runPaired({ plan, instrument: ({ condition }) => condition === "after" ? { valid: false, value: 11 } : 10 });
  assert.equal(invalid.decision.decision, "reject");
});

test("noisy decisions use staged looks, futility, and reject non-finite evidence", async () => {
  const { planTest, decide } = await jump("engine/measure.ts");
  const plan = planTest({ baseline: [1, 1.1, 0.9, 1.05, 0.95], higherIsBetter: true, threshold: 2, maxCycles: 5 });
  assert.equal(plan.baselineRuns, 5);
  assert.equal(plan.maxPairs, 8);
  assert.equal(plan.looks, 4);
  assert.ok(Math.abs(plan.alphaConf - 0.01) < 1e-12);
  assert.ok(plan.criticalValue > 4.0 && plan.criticalValue < 4.1, "final-look Student t boundary uses paired-sample degrees of freedom");
  assert.equal(decide({ plan, gains: [0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03], baseline: Array(5).fill(1), look: 4 }).decision, "futile", "a quiet confirmation sample cannot erase calibration noise");
  assert.equal(decide({ plan, gains: [0, 0], look: 1 }).decision, "futile");
  assert.equal(decide({ plan, gains: [Number.NaN], look: 1 }).decision, "reject");
  assert.ok(plan.estimatedPowerAtEffect(0.15) > plan.estimatedPowerAtEffect(0.1));
  const extendedPlan = planTest({ baseline: [1, 0.9, 1.1, 1, 1.02], higherIsBetter: true, threshold: 0.05, maxCycles: 5, maxPairs: 16 });
  assert.equal(extendedPlan.maxPairs, 16);
  assert.ok(extendedPlan.minimumDetectableEffect < plan.minimumDetectableEffect, "additional paired budget lowers the estimated MDE");
  assert.throws(() => planTest({ baseline: [1, 1], higherIsBetter: true, threshold: 0, maxCycles: 5, maxPairs: 10 }), /multiple of 4/);
  const boundaryPlan = planTest({ baseline: [0.94, 1.06, 0.97, 1.03, 1], higherIsBetter: true, threshold: 0.05, maxCycles: 5 });
  assert.equal(decide({ plan: boundaryPlan, gains: Array(8).fill(0.05), baseline: [0.94, 1.06, 0.97, 1.03, 1], look: 4 }).decision, "reject");
});

test("lower-is-better relative confirmation measures a proportional cost reduction in log space", async () => {
  const { parseThreshold, resolveThreshold, planTest, runPaired } = await jump("engine/measure.ts");
  const threshold = resolveThreshold(parseThreshold("5%"), 100, false);
  const plan = planTest({ baseline: [100, 102, 99, 101, 98], higherIsBetter: false, threshold, relative: true, maxCycles: 5 });
  const result = await runPaired({ plan, higherIsBetter: false, instrument: ({ condition }) => condition === "after" ? 90 : 100 });
  assert.equal(result.decision.decision, "accept");
  assert.ok(Math.abs(result.pairs[0].gain - Math.log(100 / 90)) < 1e-12);
  assert.ok(plan.mdeRel > 0.05, "reported relative MDE includes the required 5% threshold");
});

test("paired runner alternates ABBA, evaluates all invalid cases, and reports the actual call count", async () => {
  const { planTest, runPaired } = await jump("engine/measure.ts");
  const plan = planTest({ baseline: [10, 10.2, 9.8, 10.1, 9.9], higherIsBetter: true, threshold: 0.01, maxCycles: 5 });
  const order = [];
  const result = await runPaired({ plan, instrument: ({ condition, baseline }) => { if (!baseline) order.push(condition); return 10; } });
  assert.deepEqual(order.slice(0, 4), ["before", "after", "after", "before"]);
  assert.equal(result.runs, 21, "five baseline readings and all eight pairs when calibrated noise keeps futility inconclusive");
  assert.equal(result.decision.decision, "reject");
});

test("seeded Gaussian null experiment reports errors without treating a normal approximation as a guarantee", async () => {
  const { planTest, decide } = await jump("engine/measure.ts");
  let state = 0x12345678;
  const uniform = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state + 1) / 4294967297; };
  const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  const seeds = 2000;
  let accepts = 0;
  for (let seed = 0; seed < seeds; seed += 1) {
    state = seed + 1;
    const baseline = Array.from({ length: 5 }, normal);
    const plan = planTest({ baseline, higherIsBetter: true, threshold: 0.05, maxCycles: 5 });
    const gains = Array.from({ length: 8 }, () => 0.06 * (normal() - normal()));
    if (decide({ plan, gains, look: 4 }).decision === "accept") accepts += 1;
  }
  const observed = accepts / seeds;
  assert.ok(observed < 0.02, `seeded null false-accept estimate was ${observed}; Monte Carlo standard error ${Math.sqrt(observed * (1 - observed) / seeds)}`);
});

test("DreamBench drives candidate runPaired and cache-busts same-path candidate edits", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dreambench-measure-"));
  const candidate = path.join(directory, "measure.mjs");
  const validApi = `
export function parseThreshold(value) { return typeof value === "number" ? { kind: "absolute", value } : { kind: "relative", value: Number.parseFloat(value) / 100 }; }
export function resolveThreshold(threshold, baseline, higher) { if (threshold.kind === "absolute") return threshold.value; return higher ? Math.log1p(threshold.value) : -Math.log1p(-threshold.value); }
export function planTest(options) { return { ...options, deterministic: false, maxPairs: options.maxPairs, baselineRuns: 5 }; }
export async function runPaired() { return { decision: { decision: "accept" }, baseline: [], pairs: [], runs: 0 }; }
`;
  try {
    fs.writeFileSync(candidate, validApi);
    const accepting = await runBench({ measureModule: candidate, seeds: 8, maxPairs: 4 });
    assert.equal(accepting.scenarios.find((row) => row.name === "null-gaussian").measurement.rate, 1);
    assert.equal(accepting.scenarios.find((row) => row.name === "null-gaussian").measurement.mean_evaluator_runs, 0, "actual callback count exposes the adapter that skipped all evaluator runs");
    fs.writeFileSync(candidate, validApi.replace('decision: "accept"', 'decision: "reject"'));
    const rejecting = await runBench({ measureModule: candidate, seeds: 8, maxPairs: 4 });
    assert.equal(rejecting.scenarios.find((row) => row.name === "null-gaussian").measurement.rate, 0, "changed source at the same path must load as a new candidate");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("DreamBench rejects a candidate that breaks numeric versus percentage threshold semantics", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dreambench-contract-"));
  const candidate = path.join(directory, "measure.mjs");
  fs.writeFileSync(candidate, `
export const parseThreshold = value => ({ kind: "absolute", value: Number(value) });
export const resolveThreshold = threshold => threshold.value;
export const planTest = () => ({});
export const runPaired = async () => ({ decision: { decision: "reject" } });
`);
  try {
    await assert.rejects(runBench({ measureModule: candidate, seeds: 1 }), /parseThreshold\("5%"\)/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
