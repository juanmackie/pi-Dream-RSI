import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  auditTournamentRuntime,
  checkpointArmBudget,
  checkpointBudgets,
  digestBundle,
  invokeJsonLines,
  runRegisteredTournament,
  validateJudgement,
  validateSandboxReceipt,
} from "../eval/tournament/runner.mjs";
import {
  createPreregistrationReceipt,
  HOME_BENCHMARK_ARMS,
  REQUIRED_ABLATIONS,
  REQUIRED_HOME_BENCHMARKS,
  TOURNAMENT_ARMS,
  preregistrationDigest,
} from "../eval/tournament/preregistration.mjs";
import { createTournamentResultReceipt } from "../eval/tournament/results.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const repo = { id: "repo-a", commitSha256: hash("commit"), environmentDigest: hash("repo-env"), budget: { wallClockMs: 1000, agentStarts: 8, evaluatorRuns: 12, maxCostMicrousd: 4000, independentEvaluationReserve: { wallClockMs: 80, evaluatorRuns: 4, maxCostMicrousd: 800 } } };
const arm = { id: "dream_rsi_2", implementationDigest: hash("impl"), environmentDigest: hash("arm-env"), commandDigest: hash("command"), command: ["node", "arm.mjs"] };
const receipt = {
  schemaVersion: 1,
  status: "complete",
  repositoryId: repo.id,
  repositoryCommitSha256: repo.commitSha256,
  repositoryEnvironmentDigest: repo.environmentDigest,
  armId: arm.id,
  armImplementationDigest: arm.implementationDigest,
  armEnvironmentDigest: arm.environmentDigest,
  armCommandDigest: arm.commandDigest,
  budgetFraction: 0.5,
  usage: { wallClockMs: 400, agentStarts: 3, evaluatorRuns: 4, costMicrousd: 1000 },
  artifactPath: "C:/sandbox/output",
  artifactDigest: hash("artifact"),
  ledgerHeadDigest: hash("ledger"),
};

test("checkpoint budgets floor every resource to the same preregistered fraction", () => {
  assert.deepEqual(checkpointBudgets(repo.budget, 0.25), {
    wallClockMs: 250, agentStarts: 2, evaluatorRuns: 3, maxCostMicrousd: 1000,
  });
  assert.deepEqual(checkpointBudgets(repo.budget, 1), { wallClockMs: 1000, agentStarts: 8, evaluatorRuns: 12, maxCostMicrousd: 4000 });
  assert.deepEqual(checkpointArmBudget(repo.budget, 0.25), { wallClockMs: 230, agentStarts: 2, evaluatorRuns: 2, maxCostMicrousd: 800 });
  assert.deepEqual(checkpointArmBudget(repo.budget, 0.5), { wallClockMs: 460, agentStarts: 4, evaluatorRuns: 4, maxCostMicrousd: 1600 });
});

test("sandbox receipt is bound to pinned repo, arm, artifact, and checkpoint budgets", () => {
  const armBudget = checkpointArmBudget(repo.budget, 0.5);
  assert.doesNotThrow(() => validateSandboxReceipt(receipt, { repo, arm, fraction: 0.5, budget: armBudget }));
  assert.throws(() => validateSandboxReceipt({ ...receipt, armCommandDigest: hash("changed") }, { repo, arm, fraction: 0.5, budget: armBudget }), /pinned arm/);
  assert.throws(() => validateSandboxReceipt({ ...receipt, usage: { ...receipt.usage, agentStarts: 5 } }, { repo, arm, fraction: 0.5, budget: armBudget }), /exceeded a budget/);
  assert.throws(() => validateSandboxReceipt({ ...receipt, budgetFraction: 0.25 }, { repo, arm, fraction: 0.5, budget: armBudget }), /wrong budget checkpoint/);
});

test("independent judgement must score the exact sandbox artifact and ledger head", () => {
  const judgement = {
    schemaVersion: 1, status: "scored", repositoryId: repo.id, armId: arm.id, budgetFraction: 0.5,
    artifactDigest: receipt.artifactDigest, ledgerHeadDigest: receipt.ledgerHeadDigest,
    performanceScore: 1.2, baselinePerformanceScore: 1, correctnessScore: 1,
    hiddenRegressionCount: 0, evaluatorEvidenceDigest: hash("judge"), canaryDetections: [], evidence: [],
    evaluatorRuns: 1, wallClockMs: 20, costMicrousd: 100,
  };
  const observation = validateJudgement(judgement, { repo, arm, fraction: 0.5, sandboxReceipt: receipt });
  assert.equal(observation.artifactDigest, receipt.artifactDigest);
  assert.equal(observation.performanceScore, 1.2);
  assert.equal(observation.costMicrousd, receipt.usage.costMicrousd + 100);
  assert.equal(observation.cumulativeWallClockMs, receipt.usage.wallClockMs + 20);
  assert.equal(observation.evaluatorRuns, receipt.usage.evaluatorRuns + 1);
  assert.throws(() => validateJudgement({ ...judgement, artifactDigest: hash("different") }, { repo, arm, fraction: 0.5, sandboxReceipt: receipt }), /artifact different from the sandbox receipt/);
  assert.throws(() => validateJudgement({ ...judgement, ledgerHeadDigest: hash("different") }, { repo, arm, fraction: 0.5, sandboxReceipt: receipt }), /ledger head/);
  assert.throws(() => validateJudgement({ ...judgement, evaluatorRuns: 3 }, { repo, arm, fraction: 0.5, sandboxReceipt: receipt }), /preregistered per-checkpoint resource reserve/);
});

test("adapter bundle digest is deterministic and changes with any file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-adapter-bundle-"));
  try {
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "main.mjs"), "export const version = 1;\n");
    fs.writeFileSync(path.join(root, "lib", "adapter.mjs"), "export const run = () => true;\n");
    const first = digestBundle(root);
    assert.equal(digestBundle(root), first);
    fs.writeFileSync(path.join(root, "lib", "adapter.mjs"), "export const run = () => false;\n");
    assert.notEqual(digestBundle(root), first);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("sandbox JSONL adapter streams cumulative checkpoints without a score feedback channel", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-sandbox-protocol-"));
  try {
    const adapter = path.join(root, "sandbox.mjs");
    fs.writeFileSync(adapter, `
      let body = "";
      process.stdin.on("data", chunk => body += chunk);
      process.stdin.on("end", () => {
        const request = JSON.parse(body);
        if (request.isolation.exposeEvaluator !== false || request.isolation.exposePriorJudgements !== false) process.exit(2);
        process.stdout.write(JSON.stringify({ type: "checkpoint", fraction: 0.25 }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "checkpoint", fraction: 0.5 }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "complete" }) + "\\n");
      });
    `);
    const events = [];
    await invokeJsonLines([process.execPath, adapter], { isolation: { exposeEvaluator: false, exposePriorJudgements: false } }, {
      cwd: root,
      timeoutMs: 5000,
      onMessage: async (event) => { events.push(event); },
    });
    assert.deepEqual(events, [
      { type: "checkpoint", fraction: 0.25 },
      { type: "checkpoint", fraction: 0.5 },
      { type: "complete" },
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("execution preflight refuses unregistered manifests before invoking any adapter", () => {
  const result = auditTournamentRuntime({}, { schemaVersion: 0 }, {});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("registration receipt is required")));
  assert.ok(result.errors.some((error) => error.includes("runner protocol version")));
});

test("registered runner orchestrates and audits all 140 synthetic cells without judge feedback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-tournament-e2e-"));
  try {
    const registryKeys = crypto.generateKeyPairSync("ed25519");
    const evaluatorKeys = crypto.generateKeyPairSync("ed25519");
    const evaluatorPublicKeyPem = evaluatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const evaluatorSigningKeySha256 = hash(evaluatorKeys.publicKey.export({ type: "spki", format: "der" }));
    const repositories = ["python", "rust", "go", "typescript", "java"].map((language, index) => ({
      id: `repo-${index + 1}`,
      language,
      commitSha256: hash(`commit-${index}`),
      environmentDigest: hash(`repo-env-${index}`),
      withheldFromOptimizer: true,
      budget: {
        wallClockMs: 360_000,
        agentStarts: 24,
        evaluatorRuns: 80,
        maxCostMicrousd: 25_000_000,
        independentEvaluationReserve: { wallClockMs: 12_000, evaluatorRuns: 4, maxCostMicrousd: 1_000_000 },
      },
    }));
    const arms = TOURNAMENT_ARMS.map((id) => {
      const command = [process.execPath, "arm-adapter.mjs", "--arm", id];
      return { id, implementationDigest: hash(`${id}-impl`), environmentDigest: hash(`${id}-env`), commandDigest: hash(JSON.stringify(command)), command, budgetMultiplier: 1 };
    });
    const sandboxRoot = path.join(root, "sandbox");
    const evaluatorRoot = path.join(root, "evaluator");
    fs.mkdirSync(sandboxRoot, { recursive: true });
    fs.mkdirSync(evaluatorRoot, { recursive: true });
    fs.writeFileSync(path.join(sandboxRoot, "sandbox.mjs"), `
      import crypto from "node:crypto";
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      let body = "";
      process.stdin.on("data", chunk => body += chunk);
      process.stdin.on("end", () => {
        const request = JSON.parse(body);
        if (request.isolation.networkEgress !== "deny" || request.isolation.exposeEvaluator !== false || request.isolation.exposePriorJudgements !== false) process.exit(4);
        const arm = request.arm;
        for (const checkpoint of request.checkpoints) {
          const artifactPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-artifact-")), "artifact.bin");
          fs.writeFileSync(artifactPath, request.repository.id + ":" + arm.id + ":" + checkpoint.fraction);
          const artifactDigest = crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
          const receipt = {
            schemaVersion: 1, status: "complete", repositoryId: request.repository.id,
            repositoryCommitSha256: request.repository.commitSha256,
            repositoryEnvironmentDigest: request.repository.environmentDigest,
            armId: arm.id, armImplementationDigest: arm.implementationDigest,
            armEnvironmentDigest: arm.environmentDigest, armCommandDigest: arm.commandDigest,
            budgetFraction: checkpoint.fraction,
            usage: {
              wallClockMs: Math.floor(5000 * checkpoint.fraction),
              agentStarts: Math.floor(8 * checkpoint.fraction),
              evaluatorRuns: Math.floor(8 * checkpoint.fraction),
              costMicrousd: Math.floor((arm.id === "dream_rsi_2" ? 100000 : 200000) * checkpoint.fraction),
            },
            artifactPath, artifactDigest,
            ledgerHeadDigest: crypto.createHash("sha256").update(request.repository.id + arm.id + checkpoint.fraction).digest("hex"),
          };
          process.stdout.write(JSON.stringify({ type: "checkpoint", receipt }) + "\\n");
        }
        process.stdout.write(JSON.stringify({ type: "complete" }) + "\\n");
      });
    `);
    fs.copyFileSync(new URL("../eval/tournament/preregistration.mjs", import.meta.url), path.join(evaluatorRoot, "preregistration.mjs"));
    fs.copyFileSync(new URL("../eval/tournament/results.mjs", import.meta.url), path.join(evaluatorRoot, "results.mjs"));
    fs.writeFileSync(path.join(evaluatorRoot, "evaluator.mjs"), `
      import crypto from "node:crypto";
      import { createTournamentResultReceipt } from "./results.mjs";
      const privateKey = ${JSON.stringify(evaluatorKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString())};
      const hash = value => crypto.createHash("sha256").update(value).digest("hex");
      let body = "";
      process.stdin.on("data", chunk => body += chunk);
      process.stdin.on("end", () => {
        const request = JSON.parse(body);
        if (request.operation === "score-hidden") {
          const dream = request.arm.id === "dream_rsi_2";
          const fraction = request.budgetFraction;
          const score = (dream ? 200 : 150) * fraction;
          const judgement = {
            schemaVersion: 1, status: "scored", repositoryId: request.repository.id,
            armId: request.arm.id, budgetFraction: fraction,
            artifactDigest: request.artifactDigest, ledgerHeadDigest: request.ledgerHeadDigest,
            performanceScore: score, baselinePerformanceScore: 100, correctnessScore: 1,
            hiddenRegressionCount: 0, evaluatorEvidenceDigest: hash(request.artifactDigest + ":judge"),
            canaryDetections: [], evidence: [], evaluatorRuns: Math.ceil(4 * fraction),
            wallClockMs: Math.ceil(12000 * fraction), costMicrousd: Math.ceil(10000 * fraction),
          };
          if (dream && fraction === 1) judgement.applyEvidence = {
            repositoryId: request.repository.id, armId: request.arm.id,
            artifactDigest: request.artifactDigest, ledgerHeadDigest: request.ledgerHeadDigest,
            evaluatorEvidenceDigest: judgement.evaluatorEvidenceDigest, independentlyVerifiable: true,
          };
          process.stdout.write(JSON.stringify(judgement));
          return;
        }
        if (request.operation !== "finalize-and-sign") process.exit(5);
        const preregistration = request.preregistration;
        const observations = request.observations;
        const reproductionCommands = preregistration.repositories.flatMap(repo => preregistration.arms.map(arm => ({ repositoryId: repo.id, armId: arm.id, argv: arm.command })));
        const applies = request.applyEvidence;
        const freshProcessReproductions = applies.map(apply => ({ ...apply, score: observations.find(row => row.repositoryId === apply.repositoryId && row.armId === apply.armId && row.budgetFraction === 1).performanceScore, freshProcess: true, independent: true }));
        const homeBenchmarks = Object.fromEntries(Object.entries(preregistration.homeBenchmarks).map(([name, benchmark]) => [name, {
          armId: benchmark.armId, runCommand: benchmark.runCommand, baselineDigest: benchmark.baselineDigest,
          environmentDigest: benchmark.environmentDigest, score: 1, baselineScore: 1,
        }]));
        const report = {
          schemaVersion: 1, preregistrationDigest: request.preregistrationDigest,
          evaluator: {
            organization: preregistration.independentEvaluator.organization,
            signingKeySha256: preregistration.independentEvaluator.signingKeySha256,
            evaluatorBuildDigest: preregistration.independentEvaluator.evaluatorBuildDigest,
            hiddenSuiteManifestCommitment: preregistration.independentEvaluator.hiddenSuiteManifestCommitment,
            sealedPopulationCommitment: preregistration.independentEvaluator.sealedPopulationCommitment,
          },
          observations, applies,
          canaryDetections: preregistration.independentEvaluator.canaryIds.map(id => ({ id, detected: true })),
          freshProcessReproductions,
          policyGenerations: [{ generation: 1, sealedPopulationScore: 0.5, evaluatedByIndependentJudge: true }, { generation: 2, sealedPopulationScore: 0.6, evaluatedByIndependentJudge: true }],
          ablations: preregistration.ablations.map(item => ({ mechanism: item.mechanism, metric: "performance", fullScores: preregistration.repositories.map(repo => ({ repositoryId: repo.id, score: 200 })), ablatedScores: preregistration.repositories.map(repo => ({ repositoryId: repo.id, score: 100 })) })),
          homeBenchmarks, lossCases: [], reproductionCommands,
        };
        report.receipt = createTournamentResultReceipt(report, privateKey);
        process.stdout.write(JSON.stringify(report));
      });
    `);

    const manifest = {
      schemaVersion: 1,
      title: "Synthetic runner integration",
      project: { owner: "dream-rsi-team", repository: "synthetic-fixture" },
      repositories,
      arms,
      independentEvaluator: {
        organization: "external-test-lab", controlsHiddenSuites: true,
        signingKeySha256: evaluatorSigningKeySha256,
        evaluatorBuildDigest: digestBundle(evaluatorRoot),
        hiddenSuiteManifestCommitment: hash("hidden"), sealedPopulationCommitment: hash("sealed"),
        canaryManifestCommitment: hash("canaries"), canaryIds: ["canary-a", "canary-b"],
      },
      execution: { protocolVersion: 1, checkpointMode: "single-run-cumulative-checkpoints", schedule: "sha256-cell-order-v1", sandboxAdapterDigest: digestBundle(sandboxRoot), networkEgress: "deny" },
      policyDevelopmentPopulation: Array.from({ length: 5 }, (_, index) => hash(`development-${index}`)),
      statistics: {
        unit: "repository", confidenceLevel: 0.95, intervalMethod: "paired-bootstrap", comparisonAlternative: "one-sided-dream-advantage",
        outcomeDirections: { performance: "higher", correctness: "higher", hidden_regressions: "lower", cost: "lower", hit_rate: "higher" },
        bootstrapReplicates: 10000, bootstrapSeed: 19, budgetCheckpoints: [0.25, 0.5, 0.75, 1], reproductionTolerance: 0,
        multiplicityCorrection: "holm", outcomes: ["performance", "correctness", "hidden_regressions", "cost", "hit_rate"],
      },
      passCriteria: { minimumImprovementHitRate: 0.6, paretoDominatesEveryArm: true, zeroUnverifiableApplies: true, zeroHiddenRegressions: true, seededCanaryDetectionRate: 1, freshProcessReproductionForEveryWin: true, sealedPopulationScoreMustRise: true },
      ablations: REQUIRED_ABLATIONS.map(mechanism => ({ mechanism, metric: "performance", expectedOutcome: `removing ${mechanism} lowers performance` })),
      homeBenchmarks: Object.fromEntries(REQUIRED_HOME_BENCHMARKS.map(name => [name, { name, armId: HOME_BENCHMARK_ARMS[name], runCommand: ["node", "home.mjs", name], baselineDigest: hash(`${name}-baseline`), environmentDigest: hash(`${name}-environment`) }])),
      reporting: { includesLossCases: true, includesCostHitRateCurve: true, includesExactReproductionCommands: true },
    };
    manifest.registration = createPreregistrationReceipt(manifest, {
      url: "https://registry.example.org/synthetic-runner-fixture",
      registeredAt: "2026-10-18T00:00:00.000Z",
      privateKey: registryKeys.privateKey,
    });
    const repoPaths = repositories.map((repo, index) => {
      const sourcePath = path.join(root, `repo-${index}`);
      fs.mkdirSync(sourcePath);
      return { id: repo.id, sourcePath, environmentDigest: repo.environmentDigest };
    });
    const runtime = {
      schemaVersion: 1,
      repositories: repoPaths,
      sandbox: { bundlePath: sandboxRoot, entrypoint: "sandbox.mjs", command: [process.execPath, path.join(sandboxRoot, "sandbox.mjs")] },
      evaluator: { bundlePath: evaluatorRoot, entrypoint: "evaluator.mjs", command: [process.execPath, path.join(evaluatorRoot, "evaluator.mjs")] },
      outputRoot: path.join(root, "results"),
    };
    const result = await runRegisteredTournament(manifest, runtime, {
      trustedRegistryKeyPem: registryKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      evaluatorPublicKeyPem,
    });
    assert.equal(result.status, "PASS", JSON.stringify(result.errors));
    assert.equal(result.completedCells, 140);
    assert.equal(result.totalCells, 140);
    const savedReport = JSON.parse(fs.readFileSync(result.resultPath, "utf8"));
    assert.equal(savedReport.observations.length, 140);
    assert.equal(savedReport.receipt !== undefined, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
