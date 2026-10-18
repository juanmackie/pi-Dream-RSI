#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TOURNAMENT_ARMS = Object.freeze([
  "dream_rsi_2",
  "experiment_os",
  "mass_workflow_search",
  "autoresearch_fixed_budget",
  "qwen_telemetry_funnel",
  "coding_agent",
  "profile_guided",
]);

export const REQUIRED_ABLATIONS = Object.freeze([
  "experiment_os_records",
  "regularized_actions",
  "reviewer_guided_dag",
  "mass_workflow_search",
  "mass_trajectory_distillation",
  "fixed_budget_single_artifact",
  "fresh_context_notes",
  "sandbox_containment",
  "telemetry_funnel",
]);

export const REQUIRED_HOME_BENCHMARKS = Object.freeze([
  "rsi_master",
  "mass",
  "autoresearch",
  "anthropic_memento",
  "qwen_funnel",
]);

export const HOME_BENCHMARK_ARMS = Object.freeze({
  rsi_master: "experiment_os",
  mass: "mass_workflow_search",
  autoresearch: "autoresearch_fixed_budget",
  anthropic_memento: "coding_agent",
  qwen_funnel: "qwen_telemetry_funnel",
});

const HASH = /^[a-f0-9]{64}$/;
const DOMAIN = "dream-rsi-preregistration-v1";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
  return `{${entries.join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function coreManifest(manifest) {
  const { registration: _registration, ...core } = manifest;
  return core;
}

export function preregistrationDigest(manifest) {
  return sha256(canonical(coreManifest(manifest)));
}

export function preregistrationReceiptMessage({ digest, registeredAt, url }) {
  return `${DOMAIN}\n${digest}\n${registeredAt}\n${url}`;
}

export function createPreregistrationReceipt(manifest, { url, registeredAt, privateKey }) {
  const digest = preregistrationDigest(manifest);
  const message = preregistrationReceiptMessage({ digest, registeredAt, url });
  const publicKey = crypto.createPublicKey(privateKey);
  const registryKeySha256 = sha256(publicKey.export({ format: "der", type: "spki" }));
  const signatureBase64 = crypto.sign(null, Buffer.from(message), privateKey).toString("base64");
  return { url, registeredAt, digest, registryKeySha256, signatureBase64 };
}

function add(errors, condition, message) {
  if (!condition) errors.push(message);
}

function checkHash(errors, value, label) {
  add(errors, typeof value === "string" && HASH.test(value), `${label} must be a lowercase SHA-256 hex digest`);
}

function checkPositiveInteger(errors, value, label) {
  add(errors, Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
}

function inspectProtocol(manifest, errors) {
  add(errors, manifest?.schemaVersion === 1, "schemaVersion must equal 1");
  add(errors, typeof manifest?.title === "string" && manifest.title.trim().length > 0, "title is required");
  add(errors, typeof manifest?.project?.owner === "string" && manifest.project.owner.trim().length > 0, "project.owner is required");
  add(errors, typeof manifest?.project?.repository === "string" && manifest.project.repository.trim().length > 0, "project.repository is required");

  const repositories = manifest?.repositories;
  add(errors, Array.isArray(repositories) && repositories.length >= 5, "at least five withheld evaluation repositories are required");
  if (Array.isArray(repositories)) {
    const ids = new Set();
    const commits = new Set();
    const languages = new Set();
    for (const [index, repo] of repositories.entries()) {
      const label = `repositories[${index}]`;
      add(errors, isRecord(repo), `${label} must be an object`);
      if (!isRecord(repo)) continue;
      add(errors, typeof repo.id === "string" && repo.id.trim().length > 0 && !ids.has(repo.id), `${label}.id must be present and unique`);
      if (typeof repo.id === "string") ids.add(repo.id);
      add(errors, typeof repo.language === "string" && repo.language.trim().length > 0, `${label}.language is required`);
      if (typeof repo.language === "string") languages.add(repo.language.toLowerCase());
      checkHash(errors, repo.commitSha256, `${label}.commitSha256`);
      if (HASH.test(repo.commitSha256 ?? "")) {
        add(errors, !commits.has(repo.commitSha256), `${label}.commitSha256 must be unique`);
        commits.add(repo.commitSha256);
      }
      checkHash(errors, repo.environmentDigest, `${label}.environmentDigest`);
      add(errors, repo.withheldFromOptimizer === true, `${label}.withheldFromOptimizer must be true`);
      const budget = repo.budget;
      add(errors, isRecord(budget), `${label}.budget is required`);
      if (!isRecord(budget)) continue;
      checkPositiveInteger(errors, budget.wallClockMs, `${label}.budget.wallClockMs`);
      checkPositiveInteger(errors, budget.agentStarts, `${label}.budget.agentStarts`);
      checkPositiveInteger(errors, budget.evaluatorRuns, `${label}.budget.evaluatorRuns`);
      checkPositiveInteger(errors, budget.maxCostMicrousd, `${label}.budget.maxCostMicrousd`);
      const reserve = budget.independentEvaluationReserve;
      add(errors, isRecord(reserve), `${label}.budget.independentEvaluationReserve is required`);
      if (isRecord(reserve)) {
        checkPositiveInteger(errors, reserve.wallClockMs, `${label}.budget.independentEvaluationReserve.wallClockMs`);
        checkPositiveInteger(errors, reserve.evaluatorRuns, `${label}.budget.independentEvaluationReserve.evaluatorRuns`);
        checkPositiveInteger(errors, reserve.maxCostMicrousd, `${label}.budget.independentEvaluationReserve.maxCostMicrousd`);
        add(errors, reserve.wallClockMs < budget.wallClockMs * 0.25, `${label} budget must leave the judge's reserved wall time inside even the 25% checkpoint`);
        add(errors, reserve.evaluatorRuns >= 4 && reserve.evaluatorRuns < budget.evaluatorRuns * 0.25, `${label} budget must reserve four judge runs while leaving arm evaluator allowance at 25%`);
        add(errors, reserve.maxCostMicrousd < budget.maxCostMicrousd * 0.25, `${label} budget must leave the judge's reserved cost inside even the 25% checkpoint`);
      }
    }
    add(errors, languages.size >= 3, "evaluation repositories must span at least three languages");
  }

  const arms = manifest?.arms;
  add(errors, Array.isArray(arms) && arms.length === TOURNAMENT_ARMS.length, "exactly seven budget-matched arms are required");
  if (Array.isArray(arms)) {
    const byId = new Map();
    for (const [index, arm] of arms.entries()) {
      const label = `arms[${index}]`;
      add(errors, isRecord(arm), `${label} must be an object`);
      if (!isRecord(arm)) continue;
      add(errors, typeof arm.id === "string" && !byId.has(arm.id), `${label}.id must be present and unique`);
      if (typeof arm.id === "string") byId.set(arm.id, arm);
      checkHash(errors, arm.implementationDigest, `${label}.implementationDigest`);
      checkHash(errors, arm.environmentDigest, `${label}.environmentDigest`);
      checkHash(errors, arm.commandDigest, `${label}.commandDigest`);
      add(errors, Array.isArray(arm.command) && arm.command.length > 0 && arm.command.every((part) => typeof part === "string" && part.trim().length > 0), `${label}.command must be a non-empty argv array, not a shell command string`);
      if (Array.isArray(arm.command)) add(errors, sha256(canonical(arm.command)) === arm.commandDigest, `${label}.commandDigest must hash the exact argv array`);
      add(errors, arm.budgetMultiplier === 1, `${label}.budgetMultiplier must equal 1`);
    }
    for (const id of TOURNAMENT_ARMS) add(errors, byId.has(id), `required arm '${id}' is missing`);
  }

  const evaluator = manifest?.independentEvaluator;
  add(errors, isRecord(evaluator), "independentEvaluator is required");
  if (isRecord(evaluator)) {
    add(errors, typeof evaluator.organization === "string" && evaluator.organization.trim().length > 0, "independentEvaluator.organization is required");
    add(errors, evaluator.organization !== manifest?.project?.owner, "independent evaluator must be external to the project owner");
    add(errors, evaluator.controlsHiddenSuites === true, "independentEvaluator.controlsHiddenSuites must be true");
    checkHash(errors, evaluator.signingKeySha256, "independentEvaluator.signingKeySha256");
    checkHash(errors, evaluator.evaluatorBuildDigest, "independentEvaluator.evaluatorBuildDigest");
    checkHash(errors, evaluator.hiddenSuiteManifestCommitment, "independentEvaluator.hiddenSuiteManifestCommitment");
    checkHash(errors, evaluator.sealedPopulationCommitment, "independentEvaluator.sealedPopulationCommitment");
    checkHash(errors, evaluator.canaryManifestCommitment, "independentEvaluator.canaryManifestCommitment");
    add(errors, Array.isArray(evaluator.canaryIds) && evaluator.canaryIds.length > 0, "independentEvaluator.canaryIds must list committed canary identifiers");
    if (Array.isArray(evaluator.canaryIds)) {
      const canaryIds = new Set();
      for (const [index, id] of evaluator.canaryIds.entries()) {
        add(errors, typeof id === "string" && id.trim().length > 0 && !canaryIds.has(id), `independentEvaluator.canaryIds[${index}] must be present and unique`);
        if (typeof id === "string") canaryIds.add(id);
      }
    }
  }

  const execution = manifest?.execution;
  add(errors, isRecord(execution), "execution is required to pin the tournament runner protocol");
  if (isRecord(execution)) {
    add(errors, execution.protocolVersion === 1, "execution.protocolVersion must equal 1");
    add(errors, execution.checkpointMode === "single-run-cumulative-checkpoints", "execution.checkpointMode must use one cumulative arm run with sealed checkpoints");
    add(errors, execution.schedule === "sha256-cell-order-v1", "execution.schedule must equal 'sha256-cell-order-v1'");
    checkHash(errors, execution.sandboxAdapterDigest, "execution.sandboxAdapterDigest");
    add(errors, execution.networkEgress === "deny", "execution.networkEgress must equal 'deny'");
  }

  const development = manifest?.policyDevelopmentPopulation;
  add(errors, Array.isArray(development) && development.length >= 5, "at least five sealed policy-development repository commitments are required");
  if (Array.isArray(development)) {
    const unique = new Set();
    for (const [index, digest] of development.entries()) {
      checkHash(errors, digest, `policyDevelopmentPopulation[${index}]`);
      if (HASH.test(digest ?? "")) {
        add(errors, !unique.has(digest), `policyDevelopmentPopulation[${index}] is duplicated`);
        unique.add(digest);
      }
    }
    const evaluation = new Set((Array.isArray(repositories) ? repositories : [])
      .map((repo) => repo?.commitSha256).filter((value) => HASH.test(value ?? "")));
    for (const digest of unique) add(errors, !evaluation.has(digest), `development repository ${digest} overlaps the evaluation split`);
  }

  const statistics = manifest?.statistics;
  add(errors, isRecord(statistics), "statistics is required");
  if (isRecord(statistics)) {
    add(errors, statistics.unit === "repository", "statistics.unit must be 'repository'");
    add(errors, statistics.confidenceLevel === 0.95, "statistics.confidenceLevel must equal 0.95");
    add(errors, statistics.intervalMethod === "paired-bootstrap", "statistics.intervalMethod must be 'paired-bootstrap'");
    add(errors, statistics.comparisonAlternative === "one-sided-dream-advantage", "statistics.comparisonAlternative must be 'one-sided-dream-advantage'");
    const expectedDirections = { performance: "higher", correctness: "higher", hidden_regressions: "lower", cost: "lower", hit_rate: "higher" };
    add(errors, isRecord(statistics.outcomeDirections), "statistics.outcomeDirections is required");
    if (isRecord(statistics.outcomeDirections)) for (const [outcome, direction] of Object.entries(expectedDirections)) {
      add(errors, statistics.outcomeDirections[outcome] === direction, `statistics.outcomeDirections.${outcome} must be '${direction}'`);
    }
    checkPositiveInteger(errors, statistics.bootstrapReplicates, "statistics.bootstrapReplicates");
    checkPositiveInteger(errors, statistics.bootstrapSeed, "statistics.bootstrapSeed");
    add(errors, Array.isArray(statistics.budgetCheckpoints) && canonical(statistics.budgetCheckpoints) === "[0.25,0.5,0.75,1]", "statistics.budgetCheckpoints must equal [0.25, 0.5, 0.75, 1]");
    add(errors, typeof statistics.reproductionTolerance === "number" && Number.isFinite(statistics.reproductionTolerance) && statistics.reproductionTolerance >= 0, "statistics.reproductionTolerance must be a finite non-negative number");
    add(errors, statistics.multiplicityCorrection === "holm", "statistics.multiplicityCorrection must be 'holm'");
    add(errors, Array.isArray(statistics.outcomes) && statistics.outcomes.length > 0, "statistics.outcomes must list at least one preregistered outcome");
    const outcomes = new Set(Array.isArray(statistics.outcomes) ? statistics.outcomes : []);
    for (const outcome of ["performance", "correctness", "hidden_regressions", "cost", "hit_rate"]) {
      add(errors, outcomes.has(outcome), `statistics.outcomes must include '${outcome}'`);
    }
  }

  const gates = manifest?.passCriteria;
  add(errors, isRecord(gates), "passCriteria is required");
  if (isRecord(gates)) {
    add(errors, gates.minimumImprovementHitRate === 0.6, "minimumImprovementHitRate must equal 0.6");
    add(errors, gates.paretoDominatesEveryArm === true, "paretoDominatesEveryArm must be true");
    add(errors, gates.zeroUnverifiableApplies === true, "zeroUnverifiableApplies must be true");
    add(errors, gates.zeroHiddenRegressions === true, "zeroHiddenRegressions must be true");
    add(errors, gates.seededCanaryDetectionRate === 1, "seededCanaryDetectionRate must equal 1");
    add(errors, gates.freshProcessReproductionForEveryWin === true, "freshProcessReproductionForEveryWin must be true");
    add(errors, gates.sealedPopulationScoreMustRise === true, "sealedPopulationScoreMustRise must be true");
  }

  const ablationList = manifest?.ablations;
  add(errors, Array.isArray(ablationList), "ablations must be an array");
  const safeAblations = Array.isArray(ablationList) ? ablationList : [];
  const ablations = new Set(safeAblations.map((item) => item?.mechanism));
  for (const mechanism of REQUIRED_ABLATIONS) add(errors, ablations.has(mechanism), `required ablation '${mechanism}' is missing`);
  for (const mechanism of REQUIRED_ABLATIONS) {
    const item = safeAblations.find((candidate) => candidate?.mechanism === mechanism);
    add(errors, isRecord(item) && typeof item.expectedOutcome === "string" && item.expectedOutcome.trim().length > 0, `ablation '${mechanism}' needs a preregistered expected outcome`);
    add(errors, isRecord(item) && item.metric === "performance", `ablation '${mechanism}' must use the preregistered performance metric`);
  }

  const homeBenchmarks = manifest?.homeBenchmarks;
  add(errors, isRecord(homeBenchmarks), "homeBenchmarks is required");
  if (isRecord(homeBenchmarks)) for (const benchmark of REQUIRED_HOME_BENCHMARKS) {
    const entry = homeBenchmarks[benchmark];
    add(errors, isRecord(entry), `home benchmark '${benchmark}' is missing`);
    if (isRecord(entry)) {
      add(errors, typeof entry.name === "string" && entry.name.trim().length > 0, `home benchmark '${benchmark}' needs a name`);
      add(errors, entry.armId === HOME_BENCHMARK_ARMS[benchmark], `home benchmark '${benchmark}' must use arm '${HOME_BENCHMARK_ARMS[benchmark]}'`);
      add(errors, Array.isArray(entry.runCommand) && entry.runCommand.length > 0 && entry.runCommand.every((part) => typeof part === "string" && part.trim().length > 0), `home benchmark '${benchmark}' needs an exact shell-free runCommand argv array`);
      checkHash(errors, entry.baselineDigest, `home benchmark '${benchmark}'.baselineDigest`);
      checkHash(errors, entry.environmentDigest, `home benchmark '${benchmark}'.environmentDigest`);
    }
  }

  const reporting = manifest?.reporting;
  add(errors, isRecord(reporting), "reporting is required");
  if (isRecord(reporting)) {
    add(errors, reporting.includesLossCases === true, "reporting.includesLossCases must be true");
    add(errors, reporting.includesCostHitRateCurve === true, "reporting.includesCostHitRateCurve must be true");
    add(errors, reporting.includesExactReproductionCommands === true, "reporting.includesExactReproductionCommands must be true");
  }
}

function inspectRegistration(manifest, trustedRegistryKeyPem, errors) {
  const receipt = manifest?.registration;
  add(errors, isRecord(receipt), "registration receipt is required; local validation alone is not preregistration");
  if (!isRecord(receipt)) return null;
  add(errors, typeof receipt.url === "string" && /^https:\/\//.test(receipt.url), "registration.url must be an immutable HTTPS registration URL");
  const timestamp = typeof receipt.registeredAt === "string" ? Date.parse(receipt.registeredAt) : Number.NaN;
  add(errors, Number.isFinite(timestamp), "registration.registeredAt must be an ISO timestamp");
  const digest = preregistrationDigest(manifest);
  add(errors, receipt.digest === digest, "registration.digest does not match the canonical preregistration content");
  if (typeof receipt.registryKeySha256 !== "string" || !HASH.test(receipt.registryKeySha256)) {
    errors.push("registration.registryKeySha256 must be a lowercase SHA-256 digest");
  }
  if (!trustedRegistryKeyPem) {
    errors.push("a trusted registry public key must be supplied out of band");
    return digest;
  }
  try {
    const key = crypto.createPublicKey(trustedRegistryKeyPem);
    const keyDigest = sha256(key.export({ format: "der", type: "spki" }));
    add(errors, receipt.registryKeySha256 === keyDigest, "registration registry key does not match the out-of-band trust anchor");
    add(errors, typeof receipt.signatureBase64 === "string", "registration.signatureBase64 must be a base64 string");
    const signature = Buffer.from(typeof receipt.signatureBase64 === "string" ? receipt.signatureBase64 : "", "base64");
    add(errors, signature.length > 0, "registration.signatureBase64 is required");
    if (signature.length > 0 && receipt.url && Number.isFinite(timestamp)) {
      const message = preregistrationReceiptMessage({ digest, registeredAt: receipt.registeredAt, url: receipt.url });
      add(errors, crypto.verify(null, Buffer.from(message), key, signature), "external preregistration signature is invalid");
    }
  } catch (error) {
    errors.push(`trusted registry public key could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return digest;
}

export function auditTournamentPreregistration(manifest, { trustedRegistryKeyPem } = {}) {
  const errors = [];
  if (!isRecord(manifest)) return { valid: false, errors: ["preregistration document must be a JSON object"], digest: null };
  inspectProtocol(manifest, errors);
  const digest = inspectRegistration(manifest, trustedRegistryKeyPem, errors);
  return { valid: errors.length === 0, errors, digest };
}

function main(argv) {
  if (argv.length !== 2) {
    process.stderr.write("Usage: node eval/tournament/preregistration.mjs <manifest.json> <trusted-registry-public-key.pem>\n");
    return 2;
  }
  const [manifestPath, publicKeyPath] = argv.map((entry) => path.resolve(entry));
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const trustedRegistryKeyPem = fs.readFileSync(publicKeyPath, "utf8");
    const result = auditTournamentPreregistration(manifest, { trustedRegistryKeyPem });
    if (!result.valid) {
      process.stderr.write(`NOT REGISTERED (${result.errors.length} issue(s))\n`);
      for (const error of result.errors) process.stderr.write(`- ${error}\n`);
      return 1;
    }
    process.stdout.write(`REGISTERED PREREGISTRATION ${result.digest}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`NOT REGISTERED: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
