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
  projectFingerprint, readStoredContract, restrictedEnvironment, validateRunContract, withinApprovedScope,
} from "../extensions/pi-dream-rsi/engine/intake.ts";
import {
  readOrCreateLoopBudget, reconcileOpenReservation, remainingAllowance, settleReservation, writeLoopBudget,
} from "../extensions/pi-dream-rsi/engine/loop-budget.ts";
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
      mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"],
      ...(overrides.execution ?? {}),
    },
    models: { providers: ["fixture"], ...(overrides.models ?? {}) },
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
    [{ execution: { mode: "sandbox" } }, /mode must be "trusted-local"/],
    [{ execution: { allowedCommandCategories: [] } }, /allowedCommandCategories must be a non-empty array/],
    [{ execution: { allowedCommandCategories: ["deploy"] } }, /unknown categories: deploy/],
    [{ scope: { roots: ["../escape"] } }, /scope\.roots/],
    [{ scope: { protectedAssets: ["/etc/passwd"] } }, /scope\.protectedAssets/],
    [{ models: { providers: [] } }, /models\.providers/],
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
  assert.equal(withinApprovedScope(contract, "src/a.js"), true);
  assert.equal(withinApprovedScope(contract, "tools/b.js"), true);
  assert.equal(withinApprovedScope(contract, "docs/c.md"), false);
  assert.equal(withinApprovedScope(contract, "srcfoo/a.js"), false);
  assert.equal(isProtectedAsset(contract, "test/x.mjs"), true);
  assert.equal(isProtectedAsset(contract, "src/vendor/lib.js"), true);
  assert.equal(isProtectedAsset(contract, "src/other.js"), false);

  const open = normalizeRunContract(validContract({ scope: { roots: [] } }));
  assert.equal(withinApprovedScope(open, "anything/at/all.js"), true, "no declared roots means the whole workspace is editable");
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

const BUDGET_LIMITS = { maxCampaigns: 3, maxAgentStarts: 30, maxEvaluatorRuns: 60, deadlineMs: 60_000, maxOptimizerTrials: 1 };

test("the durable budget charges each phase from the same allowance and refuses to loosen its limits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-budget-"));
  const file = path.join(dir, "budget.json");
  let budget = readOrCreateLoopBudget(file, BUDGET_LIMITS);
  assert.deepEqual(remainingAllowance(budget), { campaigns: 3, agentStarts: 30, evaluatorRuns: 60, optimizerTrials: 1 });

  // A discovery probe is not billed as a campaign.
  const probe = { phase: "discovery", agent_starts: 1, evaluator_runs: 2, campaigns: 0, at: new Date().toISOString() };
  budget = { ...budget, open_campaign: probe };
  writeLoopBudget(file, budget);
  budget = settleReservation(readOrCreateLoopBudget(file, BUDGET_LIMITS), probe, { agentStarts: 1, evaluatorRuns: 2 });
  writeLoopBudget(file, budget);
  assert.equal(budget.campaigns, 0, "a probe does not consume a campaign");
  assert.equal(budget.agent_starts, 1);
  assert.deepEqual(budget.phases.discovery, { agent_starts: 1, evaluator_runs: 2, campaigns: 0 });

  // An optimizer trial consumes its reserved allowance.
  const trial = { phase: "optimizer", agent_starts: 4, evaluator_runs: 6, at: new Date().toISOString() };
  budget = settleReservation(budget, trial, { agentStarts: 4, evaluatorRuns: 6 });
  writeLoopBudget(file, budget);
  budget = readOrCreateLoopBudget(file, BUDGET_LIMITS);
  assert.equal(budget.optimizer_trials, 1);
  assert.equal(remainingAllowance(budget).optimizerTrials, 0);

  assert.throws(() => readOrCreateLoopBudget(file, { ...BUDGET_LIMITS, maxCampaigns: 9 }), /limits are immutable/);
  assert.throws(() => readOrCreateLoopBudget(file, { ...BUDGET_LIMITS, maxOptimizerTrials: 4 }), /limits are immutable/);
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
    [{ optimizer_trials: 9 }, /optimizer-trial counter/],
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

test("a contract run that supplies a control patch still cannot record an unverified win", async () => {
  const projectDir = tempProject({
    "package.json": `${JSON.stringify({ name: "cp", private: true, type: "module", scripts: { bench: "node bench.mjs", test: "node test.mjs" } }, null, 2)}\n`,
    "bench.mjs": 'import { work } from "./src/work.mjs";\nif (work() !== 1) process.exit(1);\n',
    "test.mjs": 'import { work } from "./src/work.mjs";\nif (work() !== 1) process.exit(1);\n',
    "src/work.mjs": "export function work() {\n  const until = performance.now() + 120;\n  while (performance.now() < until) { /* measured work */ }\n  return 1;\n}\n",
    "control.patch": "diff --git a/src/work.mjs b/src/work.mjs\n",
  });
  // A large required gain, so measurement noise alone can never look like a win.
  const contract = normalizeRunContract(validContract({
    outcome: { statement: "reduce benchmark duration", unit: "ms", higherIsBetter: false, minimumUsefulGain: "90%" },
    budgets: { maxCampaigns: 1, maxAgentStarts: 6, maxEvaluatorRuns: 40 },
  }));

  // A stub campaign claims an apply without improving anything, so only the independent
  // post-apply check can tell the difference between a claim and a verified improvement.
  const calls = [];
  const runCampaignImpl = async (options) => {
    calls.push(options);
    const id = "stub-1";
    const campaignRoot = path.join(options.baseRoot, "campaigns", id);
    fs.mkdirSync(path.join(campaignRoot, "history"), { recursive: true });
    fs.writeFileSync(path.join(campaignRoot, "history", "ledger.jsonl"),
      `${JSON.stringify({ v: 1, t: new Date().toISOString(), entryId: "e1", kind: "apply", campaignId: id, stage: "apply", outcome: "success" })}\n`);
    return { id, baseRoot: options.baseRoot, campaignRoot, engineRoot: campaignRoot, state: { kind: "complete", reason: "stub" },
      stopped: true, stopReason: "stub finished", agentStarts: 1, evaluatorRuns: 1, currentScore: 0, bestScore: 0, baselineScore: 0, startedAt: new Date().toISOString() };
  };

  const result = await runLoop({
    projectDir,
    contract,
    limits: { maxCampaigns: 1, maxAgentStarts: 6, maxEvaluatorRuns: 40, deadlineMs: 120_000 },
    controlPatchPath: path.join(projectDir, "control.patch"),
    runCampaignImpl,
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });

  assert.equal(calls.length, 1, "the campaign ran");
  assert.equal(calls[0].minimumGain, "90%",
    "the approved contract's minimum useful gain reaches the campaign when the caller passed none");
  assert.equal(result.verifications.length, 1, "the applied change was checked independently even on the control-patch path");
  assert.equal(result.verifications[0].passed, false, "the unchanged tree does not clear the useful gain");
  assert.equal(result.wins, 0, "a claim is not a win");
  assert.match(result.stopReason, /^post-apply check failed/);
});
