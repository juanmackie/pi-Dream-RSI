import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { campaignSeedReadings, patchPaths, runLoop } from "../extensions/pi-dream-rsi/engine/loop.ts";
import { getAgentContainmentSupport } from "../extensions/pi-dream-rsi/engine/containment.ts";
import { CampaignInfeasibleError, campaignVerifierIdentity, promotionFloor } from "../extensions/pi-dream-rsi/engine/campaign.ts";
import { projectFingerprint } from "../extensions/pi-dream-rsi/engine/intake.ts";

const NOW = new Date("2026-10-16T00:00:00.000Z");

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

/**
 * Fixture: a Node project whose sessions show two failing npm-test runs followed
 * by source edits. The edits are the discovered patch scope of the failing
 * command lever (highest ranked), and they also yield a follow-up-edit lever;
 * the recorded command durations add a low-ranked slow-command lever.
 */
function fixtureProject({ withControlPatch = true } = {}) {
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
  const controlPatchPath = path.join(projectDir, "control.patch");
  if (withControlPatch) fs.writeFileSync(controlPatchPath, "diff --git a/src/lexer.ts b/src/lexer.ts\n");
  return { dir, projectDir, sessionDir, controlPatchPath };
}

/** Stub campaign engine: records calls and fabricates a bounded campaign result. */
function stubCampaign({ outcome = "win", stateKind = "complete", stopReason = "stub finished", agentStarts = 5, evaluatorRuns = 9 } = {}) {
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
    };
  };
  return { impl, calls };
}

function baseLimits(overrides = {}) {
  return { maxCampaigns: 1, maxAgentStarts: 1000, maxEvaluatorRuns: 1000, deadlineMs: 60_000, ...overrides };
}

test("requested containment refuses before recon when the host backend is unavailable", async () => {
  const fixture = fixtureProject();
  let reconStarted = false;
  try {
    await assert.rejects(runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      containment: {},
      containmentSupportImpl: async () => ({
        available: false,
        backend: null,
        reason: "fixture has no OS container",
      }),
      collectSignalsImpl: async () => {
        reconStarted = true;
        return { weaknesses: [], diagnostics: [] };
      },
    }), /unavailable before recon: fixture has no OS container/);
    assert.equal(reconStarted, false);
    assert.equal(fs.existsSync(path.join(fixture.projectDir, ".dream-rsi")), false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the real agent-runtime canary refuses this host before creating loop state", async (t) => {
  const support = await getAgentContainmentSupport();
  if (support.available) {
    t.skip("this host can launch the Node runtime inside its process container");
    return;
  }
  const fixture = fixtureProject();
  let reconStarted = false;
  try {
    await assert.rejects(runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      containment: {},
      containmentSupportImpl: async () => support,
      collectSignalsImpl: async () => {
        reconStarted = true;
        return { weaknesses: [], diagnostics: [] };
      },
    }), /unavailable before recon/);
    assert.equal(reconStarted, false);
    assert.equal(fs.existsSync(path.join(fixture.projectDir, ".dream-rsi")), false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("loop chains a discovered-scope command lever through synthesis, campaign, and durable accounting", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign();
    const messages = [];
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      controlPatchPath: fixture.controlPatchPath,
      runCampaignImpl: stub.impl,
      now: () => NOW,
      onProgress: (message) => messages.push(message),
    });

    assert.equal(result.stopReason, "budget", "one campaign spent the per-run campaign allowance");
    assert.equal(stub.calls.length, 1);
    assert.equal(result.campaigns, 1);
    assert.equal(result.wins, 1);
    assert.equal(result.agentStarts, 5);
    assert.equal(result.evaluatorRuns, 9);

    const call = stub.calls[0];
    assert.match(call.task.score_program, /^node ".+\.dream-rsi[\\/]loop[\\/]metrics[\\/].+evaluate\.mjs"$/);
    assert.equal(call.verifierInputs.length, 1);
    assert.ok(call.verifierInputs[0].includes(`${path.sep}.dream-rsi${path.sep}loop${path.sep}metrics${path.sep}`), "the synthesized evaluator is the pinned verifier input");
    assert.equal(fs.realpathSync(call.verifierInputs[0]).endsWith("evaluate.mjs"), true);
    assert.deepEqual(call.gates, [], "the metric command is not repeated as a gate");
    assert.deepEqual(call.scope.slice().sort(), ["src/lexer.ts", "src/parser.ts"], "the failing command is scoped by the files edited after its failures");
    assert.ok(["src/lexer.ts", "src/parser.ts"].includes(call.task.eval_program));
    assert.equal(call.task.workspace, ".");
    assert.equal(call.task.higher_is_better, false);
    assert.match(call.goal, /"npm test"/, "the top-ranked command lever campaigns first");
    assert.equal(call.controlPatch, path.resolve(fixture.controlPatchPath));
    assert.equal(call.limits.maxCycles, 2);
    assert.equal(call.limits.maxAgentStarts, 18);
    assert.equal(call.limits.maxEvaluatorRuns, 48);
    assert.ok(call.limits.deadlineMs <= 30 * 60 * 1000);

    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.deepEqual(
      { campaigns: budget.campaigns, agent: budget.agent_starts, evaluators: budget.evaluator_runs, restarts: budget.restarts, open: budget.open_campaign },
      { campaigns: 1, agent: 5, evaluators: 9, restarts: 0, open: null },
      "the reservation is reconciled into real spend",
    );

    const winRecord = result.records.find((record) => record.outcome === "win");
    assert.ok(winRecord, "the applied candidate is recorded as a verified win");
    assert.equal(result.memory.leverStats[winRecord.leverId].wins, 1);
    assert.equal(result.records.some((record) => record.outcome === "rejected"), false, "no lever needed a screening rejection: the command lever had discovered scope");
    assert.ok(messages.some((message) => /campaign stub-1 finished as win/.test(message)));
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("loop stops on an empty inventory without touching the budget", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-loop-empty-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "empty", scripts: { test: "node -e 0" } }));
    const stub = stubCampaign();
    const result = await runLoop({
      projectDir: dir,
      limits: baseLimits(),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(result.stopReason, "empty inventory");
    assert.equal(stub.calls.length, 0);
    assert.equal(result.campaigns, 0);
    assert.deepEqual(result.records, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("loop rejects levers whose metric cannot be calibrated and never starts a campaign", async () => {
  const fixture = fixtureProject({ withControlPatch: false });
  try {
    const stub = stubCampaign();
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(result.stopReason, "no verifiable lever");
    assert.equal(stub.calls.length, 0, "no campaign is started without a validated-ready metric");
    assert.ok(result.records.length >= 1);
    assert.ok(result.records.every((record) => record.outcome === "rejected"));
    assert.equal(result.memory.outcomes.every((record) => record.outcome === "rejected"), true);
    assert.ok(result.memory.notes.some((note) => /no known-better control patch/.test(note)));
    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.deepEqual({ campaigns: budget.campaigns, agent: budget.agent_starts, evaluators: budget.evaluator_runs }, { campaigns: 0, agent: 0, evaluators: 0 });
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a plateau restart re-explores a tried lever with an alternate metric before stopping", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign({ outcome: "no-win", agentStarts: 3, evaluatorRuns: 4 });
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits({ maxCampaigns: 5, plateauK: 2 }),
      controlPatchPath: fixture.controlPatchPath,
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(result.stopReason, "plateau");
    assert.equal(stub.calls.length, 4, "three levers, then one bounded restart campaign, then the plateau stop");
    assert.deepEqual(result.records.map((record) => record.outcome), ["no-win", "no-win", "no-win", "no-win"]);
    assert.ok(result.memory.notes.some((note) => /plateau restart 1\/1: re-exploring lever/.test(note)));
    assert.ok(result.memory.notes.some((note) => /plateau: \d+ consecutive campaign/.test(note)));
    assert.match(result.memento, /plateau/);
    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.equal(budget.agent_starts, 12);
    assert.equal(budget.evaluator_runs, 16);
    assert.equal(budget.restarts, 1, "the restart allowance is durable spend");
    assert.equal(budget.open_campaign, null);

    // The restart campaign measured the alternate signal on the plateaued lever:
    // the command-success lever switched from failures (count) to duration (ms).
    const restartRecord = result.records[3];
    const evaluatorPath = path.join(fixture.projectDir, ".dream-rsi", "loop", "metrics", restartRecord.leverId, "evaluate.mjs");
    const evaluator = fs.readFileSync(evaluatorPath, "utf8");
    assert.match(evaluator, /const MODE = "duration"/, "the restart measured the alternate metric, not a repeat of the failures metric");

    const stopped = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits({ maxCampaigns: 5, plateauK: 2 }),
      controlPatchPath: fixture.controlPatchPath,
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(stub.calls.length, 4, "the restart allowance is durable: no further campaign starts across runs");
    assert.equal(stopped.stopReason, "plateau");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("loop budget is durable across runs and its limits are immutable", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign({ outcome: "no-win", agentStarts: 5, evaluatorRuns: 9 });
    const options = {
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits({ maxCampaigns: 3, maxAgentStarts: 5 }),
      controlPatchPath: fixture.controlPatchPath,
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
      controlPatchPath: fixture.controlPatchPath,
      runCampaignImpl: impl,
      now: () => NOW,
    });
    assert.equal(result.stopReason, "campaign failed: an unfinished campaign already exists; resume or stop it before starting another");
    const errorRecord = result.records.find((record) => record.outcome === "error");
    assert.ok(errorRecord, "the failed attempt is recorded as an error outcome");
    assert.equal(errorRecord.campaignRoot, null);
    assert.equal(result.campaigns, 1, "a throw counts as a started campaign even without a campaign root");
    assert.equal(errorRecord.agentStarts, 18, "the reserved grant is recorded when the real spend is unknown");
    assert.equal(errorRecord.evaluatorRuns, 48);
    const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8"));
    assert.equal(budget.agent_starts, 18, "a thrown campaign spends its reserved grant, never less");
    assert.equal(budget.evaluator_runs, 48);
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
      controlPatchPath: fixture.controlPatchPath,
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
      controlPatchPath: fixture.controlPatchPath,
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
      controlPatchPath: fixture.controlPatchPath,
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
      controlPatchPath: fixture.controlPatchPath,
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
      controlPatchPath: fixture.controlPatchPath,
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
    fs.writeFileSync(path.join(fixture.projectDir, ".dream-rsi", "loop", "lease.json"),
      JSON.stringify({ pid: 999_999, host: os.hostname(), startedAt: NOW.toISOString(), heartbeatAt: NOW.toISOString() }));
    const blocked = await runLoop(options);
    assert.equal(blocked.stopReason, "blocked");
    assert.equal(blocked.campaigns, 0, "a blocked invocation starts nothing");
    assert.equal(fs.readFileSync(first.budgetPath, "utf8"), reserved,
      "the owner's budget, including its open reservation, is untouched by the blocked invocation");
    assert.equal(fs.readFileSync(memoryPath, "utf8"), memoryBefore,
      "the blocked invocation does not rewrite the owner's memory");
    assert.ok(blocked.memory.notes.some((note) => /another loop \(pid 999999\)/.test(note)),
      "the blocked note is still reported in the returned state");
    assert.equal(stub.calls.length, 1, "only the first run started a campaign");
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
      controlPatchPath: fixture.controlPatchPath,
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
  controlPatchPath: config.controlPatchPath,
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
const result = await runLoop({
  projectDir: config.projectDir,
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
        controlPatchPath: fixture.controlPatchPath, markerDir, resultDir, goFile: path.join(stateDir, `go-${round}`),
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
      controlPatchPath: fixture.controlPatchPath, markerDir, resultDir, leasePath, holdMs: 4000, stopAfterOne: true,
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
      controlPatchPath: fixture.controlPatchPath, markerDir, resultDir, holdMs: 1500,
    }));
    const exit = await spawnContender(childFile, configFile);
    assert.equal(exit.code, 0, `child exited ${exit.code}: ${exit.stderr.slice(-600)}`);
    const [result] = readResults(resultDir);
    assert.ok(result, "the child reported a result");
    assert.ok(result.linkCalls >= 1, "the fallback was exercised: hard linking threw for the real claim path");
    assert.equal(result.firstStop, "budget", "the first loop proceeds through the exclusive-create fallback");
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
      controlPatchPath: fixture.controlPatchPath, markerDir, resultDir, readyDir, leasePath,
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
    const worldUrl = new URL("../extensions/pi-dream-rsi/engine/world.ts", import.meta.url).href;
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
      controlPatchPath: fixture.controlPatchPath,
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
      controlPatchPath: fixture.controlPatchPath,
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
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      controlPatchPath: fixture.controlPatchPath,
      runCampaignImpl: stub.impl,
      now: () => NOW,
      taskProvider: ({ lever }) => {
        if (lever.sourceKind !== "post-failure-edits") return { reject: `provider said no to ${lever.sourceKind}` };
        rejections.push(lever.id);
        return { task: providedTask, verifierInputs: [path.join(fixture.projectDir, "external-evaluator.mjs")], gates: [], controlPatch: fixture.controlPatchPath };
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

test("a campaign that applied a verified patch and then failed stops the loop without losing the win", async () => {
  const fixture = fixtureProject();
  try {
    const stub = stubCampaign({ outcome: "win", stateKind: "failed", stopReason: "integrity check failed after apply", agentStarts: 6, evaluatorRuns: 11 });
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits({ maxCampaigns: 3 }),
      controlPatchPath: fixture.controlPatchPath,
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(stub.calls.length, 1, "a failed campaign stops the loop instead of starting another one");
    assert.equal(result.stopReason, "campaign failed: integrity check failed after apply");
    assert.equal(result.campaigns, 1);
    assert.equal(result.wins, 1, "the applied patch is still counted as a win");
    assert.ok(result.records.some((record) => record.outcome === "win"), "the applied patch is recorded truthfully and not overwritten by the later failure");
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
      controlPatchPath: fixture.controlPatchPath,
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
      controlPatchPath: fixture.controlPatchPath,
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    const valid = JSON.parse(fs.readFileSync(first.budgetPath, "utf8"));
    for (const tamper of [{ campaigns: -5 }, { agent_starts: 1.5 }, { evaluator_runs: null }, { restarts: null }]) {
      fs.writeFileSync(first.budgetPath, JSON.stringify({ ...valid, ...tamper }));
      await assert.rejects(
        () => runLoop({
          projectDir: fixture.projectDir,
          sessionDir: fixture.sessionDir,
          limits,
          controlPatchPath: fixture.controlPatchPath,
          runCampaignImpl: stub.impl,
          now: () => NOW,
        }),
        /refusing to continue on corrupted state/,
        JSON.stringify(tamper),
      );
    }
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("patchPaths lists every project-relative path a unified diff touches", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 100%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "diff --git a/src/added.ts b/src/added.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/added.ts",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
  ].join("\n");
  assert.deepEqual(patchPaths(diff), ["src/a.ts", "src/added.ts", "src/gone.ts", "src/new.ts", "src/old.ts"]);
  assert.deepEqual(patchPaths(""), [], "an empty patch touches no path");
  assert.deepEqual(patchPaths("this is not a diff\n"), [], "prose is not parsed as a patch");
  assert.deepEqual(
    patchPaths("--- a/src/parser.ts\t2026-01-01 00:00:00\n+++ b/src/parser.ts\t2026-01-01 00:00:00\n"),
    ["src/parser.ts"],
    "a plain unified diff with timestamps still names its path",
  );
});

test("a known-better control patch is not passed to a lever whose scope it escapes", async () => {
  const fixture = fixtureProject();
  try {
    const controlPatchPath = path.join(fixture.projectDir, "escaped-control.patch");
    fs.writeFileSync(controlPatchPath,
      "diff --git a/src/unsafe.ts b/src/unsafe.ts\n--- a/src/unsafe.ts\n+++ b/src/unsafe.ts\n@@ -1 +1,2 @@\n seed\n+more\n");
    const stub = stubCampaign();
    const result = await runLoop({
      projectDir: fixture.projectDir,
      sessionDir: fixture.sessionDir,
      limits: baseLimits(),
      controlPatchPath,
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(stub.calls.length, 0, "no campaign receives a control patch that touches paths outside the lever's scope");
    assert.equal(result.stopReason, "no verifiable lever");
    assert.ok(result.records.length >= 1, "the refuse-to-screen path records each lever");
    assert.ok(result.records.every((record) => record.outcome === "rejected"));
    assert.ok(
      result.records.every((record) => /control patch/.test(record.stopReason ?? "") && /src\/unsafe\.ts/.test(record.stopReason ?? "")),
      "each lever records the exact path it cannot cover",
    );
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
      controlPatchPath: fixture.controlPatchPath,
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
      { campaigns: 1, agent: 5, evaluators: 9 },
      "only the real campaign is charged; the refusals cost nothing",
    );
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("qualification baseline readings seed the campaign only while the approved fingerprint matches", () => {
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
    const approvedFingerprint = projectFingerprint(dir);
    const seeds = campaignSeedReadings({
      projectDir: dir, approvedFingerprint, task, verifierInputs: ["score.mjs"], gates: [], evaluationContract,
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
      projectDir: dir, approvedFingerprint, task, verifierInputs: ["score.mjs"], gates: [], evaluationContract,
    }), null, "an edited tree invalidates the frozen baseline");
    assert.equal(campaignSeedReadings({
      projectDir: dir, approvedFingerprint: projectFingerprint(dir), task, verifierInputs: ["score.mjs"], gates: [],
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
      controlPatchPath: fixture.controlPatchPath,
      runCampaignImpl: stub.impl,
      now: () => NOW,
    });
    assert.equal(stub.calls[0].limits.deadlineMs, 60 * 60 * 1000, "the campaign default deadline is one hour");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});
