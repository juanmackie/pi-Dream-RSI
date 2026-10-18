#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  auditTournamentPreregistration,
  HOME_BENCHMARK_ARMS,
  preregistrationDigest,
  REQUIRED_ABLATIONS,
  REQUIRED_HOME_BENCHMARKS,
  TOURNAMENT_ARMS,
} from "./preregistration.mjs";

const HASH = /^[a-f0-9]{64}$/;
const RESULT_DOMAIN = "dream-rsi-tournament-results-v1";
const CHECKPOINTS = [0.25, 0.5, 0.75, 1];
const OUTCOMES = ["performance", "correctness", "hidden_regressions", "cost", "hit_rate"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resultCore(report) {
  const { receipt: _receipt, ...core } = report;
  return core;
}

export function tournamentResultMessage(report) {
  return `${RESULT_DOMAIN}\n${report.preregistrationDigest}\n${canonical(resultCore(report))}`;
}

export function createTournamentResultReceipt(report, privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  const keySha256 = sha256(publicKey.export({ format: "der", type: "spki" }));
  const signatureBase64 = crypto.sign(null, Buffer.from(tournamentResultMessage(report)), privateKey).toString("base64");
  return { evaluatorKeySha256: keySha256, signatureBase64 };
}

function add(errors, condition, message) {
  if (!condition) errors.push(message);
}

function finite(errors, value, label, { minimum = -Infinity } = {}) {
  add(errors, typeof value === "number" && Number.isFinite(value) && value >= minimum, `${label} must be a finite number >= ${minimum}`);
}

function positiveInteger(errors, value, label) {
  add(errors, Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
}

function evaluatorKeyDigest(pem) {
  const key = crypto.createPublicKey(pem);
  return sha256(key.export({ format: "der", type: "spki" }));
}

function verifyReceipt(report, preregistration, evaluatorPublicKeyPem, errors) {
  const receipt = report?.receipt;
  add(errors, isRecord(receipt), "signed evaluator receipt is required");
  if (!isRecord(receipt)) return;
  if (!evaluatorPublicKeyPem) {
    errors.push("an evaluator public key must be supplied out of band");
    return;
  }
  try {
    const key = crypto.createPublicKey(evaluatorPublicKeyPem);
    const keySha256 = evaluatorKeyDigest(evaluatorPublicKeyPem);
    add(errors, keySha256 === preregistration.independentEvaluator.signingKeySha256, "evaluator key does not match the preregistered trust anchor");
    add(errors, receipt.evaluatorKeySha256 === keySha256, "receipt evaluator key fingerprint does not match the supplied key");
    add(errors, typeof receipt.signatureBase64 === "string", "receipt.signatureBase64 must be a base64 string");
    const signature = Buffer.from(typeof receipt.signatureBase64 === "string" ? receipt.signatureBase64 : "", "base64");
    add(errors, signature.length > 0, "receipt signature is required");
    if (signature.length > 0) {
      add(errors, crypto.verify(null, Buffer.from(tournamentResultMessage(report)), key, signature), "external evaluator signature is invalid");
    }
  } catch (error) {
    errors.push(`evaluator public key could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function makeRandom(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function bootstrapMeans(values, replicates, seed) {
  const random = makeRandom(seed);
  const means = new Array(replicates);
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) total += values[Math.floor(random() * values.length)];
    means[replicate] = total / values.length;
  }
  means.sort((a, b) => a - b);
  return means;
}

function stableSeed(seed, label) {
  let mixed = seed >>> 0;
  for (const character of label) mixed = Math.imul(mixed ^ character.charCodeAt(0), 0x45d9f3b) >>> 0;
  return mixed || 1;
}

function inspectResultShape(report, preregistration, errors) {
  add(errors, isRecord(report), "result document must be a JSON object");
  if (!isRecord(report)) return null;
  add(errors, report.schemaVersion === 1, "result schemaVersion must equal 1");
  add(errors, report.preregistrationDigest === preregistrationDigest(preregistration), "result does not bind to the audited preregistration digest");

  const declaredEvaluator = report.evaluator;
  add(errors, isRecord(declaredEvaluator), "result evaluator metadata is required");
  if (isRecord(declaredEvaluator)) {
    add(errors, declaredEvaluator.organization === preregistration.independentEvaluator.organization, "result evaluator organization differs from preregistration");
    add(errors, declaredEvaluator.signingKeySha256 === preregistration.independentEvaluator.signingKeySha256, "result evaluator key fingerprint differs from preregistration");
    add(errors, declaredEvaluator.evaluatorBuildDigest === preregistration.independentEvaluator.evaluatorBuildDigest, "result evaluator build differs from preregistration");
    add(errors, declaredEvaluator.hiddenSuiteManifestCommitment === preregistration.independentEvaluator.hiddenSuiteManifestCommitment, "result hidden-suite commitment differs from preregistration");
    add(errors, declaredEvaluator.sealedPopulationCommitment === preregistration.independentEvaluator.sealedPopulationCommitment, "result sealed-population commitment differs from preregistration");
  }

  const repositories = preregistration.repositories;
  const repoById = new Map(repositories.map((repo) => [repo.id, repo]));
  const expectedCells = new Set();
  for (const repo of repositories) for (const armId of TOURNAMENT_ARMS) for (const checkpoint of CHECKPOINTS) {
    expectedCells.add(`${repo.id}\0${armId}\0${checkpoint}`);
  }
  const seenCells = new Set();
  const baselineByRepo = new Map();
  const rowsByRepoArm = new Map();
  const armById = new Map(preregistration.arms.map((arm) => [arm.id, arm]));
  const observations = Array.isArray(report.observations) ? report.observations : [];
  add(errors, Array.isArray(report.observations), "observations must be an array");
  for (const [index, observation] of observations.entries()) {
    const label = `observations[${index}]`;
    add(errors, isRecord(observation), `${label} must be an object`);
    if (!isRecord(observation)) continue;
    const repoId = observation.repositoryId;
    const armId = observation.armId;
    const fraction = observation.budgetFraction;
    const key = `${repoId}\0${armId}\0${fraction}`;
    add(errors, expectedCells.has(key), `${label} is outside the preregistered repository/arm/checkpoint matrix`);
    add(errors, !seenCells.has(key), `${label} duplicates a repository/arm/checkpoint observation`);
    seenCells.add(key);
    add(errors, repoById.has(repoId), `${label}.repositoryId is not in the held-out population`);
    add(errors, TOURNAMENT_ARMS.includes(armId), `${label}.armId is not a pinned arm`);
    finite(errors, fraction, `${label}.budgetFraction`, { minimum: 0 });
    add(errors, CHECKPOINTS.includes(fraction), `${label}.budgetFraction is not a preregistered checkpoint`);
    if (repoById.has(repoId)) {
      add(errors, observation.repositoryCommitSha256 === repoById.get(repoId).commitSha256, `${label} ran a different repository commit`);
      add(errors, observation.repositoryEnvironmentDigest === repoById.get(repoId).environmentDigest, `${label} ran in a different repository environment`);
    }
    if (armById.has(armId)) {
      add(errors, observation.armImplementationDigest === armById.get(armId).implementationDigest, `${label} ran a different arm implementation`);
      add(errors, observation.armEnvironmentDigest === armById.get(armId).environmentDigest, `${label} ran in a different arm environment`);
      add(errors, observation.armCommandDigest === armById.get(armId).commandDigest, `${label} ran a different arm command`);
    }
    finite(errors, observation.performanceScore, `${label}.performanceScore`);
    finite(errors, observation.baselinePerformanceScore, `${label}.baselinePerformanceScore`);
    if (repoById.has(repoId) && Number.isFinite(observation.baselinePerformanceScore)) {
      const previousBaseline = baselineByRepo.get(repoId);
      if (previousBaseline !== undefined) add(errors, previousBaseline === observation.baselinePerformanceScore, `${label}.baselinePerformanceScore changes across arms or checkpoints`);
      baselineByRepo.set(repoId, observation.baselinePerformanceScore);
    }
    finite(errors, observation.correctnessScore, `${label}.correctnessScore`, { minimum: 0 });
    add(errors, observation.correctnessScore <= 1, `${label}.correctnessScore must be <= 1`);
    add(errors, Number.isSafeInteger(observation.hiddenRegressionCount) && observation.hiddenRegressionCount >= 0, `${label}.hiddenRegressionCount must be a non-negative safe integer`);
    add(errors, Number.isSafeInteger(observation.costMicrousd) && observation.costMicrousd >= 0, `${label}.costMicrousd must be a non-negative safe integer`);
    if (repoById.has(repoId)) {
      const budget = repoById.get(repoId).budget;
      add(errors, observation.costMicrousd <= budget.maxCostMicrousd * fraction, `${label} exceeds its repository cost allowance at this checkpoint`);
      add(errors, Number.isSafeInteger(observation.cumulativeWallClockMs) && observation.cumulativeWallClockMs >= 0, `${label}.cumulativeWallClockMs must be a non-negative safe integer`);
      add(errors, Number.isSafeInteger(observation.agentStarts) && observation.agentStarts >= 0, `${label}.agentStarts must be a non-negative safe integer`);
      add(errors, Number.isSafeInteger(observation.evaluatorRuns) && observation.evaluatorRuns >= 0, `${label}.evaluatorRuns must be a non-negative safe integer`);
      add(errors, observation.cumulativeWallClockMs <= budget.wallClockMs * fraction, `${label} exceeds its repository wall-clock allowance at this checkpoint`);
      add(errors, observation.agentStarts <= budget.agentStarts * fraction, `${label} exceeds its repository agent-start allowance at this checkpoint`);
      add(errors, observation.evaluatorRuns <= budget.evaluatorRuns * fraction, `${label} exceeds its repository evaluator-run allowance at this checkpoint`);
    }
    const seriesKey = `${repoId}\0${armId}`;
    const series = rowsByRepoArm.get(seriesKey) ?? [];
    series.push(observation);
    rowsByRepoArm.set(seriesKey, series);
  }
  for (const cell of expectedCells) add(errors, seenCells.has(cell), `missing observation '${cell.replaceAll("\0", "/")}'`);
  for (const [seriesKey, series] of rowsByRepoArm) {
    series.sort((a, b) => a.budgetFraction - b.budgetFraction);
    for (let index = 1; index < series.length; index += 1) {
      add(errors, series[index].costMicrousd >= series[index - 1].costMicrousd, `cumulative cost decreases in '${seriesKey.replaceAll("\0", "/")}'`);
      add(errors, series[index].cumulativeWallClockMs >= series[index - 1].cumulativeWallClockMs, `cumulative wall-clock time decreases in '${seriesKey.replaceAll("\0", "/")}'`);
      add(errors, series[index].agentStarts >= series[index - 1].agentStarts, `cumulative agent starts decrease in '${seriesKey.replaceAll("\0", "/")}'`);
      add(errors, series[index].evaluatorRuns >= series[index - 1].evaluatorRuns, `cumulative evaluator runs decrease in '${seriesKey.replaceAll("\0", "/")}'`);
    }
  }

  const applies = Array.isArray(report.applies) ? report.applies : [];
  add(errors, Array.isArray(report.applies), "applies must be an array");
  const applyKeys = new Set();
  for (const [index, apply] of applies.entries()) {
    const label = `applies[${index}]`;
    add(errors, isRecord(apply), `${label} must be an object`);
    if (!isRecord(apply)) continue;
    for (const field of ["artifactDigest", "ledgerHeadDigest", "evaluatorEvidenceDigest"]) {
      add(errors, typeof apply[field] === "string" && HASH.test(apply[field]), `${label}.${field} must be a lowercase SHA-256 digest`);
    }
    add(errors, repoById.has(apply.repositoryId), `${label}.repositoryId is not in the held-out population`);
    add(errors, TOURNAMENT_ARMS.includes(apply.armId), `${label}.armId is not a pinned arm`);
    const applyKey = `${apply.repositoryId}\0${apply.armId}`;
    add(errors, !applyKeys.has(applyKey), `${label} duplicates an apply`);
    applyKeys.add(applyKey);
    add(errors, apply.independentlyVerifiable === true, `${label} is not independently verifiable`);
    add(errors, apply.armId === "dream_rsi_2", `${label} is not a Dream-RSI apply`);
    const winningRow = observations.find((row) => row?.repositoryId === apply.repositoryId && row?.armId === apply.armId && row?.budgetFraction === 1);
    add(errors, Boolean(winningRow && winningRow.performanceScore > winningRow.baselinePerformanceScore), `${label} has no independently measured winning observation`);
  }

  const canaryDetections = Array.isArray(report.canaryDetections) ? report.canaryDetections : [];
  add(errors, Array.isArray(report.canaryDetections), "canaryDetections must be an array");
  const expectedCanaries = new Set(preregistration.independentEvaluator.canaryIds);
  const detectedCanaries = new Set();
  for (const [index, item] of canaryDetections.entries()) {
    add(errors, isRecord(item), `canaryDetections[${index}] must be an object`);
    if (!isRecord(item)) continue;
    add(errors, expectedCanaries.has(item.id), `canaryDetections[${index}] has an uncommitted canary id`);
    add(errors, !detectedCanaries.has(item.id), `canaryDetections[${index}] duplicates a canary id`);
    detectedCanaries.add(item.id);
    add(errors, item.detected === true, `seeded canary '${item.id}' was not detected`);
  }
  for (const id of expectedCanaries) add(errors, detectedCanaries.has(id), `missing seeded-canary result '${id}'`);

  const finalRows = observations.filter((row) => row?.budgetFraction === 1);
  const wins = finalRows.filter((row) => row?.armId === "dream_rsi_2" && row.performanceScore > row.baselinePerformanceScore);
  const reproductions = Array.isArray(report.freshProcessReproductions) ? report.freshProcessReproductions : [];
  add(errors, Array.isArray(report.freshProcessReproductions), "freshProcessReproductions must be an array");
  const reproductionByKey = new Map();
  for (const [index, reproduction] of reproductions.entries()) {
    add(errors, isRecord(reproduction), `freshProcessReproductions[${index}] must be an object`);
    if (!isRecord(reproduction)) continue;
    const key = `${reproduction.repositoryId}\0${reproduction.armId}`;
    add(errors, !reproductionByKey.has(key), `freshProcessReproductions[${index}] duplicates a reproduction`);
    reproductionByKey.set(key, reproduction);
    add(errors, reproduction.freshProcess === true && reproduction.independent === true, `freshProcessReproductions[${index}] must be independent and run in a fresh process`);
    add(errors, typeof reproduction.artifactDigest === "string" && HASH.test(reproduction.artifactDigest), `freshProcessReproductions[${index}].artifactDigest must be a lowercase SHA-256 digest`);
    finite(errors, reproduction.score, `freshProcessReproductions[${index}].score`);
  }
  for (const win of wins) {
    const key = `${win.repositoryId}\0dream_rsi_2`;
    const reproduction = reproductionByKey.get(key);
    const apply = applies.find((item) => item?.repositoryId === win.repositoryId && item?.armId === "dream_rsi_2");
    add(errors, Boolean(reproduction), `win on '${win.repositoryId}' has no fresh-process reproduction`);
    add(errors, Boolean(apply), `win on '${win.repositoryId}' has no recorded apply`);
    if (reproduction && apply) {
      add(errors, reproduction.artifactDigest === apply.artifactDigest, `win on '${win.repositoryId}' reproduced a different artifact`);
      add(errors, Math.abs(reproduction.score - win.performanceScore) <= preregistration.statistics.reproductionTolerance, `win on '${win.repositoryId}' exceeds reproduction tolerance`);
    }
  }

  const winKeys = new Set(wins.map((win) => `${win.repositoryId}\0dream_rsi_2`));
  for (const apply of applies) add(errors, winKeys.has(`${apply?.repositoryId}\0${apply?.armId}`), "an apply has no corresponding verified Dream-RSI win");
  add(errors, applies.length === wins.length, "every Dream-RSI win must have exactly one recorded apply");

  const finalByRepoArm = new Map(finalRows.map((row) => [`${row.repositoryId}\0${row.armId}`, row]));
  const requiredLossCases = new Map();
  for (const repo of repositories) {
    const dream = finalByRepoArm.get(`${repo.id}\0dream_rsi_2`);
    if (!dream) continue;
    if (dream.performanceScore <= dream.baselinePerformanceScore) {
      requiredLossCases.set(`${repo.id}\0baseline`, { repositoryId: repo.id, armId: "baseline", comparisonScore: dream.baselinePerformanceScore });
    }
    for (const armId of TOURNAMENT_ARMS.filter((id) => id !== "dream_rsi_2")) {
      const competitor = finalByRepoArm.get(`${repo.id}\0${armId}`);
      if (competitor && dream.performanceScore < competitor.performanceScore) {
        requiredLossCases.set(`${repo.id}\0${armId}`, { repositoryId: repo.id, armId, comparisonScore: competitor.performanceScore });
      }
    }
  }
  add(errors, Array.isArray(report.lossCases), "lossCases must be an array");
  const suppliedLossCases = Array.isArray(report.lossCases) ? report.lossCases : [];
  const seenLossCases = new Set();
  for (const [index, loss] of suppliedLossCases.entries()) {
    add(errors, isRecord(loss), `lossCases[${index}] must be an object`);
    if (!isRecord(loss)) continue;
    const key = `${loss.repositoryId}\0${loss.armId}`;
    add(errors, !seenLossCases.has(key), `lossCases[${index}] duplicates a loss case`);
    seenLossCases.add(key);
    const expected = requiredLossCases.get(key);
    add(errors, Boolean(expected), `lossCases[${index}] does not correspond to a measured Dream-RSI loss`);
    add(errors, typeof loss.reason === "string" && loss.reason.trim().length > 0, `lossCases[${index}].reason is required`);
    if (expected) {
      const dream = finalByRepoArm.get(`${expected.repositoryId}\0dream_rsi_2`);
      add(errors, loss.dreamPerformanceScore === dream.performanceScore, `lossCases[${index}].dreamPerformanceScore differs from evaluator results`);
      add(errors, loss.comparisonScore === expected.comparisonScore, `lossCases[${index}].comparisonScore differs from evaluator results`);
    }
  }
  for (const key of requiredLossCases.keys()) add(errors, seenLossCases.has(key), `missing measured loss case '${key.replaceAll("\0", "/")}'`);

  const generations = Array.isArray(report.policyGenerations) ? report.policyGenerations : [];
  add(errors, Array.isArray(report.policyGenerations), "policyGenerations must be an array");
  add(errors, generations.length >= 2, "at least two sealed-population policy generations are required");
  let previousGeneration = -1;
  let previousScore = -Infinity;
  for (const [index, generation] of generations.entries()) {
    add(errors, isRecord(generation), `policyGenerations[${index}] must be an object`);
    if (!isRecord(generation)) continue;
    positiveInteger(errors, generation.generation, `policyGenerations[${index}].generation`);
    finite(errors, generation.sealedPopulationScore, `policyGenerations[${index}].sealedPopulationScore`);
    add(errors, generation.generation > previousGeneration, "policy generations must be in increasing order");
    add(errors, generation.sealedPopulationScore > previousScore, "sealed-population score must rise each generation");
    add(errors, generation.evaluatedByIndependentJudge === true, `policyGenerations[${index}] lacks independent judge evidence`);
    previousGeneration = generation.generation;
    previousScore = generation.sealedPopulationScore;
  }

  const ablations = Array.isArray(report.ablations) ? report.ablations : [];
  add(errors, Array.isArray(report.ablations), "ablations must be an array");
  const ablationByMechanism = new Map();
  for (const [index, ablation] of ablations.entries()) {
    add(errors, isRecord(ablation), `ablations[${index}] must be an object`);
    if (!isRecord(ablation)) continue;
    add(errors, !ablationByMechanism.has(ablation.mechanism), `ablations[${index}] duplicates a mechanism`);
    ablationByMechanism.set(ablation.mechanism, ablation);
    add(errors, ablation.metric === "performance", `ablations[${index}] must report the preregistered performance metric`);
  }
  for (const mechanism of REQUIRED_ABLATIONS) {
    const ablation = ablationByMechanism.get(mechanism);
    add(errors, Boolean(ablation), `missing ablation result '${mechanism}'`);
    if (!ablation) continue;
    for (const field of ["fullScores", "ablatedScores"]) {
      add(errors, Array.isArray(ablation[field]) && ablation[field].length === repositories.length, `ablation '${mechanism}'.${field} must cover every evaluation repository`);
      if (Array.isArray(ablation[field])) {
        const ids = new Set();
        for (const [scoreIndex, entry] of ablation[field].entries()) {
          add(errors, isRecord(entry) && repoById.has(entry.repositoryId), `ablation '${mechanism}'.${field}[${scoreIndex}] needs a held-out repository`);
          if (!isRecord(entry)) continue;
          add(errors, !ids.has(entry.repositoryId), `ablation '${mechanism}'.${field} duplicates a repository`);
          ids.add(entry.repositoryId);
          finite(errors, entry.score, `ablation '${mechanism}'.${field}[${scoreIndex}].score`);
        }
        add(errors, ids.size === repositories.length, `ablation '${mechanism}'.${field} must identify every held-out repository`);
      }
    }
  }

  const homeBenchmarks = report.homeBenchmarks;
  add(errors, isRecord(homeBenchmarks), "homeBenchmarks result object is required");
  if (isRecord(homeBenchmarks)) for (const benchmark of REQUIRED_HOME_BENCHMARKS) {
    const result = homeBenchmarks[benchmark];
    add(errors, isRecord(result), `missing home-benchmark result '${benchmark}'`);
    if (!isRecord(result)) continue;
    add(errors, result.armId === HOME_BENCHMARK_ARMS[benchmark], `home benchmark '${benchmark}' used the wrong arm`);
    add(errors, Array.isArray(result.runCommand) && canonical(result.runCommand) === canonical(preregistration.homeBenchmarks[benchmark].runCommand), `home benchmark '${benchmark}' argv differs from preregistration`);
    add(errors, result.baselineDigest === preregistration.homeBenchmarks[benchmark].baselineDigest, `home benchmark '${benchmark}' baseline digest differs from preregistration`);
    add(errors, result.environmentDigest === preregistration.homeBenchmarks[benchmark].environmentDigest, `home benchmark '${benchmark}' environment digest differs from preregistration`);
    finite(errors, result.score, `homeBenchmarks.${benchmark}.score`);
    finite(errors, result.baselineScore, `homeBenchmarks.${benchmark}.baselineScore`);
    add(errors, result.score >= result.baselineScore, `home benchmark '${benchmark}' did not match or beat baseline`);
  }

  add(errors, Array.isArray(report.reproductionCommands) && report.reproductionCommands.length === repositories.length * TOURNAMENT_ARMS.length, "reproductionCommands must list one exact command per repository and arm");
  const commandCells = new Set();
  if (Array.isArray(report.reproductionCommands)) for (const [index, item] of report.reproductionCommands.entries()) {
    add(errors, isRecord(item) && Array.isArray(item.argv) && item.argv.length > 0 && item.argv.every((part) => typeof part === "string" && part.trim().length > 0), `reproductionCommands[${index}] needs an exact argv array`);
    if (!isRecord(item)) continue;
    const key = `${item.repositoryId}\0${item.armId}`;
    commandCells.add(key);
    add(errors, repoById.has(item.repositoryId), `reproductionCommands[${index}] has an unknown repository`);
    add(errors, armById.has(item.armId), `reproductionCommands[${index}] has an unknown arm`);
    if (armById.has(item.armId)) {
      add(errors, Array.isArray(item.argv) && canonical(item.argv) === canonical(armById.get(item.armId).command), `reproductionCommands[${index}] differs from the pinned arm command`);
      if (Array.isArray(item.argv)) add(errors, sha256(canonical(item.argv)) === armById.get(item.armId).commandDigest, `reproductionCommands[${index}] command digest differs from preregistration`);
    }
  }
  for (const repo of repositories) for (const armId of TOURNAMENT_ARMS) add(errors, commandCells.has(`${repo.id}\0${armId}`), `missing reproduction command for '${repo.id}/${armId}'`);
  return { observations, wins, applies, finalRows };
}

function summarize(report, preregistration, validated, errors) {
  const canaryRecords = Array.isArray(report.canaryDetections) ? report.canaryDetections : [];
  const reproductionRecords = Array.isArray(report.freshProcessReproductions) ? report.freshProcessReproductions : [];
  const policyGenerations = Array.isArray(report.policyGenerations) ? report.policyGenerations : [];
  const ablationRecords = Array.isArray(report.ablations) ? report.ablations : [];
  const homeBenchmarkResults = isRecord(report.homeBenchmarks) ? report.homeBenchmarks : {};
  const checkpoints = new Map();
  for (const row of validated.observations) {
    if (!isRecord(row) || !CHECKPOINTS.includes(row.budgetFraction)) continue;
    const key = `${row.armId}@${row.budgetFraction}`;
    const entry = checkpoints.get(key) ?? { armId: row.armId, budgetFraction: row.budgetFraction, costMicrousd: 0, wins: 0, repositories: 0 };
    entry.costMicrousd += Number.isFinite(row.costMicrousd) ? row.costMicrousd : 0;
    entry.repositories += 1;
    if (row.performanceScore > row.baselinePerformanceScore) entry.wins += 1;
    checkpoints.set(key, entry);
  }
  const budgetHitCurve = [...checkpoints.values()].sort((a, b) => TOURNAMENT_ARMS.indexOf(a.armId) - TOURNAMENT_ARMS.indexOf(b.armId) || a.budgetFraction - b.budgetFraction)
    .map((entry) => ({ ...entry, hitRate: entry.repositories ? entry.wins / entry.repositories : 0 }));

  const byRepoArm = new Map();
  for (const row of validated.finalRows) byRepoArm.set(`${row.repositoryId}\0${row.armId}`, row);
  const confidence = preregistration.statistics.confidenceLevel;
  const replicates = preregistration.statistics.bootstrapReplicates;
  const seed = preregistration.statistics.bootstrapSeed;
  const comparisons = [];
  for (const armId of TOURNAMENT_ARMS.filter((id) => id !== "dream_rsi_2")) {
    for (const outcome of OUTCOMES) {
      const differences = [];
      for (const repo of preregistration.repositories) {
        const dream = byRepoArm.get(`${repo.id}\0dream_rsi_2`);
        const other = byRepoArm.get(`${repo.id}\0${armId}`);
        if (!dream || !other) continue;
        const dreamHit = dream.performanceScore > dream.baselinePerformanceScore ? 1 : 0;
        const otherHit = other.performanceScore > other.baselinePerformanceScore ? 1 : 0;
        const value = outcome === "performance" ? dream.performanceScore - other.performanceScore
          : outcome === "correctness" ? dream.correctnessScore - other.correctnessScore
            : outcome === "hidden_regressions" ? other.hiddenRegressionCount - dream.hiddenRegressionCount
              : outcome === "cost" ? other.costMicrousd - dream.costMicrousd
                : dreamHit - otherHit;
        differences.push(value);
      }
      if (differences.length !== preregistration.repositories.length) continue;
      const label = `${armId}:${outcome}`;
      comparisons.push({ armId, outcome, differences, samples: bootstrapMeans(differences, replicates, stableSeed(seed, label)) });
    }
  }
  const ordered = comparisons.map((comparison) => {
    const observed = comparison.differences.reduce((total, value) => total + value, 0) / comparison.differences.length;
    let extreme = 0;
    for (const sample of comparison.samples) if (sample - observed <= -observed) extreme += 1;
    return { ...comparison, observed, pValue: (extreme + 1) / (comparison.samples.length + 1) };
  }).sort((a, b) => a.pValue - b.pValue);
  let stillRejecting = true;
  for (const [rank, comparison] of ordered.entries()) {
    const familyAlpha = (1 - confidence) / (ordered.length - rank);
    const lower = percentile(comparison.samples, familyAlpha);
    const pass = stillRejecting && comparison.pValue <= familyAlpha && lower >= 0;
    if (!(stillRejecting && comparison.pValue <= familyAlpha)) stillRejecting = false;
    comparison.lower = lower;
    comparison.upper = percentile(comparison.samples, 1 - familyAlpha);
    comparison.holmSupported = pass;
  }
  const pareto = {};
  for (const armId of TOURNAMENT_ARMS.filter((id) => id !== "dream_rsi_2")) {
    const armComparisons = ordered.filter((item) => item.armId === armId);
    pareto[armId] = {
      outcomes: Object.fromEntries(armComparisons.map(({ outcome, observed, lower, upper, pValue, holmSupported, samples }) => [outcome, {
        meanDifferenceDreamAdvantage: observed,
        paired95Lower: percentile(samples, (1 - confidence) / 2),
        paired95Upper: percentile(samples, 1 - (1 - confidence) / 2),
        holmStepDownLowerBound: lower,
        holmStepDownUpperBound: upper,
        pValue,
        holmSupported,
      }])),
      dominates: armComparisons.length === OUTCOMES.length
        && armComparisons.every((item) => item.lower >= 0)
        && armComparisons.some((item) => item.holmSupported && item.observed > 0),
    };
  }

  const ablationTests = [];
  for (const mechanism of REQUIRED_ABLATIONS) {
    const ablation = ablationRecords.find((item) => item?.mechanism === mechanism);
    if (!ablation || !Array.isArray(ablation.fullScores) || !Array.isArray(ablation.ablatedScores)) continue;
    const fullByRepo = new Map(ablation.fullScores.map((entry) => [entry?.repositoryId, entry?.score]));
    const ablatedByRepo = new Map(ablation.ablatedScores.map((entry) => [entry?.repositoryId, entry?.score]));
    const differences = preregistration.repositories.map((repo) => fullByRepo.get(repo.id) - ablatedByRepo.get(repo.id));
    if (!differences.every(Number.isFinite)) continue;
    const observed = differences.reduce((total, value) => total + value, 0) / differences.length;
    const samples = bootstrapMeans(differences, replicates, stableSeed(seed, `ablation:${mechanism}`));
    let extreme = 0;
    for (const sample of samples) if (sample <= 0) extreme += 1;
    ablationTests.push({ mechanism, observed, pValue: (extreme + 1) / (samples.length + 1), samples });
  }
  ablationTests.sort((a, b) => a.pValue - b.pValue);
  let ablationStepDown = true;
  for (const [rank, item] of ablationTests.entries()) {
    const alpha = (1 - confidence) / (ablationTests.length - rank);
    item.lower = percentile(item.samples, alpha);
    item.upper = percentile(item.samples, 1 - alpha);
    item.holmSupported = ablationStepDown && item.pValue <= alpha && item.lower > 0;
    if (!(ablationStepDown && item.pValue <= alpha)) ablationStepDown = false;
  }
  const ablationsPass = ablationTests.length === REQUIRED_ABLATIONS.length && ablationTests.every((item) => item.holmSupported);

  const hitRate = validated.wins.length / preregistration.repositories.length;
  const zeroHiddenRegressions = validated.observations.every((row) => row?.hiddenRegressionCount === 0);
  const canaryCount = preregistration.independentEvaluator.canaryIds.length;
  const canaryDetected = new Set(canaryRecords.filter((item) => item?.detected === true).map((item) => item.id)).size;
  const allArmsDominated = Object.values(pareto).every((comparison) => comparison.dominates);
  const allAppliesVerifiable = validated.applies.every((apply) => apply?.independentlyVerifiable === true);
  const pass = errors.length === 0
    && hitRate >= preregistration.passCriteria.minimumImprovementHitRate
    && zeroHiddenRegressions
    && canaryDetected === canaryCount
    && allArmsDominated
    && allAppliesVerifiable
    && validated.wins.every((win) => reproductionRecords.some((item) => item?.repositoryId === win.repositoryId && item?.armId === "dream_rsi_2" && item?.freshProcess && item?.independent))
    && policyGenerations.length >= 2
    && policyGenerations.every((generation, index, all) => index === 0 || generation.sealedPopulationScore > all[index - 1].sealedPopulationScore)
    && ablationsPass
    && REQUIRED_HOME_BENCHMARKS.every((benchmark) => homeBenchmarkResults[benchmark]?.score >= homeBenchmarkResults[benchmark]?.baselineScore);
  return {
    status: pass ? "PASS" : "FAIL",
    passCriteria: {
      verifiedImprovementHitRate: hitRate,
      minimumImprovementHitRate: preregistration.passCriteria.minimumImprovementHitRate,
      zeroUnverifiableApplies: allAppliesVerifiable,
      zeroHiddenRegressions,
      seededCanariesDetected: canaryDetected,
      seededCanariesCommitted: canaryCount,
      everyWinReproducedInFreshProcess: validated.wins.every((win) => reproductionRecords.some((item) => item?.repositoryId === win.repositoryId && item?.armId === "dream_rsi_2" && item?.freshProcess && item?.independent)),
      sealedPolicyScoreRises: policyGenerations.length >= 2 && policyGenerations.every((generation, index, all) => index === 0 || generation.sealedPopulationScore > all[index - 1].sealedPopulationScore),
      paretoDominatesEveryArmWithHolmIntervals: allArmsDominated,
    },
    pareto,
    ablationResults: ablationTests.map(({ mechanism, observed, lower, upper, pValue, holmSupported, samples }) => ({
      mechanism,
      meanFullMinusAblated: observed,
      paired95Lower: percentile(samples, (1 - confidence) / 2),
      paired95Upper: percentile(samples, 1 - (1 - confidence) / 2),
      holmStepDownLowerBound: lower,
      holmStepDownUpperBound: upper,
      pValue,
      measurablyWorseWithoutMechanism: holmSupported,
    })),
    allAblationsPass: ablationsPass,
    budgetHitCurve,
    lossCases: Array.isArray(report.lossCases) ? report.lossCases : [],
    reproductionCommands: report.reproductionCommands ?? [],
    ablations: ablationRecords,
    homeBenchmarks: homeBenchmarkResults,
    errors,
  };
}

export function auditTournamentResults(report, { preregistration, trustedRegistryKeyPem, evaluatorPublicKeyPem } = {}) {
  const errors = [];
  if (!isRecord(preregistration)) return { status: "INVALID", errors: ["audited preregistration is required"] };
  const preregAudit = auditTournamentPreregistration(preregistration, { trustedRegistryKeyPem });
  if (!preregAudit.valid) return { status: "INVALID", errors: preregAudit.errors.map((error) => `preregistration: ${error}`) };
  verifyReceipt(report, preregistration, evaluatorPublicKeyPem, errors);
  const validated = inspectResultShape(report, preregistration, errors);
  if (!validated) return { status: "INVALID", errors };
  return summarize(report, preregistration, validated, errors);
}

function main(argv) {
  if (argv.length !== 4) {
    process.stderr.write("Usage: node eval/tournament/results.mjs <preregistration.json> <result.json> <trusted-registry-key.pem> <trusted-evaluator-key.pem>\n");
    return 2;
  }
  const [preregPath, resultPath, registryKeyPath, evaluatorKeyPath] = argv.map((entry) => path.resolve(entry));
  try {
    const preregistration = JSON.parse(fs.readFileSync(preregPath, "utf8"));
    const report = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const result = auditTournamentResults(report, {
      preregistration,
      trustedRegistryKeyPem: fs.readFileSync(registryKeyPath, "utf8"),
      evaluatorPublicKeyPem: fs.readFileSync(evaluatorKeyPath, "utf8"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === "PASS" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`INVALID RESULTS: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) process.exitCode = main(process.argv.slice(2));
