import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { jump, makeProject } from "./fixtures.mjs";

const { selectActions, defaultSearchConfig, runExperiment, experimentWorldPath } = await jump("engine/experiment.ts");
const { normalizeTask } = await jump("engine/task.ts");

test("experiment opens the configured first batch, then mixes branches and refinements", () => {
  const config = { ...defaultSearchConfig, batchSize: 4, exploreShare: 0.5, refineTop: 1 };
  assert.deepEqual(selectActions([], config, 1), [
    { kind: "branch", parent: null }, { kind: "branch", parent: null },
    { kind: "branch", parent: null }, { kind: "branch", parent: null },
  ]);
  const done = [
    { id: "n1", kind: "branch", parent: null, score: 4, valid: true },
    { id: "n2", kind: "branch", parent: null, score: 3, valid: true },
    { id: "n3", kind: "branch", parent: null, score: 2, valid: true },
    { id: "n4", kind: "branch", parent: null, score: 1, valid: true },
  ];
  assert.deepEqual(selectActions(done, config, 2), [
    { kind: "branch", parent: null }, { kind: "branch", parent: null },
    { kind: "refine", parent: "n1" }, { kind: "refine", parent: "n1" },
  ]);
});

test("experiment does not refine invalid or unscored nodes", () => {
  const config = { ...defaultSearchConfig, batchSize: 2, exploreShare: 0, refineTop: 2 };
  const done = [
    { id: "bad", kind: "branch", parent: null, score: null, valid: false },
    { id: "good", kind: "branch", parent: null, score: 1, valid: true },
  ];
  assert.deepEqual(selectActions(done, config, 2), [
    { kind: "refine", parent: "good" }, { kind: "refine", parent: "good" },
  ]);
});

test("experiment persists evaluated branches and refines the best valid parent", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const root = path.join(project.dreamRoot, "campaigns", "fixture");
  let agentStarts = 0;
  let evaluatorRuns = 0;
  const world = await runExperiment({
    root, projectDir: project.projectDir, targetRoot: project.seed, seedRoot: project.seed, task: normalizeTask(project.task),
    cycle: 1, worldId: "campaign:1", fingerprint: "fixture-fingerprint", baseline: 0, threshold: 0.1,
    config: { version: 1, batchSize: 2, exploreShare: 0.5, refineTop: 1, maxRounds: 2, patience: 1 },
    signal: new AbortController().signal, agent: normalizeTask(project.task).agent,
    beforeAgentSpawn: () => { agentStarts += 1; }, beforeEvaluatorSpawn: () => { evaluatorRuns += 1; },
  });
  assert.equal(world.status, "complete");
  assert.equal(world.nodes.length, 4);
  assert.ok(world.nodes.every((node) => node.stage === "done"));
  assert.equal(world.nodes[2].kind, "branch");
  assert.equal(world.nodes[3].parent, "n1");
  assert.match(fs.readFileSync(path.join(root, "cycles", "c0001", "work", "n1", "proposal.md"), "utf8"), /mechanism/);
  assert.equal(fs.existsSync(path.join(root, "cycles", "c0001", "work", "n1", ".dream-rsi")), false,
    "campaign state is not copied back into candidate workspaces");
  assert.equal(agentStarts, 4);
  assert.equal(evaluatorRuns, 4);
  assert.ok(fs.existsSync(experimentWorldPath(root, 1)));
});

test("resume keeps completed attempts and retries only planned work", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const root = path.join(project.dreamRoot, "campaigns", "resume");
  const task = normalizeTask(project.task);
  const interruption = new AbortController();
  const options = {
    root, projectDir: project.projectDir, targetRoot: project.seed, seedRoot: project.seed, task,
    cycle: 1, fingerprint: "resume-fingerprint", baseline: 0, threshold: 0.1,
    config: { ...defaultSearchConfig, batchSize: 3, maxRounds: 1 },
    signal: interruption.signal, agent: task.agent, maxAgentAttempts: 3, maxEvaluatorAttempts: 3,
    beforeEvaluatorSpawn: () => {},
  };
  let starts = 0;
  await assert.rejects(runExperiment({ ...options, beforeAgentSpawn: () => { if (++starts === 2) interruption.abort(); } }), /experiment stopped/);
  const interrupted = JSON.parse(fs.readFileSync(experimentWorldPath(root, 1), "utf8"));
  const completed = interrupted.nodes.find((node) => node.stage === "done");
  assert.ok(completed);
  await runExperiment({ ...options, signal: new AbortController().signal, beforeAgentSpawn: () => { starts += 1; } });
  const resumed = JSON.parse(fs.readFileSync(experimentWorldPath(root, 1), "utf8"));
  assert.deepEqual(resumed.nodes.find((node) => node.id === completed.id), completed);
  assert.equal(resumed.status, "complete");
  assert.equal(starts, 4, "the done attempt is not started again");
});

test("a stale proposal from an earlier attempt cannot validate a new no-output run", async (t) => {
  const project = makeProject({ agent: "agent-noproposal.mjs" });
  t.after(project.cleanup);
  const root = path.join(project.dreamRoot, "campaigns", "stale-proposal");
  const attempt = path.join(root, "cycles", "c0001", "attempts", "n1");
  fs.mkdirSync(attempt, { recursive: true });
  fs.writeFileSync(path.join(attempt, "proposal.md"), "stale proposal from prior process\n");
  const task = normalizeTask(project.task);
  const world = await runExperiment({
    root, projectDir: project.projectDir, targetRoot: project.seed, seedRoot: project.seed, task,
    cycle: 1, fingerprint: "stale-proposal-fingerprint", baseline: 0, threshold: 0.1,
    config: { ...defaultSearchConfig, batchSize: 1, maxRounds: 1 }, signal: new AbortController().signal,
    agent: task.agent, beforeAgentSpawn: () => {}, beforeEvaluatorSpawn: () => {}, maxAgentAttempts: 1, maxEvaluatorAttempts: 1,
  });
  assert.equal(world.nodes[0].failClass, "no_proposal");
});

test("a corrupt saved world fails closed instead of resetting experiment history", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const root = path.join(project.dreamRoot, "campaigns", "corrupt-world");
  const file = experimentWorldPath(root, 1);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ truncated");
  const task = normalizeTask(project.task);
  await assert.rejects(runExperiment({
    root, projectDir: project.projectDir, targetRoot: project.seed, seedRoot: project.seed, task,
    cycle: 1, fingerprint: "corrupt-world-fingerprint", baseline: 0, threshold: 0.1,
    config: { ...defaultSearchConfig, batchSize: 1, maxRounds: 1 }, signal: new AbortController().signal,
    agent: task.agent, beforeAgentSpawn: () => {}, beforeEvaluatorSpawn: () => {},
  }), /saved experiment world is unreadable/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ truncated", "the failed load does not overwrite corrupt evidence");
});

test("timed-out edits are evaluated, while an unchanged attempt never spends an evaluator run", async (t) => {
  const edited = makeProject({ agent: "agent-scenario.mjs", agentTimeoutMs: 5_000 });
  t.after(edited.cleanup);
  edited.task.agent.env = { DREAM_SCENARIO: "timeout" };
  const editedTask = normalizeTask(edited.task);
  const timedOut = await runExperiment({
    root: path.join(edited.dreamRoot, "campaigns", "timeout"), projectDir: edited.projectDir, targetRoot: edited.seed, seedRoot: edited.seed,
    task: editedTask, cycle: 1, fingerprint: "timeout-fingerprint", baseline: 1, threshold: 0.1,
    config: { ...defaultSearchConfig, batchSize: 1, maxRounds: 1 }, signal: new AbortController().signal,
    agent: editedTask.agent, beforeAgentSpawn: () => {}, beforeEvaluatorSpawn: () => {}, maxAgentAttempts: 1, maxEvaluatorAttempts: 1,
  });
  assert.equal(timedOut.nodes[0].timedOut, true);
  assert.equal(timedOut.nodes[0].valid, true);
  assert.equal(timedOut.evaluatorRuns, 1);

  const unchanged = makeProject({ agent: "agent-noproposal.mjs" });
  t.after(unchanged.cleanup);
  const unchangedTask = normalizeTask(unchanged.task);
  const noEdit = await runExperiment({
    root: path.join(unchanged.dreamRoot, "campaigns", "no-edit"), projectDir: unchanged.projectDir, targetRoot: unchanged.seed, seedRoot: unchanged.seed,
    task: unchangedTask, cycle: 1, fingerprint: "no-edit-fingerprint", baseline: 0, threshold: 0.1,
    config: { ...defaultSearchConfig, batchSize: 1, maxRounds: 1 }, signal: new AbortController().signal,
    agent: unchangedTask.agent, beforeAgentSpawn: () => {}, beforeEvaluatorSpawn: () => { throw new Error("unchanged attempts must not evaluate"); },
    maxAgentAttempts: 1, maxEvaluatorAttempts: 1,
  });
  assert.equal(noEdit.nodes[0].failClass, "no_proposal");
  assert.equal(noEdit.evaluatorRuns, 0);
});

test("experiment leaves the supplied confirmation and gate reserve unused", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const task = normalizeTask(project.task);
  const options = {
    root: path.join(project.dreamRoot, "campaigns", "reserve"), projectDir: project.projectDir, targetRoot: project.seed, seedRoot: project.seed,
    task, cycle: 1, fingerprint: "reserve-fingerprint", baseline: 0, threshold: 0.1,
    config: { ...defaultSearchConfig, batchSize: 3, maxRounds: 3 }, signal: new AbortController().signal,
    agent: task.agent, beforeAgentSpawn: () => {}, beforeEvaluatorSpawn: () => {},
    maxAgentAttempts: 2, maxEvaluatorAttempts: 2,
  };
  const completed = await runExperiment(options);
  assert.equal(completed.status, "complete", "search allowance exhaustion is a completed world that can still be promoted");
  assert.ok(completed.nodes.some((node) => node.valid), "completed candidate evidence remains available to promotion");
  const world = JSON.parse(fs.readFileSync(experimentWorldPath(options.root, 1), "utf8"));
  assert.ok(world.agentStarts <= 2);
  assert.ok(world.evaluatorRuns <= 2);
  assert.ok(world.agentStarts < 3, "at least one of the campaign grant's agent starts remains available for review");
  assert.ok(world.evaluatorRuns < 3, "the campaign grant stays within the evaluator reserve supplied by its caller");
});

test("a healthy attempt breaks the carried agent-error streak", async (t) => {
  const project = makeProject({ agent: "agent-streak.mjs" });
  t.after(project.cleanup);
  const counter = path.join(project.dir, "streak-count.txt");
  const task = normalizeTask(project.task);
  task.agent = { ...task.agent, output_format: "pi-json", env: { DREAM_STREAK_FILE: counter, DREAM_STREAK_MODE: "ok,error" } };
  const root = path.join(project.dreamRoot, "campaigns", "streak-reset");
  const options = {
    root, projectDir: project.projectDir, targetRoot: project.seed, seedRoot: project.seed, task,
    cycle: 1, fingerprint: "streak-fingerprint", baseline: 0, threshold: 0.1,
    config: { ...defaultSearchConfig, batchSize: 2, maxRounds: 1, patience: 1 }, signal: new AbortController().signal,
    agent: task.agent, beforeAgentSpawn: () => {}, beforeEvaluatorSpawn: () => {},
    maxAgentAttempts: 2, maxEvaluatorAttempts: 2, priorAgentErrorStreak: 2,
  };
  const world = await runExperiment(options);
  assert.equal(world.status, "complete", "one healthy attempt breaks the carried streak");
  assert.equal(world.nodes[0].failClass, "no_proposal");
  assert.equal(world.nodes[1].failClass, "agent_error");

  // Without the healthy attempt the carried streak reaches the breaker.
  const second = makeProject({ agent: "agent-streak.mjs" });
  t.after(second.cleanup);
  const secondCounter = path.join(second.dir, "streak-count.txt");
  const secondTask = normalizeTask(second.task);
  secondTask.agent = { ...secondTask.agent, output_format: "pi-json", env: { DREAM_STREAK_FILE: secondCounter, DREAM_STREAK_MODE: "error" } };
  await assert.rejects(runExperiment({
    ...options,
    root: path.join(second.dreamRoot, "campaigns", "streak-break"),
    projectDir: second.projectDir, targetRoot: second.seed, seedRoot: second.seed, task: secondTask,
    agent: secondTask.agent,
  }), /blocked: 3 consecutive non-editing agent attempts/);
});

test("an agent that exits with a failure code is an agent error, not a silent no-op", async (t) => {
  const project = makeProject({ agent: "agent-fail.mjs" });
  t.after(project.cleanup);
  const task = normalizeTask(project.task);
  const root = path.join(project.dreamRoot, "campaigns", "failed-agent");
  const world = await runExperiment({
    root, projectDir: project.projectDir, targetRoot: project.seed, seedRoot: project.seed, task,
    cycle: 1, fingerprint: "failed-agent-fingerprint", baseline: 0, threshold: 0.1,
    config: { ...defaultSearchConfig, batchSize: 1, maxRounds: 1 }, signal: new AbortController().signal,
    agent: task.agent, beforeAgentSpawn: () => {}, beforeEvaluatorSpawn: () => {},
    maxAgentAttempts: 1, maxEvaluatorAttempts: 1,
  });
  assert.equal(world.nodes[0].failClass, "agent_error");
  assert.match(world.nodes[0].error, /exited with code 3/);
  assert.equal(world.evaluatorRuns, 0, "a failed agent spends no evaluator run");
});

test("a completed experiment does not restart and patience uses strict threshold gain", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const task = normalizeTask(project.task);
  const options = {
    root: path.join(project.dreamRoot, "campaigns", "completed-world"), projectDir: project.projectDir, targetRoot: project.seed, seedRoot: project.seed,
    task, cycle: 1, fingerprint: "completed-fingerprint", baseline: 0, threshold: 0,
    config: { ...defaultSearchConfig, batchSize: 1, maxRounds: 3, patience: 1 }, signal: new AbortController().signal,
    agent: task.agent, beforeAgentSpawn: () => {}, beforeEvaluatorSpawn: () => {},
  };
  const first = await runExperiment(options);
  const second = await runExperiment({ ...options, beforeAgentSpawn: () => { throw new Error("completed world restarted"); } });
  assert.equal(second.agentStarts, first.agentStarts);
  assert.equal(second.rounds, first.rounds);
});
