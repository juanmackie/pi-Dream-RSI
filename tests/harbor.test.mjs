import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateEvidenceProtocol, validatePilot } from "../harbor/validate.mjs";
import { analyzePilot, analyzeEvidence } from "../harbor/analyze.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pilot = JSON.parse(fs.readFileSync(path.join(root, "harbor/pilot.json"), "utf8"));
const evidenceProtocol = JSON.parse(fs.readFileSync(path.join(root, "harbor/evidence-protocol.json"), "utf8"));

function pilotResults() {
  const repositories = Array.from({ length: 6 }, (_, i) => ({
    id: `repo-${i + 1}`, language: ["js", "py", "go", "rust", "java", "csharp"][i], split: i < 3 ? "development" : "held-out",
    experiments: Array.from({ length: 5 }, (_, n) => ({ verified: i === 3 && n === 0, ratio: i === 3 && n === 0 ? 2.1 : 1, correctness: "pass", ...(i === 3 && n === 0 ? { commit: "abc123" } : {}) })),
  }));
  return { schemaVersion: 1, study: "dream-rsi-pilot", source: "fixture", repositories,
    negativeControl: { attempts: 5, commits: 0, correctnessRegressions: 0, headroom: 0, worktreeSharedWithTreatment: false },
    replays: [{ commit: "abc123", cleanCheckout: true, passed: true }], evaluatorCv: { wallClock: 0.02, deterministic: 0.005 }, spendUsd: 0 };
}

function evidenceResults() {
  const treatmentRepositories = Array.from({ length: 16 }, (_, i) => ({
    id: `treatment-${i + 1}`, language: ["js", "py", "go", "rs", "java", "c", "cs", "rb"][i % 8], split: i < 10 ? "development" : "held-out", tokens: 10000, spendUsd: 20,
    campaigns: Array.from({ length: 10 }, (_, n) => ({
      verifiedWin: i >= 10, ratio: i >= 10 ? (i >= 10 && i <= 13 && n === 0 ? 2 : 1.6) : null,
      magnitudeWin: i >= 10 && n < 2, correctness: "pass", commit: i >= 10 ? `commit-${i}-${n}` : null,
    })),
  }));
  return { schemaVersion: 1, study: "dream-rsi-evidence-track", source: "fixture", pilotRepositoryIds: Array.from({ length: 6 }, (_, i) => `pilot-${i + 1}`), scopeFrozen: true, outOfScopeChanges: 0, protectedVerifierChanges: 0, treatmentRepositories,
    negativeControls: Array.from({ length: 4 }, (_, i) => ({ id: `negative-${i + 1}`, campaigns: 10, commits: 0, headroom: 0, worktreeSharedWithTreatment: false })),
    developmentControlArms: { repositories: 10, campaignsPerArm: 5, placebo: 50, textbook: 50, shuffled: 50, aaPairedSequences: 60, commits: 0, worktreeSharedWithTreatment: false },
    cleanCheckoutReplay: { passed: 60, required: 60, failed: 0 },
    replays: Array.from({ length: 60 }, (_, i) => ({ commit: `commit-${Math.floor(i / 10) + 10}-${i % 10}`, cleanCheckout: true, passed: true })), crashRecovery: { passed: 12, required: 12 }, redTeam: { classes: 12, repeatsPerClass: 3, successes: 0 },
    evaluatorCv: { wallClock: 0.02 }, spendUsd: 1000, tokens: 1000000, ratioCiLower95: 1.2 };
}

test("frozen pilot manifest passes design validation but cannot claim readiness without six approved pins", () => {
  const frozen = validatePilot(pilot);
  assert.equal(frozen.ok, true);
  assert.equal(frozen.ready, false);
  assert.equal(validatePilot(pilot, { ready: true }).ok, false);
  const corrupted = structuredClone(pilot); corrupted.pass.heldOutRepositoriesWithVerified2xWin = 0;
  assert.match(validatePilot(corrupted).errors.join(" "), /pass or cost gate/);
});

test("ready pilot pins are checked against six local Git checkouts without running project commands", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-harbor-pins-"));
  try {
    const repositories = Array.from({ length: 6 }, (_, i) => {
      const dir = path.join(temp, `r${i}`); fs.mkdirSync(dir);
      const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
      git("init", "--initial-branch=main"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
      fs.writeFileSync(path.join(dir, "README.md"), `fixture ${i}\n`); git("add", "."); git("commit", "-m", "fixture");
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      return { id: `repo-${i}`, source: dir, sha, language: ["js", "py", "go", "rs", "java", "c"][i], split: i < 3 ? "development" : "held-out" };
    });
    assert.equal(validatePilot({ ...pilot, repositories }, { ready: true, baseDir: temp }).ready, true);
    const stale = structuredClone(repositories); stale[0].sha = "0".repeat(40);
    assert.match(validatePilot({ ...pilot, repositories: stale }, { ready: true, baseDir: temp }).errors.join(" "), /HEAD differs/);
    const remote = structuredClone(repositories); remote[0].source = "https://example.invalid/repo.git";
    assert.match(validatePilot({ ...pilot, repositories: remote }, { ready: false }).errors.join(" "), /local source path/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("pilot and evidence run commands emit pending schedules only", () => {
  for (const mode of ["--pilot", "--evidence"]) {
    const output = spawnSync(process.execPath, [path.join(root, "harbor/run.mjs"), mode], { cwd: root, encoding: "utf8" });
    assert.equal(output.status, 0, output.stderr);
    const schedule = JSON.parse(output.stdout);
    assert.equal(schedule.executed, false);
    assert.equal(schedule.mode, "schedule-only");
    assert.equal(schedule.slots.length, 0);
    if (mode === "--pilot") assert.equal(schedule.needsOperatorPins, true);
    else assert.equal(schedule.requiresSeparateExecutionApproval, true);
  }
});

test("pilot analysis enforces held-out, control, replay, CV and cost gates; fixture is marked simulated", () => {
  const good = analyzePilot(pilotResults());
  assert.equal(good.pass, true, good.errors.join("; "));
  assert.equal(good.source, "simulated");
  assert.match(good.conclusion, /SIMULATED ONLY/);
  const contaminated = pilotResults(); contaminated.negativeControl.commits = 1;
  assert.match(analyzePilot(contaminated).errors.join(" "), /negative control/);
  const missingReplay = pilotResults(); missingReplay.replays[0].cleanCheckout = false;
  assert.match(analyzePilot(missingReplay).errors.join(" "), /clean-checkout replay/);
  const wrongSplit = pilotResults(); wrongSplit.repositories[0].split = "held-out";
  assert.match(analyzePilot(wrongSplit).errors.join(" "), /denominator/);
  const malformedRow = pilotResults(); malformedRow.repositories[0].experiments[0] = null;
  assert.equal(analyzePilot(malformedRow).pass, false);
  assert.equal(analyzePilot(null).pass, false);
});

test("full evidence protocol validates frozen denominators and rejects edits", () => {
  assert.equal(validateEvidenceProtocol(evidenceProtocol).ok, true);
  const changed = structuredClone(evidenceProtocol); changed.denominators.heldOutCampaigns = 59;
  assert.equal(validateEvidenceProtocol(changed).ok, false);
});

test("optional evidence analysis checks all denominators, kill gates and control isolation", () => {
  const good = analyzeEvidence(evidenceResults());
  assert.equal(good.pass, true, good.errors.join("; "));
  assert.equal(good.source, "simulated");
  assert.match(good.conclusion, /SIMULATED ONLY/);
  const contaminated = evidenceResults(); contaminated.negativeControls[0].worktreeSharedWithTreatment = true;
  const bad = analyzeEvidence(contaminated);
  assert.equal(bad.pass, false);
  assert.equal(bad.killTriggered, true);
  assert.match(bad.errors.join(" "), /isolated negative controls/);
  const overlap = evidenceResults(); overlap.pilotRepositoryIds[0] = "treatment-1";
  assert.match(analyzeEvidence(overlap).errors.join(" "), /disjoint from the pilot/);
  const controlOverlap = evidenceResults(); controlOverlap.negativeControls[0].id = "pilot-1";
  assert.match(analyzeEvidence(controlOverlap).errors.join(" "), /isolated negative controls/);
  const malformed = evidenceResults(); malformed.treatmentRepositories[0] = null;
  assert.equal(analyzeEvidence(malformed).pass, false);
  assert.equal(analyzeEvidence(null).pass, false);
  const scope = evidenceResults(); scope.outOfScopeChanges = 1;
  assert.match(analyzeEvidence(scope).errors.join(" "), /frozen scope/);
  const short = evidenceResults(); short.treatmentRepositories[0].campaigns.pop();
  assert.match(analyzeEvidence(short).errors.join(" "), /ten campaigns/);
  const magnitudeWithoutVerification = evidenceResults();
  magnitudeWithoutVerification.treatmentRepositories[10].campaigns[0].verifiedWin = false;
  magnitudeWithoutVerification.treatmentRepositories[10].campaigns[0].magnitudeWin = true;
  assert.match(analyzeEvidence(magnitudeWithoutVerification).errors.join(" "), /magnitude win without a verified win/);
  const redTeam = evidenceResults(); redTeam.redTeam.successes = 1;
  assert.match(analyzeEvidence(redTeam).errors.join(" "), /red-team gate/);
});
