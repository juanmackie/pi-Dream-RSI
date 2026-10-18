import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import {
  auditTournamentPreregistration,
  createPreregistrationReceipt,
  HOME_BENCHMARK_ARMS,
  REQUIRED_ABLATIONS,
  REQUIRED_HOME_BENCHMARKS,
  TOURNAMENT_ARMS,
} from "../eval/tournament/preregistration.mjs";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fixture() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const manifest = {
    schemaVersion: 1,
    title: "Dream-RSI unseen-repository tournament",
    project: { owner: "dream-rsi-team", repository: "pi-Dream-RSI" },
    repositories: ["python", "rust", "go", "typescript", "java"].map((language, index) => ({
      id: `heldout-${index + 1}`,
      language,
      commitSha256: digest(`heldout-commit-${index}`),
      environmentDigest: digest(`heldout-environment-${index}`),
      withheldFromOptimizer: true,
      budget: { wallClockMs: 3_600_000, agentStarts: 24, evaluatorRuns: 80, maxCostMicrousd: 25_000_000, independentEvaluationReserve: { wallClockMs: 120_000, evaluatorRuns: 4, maxCostMicrousd: 1_000_000 } },
    })),
    arms: TOURNAMENT_ARMS.map((id) => {
      const command = ["npm", "run", "tournament-arm", "--", "--arm", id];
      return {
        id,
        implementationDigest: digest(`${id}-implementation`),
        environmentDigest: digest(`${id}-environment`),
        commandDigest: digest(JSON.stringify(command)),
        command,
        budgetMultiplier: 1,
      };
    }),
    independentEvaluator: {
      organization: "independent-eval-lab",
      controlsHiddenSuites: true,
      signingKeySha256: digest("external-evaluator-key"),
      evaluatorBuildDigest: digest("evaluator-build"),
      hiddenSuiteManifestCommitment: digest("hidden-suite-manifest"),
      sealedPopulationCommitment: digest("sealed-population"),
      canaryManifestCommitment: digest("canary-manifest"),
      canaryIds: ["seeded-001", "seeded-002"],
    },
    execution: {
      protocolVersion: 1,
      checkpointMode: "single-run-cumulative-checkpoints",
      schedule: "sha256-cell-order-v1",
      sandboxAdapterDigest: digest("sandbox-adapter"),
      networkEgress: "deny",
    },
    policyDevelopmentPopulation: Array.from({ length: 5 }, (_, index) => digest(`development-repo-${index}`)),
    statistics: {
      unit: "repository",
      confidenceLevel: 0.95,
      intervalMethod: "paired-bootstrap",
      comparisonAlternative: "one-sided-dream-advantage",
      outcomeDirections: { performance: "higher", correctness: "higher", hidden_regressions: "lower", cost: "lower", hit_rate: "higher" },
      bootstrapReplicates: 20_000,
      bootstrapSeed: 101,
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
    ablations: REQUIRED_ABLATIONS.map((mechanism) => ({ mechanism, metric: "performance", expectedOutcome: `removing ${mechanism} lowers held-out performance` })),
    homeBenchmarks: Object.fromEntries(REQUIRED_HOME_BENCHMARKS.map((name) => [name, {
      name: `${name} primary benchmark`,
      armId: HOME_BENCHMARK_ARMS[name],
      runCommand: ["npm", "run", "home-benchmark", "--", "--name", name],
      baselineDigest: digest(`${name}-baseline`),
      environmentDigest: digest(`${name}-environment`),
    }])),
    reporting: {
      includesLossCases: true,
      includesCostHitRateCurve: true,
      includesExactReproductionCommands: true,
    },
  };
  manifest.registration = createPreregistrationReceipt(manifest, {
    url: "https://registry.example.org/preregistrations/dream-rsi-2026",
    registeredAt: "2026-10-18T00:00:00.000Z",
    privateKey,
  });
  return { manifest, trustedRegistryKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString() };
}

test("a complete independently signed preregistration validates against an out-of-band registry key", () => {
  const { manifest, trustedRegistryKeyPem } = fixture();
  const result = auditTournamentPreregistration(manifest, { trustedRegistryKeyPem });
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.match(result.digest, /^[a-f0-9]{64}$/);
});

test("a local draft cannot be called registered without a trusted registry key", () => {
  const { manifest } = fixture();
  const result = auditTournamentPreregistration(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("a trusted registry public key must be supplied out of band"));
});

test("a changed manifest or substituted registry key invalidates the external receipt", () => {
  const { manifest, trustedRegistryKeyPem } = fixture();
  manifest.repositories[0].commitSha256 = digest("changed-after-registration");
  const mutated = auditTournamentPreregistration(manifest, { trustedRegistryKeyPem });
  assert.ok(mutated.errors.includes("registration.digest does not match the canonical preregistration content"));

  const other = crypto.generateKeyPairSync("ed25519");
  const substituted = auditTournamentPreregistration(fixture().manifest, {
    trustedRegistryKeyPem: other.publicKey.export({ format: "pem", type: "spki" }).toString(),
  });
  assert.ok(substituted.errors.includes("registration registry key does not match the out-of-band trust anchor"));
  assert.ok(substituted.errors.includes("external preregistration signature is invalid"));
});

test("the preregistration gate rejects an incomplete split, arm set, and home-benchmark plan", () => {
  const { manifest, trustedRegistryKeyPem } = fixture();
  manifest.repositories = manifest.repositories.slice(0, 4);
  for (const repository of manifest.repositories) repository.language = "python";
  manifest.arms = manifest.arms.slice(0, 6);
  delete manifest.homeBenchmarks.mass;
  const result = auditTournamentPreregistration(manifest, { trustedRegistryKeyPem });
  assert.ok(result.errors.includes("at least five withheld evaluation repositories are required"));
  assert.ok(result.errors.includes("exactly seven budget-matched arms are required"));
  assert.ok(result.errors.includes("evaluation repositories must span at least three languages"));
  assert.ok(result.errors.includes("required arm 'profile_guided' is missing"));
  assert.ok(result.errors.includes("home benchmark 'mass' is missing"));
});

test("the result protocol pins canaries, budget checkpoints, reproduction tolerance, home arms, and argv", () => {
  const { manifest, trustedRegistryKeyPem } = fixture();
  manifest.independentEvaluator.canaryIds = ["seeded-001", "seeded-001"];
  manifest.statistics.budgetCheckpoints = [0.5, 1];
  manifest.statistics.reproductionTolerance = -1;
  manifest.statistics.comparisonAlternative = "two-sided";
  manifest.homeBenchmarks.mass.armId = "dream_rsi_2";
  manifest.arms[0].command = "npm run unpinned-shell-command";
  manifest.ablations[0].metric = "self_reported_success";
  const result = auditTournamentPreregistration(manifest, { trustedRegistryKeyPem });
  assert.ok(result.errors.includes("independentEvaluator.canaryIds[1] must be present and unique"));
  assert.ok(result.errors.includes("statistics.budgetCheckpoints must equal [0.25, 0.5, 0.75, 1]"));
  assert.ok(result.errors.includes("statistics.reproductionTolerance must be a finite non-negative number"));
  assert.ok(result.errors.includes("statistics.comparisonAlternative must be 'one-sided-dream-advantage'"));
  assert.ok(result.errors.includes("home benchmark 'mass' must use arm 'mass_workflow_search'"));
  assert.ok(result.errors.includes("arms[0].command must be a non-empty argv array, not a shell command string"));
  assert.ok(result.errors.includes(`ablation '${REQUIRED_ABLATIONS[0]}' must use the preregistered performance metric`));
});

test("malformed JSON field shapes produce diagnostics instead of crashing the audit", () => {
  const { manifest, trustedRegistryKeyPem } = fixture();
  manifest.repositories = { unexpected: true };
  manifest.policyDevelopmentPopulation = [digest("development-repo")];
  manifest.ablations = { unexpected: true };
  manifest.registration.signatureBase64 = { unexpected: true };
  const result = auditTournamentPreregistration(manifest, { trustedRegistryKeyPem });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("at least five withheld evaluation repositories are required"));
  assert.ok(result.errors.includes("ablations must be an array"));
  assert.ok(result.errors.includes("registration.signatureBase64 must be a base64 string"));
});
