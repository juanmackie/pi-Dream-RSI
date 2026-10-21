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

import {
  ContractNotApprovedError, approveRunContract, contractFile, isProtectedAsset, normalizeRunContract,
  projectFingerprint, readStoredContract, restrictedEnvironment, validateRunContract,
} from "../extensions/pi-dream-rsi/engine/intake.ts";
import { pathWithin } from "../extensions/pi-dream-rsi/engine/scope.ts";
import {
  readOrCreateLoopBudget, reconcileOpenReservation, remainingAllowance, settleReservation, writeLoopBudget,
} from "../extensions/pi-dream-rsi/engine/budget.ts";
import { runLoop } from "../extensions/pi-dream-rsi/engine/loop.ts";

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
  ];
  for (const [patch, expected] of cases) {
    const errors = validateRunContract(validContract(patch));
    assert.ok(errors.length > 0, `expected a rejection for ${JSON.stringify(patch)}`);
    assert.match(errors.join("; "), expected);
    assert.throws(() => normalizeRunContract(validContract(patch)), expected);
  }
  assert.throws(() => normalizeRunContract(null), /must be an object/);
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

const BUDGET_LIMITS = { maxCampaigns: 3, maxAgentStarts: 30, maxEvaluatorRuns: 60, deadlineMs: 60_000 };

test("the durable budget charges each phase from the same allowance and refuses to loosen its limits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-budget-"));
  const file = path.join(dir, "budget.json");
  let budget = readOrCreateLoopBudget(file, BUDGET_LIMITS);
  assert.deepEqual(remainingAllowance(budget), { campaigns: 3, agentStarts: 30, evaluatorRuns: 60 });

  // A discovery probe is not billed as a campaign.
  const probe = { phase: "discovery", agent_starts: 1, evaluator_runs: 2, campaigns: 0, at: new Date().toISOString() };
  budget = { ...budget, open_campaign: probe };
  writeLoopBudget(file, budget);
  budget = settleReservation(readOrCreateLoopBudget(file, BUDGET_LIMITS), probe, { agentStarts: 1, evaluatorRuns: 2 });
  writeLoopBudget(file, budget);
  assert.equal(budget.campaigns, 0, "a probe does not consume a campaign");
  assert.equal(budget.agent_starts, 1);
  assert.deepEqual(budget.phases.discovery, { agent_starts: 1, evaluator_runs: 2, campaigns: 0 });

  assert.throws(() => readOrCreateLoopBudget(file, { ...BUDGET_LIMITS, maxCampaigns: 9 }), /limits are immutable/);
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

  assert.equal(result.stopReason, "not-approved");
  assert.match(result.memory.notes.at(-1), /a different run contract is already stored/);
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
    contract: normalizeRunContract(validContract()),
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
    /limits are immutable/,
    "a resumed run cannot widen its own cap",
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
  assert.equal(result.stopReason, "not-approved", "a widened scope is a different contract");
  assert.equal(readStoredContract(loopRoot).contract.scope.roots[0], "src", "the approved scope is not overwritten");
});
