#!/usr/bin/env node
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, "scenarios.json"), "utf8"));
const extensionRoot = path.resolve(here, "../extensions/pi-dream-rsi");

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(random) { return Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random()); }
function draw(scenario, random) {
  if (scenario.kind === "student") {
    let chi = 0;
    for (let index = 0; index < scenario.df; index += 1) chi += normal(random) ** 2;
    return normal(random) / Math.sqrt(chi / scenario.df) * scenario.noise_sd * Math.sqrt((scenario.df - 2) / scenario.df);
  }
  if (scenario.kind === "bootstrap") return scenario.samples[Math.floor(random() * scenario.samples.length)];
  return normal(random) * scenario.noise_sd;
}
function logGamma(z) {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  const shifted = z - 1;
  let sum = 0.99999999999980993;
  coefficients.forEach((coefficient, index) => { sum += coefficient / (shifted + index + 1); });
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}
function logAdd(a, b) {
  const high = Math.max(a, b);
  return high + Math.log(Math.exp(a - high) + Math.exp(b - high));
}
function binomialLogCdf(k, n, p) {
  if (p <= 0) return 0;
  if (p >= 1) return k >= n ? 0 : Number.NEGATIVE_INFINITY;
  let term = logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log1p(-p);
  let total = term;
  for (let index = k; index > 0; index -= 1) {
    term += Math.log(index) - Math.log(n - index + 1) + Math.log1p(-p) - Math.log(p);
    total = logAdd(total, term);
  }
  return total;
}
function clopperPearsonUpper(successes, trials, alpha = 0.05) {
  if (successes >= trials) return 1;
  let low = successes / trials;
  let high = 1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (binomialLogCdf(successes, trials, middle) > Math.log(alpha)) low = middle;
    else high = middle;
  }
  return high;
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function simulateMedian3(scenario, random, threshold) {
  const gainAt = (pair) => {
    const beforeOrder = pair * 2;
    const afterOrder = beforeOrder + 1;
    const drift = scenario.kind === "drift" ? scenario.drift_per_run * (afterOrder - beforeOrder) : 0;
    return scenario.effect + draw(scenario, random) - draw(scenario, random) + drift;
  };
  const first = gainAt(0);
  if (first <= threshold) return { accepted: false, evaluatorRuns: 2 };
  const gains = [first, gainAt(1), gainAt(2)];
  return { accepted: median(gains) > threshold, evaluatorRuns: 6 };
}
async function simulate(scenario, options) {
  const { planTest, runPaired, count, seedStart, threshold, maxCycles, maxPairs = 8 } = options;
  let measurementAccepted = 0;
  let baselineAccepted = 0;
  let baselineEvaluatorRuns = 0;
  let deterministicDeclared = 0;
  let deterministicFalseClaims = 0;
  const pairsUsed = [];
  const evaluatorRunsUsed = [];
  let firstInstrumentOrder = null;
  for (let index = 0; index < count; index += 1) {
    const random = rng(seedStart + index);
    const baselineRandom = rng((seedStart + index + 0x9E3779B9) >>> 0);
    const baselineResult = simulateMedian3(scenario, baselineRandom, threshold);
    if (baselineResult.accepted) baselineAccepted += 1;
    baselineEvaluatorRuns += baselineResult.evaluatorRuns;
    const baselineDrift = (order) => scenario.kind === "drift" ? scenario.drift_per_run * order : 0;
    const baseline = Array.from({ length: 5 }, (_, order) => 1 + draw(scenario, random) + baselineDrift(order));
    const deterministic = baseline.every((value) => value === baseline[0]);
    if (deterministic) {
      deterministicDeclared += 1;
      const auditRandom = rng((seedStart + index + 0x85EBCA6B) >>> 0);
      const hidden = Array.from({ length: 3 }, (_, offset) => 1 + draw(scenario, auditRandom) + baselineDrift(offset + 5));
      if (hidden.some((value) => value !== baseline[0])) deterministicFalseClaims += 1;
    }
    const plan = planTest({ deterministic, threshold, maxCycles, maxPairs, baseline, higherIsBetter: scenario.higher_is_better ?? true });
    let callbackRuns = 0;
    const pairedConditions = new Map();
    const callbackOrder = [];
    const result = await runPaired({
      plan,
      higherIsBetter: scenario.higher_is_better ?? true,
      instrument: ({ condition, order, pair, baseline: isBaseline }) => {
        callbackRuns += 1;
        callbackOrder.push(`${isBaseline ? "baseline" : "pair"}:${condition}`);
        if (!isBaseline) {
          const conditions = pairedConditions.get(pair) ?? new Set();
          conditions.add(condition);
          pairedConditions.set(pair, conditions);
        }
        const raw = 1 + draw(scenario, random) + baselineDrift(order)
          + (!isBaseline && condition === "after" ? (scenario.higher_is_better === false ? -scenario.effect : scenario.effect) : 0);
        return raw;
      },
    });
    if (index === 0) firstInstrumentOrder = callbackOrder;
    if (result?.decision?.decision === "accept") measurementAccepted += 1;
    pairsUsed.push([...pairedConditions.values()].filter((conditions) => conditions.has("before") && conditions.has("after")).length);
    evaluatorRunsUsed.push(callbackRuns);
  }
  const measurementRate = measurementAccepted / count;
  const baselineRate = baselineAccepted / count;
  return {
    name: scenario.name,
    measurement: { accepted: measurementAccepted, trials: count, rate: measurementRate, clopper_pearson_95_upper: clopperPearsonUpper(measurementAccepted, count), mean_pairs: pairsUsed.reduce((a, b) => a + b, 0) / count, mean_evaluator_runs: evaluatorRunsUsed.reduce((a, b) => a + b, 0) / count, deterministic_declared: deterministicDeclared, deterministic_false_claims: deterministicFalseClaims, first_trial_instrument_order: firstInstrumentOrder },
    baseline_median3: { accepted: baselineAccepted, trials: count, rate: baselineRate, clopper_pearson_95_upper: clopperPearsonUpper(baselineAccepted, count), mean_evaluator_runs: baselineEvaluatorRuns / count },
  };
}

function checkContract(api) {
  if (typeof api.parseThreshold !== "function" || typeof api.resolveThreshold !== "function") throw new Error("measurement module must export parseThreshold and resolveThreshold");
  const absolute = api.parseThreshold(0.05);
  if (absolute?.kind !== "absolute" || absolute.value !== 0.05) throw new Error("parseThreshold(0.05) must preserve an absolute score delta");
  const relative = api.parseThreshold("5%");
  if (relative?.kind !== "relative" || relative.value !== 0.05) throw new Error('parseThreshold("5%") must return a 5% relative threshold');
  const higher = api.resolveThreshold(relative, 100, true);
  const lower = api.resolveThreshold(relative, 100, false);
  if (!Number.isFinite(higher) || Math.abs(higher - Math.log1p(0.05)) > 1e-12) throw new Error("higher-is-better relative threshold must use log1p(p)");
  if (!Number.isFinite(lower) || Math.abs(lower + Math.log1p(-0.05)) > 1e-12) throw new Error("lower-is-better relative threshold must use -log1p(-p)");
}

export async function runBench(options = {}) {
  const heldOut = options.heldOut ?? false;
  const seedStart = options.seedStart ?? (heldOut ? config.held_out_seed_start : config.seed_start);
  const count = options.seeds ?? (heldOut ? config.held_out_seeds : config.seeds);
  if (!Number.isInteger(seedStart) || !Number.isInteger(count) || count < 1) throw new Error("seedStart and seeds must be integers, with seeds positive");
  const threshold = options.threshold ?? config.threshold;
  const maxCycles = options.maxCycles ?? config.max_cycles;
  const maxPairs = options.maxPairs ?? 8;
  const measurePath = path.resolve(options.measureModule ?? path.join(extensionRoot, "engine", "measure.ts"));
  const sourceHash = createHash("sha256").update(fs.readFileSync(measurePath)).digest("hex");
  const moduleUrl = pathToFileURL(measurePath);
  moduleUrl.searchParams.set("dreambench", sourceHash);
  const api = await import(moduleUrl.href);
  checkContract(api);
  if (typeof api.planTest !== "function" || typeof api.runPaired !== "function") throw new Error("measurement module must export planTest and runPaired");
  const simulation = { planTest: api.planTest, runPaired: api.runPaired, count, seedStart, threshold, maxCycles, maxPairs };
  const scenarios = [];
  for (const scenario of config.scenarios) {
    const row = await simulate(scenario, simulation);
    if (threshold !== 0 && scenario.effect > 0) {
      row.threshold_zero = (await simulate(scenario, { ...simulation, threshold: 0 })).measurement;
    }
    scenarios.push(row);
  }
  return {
    benchmark: "DreamBench Tier 1 measurement engine",
    measurement_sha256: sourceHash,
    node_version: process.version,
    seed_start: seedStart,
    seeds: count,
    held_out: heldOut,
    max_cycles: maxCycles,
    max_pairs: maxPairs,
    threshold,
    per_confirmation_alpha: 0.10 / (2 * maxCycles),
    baseline: "Dream-RSI 1.0 paired median-of-3 comparison, fixed before-then-after order, first pair screens at threshold, then the median gain must exceed threshold.",
    measurement_adapter: "Every trial calls the candidate module's runPaired; generated evaluator scores enter only through its instrument callback, whose actual calls and order are reported.",
    deterministic_rule: "Five baseline reads classify determinism only when all five match. Hidden follow-up deviations estimate false deterministic declarations in simulation.",
    preflight_baseline_runs_per_campaign: 5,
    confidence_interval: "One-sided 95% exact Clopper-Pearson binomial upper bounds quantify Monte Carlo uncertainty only.",
    caveat: "Student t cutoffs use paired-sample degrees of freedom while the standard error is floored by the larger of paired and baseline variation. Seeded Clopper-Pearson bounds quantify Monte Carlo uncertainty only; they do not prove family-wise false-accept control for other evaluators, serial dependence, or contaminated data.",
    scenarios,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const heldOut = args.includes("--held-out");
  const numberArg = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? Number(args[index + 1]) : fallback;
  };
  const report = await runBench({
    heldOut,
    seedStart: numberArg("--seed", heldOut ? config.held_out_seed_start : config.seed_start),
    seeds: numberArg("--seeds", heldOut ? config.held_out_seeds : config.seeds),
    maxPairs: numberArg("--pairs", 8),
  });
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`${report.benchmark}; seeds ${report.seed_start}..${report.seed_start + report.seeds - 1}${heldOut ? " (held out)" : ""}\n`);
    for (const row of report.scenarios) process.stdout.write(`${row.name}: new=${row.measurement.rate.toFixed(4)} (CP95 upper ${row.measurement.clopper_pearson_95_upper.toFixed(4)}, ${row.measurement.mean_evaluator_runs.toFixed(1)} evals); median3=${row.baseline_median3.rate.toFixed(4)} (CP95 upper ${row.baseline_median3.clopper_pearson_95_upper.toFixed(4)}, ${row.baseline_median3.mean_evaluator_runs.toFixed(1)} evals)\n`);
    process.stdout.write(`${report.caveat}\n`);
  }
}
