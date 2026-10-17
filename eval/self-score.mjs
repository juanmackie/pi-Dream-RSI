#!/usr/bin/env node
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { purityViolations, countCodeTokens } from "./purity.mjs";
import { runBench } from "./bench.mjs";

const VERIFIER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(VERIFIER_ROOT, "extensions", "pi-dream-rsi", "engine", "measure.ts");
const CONFIG_PATH = path.join(VERIFIER_ROOT, ".auto", "measure-config.json");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function summarize(report, alpha, tokenDelta = 0, config = {}) {
  const positives = report.scenarios.filter((row) => row.name.startsWith("win-"));
  const nulls = report.scenarios.filter((row) => /^(?:null-|boundary-|mined-null-|mined-drift-boundary-)/.test(row.name));
  if (positives.length === 0 || nulls.length === 0) throw new Error("DreamBench requires positive and null/boundary scenarios");
  const power = positives.reduce((sum, row) => sum + row.measurement.rate, 0) / positives.length;
  const meanRuns = positives.reduce((sum, row) => sum + row.measurement.mean_evaluator_runs, 0) / positives.length;
  const bloatPenalty = (config.bloat_penalty ?? 0.01) * tokenDelta / (config.bloat_token_unit ?? 50);
  const score = power - 0.25 * (meanRuns / 16) - bloatPenalty;
  const falseAccepts = nulls.map((row) => ({ scenario: row.name, accepted: row.measurement.accepted,
    trials: row.measurement.trials, rate: row.measurement.rate, upper: row.measurement.clopper_pearson_95_upper }));
  return { score, power, mean_evaluator_runs: meanRuns, false_accepts: falseAccepts,
    alpha, alpha_passed: falseAccepts.every((row) => row.upper <= alpha) };
}

export async function scoreMeasurement(workspace = process.cwd(), options = {}) {
  const candidatePath = path.resolve(workspace, "extensions", "pi-dream-rsi", "engine", "measure.ts");
  const baselineBytes = fs.readFileSync(BASELINE_PATH);
  const baselineSource = baselineBytes.toString("utf8");
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (sha256(baselineBytes) !== config.baseline_sha256 || countCodeTokens(baselineSource) !== config.baseline_tokens) {
    throw new Error("trusted measure baseline does not match its protected snapshot config");
  }
  const candidateBytes = fs.readFileSync(candidatePath);
  const candidateSource = candidateBytes.toString("utf8");
  const candidateHash = sha256(candidateBytes);
  const violations = purityViolations(candidateSource, "measure.ts");
  if (violations.length) return { score: 0, valid: false, fail_class: "purity_failure", error: violations.join("; ") };
  const candidateTokens = countCodeTokens(candidateSource);
  const deltaTokens = candidateTokens - config.baseline_tokens;
  const heldoutTolerance = config.heldout_tolerance ?? 0.005;
  const evaluate = async (modulePath, heldOut, count) => runBench({ measureModule: modulePath, heldOut, ...(count ? { seeds: count } : {}) });
  const candidatePrimary = await evaluate(candidatePath, false, options.seeds);
  const candidateHeldout = await evaluate(candidatePath, true, options.heldoutSeeds);
  const baselinePrimary = await evaluate(BASELINE_PATH, false, options.seeds);
  const baselineHeldout = await evaluate(BASELINE_PATH, true, options.heldoutSeeds);
  const candidatePrimarySummary = summarize(candidatePrimary, config.alpha, deltaTokens, config);
  const candidateHeldoutSummary = summarize(candidateHeldout, config.alpha, deltaTokens, config);
  const baselinePrimarySummary = summarize(baselinePrimary, config.alpha, 0, config);
  const baselineHeldoutSummary = summarize(baselineHeldout, config.alpha, 0, config);
  // The campaign optimizes the primary-set J. Held-out results are an independent
  // non-regression gate and never inflate the reported objective.
  const candidateCombined = candidatePrimarySummary.score;
  const baselineCombined = baselinePrimarySummary.score;
  const heldoutMinimum = baselineHeldoutSummary.score - heldoutTolerance;
  const heldoutPassed = candidateHeldoutSummary.score >= heldoutMinimum;
  const primaryPassed = candidatePrimarySummary.score >= baselinePrimarySummary.score - heldoutTolerance;
  // Prevent a low-power all-reject strategy from winning merely because the
  // baseline J is negative due to evaluator cost.
  const primaryPowerPassed = candidatePrimarySummary.power >= baselinePrimarySummary.power - heldoutTolerance;
  const heldoutPowerPassed = candidateHeldoutSummary.power >= baselineHeldoutSummary.power - heldoutTolerance;
  const alphaPassed = candidatePrimarySummary.alpha_passed && candidateHeldoutSummary.alpha_passed;
  const valid = heldoutPassed && primaryPassed && primaryPowerPassed && heldoutPowerPassed && alphaPassed;
  const failClass = valid ? "ok" : !alphaPassed ? "false_accept_limit" : !primaryPowerPassed || !heldoutPowerPassed ? "power_regression" : !heldoutPassed ? "heldout_regression" : "primary_regression";
  return {
    score: candidateCombined,
    valid,
    fail_class: failClass,
    error: valid ? null : failClass === "false_accept_limit" ? "a null or boundary false-accept confidence bound exceeds alpha" : `${failClass.replaceAll("_", " ")} against protected DreamBench baseline`,
    baseline: { sha256: config.baseline_sha256, tokens: config.baseline_tokens },
    candidate: { sha256: candidateHash, tokens: candidateTokens },
    delta_tokens: deltaTokens,
    formula: "primary positive-scenario power - 0.25*(mean positive evaluator runs/16) - 0.01*(delta code tokens/50); held-out J and power are hard non-regression gates",
    baseline_score: baselineCombined,
    alpha: config.alpha,
    primary: { candidate: candidatePrimarySummary, baseline: baselinePrimarySummary },
    heldout: { candidate: candidateHeldoutSummary, baseline: baselineHeldoutSummary, minimum: heldoutMinimum },
    power_floor: { tolerance: heldoutTolerance, primary_minimum: baselinePrimarySummary.power - heldoutTolerance, heldout_minimum: baselineHeldoutSummary.power - heldoutTolerance, primary_passed: primaryPowerPassed, heldout_passed: heldoutPowerPassed },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const workspace = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? ".");
  const numberArg = (name) => { const arg = args.find((item) => item.startsWith(`${name}=`)); return arg ? Number(arg.slice(name.length + 1)) : undefined; };
  let result;
  try { result = await scoreMeasurement(workspace, { seeds: numberArg("--seeds"), heldoutSeeds: numberArg("--heldout-seeds") }); }
  catch (error) { result = { score: 0, valid: false, fail_class: "scorer_error", error: error instanceof Error ? error.message : String(error) }; }
  const output = path.join(workspace, "eval", "score.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`score=${result.score} fail_class=${result.fail_class}`);
  if (!result.valid) process.exitCode = 1;
}
