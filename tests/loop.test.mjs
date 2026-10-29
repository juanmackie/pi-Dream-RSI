import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { campaignSeedReadings, readLoopActivity, runLoop as runLoopCore, waitForCampaignInterval } from "../extensions/pi-dream-rsi/engine/loop.ts";
import { CampaignInfeasibleError, campaignVerifierIdentity, promotionFloor, readCampaignStatus } from "../extensions/pi-dream-rsi/engine/campaign.ts";
import { normalizeRunContract, projectFingerprint } from "../extensions/pi-dream-rsi/engine/intake.ts";
import { defaultSearchConfig } from "../extensions/pi-dream-rsi/engine/experiment.ts";
import { defaultTask } from "../extensions/pi-dream-rsi/engine/task.ts";
import { appendLedgerRecord } from "../extensions/pi-dream-rsi/engine/ledger.ts";
import { applyCandidatePatch, candidatePatchFingerprint } from "../extensions/pi-dream-rsi/engine/campaign-patch.ts";
import { readOrCreateLoopBudget, reserveHourlyProcessStart, writeLoopBudget } from "../extensions/pi-dream-rsi/engine/budget.ts";

const NOW = new Date("2026-10-16T00:00:00.000Z");

const TEST_CONTRACT = normalizeRunContract({
  version: 1,
  outcome: { statement: "Reduce benchmark duration", unit: "ms", higherIsBetter: false, minimumUsefulGain: "5%" },
  preserved: { gates: [] },
  scope: { roots: ["."], protectedAssets: [] },
  execution: { consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark", "build", "custom"] },
  budgets: { maxCampaigns: 20, maxAgentStarts: 2000, maxEvaluatorRuns: 2000, deadlineMs: 7_200_000, falseAcceptBudget: 0.1 },
});

function runLoop(options) {
  const commandSpecs = [
    { label: "npm test", category: "test", entry: "src/parser.ts", ok: false, exitCode: 1, durationMs: 500 },
    { label: "npm run bench", category: "benchmark", entry: "src/lexer.ts", ok: true, exitCode: 0, durationMs: 1200 },
    { label: "node bench-extra.mjs", category: "custom", entry: "src/extra.ts", ok: true, exitCode: 0, durationMs: 800 },
  ];
  const reconProjectImpl = options.reconProjectImpl ?? (async (reconOptions) => {
    const selected = commandSpecs.slice(0, Math.max(1, reconOptions.maxProbes ?? 3));
    for (const command of selected) await reconOptions.beforeProbe?.(command);
    return {
      commands: selected.map(({ ok, exitCode, durationMs, ...command }) => ({
        ...command, argv: command.label.split(" "), declaredArgv: command.label.split(" "),
        source: `fixture:${command.label}`, shim: false,
      })),
      probes: selected.map(({ label, ok, exitCode, durationMs }) => ({
        label, ok, durationMs, timedOut: false, error: ok ? null : "test failures", exitCode, spawnFailed: false,
      })),
      graph: selected.map((command) => command.entry),
      graphs: Object.fromEntries(selected.map((command) => [command.label, [command.entry]])),
      files: selected.map((command) => ({ path: command.entry, bytes: 20, lines: 1 })),
      notes: [], blockers: [],
    };
  });
  return runLoopCore({
    ...options,
    contract: options.contract ?? TEST_CONTRACT,
    reconProbes: options.reconProbes ?? 3,
    reconProjectImpl,
    taskProvider: options.taskProvider ?? (({ lever }) => ({
      task: { ...defaultTask(lever.id), eval_program: lever.scopeFiles[0] ?? ".", score_program: "node -e 0", higher_is_better: false },
      verifierInputs: [], gates: [],
    })),
  });
}

function writeSession(sessionDir, projectDir, entries, name = "session.jsonl", mtime = NOW) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const header = { type: "session", version: 3, id: name, timestamp: mtime.toISOString(), cwd: projectDir };
  const file = path.join(sessionDir, name);
  fs.writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  fs.utimesSync(file, mtime, mtime);
}

function toolEntry(id, name, arguments_, time) {
  return {
    type: "message", id: `entry-${id}`, parentId: null, timestamp: new Date(time).toISOString(),
    message: {
      role: "assistant", content: [{ type: "toolCall", id, name, arguments: arguments_ }],
      timestamp: time, provider: "fixture", model: "fixture", api: "fixture", usage: {}, stopReason: "toolUse",
    },
  };
}

function toolResult(id, name, text, time, { isError = false, details } = {}) {
  return {
    type: "message", id: `result-${id}`, parentId: null, timestamp: new Date(time).toISOString(),
    message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: time, details },
  };
}

/** Fixture project with session evidence for contract-bounded recon ranking. */
function fixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-loop-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node -e 0" } }));
  const sessionDir = path.join(dir, "sessions");
  const t0 = NOW.getTime() - 60_000;
  writeSession(sessionDir, projectDir, [
    toolEntry("fail-1", "bash", { command: "npm test" }, t0),
    toolResult("fail-1", "bash", "Error: command failed", t0 + 80, { isError: true }),
    toolEntry("edit-1", "edit", { path: "src/parser.ts", edits: [{ oldText: "a", newText: "b" }] }, t0 + 120),
    toolResult("edit-1", "edit", "edited", t0 + 160),
    toolEntry("fail-2", "bash", { command: "npm test" }, t0 + 200),
    toolResult("fail-2", "bash", "Error: command failed", t0 + 280, { isError: true }),
    toolEntry("edit-2", "write", { path: "src/lexer.ts", content: "fix" }, t0 + 320),
    toolResult("edit-2", "write", "written", t0 + 360),
  ]);
  return { dir, projectDir, sessionDir };
}

/** Stub campaign engine: records calls and fabricates a bounded campaign result. */
function stubCampaign({ outcome = "no-win", stateKind = "complete", stopReason = "stub finished", agentStarts = 5, evaluatorRuns = 9, pendingConfirmation = false } = {}) {
  const calls = [];
  const impl = async (options) => {
    calls.push(options);
    const id = `stub-${calls.length}`;
    const campaignRoot = path.join(options.baseRoot, "campaigns", id);
    fs.mkdirSync(path.join(campaignRoot, "history"), { recursive: true });
    const entry = outcome === "win"
      ? { v: 1, t: NOW.toISOString(), entryId: `e${calls.length}`, kind: "apply", campaignId: id, stage: "apply", outcome: "success" }
      : { v: 1, t: NOW.toISOString(), entryId: `e${calls.length}`, kind: "attempt", campaignId: id, stage: "attempt", outcome: "rejected" };
    fs.writeFileSync(path.join(campaignRoot, "history", "ledger.jsonl"), `${JSON.stringify(entry)}\n`);
    return {
      id, baseRoot: options.baseRoot, campaignRoot, engineRoot: campaignRoot,
      state: { kind: stateKind, reason: stopReason }, stopped: true, stopReason,
      agentStarts, evaluatorRuns, currentScore: 0, bestScore: 0, baselineScore: 0, startedAt: NOW.toISOString(),
      ...(pendingConfirmation ? { pendingConfirmation: { iteration: 1, cell: "n1", pairs: 2, maxPairs: 8 } } : {}),
    };
  };
  return { impl, calls };
}

function baseLimits(overrides = {}) {
  return { maxCampaigns: 1, maxAgentStarts: 1000, maxEvaluatorRuns: 1000, deadlineMs: 60_000, ...overrides };
}

function pendingConfirmationArtifacts(projectDir, contract, { autoCommitFixture = false } = {}) {
  const baseRoot = path.join(projectDir, ".dream-rsi");
  const loopRoot = path.join(baseRoot, "loop");
  const id = "a0000000-0000-4000-8000-000000000001";
  const campaignRoot = path.join(baseRoot, "campaigns", id);
  const history = path.join(campaignRoot, "history");
  const evidenceDir = path.join(history, "r0001_campaign", "n1");
  const metricsDir = path.join(loopRoot, "metrics", "recovery1");
  const verifierDir = path.join(loopRoot, "verifiers", "recovery1");
  const wrapperPath = path.join(metricsDir, "evaluate.mjs");
  const sourcePath = path.join(projectDir, "eval", "score.mjs");
  const gatePath = path.join(projectDir, "eval", "gate.mjs");
  const targetPath = path.join(projectDir, "src", "parser.ts");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(targetPath, "export const oldValue = 1;\n");
  fs.writeFileSync(sourcePath, autoCommitFixture
    ? `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";\nconst value=readFileSync("src/parser.ts","utf8").includes("oldValue = 2")?2:1;mkdirSync("eval",{recursive:true});writeFileSync("eval/score.json",JSON.stringify({score:value,valid:true,fail_class:"ok",error:null}));\n`
    : "process.stdout.write('score');\n");
  fs.writeFileSync(gatePath, "process.exit(0);\n");
  const argv = contract.outcome.evaluator.argv;
  const declaredInputs = contract.outcome.evaluator.inputs ?? [];
  const identityInputs = declaredInputs.map((input) => path.resolve(projectDir, input));
  const pinnedInputs = declaredInputs.map((input) => path.join(verifierDir, ...input.replace(/\\/g, "/").split("/")));
  for (let index = 0; index < pinnedInputs.length; index += 1) {
    fs.mkdirSync(path.dirname(pinnedInputs[index]), { recursive: true });
    fs.copyFileSync(path.resolve(projectDir, declaredInputs[index]), pinnedInputs[index]);
  }
  fs.writeFileSync(wrapperPath, [
    ...(autoCommitFixture ? ['import { spawnSync } from "node:child_process";'] : []),
    `const COMMAND = ${JSON.stringify(argv)};`,
    'const MODE = "score";',
    "const SAMPLE_TIMEOUT_MS = 600000;",
    'const OUTPUT = "eval/score.json";',
    `const SCORE_OUTPUT = ${JSON.stringify(contract.outcome.evaluator.output)};`,
    `const SCORE_UNIT = ${JSON.stringify(contract.outcome.unit)};`,
    ...(autoCommitFixture ? ["const result=spawnSync(COMMAND[0],COMMAND.slice(1),{stdio:'inherit'});process.exit(result.status??1);"] : []),
    "",
  ].join("\n"));
  const old = new Date(Date.now() - 10 * 60_000);
  for (const file of [wrapperPath, sourcePath, gatePath]) fs.utimesSync(file, old, old);

  const task = {
    ...defaultTask("recovery1"),
    eval_program: "src/parser.ts",
    score_program: `node "${wrapperPath}"`,
    score_path: "eval/score.json",
    higher_is_better: contract.outcome.higherIsBetter,
  };
  const verifierInputs = [wrapperPath, ...pinnedInputs];
  const gates = [...contract.preserved.gates];
  const verifierIdentity = campaignVerifierIdentity(projectDir, task, verifierInputs, gates, identityInputs);
  const targetDigest = "b".repeat(64);
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, "ledger.jsonl"), "");
  fs.writeFileSync(path.join(campaignRoot, "campaign-processes.json"), JSON.stringify({
    version: 1, agent_limit: 20, evaluator_limit: 200, agent_starts: 5, evaluator_runs: 9, last_start: null,
  }));

  const candidatePath = path.join(campaignRoot, "candidate", "src", "parser.ts");
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, "export const oldValue = 2;\n");
  const patch = [{
    kind: "write", relative: "src/parser.ts", from: candidatePath, to: targetPath,
    beforeHash: createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex"),
    afterHash: createHash("sha256").update(fs.readFileSync(candidatePath)).digest("hex"), beforeLines: 1, afterLines: 1,
  }];
  const patchHash = autoCommitFixture ? candidatePatchFingerprint(patch) : "a".repeat(64);
  const confirmationIdentity = `${verifierIdentity}:${patchHash}:${targetDigest}`;
  const outcome = (raw) => ({ score: autoCommitFixture ? raw : -raw, raw_score: raw, valid: true, fail_class: "ok", error: null });
  const pairs = autoCommitFixture
    ? [1.5, 1.6].map((after) => ({ measurement: { before: 1, after, gain: after - 1 }, beforeOutcome: outcome(1), afterOutcome: outcome(after) }))
    : [9.5, 9.4].map((after) => ({ measurement: { before: 10, after, gain: Math.log(10 / after) }, beforeOutcome: outcome(10), afterOutcome: outcome(after) }));
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "confirmation.json"), JSON.stringify({ version: 1, identity: confirmationIdentity, baseline: autoCommitFixture ? [1, 1, 1] : [10, 9], pairs }));
  const now = Date.now();
  const record = {
    version: 1, id, baseRoot, campaignRoot, projectDir, targetRoot: projectDir,
    goal: contract.outcome.statement, task, scope: ["src/parser.ts"], verifierInputs, verifierIdentity, identityInputs, taskFingerprint: "test-fingerprint",
    searchConfig: defaultSearchConfig, mechanism: "test recovery", minimumGain: 0.5,
    requestedMinimumGain: contract.outcome.minimumUsefulGain, expectedReadMs: 1000,
    baselineScores: autoCommitFixture ? [1, 1, 1] : [-10, -9, -11], rawBaselineScores: autoCommitFixture ? [1, 1, 1] : [10, 9],
    checkRuns: (autoCommitFixture ? [1, 1, 1] : [-10, -9, -11]).map((score) => ({ durationMs: 0, code: null, valid: true, failClass: "ok", score, error: null, stdoutTail: "seeded from loop qualification", logPath: null })),
    gates,
    limits: { maxCycles: 2, maxAgentStarts: 20, maxEvaluatorRuns: 200, deadlineMs: 60_000, plateauCycles: 2, maxCandidatesPerCycle: 8 },
    startedAt: new Date(now - 60_000).toISOString(), deadlineAt: new Date(now - 1_000).toISOString(),
    completedCycles: [], baselineScore: -10, baselineRepeatScore: -9, currentScore: -10, bestScore: -10, noGainCycles: 0,
    state: { kind: "paused", phase: "promote", iteration: 1, reason: "confirmation pending" },
    pendingConfirmation: {
      iteration: 1, candidate: { iteration: 1, cell: "n1", score: -8, raw_score: 8, fail_class: "ok", workspace: path.join(campaignRoot, "candidate"), program: targetPath },
      patch, patchHash, evidenceDir, confirmationIdentity, targetDigest, pairs: 2, maxPairs: 8,
    },
  };
  fs.mkdirSync(path.join(baseRoot, "campaigns"), { recursive: true });
  fs.writeFileSync(path.join(campaignRoot, "campaign.json"), JSON.stringify(record));
  fs.writeFileSync(path.join(baseRoot, "campaigns", "active.json"), JSON.stringify({ id }));
  return { baseRoot, campaignRoot, loopRoot, sourcePath, evidencePath: path.join(evidenceDir, "confirmation.json") };
}

test("live activity inspection distinguishes lease ownership from stale or unverifiable state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-activity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "loop"));
  const file = path.join(root, "loop/lease.json");
  assert.equal(readLoopActivity(root), null);
  const lease = { pid: process.pid, host: os.hostname(), startedAt: NOW.toISOString(), heartbeatAt: NOW.toISOString(),
    activity: { phase: "qualification", detail: "Checking the metric", updatedAt: NOW.toISOString() } };
  for (const [patch, state] of [[{}, "running"], [{ pid: 999999 }, "interrupted"], [{ host: "another-host" }, "unverified"], [{ host: null }, "unverified"]]) {
    const before = JSON.stringify({ ...lease, ...patch });
    fs.writeFileSync(file, before);
    const observed = readLoopActivity(root);
    assert.equal(observed.state, state);
    assert.equal(observed.phase, "qualification");
    assert.equal(fs.readFileSync(file, "utf8"), before, "inspection is read-only even for a dead owner");
  }
  fs.writeFileSync(file, "not JSON");
  assert.equal(readLoopActivity(root).state, "unknown");
  fs.writeFileSync(file, JSON.stringify({ ...lease, activity: undefined }));
  assert.equal(readLoopActivity(root).phase, "unknown", "legacy leases do not invent a work phase");
  assert.equal(readLoopActivity(root).state, "unverified", "a legacy lease alone is not verified live progress");
  fs.writeFileSync(file, " ".repeat(65 * 1024));
  assert.equal(readLoopActivity(root).state, "unknown", "oversized lease input is refused");
});

test("loop ranks contract-bounded recon levers and accounts for campaign spend", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign();
    const messages = [];
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      runCampaignImpl: stub.impl,
      now: () => NOW,
      onProgress: (message) => messages.push(message),
    });

    assert.equal(result.stopReason, "budget", "one campaign spent the per-run campaign allowance");
    assert.equal(stub.calls.length, 1);
    assert.equal(result.campaigns, 1);
    assert.equal(result.wins, 0, "a campaign claim without an independent instrument cannot be counted as a verified win");
    assert.equal(result.agentStarts, 5);
    assert.equal(result.campaignEvaluatorRuns, 9, "campaign evaluator spend remains distinct from discovery probes");
    assert.equal(result.preflightEvaluatorRuns, 3, "discovery probes are reported as preflight spend");
    assert.equal(result.evaluatorRuns, 12, "total evaluator spend includes preflight and campaign runs");

    const call = stub.calls[0];
    assert.equal(call.verifierInputs.length, 0, "the fixture setup avoids synthesizing an evaluator in loop accounting tests");
    assert.deepEqual(call.gates, [], "the metric command is not repeated as a gate");
    assert.deepEqual(call.scope, ["src/parser.ts"], "the failing test lever is scoped to its own measured import graph");
    assert.equal(call.task.workspace, ".");
    assert.equal(call.task.higher_is_better, false);
    assert.match(call.goal, /"/);
    assert.equal(call.limits.maxCycles, 2);
    assert.equal(call.limits.maxAgentStarts, 18);
    assert.equal(call.limits.maxEvaluatorRuns, 48);
    assert.ok(call.limits.deadlineMs <= 30 * 60 * 1000);

    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.deepEqual(
      { campaigns: budget.campaigns, agent: budget.agent_starts, evaluators: budget.evaluator_runs, open: budget.open_campaign },
      { campaigns: 1, agent: 5, evaluators: 12, open: null },
      "the reservation is reconciled into real spend",
    );

    assert.ok(result.records.some((record) => record.outcome === "no-win"), "the scripted campaign's unverified no-win outcome is recorded");
    assert.equal(result.records.some((record) => record.outcome === "rejected"), false, "no lever needed a screening rejection: the command lever had discovered scope");
    assert.ok(messages.some((message) => /campaign stub-1 finished as no-win/.test(message)));
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("continuous mode stops on its durable no-win plateau without resetting spend on another explicit run", async () => {
  const fixture = fixtureProject();
  try {
    const contract = normalizeRunContract({ ...TEST_CONTRACT, continuation: { plateauCampaigns: 1, minimumCampaignIntervalMs: 1000 } });
    const first = stubCampaign();
    const result = await runLoop({ projectDir: fixture.projectDir, sessionDir: fixture.sessionDir,
      limits: baseLimits({ maxCampaigns: 5 }), contract, runCampaignImpl: first.impl, now: () => NOW });
    assert.equal(result.stopCode, "plateau");
    assert.equal(first.calls.length, 1);
    const savedBudget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.equal(savedBudget.consecutive_no_win_campaigns, 1);
    assert.equal(Date.parse(savedBudget.last_campaign_started_at), NOW.getTime());

    const second = stubCampaign();
    const continued = await runLoop({ projectDir: fixture.projectDir, sessionDir: fixture.sessionDir,
      limits: baseLimits({ maxCampaigns: 5 }), contract, runCampaignImpl: second.impl, now: () => new Date(NOW.getTime() + 86_400_000) });
    assert.equal(continued.stopCode, "plateau", "cross-day explicit continuation does not erase plateau history");
    assert.equal(second.calls.length, 0, "no new campaign starts after the approved plateau");
    assert.equal(JSON.parse(fs.readFileSync(result.budgetPath, "utf8")).campaigns, 1, "durable campaign spend is unchanged");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("continuous dispatch waits at the real campaign process hook, then reserves one rolling-hour slot", async () => {
  const fixture = fixtureProject();
  try {
    const limits = baseLimits();
    const contract = normalizeRunContract({ ...TEST_CONTRACT, continuation: {
      plateauCampaigns: 3, minimumCampaignIntervalMs: 1000, agentStartsPerHour: 1, evaluatorRunsPerHour: 96,
    } });
    const budgetPath = path.join(fixture.projectDir, ".dream-rsi", "loop", "budget.json");
    const budget = readOrCreateLoopBudget(budgetPath, limits);
    const clockStart = Date.now();
    writeLoopBudget(budgetPath, { ...budget, hourly_starts: { agents: [clockStart - 3_599_900], evaluators: [] } });
    let rateClock = clockStart;
    const waits = [];
    const stub = stubCampaign({ agentStarts: 1, evaluatorRuns: 0 });
    const result = await runLoop({ projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits, contract,
      runCampaignImpl: async (options) => {
        assert.equal(typeof options.beforeProcessRateLimit, "function", "campaign receives the shared dispatch limiter");
        await options.beforeProcessRateLimit("agent", "first-attempt");
        return stub.impl(options);
      },
      processRateLimitNow: () => rateClock,
      waitForProcessRateLimitImpl: async (waitMs) => { waits.push(waitMs); rateClock += waitMs; return "ready"; },
    });
    assert.equal(waits.length, 1, "one process start is paced at its actual dispatch hook");
    assert.ok(waits[0] > 0 && waits[0] <= 100, `wait was ${waits[0]}ms`);
    assert.equal(result.campaigns, 1);
    const saved = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
    assert.equal(saved.hourly_starts.agents.length, 1, "pruned history and the newly reserved start persist");
    assert.equal(saved.hourly_starts.agents[0], rateClock);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("parallel campaign dispatches serialize reservations so a burst cannot exceed the hourly cap", async () => {
  const fixture = fixtureProject();
  try {
    const limits = baseLimits();
    const contract = normalizeRunContract({ ...TEST_CONTRACT, continuation: {
      plateauCampaigns: 3, minimumCampaignIntervalMs: 1000, agentStartsPerHour: 1, evaluatorRunsPerHour: 96,
    } });
    const budgetPath = path.join(fixture.projectDir, ".dream-rsi", "loop", "budget.json");
    const budget = readOrCreateLoopBudget(budgetPath, limits);
    writeLoopBudget(budgetPath, { ...budget, hourly_starts: { agents: [], evaluators: [] } });
    let rateClock = Date.now();
    const waits = [];
    const stub = stubCampaign({ agentStarts: 3, evaluatorRuns: 0 });
    const result = await runLoop({ projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits, contract,
      runCampaignImpl: async (options) => {
        await Promise.all(["a", "b", "c"].map((key) => options.beforeProcessRateLimit("agent", key)));
        return stub.impl(options);
      },
      processRateLimitNow: () => rateClock,
      waitForProcessRateLimitImpl: async (waitMs) => { waits.push(waitMs); rateClock += waitMs; return "ready"; },
    });
    assert.equal(result.campaigns, 1);
    assert.equal(waits.length, 2, "only the two excess concurrent starts wait for the next slots");
    const saved = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
    assert.equal(saved.hourly_starts.agents.length, 1, "serialized reservations never exceed the configured rolling cap");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a rate wait that reaches the deadline does not dispatch or become a campaign failure", async () => {
  const fixture = fixtureProject();
  try {
    const limits = baseLimits();
    const contract = normalizeRunContract({ ...TEST_CONTRACT, continuation: {
      plateauCampaigns: 3, minimumCampaignIntervalMs: 1000, agentStartsPerHour: 1, evaluatorRunsPerHour: 96,
    } });
    const budgetPath = path.join(fixture.projectDir, ".dream-rsi", "loop", "budget.json");
    const budget = readOrCreateLoopBudget(budgetPath, limits);
    writeLoopBudget(budgetPath, { ...budget, hourly_starts: { agents: [Date.now()], evaluators: [] } });
    let dispatches = 0;
    const result = await runLoop({ projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits, contract,
      runCampaignImpl: async (options) => {
        await options.beforeProcessRateLimit("agent", "blocked-attempt");
        dispatches += 1;
        return stubCampaign({ agentStarts: 1, evaluatorRuns: 0 }).impl(options);
      },
      waitForProcessRateLimitImpl: async () => "deadline",
    });
    assert.equal(result.stopCode, "deadline");
    assert.equal(dispatches, 0);
    assert.match(result.stopReason, /deadline/);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("an outer deadline is not misclassified as campaign cancellation when a campaign pauses", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign({ stateKind: "paused", stopReason: "stopped by request", agentStarts: 1, evaluatorRuns: 0 });
    const result = await runLoop({
      projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits: baseLimits({ deadlineMs: 2_000 }),
      runCampaignImpl: async (options) => {
        const paused = await stub.impl(options);
        await new Promise((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener("abort", resolve, { once: true });
        });
        return paused;
      },
    });
    assert.equal(stub.calls.length, 1, "the campaign reached its real loop boundary");
    assert.equal(result.stopCode, "deadline", result.stopReason);
    assert.equal(result.stopReason, "deadline");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("cancellation while waiting for a process-rate slot stops without dispatch", async () => {
  const fixture = fixtureProject();
  const controller = new AbortController();
  try {
    const limits = baseLimits();
    const contract = normalizeRunContract({ ...TEST_CONTRACT, continuation: {
      plateauCampaigns: 3, minimumCampaignIntervalMs: 1000, agentStartsPerHour: 1, evaluatorRunsPerHour: 96,
    } });
    const budgetPath = path.join(fixture.projectDir, ".dream-rsi", "loop", "budget.json");
    const budget = readOrCreateLoopBudget(budgetPath, limits);
    writeLoopBudget(budgetPath, { ...budget, hourly_starts: { agents: [Date.now()], evaluators: [] } });
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    let dispatches = 0;
    const resultPromise = runLoop({ projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits, contract, signal: controller.signal,
      runCampaignImpl: async (options) => {
        await options.beforeProcessRateLimit("agent", "cancelled-attempt");
        dispatches += 1;
        return stubCampaign({ agentStarts: 1, evaluatorRuns: 0 }).impl(options);
      },
      waitForProcessRateLimitImpl: async (_waitMs, _deadlineAt, signal) => await new Promise((resolve) => {
        enteredResolve();
        signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
      }),
    });
    await entered;
    controller.abort();
    const result = await resultPromise;
    assert.equal(result.stopCode, "cancelled");
    assert.equal(dispatches, 0);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a campaign deadline aborts its rate wait without cancelling the owning loop", async () => {
  const fixture = fixtureProject();
  try {
    const limits = baseLimits();
    const contract = normalizeRunContract({ ...TEST_CONTRACT, continuation: {
      plateauCampaigns: 3, minimumCampaignIntervalMs: 1000, agentStartsPerHour: 1, evaluatorRunsPerHour: 96,
    } });
    const budgetPath = path.join(fixture.projectDir, ".dream-rsi", "loop", "budget.json");
    const budget = readOrCreateLoopBudget(budgetPath, limits);
    writeLoopBudget(budgetPath, { ...budget, hourly_starts: { agents: [Date.now()], evaluators: [] } });
    let dispatches = 0;
    const result = await runLoop({ projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits, contract,
      runCampaignImpl: async (options) => {
        const campaignSignal = new AbortController();
        setTimeout(() => campaignSignal.abort(), 10);
        await options.beforeProcessRateLimit("agent", "campaign-timeout", campaignSignal.signal);
        dispatches += 1;
        return stubCampaign({ agentStarts: 1, evaluatorRuns: 0 }).impl(options);
      },
      waitForProcessRateLimitImpl: async (_waitMs, _deadlineAt, signal) => await new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
      }),
    });
    assert.notEqual(result.stopCode, "cancelled", "an inner campaign deadline is not operator cancellation of the loop");
    assert.equal(dispatches, 0);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("hourly process reservations persist, enforce independent rolling limits, and expire at one hour", () => {
  const fixture = fixtureProject();
  try {
    const file = path.join(fixture.projectDir, ".dream-rsi", "loop", "budget.json");
    const budget = readOrCreateLoopBudget(file, baseLimits());
    const start = Date.parse("2026-10-16T00:00:00.000Z");
    const agent1 = reserveHourlyProcessStart(budget, "agent", 2, start);
    assert.equal(agent1.waitMs, 0);
    const agent2 = reserveHourlyProcessStart(agent1.budget, "agent", 2, start + 1);
    assert.equal(agent2.waitMs, 0);
    const blocked = reserveHourlyProcessStart(agent2.budget, "agent", 2, start + 2);
    assert.equal(blocked.waitMs, 3_599_998);
    const evaluator = reserveHourlyProcessStart(blocked.budget, "evaluator", 1, start + 2);
    assert.equal(evaluator.waitMs, 0, "agent and evaluator allowances are independent");
    writeLoopBudget(file, evaluator.budget);
    const restored = readOrCreateLoopBudget(file, baseLimits());
    const stillBlocked = reserveHourlyProcessStart(restored, "agent", 2, start + 3);
    assert.ok(stillBlocked.waitMs > 0, "recent process reservations survive restart");
    const expired = reserveHourlyProcessStart(stillBlocked.budget, "agent", 2, start + 3_600_001);
    assert.equal(expired.waitMs, 0, "events exactly one hour old no longer consume a slot");
    const legacy = { ...restored };
    delete legacy.hourly_starts;
    writeLoopBudget(file, legacy);
    assert.deepEqual(readOrCreateLoopBudget(file, baseLimits()).hourly_starts, { agents: [], evaluators: [] }, "legacy loop budgets migrate without resetting other spend");
    fs.writeFileSync(file, JSON.stringify({ ...legacy, hourly_starts: { agents: ["corrupt"], evaluators: [] } }));
    assert.throws(() => readOrCreateLoopBudget(file, baseLimits()), /hourly process history is invalid/);
    const maximumHistory = Array.from({ length: 10_000 }, (_, index) => start + index);
    fs.writeFileSync(file, JSON.stringify({ ...legacy, hourly_starts: { agents: maximumHistory, evaluators: [] } }));
    assert.equal(readOrCreateLoopBudget(file, baseLimits()).hourly_starts.agents.length, 10_000, "history matches the contract's maximum 10,000/hour cap");
    maximumHistory.push(start + 10_000);
    fs.writeFileSync(file, JSON.stringify({ ...legacy, hourly_starts: { agents: maximumHistory, evaluators: [] } }));
    assert.throws(() => readOrCreateLoopBudget(file, baseLimits()), /hourly process history is invalid/, "history remains bounded beyond the supported cap");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("continuous campaign starts honor a persisted minimum interval", async () => {
  const fixture = fixtureProject();
  try {
    const limits = baseLimits({ maxCampaigns: 1 });
    const contract = normalizeRunContract({ ...TEST_CONTRACT, continuation: { plateauCampaigns: 3, minimumCampaignIntervalMs: 1000 } });
    const loopRoot = path.join(fixture.projectDir, ".dream-rsi", "loop");
    fs.mkdirSync(loopRoot, { recursive: true });
    const budgetPath = path.join(loopRoot, "budget.json");
    const budget = readOrCreateLoopBudget(budgetPath, limits);
    writeLoopBudget(budgetPath, { ...budget, last_campaign_started_at: new Date(Date.now() + 350).toISOString() });
    const stub = stubCampaign();
    const startedAt = Date.now();
    const result = await runLoop({ projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits,
      contract, runCampaignImpl: stub.impl, now: () => NOW });
    assert.equal(stub.calls.length, 1);
    assert.ok(Date.now() - startedAt >= 300, "the campaign cannot start before the persisted interval elapses");
    assert.equal(result.campaigns, 1);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a pacing wait that wakes after the deadline does not reserve or start a campaign", async () => {
  const fixture = fixtureProject();
  try {
    const limits = baseLimits({ maxCampaigns: 1 });
    const contract = normalizeRunContract({ ...TEST_CONTRACT, continuation: { plateauCampaigns: 3, minimumCampaignIntervalMs: 1000 } });
    const loopRoot = path.join(fixture.projectDir, ".dream-rsi", "loop");
    fs.mkdirSync(loopRoot, { recursive: true });
    const budgetPath = path.join(loopRoot, "budget.json");
    const budget = readOrCreateLoopBudget(budgetPath, limits);
    writeLoopBudget(budgetPath, { ...budget, last_campaign_started_at: new Date(Date.now() + 10_000).toISOString() });
    const stub = stubCampaign();
    const result = await runLoop({ projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits,
      contract, runCampaignImpl: stub.impl, now: () => NOW,
      waitForCampaignIntervalImpl: (waitMs, deadlineAt, signal) => {
        let fakeNow = Date.now();
        return waitForCampaignInterval(waitMs, deadlineAt, signal, () => fakeNow, async () => { fakeNow = deadlineAt + 1; });
      },
    });
    assert.equal(result.stopCode, "deadline");
    assert.equal(stub.calls.length, 0, "deadline after the timer wake prevents dispatch");
    const saved = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
    assert.equal(saved.campaigns, 0);
    assert.equal(saved.open_campaign, null, "no spend reservation is written after the deadline");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a pending confirmation retains loop context and reports a resumable stop", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign({ stateKind: "paused", stopReason: "confirmation pending", pendingConfirmation: true });
    fs.mkdirSync(path.join(fixture.projectDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixture.projectDir, "src", "parser.ts"), "export const parserSentinel = 100;\\n");
    fs.mkdirSync(path.join(fixture.projectDir, "eval"), { recursive: true });
    fs.writeFileSync(path.join(fixture.projectDir, "eval", "score.mjs"), `import * as fs from "node:fs";\nconst valid = fs.readFileSync("src/parser.ts", "utf8").includes("parserSentinel");\nfs.mkdirSync("eval", { recursive: true });\nfs.writeFileSync("eval/score.json", JSON.stringify({ score: 10, valid, fail_class: valid ? "ok" : "inert", error: valid ? null : "editable source is inert" }));\n`);
    fs.writeFileSync(path.join(fixture.projectDir, "eval", "gate.mjs"), `import * as fs from "node:fs";\nprocess.exit(fs.readFileSync("src/parser.ts", "utf8").includes("parserSentinel") ? 0 : 1);\n`);
    const contract = normalizeRunContract({
      ...TEST_CONTRACT,
      outcome: { ...TEST_CONTRACT.outcome, evaluator: { argv: ["node", "eval/score.mjs"], output: "score-json", inputs: ["eval/score.mjs"] } },
      preserved: { gates: ["node eval/gate.mjs"] },
      scope: { roots: ["src"], protectedAssets: ["eval/score.mjs", "eval/gate.mjs"] },
      continuation: { plateauCampaigns: 1, minimumCampaignIntervalMs: 1000 },
    });
    const result = await runLoopCore({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      contract,
      collectSignalsImpl: async () => ({ weaknesses: [], diagnostics: [] }),
      reconProjectImpl: async () => ({
        commands: [], probes: [], graph: ["src/parser.ts"],
        graphs: { "contract.outcome.evaluator": ["src/parser.ts"] },
        files: [{ path: "src/parser.ts", bytes: 31, lines: 1 }], notes: [], blockers: [],
      }),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });

    assert.equal(result.stopCode, "confirmation-pending", result.stopReason);
    assert.equal(stub.calls.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(result.budgetPath, "utf8")).consecutive_no_win_campaigns, 0,
      "a campaign awaiting confirmation does not count toward the completed no-win plateau");
    const contextPath = path.join(fixture.projectDir, ".dream-rsi", "loop", "active.json");
    const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
    assert.equal(context.version, 1);
    assert.ok(context.lever.id, "the frozen lever remains available for confirmation resume");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("an outer loop deadline remains the stop reason when a resumed campaign pauses", async () => {
  const fixture = fixtureProject();
  try {
    const contract = normalizeRunContract({
      ...TEST_CONTRACT,
      outcome: { ...TEST_CONTRACT.outcome, statement: "Resume a bounded confirmation", evaluator: { argv: ["python", "--config=eval/score.mjs"], output: "score-json", inputs: ["eval/score.mjs"] } },
      preserved: { gates: ["node eval/gate.mjs"] },
      scope: { roots: ["src"], protectedAssets: ["eval/score.mjs", "eval/gate.mjs"] },
    });
    const artifacts = pendingConfirmationArtifacts(fixture.projectDir, contract);
    let resumed = false;
    const result = await runLoopCore({
      projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits: baseLimits({ deadlineMs: 500 }), contract,
      resumeActiveCampaign: true, confirmationOnly: true, now: () => NOW,
      resumeCampaignImpl: async (options) => {
        resumed = true;
        await new Promise((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener("abort", resolve, { once: true });
        });
        return { ...readCampaignStatus(options.baseRoot), stopped: true, state: { kind: "paused", phase: "promote", iteration: 1, reason: "stopped by request" }, stopReason: "stopped by request" };
      },
    });
    assert.equal(resumed, true, "the saved campaign entered its real resume boundary");
    assert.equal(result.stopCode, "deadline", result.stopReason);
    assert.equal(result.stopReason, "deadline");
    assert.ok(fs.existsSync(path.join(artifacts.loopRoot, "active.json")), "the paused campaign retains its recovery context");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("confirmation-only resume reconstructs missing context from validated campaign evidence", async () => {
  const fixture = fixtureProject();
  try {
    const contract = normalizeRunContract({
      ...TEST_CONTRACT,
      outcome: { ...TEST_CONTRACT.outcome, statement: "Recover the saved score confirmation", evaluator: { argv: ["python", "--config=eval/score.mjs"], output: "score-json", inputs: ["eval/score.mjs"] } },
      preserved: { gates: ["node eval/gate.mjs"] },
      scope: { roots: ["src"], protectedAssets: ["eval/score.mjs", "eval/gate.mjs"] },
    });
    const artifacts = pendingConfirmationArtifacts(fixture.projectDir, contract);
    const calls = [];
    const result = await runLoopCore({
      projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits: baseLimits(), contract,
      resumeActiveCampaign: true, confirmationOnly: true, now: () => NOW,
      resumeCampaignImpl: async (options) => {
        calls.push(options);
        const active = JSON.parse(fs.readFileSync(path.join(artifacts.loopRoot, "active.json"), "utf8"));
        assert.equal(active.campaignId, "a0000000-0000-4000-8000-000000000001", "the validated context is durable before resume starts");
        assert.equal(active.instrument.timeoutMs, 600000);
        assert.deepEqual(active.instrument.baseline, [10, 9, 11], "recovery restores the pre-campaign qualification baseline, not later readings");
        return { ...readCampaignStatus(options.baseRoot), stopped: true, stopReason: "confirmation pending" };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].confirmationOnly, true);
    assert.ok(calls[0].extendLimits.deadlineMs > 0, "the expired inner deadline is extended only from the remaining loop allowance");
    assert.equal(result.stopCode, "confirmation-pending", result.stopReason);
    assert.match(result.stopReason, /confirmation pending/);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a resumed confirmation commits only after its independent post-apply check", async () => {
  const fixture = fixtureProject();
  try {
    const contract = normalizeRunContract({
      ...TEST_CONTRACT,
      outcome: { statement: "Increase the parser score", unit: "points", higherIsBetter: true, minimumUsefulGain: 0.5,
        evaluator: { argv: ["node", "eval/score.mjs"], output: "score-json", inputs: ["eval/score.mjs"] } },
      preserved: { gates: ["node eval/gate.mjs"] },
      scope: { roots: ["src"], protectedAssets: ["eval/score.mjs", "eval/gate.mjs"] },
      git: { autoCommit: true, branch: "dream-rsi/improve" },
      continuation: { plateauCampaigns: 1, minimumCampaignIntervalMs: 1000 },
    });
    const artifacts = pendingConfirmationArtifacts(fixture.projectDir, contract, { autoCommitFixture: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fixture.projectDir });
    execFileSync("git", ["config", "user.name", "Dream RSI Test"], { cwd: fixture.projectDir });
    execFileSync("git", ["config", "user.email", "dream-rsi-test@example.invalid"], { cwd: fixture.projectDir });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: fixture.projectDir });
    execFileSync("git", ["add", "package.json", "src", "eval"], { cwd: fixture.projectDir });
    execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: fixture.projectDir });
    const loopBudgetPath = path.join(artifacts.loopRoot, "budget.json");
    const loopBudget = readOrCreateLoopBudget(loopBudgetPath, baseLimits());
    writeLoopBudget(loopBudgetPath, { ...loopBudget, consecutive_no_win_campaigns: 1 });

    const result = await runLoopCore({
      projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits: baseLimits(), contract,
      resumeActiveCampaign: true, confirmationOnly: true, now: () => NOW,
      resumeCampaignImpl: async (options) => {
        const recordPath = path.join(artifacts.campaignRoot, "campaign.json");
        const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        const effectiveAgent = { command: "pi-bolt", model: "openai/gpt-6.1-sol", modelSource: "saved" };
        options.onUpdate({ id: record.id, state: { kind: "running", phase: "confirm" }, effectiveAgent });
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(artifacts.loopRoot, "status.json"), "utf8")).effectiveAgent, effectiveAgent,
          "live confirmation status records the actual child agent");
        const transactionId = "resume-verified-apply";
        applyCandidatePatch({ seedRoot: record.targetRoot, patch: record.pendingConfirmation.patch,
          journalDir: path.join(artifacts.campaignRoot, "promotion-journal"), transactionId });
        appendLedgerRecord(path.join(artifacts.campaignRoot, "history", "ledger.jsonl"), {
          kind: "apply", campaignId: record.id, stage: "apply", outcome: "success",
          patchHash: record.pendingConfirmation.patchHash, facts: { transactionId },
        });
        const status = readCampaignStatus(options.baseRoot);
        return { ...status, state: { kind: "complete" }, pendingConfirmation: undefined, stopped: false, stopReason: "confirmation complete" };
      },
    });

    assert.equal(result.stopCode, "confirmation-complete", result.stopReason);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(artifacts.loopRoot, "status.json"), "utf8")).effectiveAgent,
      { command: "pi-bolt", model: "openai/gpt-6.1-sol", modelSource: "saved" }, "terminal confirmation status retains the actual child agent");
    assert.equal(JSON.parse(fs.readFileSync(loopBudgetPath, "utf8")).consecutive_no_win_campaigns, 0,
      "saved confirmation recovery runs despite a reached plateau and a verified win clears the streak");
    assert.equal(result.autoCommits.length, 1, "the resumed verified win produces one local receipt");
    assert.equal(result.autoCommits[0].branch, "dream-rsi/improve");
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: fixture.projectDir, encoding: "utf8" }).trim(), "dream-rsi/improve");
    assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: fixture.projectDir, encoding: "utf8" }).trim(), execFileSync("git", ["rev-parse", `${result.autoCommits[0].hash}^`], { cwd: fixture.projectDir, encoding: "utf8" }).trim());
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("confirmation recovery refuses an evaluator changed since campaign start without resuming", async () => {
  const fixture = fixtureProject();
  try {
    const contract = normalizeRunContract({
      ...TEST_CONTRACT,
      outcome: { ...TEST_CONTRACT.outcome, statement: "Recover the saved score confirmation", evaluator: { argv: ["node", "eval/score.mjs"], output: "score-json" } },
      preserved: { gates: ["node eval/gate.mjs"] },
      scope: { roots: ["src"], protectedAssets: ["eval/score.mjs", "eval/gate.mjs"] },
    });
    const artifacts = pendingConfirmationArtifacts(fixture.projectDir, contract);
    fs.appendFileSync(artifacts.sourcePath, "// changed after campaign start\n");
    let resumes = 0;
    const result = await runLoopCore({
      projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits: baseLimits(), contract,
      resumeActiveCampaign: true, confirmationOnly: true, now: () => NOW,
      resumeCampaignImpl: async () => { resumes += 1; throw new Error("must not resume"); },
    });

    assert.equal(resumes, 0);
    assert.match(result.stopReason, /measurement input changed/);
    assert.equal(fs.existsSync(path.join(artifacts.loopRoot, "active.json")), false, "refused recovery does not persist reconstructed context");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("confirmation recovery refuses malformed saved score pairs before resume", async () => {
  const fixture = fixtureProject();
  try {
    const contract = normalizeRunContract({
      ...TEST_CONTRACT,
      outcome: { ...TEST_CONTRACT.outcome, statement: "Recover the saved score confirmation", evaluator: { argv: ["node", "eval/score.mjs"], output: "score-json" } },
      preserved: { gates: ["node eval/gate.mjs"] },
      scope: { roots: ["src"], protectedAssets: ["eval/score.mjs", "eval/gate.mjs"] },
    });
    const artifacts = pendingConfirmationArtifacts(fixture.projectDir, contract);
    const evidence = JSON.parse(fs.readFileSync(artifacts.evidencePath, "utf8"));
    delete evidence.pairs[0].beforeOutcome;
    fs.writeFileSync(artifacts.evidencePath, JSON.stringify(evidence));
    let resumes = 0;
    const result = await runLoopCore({
      projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits: baseLimits(), contract,
      resumeActiveCampaign: true, confirmationOnly: true, now: () => NOW,
      resumeCampaignImpl: async () => { resumes += 1; throw new Error("must not resume"); },
    });

    assert.equal(resumes, 0);
    assert.match(result.stopReason, /saved paired measurements do not match/);
    assert.equal(fs.existsSync(path.join(artifacts.loopRoot, "active.json")), false);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("confirmation recovery checks a direct evaluator executable changed after campaign start", async () => {
  const fixture = fixtureProject();
  try {
    const contract = normalizeRunContract({
      ...TEST_CONTRACT,
      outcome: { ...TEST_CONTRACT.outcome, statement: "Recover the saved score confirmation", evaluator: { argv: ["eval/score.mjs"], output: "score-json" } },
      preserved: { gates: ["node eval/gate.mjs"] },
      scope: { roots: ["src"], protectedAssets: ["eval/score.mjs", "eval/gate.mjs"] },
    });
    const artifacts = pendingConfirmationArtifacts(fixture.projectDir, contract);
    fs.appendFileSync(artifacts.sourcePath, "// changed after campaign start\n");
    let resumes = 0;
    const result = await runLoopCore({
      projectDir: fixture.projectDir, sessionDir: fixture.sessionDir, limits: baseLimits(), contract,
      resumeActiveCampaign: true, confirmationOnly: true, now: () => NOW,
      resumeCampaignImpl: async () => { resumes += 1; throw new Error("must not resume"); },
    });

    assert.equal(resumes, 0);
    assert.match(result.stopReason, /measurement input changed/);
    assert.equal(fs.existsSync(path.join(artifacts.loopRoot, "active.json")), false);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("dream adopts a replay winner, charges its agent, and the next campaign snapshots the config", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign();
    const loopRoot = path.join(fixture.projectDir, ".dream-rsi", "loop");
    const agentPath = path.join(fixture.projectDir, "dream-agent.mjs");
    const adopted = { ...defaultSearchConfig, batchSize: 3, exploreShare: 1, maxRounds: 1 };
    fs.writeFileSync(agentPath, `import { writeFileSync } from "node:fs";\nlet prompt = ""; process.stdin.on("data", chunk => prompt += chunk);\nprocess.stdin.on("end", () => { const match = prompt.match(/Incumbent: (\\{[^\\n]+\\})/); const incumbent = JSON.parse(match[1]); writeFileSync("configs.json", JSON.stringify({ configs: [{ ...incumbent, batchSize: 3, exploreShare: 1, maxRounds: 1 }] })); });\n`);
    const worldFor = (id, cycle) => ({
      version: 1, worldId: id, cycle, status: "complete", fingerprint: `fingerprint-${id}`,
      config: defaultSearchConfig, baseline: 1, threshold: 0.1, rounds: 1, agentStarts: 3, evaluatorRuns: 3, stopped: "round limit",
      nodes: [1.1, 1.2, 1.3, 1.3].map((score, index) => ({ id: `n${index + 1}`, parent: null, kind: "branch", round: 1,
        seq: index + 1, stage: "done", score, valid: true, failClass: "ok", timedOut: false, cost: 1, retries: 1 })),
    });
    for (const [id, cycle] of [["prior-1", 1], ["prior-2", 2]]) {
      const priorWorldRoot = path.join(fixture.projectDir, ".dream-rsi", "campaigns", id, "cycles", `c${String(cycle).padStart(4, "0")}`);
      fs.mkdirSync(priorWorldRoot, { recursive: true });
      fs.writeFileSync(path.join(priorWorldRoot, "world.json"), JSON.stringify(worldFor(id, cycle)));
    }
    const impl = async (options) => {
      const result = await stub.impl(options);
      if (stub.calls.length === 1) {
        const cycleRoot = path.join(result.campaignRoot, "cycles", "c0001");
        fs.mkdirSync(cycleRoot, { recursive: true });
        fs.writeFileSync(path.join(cycleRoot, "world.json"), JSON.stringify(worldFor(result.id, 3)));
      }
      return result;
    };
    const result = await runLoop({ projectDir: fixture.projectDir, sessionDir: fixture.sessionDir,
      limits: baseLimits({ maxCampaigns: 2 }), runCampaignImpl: impl, now: () => NOW,
      taskProvider: ({ lever }) => ({
        task: { ...defaultTask(lever.id), eval_program: lever.scopeFiles[0] ?? ".", agent: {
          command: process.execPath, args: [agentPath], model: null, thinking: null, prompt_via: "stdin",
        } },
        verifierInputs: [], gates: [],
      }),
    });
    assert.equal(result.campaigns, 2);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(stub.calls[0].searchConfig, defaultSearchConfig, "the first campaign uses the engine default");
    assert.deepEqual(stub.calls[1].searchConfig, adopted, `the next campaign receives the config chosen from completed-world replay: ${JSON.stringify({ notes: result.memory.notes, phases: JSON.parse(fs.readFileSync(result.budgetPath, "utf8")).phases, dreams: fs.existsSync(path.join(loopRoot, "dreams.jsonl")) ? fs.readFileSync(path.join(loopRoot, "dreams.jsonl"), "utf8") : null })}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(loopRoot, "search-config.json"), "utf8")), adopted);
    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.deepEqual(budget.phases.dream, { agent_starts: 1, evaluator_runs: 0, campaigns: 0 }, "the dream agent is charged before spawn");
    const liveStatus = JSON.parse(fs.readFileSync(path.join(loopRoot, "status.json"), "utf8"));
    assert.deepEqual(liveStatus.effectiveAgent, { command: process.execPath, model: null, modelSource: "child-default" },
      "the latest child-agent command and default model remain observable after the dream step");
    assert.equal(fs.readFileSync(path.join(loopRoot, "dreams.jsonl"), "utf8").trim().split(/\r?\n/).length, 1,
      "the actual replay decision is durably recorded");
    const lastRun = fs.readFileSync(path.join(loopRoot, "last-run.md"), "utf8");
    assert.match(lastRun, /## Attempt timeline[\s\S]*no-win · lever/);
    assert.match(lastRun, /## Dream decisions[\s\S]*adopted search config/);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("loop stops when recon finds no eligible workload without starting a campaign", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-loop-empty-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "empty", scripts: { test: "node -e 0" } }));
    const stub = stubCampaign();
    const result = await runLoop({
      projectDir: dir,
      limits: baseLimits(),
      reconProjectImpl: async () => ({ commands: [], probes: [], graph: [], graphs: {}, files: [], notes: [], blockers: ["no workloads"] }),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(result.stopCode, "blocked");
    assert.match(result.stopReason, /no executable workload/i);
    assert.match(result.stopReason, /Next step:/);
    assert.equal(stub.calls.length, 0);
    assert.equal(result.campaigns, 0);
    assert.deepEqual(result.records, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("loop budget is durable across runs and its limits are immutable", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign({ outcome: "no-win", agentStarts: 5, evaluatorRuns: 9 });
    const options = {
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits({ maxCampaigns: 3, maxAgentStarts: 5 }),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    };
    const first = await runLoop(options);
    assert.equal(first.stopReason, "budget");
    assert.equal(stub.calls.length, 1);

    const second = await runLoop(options);
    assert.equal(second.stopReason, "budget", "the exhausted durable budget stops a fresh run before any work");
    assert.equal(stub.calls.length, 1, "no second campaign was started");

    await assert.rejects(
      runLoop({ ...options, limits: baseLimits({ maxCampaigns: 3, maxAgentStarts: 6 }) }),
      /immutable/,
    );
    const status = JSON.parse(fs.readFileSync(path.join(path.dirname(first.budgetPath), "status.json"), "utf8"));
    assert.equal(status.state, "failed");
    assert.equal(status.stopCode, "failed");
    assert.match(status.stopReason, /immutable/);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a campaign-engine failure stops the loop and charges the reserved grant", async () => {
  const fixture = fixtureProject();
  try {
    const impl = async () => { throw new Error("an unfinished campaign already exists; resume or stop it before starting another"); };
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits({ maxCampaigns: 2 }),
      runCampaignImpl: impl,
      now: () => NOW,
    });
    assert.equal(result.stopReason, "campaign failed: an unfinished campaign already exists; resume or stop it before starting another");
    const errorRecord = result.records.find((record) => record.outcome === "error");
    assert.ok(errorRecord, "the failed attempt is recorded as an error outcome");
    assert.equal(errorRecord.campaignRoot, null);
    assert.equal(result.campaigns, 1, "a throw counts as a started campaign even without a campaign root");
    assert.equal(errorRecord.agentStarts, 18, "the reserved grant is recorded when the real spend is unknown");
    assert.equal(errorRecord.evaluatorRuns, 48, "the campaign record reports its reserved evaluator grant");
    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.equal(budget.agent_starts, 18, "a thrown campaign spends its reserved grant, never less");
    assert.equal(budget.evaluator_runs, 51);
    assert.equal(budget.campaigns, 1);
    assert.equal(budget.open_campaign, null, "the reservation is reconciled, not left open");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a leftover campaign reservation is reconciled as fully spent on the next run", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign();
    const limits = baseLimits();
    const first = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits,
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(first.stopReason, "budget");
    const spent = JSON.parse(fs.readFileSync(first.budgetPath, "utf8"));
    assert.equal(spent.open_campaign, null);
    // Simulate a process death mid-campaign: the reservation is written, the spend is not.
    fs.writeFileSync(first.budgetPath, JSON.stringify({ ...spent, open_campaign: { agent_starts: 7, evaluator_runs: 11, at: NOW.toISOString() } }));
    const second = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits,
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.ok(second.memory.notes.some((note) => /reconciled an interrupted campaign/.test(note)));
    const reconciled = JSON.parse(fs.readFileSync(first.budgetPath, "utf8"));
    assert.equal(reconciled.campaigns, spent.campaigns + 1, "the interrupted campaign counts as spent");
    assert.equal(reconciled.agent_starts, spent.agent_starts + 7);
    assert.equal(reconciled.evaluator_runs, spent.evaluator_runs + 11);
    assert.equal(reconciled.open_campaign, null);
    assert.equal(second.stopReason, "budget", "the reconciled spend exhausts the remaining allowance");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a live lease and a stale heartbeat from a live process block; a dead owner's stale lease is taken over", async () => {
  const fixture = fixtureProject();
  try {
    const loopRoot = path.join(fixture.projectDir, ".dream-rsi", "loop");
    fs.mkdirSync(loopRoot, { recursive: true });
    const leasePath = path.join(loopRoot, "lease.json");
    fs.writeFileSync(leasePath, JSON.stringify({ pid: 999_999, host: os.hostname(), startedAt: NOW.toISOString(), heartbeatAt: NOW.toISOString() }));
    const stub = stubCampaign();
    const options = {
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    };
    const blocked = await runLoop(options);
    assert.equal(blocked.stopReason, "blocked");
    assert.equal(stub.calls.length, 0, "no campaign runs under a live foreign lease");
    assert.ok(blocked.memory.notes.some((note) => /another loop \(pid 999999\)/.test(note)));

    const stale = new Date(NOW.getTime() - 46 * 60 * 1000).toISOString();
    fs.writeFileSync(leasePath, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: stale, heartbeatAt: stale }));
    const activeStale = await runLoop(options);
    assert.equal(activeStale.stopReason, "blocked", "a stale heartbeat cannot evict a process that is still alive");
    assert.equal(stub.calls.length, 0);

    fs.writeFileSync(leasePath, JSON.stringify({ pid: 999_999, host: "another-host", startedAt: stale, heartbeatAt: stale }));
    const foreignStale = await runLoop(options);
    assert.equal(foreignStale.stopReason, "blocked", "a lease on another host cannot be proven dead locally");
    assert.equal(stub.calls.length, 0);

    fs.writeFileSync(leasePath, JSON.stringify({ pid: 999_999, host: os.hostname(), startedAt: stale, heartbeatAt: stale }));
    const taken = await runLoop(options);
    assert.equal(taken.stopReason, "budget", "a same-host stale lease with a dead owner is taken over");
    assert.equal(stub.calls.length, 1);
    assert.ok(taken.memory.notes.some((note) => /took over a stale loop lease/.test(note)));
    assert.equal(fs.existsSync(leasePath), false, "the lease is released when the loop exits");

    fs.writeFileSync(leasePath, JSON.stringify({ pid: 999_999, host: os.hostname(), startedAt: stale, heartbeatAt: stale }));
    const recoveryPath = `${leasePath}.recovery`;
    fs.writeFileSync(recoveryPath, JSON.stringify({ pid: 999_999, host: os.hostname(), startedAt: stale, heartbeatAt: stale }));
    const memoryBefore = fs.readFileSync(taken.memoryPath, "utf8");
    const recoveryBlocked = await runLoop(options);
    assert.equal(recoveryBlocked.stopReason, "blocked", "a recovery claim left on disk blocks another stale takeover");
    assert.ok(recoveryBlocked.memory.notes.some((note) => /recovery/.test(note)));
    assert.equal(stub.calls.length, 1, "a stale recovery claim starts no campaign");
    assert.equal(fs.readFileSync(taken.memoryPath, "utf8"), memoryBefore, "the blocked recovery leaves durable memory unchanged");
    assert.ok(fs.existsSync(recoveryPath), "the recovery claim is not stolen or removed automatically");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a half-published lease is waited out, and an old unreadable lease fails closed", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign();
    const options = {
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    };
    const leasePath = path.join(fixture.projectDir, ".dream-rsi", "loop", "lease.json");
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    // A contender that catches another loop mid-publication must not take the lease over.
    fs.writeFileSync(leasePath, "");
    const publishing = await runLoop(options);
    assert.equal(publishing.stopReason, "blocked", "an unreadable fresh lease is a publication in progress");
    assert.ok(publishing.memory.notes.some((note) => /publishing its lease file/.test(note)));
    assert.equal(stub.calls.length, 0, "no campaign runs while the lease is being published");
    assert.ok(fs.existsSync(leasePath), "the publication in progress is left alone");
    // Age alone cannot prove that an exclusive-create publisher is dead. Keep an old unreadable
    // lease and require an operator to inspect it instead of deleting a possibly active owner's file.
    const old = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(leasePath, old, old);
    const unreadableOld = await runLoop(options);
    assert.equal(unreadableOld.stopReason, "blocked", "an unreadable lease without owner evidence is not taken over");
    assert.ok(unreadableOld.memory.notes.some((note) => /owner cannot be verified/.test(note)));
    assert.equal(stub.calls.length, 0);
    assert.ok(fs.existsSync(leasePath), "the unverifiable lease is preserved for inspection");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a blocked loop never reconciles or rewrites the owner's budget", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign();
    const options = {
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    };
    const first = await runLoop(options);
    const budget = JSON.parse(fs.readFileSync(first.budgetPath, "utf8"));
    budget.open_campaign = { agent_starts: 7, evaluator_runs: 11, at: NOW.toISOString() };
    fs.writeFileSync(first.budgetPath, `${JSON.stringify(budget, null, 2)}\n`);
    const reserved = fs.readFileSync(first.budgetPath, "utf8");
    const memoryPath = path.join(fixture.projectDir, ".dream-rsi", "loop", "memory.json");
    const memoryBefore = fs.readFileSync(memoryPath, "utf8");
    const statusPath = path.join(fixture.projectDir, ".dream-rsi", "loop", "status.json");
    const statusBefore = fs.readFileSync(statusPath, "utf8");
    fs.writeFileSync(path.join(fixture.projectDir, ".dream-rsi", "loop", "lease.json"),
      JSON.stringify({ pid: 999_999, host: os.hostname(), startedAt: NOW.toISOString(), heartbeatAt: NOW.toISOString() }));
    const blocked = await runLoop(options);
    assert.equal(blocked.stopReason, "blocked");
    assert.equal(blocked.campaigns, 0, "a blocked invocation starts nothing");
    assert.equal(fs.readFileSync(first.budgetPath, "utf8"), reserved,
      "the owner's budget, including its open reservation, is untouched by the blocked invocation");
    assert.equal(fs.readFileSync(memoryPath, "utf8"), memoryBefore,
      "the blocked invocation does not rewrite the owner's memory");
    assert.equal(fs.readFileSync(statusPath, "utf8"), statusBefore,
      "the blocked invocation does not overwrite the last status owned by the lease holder");
    assert.ok(blocked.memory.notes.some((note) => /another loop \(pid 999999\)/.test(note)),
      "the blocked note is still reported in the returned state");
    assert.equal(stub.calls.length, 1, "only the first run started a campaign");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a loop that loses lease ownership cannot publish live or terminal status", async () => {
  const fixture = fixtureProject();
  try {
    let enterCampaign = () => {};
    let releaseCampaign = () => {};
    const entered = new Promise((resolve) => { enterCampaign = resolve; });
    const gate = new Promise((resolve) => { releaseCampaign = resolve; });
    const options = {
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      now: () => NOW,
    };
    const first = runLoop({ ...options, runCampaignImpl: async (campaignOptions) => {
      enterCampaign();
      await gate;
      campaignOptions.onUpdate({ id: "old-owner", state: { kind: "running", phase: "candidate" } });
      return stubCampaign().impl(campaignOptions);
    } });
    await entered;
    const loopRoot = path.join(fixture.projectDir, ".dream-rsi", "loop");
    const leasePath = path.join(loopRoot, "lease.json");
    const replacementLease = { pid: 999_999, host: os.hostname(), startedAt: "2030-01-01T00:00:00.000Z", heartbeatAt: NOW.toISOString() };
    fs.writeFileSync(leasePath, `${JSON.stringify(replacementLease, null, 2)}\n`);
    const statusPath = path.join(loopRoot, "status.json");
    const replacementStatus = `${JSON.stringify({ version: 1, state: "running", phase: "replacement-owner" }, null, 2)}\n`;
    fs.writeFileSync(statusPath, replacementStatus);
    releaseCampaign();
    const result = await first;
    assert.equal(result.campaigns, 1);
    assert.equal(fs.readFileSync(statusPath, "utf8"), replacementStatus, "the displaced loop cannot overwrite its new owner's status");
    assert.deepEqual(JSON.parse(fs.readFileSync(leasePath, "utf8")), replacementLease, "the displaced loop cannot remove its new owner's lease");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a second loop cannot claim the lease while the first still holds it", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign();
    let enterCampaign = () => {};
    let releaseCampaign = () => {};
    const entered = new Promise((resolve) => { enterCampaign = resolve; });
    const gate = new Promise((resolve) => { releaseCampaign = resolve; });
    const options = {
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      now: () => NOW,
    };
    const first = runLoop({ ...options, runCampaignImpl: async (campaignOptions) => { enterCampaign(); await gate; return stub.impl(campaignOptions); } });
    await entered;
    const second = await runLoop({ ...options, runCampaignImpl: stub.impl });
    assert.equal(second.stopReason, "blocked", "the overlapping second loop loses the exclusive lease claim");
    assert.equal(stub.calls.length, 0, "the second loop started no campaign while the first held the lease");
    assert.ok(second.memory.notes.some((note) => /another loop \(pid/.test(note)));
    releaseCampaign();
    const firstResult = await first;
    assert.equal(firstResult.campaigns, 1, "the first loop completed its campaign");
    assert.equal(stub.calls.length, 1);
    assert.equal(fs.existsSync(path.join(fixture.projectDir, ".dream-rsi", "loop", "lease.json")), false, "the lease is released after the first loop exits");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

const LOOP_URL = new URL("../extensions/pi-dream-rsi/engine/loop.ts", import.meta.url).href;

/**
 * Contender process for the cross-process lease tests. Modes:
 * - "race": wait for the go file, then run one loop whose campaign holds the lease for
 *   config.holdMs and reports markers and a result file.
 * - "nohardlink": patch linkSync through the CJS cache before any ESM import of node:fs, so the
 *   engine's namespace snapshots the mock; then race a gated first loop against a second one.
 * The patch must precede the engine import, and the engine's `import * as fs` namespace is a
 * snapshot of the CJS exports, so this order is what makes the mock visible to the real code.
 */
const CHILD_RECON_SETUP = `const contract = ${JSON.stringify(TEST_CONTRACT)};
const commandSpecs = [
  { label: "npm test", category: "test", entry: "src/parser.ts", ok: false, exitCode: 1, durationMs: 500 },
  { label: "npm run bench", category: "benchmark", entry: "src/lexer.ts", ok: true, exitCode: 0, durationMs: 1200 },
  { label: "node bench-extra.mjs", category: "custom", entry: "src/extra.ts", ok: true, exitCode: 0, durationMs: 800 },
];
const reconProjectImpl = async (options) => {
  const selected = commandSpecs.slice(0, Math.max(1, options.maxProbes ?? 3));
  for (const command of selected) await options.beforeProbe?.(command);
  return {
    commands: selected.map(({ ok, exitCode, durationMs, ...command }) => ({ ...command,
      argv: command.label.split(" "), declaredArgv: command.label.split(" "), source: "fixture:" + command.label, shim: false })),
    probes: selected.map(({ label, ok, exitCode, durationMs }) => ({ label, ok, durationMs, timedOut: false,
      error: ok ? null : "test failures", exitCode, spawnFailed: false })),
    graph: selected.map((command) => command.entry),
    graphs: Object.fromEntries(selected.map((command) => [command.label, [command.entry]])),
    files: selected.map((command) => ({ path: command.entry, bytes: 20, lines: 1 })), notes: [], blockers: [],
  };
};
const taskProvider = ({ lever }) => ({ task: { name: "lease fixture", workspace: ".", eval_program: lever.scopeFiles[0] ?? ".",
  score_program: "node -e 0", score_path: "eval/score.json", higher_is_better: false }, verifierInputs: [], gates: [] });
`;

const CHILD_SCRIPT = `import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const config = JSON.parse(require_("node:fs").readFileSync(process.argv[2], "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let linkCalls = 0;
if (config.mode === "nohardlink" || config.mode === "fallback-race") {
  const cjsFs = require_("node:fs");
  cjsFs.linkSync = () => {
    linkCalls += 1;
    throw Object.assign(new Error("hard links are not supported here"), { code: "EPERM" });
  };
  if (config.mode === "fallback-race") {
    const realExists = cjsFs.existsSync;
    const realWrite = cjsFs.writeFileSync;
    const path_ = require_("node:path");
    cjsFs.existsSync = (target) => {
      const exists = realExists(target);
      if (path_.resolve(target) === path_.resolve(config.leasePath) && !exists) {
        realWrite(path_.join(config.readyDir, "ready-" + process.pid), "ready");
        while (!realExists(config.releaseFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        return false;
      }
      return exists;
    };
  }
}
if (config.mode === "stale-reaper-a") {
  const cjsFs = require_("node:fs");
  const path_ = require_("node:path");
  const realRemove = cjsFs.rmSync;
  const realWrite = cjsFs.writeFileSync;
  const realExists = cjsFs.existsSync;
  let paused = false;
  cjsFs.rmSync = (target, ...args) => {
    if (!paused && path_.resolve(target) === path_.resolve(config.leasePath)) {
      paused = true;
      realWrite(config.pausedFile, "paused");
      while (!realExists(config.resumeFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    return realRemove(target, ...args);
  };
}
let renameCalls = 0;
if (config.mode === "rename-retry" || config.mode === "rename-fatal" || config.mode === "rename-exhaust") {
  const cjsFs = require_("node:fs");
  const realRename = cjsFs.renameSync;
  cjsFs.renameSync = (from, to) => {
    renameCalls += 1;
    if (config.mode === "rename-fatal" || config.mode === "rename-exhaust" || renameCalls <= config.failFirst) {
      throw Object.assign(new Error("rename refused"), { code: config.mode === "rename-fatal" ? "ENOENT" : "EPERM" });
    }
    return realRename(from, to);
  };
}
const fs = await import("node:fs");
const path = await import("node:path");
const runLoop = config.loopUrl ? (await import(config.loopUrl)).runLoop : null;
${CHILD_RECON_SETUP}
const stub = (label) => {
  const calls = [];
  const impl = async (options) => {
    calls.push(options);
    const id = label + "-" + process.pid + "-" + calls.length;
    const campaignRoot = path.join(options.baseRoot, "campaigns", id);
    fs.mkdirSync(path.join(campaignRoot, "history"), { recursive: true });
    fs.writeFileSync(path.join(config.markerDir, "start-" + process.pid + "-" + calls.length + ".json"), "start");
    await sleep(config.holdMs ?? 2000);
    fs.writeFileSync(path.join(config.markerDir, "end-" + process.pid + "-" + calls.length + ".json"), "end");
    fs.writeFileSync(path.join(campaignRoot, "history", "ledger.jsonl"), JSON.stringify({ v: 1, t: new Date().toISOString(), entryId: "e" + calls.length, kind: "apply", campaignId: id, stage: "apply", outcome: "success" }) + "\\n");
    return { id, baseRoot: options.baseRoot, campaignRoot, engineRoot: campaignRoot, state: config.stopAfterOne ? { kind: "failed", reason: "bounded child test" } : { kind: "complete", reason: "child stub" }, stopped: true, stopReason: "child stub", agentStarts: 3, evaluatorRuns: 4, currentScore: 0, bestScore: 0, baselineScore: 0, startedAt: new Date().toISOString() };
  };
  return { impl, calls };
};
const options = {
  projectDir: config.projectDir,
  sessionDir: config.sessionDir,
  contract,
  reconProjectImpl,
  taskProvider,
  limits: { maxCampaigns: 1, maxAgentStarts: 1000, maxEvaluatorRuns: 1000, deadlineMs: 60_000 },
};
let report;
if (config.mode === "race" || config.mode === "fallback-race" || config.mode === "stale-reaper-a" || config.mode === "stale-reaper-b") {
  if (config.mode === "race") while (!fs.existsSync(config.goFile)) await sleep(5);
  const contender = stub(config.role ?? "race");
  const result = await runLoop({ ...options, limits: config.stopAfterOne ? { ...options.limits, maxCampaigns: 2 } : options.limits, runCampaignImpl: contender.impl });
  report = { pid: process.pid, role: config.role ?? null, stopReason: result.stopReason, campaigns: result.campaigns, linkCalls };
} else if (config.mode === "rename-retry" || config.mode === "rename-fatal" || config.mode === "rename-exhaust") {
  const { writeFileAtomic } = await import(config.worldUrl);
  const target = path.join(config.resultDir, "atomic-target.json");
  const waits = [];
  if (config.mode === "rename-exhaust") {
    fs.writeFileSync(target, "old\\n");
    const realWait = Atomics.wait;
    Atomics.wait = (view, index, value, timeout) => { waits.push(timeout); return realWait(view, index, value, timeout); };
  }
  let caught = null;
  try {
    writeFileAtomic(target, "written\\n", true);
  } catch (error) {
    caught = { code: error.code, message: error.message };
  }
  report = {
    pid: process.pid, renameCalls, caught, waits,
    contents: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null,
    leftovers: fs.readdirSync(config.resultDir).filter((name) => name.includes(".tmp-")),
  };
} else {
  const first = stub("first");
  const second = stub("second");
  let enter = () => {};
  let release = () => {};
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const firstRun = runLoop({ ...options, runCampaignImpl: async (runOptions) => { enter(); await gate; return first.impl(runOptions); } });
  await entered;
  const secondResult = await runLoop({ ...options, runCampaignImpl: second.impl });
  release();
  const firstResult = await firstRun;
  report = {
    pid: process.pid, firstStop: firstResult.stopReason, firstCampaigns: firstResult.campaigns,
    secondStop: secondResult.stopReason, secondCampaigns: secondResult.campaigns,
    firstCalls: first.calls.length, secondCalls: second.calls.length, linkCalls,
    leaseExists: fs.existsSync(path.join(config.projectDir, ".dream-rsi", "loop", "lease.json")),
  };
}
fs.writeFileSync(path.join(config.resultDir, "result-" + process.pid + ".json"), JSON.stringify(report));
`;

function spawnContender(childFile, configFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [childFile, configFile], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stderr: String(error) }));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

function readResults(resultDir) {
  return fs.readdirSync(resultDir)
    .filter((name) => name.startsWith("result-"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(resultDir, name), "utf8")));
}

const ABSENT_PRIMARY_CHILD_SCRIPT = `import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const fs = require_("node:fs");
const path = require_("node:path");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
const realRemove = fs.rmSync;
const realLink = fs.linkSync;
const realExists = fs.existsSync;
const waitFor = (file) => {
  const deadline = Date.now() + 30_000;
  while (!realExists(file)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + file);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
if (config.role === "A") {
  let leaseReads = 0;
  fs.readFileSync = (file, ...args) => {
    if (path.resolve(String(file)) === config.leasePath && ++leaseReads === 2) {
      realWrite(config.beforeReread, "ready");
      waitFor(config.allowReread);
    }
    return realRead(file, ...args);
  };
  let primaryLinks = 0;
  let paused = false;
  const pause = () => {
    if (paused) return;
    paused = true;
    realWrite(config.beforeMutation, "ready");
    waitFor(config.allowMutation);
  };
  fs.linkSync = (from, to) => {
    if (path.resolve(String(to)) === config.leasePath && ++primaryLinks === 2) pause();
    return realLink(from, to);
  };
  fs.rmSync = (file, ...args) => {
    if (path.resolve(String(file)) === config.leasePath) pause();
    return realRemove(file, ...args);
  };
}
const { runLoop } = await import(config.loopUrl);
${CHILD_RECON_SETUP}
const result = await runLoop({
  projectDir: config.projectDir,
  contract, reconProjectImpl, taskProvider,
  limits: { maxCampaigns: 2, maxAgentStarts: 100, maxEvaluatorRuns: 100, deadlineMs: 60_000 },
  ...(config.role === "O" ? { now: () => new Date(Date.now() - 60 * 60 * 1000) } : {}),
  collectSignalsImpl: async () => {
    realWrite(path.join(config.stateDir, config.role + "-entered"), JSON.stringify({ pid: process.pid, lease: JSON.parse(realRead(config.leasePath, "utf8")) }));
    waitFor(path.join(config.stateDir, config.role + "-exit"));
    return { weaknesses: [], diagnostics: [] };
  },
});
realWrite(path.join(config.stateDir, config.role + "-result"), JSON.stringify({ pid: process.pid, stopReason: result.stopReason, campaigns: result.campaigns }));
`;

test("independent processes serialize campaigns under the loop lease", async () => {
  const fixture = fixtureProject();
  try {
    const stateDir = path.join(fixture.dir, "race");
    const markerDir = path.join(stateDir, "markers");
    const resultDir = path.join(stateDir, "results");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.mkdirSync(resultDir, { recursive: true });
    const childFile = path.join(stateDir, "loop-child.mjs");
    fs.writeFileSync(childFile, CHILD_SCRIPT);
    for (let round = 0; round < 3; round += 1) {
      fs.rmSync(path.join(fixture.projectDir, ".dream-rsi", "loop"), { recursive: true, force: true });
      for (const dir of [markerDir, resultDir]) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
      }
      const configFile = path.join(stateDir, `config-${round}.json`);
      fs.writeFileSync(configFile, JSON.stringify({
        mode: "race", loopUrl: LOOP_URL, projectDir: fixture.projectDir, sessionDir: fixture.sessionDir,
        markerDir, resultDir, goFile: path.join(stateDir, `go-${round}`),
        holdMs: 4000,
      }));
      const contenders = Array.from({ length: 4 }, () => spawnContender(childFile, configFile));
      fs.writeFileSync(path.join(stateDir, `go-${round}`), "go\n");
      const exits = await Promise.all(contenders);
      for (const exit of exits) assert.equal(exit.code, 0, `contender exited ${exit.code}: ${exit.stderr.slice(-500)}`);
      const results = readResults(resultDir);
      assert.equal(results.length, 4, "every contender reported a result");
      const runners = results.filter((result) => result.campaigns > 0);
      assert.equal(runners.length, 1, `exactly one contender ran a campaign: ${JSON.stringify(results)}`);
      assert.equal(runners[0].campaigns, 1);
      assert.equal(results.filter((result) => result.campaigns === 0).length, 3, `the other contenders started nothing: ${JSON.stringify(results)}`);
      assert.ok(results.filter((result) => result.stopReason === "blocked").length >= 2,
        `the live lease stopped the other contenders: ${JSON.stringify(results)}`);
      const starts = fs.readdirSync(markerDir).filter((name) => name.startsWith("start-"));
      const ends = fs.readdirSync(markerDir).filter((name) => name.startsWith("end-"));
      assert.equal(starts.length, 1, "exactly one campaign started under contention");
      assert.equal(ends.length, 1, "exactly one campaign finished under contention");
      const budget = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, ".dream-rsi", "loop", "budget.json"), "utf8"));
      assert.equal(budget.campaigns, 1, "the durable budget charges exactly one campaign");
    }
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("stale lease reapers serialize before unlinking and cannot evict a newer owner", async () => {
  const fixture = fixtureProject();
  try {
    const stateDir = path.join(fixture.dir, "stale-reaper-race");
    const markerDir = path.join(stateDir, "markers");
    const resultDir = path.join(stateDir, "results");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.mkdirSync(resultDir, { recursive: true });
    const childFile = path.join(stateDir, "loop-child.mjs");
    fs.writeFileSync(childFile, CHILD_SCRIPT);
    const leasePath = path.join(fixture.projectDir, ".dream-rsi", "loop", "lease.json");
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fs.writeFileSync(leasePath, JSON.stringify({ pid: 999_999, host: os.hostname(), startedAt: old, heartbeatAt: old }));
    const pausedFile = path.join(stateDir, "paused");
    const resumeFile = path.join(stateDir, "resume");
    const common = {
      loopUrl: LOOP_URL, projectDir: fixture.projectDir, sessionDir: fixture.sessionDir,
      markerDir, resultDir, leasePath, holdMs: 4000, stopAfterOne: true,
    };
    const configA = path.join(stateDir, "config-a.json");
    const configB = path.join(stateDir, "config-b.json");
    fs.writeFileSync(configA, JSON.stringify({ ...common, mode: "stale-reaper-a", role: "A", pausedFile, resumeFile }));
    fs.writeFileSync(configB, JSON.stringify({ ...common, mode: "stale-reaper-b", role: "B" }));
    const first = spawnContender(childFile, configA);
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(pausedFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(pausedFile), "the first stale reaper paused immediately before unlink");
    const second = spawnContender(childFile, configB);
    const contenderDeadline = Date.now() + 15_000;
    while (Date.now() < contenderDeadline) {
      if (readResults(resultDir).some((result) => result.role === "B")
        || fs.readdirSync(markerDir).some((name) => name.startsWith("start-"))) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(resumeFile, "resume");
    const exits = await Promise.all([first, second]);
    for (const exit of exits) assert.equal(exit.code, 0, `stale reaper child exited ${exit.code}: ${exit.stderr.slice(-500)}`);
    const results = readResults(resultDir);
    assert.equal(results.length, 2);
    assert.equal(results.find((result) => result.role === "B")?.stopReason, "blocked", JSON.stringify(results));
    assert.equal(results.find((result) => result.role === "B")?.campaigns, 0, JSON.stringify(results));
    assert.equal(results.find((result) => result.role === "A")?.campaigns, 1, JSON.stringify(results));
    assert.equal(fs.readdirSync(markerDir).filter((name) => name.startsWith("start-")).length, 1,
      "only the serialized stale reaper enters a campaign");
    const budget = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, ".dream-rsi", "loop", "budget.json"), "utf8"));
    assert.equal(budget.campaigns, 1, "the competing reaper cannot reconcile or double-charge the owner's reservation");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a reaper that finds the old owner already released claims the absent primary instead of unlinking a new owner", async () => {
  const fixture = fixtureProject();
  const stateDir = path.join(fixture.dir, "absent-primary-race");
  const leasePath = path.join(fixture.projectDir, ".dream-rsi", "loop", "lease.json");
  const childFile = path.join(stateDir, "lease-child.mjs");
  const children = [];
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(childFile, ABSENT_PRIMARY_CHILD_SCRIPT);
    const start = (role) => {
      const configFile = path.join(stateDir, `${role}.json`);
      fs.writeFileSync(configFile, JSON.stringify({
        role, stateDir, projectDir: fixture.projectDir, leasePath,
        loopUrl: LOOP_URL,
        beforeReread: path.join(stateDir, "A-before-reread"),
        allowReread: path.join(stateDir, "allow-reread"),
        beforeMutation: path.join(stateDir, "A-before-mutation"),
        allowMutation: path.join(stateDir, "allow-mutation"),
      }));
      const exit = spawnContender(childFile, configFile);
      children.push(exit);
      return exit;
    };
    const waitFor = async (file, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(fs.existsSync(file), `timed out waiting for ${file}`);
    };

    const owner = start("O");
    await waitFor(path.join(stateDir, "O-entered"));
    const reaper = start("A");
    await waitFor(path.join(stateDir, "A-before-reread"));
    fs.writeFileSync(path.join(stateDir, "O-exit"), "exit");
    await waitFor(path.join(stateDir, "O-result"));
    assert.equal(fs.existsSync(leasePath), false, "the old owner released its primary lease");
    fs.writeFileSync(path.join(stateDir, "allow-reread"), "continue");
    await waitFor(path.join(stateDir, "A-before-mutation"));

    const contender = start("C");
    await waitFor(path.join(stateDir, "C-entered"));
    const contenderLease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    fs.writeFileSync(path.join(stateDir, "allow-mutation"), "continue");
    const aResult = path.join(stateDir, "A-result");
    const aEntered = path.join(stateDir, "A-entered");
    const resultDeadline = Date.now() + 15_000;
    while (!fs.existsSync(aResult) && !fs.existsSync(aEntered) && Date.now() < resultDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(aEntered), false, "the stale reaper must not enter while the new owner is active");
    assert.ok(fs.existsSync(aResult), "the stale reaper returns after losing the atomic claim");
    const reaperResult = JSON.parse(fs.readFileSync(aResult, "utf8"));
    assert.equal(reaperResult.stopReason, "blocked", "the reaper loses its exclusive claim to the new owner");
    assert.equal(reaperResult.campaigns, 0);
    assert.equal(fs.existsSync(path.join(stateDir, "C-result")), false, "the new owner remains active while the reaper exits");
    assert.equal(JSON.parse(fs.readFileSync(leasePath, "utf8")).pid, contenderLease.pid,
      "the reaper does not unlink the newly published primary lease");

    fs.writeFileSync(path.join(stateDir, "C-exit"), "exit");
    const exits = await Promise.all([owner, reaper, contender]);
    for (const exit of exits) assert.equal(exit.code, 0, `lease race child exited ${exit.code}: ${exit.stderr.slice(-500)}`);
    assert.ok(fs.existsSync(path.join(stateDir, "C-result")), "the contender completes after its test gate opens");
  } finally {
    for (const signal of ["O-exit", "A-exit", "C-exit", "allow-reread", "allow-mutation"]) {
      try { fs.writeFileSync(path.join(stateDir, signal), "release"); } catch { /* fixture cleanup may already have started */ }
    }
    await Promise.allSettled(children);
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the exclusive-create fallback holds single ownership when hard links are unsupported", async () => {
  const fixture = fixtureProject();
  try {
    const stateDir = path.join(fixture.dir, "nohardlink");
    const markerDir = path.join(stateDir, "markers");
    const resultDir = path.join(stateDir, "results");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.mkdirSync(resultDir, { recursive: true });
    const childFile = path.join(stateDir, "loop-child.mjs");
    fs.writeFileSync(childFile, CHILD_SCRIPT);
    const configFile = path.join(stateDir, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mode: "nohardlink", loopUrl: LOOP_URL, projectDir: fixture.projectDir, sessionDir: fixture.sessionDir,
      markerDir, resultDir, holdMs: 1500,
    }));
    const exit = await spawnContender(childFile, configFile);
    assert.equal(exit.code, 0, `child exited ${exit.code}: ${exit.stderr.slice(-600)}`);
    const [result] = readResults(resultDir);
    assert.ok(result, "the child reported a result");
    assert.ok(result.linkCalls >= 1, "the fallback was exercised: hard linking threw for the real claim path");
    assert.match(result.firstStop, /^post-apply check failed/, "the lease fallback runs and refuses an unverified apply claim");
    assert.equal(result.firstCampaigns, 1);
    assert.equal(result.secondStop, "blocked", "the second loop stays blocked while the fallback lease is held");
    assert.equal(result.secondCampaigns, 0);
    assert.equal(result.secondCalls, 0, "no campaign started while the fallback lease was held");
    assert.equal(result.leaseExists, false, "the fallback lease is released on exit");
    assert.equal(fs.readdirSync(markerDir).filter((name) => name.startsWith("start-")).length, 1);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("the exclusive-create fallback serializes simultaneous stale observations", async () => {
  const fixture = fixtureProject();
  try {
    const stateDir = path.join(fixture.dir, "fallback-race");
    const markerDir = path.join(stateDir, "markers");
    const resultDir = path.join(stateDir, "results");
    const readyDir = path.join(stateDir, "ready");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.mkdirSync(resultDir, { recursive: true });
    fs.mkdirSync(readyDir, { recursive: true });
    const childFile = path.join(stateDir, "loop-child.mjs");
    fs.writeFileSync(childFile, CHILD_SCRIPT);
    const leasePath = path.join(fixture.projectDir, ".dream-rsi", "loop", "lease.json");
    const configFile = path.join(stateDir, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({
      mode: "fallback-race", loopUrl: LOOP_URL, projectDir: fixture.projectDir, sessionDir: fixture.sessionDir,
      markerDir, resultDir, readyDir, leasePath,
      releaseFile: path.join(stateDir, "release"),
    }));
    const children = [spawnContender(childFile, configFile), spawnContender(childFile, configFile)];
    const deadline = Date.now() + 30_000;
    while (fs.readdirSync(readyDir).length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.readdirSync(readyDir).length, 2, "both processes observed the absent lease before either exclusive create");
    fs.writeFileSync(path.join(stateDir, "release"), "go");
    const exits = await Promise.all(children);
    for (const exit of exits) assert.equal(exit.code, 0, `fallback contender exited ${exit.code}: ${exit.stderr.slice(-500)}`);
    const results = readResults(resultDir);
    assert.equal(results.length, 2);
    assert.equal(results.filter((result) => result.campaigns === 1).length, 1, JSON.stringify(results));
    assert.equal(results.filter((result) => result.stopReason === "blocked").length, 1, JSON.stringify(results));
    assert.equal(fs.readdirSync(markerDir).filter((name) => name.startsWith("start-")).length, 1);
    const budget = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, ".dream-rsi", "loop", "budget.json"), "utf8"));
    assert.equal(budget.campaigns, 1);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("atomic writes retry a transient rename refusal and still fail on a fatal one", async () => {
  const fixture = fixtureProject();
  try {
    const stateDir = path.join(fixture.dir, "rename");
    const markerDir = path.join(stateDir, "markers");
    const resultDir = path.join(stateDir, "results");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.mkdirSync(resultDir, { recursive: true });
    const childFile = path.join(stateDir, "loop-child.mjs");
    fs.writeFileSync(childFile, CHILD_SCRIPT);
    const worldUrl = new URL("../extensions/pi-dream-rsi/engine/fsutil.ts", import.meta.url).href;
    const retryConfig = path.join(stateDir, "config-retry.json");
    fs.writeFileSync(retryConfig, JSON.stringify({ mode: "rename-retry", worldUrl, failFirst: 2, markerDir, resultDir }));
    const retryExit = await spawnContender(childFile, retryConfig);
    assert.equal(retryExit.code, 0, `retry child exited ${retryExit.code}: ${retryExit.stderr.slice(0, 1200)}`);
    const [retry] = readResults(resultDir);
    assert.equal(retry.caught, null, "the transient refusals are retried to success");
    assert.equal(retry.renameCalls, 3, "two refusals then the real rename");
    assert.equal(retry.contents, "written\n", "the atomic write lands");
    assert.deepEqual(retry.leftovers, [], "no temp files remain after a retried write");
    fs.rmSync(resultDir, { recursive: true, force: true });
    fs.mkdirSync(resultDir, { recursive: true });
    const fatalConfig = path.join(stateDir, "config-fatal.json");
    fs.writeFileSync(fatalConfig, JSON.stringify({ mode: "rename-fatal", worldUrl, markerDir, resultDir }));
    const fatalExit = await spawnContender(childFile, fatalConfig);
    assert.equal(fatalExit.code, 0, `fatal child exited ${fatalExit.code}: ${fatalExit.stderr.slice(0, 1200)}`);
    const [fatal] = readResults(resultDir);
    assert.equal(fatal.caught?.code, "ENOENT", "a non-transient rename error still throws");
    assert.equal(fatal.renameCalls, 1, "fatal errors are not retried");
    assert.equal(fatal.contents, null, "the failed atomic write leaves no target");
    assert.deepEqual(fatal.leftovers, [], "the temp file is cleaned up after a failed write");
    fs.rmSync(resultDir, { recursive: true, force: true });
    fs.mkdirSync(resultDir, { recursive: true });
    const exhaustConfig = path.join(stateDir, "config-exhaust.json");
    fs.writeFileSync(exhaustConfig, JSON.stringify({ mode: "rename-exhaust", worldUrl, failFirst: 99, markerDir, resultDir }));
    const exhaustExit = await spawnContender(childFile, exhaustConfig);
    assert.equal(exhaustExit.code, 0, `exhaust child exited ${exhaustExit.code}: ${exhaustExit.stderr.slice(0, 1200)}`);
    const [exhaust] = readResults(resultDir);
    assert.equal(exhaust.caught?.code, "EPERM", "persistent transient failures eventually propagate");
    assert.equal(exhaust.renameCalls, 4, "the retry count is bounded to four total attempts");
    assert.deepEqual(exhaust.waits, [5, 10, 15], "the backoff sequence is bounded and ordered");
    assert.equal(exhaust.contents, "old\n", "exhausted retries preserve the prior destination");
    assert.deepEqual(exhaust.leftovers, [], "the exhausted write cleans up its temporary file");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

/** Fabricate a campaign pointer + record without running the real engine. */
function fabricateCampaign(fixture, { stateKind, stopRequest = false } = {}) {
  const baseRoot = path.join(fixture.projectDir, ".dream-rsi");
  const id = "aaaaaaaaaaaaaaaa";
  const campaignRoot = path.join(baseRoot, "campaigns", id);
  fs.mkdirSync(campaignRoot, { recursive: true });
  fs.writeFileSync(path.join(baseRoot, "campaigns", "active.json"), JSON.stringify({ id }));
  fs.writeFileSync(path.join(campaignRoot, "campaign.json"), JSON.stringify({
    version: 1, id, campaignRoot, baseRoot, projectDir: fixture.projectDir, goal: "fixture goal", scope: [], task: {},
    verifierInputs: [], gates: [], noGainCycles: 0, bestScore: 0, baselineScore: 0, completedCycles: [], rejections: [],
    state: { kind: stateKind, phase: "live", iteration: "iter1", reason: stateKind === "paused" ? "stopped by request" : "finished" },
    limits: { maxCycles: 2, maxAgentStarts: 1, maxEvaluatorRuns: 1, deadlineMs: 1000, plateauCycles: 1, maxCandidatesPerCycle: 1 },
    createdAt: NOW.toISOString(), deadlineAt: NOW.toISOString(),
  }));
  fs.writeFileSync(path.join(campaignRoot, "campaign-processes.json"), JSON.stringify({
    version: 1, agent_limit: 1, evaluator_limit: 1, agent_starts: 0, evaluator_runs: 0, last_start: null,
  }));
  if (stopRequest) fs.writeFileSync(path.join(campaignRoot, "stop.request"), "stop\n");
  return { baseRoot, campaignRoot };
}

test("an unfinished campaign blocks the loop before any new campaign", async () => {
  const fixture = fixtureProject();
  try {
    fabricateCampaign(fixture, { stateKind: "paused" });
    const stub = stubCampaign();
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(result.stopReason, "blocked");
    assert.equal(stub.calls.length, 0, "no new campaign starts while another is unfinished");
    assert.ok(result.memory.notes.some((note) => /blocked: campaign aaaaaaaaaaaaaaaa is paused/.test(note)));
    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.equal(budget.campaigns, 0);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a stop request between campaigns cancels the loop and is consumed", async () => {
  const fixture = fixtureProject();
  try {
    const fabricated = fabricateCampaign(fixture, { stateKind: "complete", stopRequest: true });
    const stub = stubCampaign();
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(result.stopReason, "cancelled");
    assert.equal(stub.calls.length, 0);
    assert.equal(fs.existsSync(path.join(fabricated.campaignRoot, "stop.request")), false, "the stop request is consumed once honored");
    assert.ok(result.memory.notes.some((note) => /stop request arrived between campaigns/.test(note)));
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a task provider replaces synthesis, and its rejection is recorded verbatim", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign();
    const providedTask = {
      name: "provided", workspace: ".", eval_program: "src/lexer.ts", score_program: `node "${path.join(fixture.projectDir, "external-evaluator.mjs")}"`,
      score_path: "eval/score.json", higher_is_better: false,
    };
    const rejections = [];
    let providerCalls = 0;
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      runCampaignImpl: stub.impl,
      now: () => NOW,
      taskProvider: ({ lever }) => {
        providerCalls += 1;
        if (providerCalls === 1) return { reject: `provider said no to ${lever.metricKind}` };
        rejections.push(lever.id);
        return { task: providedTask, verifierInputs: [path.join(fixture.projectDir, "external-evaluator.mjs")], gates: [] };
      },
    });
    assert.equal(result.stopReason, "budget");
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].task.name, "provided");
    assert.deepEqual(stub.calls[0].verifierInputs, [path.join(fixture.projectDir, "external-evaluator.mjs")]);
    assert.equal(fs.existsSync(path.join(fixture.projectDir, ".dream-rsi", "loop", "metrics")), false, "no synthesis runs when a provider supplies the setup");
    assert.ok(result.records.some((record) => record.outcome === "rejected" && /provider said no/.test(record.stopReason)));
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a campaign apply claim without an independent instrument stops as unverified", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign({ outcome: "win", stateKind: "failed", stopReason: "integrity check failed after apply", agentStarts: 6, evaluatorRuns: 11 });
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits({ maxCampaigns: 3 }),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(stub.calls.length, 1, "a failed campaign stops the loop instead of starting another one");
    assert.match(result.stopReason, /^post-apply check failed/);
    assert.equal(result.campaigns, 1);
    assert.equal(result.wins, 0, "the apply claim is not promoted to a win without independent verification");
    assert.ok(result.records.every((record) => record.outcome !== "win"));
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a lever-level preflight rejection is a screening outcome, not a loop stop", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign({
      outcome: "no-win",
      stateKind: "failed",
      stopReason: "evaluator preflight failed: minimum detectable effect exceeds 50%",
      agentStarts: 2,
      evaluatorRuns: 4,
    });
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits({ maxCampaigns: 5 }),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(stub.calls.length, 3, "each discoverable lever is screened once in this run");
    assert.equal(result.stopReason, "no verifiable lever", "the loop continues past every rejected lever and stops only because nothing launchable remains");
    assert.equal(result.records.filter((record) => record.outcome === "rejected" && /preflight failed/.test(record.stopReason ?? "")).length, 3,
      "every preflight rejection is recorded as a screening outcome");
    assert.ok(result.memory.notes.some((note) => /rejected during preflight/.test(note)));
    assert.equal(result.wins, 0);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("negative or fractional budget counters fail closed instead of inflating the allowance", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign();
    const limits = baseLimits();
    const first = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits,
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    const valid = JSON.parse(fs.readFileSync(first.budgetPath, "utf8"));
    for (const tamper of [{ campaigns: -5 }, { agent_starts: 1.5 }, { evaluator_runs: null }]) {
      fs.writeFileSync(first.budgetPath, JSON.stringify({ ...valid, ...tamper }));
      await assert.rejects(
        () => runLoop({
          projectDir: fixture.projectDir,
          sessionDir: fixture.sessionDir,
          limits,
          runCampaignImpl: stub.impl,
          now: () => NOW,
        }),
        /refusing to continue on corrupted state/,
        JSON.stringify(tamper),
      );
      const status = JSON.parse(fs.readFileSync(path.join(path.dirname(first.budgetPath), "status.json"), "utf8"));
      assert.equal(status.state, "failed", JSON.stringify(tamper));
      assert.equal(status.stopCode, "failed", JSON.stringify(tamper));
      assert.match(status.stopReason, /corrupted state/, JSON.stringify(tamper));
    }
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a campaign that refuses infeasible caps is charged no spend and the loop continues", async () => {
  const fixture = fixtureProject();
  try {
    const floor = promotionFloor({ readings: 5, deterministic: true, evaluatorTimeoutMs: 60_000 });
    const stub = stubCampaign();
    const seen = [];
    const impl = async (options) => {
      seen.push(options);
      if (seen.length <= 2) {
        throw new CampaignInfeasibleError(
          "insufficient caps for a verified promotion",
          floor,
          { evaluatorRuns: floor.evaluatorRuns, agentStarts: floor.agentStarts, deadlineMs: 60 * 60 * 1000 },
        );
      }
      return stub.impl(options);
    };
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      runCampaignImpl: impl,
      now: () => NOW,
    });

    assert.equal(seen.length, 3, "each infeasible refusal moved on to the next lever instead of halting the run");
    assert.equal(new Set(seen.map((options) => options.goal)).size, 3, "the refusals screened different levers");
    assert.equal(stub.calls.length, 1, "the third lever finally started its campaign");
    assert.equal(result.stopReason, "budget", "the run only stops once its campaign allowance is spent");

    const rejected = result.records.filter((record) => record.outcome === "rejected");
    assert.equal(rejected.length, 2);
    for (const record of rejected) {
      assert.equal(record.evaluatorRuns, 0, "a refusal taken before any reading costs no evaluator run");
      assert.equal(record.agentStarts, 0, "a refusal taken before any agent costs no agent start");
      assert.equal(record.campaignRoot, null);
      assert.match(record.stopReason, /^campaign infeasible: /);
    }
    assert.ok(
      result.memory.notes.some((note) => /infeasible/.test(note) && /evaluator runs 7/.test(note) && /recommended/.test(note)),
      "the note names the floor and the recommended caps",
    );
    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.deepEqual(
      { campaigns: budget.campaigns, agent: budget.agent_starts, evaluators: budget.evaluator_runs },
      { campaigns: 1, agent: 5, evaluators: 12 },
      "only the real campaign is charged; the refusals cost nothing",
    );
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("qualification baseline readings seed the campaign only while the qualification fingerprint matches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-seed-"));
  try {
    fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");
    const task = {
      name: "seed", workspace: ".", eval_program: "solution.py", score_program: "node score.mjs",
      score_path: "eval/score.json", higher_is_better: false,
    };
    const evaluationContract = {
      id: "0123456789abcdef", outcome: "reduce benchmark duration", unit: "ms", higherIsBetter: false,
      minimumUsefulGain: "10%", metricKind: "command-duration", argv: ["node", "bench.mjs"], gates: [],
      assets: [], baseline: [120, 122, 118], sensitivity: 40, confirmationPerspective: "fresh copy",
    };
    const qualificationFingerprint = projectFingerprint(dir);
    const seeds = campaignSeedReadings({
      projectDir: dir, qualificationFingerprint, task, verifierInputs: ["score.mjs"], gates: [], evaluationContract,
    });
    assert.ok(seeds, "a qualified instrument on the approved tree seeds the campaign check");
    assert.equal(seeds.identity, campaignVerifierIdentity(dir, task, ["score.mjs"], []));
    assert.deepEqual(seeds.runs.map((run) => run.score), [-120, -122, -118],
      "every baseline reading is reused in the campaign's normalized score semantics (lower is better is negated)");
    assert.ok(seeds.runs.every((run) => run.durationMs === 0 && run.code === null && run.valid === true
      && run.failClass === "ok" && run.error === null && run.logPath === null
      && run.stdoutTail === "seeded from loop qualification"), "seeded readings carry no invented process evidence");

    fs.writeFileSync(path.join(dir, "a.js"), "export const a = 2;\n");
    assert.equal(campaignSeedReadings({
      projectDir: dir, qualificationFingerprint, task, verifierInputs: ["score.mjs"], gates: [], evaluationContract,
    }), null, "an edited tree invalidates the frozen baseline");
    assert.equal(campaignSeedReadings({
      projectDir: dir, qualificationFingerprint: projectFingerprint(dir), task, verifierInputs: ["score.mjs"], gates: [],
    }), null, "no qualified instrument means no seeded readings");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a campaign inherits a one-hour deadline when the run has more time", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign();
    await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits({ deadlineMs: 2 * 60 * 60 * 1000 }),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(stub.calls[0].limits.deadlineMs, 60 * 60 * 1000, "the campaign default deadline is one hour");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});
