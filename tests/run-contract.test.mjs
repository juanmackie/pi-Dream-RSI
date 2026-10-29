/**
 * Run contract and durable all-phase accounting.
 *
 * The contract is the only place a run's objective, permissions and spend are
 * set. These tests cover refusal before any probe, the approval fingerprint,
 * environment restriction, scope checks, and the reserve-before-dispatch budget
 * that every phase shares.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ContractNotApprovedError, approvalIdentity, approveRunContract, contractFile, isProtectedAsset, normalizeRunContract,
  projectFingerprint, readStoredContract, restrictedEnvironment, validateRunContract,
} from "../extensions/pi-dream-rsi/engine/intake.ts";
import { constitutionProtectedAssets, pathWithin } from "../extensions/pi-dream-rsi/engine/scope.ts";
import {
  RSI_DAILY_CAPS, chargeImmediateProcessStart, readOrCreateLoopBudget, reconcileOpenReservation, recordCampaignTokenUsage, recordTokenUsage,
  remainingAllowance, remainingRsiTokens, reserveRsiRun, settleReservation, settleRsiRun, writeLoopBudget,
} from "../extensions/pi-dream-rsi/engine/budget.ts";
import { bootstrapWritePlan, runLoop } from "../extensions/pi-dream-rsi/engine/loop.ts";
import { resolveLoopProposal } from "../extensions/pi-dream-rsi/engine/proposal.ts";
import { readLoopSettingsFile } from "../extensions/pi-dream-rsi/engine/settings.ts";

function validContract(overrides = {}) {
  return {
    version: 1,
    ...overrides,
    outcome: {
      statement: "reduce the wall-clock duration of the declared benchmark command",
      unit: "ms",
      higherIsBetter: false,
      minimumUsefulGain: "10%",
      ...(overrides.outcome ?? {}),
    },
    preserved: { gates: [], ...(overrides.preserved ?? {}) },
    scope: { roots: ["src"], protectedAssets: [], ...(overrides.scope ?? {}) },
    execution: {
      consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"],
      ...(overrides.execution ?? {}),
    },
    budgets: {
      maxCampaigns: 2, maxAgentStarts: 20, maxEvaluatorRuns: 100, deadlineMs: 60_000, falseAcceptBudget: 0.01,
      ...(overrides.budgets ?? {}),
    },
  };
}

function tempProject(files = { "src/a.js": "export const a = 1;\n" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-contract-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

test("a contract is rejected for every fact the loop needs to stay inside its boundaries", () => {
  assert.deepEqual(validateRunContract(validContract()), []);
  const cases = [
    [{ version: 2 }, /version must be 1/],
    [{ outcome: { statement: "  " } }, /outcome\.statement/],
    [{ outcome: { higherIsBetter: "no" } }, /higherIsBetter must be explicitly true or false/],
    [{ outcome: { minimumUsefulGain: "10" } }, /minimumUsefulGain/],
    [{ outcome: { minimumUsefulGain: -5 } }, /minimumUsefulGain/],
    [{ outcome: { minimumUsefulGain: "100%" } }, /minimumUsefulGain/],
    [{ execution: { consent: undefined } }, /consent must be explicitly true or false/],
    [{ execution: { allowedCommandCategories: [] } }, /allowedCommandCategories must be a non-empty array/],
    [{ execution: { allowedCommandCategories: ["deploy"] } }, /unknown categories: deploy/],
    [{ scope: { roots: ["../escape"] } }, /scope\.roots/],
    [{ scope: { protectedAssets: ["/etc/passwd"] } }, /scope\.protectedAssets/],
    [{ budgets: { maxCampaigns: 0 } }, /maxCampaigns must be a positive integer/],
    [{ budgets: { falseAcceptBudget: 0.9 } }, /falseAcceptBudget/],
    [{ git: { autoCommit: true, branch: "main" } }, /cannot target a default branch/],
    [{ git: { autoCommit: true, branch: "bad branch" } }, /valid local Git branch/],
    [{ git: { autoCommit: true, branch: "dream-rsi/improve", commitPolicy: "later" } }, /commitPolicy/],
    [{ git: { autoCommit: false, branch: "dream-rsi/improve", commitPolicy: "squash-per-campaign" } }, /must match autoCommit/],
    [{ mode: "future" }, /mode must be "rsi"/],
    [{ mode: "rsi", budgets: { maxCampaigns: 7 } }, /cannot exceed the approved nightly limits/],
  ];
  for (const [patch, expected] of cases) {
    const errors = validateRunContract(validContract(patch));
    assert.ok(errors.length > 0, `expected a rejection for ${JSON.stringify(patch)}`);
    assert.match(errors.join("; "), expected);
    assert.throws(() => normalizeRunContract(validContract(patch)), expected);
  }
  assert.throws(() => normalizeRunContract(null), /must be an object/);
});
test("RSI fails closed when sandbox/provider-bounded worker controls are unavailable", async () => {
  const projectDir = tempProject();
  try {
    const contract = normalizeRunContract(validContract({
      mode: "rsi",
      budgets: { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs },
    }));
    let reconCalls = 0;
    let campaignCalls = 0;
    const result = await runLoop({
      projectDir, contract,
      limits: { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs },
      reconProjectImpl: async () => { reconCalls += 1; throw new Error("must not probe"); },
      runCampaignImpl: async () => { campaignCalls += 1; throw new Error("must not start a campaign"); },
    });
    assert.equal(result.stopCode, "blocked");
    assert.match(result.stopReason, /provider-bounded or host-isolated worker adapter/);
    assert.equal(result.preflight.status, "blocked");
    assert.ok(result.preflight.checks.some((check) => check.status === "blocked" && /host-isolated worker adapter/.test(check.reason)));
    assert.equal(result.agentStarts, 0);
    assert.equal(reconCalls, 0);
    assert.equal(campaignCalls, 0);
    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.equal(budget.rsi.active_run, null);
    assert.deepEqual([budget.rsi.campaigns, budget.rsi.tokens], [0, 0], "the blocked RSI start launches no campaign or token-using work");
    assert.ok(budget.rsi.wall_ms >= 0 && budget.rsi.wall_ms <= RSI_DAILY_CAPS.wallMs, "control-plane time stays within the daily reservation");
    assert.equal(budget.wall_ms, budget.rsi.wall_ms, "actual RSI wall usage is retained in lifetime totals");
    const status = JSON.parse(fs.readFileSync(path.join(path.dirname(result.budgetPath), "status.json"), "utf8"));
    assert.equal(status.budget.rsiDaily.active, false, "terminal status reflects the settled reservation");
    assert.equal(status.budget.rsiDaily.wallMs, budget.rsi.wall_ms);
    await assert.rejects(runLoop({
      projectDir, contract,
      limits: { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs },
      evaluatorBootstrap: { authorized: true, paths: [] },
    }), /refuses evaluator bootstrap/);
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("recovery under an existing RSI contract is persisted before a replacement proposal can be rejected", async () => {
  const projectDir = tempProject();
  const loopRoot = path.join(projectDir, ".dream-rsi", "loop");
  fs.mkdirSync(loopRoot, { recursive: true });
  try {
    const saved = normalizeRunContract(validContract({ mode: "rsi", budgets: {
      maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs,
    } }));
    const proposed = normalizeRunContract(validContract({
      ...saved, outcome: { ...saved.outcome, statement: "another objective requiring replacement approval" },
    }));
    fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...approveRunContract(projectDir, saved) })}\n`);
    const budgetPath = path.join(loopRoot, "budget.json");
    const start = Date.parse("2026-11-01T12:00:00.000Z");
    const budget = readOrCreateLoopBudget(budgetPath, saved.budgets, { rsiMode: true, nowMs: start });
    const reservation = reserveRsiRun(budget, start, 4 * 60 * 60 * 1000);
    writeLoopBudget(budgetPath, reservation.budget);
    const result = await runLoop({
      projectDir, contract: proposed,
      limits: { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs },
      now: () => new Date(start + 60_000),
    });
    assert.equal(result.stopCode, "blocked");
    const persisted = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
    assert.equal(persisted.rsi.active_run, null);
    assert.equal(persisted.rsi.wall_ms, 60_000, "the abandoned reservation is conservatively charged once");
    const status = JSON.parse(fs.readFileSync(path.join(loopRoot, "status.json"), "utf8"));
    const report = JSON.parse(fs.readFileSync(result.reportPath, "utf8"));
    assert.equal(status.budget.rsiDaily.active, false);
    assert.equal(status.budget.rsiDaily.wallMs, persisted.rsi.wall_ms);
    assert.equal(report.budget.rsiDaily.wallMs, persisted.rsi.wall_ms);
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("terminal RSI status and report reflect the atomic budget file after failed writes", async () => {
  for (const failure of ["reservation-and-settlement-before-write", "settlement-before-write", "settlement-after-write"]) {
    const projectDir = tempProject();
    try {
      const contract = normalizeRunContract(validContract({ mode: "rsi", budgets: {
        maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs,
      } }));
      let writes = 0;
      const result = await runLoop({
        projectDir, contract,
        limits: { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs },
        writeBudgetImpl: (file, budget) => {
          writes += 1;
          const shouldFail = failure === "reservation-and-settlement-before-write" ? writes === 2 || writes === 3
            : writes === 3;
          if (!shouldFail) return writeLoopBudget(file, budget);
          if (failure === "settlement-after-write" && writes === 3) writeLoopBudget(file, budget);
          throw new Error(`injected ${failure}`);
        },
      });
      const budget = JSON.parse(fs.readFileSync(path.join(projectDir, ".dream-rsi", "loop", "budget.json"), "utf8"));
      const status = JSON.parse(fs.readFileSync(path.join(projectDir, ".dream-rsi", "loop", "status.json"), "utf8"));
      const report = JSON.parse(fs.readFileSync(result.reportPath, "utf8"));
      const persistedActive = budget.rsi.active_run !== null;
      assert.equal(status.budget.rsiDaily.active, persistedActive, `${failure}: ${JSON.stringify({ statusBudget: status.budget, budget })}`);
      assert.equal(status.budget.rsiDaily.wallMs, budget.rsi.wall_ms, failure);
      assert.equal(report.budget.rsiDaily.wallMs, budget.rsi.wall_ms, failure);
      assert.equal(report.budget.rsiDaily.active, persistedActive, failure);
    } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
  }
});

test("a failed lease-directory startup does not attach a deadline timer or external abort listener", async () => {
  const projectDir = tempProject();
  try {
    fs.writeFileSync(path.join(projectDir, ".dream-rsi"), "not a directory");
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === "addEventListener") return (...args) => { added += 1; return target.addEventListener(...args); };
        if (property === "removeEventListener") return (...args) => { removed += 1; return target.removeEventListener(...args); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const contract = normalizeRunContract(validContract());
    await assert.rejects(runLoop({
      projectDir, contract, signal,
      limits: { maxCampaigns: 1, maxAgentStarts: 1, maxEvaluatorRuns: 1, deadlineMs: 100 },
    }), /ENOTDIR|not a directory/i);
    assert.equal(added, 0);
    assert.equal(removed, 0);
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("an exhausted RSI wall allowance reports budget-exhausted before repository work", async () => {
  const projectDir = tempProject();
  const loopRoot = path.join(projectDir, ".dream-rsi", "loop");
  fs.mkdirSync(loopRoot, { recursive: true });
  try {
    const contract = normalizeRunContract(validContract({ mode: "rsi", budgets: {
      maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs,
    } }));
    fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...approveRunContract(projectDir, contract) })}\n`);
    const budgetPath = path.join(loopRoot, "budget.json");
    const budget = readOrCreateLoopBudget(budgetPath, contract.budgets, { rsiMode: true });
    writeLoopBudget(budgetPath, { ...budget, wall_ms: RSI_DAILY_CAPS.wallMs, rsi: { ...budget.rsi, wall_ms: RSI_DAILY_CAPS.wallMs } });
    let reconCalls = 0;
    const result = await runLoop({
      projectDir, contract,
      limits: { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs },
      reconProjectImpl: async () => { reconCalls += 1; throw new Error("must not probe"); },
    });
    assert.equal(result.stopCode, "budget-exhausted");
    assert.equal(reconCalls, 0);
    assert.equal(result.agentStarts, 0);
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("RSI startup does not switch Git branches or run repository checkout hooks", async () => {
  const projectDir = tempProject();
  try {
    const git = (args) => execFileSync("git", args, { cwd: projectDir, stdio: "ignore", windowsHide: true });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Dream RSI Test"]);
    git(["config", "user.email", "dream-rsi-test@example.invalid"]);
    git(["add", "src"]);
    git(["commit", "-q", "-m", "baseline"]);
    const hook = path.join(projectDir, ".git", "hooks", "post-checkout");
    fs.writeFileSync(hook, "#!/bin/sh\nprintf ran > post-checkout.marker\n");
    fs.chmodSync(hook, 0o755);
    const contract = normalizeRunContract(validContract({
      mode: "rsi", git: { autoCommit: true, branch: "dream-rsi/improve" },
      budgets: { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs },
    }));
    const result = await runLoop({
      projectDir, contract,
      limits: { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs },
    });
    assert.equal(result.stopCode, "blocked");
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: projectDir, encoding: "utf8" }).trim(), "main");
    assert.equal(fs.existsSync(path.join(projectDir, "post-checkout.marker")), false, "RSI approval must not execute untrusted checkout hooks");
    assert.equal(JSON.parse(fs.readFileSync(path.join(projectDir, ".dream-rsi", "loop", "status.json"), "utf8")).branch, null);
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("a rejected legacy-to-RSI contract replacement does not persist an accounting migration", async () => {
  const projectDir = tempProject();
  const loopRoot = path.join(projectDir, ".dream-rsi", "loop");
  fs.mkdirSync(loopRoot, { recursive: true });
  try {
    const legacy = normalizeRunContract(validContract());
    const rsi = normalizeRunContract(validContract({ mode: "rsi", budgets: { maxCampaigns: 2, deadlineMs: RSI_DAILY_CAPS.wallMs } }));
    fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...approveRunContract(projectDir, legacy) })}\n`);
    readOrCreateLoopBudget(path.join(loopRoot, "budget.json"), legacy.budgets);
    const contractBefore = fs.readFileSync(contractFile(loopRoot), "utf8");
    const budgetPath = path.join(loopRoot, "budget.json");
    const budgetBefore = fs.readFileSync(budgetPath, "utf8");
    const result = await runLoop({
      projectDir, contract: rsi,
      limits: { maxCampaigns: 2, maxAgentStarts: 20, maxEvaluatorRuns: 100, deadlineMs: RSI_DAILY_CAPS.wallMs },
    });
    assert.equal(result.stopCode, "blocked");
    assert.equal(fs.readFileSync(contractFile(loopRoot), "utf8"), contractBefore, "the saved legacy contract remains authoritative");
    assert.equal(fs.readFileSync(budgetPath, "utf8"), budgetBefore, "unapproved migration leaves legacy counters byte-identical");
    assert.equal(JSON.parse(budgetBefore).rsi, undefined);
    const report = JSON.parse(fs.readFileSync(result.reportPath, "utf8"));
    assert.equal(report.budget.rsiDaily, undefined, "the report does not advertise an unpersisted RSI migration");
    const status = JSON.parse(fs.readFileSync(path.join(loopRoot, "status.json"), "utf8"));
    assert.equal(status.budget.rsiDaily, undefined, "the status snapshot matches durable accounting");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("new Git-backed proposals default to verified auto-commit while legacy contracts keep their policy", () => {
  const projectDir = tempProject();
  try {
    const withoutGit = resolveLoopProposal({}, projectDir);
    assert.deepEqual(withoutGit.contract.git, { autoCommit: false, branch: "dream-rsi/improve" });
    fs.mkdirSync(path.join(projectDir, ".git"));
    const withGit = resolveLoopProposal({}, projectDir);
    assert.deepEqual(withGit.contract.git, { autoCommit: true, branch: "dream-rsi/improve" });
    const legacy = normalizeRunContract(validContract());
    const resumed = resolveLoopProposal({}, projectDir, legacy);
    assert.equal(resumed.contract.git, undefined, "legacy contracts remain working-tree-only without adding a new Git policy");
    const disabled = resolveLoopProposal({ auto_commit: false }, projectDir);
    assert.equal(disabled.contract.git?.autoCommit, false);
    const perChange = resolveLoopProposal({ commit_policy: "commit-per-accepted-change" }, projectDir);
    assert.deepEqual(perChange.contract.git, { autoCommit: true, branch: "dream-rsi/improve", commitPolicy: "commit-per-accepted-change" });
    const squash = resolveLoopProposal({ commit_policy: "squash-per-campaign" }, projectDir);
    assert.deepEqual(squash.contract.git, { autoCommit: true, branch: "dream-rsi/improve", commitPolicy: "squash-per-campaign" });
    assert.equal(resolveLoopProposal({}, projectDir, squash.contract).contract.git?.commitPolicy, "squash-per-campaign",
      "the saved policy is inherited on resume/reuse");
    const rsi = resolveLoopProposal({ rsi_mode: true }, projectDir);
    assert.equal(rsi.contract.mode, "rsi");
    assert.equal(rsi.contract.budgets.maxCampaigns, 6);
    assert.equal(rsi.contract.budgets.deadlineMs, RSI_DAILY_CAPS.wallMs);
    assert.throws(() => resolveLoopProposal({ rsi_mode: true, max_campaigns: 7 }, projectDir), /max_campaigns/);
    assert.throws(() => resolveLoopProposal({ rsi_mode: false }, projectDir, rsi.contract), /cannot be disabled/);
    assert.throws(() => resolveLoopProposal({ rsi_mode: true, evaluator_bootstrap: { authorized: true, paths: ["src/harness.mjs"] } }, projectDir), /cannot run evaluator bootstrap/);
    const noCommit = resolveLoopProposal({ commit_policy: "no-commit" }, projectDir);
    assert.deepEqual(noCommit.contract.git, { autoCommit: false, branch: "dream-rsi/improve", commitPolicy: "no-commit" });
    assert.throws(() => resolveLoopProposal({ auto_commit: true, commit_policy: "no-commit" }, projectDir), /conflict/);
    const continuous = resolveLoopProposal({ continuous: true }, projectDir);
    assert.deepEqual(continuous.contract.continuation, { plateauCampaigns: 3, minimumCampaignIntervalMs: 60_000, agentStartsPerHour: 36, evaluatorRunsPerHour: 96 });
    const customRates = resolveLoopProposal({ continuous: true, agent_starts_per_hour: 12, evaluator_runs_per_hour: 48 }, projectDir);
    assert.equal(customRates.contract.continuation?.agentStartsPerHour, 12);
    assert.equal(customRates.contract.continuation?.evaluatorRunsPerHour, 48);
    assert.throws(() => resolveLoopProposal({ continuous: true, agent_starts_per_hour: 0 }, projectDir), /agent_starts_per_hour/);
    assert.throws(() => resolveLoopProposal({ continuous: true, evaluator_runs_per_hour: 10001 }, projectDir), /evaluator_runs_per_hour/);
    const resumedContinuous = resolveLoopProposal({}, projectDir, continuous.contract);
    assert.deepEqual(resumedContinuous.contract.continuation, continuous.contract.continuation, "saved continuous policy is inherited on reuse");
    const legacyContinuous = normalizeRunContract({ ...validContract(), continuation: { plateauCampaigns: 3, minimumCampaignIntervalMs: 60_000 } });
    assert.deepEqual(legacyContinuous.continuation, { plateauCampaigns: 3, minimumCampaignIntervalMs: 60_000 }, "legacy continuous contracts retain their saved shape and use runtime rate defaults");
    assert.equal(resolveLoopProposal({ continuous: false }, projectDir, continuous.contract).contract.continuation, undefined,
      "disabling continuous mode is explicit");
    assert.throws(() => resolveLoopProposal({ continuous: true, plateau_campaigns: 65 }, projectDir), /plateau_campaigns/);
    fs.rmSync(path.join(projectDir, ".git"), { recursive: true, force: true });
    assert.throws(() => resolveLoopProposal({ auto_commit: true }, projectDir), /existing Git working tree/);
    fs.mkdirSync(path.join(projectDir, ".git"));
    assert.throws(() => resolveLoopProposal({ auto_commit: true, focus: "measure quality", unit: "percent", higher_is_better: true,
      scope_roots: ["src"], evaluator_bootstrap: { authorized: true, paths: ["src/measure.mjs"] } }, projectDir), /cannot be combined with evaluator bootstrap/);
    const bootstrapped = resolveLoopProposal({ auto_commit: false, focus: "measure quality", unit: "percent", higher_is_better: true,
      scope_roots: ["src"], evaluator_bootstrap: { authorized: true, paths: ["src/measure.mjs"] } }, projectDir);
    assert.equal(bootstrapped.contract.git?.autoCommit, false);
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("commit policies survive settings-envelope import and invalid combinations fail closed", () => {
  const dir = tempProject();
  try {
    const file = path.join(dir, "settings.json");
    const contract = normalizeRunContract(validContract({ git: { autoCommit: true, branch: "dream-rsi/improve", commitPolicy: "squash-per-campaign" } }));
    fs.writeFileSync(file, JSON.stringify({ version: 1, contract }));
    const allowed = ["focus", "unit", "higher_is_better", "minimum_gain", "scope_roots", "protected_assets", "gates",
      "max_campaigns", "max_agent_starts", "max_evaluator_runs", "false_accept_budget", "deadline_minutes", "auto_commit", "commit_branch", "commit_policy", "rsi_mode", "env_allowlist", "command_categories"];
    const settings = readLoopSettingsFile(file, dir, allowed);
    assert.equal(settings.commit_policy, "squash-per-campaign");
    assert.equal(settings.auto_commit, true);
    const rsiContract = normalizeRunContract(validContract({ mode: "rsi" }));
    fs.writeFileSync(file, JSON.stringify({ version: 1, contract: rsiContract }));
    assert.equal(readLoopSettingsFile(file, dir, allowed).rsi_mode, true, "the explicit mode survives settings-envelope round-trip");
    const invalid = { ...contract, git: { autoCommit: false, branch: "dream-rsi/improve", commitPolicy: "squash-per-campaign" } };
    fs.writeFileSync(file, JSON.stringify({ version: 1, contract: invalid }));
    assert.throws(() => readLoopSettingsFile(file, dir, allowed), /must match autoCommit/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a saved contract can be proposed with a higher total campaign cap", () => {
  const projectDir = tempProject();
  try {
    const prior = normalizeRunContract(validContract({ budgets: { maxCampaigns: 20, maxAgentStarts: 72, maxEvaluatorRuns: 20, deadlineMs: 120 * 60_000, falseAcceptBudget: 0.1 } }));
    const proposal = resolveLoopProposal({ max_evaluator_runs: 34 }, projectDir, prior);
    assert.equal(proposal.contract.budgets.maxEvaluatorRuns, 34);
    assert.equal(proposal.contract.budgets.maxAgentStarts, prior.budgets.maxAgentStarts);
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("normalized contracts drop unused execution mode and model provider fields", () => {
  const contract = normalizeRunContract(validContract({
    execution: { mode: "sandbox", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    models: { providers: [] },
  }));
  assert.deepEqual(contract.execution, { consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] });
  assert.equal(Object.hasOwn(contract, "models"), false);
});

test("approval refuses trusted-local execution without consent and names the exact reason", () => {
  const projectDir = tempProject();
  const contract = normalizeRunContract(validContract({ execution: { consent: false } }));
  assert.throws(
    () => approveRunContract(projectDir, contract),
    (error) => error instanceof ContractNotApprovedError
      && error.reason === "trusted-local execution was not approved for this repository; discovered commands run on this host with host access, so the operator must approve that risk once before any probe runs",
  );
  assert.throws(() => approveRunContract(path.join(projectDir, "missing"), normalizeRunContract(validContract())), ContractNotApprovedError);
});

test("the approval fingerprint is stable for unchanged content and ignores dependency directories", () => {
  const projectDir = tempProject({ "src/a.js": "export const a = 1;\n", "README.md": "# project\n" });
  const contract = normalizeRunContract(validContract());
  const first = approveRunContract(projectDir, contract);
  const second = approveRunContract(projectDir, contract);
  assert.equal(first.fingerprint, second.fingerprint, "re-approving unchanged content gives the same baseline");

  fs.mkdirSync(path.join(projectDir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "node_modules", "dep", "index.js"), "install noise\n");
  fs.mkdirSync(path.join(projectDir, ".dream-rsi", "loop"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".dream-rsi", "loop", "budget.json"), "{}\n");
  assert.equal(projectFingerprint(projectDir), first.fingerprint, "a dependency install or loop state is not a baseline change");

  fs.writeFileSync(path.join(projectDir, "src", "a.js"), "export const a = 2;\n");
  assert.notEqual(projectFingerprint(projectDir), first.fingerprint, "a source edit does change the baseline");
});

test("a probe environment carries the runtime baseline plus the allowlist, and never a secret", () => {
  const contract = normalizeRunContract(validContract({ execution: { envAllowlist: ["CI"] } }));
  const source = {
    PATH: "/bin", CI: "1", HOME: "/home/u",
    OPENAI_API_KEY: "sk-secret", AWS_SECRET_ACCESS_KEY: "x", GITHUB_TOKEN: "ghp_secret", PI_SESSION_ID: "s",
  };
  const env = restrictedEnvironment(contract, source);
  assert.equal(env.PATH, "/bin", "process execution needs PATH or nothing can start");
  assert.equal(env.CI, "1", "the allowlist is added on top");
  for (const secret of ["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "PI_SESSION_ID"]) {
    assert.equal(Object.hasOwn(env, secret), false, `${secret} must never reach a probe`);
  }
  // An empty allowlist still yields a runnable environment, and still no secrets.
  const bare = restrictedEnvironment(normalizeRunContract(validContract()), source);
  assert.equal(bare.PATH, "/bin");
  assert.equal(Object.hasOwn(bare, "GITHUB_TOKEN"), false);
});

test("scope and protected-asset checks are exact about paths", () => {
  const contract = normalizeRunContract(validContract({ scope: { roots: ["src", "tools"], protectedAssets: ["test", "src/vendor"] } }));
  assert.equal(pathWithin("src/a.js", contract.scope.roots), true);
  assert.equal(pathWithin("tools/b.js", contract.scope.roots), true);
  assert.equal(pathWithin("docs/c.md", contract.scope.roots), false);
  assert.equal(pathWithin("srcfoo/a.js", contract.scope.roots), false);
  assert.equal(pathWithin("src/a.js", ["."]), true, "dot denotes the project root");
  assert.equal(pathWithin("src/a.js", ["./"]), true, "dot-slash denotes the project root");
  assert.equal(isProtectedAsset(contract, "test/x.mjs"), true);
  assert.equal(isProtectedAsset(contract, "src/vendor/lib.js"), true);
  assert.equal(isProtectedAsset(contract, "src/other.js"), false);

  const open = normalizeRunContract(validContract({ scope: { roots: [] } }));
  assert.equal(pathWithin("anything/at/all.js", open.scope.roots), true, "no declared roots means the whole workspace is editable");
});

test("self-host contracts protect immutable verifier and patch-application files", () => {
  const projectDir = tempProject({
    "package.json": JSON.stringify({ name: "pi-dream-rsi" }),
    "extensions/pi-dream-rsi/engine/verify.ts": "export {};\n",
    "extensions/pi-dream-rsi/engine/campaign-patch.ts": "export {};\n",
  });
  const protectedFiles = ["extensions/pi-dream-rsi/engine/verify.ts", "extensions/pi-dream-rsi/engine/campaign-patch.ts", "docs/constitution.md"];
  try {
    assert.deepEqual(constitutionProtectedAssets(projectDir), protectedFiles);
    const direct = normalizeRunContract(validContract({ scope: { roots: ["."] } }));
    const approved = approveRunContract(projectDir, direct);
    assert.notEqual(approvalIdentity(approved.contract), approvalIdentity(direct), "adding immutable scope requires the explicit contract-replacement path");
    const proposal = resolveLoopProposal({}, projectDir, direct);
    for (const file of protectedFiles) {
      assert.ok(approved.contract.scope.protectedAssets.includes(file), `${file} is enforced for direct contracts`);
      assert.ok(proposal.contract.scope.protectedAssets.includes(file), `${file} appears in reviewed proposals`);
      assert.ok(bootstrapWritePlan(approved.contract, [file]).checks.some((check) => check.status === "blocked"), `${file} cannot be created by bootstrap`);
    }
    const ordinary = tempProject({ "package.json": JSON.stringify({ name: "unrelated-project" }) });
    try { assert.deepEqual(constitutionProtectedAssets(ordinary), [], "the self-host rule does not constrain unrelated repositories"); }
    finally { fs.rmSync(ordinary, { recursive: true, force: true }); }
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("a stored contract round-trips and a corrupt file fails closed", () => {
  const projectDir = tempProject();
  const loopRoot = path.join(projectDir, ".dream-rsi", "loop");
  const approved = approveRunContract(projectDir, normalizeRunContract(validContract()));
  fs.mkdirSync(loopRoot, { recursive: true });
  fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...approved, contract: approved.contract }, null, 2)}\n`);
  const stored = readStoredContract(loopRoot);
  assert.equal(stored.fingerprint, approved.fingerprint);
  assert.equal(stored.contract.outcome.minimumUsefulGain, "10%");
  assert.deepEqual(stored.contract.execution.allowedCommandCategories, ["test", "benchmark"]);

  fs.writeFileSync(contractFile(loopRoot), "{ not json");
  assert.throws(() => readStoredContract(loopRoot), /unreadable/);
  fs.writeFileSync(contractFile(loopRoot), JSON.stringify({ version: 1, fingerprint: "x", approvedAt: "y", contract: { version: 1 } }));
  assert.throws(() => readStoredContract(loopRoot), /invalid/);
  assert.equal(readStoredContract(path.join(projectDir, "absent")), null);
});

const BUDGET_LIMITS = { maxCampaigns: 3, maxAgentStarts: 30, maxEvaluatorRuns: 20, deadlineMs: 60_000 };

test("RSI UTC-day accounting renews only daily counters and preserves lifetime totals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-nightly-budget-"));
  const file = path.join(dir, "budget.json");
  try {
    const firstDay = Date.parse("2026-11-01T12:00:00.000Z");
    let budget = readOrCreateLoopBudget(file, {
      maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs,
    }, { rsiMode: true, rsiWindowId: "2026-11-01", nowMs: firstDay });
    const reservation = { phase: "campaign", agent_starts: 4, evaluator_runs: 3, campaigns: 1, at: new Date(firstDay).toISOString() };
    budget = { ...budget, open_campaign: reservation };
    budget = settleReservation(budget, reservation, { agentStarts: 4, evaluatorRuns: 3, campaigns: 1 });
    budget = recordTokenUsage(budget, 1_200);
    budget = recordCampaignTokenUsage(budget, "campaign-1", 300);
    budget = recordCampaignTokenUsage(budget, "campaign-1", 450);
    assert.deepEqual(remainingAllowance(budget), { campaigns: 5, agentStarts: 68, evaluatorRuns: 197 });
    assert.equal(budget.campaigns, 1, "top-level campaign total is lifetime, not renewed");
    assert.equal(budget.tokens_used, 1_650, "campaign resume receipts add only the newly observed token delta");
    assert.equal(budget.rsi.tokens, 1_650);
    assert.equal(remainingRsiTokens(budget), RSI_DAILY_CAPS.tokens - 1_650);
    const maxedTokens = recordTokenUsage(budget, remainingRsiTokens(budget));
    assert.equal(remainingRsiTokens(maxedTokens), 0, "the daily token cap has an exact exhausted boundary");
    const observedOverrun = recordTokenUsage(maxedTokens, 1);
    assert.equal(remainingRsiTokens(observedOverrun), -1, "reported usage is never clamped or hidden; dispatch guards must stop before another call");
    const exhaustedWall = { ...budget, rsi: { ...budget.rsi, wall_ms: RSI_DAILY_CAPS.wallMs } };
    assert.throws(() => reserveRsiRun(exhaustedWall, firstDay, 1_000), /daily wall-clock budget is exhausted/);

    const started = reserveRsiRun(budget, firstDay, RSI_DAILY_CAPS.wallMs);
    budget = started.budget;
    assert.equal(started.allowanceMs, RSI_DAILY_CAPS.wallMs);
    assert.throws(() => reserveRsiRun(started.budget, firstDay, 1_000), /already active/);
    const actualOverrun = settleRsiRun(started.budget, firstDay + RSI_DAILY_CAPS.wallMs + 1_234);
    assert.equal(actualOverrun.wall_ms, RSI_DAILY_CAPS.wallMs + 1_234, "clean settlement records actual lifetime elapsed time, not only its grant");
    budget = settleRsiRun(budget, firstDay + 30 * 60_000);
    assert.equal(budget.wall_ms, 30 * 60_000);
    assert.equal(budget.rsi.wall_ms, 30 * 60_000);
    writeLoopBudget(file, budget);

    const nextDay = Date.parse("2026-11-02T00:10:00.000Z");
    const renewed = readOrCreateLoopBudget(file, {
      maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs,
    }, { rsiMode: true, rsiWindowId: "2026-11-02", nowMs: nextDay });
    assert.deepEqual([renewed.rsi.campaigns, renewed.rsi.agent_starts, renewed.rsi.evaluator_runs, renewed.rsi.tokens, renewed.rsi.wall_ms], [0, 0, 0, 0, 0]);
    assert.deepEqual([renewed.campaigns, renewed.agent_starts, renewed.evaluator_runs, renewed.tokens_used, renewed.wall_ms], [1, 4, 3, 1_650, 30 * 60_000]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("legacy RSI migration reserves the first-day wall budget and flags unknown lifetime history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-legacy-migration-"));
  const file = path.join(dir, "budget.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, max_campaigns: 6, max_agent_starts: 72, max_evaluator_runs: 200,
      campaigns: 1, agent_starts: 2, evaluator_runs: 1, open_campaign: null }));
    const firstDay = Date.parse("2026-11-01T12:00:00.000Z");
    const migrated = readOrCreateLoopBudget(file, {
      maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs,
    }, { rsiMode: true, rsiWindowId: "2026-11-01", nowMs: firstDay });
    assert.deepEqual([migrated.rsi.campaigns, migrated.rsi.agent_starts, migrated.rsi.wall_ms], [1, 2, RSI_DAILY_CAPS.wallMs]);
    assert.equal(migrated.rsi.tokens_unattributed, true);
    assert.equal(migrated.rsi.wall_unattributed, true);
    assert.deepEqual([migrated.tokens_used, migrated.wall_ms], [0, 0], "migration does not invent lifetime usage where no history exists");
    const nextDay = readOrCreateLoopBudget(file, {
      maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs,
    }, { rsiMode: true, rsiWindowId: "2026-11-02", nowMs: firstDay + 12 * 60 * 60_000 });
    assert.deepEqual([nextDay.rsi.campaigns, nextDay.rsi.agent_starts, nextDay.rsi.wall_ms], [0, 0, 0]);
    assert.equal(nextDay.rsi.tokens_unattributed, true);
    assert.equal(nextDay.rsi.wall_unattributed, true, "daily renewal preserves lifetime-history warnings");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("RSI cap-extension recovery compares current daily spend, not unbounded lifetime totals", async () => {
  const projectDir = tempProject();
  const loopRoot = path.join(projectDir, ".dream-rsi", "loop");
  fs.mkdirSync(loopRoot, { recursive: true });
  try {
    const previousContract = normalizeRunContract(validContract({ mode: "rsi", budgets: {
      maxCampaigns: 6, maxAgentStarts: 10, maxEvaluatorRuns: 20, deadlineMs: RSI_DAILY_CAPS.wallMs,
    } }));
    const nextContract = normalizeRunContract({ ...previousContract, budgets: { ...previousContract.budgets, maxAgentStarts: 20 } });
    const previous = approveRunContract(projectDir, previousContract);
    const next = approveRunContract(projectDir, nextContract);
    fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...previous })}\n`);
    const budgetPath = path.join(loopRoot, "budget.json");
    let budget = readOrCreateLoopBudget(budgetPath, {
      maxCampaigns: 6, maxAgentStarts: 10, maxEvaluatorRuns: 20, deadlineMs: RSI_DAILY_CAPS.wallMs,
    }, { rsiMode: true });
    budget = { ...budget, campaigns: 7, agent_starts: 50, evaluator_runs: 100,
      rsi: { ...budget.rsi, campaigns: 1, agent_starts: 2, evaluator_runs: 3 } };
    writeLoopBudget(budgetPath, budget);
    fs.writeFileSync(path.join(loopRoot, "budget-extension.json"), JSON.stringify({ version: 1, previous, next,
      previousCaps: { maxCampaigns: 6, maxAgentStarts: 10, maxEvaluatorRuns: 20 },
      nextCaps: { maxCampaigns: 6, maxAgentStarts: 20, maxEvaluatorRuns: 20 } }));
    const result = await runLoop({
      projectDir, contract: nextContract,
      limits: { maxCampaigns: 6, maxAgentStarts: 20, maxEvaluatorRuns: 20, deadlineMs: RSI_DAILY_CAPS.wallMs },
    });
    assert.equal(result.stopCode, "blocked", "recovery completes then stops at the documented RSI worker gate");
    assert.equal(fs.existsSync(path.join(loopRoot, "budget-extension.json")), false);
    const savedBudget = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
    assert.deepEqual([savedBudget.campaigns, savedBudget.agent_starts, savedBudget.evaluator_runs], [7, 50, 100]);
    assert.deepEqual([savedBudget.rsi.campaigns, savedBudget.rsi.agent_starts, savedBudget.rsi.evaluator_runs], [1, 2, 3]);
    assert.equal(savedBudget.max_agent_starts, 20);
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("RSI budget recovery charges an interrupted run and rejects malformed daily state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-nightly-recovery-"));
  const file = path.join(dir, "budget.json");
  try {
    const startedAt = Date.parse("2026-11-01T23:30:00.000Z");
    let budget = readOrCreateLoopBudget(file, {
      maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs,
    }, { rsiMode: true, rsiWindowId: "2026-11-01", nowMs: startedAt });
    budget = reserveRsiRun(budget, startedAt, RSI_DAILY_CAPS.wallMs).budget;
    assert.throws(() => reserveRsiRun(budget, startedAt, 1_000), /already active/);
    writeLoopBudget(file, budget);
    const recovered = readOrCreateLoopBudget(file, {
      maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs,
    }, { rsiMode: true, rsiWindowId: "2026-11-02", nowMs: Date.parse("2026-11-02T00:10:00.000Z") });
    assert.equal(recovered.wall_ms, 30 * 60_000, "crash recovery charges up to the reserved pre-midnight wall allowance");
    assert.equal(recovered.rsi.window_id, "2026-11-02");
    assert.equal(recovered.rsi.wall_ms, 0, "new UTC window starts with a fresh daily counter");
    assert.throws(() => readOrCreateLoopBudget(file, {
      maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs,
    }, { rsiMode: true, rsiWindowId: "2026-11-01", nowMs: Date.parse("2026-11-01T23:59:00.000Z") }), /clock moved backward/);
    writeLoopBudget(file, { ...recovered, rsi: { ...recovered.rsi, tokens: -1 } });
    assert.throws(() => readOrCreateLoopBudget(file, {
      maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: RSI_DAILY_CAPS.wallMs,
    }, { rsiMode: true, rsiWindowId: "2026-11-02", nowMs: Date.parse("2026-11-02T00:11:00.000Z") }), /RSI budget.*expected schema/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an immediate process charge preserves an open campaign reservation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-open-charge-"));
  try {
    const budget = readOrCreateLoopBudget(path.join(dir, "budget.json"), BUDGET_LIMITS);
    const reservation = { phase: "campaign", agent_starts: 3, evaluator_runs: 8, campaigns: 1, at: new Date().toISOString() };
    const started = chargeImmediateProcessStart({ ...budget, open_campaign: reservation }, "campaign", "agent");
    assert.deepEqual(started.open_campaign, reservation, "a dispatch-time charge cannot erase the crash-recovery reservation");
    assert.equal(started.agent_starts, budget.agent_starts + 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an approved budget extension preserves spend and refuses a limit below recorded use", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-budget-"));
  const file = path.join(dir, "budget.json");
  let budget = readOrCreateLoopBudget(file, BUDGET_LIMITS);
  assert.deepEqual(remainingAllowance(budget), { campaigns: 3, agentStarts: 30, evaluatorRuns: 20 });

  // A discovery probe is not billed as a campaign.
  const probe = { phase: "discovery", agent_starts: 1, evaluator_runs: 9, campaigns: 0, at: new Date().toISOString() };
  budget = { ...budget, open_campaign: probe };
  writeLoopBudget(file, budget);
  budget = settleReservation(readOrCreateLoopBudget(file, BUDGET_LIMITS), probe, { agentStarts: 1, evaluatorRuns: 9 });
  writeLoopBudget(file, budget);
  assert.equal(budget.campaigns, 0, "a probe does not consume a campaign");
  assert.equal(budget.agent_starts, 1);
  assert.deepEqual(budget.phases.discovery, { agent_starts: 1, evaluator_runs: 9, campaigns: 0 });

  const extended = readOrCreateLoopBudget(file, { ...BUDGET_LIMITS, maxCampaigns: 34, maxAgentStarts: 90, maxEvaluatorRuns: 34 }, { allowIncrease: true });
  assert.deepEqual([extended.max_campaigns, extended.max_agent_starts, extended.max_evaluator_runs], [34, 90, 34]);
  assert.deepEqual([extended.campaigns, extended.agent_starts, extended.evaluator_runs], [0, 1, 9]);
  assert.throws(() => readOrCreateLoopBudget(file, { ...BUDGET_LIMITS, maxEvaluatorRuns: 1 }, { allowIncrease: true }), /may only be increased|below accumulated spend/);
  assert.throws(() => readOrCreateLoopBudget(file, { ...BUDGET_LIMITS, maxCampaigns: 2 }, { allowIncrease: true }), /may only be increased/);
});

test("an interrupted campaign reconciliation charges observed starts instead of its full grant", () => {
  const open = { version: 1, max_campaigns: 2, max_agent_starts: 20, max_evaluator_runs: 100,
    campaigns: 0, agent_starts: 0, evaluator_runs: 0, open_campaign: {
    phase: "campaign", agent_starts: 8, evaluator_runs: 40, campaigns: 1, campaign_id: "saved-campaign",
    campaign_agent_starts_before: 0, campaign_evaluator_runs_before: 0, at: new Date().toISOString(),
  } };
  const recovered = reconcileOpenReservation(open, { agentStarts: 3, evaluatorRuns: 11, campaigns: 1 });
  assert.equal(recovered.budget.agent_starts, 3);
  assert.equal(recovered.budget.evaluator_runs, 11);
  assert.equal(recovered.budget.campaigns, 1);
  assert.equal(recovered.budget.open_campaign, null);
});

test("a legacy reservation without a phase is still charged one campaign", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-budget-legacy-"));
  const file = path.join(dir, "budget.json");
  const created = readOrCreateLoopBudget(file, BUDGET_LIMITS);
  fs.writeFileSync(file, JSON.stringify({ ...created, open_campaign: { agent_starts: 7, evaluator_runs: 11, at: new Date().toISOString() } }));
  const recovered = reconcileOpenReservation(readOrCreateLoopBudget(file, BUDGET_LIMITS));
  assert.equal(recovered.charged.phase, "campaign");
  assert.equal(recovered.charged.campaigns, 1);
  assert.equal(recovered.budget.campaigns, 1);
  assert.equal(recovered.budget.agent_starts, 7);
  assert.equal(recovered.budget.evaluator_runs, 11);
  assert.equal(recovered.budget.open_campaign, null);
  assert.equal(reconcileOpenReservation(recovered.budget), null, "a settled budget has nothing to reconcile");
});

test("corrupt or tampered budget state fails closed instead of granting allowance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-budget-bad-"));
  const file = path.join(dir, "budget.json");
  const created = readOrCreateLoopBudget(file, BUDGET_LIMITS);
  const tampered = [
    [{ agent_starts: -5 }, /expected schema/],
    [{ evaluator_runs: 1.5 }, /expected schema/],
    [{ campaigns: null }, /expected schema/],
    [{ version: 2 }, /expected schema/],
    [{ phases: { unknown: { agent_starts: 0, evaluator_runs: 0, campaigns: 0 } } }, /unknown phase/],
    [{ phases: { discovery: { agent_starts: -1, evaluator_runs: 0, campaigns: 0 } } }, /expected schema/],
    [{ open_campaign: { agent_starts: 1, evaluator_runs: 1, at: "not a date" } }, /unreadable open-campaign reservation/],
  ];
  for (const [patch, expected] of tampered) {
    fs.writeFileSync(file, JSON.stringify({ ...created, ...patch }));
    assert.throws(() => readOrCreateLoopBudget(file, BUDGET_LIMITS), expected);
  }
  fs.writeFileSync(file, "not json");
  assert.throws(() => readOrCreateLoopBudget(file, BUDGET_LIMITS), /unreadable/);
});

// ---------------------------------------------------------------------------
// Contract behaviour through the loop's public entry point
// ---------------------------------------------------------------------------

test("the loop refuses an unapproved contract before any discovery, and leaves the budget untouched", async () => {
  const projectDir = tempProject({ "src/a.js": "export const a = 1;\n", "package.json": "{}\n" });
  const refused = normalizeRunContract(validContract({ execution: { consent: false } }));
  const result = await runLoop({
    projectDir,
    contract: refused,
    limits: { maxCampaigns: 2, maxAgentStarts: 8, maxEvaluatorRuns: 16, deadlineMs: 30_000 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });

  assert.equal(result.stopReason, "not-approved");
  assert.equal(result.contract, null);
  assert.equal(result.campaigns, 0);
  assert.equal(fs.existsSync(path.join(projectDir, ".dream-rsi", "loop", "contract.json")), false, "a refused contract is not stored");
  const budget = JSON.parse(fs.readFileSync(path.join(projectDir, ".dream-rsi", "loop", "budget.json"), "utf8"));
  assert.deepEqual(
    { campaigns: budget.campaigns, agents: budget.agent_starts, evaluators: budget.evaluator_runs },
    { campaigns: 0, agents: 0, evaluators: 0 },
    "nothing was spent",
  );
  assert.ok(result.memory.notes.some((note) => note.startsWith("not-approved:")), "the refusal is recorded with its reason");
});

test("a second, different objective is refused rather than silently replacing the stored contract", async () => {
  const projectDir = tempProject({ "src/a.js": "export const a = 1;\n", "package.json": "{}\n" });
  const loopRoot = path.join(projectDir, ".dream-rsi", "loop");
  const first = approveRunContract(projectDir, normalizeRunContract(validContract()));
  fs.mkdirSync(loopRoot, { recursive: true });
  fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...first, contract: first.contract }, null, 2)}\n`);

  const other = normalizeRunContract(validContract({ outcome: { statement: "reduce peak memory of the benchmark" } }));
  const result = await runLoop({
    projectDir,
    contract: other,
    limits: { maxCampaigns: 2, maxAgentStarts: 8, maxEvaluatorRuns: 16, deadlineMs: 30_000 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });

  assert.equal(result.stopCode, "blocked");
  assert.equal(result.contract, null, "a refused contract is never reported as recorded");
  assert.match(result.stopReason, /a different run contract is already stored/i);
  assert.match(result.memory.notes.at(-1), /a different run contract is already stored/i);
  const stored = readStoredContract(loopRoot);
  assert.equal(stored.contract.outcome.statement, "reduce the wall-clock duration of the declared benchmark command", "the approved objective is not overwritten");
});

test("an interrupted discovery phase is reconciled as discovery spend, not as a campaign", async () => {
  const projectDir = tempProject({ "src/a.js": "export const a = 1;\n", "package.json": "{}\n" });
  const loopRoot = path.join(projectDir, ".dream-rsi", "loop");
  const budgetPath = path.join(loopRoot, "budget.json");
  fs.mkdirSync(loopRoot, { recursive: true });
  const limits = { maxCampaigns: 2, maxAgentStarts: 8, maxEvaluatorRuns: 16, deadlineMs: 30_000 };
  const created = readOrCreateLoopBudget(budgetPath, limits);
  fs.writeFileSync(budgetPath, JSON.stringify({
    ...created,
    open_campaign: { phase: "discovery", agent_starts: 1, evaluator_runs: 3, campaigns: 0, at: "2026-10-20T00:00:00.000Z" },
  }));

  const result = await runLoop({
    projectDir,
    contract: normalizeRunContract(validContract({ budgets: { maxCampaigns: limits.maxCampaigns, maxAgentStarts: limits.maxAgentStarts, maxEvaluatorRuns: limits.maxEvaluatorRuns } })),
    limits,
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });

  const budget = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
  assert.equal(budget.campaigns, 0, "a dead probe does not consume a campaign allowance");
  assert.equal(budget.agent_starts, 1);
  assert.equal(budget.evaluator_runs, 3);
  assert.deepEqual(budget.phases.discovery, { agent_starts: 1, evaluator_runs: 3, campaigns: 0 });
  assert.equal(budget.open_campaign, null, "the reservation is settled once, not left open");
  assert.ok(result.memory.notes.some((note) => note.includes("interrupted discovery phase")));
});

test("resuming under a contract keeps the durable budget and does not renew it", async () => {
  const projectDir = tempProject({ "src/a.js": "export const a = 1;\n", "package.json": "{}\n" });
  const limits = { maxCampaigns: 1, maxAgentStarts: 2, maxEvaluatorRuns: 2, deadlineMs: 30_000 };
  const contract = normalizeRunContract(validContract({ budgets: { maxCampaigns: 1, maxAgentStarts: 2, maxEvaluatorRuns: 2 } }));
  const budgetPath = path.join(projectDir, ".dream-rsi", "loop", "budget.json");
  fs.mkdirSync(path.dirname(budgetPath), { recursive: true });
  const exhausted = readOrCreateLoopBudget(budgetPath, limits);
  fs.writeFileSync(budgetPath, JSON.stringify({ ...exhausted, campaigns: 1, agent_starts: 2, evaluator_runs: 2 }));

  const resumed = await runLoop({ projectDir, contract, limits, now: () => new Date("2026-10-20T00:00:00.000Z") });
  const spent = JSON.parse(fs.readFileSync(budgetPath, "utf8"));

  assert.equal(resumed.stopReason, "budget", "a resumed run inherits the spent allowance instead of a fresh one");
  assert.equal(resumed.campaigns, 0);
  assert.deepEqual(
    { campaigns: spent.campaigns, agents: spent.agent_starts, evaluators: spent.evaluator_runs },
    { campaigns: 1, agents: 2, evaluators: 2 },
    "resume neither resets nor extends the cap",
  );
  assert.throws(
    () => readOrCreateLoopBudget(budgetPath, { ...limits, maxAgentStarts: 8 }),
    /immutable without an approved saved contract/,
    "a resumed run cannot widen its own cap without a replacement approval",
  );
});

test("loop resume finishes the saved campaign context, records it, and continues discovery", async () => {
  const projectDir = tempProject({
    "package.json": `${JSON.stringify({ name: "resume-loop", private: true, type: "module", scripts: { test: "node -e 0" } })}\n`,
    "src/a.js": "export const a = 1;\n",
  });
  try {
    const baseRoot = path.join(projectDir, ".dream-rsi");
    const loopRoot = path.join(baseRoot, "loop");
    const id = "aaaaaaaaaaaaaaaa";
    const campaignRoot = path.join(baseRoot, "campaigns", id);
    fs.mkdirSync(path.join(campaignRoot, "history"), { recursive: true });
    fs.writeFileSync(path.join(baseRoot, "campaigns", "active.json"), JSON.stringify({ id }));
    fs.writeFileSync(path.join(campaignRoot, "history", "ledger.jsonl"), "");
    fs.writeFileSync(path.join(campaignRoot, "campaign-processes.json"), JSON.stringify({
      version: 1, agent_limit: 5, evaluator_limit: 10, agent_starts: 0, evaluator_runs: 0, last_start: null,
    }));
    fs.writeFileSync(path.join(campaignRoot, "campaign.json"), JSON.stringify({
      version: 1, id, baseRoot, campaignRoot, projectDir, targetRoot: projectDir, goal: "resume fixture",
      task: { name: "fixture", workspace: ".", eval_program: "src/a.js", score_program: "node -e 0", score_path: "eval/score.json", higher_is_better: false, evaluator_timeout_ms: 1000 },
      scope: ["src"], verifierInputs: [], gates: [], taskFingerprint: "task", verifierIdentity: "verifier",
      limits: { maxCycles: 2, maxAgentStarts: 5, maxEvaluatorRuns: 10, deadlineMs: 60_000, plateauCycles: 2, maxCandidatesPerCycle: 2 },
      completedCycles: [], currentScore: 0, bestScore: 0, noGainCycles: 0,
      startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      state: { kind: "paused", phase: "experiment", iteration: null, reason: "stopped by request" },
    }));
    fs.mkdirSync(loopRoot, { recursive: true });
    fs.writeFileSync(path.join(loopRoot, "active.json"), JSON.stringify({
      version: 1, contractId: "contract-id",
      lever: { id: "saved-lever", sourceKind: "recon-command", goal: "fixture", mechanism: "saved mechanism", metric: "metric", metricKind: "command-duration", scopeFiles: ["src/a.js"], gates: [], estimates: { expectedGain: 0.1, costSeconds: 1, confidence: 1, readiness: 1 }, score: 1, evidence: [], reasons: [], command: { argv: ["node", "-e", "0"], shim: false, source: "fixture", entry: null } },
      setup: { task: { name: "fixture", workspace: ".", eval_program: "src/a.js", score_program: "node -e 0", score_path: "eval/score.json", higher_is_better: false }, verifierInputs: [], gates: [] },
      plan: { ready: true }, instrument: { argv: ["node", "-e", "0"], gates: [], baseline: [1, 1], unit: "ms", higherIsBetter: false, minimumUsefulGain: "10%", timeoutMs: 1000, kind: "command-duration" },
      baselineFingerprint: "before",
    }));

    const contract = normalizeRunContract(validContract());
    const resumeCalls = [];
    const result = await runLoop({
      projectDir, contract, resumeActiveCampaign: true,
      limits: { maxCampaigns: 2, maxAgentStarts: 20, maxEvaluatorRuns: 100, deadlineMs: 60_000 },
      resumeCampaignImpl: async (options) => {
        resumeCalls.push(options);
        const savedRecordPath = path.join(campaignRoot, "campaign.json");
        const savedRecord = JSON.parse(fs.readFileSync(savedRecordPath, "utf8"));
        savedRecord.state = { kind: "complete", reason: "resumed to completion" };
        fs.writeFileSync(savedRecordPath, JSON.stringify(savedRecord));
        return { id, baseRoot, campaignRoot, engineRoot: campaignRoot, projectDir, targetRoot: projectDir,
          scope: ["src"], goal: "resume fixture", limits: { maxCycles: 2, maxAgentStarts: 5, maxEvaluatorRuns: 10, deadlineMs: 60_000 },
          state: { kind: "complete", reason: "resumed to completion" }, completedCycles: [], currentScore: 0, bestScore: 0,
          noGainCycles: 0, agentStarts: 1, evaluatorRuns: 1, startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          stopped: true, stopReason: "resumed to completion" };
      },
    });

    assert.equal(resumeCalls.length, 1);
    assert.equal(result.records[0]?.leverId, "saved-lever", "the resumed campaign outcome is added to loop memory");
    assert.equal(result.stopCode, "blocked", "resume continues into discovery and reports its missing workload blocker");
    assert.match(result.stopReason, /no benchmark or custom workload is declared/);
    assert.equal(fs.existsSync(path.join(loopRoot, "active.json")), false, "terminal resume context is removed");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("qualification spend cannot push a campaign past the durable evaluator cap", async () => {
  const projectDir = tempProject({
    "package.json": `${JSON.stringify({ name: "cap", private: true, type: "module", scripts: { bench: "node bench.mjs", test: "node test.mjs" } }, null, 2)}\n`,
    "bench.mjs": 'import { work } from "./src/work.mjs";\nif (work() !== 1) process.exit(1);\n',
    "test.mjs": 'import { work } from "./src/work.mjs";\nif (work() !== 1) process.exit(1);\n',
    "src/work.mjs": "export function work() {\n  const until = performance.now() + 60;\n  while (performance.now() < until) { /* measured work */ }\n  return 1;\n}\n",
  });
  const limits = { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 3, deadlineMs: 60_000 };
  const contract = normalizeRunContract(validContract({ budgets: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 3 } }));
  const budgetPath = path.join(projectDir, ".dream-rsi", "loop", "budget.json");
  fs.mkdirSync(path.dirname(budgetPath), { recursive: true });
  // Two of the three evaluator runs are already spent, so the probe and the
  // qualification that follow cannot both fit inside the remaining allowance.
  const created = readOrCreateLoopBudget(budgetPath, limits);
  fs.writeFileSync(budgetPath, JSON.stringify({ ...created, evaluator_runs: 2 }));

  const result = await runLoop({
    projectDir,
    contract,
    limits,
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });
  const budget = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
  assert.ok(budget.evaluator_runs <= 3, `the durable cap must hold (spent ${budget.evaluator_runs} of 3)`);
  assert.equal(result.stopReason, "budget", "the run stops honestly instead of overspending");
  assert.equal(result.campaigns, 0, "no campaign is granted from a stale allowance");
});

test("a contract's budgets cap the durable spend even when the caller asks for more", async () => {
  const projectDir = tempProject({ "src/a.js": "export const a = 1;\n", "package.json": "{}\n" });
  const contract = normalizeRunContract(validContract({ budgets: { maxCampaigns: 1, maxAgentStarts: 2, maxEvaluatorRuns: 3 } }));
  // The caller asks for far more than the contract approved.
  const result = await runLoop({
    projectDir,
    contract,
    limits: { maxCampaigns: 50, maxAgentStarts: 500, maxEvaluatorRuns: 500, deadlineMs: 60_000 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });
  const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
  assert.equal(budget.max_campaigns, 1, "the contract's campaign ceiling wins");
  assert.equal(budget.max_agent_starts, 2, "the contract's agent-start ceiling wins");
  assert.equal(budget.max_evaluator_runs, 3, "the contract's evaluator ceiling wins");
});

test("a replacement cannot lower a durable cap through per-run limits", async () => {
  const projectDir = tempProject({ "src/a.js": "export const a = 1;\n", "package.json": "{}\n" });
  const loopRoot = path.join(projectDir, ".dream-rsi", "loop");
  fs.mkdirSync(loopRoot, { recursive: true });
  const oldContract = approveRunContract(projectDir, normalizeRunContract(validContract({ budgets: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 20 } })));
  fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...oldContract })}\n`);
  const budgetPath = path.join(loopRoot, "budget.json");
  const initial = readOrCreateLoopBudget(budgetPath, oldContract.contract.budgets);
  fs.writeFileSync(budgetPath, JSON.stringify({ ...initial, campaigns: 1, agent_starts: 2, evaluator_runs: 9 }));
  const raised = normalizeRunContract(validContract({ budgets: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 34 } }));
  const result = await runLoop({
    projectDir, contract: raised,
    replaceContract: approvalIdentity(oldContract.contract),
    limits: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 15, deadlineMs: 30_000 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });
  const budget = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
  assert.ok(result.contract, result.stopReason);
  assert.equal(readStoredContract(loopRoot).contract.budgets.maxEvaluatorRuns, 34);
  assert.deepEqual([budget.evaluator_runs, budget.max_evaluator_runs], [9, 20]);
});

test("request limits and the approved contract jointly bound new durable totals", async () => {
  const projectDir = tempProject({ "src/a.js": "export const a = 1;\n", "package.json": "{}\n" });
  const contract = normalizeRunContract(validContract({ budgets: { maxCampaigns: 4, maxAgentStarts: 20, maxEvaluatorRuns: 34 } }));
  const result = await runLoop({
    projectDir,
    contract,
    limits: { maxCampaigns: 2, maxAgentStarts: 10, maxEvaluatorRuns: 15, deadlineMs: 60_000 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });
  const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
  assert.deepEqual([budget.max_campaigns, budget.max_agent_starts, budget.max_evaluator_runs], [2, 10, 15]);
});

test("a contract run refuses a second objective even when the wording of the first is reused", async () => {
  const projectDir = tempProject({ "src/a.js": "export const a = 1;\n", "package.json": "{}\n" });
  const loopRoot = path.join(projectDir, ".dream-rsi", "loop");
  const first = approveRunContract(projectDir, normalizeRunContract(validContract()));
  fs.mkdirSync(loopRoot, { recursive: true });
  fs.writeFileSync(contractFile(loopRoot), `${JSON.stringify({ version: 1, ...first, contract: first.contract }, null, 2)}\n`);

  // Same sentence, materially wider boundary.
  const widened = normalizeRunContract(validContract({ scope: { roots: ["."], protectedAssets: [] } }));
  const result = await runLoop({
    projectDir,
    contract: widened,
    limits: { maxCampaigns: 1, maxAgentStarts: 4, maxEvaluatorRuns: 8, deadlineMs: 30_000 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });
  assert.equal(result.stopCode, "blocked", "a widened scope is a different contract, not missing consent");
  assert.equal(readStoredContract(loopRoot).contract.scope.roots[0], "src", "the approved scope is not overwritten");
});
