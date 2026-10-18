import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import {
  createPreregistrationReceipt,
  HOME_BENCHMARK_ARMS,
  preregistrationDigest,
  REQUIRED_ABLATIONS,
  REQUIRED_HOME_BENCHMARKS,
  TOURNAMENT_ARMS,
} from "../eval/tournament/preregistration.mjs";
import {
  auditTournamentResults,
  createTournamentResultReceipt,
} from "../eval/tournament/results.mjs";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fixture() {
  const registryKeys = crypto.generateKeyPairSync("ed25519");
  const evaluatorKeys = crypto.generateKeyPairSync("ed25519");
  const evaluatorKeyPem = evaluatorKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const evaluatorKeyDigest = digest(evaluatorKeys.publicKey.export({ format: "der", type: "spki" }));
  const repositories = ["python", "rust", "go", "typescript", "java"].map((language, index) => ({
    id: `heldout-${index + 1}`,
    language,
    commitSha256: digest(`heldout-commit-${index}`),
    environmentDigest: digest(`heldout-environment-${index}`),
    withheldFromOptimizer: true,
    budget: { wallClockMs: 3_600_000, agentStarts: 24, evaluatorRuns: 80, maxCostMicrousd: 25_000_000, independentEvaluationReserve: { wallClockMs: 120_000, evaluatorRuns: 4, maxCostMicrousd: 1_000_000 } },
  }));
  const preregistration = {
    schemaVersion: 1,
    title: "Synthetic signed results-gate fixture",
    project: { owner: "dream-rsi-team", repository: "pi-Dream-RSI" },
    repositories,
    arms: TOURNAMENT_ARMS.map((id) => {
      const command = ["npm", "run", "tournament-arm", "--", "--arm", id];
      return { id, implementationDigest: digest(`${id}-impl`), environmentDigest: digest(`${id}-env`), command, commandDigest: digest(JSON.stringify(command)), budgetMultiplier: 1 };
    }),
    independentEvaluator: {
      organization: "external-eval-lab",
      controlsHiddenSuites: true,
      signingKeySha256: evaluatorKeyDigest,
      evaluatorBuildDigest: digest("eval-build"),
      hiddenSuiteManifestCommitment: digest("hidden-suite"),
      sealedPopulationCommitment: digest("sealed-population"),
      canaryManifestCommitment: digest("canaries"),
      canaryIds: ["canary-1", "canary-2"],
    },
    execution: { protocolVersion: 1, checkpointMode: "single-run-cumulative-checkpoints", schedule: "sha256-cell-order-v1", sandboxAdapterDigest: digest("sandbox-build"), networkEgress: "deny" },
    policyDevelopmentPopulation: Array.from({ length: 5 }, (_, index) => digest(`dev-${index}`)),
    statistics: {
      unit: "repository",
      confidenceLevel: 0.95,
      intervalMethod: "paired-bootstrap",
      comparisonAlternative: "one-sided-dream-advantage",
      outcomeDirections: { performance: "higher", correctness: "higher", hidden_regressions: "lower", cost: "lower", hit_rate: "higher" },
      bootstrapReplicates: 20_000,
      bootstrapSeed: 71,
      budgetCheckpoints: [0.25, 0.5, 0.75, 1],
      reproductionTolerance: 0,
      multiplicityCorrection: "holm",
      outcomes: ["performance", "correctness", "hidden_regressions", "cost", "hit_rate"],
    },
    passCriteria: {
      minimumImprovementHitRate: 0.6,
      paretoDominatesEveryArm: true,
      zeroUnverifiableApplies: true,
      zeroHiddenRegressions: true,
      seededCanaryDetectionRate: 1,
      freshProcessReproductionForEveryWin: true,
      sealedPopulationScoreMustRise: true,
    },
    ablations: REQUIRED_ABLATIONS.map((mechanism) => ({ mechanism, metric: "performance", expectedOutcome: `removing ${mechanism} lowers performance` })),
    homeBenchmarks: Object.fromEntries(REQUIRED_HOME_BENCHMARKS.map((name) => [name, {
      name: `${name} home benchmark`,
      armId: HOME_BENCHMARK_ARMS[name],
      runCommand: ["npm", "run", "home-benchmark", "--", "--name", name],
      baselineDigest: digest(`${name}-baseline`),
      environmentDigest: digest(`${name}-environment`),
    }])),
    reporting: { includesLossCases: true, includesCostHitRateCurve: true, includesExactReproductionCommands: true },
  };
  preregistration.registration = createPreregistrationReceipt(preregistration, {
    url: "https://registry.example.org/preregistrations/synthetic-fixture",
    registeredAt: "2026-10-18T00:00:00.000Z",
    privateKey: registryKeys.privateKey,
  });

  const observations = [];
  const reproductionCommands = [];
  const applies = [];
  const freshProcessReproductions = [];
  for (const repo of repositories) {
    for (const armId of TOURNAMENT_ARMS) {
      const dream = armId === "dream_rsi_2";
      const command = preregistration.arms.find((arm) => arm.id === armId).command;
      reproductionCommands.push({ repositoryId: repo.id, armId, argv: command });
      for (const budgetFraction of [0.25, 0.5, 0.75, 1]) {
        const performanceScore = (dream ? 100 : 50) * budgetFraction;
        const pinnedArm = preregistration.arms.find((arm) => arm.id === armId);
        observations.push({
          repositoryId: repo.id,
          armId,
          budgetFraction,
          repositoryCommitSha256: repo.commitSha256,
          repositoryEnvironmentDigest: repo.environmentDigest,
          armImplementationDigest: pinnedArm.implementationDigest,
          armEnvironmentDigest: pinnedArm.environmentDigest,
          armCommandDigest: pinnedArm.commandDigest,
          performanceScore,
          baselinePerformanceScore: 0,
          correctnessScore: dream ? 1 : 0.9,
          hiddenRegressionCount: 0,
          costMicrousd: (dream ? 1 : 2) * 1_000_000 * budgetFraction,
          cumulativeWallClockMs: 30_000 * budgetFraction,
          agentStarts: Math.round(10 * budgetFraction),
          evaluatorRuns: 20 * budgetFraction,
        });
      }
      if (dream) {
        const artifactDigest = digest(`${repo.id}-winning-artifact`);
        applies.push({ repositoryId: repo.id, armId, artifactDigest, ledgerHeadDigest: digest(`${repo.id}-ledger`), evaluatorEvidenceDigest: digest(`${repo.id}-evidence`), independentlyVerifiable: true });
        freshProcessReproductions.push({ repositoryId: repo.id, armId, artifactDigest, score: 100, freshProcess: true, independent: true });
      }
    }
  }

  const report = {
    schemaVersion: 1,
    preregistrationDigest: digest(JSON.stringify({})),
    evaluator: {
      organization: preregistration.independentEvaluator.organization,
      signingKeySha256: evaluatorKeyDigest,
      evaluatorBuildDigest: preregistration.independentEvaluator.evaluatorBuildDigest,
      hiddenSuiteManifestCommitment: preregistration.independentEvaluator.hiddenSuiteManifestCommitment,
      sealedPopulationCommitment: preregistration.independentEvaluator.sealedPopulationCommitment,
    },
    observations,
    applies,
    canaryDetections: ["canary-1", "canary-2"].map((id) => ({ id, detected: true })),
    freshProcessReproductions,
    policyGenerations: [
      { generation: 1, sealedPopulationScore: 0.5, evaluatedByIndependentJudge: true },
      { generation: 2, sealedPopulationScore: 0.6, evaluatedByIndependentJudge: true },
    ],
    ablations: REQUIRED_ABLATIONS.map((mechanism) => ({
      mechanism,
      metric: "performance",
      fullScores: repositories.map((repo) => ({ repositoryId: repo.id, score: 100 })),
      ablatedScores: repositories.map((repo) => ({ repositoryId: repo.id, score: 90 })),
    })),
    homeBenchmarks: Object.fromEntries(REQUIRED_HOME_BENCHMARKS.map((name) => [name, {
      armId: HOME_BENCHMARK_ARMS[name],
      runCommand: preregistration.homeBenchmarks[name].runCommand,
      baselineDigest: preregistration.homeBenchmarks[name].baselineDigest,
      environmentDigest: preregistration.homeBenchmarks[name].environmentDigest,
      score: 100,
      baselineScore: 100,
    }])),
    lossCases: [],
    reproductionCommands,
  };
  report.preregistrationDigest = preregistrationDigest(preregistration);
  report.receipt = createTournamentResultReceipt(report, evaluatorKeys.privateKey);
  return {
    report,
    preregistration,
    registryPublicKeyPem: registryKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    evaluatorKeyPem,
    evaluatorPrivateKey: evaluatorKeys.privateKey,
  };
}

function audit(bundle) {
  return auditTournamentResults(bundle.report, {
    preregistration: bundle.preregistration,
    trustedRegistryKeyPem: bundle.registryPublicKeyPem,
    evaluatorPublicKeyPem: bundle.evaluatorKeyPem,
  });
}

function resign(bundle) {
  bundle.report.receipt = createTournamentResultReceipt(bundle.report, bundle.evaluatorPrivateKey);
}

test("signed complete results produce a Holm-bootstrap audit and passing report", () => {
  const bundle = fixture();
  const result = audit(bundle);
  assert.equal(result.status, "PASS", JSON.stringify(result, null, 2));
  assert.equal(result.passCriteria.verifiedImprovementHitRate, 1);
  assert.equal(result.budgetHitCurve.length, TOURNAMENT_ARMS.length * 4);
  assert.equal(result.ablationResults.length, REQUIRED_ABLATIONS.length);
  assert.ok(Object.values(result.pareto).every((comparison) => comparison.dominates));
});

test("results refuse a missing evaluator trust anchor and reject report tampering", () => {
  const bundle = fixture();
  const noKey = auditTournamentResults(bundle.report, { preregistration: bundle.preregistration, trustedRegistryKeyPem: bundle.registryPublicKeyPem });
  assert.equal(noKey.status, "FAIL");
  assert.ok(noKey.errors.includes("an evaluator public key must be supplied out of band"));

  bundle.report.observations[0].performanceScore += 1;
  const changed = audit(bundle);
  assert.ok(changed.errors.includes("external evaluator signature is invalid"));
});

test("signed evidence with a hidden regression, missed canary, or failed ablation cannot pass", () => {
  const bundle = fixture();
  bundle.report.observations[0].hiddenRegressionCount = 1;
  bundle.report.canaryDetections[0].detected = false;
  bundle.report.ablations[0].ablatedScores = bundle.report.ablations[0].fullScores;
  resign(bundle);
  const result = audit(bundle);
  assert.equal(result.status, "FAIL");
  assert.equal(result.passCriteria.zeroHiddenRegressions, false);
  assert.ok(result.errors.includes("seeded canary 'canary-1' was not detected"));
  assert.equal(result.allAblationsPass, false);
});

test("checkpoint budgets are enforced and malformed signed reports return diagnostics", () => {
  const overBudget = fixture();
  overBudget.report.observations[0].agentStarts = 7;
  resign(overBudget);
  const budgetResult = audit(overBudget);
  assert.ok(budgetResult.errors.some((error) => error.includes("agent-start allowance at this checkpoint")));

  const malformed = fixture();
  malformed.report.canaryDetections = { invalid: true };
  malformed.report.freshProcessReproductions = { invalid: true };
  malformed.report.policyGenerations = { length: 2 };
  malformed.report.ablations = { invalid: true };
  malformed.report.homeBenchmarks = { invalid: true };
  resign(malformed);
  const malformedResult = audit(malformed);
  assert.equal(malformedResult.status, "FAIL");
  assert.ok(malformedResult.errors.includes("canaryDetections must be an array"));
  assert.ok(malformedResult.errors.includes("policyGenerations must be an array"));
});
