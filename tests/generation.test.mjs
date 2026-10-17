/**
 * Optimizer generations.
 *
 * The tool improves itself, but the running process may never certify its own
 * replacement. These tests cover the promotion rule, the guard rails, the sealed
 * confirmation allowance, and activation across a real process boundary with a
 * retained previous champion for rollback.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runLoop } from "../extensions/pi-dream-rsi/engine/loop.ts";
import { normalizeRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";
import {
  applyPromotionDecision, assertGuardRailsIntact, decidePromotion, digestArtifacts, emptyGenerationState,
  generationId, loadActiveGeneration, readGenerationState, registerChallenger, rollbackGeneration, writeGenerationState,
} from "../extensions/pi-dream-rsi/engine/generation.ts";

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

test("a challenger is registered, promoted once, activated for the next process, and rolled back", () => {
  const root = loopRoot();
  const projectRoot = path.join(root, "project");
  const championArtifacts = snapshot(projectRoot, { "prompts/discovery-agent.md": "champion prompt\n" });
  const championId = generationId(championArtifacts);
  writeGenerationState(root, { ...emptyGenerationState(), generations: [{ id: championId, label: "installed", createdAt: "2026-10-20T00:00:00.000Z", parent: null, artifacts: championArtifacts, status: "champion" }], active: championId });

  const challengerArtifacts = snapshot(projectRoot, { "prompts/discovery-agent.md": "challenger prompt\n" });
  const challenger = registerChallenger(root, { label: "discovery rewrite", artifacts: challengerArtifacts, now: new Date("2026-10-20T01:00:00.000Z") });
  assert.equal(challenger.status, "challenger");
  assert.equal(challenger.parent, championId);
  assert.throws(() => registerChallenger(root, { label: "duplicate", artifacts: challengerArtifacts }), /already registered/);

  assert.equal(loadActiveGeneration(root), null, "registering a challenger does not activate it");

  const decision = decidePromotion(evidence());
  const promoted = applyPromotionDecision(root, challenger.id, decision);
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

  const rolledBack = rollbackGeneration(root);
  assert.equal(rolledBack.restored, championId, "rollback returns to the previous champion");
  assert.equal(readGenerationState(root).generations.find((entry) => entry.id === challenger.id).status, "retired");
  assert.equal(loadActiveGeneration(root).id, championId);
});

test("rejected challengers never activate, and the sealed allowance cannot be renewed", () => {
  const root = loopRoot();
  const projectRoot = path.join(root, "project");
  const championArtifacts = snapshot(projectRoot, { "prompts/discovery-agent.md": "champion\n" });
  const championId = generationId(championArtifacts);
  writeGenerationState(root, { ...emptyGenerationState(1), generations: [{ id: championId, label: "installed", createdAt: "2026-10-20T00:00:00.000Z", parent: null, artifacts: championArtifacts, status: "champion" }], active: championId });

  const bad = registerChallenger(root, { label: "gaming", artifacts: snapshot(projectRoot, { "prompts/discovery-agent.md": "gaming\n" }) });
  const rejected = applyPromotionDecision(root, bad.id, decidePromotion(evidence({ challengerRegressions: 1 })), 1);
  assert.equal(rejected.active, championId, "a rejected challenger leaves the champion active");
  assert.equal(rejected.generations.find((entry) => entry.id === bad.id).status, "rejected");
  assert.equal(loadActiveGeneration(root), null, "no activation marker is written for a rejection");

  const second = registerChallenger(root, { label: "second attempt", artifacts: snapshot(projectRoot, { "prompts/discovery-agent.md": "second\n" }) });
  assert.throws(
    () => applyPromotionDecision(root, second.id, decidePromotion(evidence()), 1),
    /no sealed confirmation attempts remain/,
    "an exposed split cannot be queried again until a fresh one is authorised",
  );
  // A caller may lower the ledger's allowance but never raise it.
  assert.throws(
    () => applyPromotionDecision(root, second.id, decidePromotion(evidence()), 99),
    /no sealed confirmation attempts remain/,
    "a larger caller-supplied limit cannot resurrect a spent sealed split",
  );
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
  const artifacts = snapshot(path.join(dir, "snapshot"), { "prompts/discovery-agent.md": "challenger prompt\n" });
  const challengerId = generationId(artifacts);
  registerChallenger(loopRootDir, { label: "scripted challenger", artifacts });

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
    optimizerTrial: async () => ({ challengerId, evidence: evidence() }),
  });

  assert.equal(result.stopReason, "plateau");
  const state = readGenerationState(loopRootDir);
  assert.equal(state.active, challengerId, "the challenger is the active generation for the next run");
  assert.equal(state.confirmationAttempts, 1);
  assert.ok(result.memory.notes.some((note) => /promoted .*It activates in the next process, not this one/.test(note)));
  assert.equal(result.generation, challengerId, "the result reports the generation the next run would use");
});

void runLoop;
void emptyGenerationState;
