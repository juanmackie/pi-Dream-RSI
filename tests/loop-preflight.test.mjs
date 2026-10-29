import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { runLoop } from "../extensions/pi-dream-rsi/engine/loop.ts";
import { normalizeRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";
import { recoveryForLoop } from "../extensions/pi-dream-rsi/engine/recovery.ts";

const limits = { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: 120_000 };

function git(args, cwd) { return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }); }
function gitContract() {
  return normalizeRunContract({
    version: 1,
    outcome: { statement: "Optimize the fixture workload", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%", proxyJustification: "The pinned workload measures the approved outcome." },
    preserved: { gates: [] }, scope: { roots: ["src"], protectedAssets: [] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["benchmark"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 8, maxEvaluatorRuns: 20, deadlineMs: 120_000, falseAcceptBudget: 0.1 },
    git: { autoCommit: true, branch: "dream-rsi/improve" },
  });
}
function initializeGitProject(projectDir) {
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }));
  fs.writeFileSync(path.join(projectDir, "src/work.mjs"), "export const value = 'main';\n");
  git(["init", "--initial-branch=main"], projectDir);
  git(["config", "user.name", "Dream RSI Test"], projectDir);
  git(["config", "user.email", "dream-rsi-test@example.invalid"], projectDir);
  git(["add", "-A"], projectDir);
  git(["commit", "-m", "baseline"], projectDir);
}

test("auto-commit branch switching cannot change the source approved by the operator", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-approved-source-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  initializeGitProject(projectDir);
  git(["switch", "-c", "dream-rsi/improve"], projectDir);
  fs.writeFileSync(path.join(projectDir, "src/unreviewed.mjs"), "export const value = 'unreviewed-branch';\n");
  git(["add", "src/unreviewed.mjs"], projectDir);
  git(["commit", "-m", "different branch source"], projectDir);
  git(["switch", "main"], projectDir);
  let reconCalls = 0;
  try {
    const result = await runLoop({
      projectDir, contract: gitContract(), limits, includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      reconProjectImpl: async () => { reconCalls += 1; return { commands: [], probes: [], graph: [], graphs: {}, files: [], notes: [], blockers: [] }; },
    });
    assert.equal(result.stopCode, "blocked");
    assert.match(result.stopReason, /source changed when selecting the auto-commit branch/i);
    assert.equal(reconCalls, 0, "no repository command or discovery may run after switching to unreviewed source");
    assert.equal(fs.existsSync(path.join(projectDir, ".dream-rsi", "loop", "contract.json")), false, "the changed source must not receive a saved approval");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Git preflight blockers mentioning credentials still give commit recovery guidance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-index-blocked-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  initializeGitProject(projectDir);
  fs.writeFileSync(path.join(projectDir, "credentials.txt"), "operator change\n");
  try {
    const result = await runLoop({
      projectDir, contract: gitContract(), limits, includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
    });
    assert.equal(result.stopCode, "blocked");
    assert.ok(result.preflight.checks.some((check) => check.name === "git" && /clean working tree.*credentials\.txt/i.test(check.reason)));
    assert.equal(recoveryForLoop(result).category, "commit");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a metric without an evaluator is blocked instead of substituting a proxy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-no-evaluator-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "accuracy", scripts: {} }));
  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "Improve classification accuracy", unit: "percent", higherIsBetter: true, minimumUsefulGain: 1 },
    preserved: { gates: [] }, scope: { roots: ["src"], protectedAssets: [] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["benchmark"] },
    budgets: { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: 120_000, falseAcceptBudget: 0.1 },
  });
  let campaigns = 0;
  try {
    const result = await runLoop({
      projectDir, contract, limits, includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      reconProjectImpl: async () => ({ commands: [], probes: [], graph: [], graphs: {}, files: [], notes: [], blockers: ["no declared command matches the approved command categories, so there is nothing to measure"] }),
      runCampaignImpl: async () => { campaigns += 1; throw new Error("campaign must not start"); },
    });
    assert.equal(result.stopCode, "blocked");
    assert.ok(result.preflight.checks.some((check) => check.name === "evaluator" && check.status === "blocked" && /unit and score direction alone are not an evaluator/.test(check.remedy)));
    assert.equal(result.campaigns, 0);
    assert.equal(campaigns, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a declared failure-count metric uses a discovered failing suite without a score evaluator", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-native-failures-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "failures", scripts: { test: "node test.mjs" } }));
  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "Reduce the number of test failures", unit: "failures", higherIsBetter: false, minimumUsefulGain: 1 },
    preserved: { gates: [] }, scope: { roots: ["src"], protectedAssets: [] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["test"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20, deadlineMs: 120_000, falseAcceptBudget: 0.1 },
  });
  const command = { label: "npm test", argv: [process.execPath, path.join(projectDir, "test.mjs")], declaredArgv: ["npm", "test"], category: "test", source: "package.json#scripts.test", shim: false, entry: "test.mjs" };
  let taskProviderCalls = 0;
  let campaignCalls = 0;
  try {
    const result = await runLoop({
      projectDir, contract, limits: { ...limits, maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20 }, includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      reconProjectImpl: async (options) => {
        await options.beforeProbe?.(command);
        return { commands: [command], probes: [{ label: command.label, ok: false, durationMs: 12, timedOut: false, error: "one assertion failed", exitCode: 1, spawnFailed: false }], graph: ["src/work.mjs"], graphs: { [command.label]: ["src/work.mjs"] }, files: [], notes: [], blockers: [] };
      },
      taskProvider: ({ lever }) => {
        taskProviderCalls += 1;
        assert.equal(lever.metricKind, "suite-failures");
        return { reject: "test seam: do not launch a campaign" };
      },
      runCampaignImpl: async () => { campaignCalls += 1; throw new Error("the rejected test setup must not launch a campaign"); },
    });
    assert.ok(result.inventory?.levers.some((lever) => lever.metricKind === "suite-failures"));
    assert.ok(result.preflight.checks.some((check) => check.name === "metric" && check.status === "passed"));
    assert.ok(result.preflight.checks.some((check) => check.name === "evaluator" && check.status === "passed"));
    assert.equal(result.preflight.checks.some((check) => check.name === "metric" && check.status === "blocked"), false);
    assert.equal(result.preflight.checks.some((check) => check.name === "evaluator" && check.status === "blocked"), false);
    assert.equal(taskProviderCalls, 1, "the native failure-count lever reaches qualification/setup");
    assert.equal(campaignCalls, 0);
    assert.equal(result.campaigns, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an explicitly authorized bootstrap creates an in-scope workload before campaign ranking", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-bootstrap-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "canvas", scripts: {} }));
  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "Reduce canvas rendering time on a pinned synthetic workload", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%", proxyJustification: "Measured render time is the approved cost metric." },
    preserved: { gates: [] }, scope: { roots: ["."], protectedAssets: [] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["benchmark"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20, deadlineMs: 120_000, falseAcceptBudget: 0.1 },
  });
  let reconCount = 0;
  let bootstrapCalls = 0;
  let campaignCalls = 0;
  try {
    const result = await runLoop({
      projectDir, contract, focus: "pinned synthetic workload", limits: { ...limits, maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20 }, includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      evaluatorBootstrap: {
        authorized: true, paths: ["package.json", "bench.mjs"],
        run: async (context) => {
          await context.beforeAgentSpawn();
          bootstrapCalls += 1;
          assert.ok(context.deadlineMs > 0 && context.deadlineMs <= 120_000);
          fs.writeFileSync(path.join(projectDir, "bench.mjs"), "console.log('pinned workload');\n");
          fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "canvas", scripts: { bench: "node bench.mjs" } }));
          return { validatedPaths: ["package.json", "bench.mjs"] };
        },
      },
      reconProjectImpl: async (options) => {
        reconCount += 1;
        if (reconCount === 1) return { commands: [], probes: [], graph: [], graphs: {}, files: [], notes: [], blockers: ["no benchmark or custom workload is declared, so no duration or throughput can be measured"] };
        const command = { label: "npm run bench", argv: [process.execPath, path.join(projectDir, "bench.mjs")], declaredArgv: ["npm", "run", "bench"], category: "benchmark", source: "package.json#scripts.bench", shim: false, entry: "bench.mjs" };
        await options.beforeProbe?.(command);
        return { commands: [command], probes: [{ label: command.label, ok: true, durationMs: 1, timedOut: false, error: null, exitCode: 0 }], graph: ["bench.mjs"], graphs: { [command.label]: ["bench.mjs"] }, files: [{ path: "bench.mjs", bytes: 20, lines: 1 }], notes: [], blockers: [] };
      },
      taskProvider: ({ lever }) => ({ task: { name: "bootstrap-test", workspace: ".", eval_program: lever.scopeFiles[0] ?? ".", score_program: "node -e 0", score_path: "eval/score.json", higher_is_better: false, evaluator_timeout_ms: 5000, copy_exclude: [] }, verifierInputs: [], gates: [] }),
      runCampaignImpl: async (options) => {
        campaignCalls += 1;
        assert.equal(options.goal.includes("rendering"), true);
        return { id: "stub", baseRoot: options.baseRoot, campaignRoot: path.join(options.baseRoot, "campaigns", "stub"), engineRoot: path.join(options.baseRoot, "campaigns", "stub"), state: { kind: "complete", reason: "test" }, stopped: true, stopReason: "test", agentStarts: 0, evaluatorRuns: 0, currentScore: 0, bestScore: 0, baselineScore: 0, startedAt: new Date().toISOString() };
      },
    });
    assert.equal(bootstrapCalls, 1);
    assert.equal(reconCount, 2, "the created workload is executed by discovery before ranking");
    assert.equal(campaignCalls, 1, `${result.stopCode}: ${result.stopReason}; inventory=${JSON.stringify(result.inventory)}`);
    assert.equal(result.preflight.status, "not-checked", "declared gates and the final instrument still require qualification");
    assert.ok(result.preflight.checks.some((check) => check.name === "workload" && check.status === "passed"));
    assert.equal(result.preflightEvaluatorRuns, 1);
    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.equal(budget.phases.qualification.agent_starts, 1, "the bootstrap agent is charged before it runs");
    assert.ok(result.agentStarts >= 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap reports out-of-scope writes without demanding edit access to read-only gates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-bootstrap-scope-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "canvas", scripts: {} }));
  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "Measure pinned canvas render time", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%", proxyJustification: "Render time is the selected metric." },
    preserved: { gates: ["python -m unittest tests.test_mvp_wiring", "node \"tests/gate.mjs\" \"tests/other-gate.mjs\"", "node tests/outside.mjs&&node src/check.mjs", "node tests/redirection.mjs>gate.log&&node src/check.mjs"] }, scope: { roots: ["src"], protectedAssets: [] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20, deadlineMs: 120_000, falseAcceptBudget: 0.1 },
  });
  let bootstrapCalls = 0;
  let reconCalls = 0;
  try {
    const result = await runLoop({
      projectDir, contract, limits: { ...limits, maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20 }, includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      evaluatorBootstrap: { authorized: true, paths: ["package.json", "scripts/canvas-bench.mjs", "tests/gate.mjs"], run: async () => { bootstrapCalls += 1; return { validatedPaths: [] }; } },
      reconProjectImpl: async () => { reconCalls += 1; return { commands: [], probes: [], graph: [], graphs: {}, files: [], notes: [], blockers: ["no benchmark or custom workload is declared, so no duration or throughput can be measured"] }; },
    });
    assert.equal(result.stopCode, "blocked");
    assert.match(result.stopReason, /package\.json/);
    assert.match(result.stopReason, /scripts\/canvas-bench\.mjs/);
    assert.match(result.stopReason, /tests\/gate\.mjs/, "a gate becomes a write requirement only when setup explicitly plans to edit it");
    assert.doesNotMatch(result.stopReason, /tests\/test_mvp_wiring\.py|tests\/other-gate\.mjs|tests\/outside\.mjs|tests\/redirection\.mjs/, "read/run requirements must not be treated as planned writes");
    assert.match(result.stopReason, /Next step:/);
    assert.equal(bootstrapCalls, 0);
    assert.equal(reconCalls, 0, "scope incompatibility is found before discovery or saved contract approval");
    assert.equal(result.contract, null);
    assert.equal(fs.existsSync(path.join(projectDir, ".dream-rsi", "loop", "contract.json")), false);
    assert.equal(result.campaigns, 0);
    assert.equal(result.agentStarts, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap traversal paths are rejected before approval or discovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-bootstrap-traversal-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "canvas", scripts: {} }));
  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "Measure pinned canvas render time", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%", proxyJustification: "Render time is the selected metric." },
    preserved: { gates: [] }, scope: { roots: ["src"], protectedAssets: ["protected.json"] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["benchmark"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20, deadlineMs: 120_000, falseAcceptBudget: 0.1 },
  });
  let bootstrapCalls = 0;
  let reconCalls = 0;
  try {
    const result = await runLoop({
      projectDir, contract, limits: { ...limits, maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20 }, includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      evaluatorBootstrap: { authorized: true, paths: ["src/../protected.json"], run: async () => { bootstrapCalls += 1; return { validatedPaths: ["src/../protected.json"] }; } },
      reconProjectImpl: async () => { reconCalls += 1; return { commands: [], probes: [], graph: [], graphs: {}, files: [], notes: [], blockers: [] }; },
    });
    assert.equal(result.stopCode, "blocked");
    assert.match(result.stopReason, /src\/\.\.\/protected\.json/);
    assert.match(result.stopReason, /without traversal or absolute paths/);
    assert.equal(bootstrapCalls, 0);
    assert.equal(reconCalls, 0);
    assert.equal(result.contract, null);
    assert.equal(result.agentStarts, 0);
    assert.equal(result.campaigns, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("read-only gates and evaluator references outside patch scope do not require edit permission", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-gate-option-paths-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "canvas", scripts: {} }));
  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "Measure canvas render time", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%", proxyJustification: "Render time is the selected metric." },
    preserved: { gates: ["python -m unittest tests.test_mvp_wiring", "node --require=./tests/setup.js ./tests/check.js"] }, scope: { roots: ["src"], protectedAssets: ["tests", "scripts"] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20, deadlineMs: 120_000, falseAcceptBudget: 0.1 },
  });
  let reconCalls = 0;
  try {
    const result = await runLoop({
      projectDir, contract, focus: "Measure src/render.mjs with scripts/measure.mjs and tests/test_mvp_wiring.py", limits: { ...limits, maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20 }, includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      reconProjectImpl: async () => { reconCalls += 1; return { commands: [], probes: [], graph: [], graphs: {}, files: [], notes: [], blockers: ["no benchmark or custom workload is declared"] }; },
    });
    assert.ok(result.contract, result.stopReason);
    assert.ok(result.preflight.checks.some((check) => check.name === "scope" && check.status === "passed"), JSON.stringify(result.preflight));
    assert.equal(reconCalls, 1, "read-only requirements do not block discovery");
    assert.equal(result.stopCode, "blocked", "the genuinely missing workload still blocks after scope validation");
    assert.ok(result.preflight.checks.some((check) => check.name === "workload" && check.status === "blocked"));
    const saved = JSON.parse(fs.readFileSync(path.join(projectDir, ".dream-rsi/loop/contract.json"), "utf8")).contract;
    assert.deepEqual(saved.scope, contract.scope, "no write permission is added for verification files");
    assert.deepEqual(saved.preserved.gates, contract.preserved.gates, "all mandatory gates remain intact");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap stops at the run deadline without a second discovery pass", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-bootstrap-deadline-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "canvas", scripts: {} }));
  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "Measure pinned canvas render time", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%", proxyJustification: "Render time is the selected metric." },
    preserved: { gates: [] }, scope: { roots: [], protectedAssets: [] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["benchmark"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20, deadlineMs: 120_000, falseAcceptBudget: 0.1 },
  });
  let reconCount = 0;
  try {
    const result = await runLoop({
      projectDir, contract, limits: { ...limits, maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20, deadlineMs: 1_000 }, includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      evaluatorBootstrap: { authorized: true, paths: ["package.json", "bench.mjs"], run: async (context) => {
        await context.beforeAgentSpawn();
        assert.ok(context.deadlineMs > 0 && context.deadlineMs <= 1_000);
        await new Promise((resolve) => setTimeout(resolve, 1_050));
        return { validatedPaths: ["package.json", "bench.mjs"] };
      } },
      reconProjectImpl: async () => {
        reconCount += 1;
        return { commands: [], probes: [], graph: [], graphs: {}, files: [], notes: [], blockers: ["no benchmark or custom workload is declared, so no duration or throughput can be measured"] };
      },
    });
    assert.equal(result.stopCode, "deadline");
    assert.equal(reconCount, 1, "the bootstrapped workload is not discovered after the deadline");
    assert.equal(result.campaigns, 0);
    assert.equal(result.agentStarts, 1, "only the dispatched bootstrap agent is charged");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap refuses protected paths before spending an agent start", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-bootstrap-protected-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "canvas", scripts: {} }));
  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "Measure pinned canvas render time", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%", proxyJustification: "Render time is the selected metric." },
    preserved: { gates: [] }, scope: { roots: ["."], protectedAssets: ["bench.mjs"] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["benchmark"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20, deadlineMs: 120_000, falseAcceptBudget: 0.1 },
  });
  let bootstrapCalls = 0;
  try {
    const result = await runLoop({
      projectDir, contract, limits: { ...limits, maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20 }, includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      evaluatorBootstrap: { authorized: true, paths: ["package.json", "bench.mjs"], run: async () => { bootstrapCalls += 1; return { validatedPaths: ["package.json", "bench.mjs"] }; } },
      reconProjectImpl: async () => ({ commands: [], probes: [], graph: [], graphs: {}, files: [], notes: [], blockers: ["no benchmark or custom workload is declared, so no duration or throughput can be measured"] }),
    });
    assert.equal(result.stopCode, "blocked");
    assert.match(result.stopReason, /protected.*bench\.mjs/i);
    assert.equal(bootstrapCalls, 0);
    assert.equal(result.agentStarts, 0);
    assert.equal(result.campaigns, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("disabled bootstrap paths do not extend the approved editable scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-bootstrap-disabled-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "canvas", scripts: { test: "node -e 0" } }));
  const contract = normalizeRunContract({
    version: 1,
    outcome: { statement: "Reduce benchmark runtime", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%" },
    preserved: { gates: [] }, scope: { roots: ["src"], protectedAssets: [] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20, deadlineMs: 120_000, falseAcceptBudget: 0.1 },
  });
  try {
    const result = await runLoop({
      projectDir, contract, limits: { ...limits, maxCampaigns: 2, maxAgentStarts: 5, maxEvaluatorRuns: 20 }, includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      evaluatorBootstrap: { authorized: false, paths: ["bench.mjs"], run: async () => { throw new Error("disabled bootstrap must not run"); } },
      reconProjectImpl: async (options) => {
        const command = { label: "npm test", argv: [process.execPath, "-e", "0"], declaredArgv: ["npm", "test"], category: "test", source: "package.json#scripts.test", shim: false, entry: null };
        await options.beforeProbe?.(command);
        return { commands: [command], probes: [{ label: command.label, ok: true, durationMs: 1, timedOut: false, error: null, exitCode: 0 }], graph: [], graphs: {}, files: [], notes: [], blockers: ["no benchmark or custom workload is declared, so no duration or throughput can be measured"] };
      },
    });
    assert.equal(result.stopCode, "blocked");
    assert.ok(result.preflight.checks.some((check) => check.name === "scope" && check.status === "passed"));
    assert.equal(result.preflight.checks.some((check) => check.name === "scope" && check.status === "blocked"), false);
    assert.equal(result.campaigns, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("missing pinned workload is an actionable preflight blocker and all evaluator spend reconciles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-preflight-"));
  const projectDir = path.join(root, "project");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "canvas", scripts: { test: "node -e 0" } }));
  const contract = normalizeRunContract({
    version: 1,
    outcome: {
      statement: "Reduce large-canvas render time using a pinned synthetic 5,000-object workload",
      unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%",
      proxyJustification: "Wall-clock render time is the user-selected proxy for canvas rendering cost.",
    },
    preserved: { gates: ["node -e 0"] },
    scope: { roots: ["src"], protectedAssets: [] },
    execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["test"] },
    budgets: { maxCampaigns: 6, maxAgentStarts: 72, maxEvaluatorRuns: 200, deadlineMs: 120_000, falseAcceptBudget: 0.1 },
  });
  let probeStarts = 0;
  let campaigns = 0;
  try {
    const result = await runLoop({
      projectDir, contract, focus: "pinned synthetic 5,000-object canvas workload",
      limits, now: () => new Date(), includeLogs: false,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      reconProjectImpl: async (options) => {
        await options.beforeProbe?.({ label: "npm test", argv: ["node", "-e", "0"], declaredArgv: ["node", "-e", "0"], category: "test", source: "package.json#scripts.test", shim: false, entry: null });
        probeStarts += 1;
        return {
          commands: [{ label: "npm test", argv: ["node", "-e", "0"], declaredArgv: ["node", "-e", "0"], category: "test", source: "package.json#scripts.test", shim: false, entry: null }],
          probes: [{ label: "npm test", ok: true, durationMs: 1, timedOut: false, error: null, exitCode: 0, spawnFailed: false }],
          graph: [], graphs: {}, files: [], notes: [],
          blockers: ["no benchmark or custom workload is declared, so no duration or throughput can be measured"],
        };
      },
      runCampaignImpl: async () => { campaigns += 1; throw new Error("campaign must not start"); },
    });
    const report = JSON.parse(fs.readFileSync(result.reportPath, "utf8"));
    const lastRunPath = path.join(path.dirname(result.reportPath), "last-run.md");
    const lastRun = fs.readFileSync(lastRunPath, "utf8");
    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.equal(result.stopCode, "blocked");
    assert.match(result.stopReason, /no benchmark or custom workload is declared/);
    assert.match(result.stopReason, /Declare and pin the requested workload/);
    assert.equal(result.preflight.status, "blocked");
    assert.ok(result.preflight.checks.some((check) => check.name === "workload" && check.status === "blocked"));
    assert.equal(result.campaigns, 0);
    assert.equal(campaigns, 0);
    assert.equal(probeStarts, 1);
    assert.equal(result.preflightEvaluatorRuns, 1);
    assert.equal(result.campaignEvaluatorRuns, 0);
    assert.equal(result.evaluatorRuns, result.preflightEvaluatorRuns + result.campaignEvaluatorRuns);
    assert.equal(report.evaluatorRuns, budget.evaluator_runs);
    assert.equal(report.evaluatorRuns, 1);
    assert.equal(report.preflightEvaluatorRuns, 1);
    assert.equal(report.campaignEvaluatorRuns, 0);
    assert.equal(report.evaluatorRunsByPhase.discovery, 1);
    assert.equal(report.campaigns, budget.campaigns);
    assert.match(lastRun, /# Dream-RSI last run/);
    assert.match(lastRun, /Stop: `blocked`/);
    assert.match(lastRun, /no benchmark or custom workload is declared/);
    assert.match(lastRun, /## Next action/);
    assert.match(lastRun, /1 evaluator run\(s\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
