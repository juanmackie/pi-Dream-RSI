#!/usr/bin/env node
/** Registered, budget-matched tournament controller. The pinned sandbox executes arms; the pinned external judge owns every score and final signature. */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import { auditTournamentPreregistration } from "./preregistration.mjs";
import { auditTournamentResults } from "./results.mjs";

export const RUNNER_PROTOCOL_VERSION = 1;
export const RUNNER_CHECKPOINTS = Object.freeze([0.25, 0.5, 0.75, 1]);
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const SECRET_ENV = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|AUTHORIZATION|COOKIE)/i;

function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

/** Stable content digest of a trusted adapter bundle; symlinks are rejected. */
export function digestBundle(root) {
  const absolute = path.resolve(root);
  const entries = [];
  const visit = (folder, relative = "") => {
    for (const name of fs.readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      const itemRelative = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`adapter bundle contains a symbolic link: ${itemRelative}`);
      if (stat.isDirectory()) visit(full, itemRelative);
      else if (stat.isFile()) entries.push([itemRelative, sha256(fs.readFileSync(full))]);
      else throw new Error(`adapter bundle contains a special file: ${itemRelative}`);
    }
  };
  visit(absolute);
  if (entries.length === 0) throw new Error("adapter bundle is empty");
  return sha256(canonical(entries));
}

function assertCommand(command, label) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part.trim())) {
    throw new Error(`${label} must be a non-empty argv array`);
  }
}

export function auditTournamentRuntime(preregistration, runtime, { trustedRegistryKeyPem } = {}) {
  const errors = [];
  const registration = auditTournamentPreregistration(preregistration, { trustedRegistryKeyPem });
  errors.push(...registration.errors.map((error) => `preregistration: ${error}`));
  if (!isRecord(runtime) || runtime.schemaVersion !== RUNNER_PROTOCOL_VERSION) {
    errors.push("runtime schemaVersion must equal the pinned tournament runner protocol version");
    return { valid: false, errors, preregistrationDigest: registration.digest };
  }
  const verifyBundle = (adapter, expectedDigest, label) => {
    if (!isRecord(adapter) || typeof adapter.bundlePath !== "string") {
      errors.push(`${label}.bundlePath is required`);
      return;
    }
    try {
      const actual = digestBundle(adapter.bundlePath);
      if (actual !== expectedDigest) errors.push(`${label} bundle digest does not match preregistration`);
    } catch (error) { errors.push(`${label} bundle cannot be verified: ${error instanceof Error ? error.message : String(error)}`); }
    try {
      assertCommand(adapter.command, `${label}.command`);
      if (typeof adapter.entrypoint !== "string" || !adapter.entrypoint || path.isAbsolute(adapter.entrypoint)
        || adapter.entrypoint.split(/[\\/]/).includes("..")) {
        errors.push(`${label}.entrypoint must be a bundle-relative path without parent traversal`);
      } else {
        const entrypoint = path.resolve(adapter.bundlePath, adapter.entrypoint);
        const relative = path.relative(path.resolve(adapter.bundlePath), entrypoint);
        if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(entrypoint)) errors.push(`${label}.entrypoint must exist inside its pinned bundle`);
        if (!adapter.command.slice(1).some((argument) => path.resolve(adapter.bundlePath, argument) === entrypoint)
          && path.resolve(adapter.command[0]) !== entrypoint) errors.push(`${label}.command must execute its pinned entrypoint`);
      }
    } catch (error) { errors.push(error.message); }
  };
  verifyBundle(runtime.sandbox, preregistration?.execution?.sandboxAdapterDigest, "sandbox");
  verifyBundle(runtime.evaluator, preregistration?.independentEvaluator?.evaluatorBuildDigest, "evaluator");
  if (runtime.evaluator?.timeoutMs !== undefined && (!Number.isSafeInteger(runtime.evaluator.timeoutMs) || runtime.evaluator.timeoutMs <= 0)) {
    errors.push("runtime.evaluator.timeoutMs must be a positive safe integer when supplied");
  }
  const repoEntries = Array.isArray(runtime.repositories) ? runtime.repositories : [];
  const repoById = new Map(repoEntries.filter(isRecord).map((entry) => [entry.id, entry]));
  if (!Array.isArray(runtime.repositories)) errors.push("runtime.repositories must be an array");
  for (const repo of preregistration?.repositories ?? []) {
    const configured = repoById.get(repo.id);
    if (!configured) { errors.push(`runtime repository '${repo.id}' is missing`); continue; }
    if (typeof configured.sourcePath !== "string" || !path.isAbsolute(configured.sourcePath) || !fs.existsSync(configured.sourcePath)) {
      errors.push(`runtime repository '${repo.id}' needs an existing absolute sourcePath`);
    }
    if (configured.environmentDigest !== repo.environmentDigest) errors.push(`runtime repository '${repo.id}' environment digest differs from preregistration`);
  }
  if (repoById.size !== (preregistration?.repositories?.length ?? 0)) errors.push("runtime repository set must exactly match the preregistered evaluation population");
  if (typeof runtime.outputRoot !== "string" || !path.isAbsolute(runtime.outputRoot)) errors.push("runtime.outputRoot must be an absolute path");
  return { valid: errors.length === 0, errors, preregistrationDigest: registration.digest };
}

function minimalEnvironment() {
  const allowed = process.platform === "win32"
    ? ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE"]
    : ["PATH", "HOME", "TMPDIR"];
  return Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}

function invokeJson(command, request, { cwd, timeoutMs, maxOutputBytes = OUTPUT_LIMIT, signal } = {}) {
  return new Promise((resolve, reject) => {
    assertCommand(command, "adapter command");
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: Object.fromEntries(Object.entries(minimalEnvironment()).filter(([key]) => !SECRET_ENV.test(key))),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => { child.kill(); finish(new Error("tournament adapter aborted")); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${path.basename(command[0])} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) { child.kill(); finish(new Error("tournament adapter output exceeded its limit")); }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_384); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) { finish(new Error(`${path.basename(command[0])} exited ${code}: ${stderr.slice(-2_000)}`)); return; }
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(new Error(`${path.basename(command[0])} returned invalid JSON`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** Stream sealed checkpoint receipts from one cumulative sandboxed arm run. */
export async function invokeJsonLines(command, request, { cwd, timeoutMs, maxOutputBytes = OUTPUT_LIMIT, signal, onMessage }) {
  assertCommand(command, "sandbox adapter command");
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: Object.fromEntries(Object.entries(minimalEnvironment()).filter(([key]) => !SECRET_ENV.test(key))),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childResult = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code) => resolve({ code }));
  });
  let stderr = "";
  let outputBytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const abort = () => child.kill();
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_384); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { outputBytes += Buffer.byteLength(chunk); if (outputBytes > maxOutputBytes) child.kill(); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stdin.end(JSON.stringify(request));
  let callbackError = null;
  try {
    for await (const line of lines) {
      if (outputBytes > maxOutputBytes) throw new Error("sandbox adapter output exceeded its limit");
      let message;
      try { message = JSON.parse(line); } catch { throw new Error("sandbox adapter emitted a malformed JSONL protocol event"); }
      await onMessage(message);
    }
  } catch (error) {
    callbackError = error;
    child.kill();
  }
  const termination = await childResult.finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
  if (termination.error) throw termination.error;
  if (callbackError) throw callbackError;
  if (signal?.aborted) throw new Error("tournament adapter aborted");
  if (timedOut) throw new Error(`sandbox adapter timed out after ${timeoutMs} ms`);
  if (outputBytes > maxOutputBytes) throw new Error("sandbox adapter output exceeded its limit");
  if (termination.code !== 0) throw new Error(`sandbox adapter exited ${termination.code}: ${stderr.slice(-2_000)}`);
}

export function checkpointBudgets(repoBudget, fraction) {
  return {
    wallClockMs: Math.floor(repoBudget.wallClockMs * fraction),
    agentStarts: Math.floor(repoBudget.agentStarts * fraction),
    evaluatorRuns: Math.floor(repoBudget.evaluatorRuns * fraction),
    maxCostMicrousd: Math.floor(repoBudget.maxCostMicrousd * fraction),
  };
}

function digestOrder(values, preregistrationDigestValue, kind) {
  return [...values].sort((left, right) => {
    const leftKey = sha256(`${preregistrationDigestValue}\u0000${kind}\u0000${left.id}`);
    const rightKey = sha256(`${preregistrationDigestValue}\u0000${kind}\u0000${right.id}`);
    return leftKey.localeCompare(rightKey);
  });
}

export function checkpointArmBudget(repoBudget, fraction) {
  const total = checkpointBudgets(repoBudget, fraction);
  const reserve = repoBudget.independentEvaluationReserve;
  if (!isRecord(reserve)) throw new Error("repository budget must reserve the independent evaluator before arm execution");
  const judgeReserve = {
    wallClockMs: Math.ceil(reserve.wallClockMs * fraction),
    evaluatorRuns: Math.ceil(reserve.evaluatorRuns * fraction),
    maxCostMicrousd: Math.ceil(reserve.maxCostMicrousd * fraction),
  };
  const arm = {
    wallClockMs: total.wallClockMs - judgeReserve.wallClockMs,
    agentStarts: total.agentStarts,
    evaluatorRuns: total.evaluatorRuns - judgeReserve.evaluatorRuns,
    maxCostMicrousd: total.maxCostMicrousd - judgeReserve.maxCostMicrousd,
  };
  if (Object.values(arm).some((value) => value <= 0)) throw new Error(`budget fraction ${fraction} leaves no positive arm allowance after reserving the independent evaluator`);
  return arm;
}

export function validateSandboxReceipt(receipt, { repo, arm, fraction, budget }) {
  if (!isRecord(receipt) || receipt.schemaVersion !== 1 || receipt.status !== "complete") throw new Error("sandbox adapter did not return a complete protocol-v1 receipt");
  if (receipt.repositoryId !== repo.id || receipt.repositoryCommitSha256 !== repo.commitSha256) throw new Error("sandbox receipt does not match the pinned repository revision");
  if (receipt.repositoryEnvironmentDigest !== repo.environmentDigest) throw new Error("sandbox receipt does not match the pinned repository environment");
  if (receipt.armId !== arm.id || receipt.armImplementationDigest !== arm.implementationDigest || receipt.armEnvironmentDigest !== arm.environmentDigest || receipt.armCommandDigest !== arm.commandDigest) {
    throw new Error("sandbox receipt does not match the pinned arm implementation, environment, or command");
  }
  if (receipt.budgetFraction !== fraction || !isRecord(receipt.usage)) throw new Error("sandbox receipt has the wrong budget checkpoint or missing usage");
  for (const field of ["wallClockMs", "agentStarts", "evaluatorRuns", "costMicrousd"]) {
    if (!Number.isSafeInteger(receipt.usage[field]) || receipt.usage[field] < 0) throw new Error(`sandbox receipt usage.${field} must be a non-negative integer`);
  }
  if (receipt.usage.wallClockMs > budget.wallClockMs || receipt.usage.agentStarts > budget.agentStarts
    || receipt.usage.evaluatorRuns > budget.evaluatorRuns || receipt.usage.costMicrousd > budget.maxCostMicrousd) {
    throw new Error("sandbox receipt exceeded a budget-matched checkpoint allowance");
  }
  for (const field of ["artifactPath", "artifactDigest", "ledgerHeadDigest"]) {
    if (typeof receipt[field] !== "string" || !receipt[field]) throw new Error(`sandbox receipt ${field} is required`);
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.artifactDigest) || !/^[a-f0-9]{64}$/.test(receipt.ledgerHeadDigest)) throw new Error("sandbox artifact and ledger provenance must be SHA-256 digests");
}

export function validateJudgement(judgement, { repo, arm, fraction, sandboxReceipt }) {
  if (!isRecord(judgement) || judgement.schemaVersion !== 1 || judgement.status !== "scored") throw new Error("independent evaluator did not return a scored protocol-v1 judgement");
  if (judgement.repositoryId !== repo.id || judgement.armId !== arm.id || judgement.budgetFraction !== fraction) throw new Error("independent evaluator judgement is bound to a different cell");
  if (judgement.artifactDigest !== sandboxReceipt.artifactDigest) throw new Error("independent evaluator scored an artifact different from the sandbox receipt");
  for (const field of ["performanceScore", "baselinePerformanceScore", "correctnessScore"]) {
    if (typeof judgement[field] !== "number" || !Number.isFinite(judgement[field])) throw new Error(`independent evaluator ${field} must be finite`);
  }
  if (!Number.isSafeInteger(judgement.hiddenRegressionCount) || judgement.hiddenRegressionCount < 0) throw new Error("independent evaluator hiddenRegressionCount must be a non-negative integer");
  if (typeof judgement.evaluatorEvidenceDigest !== "string" || !/^[a-f0-9]{64}$/.test(judgement.evaluatorEvidenceDigest)) throw new Error("independent evaluator evidence digest must be SHA-256");
  for (const field of ["evaluatorRuns", "wallClockMs", "costMicrousd"]) {
    if (!Number.isSafeInteger(judgement[field]) || judgement[field] < 0) throw new Error(`independent evaluator ${field} must be a non-negative integer`);
  }
  if (!Array.isArray(judgement.canaryDetections) || !Array.isArray(judgement.evidence)) throw new Error("independent evaluator must return canary and evidence records");
  if (judgement.ledgerHeadDigest !== sandboxReceipt.ledgerHeadDigest) throw new Error("independent evaluator did not bind the arm's ledger head");
  const budget = checkpointBudgets(repo.budget, fraction);
  const reserve = repo.budget.independentEvaluationReserve;
  const judgeReserve = {
    wallClockMs: Math.ceil(reserve.wallClockMs * fraction),
    evaluatorRuns: Math.ceil(reserve.evaluatorRuns * fraction),
    maxCostMicrousd: Math.ceil(reserve.maxCostMicrousd * fraction),
  };
  if (judgement.wallClockMs > judgeReserve.wallClockMs || judgement.evaluatorRuns > judgeReserve.evaluatorRuns
    || judgement.costMicrousd > judgeReserve.maxCostMicrousd) {
    throw new Error("independent evaluator exceeded its preregistered per-checkpoint resource reserve");
  }
  const usage = {
    wallClockMs: sandboxReceipt.usage.wallClockMs + judgement.wallClockMs,
    agentStarts: sandboxReceipt.usage.agentStarts,
    evaluatorRuns: sandboxReceipt.usage.evaluatorRuns + judgement.evaluatorRuns,
    costMicrousd: sandboxReceipt.usage.costMicrousd + judgement.costMicrousd,
  };
  if (usage.wallClockMs > budget.wallClockMs || usage.agentStarts > budget.agentStarts
    || usage.evaluatorRuns > budget.evaluatorRuns || usage.costMicrousd > budget.maxCostMicrousd) {
    throw new Error("combined arm and independent-evaluator usage exceeded the preregistered checkpoint budget");
  }
  return {
    repositoryId: repo.id,
    repositoryCommitSha256: repo.commitSha256,
    repositoryEnvironmentDigest: repo.environmentDigest,
    armId: arm.id,
    armImplementationDigest: arm.implementationDigest,
    armEnvironmentDigest: arm.environmentDigest,
    armCommandDigest: arm.commandDigest,
    budgetFraction: fraction,
    performanceScore: judgement.performanceScore,
    baselinePerformanceScore: judgement.baselinePerformanceScore,
    correctnessScore: judgement.correctnessScore,
    hiddenRegressionCount: judgement.hiddenRegressionCount,
    costMicrousd: usage.costMicrousd,
    cumulativeWallClockMs: usage.wallClockMs,
    agentStarts: usage.agentStarts,
    evaluatorRuns: usage.evaluatorRuns,
    ledgerHeadDigest: sandboxReceipt.ledgerHeadDigest,
    artifactDigest: sandboxReceipt.artifactDigest,
    evaluatorEvidenceDigest: judgement.evaluatorEvidenceDigest,
    canaryDetections: judgement.canaryDetections,
    evidence: judgement.evidence,
  };
}

/**
 * Run each repository/arm pair once and score cumulative sealed checkpoints.
 * The sandbox and evaluator are separate pinned processes: no hidden score,
 * canary label, or judge output is ever sent back to an arm.
 */
export async function runRegisteredTournament(preregistration, runtime, {
  trustedRegistryKeyPem,
  evaluatorPublicKeyPem,
  signal,
  onProgress = () => {},
} = {}) {
  const preflight = auditTournamentRuntime(preregistration, runtime, { trustedRegistryKeyPem });
  if (!preflight.valid) throw new Error(`tournament refused before execution:\n- ${preflight.errors.join("\n- ")}`);
  const evaluatorDigest = sha256(crypto.createPublicKey(evaluatorPublicKeyPem).export({ format: "der", type: "spki" }));
  if (evaluatorDigest !== preregistration.independentEvaluator.signingKeySha256) throw new Error("out-of-band evaluator public key does not match preregistration");

  const observationRequests = [];
  const applyEvidence = [];
  const total = preregistration.repositories.length * preregistration.arms.length * RUNNER_CHECKPOINTS.length;
  let completed = 0;
  const orderedRepositories = digestOrder(preregistration.repositories, preflight.preregistrationDigest, "repository");
  for (const repo of orderedRepositories) {
    const source = runtime.repositories.find((entry) => entry.id === repo.id);
    const orderedArms = digestOrder(preregistration.arms, preflight.preregistrationDigest, `arm:${repo.id}`);
    for (const arm of orderedArms) {
      if (signal?.aborted) throw new Error("tournament aborted before all registered cells completed");
      const expectedBudgets = RUNNER_CHECKPOINTS.map((fraction) => checkpointBudgets(repo.budget, fraction));
      const armBudgets = RUNNER_CHECKPOINTS.map((fraction) => checkpointArmBudget(repo.budget, fraction));
      let nextCheckpoint = 0;
      let sawComplete = false;
      await invokeJsonLines(runtime.sandbox.command, {
        protocol: "dream-rsi-tournament-v1",
        operation: "run-arm-through-checkpoints",
        preregistrationDigest: preflight.preregistrationDigest,
        repository: { id: repo.id, sourcePath: source.sourcePath, commitSha256: repo.commitSha256, environmentDigest: repo.environmentDigest },
        arm: { id: arm.id, command: arm.command, implementationDigest: arm.implementationDigest, environmentDigest: arm.environmentDigest, commandDigest: arm.commandDigest },
        totalBudget: repo.budget,
        checkpoints: RUNNER_CHECKPOINTS.map((fraction, index) => ({ fraction, budget: expectedBudgets[index], armBudget: armBudgets[index] })),
        isolation: { networkEgress: "deny", freshRepositoryCopy: true, immutableCheckpointArtifacts: true, exposeEvaluator: false, exposePriorJudgements: false },
      }, {
        cwd: runtime.sandbox.bundlePath,
        timeoutMs: repo.budget.wallClockMs + 30_000,
        signal,
        onMessage: async (event) => {
          if (!isRecord(event)) throw new Error("sandbox event must be an object");
          if (event.type === "complete") {
            if (nextCheckpoint !== RUNNER_CHECKPOINTS.length) throw new Error("sandbox ended before emitting all registered checkpoints");
            sawComplete = true;
            return;
          }
          if (event.type !== "checkpoint" || nextCheckpoint >= RUNNER_CHECKPOINTS.length) throw new Error("sandbox emitted an unknown or excess tournament event");
          const fraction = RUNNER_CHECKPOINTS[nextCheckpoint];
          const budget = expectedBudgets[nextCheckpoint];
          const sandboxReceipt = event.receipt;
          validateSandboxReceipt(sandboxReceipt, { repo, arm, fraction, budget: armBudgets[nextCheckpoint] });
          const judgement = await invokeJson(runtime.evaluator.command, {
            protocol: "dream-rsi-tournament-v1",
            operation: "score-hidden",
            preregistrationDigest: preflight.preregistrationDigest,
            repository: { id: repo.id, commitSha256: repo.commitSha256, environmentDigest: repo.environmentDigest },
            arm: { id: arm.id, implementationDigest: arm.implementationDigest, environmentDigest: arm.environmentDigest },
            budgetFraction: fraction,
            artifactPath: sandboxReceipt.artifactPath,
            artifactDigest: sandboxReceipt.artifactDigest,
            ledgerHeadDigest: sandboxReceipt.ledgerHeadDigest,
            sandboxReceipt,
          }, { cwd: runtime.evaluator.bundlePath, timeoutMs: runtime.evaluator.timeoutMs ?? 30 * 60_000, signal });
          const observation = validateJudgement(judgement, { repo, arm, fraction, sandboxReceipt });
          observationRequests.push(observation);
          if (judgement.applyEvidence) applyEvidence.push(judgement.applyEvidence);
          nextCheckpoint += 1;
          completed += 1;
          onProgress({ completed, total, repoId: repo.id, armId: arm.id, budgetFraction: fraction });
        },
      });
      if (!sawComplete) throw new Error(`sandbox did not terminate cleanly for '${repo.id}/${arm.id}'`);
    }
  }

  const finalReport = await invokeJson(runtime.evaluator.command, {
    protocol: "dream-rsi-tournament-v1",
    operation: "finalize-and-sign",
    preregistrationDigest: preflight.preregistrationDigest,
    preregistration,
    observations: observationRequests,
    applyEvidence,
  }, { cwd: runtime.evaluator.bundlePath, timeoutMs: runtime.evaluator.timeoutMs ?? 30 * 60_000, signal });
  const audit = auditTournamentResults(finalReport, { preregistration, trustedRegistryKeyPem, evaluatorPublicKeyPem });
  fs.mkdirSync(runtime.outputRoot, { recursive: true });
  const resultPath = path.join(runtime.outputRoot, `tournament-${preflight.preregistrationDigest}.json`);
  fs.writeFileSync(resultPath, `${JSON.stringify(finalReport, null, 2)}\n`, { flag: "wx" });
  return { status: audit.status, errors: audit.errors, resultPath, completedCells: completed, totalCells: total, preregistrationDigest: preflight.preregistrationDigest };
}

async function main(argv) {
  if (argv.length !== 4) {
    process.stderr.write("Usage: node eval/tournament/runner.mjs <registered-preregistration.json> <runtime.json> <trusted-registry-public-key.pem> <trusted-evaluator-public-key.pem>\n");
    return 2;
  }
  const [preregPath, runtimePath, registryKeyPath, evaluatorKeyPath] = argv.map((entry) => path.resolve(entry));
  try {
    const preregistration = JSON.parse(fs.readFileSync(preregPath, "utf8"));
    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    const trustedRegistryKeyPem = fs.readFileSync(registryKeyPath, "utf8");
    const evaluatorPublicKeyPem = fs.readFileSync(evaluatorKeyPath, "utf8");
    const result = await runRegisteredTournament(preregistration, runtime, { trustedRegistryKeyPem, evaluatorPublicKeyPem,
      onProgress: (event) => process.stdout.write(`${JSON.stringify({ event: "cell-complete", ...event })}\n`) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === "PASS" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`TOURNAMENT NOT PASSED: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) process.exitCode = await main(process.argv.slice(2));
