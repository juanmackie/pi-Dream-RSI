import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { jump } from "./fixtures.mjs";

const {
  distillResearchOrgPolicy, distillSealedResearchOrgPolicy, distillSealedWorkflowPolicy,
  sealedPolicyEvidenceSigningBytes, sealedWorkflowEvidenceSigningBytes,
} = await jump("engine/research-policy.ts");
const { researchWorkflowEditDistance, researchWorkflowNeighbors, validateResearchWorkflow } = await jump("engine/workflow-search.ts");

const measuredWorkflow = {
  version: 1,
  stages: [
    { id: "scout", role: "scout", instruction: "measure-first", input: "bottleneck-report", output: "bottleneck-report", after: [] },
    { id: "build", role: "implementer", instruction: "minimal-patch", input: "bottleneck-report", output: "patch-and-rationale", after: ["scout"] },
    { id: "review", role: "reviewer", instruction: "adversarial-review", input: "patch-and-rationale", output: "review-findings", after: ["build"] },
    { id: "verify", role: "verifier", instruction: "independent-reproduction", input: "review-findings", output: "reproduction-record", after: ["review"] },
  ],
};

function signedEvidence(overrides = {}, keyPair = crypto.generateKeyPairSync("ed25519")) {
  const { publicKey, privateKey } = keyPair;
  const payload = {
    version: 1,
    corpusId: "dev-population-2026-01",
    populationDigest: "a".repeat(64),
    repositoryDigest: "b".repeat(64),
    contractId: "contract-domain-a",
    evaluatorId: "trusted-evaluator",
    strategyClass: "session-failure",
    trials: 4,
    wins: 2,
    evidenceDigest: "c".repeat(64),
    ...overrides,
  };
  return {
    evidence: { ...payload, signature: crypto.sign(null, sealedPolicyEvidenceSigningBytes(payload), privateKey).toString("base64") },
    authority: { evaluatorId: "trusted-evaluator", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() },
    privateKey,
  };
}

function record(outcome, strategyClass, overrides = {}) {
  return {
    kind: "campaign",
    leverId: "lever",
    outcome,
    evaluatorRuns: 5,
    agentStarts: 2,
    wallMs: 1000,
    at: "2026-10-20T00:00:00.000Z",
    ...(outcome === "win" ? { verifiedGain: 0.1 } : {}),
    provenance: {
      contractId: "contract-a",
      evaluatorId: "evaluator-a",
      baselineFingerprint: "baseline-a",
      strategyClass,
    },
    ...overrides,
  };
}

test("research policy distillation uses only verified outcomes within matching measurement domains", () => {
  const policy = distillResearchOrgPolicy("base policy\n", [
    record("win", "recon-command"),
    record("no-win", "recon-command", { verifiedGain: undefined }),
    record("win", "git-hotspot", { provenance: { contractId: "contract-b", evaluatorId: "evaluator-b", strategyClass: "git-hotspot" } }),
    record("error", "slow-command"),
    record("win", "post-failure-edits", { verifiedGain: 0, provenance: { contractId: "contract-a", evaluatorId: "evaluator-a", strategyClass: "post-failure-edits" } }),
  ]);

  assert.match(policy, /^base policy/);
  assert.match(policy, /lever class: recon-command/);
  assert.doesNotMatch(policy, /lever class: slow-command/);
  assert.match(policy, /1 independently verified win\(s\) in 2 comparable campaign\(s\)/);
  assert.match(policy, /Corpus digest: [a-f0-9]{64}/);
});

test("research policy distillation is stable and replaces its prior learned section", () => {
  const outcomes = [record("win", "session-failure")];
  const first = distillResearchOrgPolicy("base policy", outcomes);
  const second = distillResearchOrgPolicy(`${first}\n\n<!-- dream-rsi:distilled-policy:start -->\nold repeated section`, outcomes);

  assert.equal(second, first);
  assert.equal((second.match(/Trajectory-derived research priors/g) ?? []).length, 1);
});

test("research policy distillation refuses to learn from unverified or incomplete records", () => {
  assert.equal(distillResearchOrgPolicy("base policy", [
    record("win", "evaluator", { provenance: undefined }),
    record("win", "evaluator", { verifiedGain: 0 }),
    record("no-win", "evaluator"),
    record("rejected", "evaluator"),
  ]), null);
});

test("sealed policy distillation verifies host-pinned records and aggregates across repository population", () => {
  const first = signedEvidence();
  const rows = [first.evidence];
  for (let index = 0; index < 4; index += 1) {
    rows.push(signedEvidence({ repositoryDigest: String(index + 2).repeat(64), trials: 3, wins: 2 }, {
      publicKey: crypto.createPublicKey(first.authority.publicKey),
      privateKey: first.privateKey,
    }).evidence);
  }
  const withheld = new Set(["f".repeat(64)]);
  const policy = distillSealedResearchOrgPolicy("base policy", rows, [first.authority], withheld);

  assert.match(policy, /10 independently verified win\(s\) in 16 sealed-population trial\(s\)/);
  assert.match(policy, /Corpus digest: [a-f0-9]{64}/);
});

test("sealed policy distillation rejects withheld overlap, tampering, duplicate records, and unknown judges", () => {
  const first = signedEvidence();
  const fiveRows = [first.evidence];
  for (let index = 0; index < 4; index += 1) {
    fiveRows.push(signedEvidence({ repositoryDigest: String(index + 2).repeat(64) }, {
      publicKey: crypto.createPublicKey(first.authority.publicKey), privateKey: first.privateKey,
    }).evidence);
  }
  const withheld = new Set(["f".repeat(64)]);
  assert.throws(() => distillSealedResearchOrgPolicy("base", fiveRows, [first.authority], new Set([first.evidence.repositoryDigest])), /withheld confirmation population/);

  const tampered = { ...fiveRows[0], wins: 3 };
  assert.throws(() => distillSealedResearchOrgPolicy("base", [tampered, ...fiveRows.slice(1)], [first.authority], withheld), /signature is invalid/);
  assert.throws(() => distillSealedResearchOrgPolicy("base", fiveRows, [], withheld), /not host-pinned/);
  assert.throws(() => distillSealedResearchOrgPolicy("base", [...fiveRows, first.evidence], [first.authority], withheld), /duplicate repository trajectory/);
  assert.throws(() => distillSealedResearchOrgPolicy("base", [first.evidence], [first.authority], withheld), /at least five development repositories/);
});

test("workflow graph validation and neighbors stay typed, acyclic, and one edit away", () => {
  const workflow = validateResearchWorkflow(measuredWorkflow);
  const neighbors = researchWorkflowNeighbors(workflow);
  assert.ok(neighbors.length > 0);
  assert.ok(neighbors.every((candidate) => researchWorkflowEditDistance(workflow, candidate) === 1));
  assert.throws(() => validateResearchWorkflow({ ...workflow, stages: workflow.stages.map((stage) => ({ ...stage, after: ["missing"] })) }), /unknown or self predecessor/);
  assert.throws(() => validateResearchWorkflow({ ...workflow, stages: workflow.stages.map((stage) => ({ ...stage, instruction: "write-to-hidden-oracle" })) }), /outside the allowlist/);
  assert.throws(() => validateResearchWorkflow({ ...workflow, stages: workflow.stages.map((stage) => ({ ...stage, after: stage.id === "scout" ? ["verify"] : stage.after })) }), /acyclic/);
});

test("workflow priors require signed evidence from five non-withheld repositories", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const authority = { evaluatorId: "workflow-judge", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() };
  const rows = Array.from({ length: 5 }, (_, index) => {
    const payload = {
      version: 1,
      corpusId: "workflow-population-1",
      populationDigest: "a".repeat(64),
      repositoryDigest: String(index + 1).repeat(64),
      contractId: "repo-measurement-v1",
      evaluatorId: authority.evaluatorId,
      workflow: measuredWorkflow,
      trials: 3,
      wins: index < 3 ? 2 : 1,
      evidenceDigest: String(index + 1).repeat(64),
    };
    return { ...payload, signature: crypto.sign(null, sealedWorkflowEvidenceSigningBytes(payload), privateKey).toString("base64") };
  });
  const withheld = new Set(["f".repeat(64)]);
  const policy = distillSealedWorkflowPolicy("base policy", rows, [authority], withheld);
  assert.match(policy, /Trajectory-derived workflow priors/);
  assert.match(policy, /independently verified win\(s\) in 15 sealed-population trial\(s\)/);
  assert.match(policy, /one-edit neighbors/);
  assert.equal(distillSealedWorkflowPolicy(policy, rows, [authority], withheld), policy);
  assert.throws(() => distillSealedWorkflowPolicy("base", rows, [authority], new Set([rows[0].repositoryDigest])), /withheld confirmation population/);
  const tampered = { ...rows[0], wins: 3 };
  assert.throws(() => distillSealedWorkflowPolicy("base", [tampered, ...rows.slice(1)], [authority], withheld), /signature is invalid/);
});
