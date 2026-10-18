/**
 * Optimizer generations.
 *
 * The tool improves itself, but the running process may never certify its own
 * replacement. These tests cover the promotion rule, the guard rails, the sealed
 * confirmation allowance, and activation across a real process boundary with a
 * retained previous champion for rollback.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runLoop } from "../extensions/pi-dream-rsi/engine/loop.ts";
import { normalizeRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";
import {
  applyConfirmationReceipt, archiveGenerationArtifacts, assertGuardRailsIntact, confirmationSigningBytes, decidePromotion, digestArtifacts, emptyGenerationState,
  generationId, loadActiveGeneration, readGenerationState, registerChallenger, rollbackGeneration, writeGenerationState,
  seededCanaryId, seededCanaryManifestDigest,
} from "../extensions/pi-dream-rsi/engine/generation.ts";
import { sealedPolicyEvidenceSigningBytes } from "../extensions/pi-dream-rsi/engine/research-policy.ts";

function loopRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-generation-"));
  return dir;
}

function evidence(overrides = {}) {
  return {
    championScore: 0.42,
    challengerScore: 0.55,
    pairs: 12,
    minimumGain: 0.05,
    championSafetyViolations: 0,
    challengerSafetyViolations: 0,
    challengerRegressions: 0,
    championCost: 40,
    challengerCost: 42,
    maxCostRatio: 1.25,
    minimumPairs: 8,
    ...overrides,
  };
}

const evaluatorKeys = generateKeyPairSync("ed25519");
const canaryManifest = Array.from({ length: 4 }, (_, index) => {
  const seedCommitment = String(index + 5).padStart(64, "0");
  return { id: seededCanaryId(seedCommitment), seedCommitment };
});
const confirmationAuthority = {
  evaluatorId: "external-test-judge",
  publicKey: evaluatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  canaryManifestDigest: seededCanaryManifestDigest(canaryManifest),
};
const policyEvidenceKeys = generateKeyPairSync("ed25519");
const policyEvidenceAuthority = {
  evaluatorId: "sealed-policy-evaluator",
  publicKey: policyEvidenceKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
};

function signedPolicyEvidence(repositoryDigest, overrides = {}) {
  const payload = {
    version: 1,
    corpusId: "sealed-development-v1",
    populationDigest: "a".repeat(64),
    repositoryDigest,
    contractId: "sealed-contract-domain",
    evaluatorId: policyEvidenceAuthority.evaluatorId,
    strategyClass: "git-hotspot",
    trials: 2,
    wins: 1,
    evidenceDigest: "b".repeat(64),
    ...overrides,
  };
  return { ...payload, signature: sign(null, sealedPolicyEvidenceSigningBytes(payload), policyEvidenceKeys.privateKey).toString("base64") };
}

function signedReceipt(challengerId, evidenceValue = evidence(), overrides = {}) {
  const payload = {
    version: 2,
    challengerId,
    candidateGenerationId: challengerId,
    splitId: "heldout-" + challengerId,
    evaluatorId: confirmationAuthority.evaluatorId,
    evaluatedAt: "2026-10-20T02:00:00.000Z",
    freshProcessReproduced: true,
    hiddenSuiteRegressions: 0,
    canaryManifestDigest: confirmationAuthority.canaryManifestDigest,
    canaries: canaryManifest.map((canary) => ({ ...canary, detected: true })),
    evidence: evidenceValue,
    ...overrides,
  };
  return {
    ...payload,
    signature: sign(null, confirmationSigningBytes(payload), evaluatorKeys.privateKey).toString("base64"),
  };
}

function snapshot(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return digestArtifacts(root, Object.keys(files));
}

test("a challenger must clear every constraint before it replaces the champion", () => {
  assert.equal(decidePromotion(evidence()).outcome, "promote");

  const cases = [
    [{ challengerSafetyViolations: 1 }, "reject", /failed 1 fixed safety constraint/],
    [{ challengerRegressions: 2 }, "reject", /regressed 2 fixed case/],
    [{ challengerScore: 0.45 }, "reject", /against a required 0\.050/],
    [{ challengerScore: 0.30 }, "reject", /against a required/],
    [{ challengerCost: 90 }, "reject", /2\.25x the champion, above the 1\.25x ceiling/],
    [{ pairs: 3 }, "inconclusive", /not enough to decide/],
  ];
  for (const [patch, outcome, pattern] of cases) {
    const decision = decidePromotion(evidence(patch));
    assert.equal(decision.outcome, outcome, `${JSON.stringify(patch)} should be ${outcome}`);
    assert.match(decision.reason, pattern);
  }

  // A challenger that is only marginally better still needs a strictly positive gain.
  assert.equal(decidePromotion(evidence({ challengerScore: 0.42, minimumGain: 0 })).outcome, "reject");
  // Ties never promote.
  assert.equal(decidePromotion(evidence({ championScore: 0.5, challengerScore: 0.5, minimumGain: 0 })).outcome, "reject");
});

test("a generation may not replace the loop's own guard rails", () => {
  assert.doesNotThrow(() => assertGuardRailsIntact([{ path: "prompts/discovery-agent.md", sha256: "a" }]));
  for (const policy of ["prompts/policy-improvement.md", "prompts/research-org.md", "extensions/pi-dream-rsi/policy/method.ts"]) {
    assert.doesNotThrow(() => assertGuardRailsIntact([{ path: policy, sha256: "a" }]), policy + " is an editable research policy");
  }
  for (const forbidden of ["tests/hidden-oracle.test.mjs", "eval/bench.mjs", "package.json", "prompts/adversarial-review.md"]) {
    assert.throws(
      () => assertGuardRailsIntact([{ path: forbidden, sha256: "a" }]),
      /outside the editable research-policy allowlist/,
      forbidden + " must stay outside policy generations",
    );
  }
  // The instrument and the statistics decide how a challenger is judged, and the loop
  // wires the guards; a generation that could ship any of them could license itself.
  for (const fixed of ["extensions/pi-dream-rsi/engine/intake.ts", ".dream-rsi/loop/budget.json", "extensions/pi-dream-rsi/engine/generation.ts",
    "extensions/pi-dream-rsi/engine/metrics.ts", "extensions/pi-dream-rsi/engine/measure.ts", "extensions/pi-dream-rsi/engine/loop.ts",
    "extensions/pi-dream-rsi/engine/verify.ts", "extensions/pi-dream-rsi/engine/loop-budget.ts"]) {
    assert.throws(
      () => assertGuardRailsIntact([{ path: fixed, sha256: "a" }]),
      /may not replace a fixed guard rail/,
      `${fixed} must stay fixed across generations`,
    );
  }
});

test("fresh-process loading rechecks the artifact allowlist and content address", () => {
  const root = loopRoot();
  const forbiddenArtifacts = [{ path: "eval/bench.mjs", sha256: "a".repeat(64) }];
  const forbiddenId = generationId(forbiddenArtifacts);
  const champion = {
    id: forbiddenId, label: "forged persisted champion", createdAt: "2026-10-20T00:00:00.000Z",
    parent: null, artifacts: forbiddenArtifacts, status: "champion",
  };
  writeGenerationState(root, { ...emptyGenerationState(), active: forbiddenId, generations: [champion] });
  fs.mkdirSync(path.join(root, "generations"), { recursive: true });
  fs.writeFileSync(path.join(root, "generations", "active.json"), JSON.stringify({ id: forbiddenId }) + "\n");
  assert.throws(() => loadActiveGeneration(root), /outside the editable research-policy allowlist/);

  const permittedArtifacts = [{ path: "prompts/discovery-agent.md", sha256: "b".repeat(64) }];
  const permittedId = generationId(permittedArtifacts);
  const permittedChampion = { ...champion, id: permittedId, artifacts: permittedArtifacts };
  writeGenerationState(root, { ...emptyGenerationState(), active: permittedId, generations: [permittedChampion] });
  fs.writeFileSync(path.join(root, "generations", "active.json"), JSON.stringify({ id: permittedId }) + "\n");
  permittedChampion.artifacts[0].sha256 = "c".repeat(64);
  writeGenerationState(root, { ...emptyGenerationState(), active: permittedId, generations: [permittedChampion] });
  assert.throws(() => loadActiveGeneration(root), /digest does not match its recorded identity/);
});

test("a challenger is registered, promoted once, activated for the next process, and rolled back", () => {
  const root = loopRoot();
  const projectRoot = path.join(root, "project");
  const championArtifacts = snapshot(projectRoot, { "prompts/discovery-agent.md": "champion prompt\n" });
  const championId = generationId(championArtifacts);
  archiveGenerationArtifacts(root, projectRoot, championArtifacts);
  writeGenerationState(root, { ...emptyGenerationState(), generations: [{ id: championId, label: "installed", createdAt: "2026-10-20T00:00:00.000Z", parent: null, artifacts: championArtifacts, status: "champion" }], active: championId });

  const challengerArtifacts = snapshot(projectRoot, { "prompts/discovery-agent.md": "challenger prompt\n" });
  const challenger = registerChallenger(root, { label: "discovery rewrite", artifactRoot: projectRoot, artifacts: challengerArtifacts, now: new Date("2026-10-20T01:00:00.000Z") });
  assert.equal(challenger.status, "challenger");
  assert.equal(challenger.parent, championId);
  assert.throws(() => registerChallenger(root, { label: "duplicate", artifactRoot: projectRoot, artifacts: challengerArtifacts }), /already registered/);
  const forgedReceipt = signedReceipt(challenger.id);
  forgedReceipt.evidence.challengerScore = 0.99;
  assert.throws(
    () => applyConfirmationReceipt(root, challenger.id, forgedReceipt, confirmationAuthority),
    /signature is invalid/,
    "changing a signed score invalidates the evaluator receipt",
  );
  const wrongAuthority = { ...confirmationAuthority, evaluatorId: "candidate-controlled-judge" };
  assert.throws(
    () => applyConfirmationReceipt(root, challenger.id, signedReceipt(challenger.id), wrongAuthority),
    /evaluator is not trusted/,
    "a candidate cannot select the evaluator identity",
  );
  assert.equal(readGenerationState(root).confirmationAttempts, 0, "invalid receipts do not spend or promote");

  assert.equal(loadActiveGeneration(root), null, "registering a challenger does not activate it");

  const receipt = signedReceipt(challenger.id);
  const application = applyConfirmationReceipt(root, challenger.id, receipt, confirmationAuthority);
  assert.equal(application.decision.outcome, "promote");
  const promoted = application.state;
  assert.equal(promoted.active, challenger.id);
  assert.equal(promoted.confirmationAttempts, 1, "the sealed attempt is spent");
  assert.equal(promoted.generations.find((entry) => entry.id === championId).status, "retired", "the previous champion is kept");

  // The activation is durable state a *fresh process* reads, not an in-memory swap.
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { loadActiveGeneration } from ${JSON.stringify(new URL("../extensions/pi-dream-rsi/engine/generation.ts", import.meta.url).href)};
     const active = loadActiveGeneration(${JSON.stringify(root)});
     process.stdout.write(JSON.stringify(active));`], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const loaded = JSON.parse(probe.stdout);
  assert.equal(loaded.id, challenger.id, "a fresh process loads the promoted generation");
  assert.deepEqual(loaded.artifacts, challengerArtifacts, "it loads that generation's recorded artifacts");
  assert.equal(loaded.files["prompts/discovery-agent.md"], "challenger prompt\n", "the fresh process receives the snapshotted policy contents");
  assert.throws(
    () => applyConfirmationReceipt(root, challenger.id, receipt, confirmationAuthority),
    /staged challenger/,
    "a promoted generation cannot be evaluated again using stale confirmation",
  );

  const rolledBack = rollbackGeneration(root);
  assert.equal(rolledBack.restored, championId, "rollback returns to the previous champion");
  assert.equal(readGenerationState(root).generations.find((entry) => entry.id === challenger.id).status, "retired");
  assert.equal(loadActiveGeneration(root).id, championId);
  assert.equal(loadActiveGeneration(root).files["prompts/discovery-agent.md"], "champion prompt\n");
  fs.writeFileSync(path.join(root, "generations", "artifacts", championId, "prompts", "discovery-agent.md"), "tampered snapshot\n");
  assert.throws(() => loadActiveGeneration(root), /failed its digest check/);
});

test("rejected challengers never activate, and the sealed allowance cannot be renewed", () => {
  const root = loopRoot();
  const projectRoot = path.join(root, "project");
  const championArtifacts = snapshot(projectRoot, { "prompts/discovery-agent.md": "champion\n" });
  const championId = generationId(championArtifacts);
  archiveGenerationArtifacts(root, projectRoot, championArtifacts);
  writeGenerationState(root, { ...emptyGenerationState(1), generations: [{ id: championId, label: "installed", createdAt: "2026-10-20T00:00:00.000Z", parent: null, artifacts: championArtifacts, status: "champion" }], active: championId });

  const bad = registerChallenger(root, { label: "gaming", artifactRoot: projectRoot, artifacts: snapshot(projectRoot, { "prompts/discovery-agent.md": "gaming\n" }) });
  const badReceipt = signedReceipt(bad.id, evidence({ challengerRegressions: 1 }));
  const rejected = applyConfirmationReceipt(root, bad.id, badReceipt, confirmationAuthority, 1).state;
  assert.equal(rejected.active, championId, "a rejected challenger leaves the champion active");
  assert.equal(rejected.generations.find((entry) => entry.id === bad.id).status, "rejected");
  assert.equal(loadActiveGeneration(root), null, "no activation marker is written for a rejection");
  fs.mkdirSync(path.join(root, "generations"), { recursive: true });
  fs.writeFileSync(path.join(root, "generations", "active.json"), `${JSON.stringify({ id: bad.id })}\n`);
  assert.equal(loadActiveGeneration(root), null, "a marker cannot activate rejected code or disagree with the ledger");

  const second = registerChallenger(root, { label: "second attempt", artifactRoot: projectRoot, artifacts: snapshot(projectRoot, { "prompts/discovery-agent.md": "second\n" }) });
  assert.throws(
    () => applyConfirmationReceipt(root, second.id, signedReceipt(second.id), confirmationAuthority, 1),
    /no sealed confirmation attempts remain/,
    "an exposed split cannot be queried again until a fresh one is authorised",
  );
  // A caller may lower the ledger's allowance but never raise it.
  assert.throws(
    () => applyConfirmationReceipt(root, second.id, signedReceipt(second.id), confirmationAuthority, 99),
    /no sealed confirmation attempts remain/,
    "a larger caller-supplied limit cannot resurrect a spent sealed split",
  );
});

test("signed confirmation rejects missing fresh-process reproduction and undetected canaries", () => {
  const root = loopRoot();
  const projectRoot = path.join(root, "project");
  const first = registerChallenger(root, {
    label: "not reproduced",
    artifactRoot: projectRoot,
    artifacts: snapshot(projectRoot, { "prompts/discovery-agent.md": "fresh process failed\n" }),
  });
  const firstReceipt = signedReceipt(first.id, evidence(), { freshProcessReproduced: false });
  const noReproduction = applyConfirmationReceipt(root, first.id, firstReceipt, confirmationAuthority);
  assert.equal(noReproduction.decision.outcome, "reject");
  assert.match(noReproduction.decision.reason, /fresh process/);
  assert.equal(noReproduction.state.active, null);

  const second = registerChallenger(root, {
    label: "missed canary",
    artifactRoot: projectRoot,
    artifacts: snapshot(projectRoot, { "prompts/discovery-agent.md": "canary missed\n" }),
  });
  assert.throws(
    () => applyConfirmationReceipt(
      root, second.id, signedReceipt(second.id, evidence(), { splitId: firstReceipt.splitId }), confirmationAuthority,
    ),
    /split was already consumed/,
    "a fresh receipt cannot reuse an already exposed split",
  );
  const missedCanary = applyConfirmationReceipt(
    root, second.id, signedReceipt(second.id, evidence(), {
      canaries: canaryManifest.map((canary, index) => ({ ...canary, detected: index !== 2 })),
    }), confirmationAuthority,
  );
  assert.equal(missedCanary.decision.outcome, "reject");
  assert.ok(missedCanary.decision.reason.includes("3/4 seeded canary"));
  assert.equal(missedCanary.state.active, null);
  assert.equal(missedCanary.state.confirmationAttempts, 2);
  assert.equal(missedCanary.state.confirmationSplits.length, 2);
});

test("signed confirmation binds every seeded canary commitment to the host-pinned manifest", () => {
  const root = loopRoot();
  const projectRoot = path.join(root, "project");
  const challenger = registerChallenger(root, {
    label: "wrong canary manifest",
    artifactRoot: projectRoot,
    artifacts: snapshot(projectRoot, { "prompts/discovery-agent.md": "candidate\n" }),
  });
  const changedCanaries = canaryManifest.map((canary, index) => ({
    ...canary,
    seedCommitment: index === 0 ? "f".repeat(64) : canary.seedCommitment,
    detected: true,
  })).map((canary) => ({ ...canary, id: seededCanaryId(canary.seedCommitment) }));
  const receipt = signedReceipt(challenger.id, evidence(), {
    canaries: changedCanaries,
    canaryManifestDigest: seededCanaryManifestDigest(changedCanaries),
  });
  assert.throws(
    () => applyConfirmationReceipt(root, challenger.id, receipt, confirmationAuthority),
    /host-pinned seeded canary manifest/,
  );
  const state = readGenerationState(root);
  assert.equal(state.confirmationAttempts, 0, "untrusted canary evidence does not consume a sealed evaluation attempt");
  assert.equal(state.generations.find((generation) => generation.id === challenger.id)?.status, "challenger");
});

test("a corrupt generation ledger is reported instead of silently reset", () => {
  const root = loopRoot();
  fs.mkdirSync(path.join(root, "generations"), { recursive: true });
  fs.writeFileSync(path.join(root, "generations", "state.json"), "{ not json");
  assert.throws(() => readGenerationState(root), /unreadable/);
  fs.writeFileSync(path.join(root, "generations", "state.json"), JSON.stringify({ version: 1, active: null, generations: [{ id: "x" }], confirmationAttempts: 0 }));
  assert.throws(() => readGenerationState(root), /invalid entry/);
});

test("a loop that plateaus retains the champion when no sealed harness is configured", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-generation-loop-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), `${JSON.stringify({
    name: "plateau", private: true, type: "module", scripts: { test: "node test.mjs", bench: "node bench.mjs" },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(projectDir, "bench.mjs"), 'import { work } from "./src/work.mjs";\nwork();\n');
  // A real oracle: it imports the editable code, so an inert version fails it.
  fs.writeFileSync(path.join(projectDir, "test.mjs"), 'import { work } from "./src/work.mjs";\nif (work() !== 1) process.exit(1);\n');
  // Deterministic work of a real, measurable length, so the campaign preflight can
  // resolve a practical gain on this fixture.
  fs.writeFileSync(path.join(projectDir, "src", "work.mjs"),
    "export function work() {\n  const until = performance.now() + 250;\n  while (performance.now() < until) { /* measured work */ }\n  return 1;\n}\n");

  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "reduce benchmark duration", unit: "ms", higherIsBetter: false, minimumUsefulGain: "50%" },
    preserved: { gates: [] },
    scope: { roots: ["src"], protectedAssets: [] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    models: { providers: ["fixture"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 14, maxEvaluatorRuns: 60, deadlineMs: 5 * 60_000, falseAcceptBudget: 0.01, optimizerTrials: 1 },
    agent: { command: process.execPath, args: ["-e", "0"], prompt_via: "stdin", model: null, thinking: null },
  });

  const result = await runLoop({
    projectDir,
    contract,
    // No plateau restart here: this test is about what happens when the loop stops.
    limits: { maxCampaigns: 2, maxAgentStarts: 14, maxEvaluatorRuns: 60, deadlineMs: 5 * 60_000, plateauK: 1, maxRestarts: 0, maxOptimizerTrials: 1 },
    campaignDefaults: { maxCycles: 1 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });

  assert.equal(result.generation, null, "no generation is active until one is promoted");
  assert.ok(
    result.memory.notes.some((note) => /no sealed confirmation harness is configured/.test(note)),
    `expected an honest retain note, got ${JSON.stringify(result.memory.notes)}`,
  );
  const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
  assert.equal(budget.optimizer_trials, 0, "no trial was spent when none could be scored");
});

test("a loop promotes a scripted challenger only after its evidence passes, and the run does not hot-swap", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-generation-promote-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), `${JSON.stringify({
    name: "promote", private: true, type: "module", scripts: { test: "node test.mjs", bench: "node bench.mjs" },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(projectDir, "bench.mjs"), 'import { work } from "./src/work.mjs";\nwork();\n');
  // A real oracle: it imports the editable code, so an inert version fails it.
  fs.writeFileSync(path.join(projectDir, "test.mjs"), 'import { work } from "./src/work.mjs";\nif (work() !== 1) process.exit(1);\n');
  // Deterministic work of a real, measurable length, so the campaign preflight can
  // resolve a practical gain on this fixture.
  fs.writeFileSync(path.join(projectDir, "src", "work.mjs"),
    "export function work() {\n  const until = performance.now() + 250;\n  while (performance.now() < until) { /* measured work */ }\n  return 1;\n}\n");

  const loopRootDir = path.join(projectDir, ".dream-rsi", "loop");
  fs.mkdirSync(path.join(loopRootDir, "generations"), { recursive: true });
  const verifiedTrajectory = {
    kind: "campaign", leverId: "prior-lever", outcome: "win", evaluatorRuns: 9, agentStarts: 7,
    wallMs: 1000, at: "2026-10-19T00:00:00.000Z", verifiedGain: 0.2,
    provenance: { contractId: "training-contract", evaluatorId: "training-evaluator", baselineFingerprint: "training-baseline", mechanism: "batch independent roots", strategyClass: "recon-command" },
  };
  fs.writeFileSync(path.join(loopRootDir, "memory.json"), JSON.stringify({ version: 1, leverStats: {}, outcomes: [verifiedTrajectory], notes: [] }));

  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "reduce benchmark duration", unit: "ms", higherIsBetter: false, minimumUsefulGain: "50%" },
    preserved: { gates: [] },
    scope: { roots: ["src"], protectedAssets: [] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    models: { providers: ["fixture"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 14, maxEvaluatorRuns: 60, deadlineMs: 5 * 60_000, falseAcceptBudget: 0.01, optimizerTrials: 1 },
    agent: { command: process.execPath, args: ["-e", "0"], prompt_via: "stdin", model: null, thinking: null },
  });

  const result = await runLoop({
    projectDir,
    contract,
    // No plateau restart here: this test is about what happens when the loop stops.
    limits: { maxCampaigns: 2, maxAgentStarts: 14, maxEvaluatorRuns: 60, deadlineMs: 5 * 60_000, plateauK: 1, maxRestarts: 0, maxOptimizerTrials: 1 },
    campaignDefaults: { maxCycles: 1 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
    confirmationAuthority,
    sealedPolicy: {
      evidence: Array.from({ length: 5 }, (_, index) => signedPolicyEvidence(String(index + 1).repeat(64))),
      authorities: [policyEvidenceAuthority],
      withheldRepositoryDigests: new Set(["f".repeat(64)]),
    },
    optimizerTrial: async ({ loopRoot, candidate }) => {
      assert.match(candidate.files["prompts/research-org.md"], /lever class: git-hotspot/);
      assert.doesNotMatch(candidate.files["prompts/research-org.md"], /lever class: recon-command/);
      const staged = registerChallenger(loopRoot, {
        label: candidate.label,
        artifactRoot: candidate.artifactRoot,
        artifacts: candidate.artifacts,
      });
      assert.equal(staged.id, candidate.id);
      return { challengerId: candidate.id, receipt: signedReceipt(candidate.id) };
    },
  });

  assert.equal(result.stopReason, "plateau");
  const state = readGenerationState(loopRootDir);
  const challengerId = state.generations.find((entry) => entry.status === "champion").id;
  assert.equal(state.active, challengerId, "the challenger is the active generation for the next run");
  assert.equal(state.confirmationAttempts, 1);
  assert.ok(result.memory.notes.some((note) => /promoted .*It activates in the next process, not this one/.test(note)));
  assert.equal(result.generation, challengerId, "the result reports the generation the next run would use");

  // A separate loop state models the next process/session: it loads the durable
  // promoted generation and forwards its verified contents into a new campaign.
  const nextLoopRoot = path.join(projectDir, ".dream-rsi", "loop-next");
  fs.cpSync(path.join(loopRootDir, "generations"), path.join(nextLoopRoot, "generations"), { recursive: true });
  let nextCampaignOptions = null;
  const nextRun = await runLoop({
    projectDir,
    loopRoot: nextLoopRoot,
    contract,
    limits: { maxCampaigns: 1, maxAgentStarts: 14, maxEvaluatorRuns: 60, deadlineMs: 5 * 60_000, plateauK: 1, maxRestarts: 0 },
    campaignDefaults: { maxCycles: 1 },
    now: () => new Date("2026-10-20T00:01:00.000Z"),
    runCampaignImpl: async (options) => {
      nextCampaignOptions = options;
      const campaignRoot = path.join(options.baseRoot, "campaigns", "next-process-fixture");
      fs.mkdirSync(path.join(campaignRoot, "history"), { recursive: true });
      fs.writeFileSync(path.join(campaignRoot, "history", "ledger.jsonl"), "");
      return {
        id: "next-process-fixture", baseRoot: options.baseRoot, campaignRoot, engineRoot: campaignRoot,
        state: { kind: "complete", reason: "fixture" }, stopped: true, stopReason: "fixture",
        agentStarts: 0, evaluatorRuns: 0, currentScore: 0, bestScore: 0, baselineScore: 0,
        startedAt: "2026-10-20T00:01:00.000Z",
      };
    },
  });
  assert.equal(nextRun.generation, challengerId);
  assert.equal(nextCampaignOptions.optimizerGeneration.id, challengerId);
  assert.match(nextCampaignOptions.optimizerGeneration.files["prompts/research-org.md"], /lever class: git-hotspot/);
});

void runLoop;
void emptyGenerationState;
