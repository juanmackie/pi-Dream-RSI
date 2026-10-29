import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { jump, makeProject } from "./fixtures.mjs";

const { replayWorld, worldValue, composeSearchConfig, validateSearchConfig, maybeDream } = await jump("engine/dream.ts");
const { defaultSearchConfig } = await jump("engine/experiment.ts");

test("replay reveals only recorded branch and refinement nodes", () => {
  const world = { version: 1, cycle: 1, status: "complete", fingerprint: "f", config: defaultSearchConfig,
    baseline: 1, threshold: 0.1, rounds: 2, stopped: "round limit", nodes: [
      { id: "n1", parent: null, kind: "branch", round: 1, seq: 1, stage: "done", score: 2, valid: true, failClass: "ok", timedOut: false, cost: 1, retries: 1 },
      { id: "n2", parent: null, kind: "branch", round: 1, seq: 2, stage: "done", score: 1.5, valid: true, failClass: "ok", timedOut: false, cost: 1, retries: 1 },
      { id: "n3", parent: "n1", kind: "refine", round: 2, seq: 3, stage: "done", score: 2.2, valid: true, failClass: "ok", timedOut: false, cost: 1, retries: 1 },
      { id: "n4", parent: null, kind: "branch", round: 2, seq: 4, stage: "done", score: 1.8, valid: true, failClass: "ok", timedOut: false, cost: 1, retries: 1 },
    ] };
  const result = replayWorld(world, { ...defaultSearchConfig, maxRounds: 2 });
  assert.equal(result.revealed.length, 4);
  assert.equal(result.coverage, 1);
  assert.equal(result.best, 2.2);
});

test("replay selects the earliest recorded child and applies the configured patience stop", () => {
  const world = { version: 1, cycle: 1, status: "complete", fingerprint: "f", config: defaultSearchConfig,
    baseline: 1, threshold: 0.1, rounds: 2, stopped: "round limit", nodes: [
      { id: "n1", parent: null, kind: "branch", round: 2, seq: 1, stage: "done", score: 1.01, valid: true, failClass: "ok", timedOut: false, cost: 1, retries: 1 },
      { id: "n2", parent: null, kind: "branch", round: 2, seq: 2, stage: "done", score: 1.02, valid: true, failClass: "ok", timedOut: false, cost: 1, retries: 1 },
    ] };
  const impatient = replayWorld(world, { ...defaultSearchConfig, batchSize: 1, exploreShare: 1, maxRounds: 3, patience: 1 });
  assert.deepEqual(impatient.revealed, ["n1"], "round labels do not prevent replaying the earliest legal child");
  assert.equal(impatient.rounds, 1, "patience stops after one round without the required gain");
  assert.equal(impatient.coverage, 0.5, "unrevealed recorded actions reduce coverage");
  const patient = replayWorld(world, { ...defaultSearchConfig, batchSize: 1, exploreShare: 1, maxRounds: 2, patience: 3 });
  assert.deepEqual(patient.revealed, ["n1", "n2"]);
  assert.equal(patient.coverage, 1);
});

test("zero threshold still requires strict improvement before resetting patience", () => {
  const world = { baseline: 1, threshold: 0, rounds: 3, nodes: [
    { id: "a", parent: null, kind: "branch", round: 1, seq: 1, stage: "done", score: 1, valid: true },
    { id: "b", parent: null, kind: "branch", round: 2, seq: 2, stage: "done", score: 1, valid: true },
    { id: "c", parent: null, kind: "branch", round: 3, seq: 3, stage: "done", score: 1, valid: true },
  ] };
  const replay = replayWorld(world, { ...defaultSearchConfig, batchSize: 1, exploreShare: 1, maxRounds: 3, patience: 1 });
  assert.equal(replay.rounds, 1);
});

test("world value rewards normalized gain and penalizes unnecessary rounds", () => {
  const world = { baseline: 10, threshold: 1, nodes: [{ score: 20, valid: true, stage: "done" }, { score: 18, valid: true, stage: "done" }], rounds: 2 };
  assert.equal(worldValue(world, { best: 20, revealed: ["n1", "n2"], coverage: 1, rounds: 2 }), 0.97);
});

test("meta proposals accept only the bounded SearchConfig data schema", () => {
  assert.deepEqual(validateSearchConfig(defaultSearchConfig), defaultSearchConfig);
  assert.equal(validateSearchConfig({ ...defaultSearchConfig, policyCode: "process.exit(1)" }), null);
  assert.equal(validateSearchConfig({ ...defaultSearchConfig, batchSize: 100 }), null);
});

test("contrastive compose blocks single-probe adoption and lucky best-run selection", () => {
  const incumbent = defaultSearchConfig;
  const stable = { ...incumbent, patience: 2 };
  const lucky = { ...incumbent, batchSize: 3 };
  const probes = (scores) => scores.map((score, index) => ({ worldId: `probe-${index + 1}`, score, coverage: 1 }));
  assert.deepEqual(composeSearchConfig([
    { config: incumbent, probes: probes([50, 50, 50]) },
    { config: stable, probes: probes([55, 55, 55]) },
    { config: lucky, probes: probes([95, 49, 49]) },
  ], incumbent), stable, "a spectacular best run cannot outweigh two regressions");
  assert.deepEqual(composeSearchConfig([
    { config: incumbent, probes: probes([50]) },
    { config: stable, probes: probes([95]) },
  ], incumbent), incumbent, "one probe is not enough");
  assert.deepEqual(composeSearchConfig([
    { config: incumbent, probes: probes([50, 50, 50]) },
    { config: stable, probes: probes([55, 49, 55]) },
  ], incumbent), incumbent, "one inconsistent probe blocks adoption");
});

test("compose honors the strict margin boundary and ranks by worst-probe improvement", () => {
  const incumbent = defaultSearchConfig;
  const smallWorst = { ...incumbent, patience: 2 };
  const largerMean = { ...incumbent, batchSize: 3 };
  const probes = (scores) => scores.map((score, index) => ({ worldId: `probe-${index + 1}`, score, coverage: 1 }));
  assert.deepEqual(composeSearchConfig([
    { config: incumbent, probes: probes([0.97, 0.97, 0.97]) },
    { config: smallWorst, probes: probes([0.98, 0.98, 0.98]) },
  ], incumbent), incumbent, "a nominal 0.01 improvement is not strictly above the margin");
  assert.deepEqual(composeSearchConfig([
    { config: incumbent, probes: probes([0, 0, 0]) },
    { config: smallWorst, probes: probes([0.2, 0.2, 0.2]) },
    { config: largerMean, probes: probes([0.5, 0.5, 0.15]) },
  ], incumbent), smallWorst, "the higher mean cannot outweigh a lower worst-probe margin");
});

test("contrastive compose requires the configured number of unique, covered probes", () => {
  const incumbent = defaultSearchConfig;
  const winner = { ...incumbent, patience: 2 };
  const probes = [1, 2, 3].map((id) => ({ worldId: `probe-${id}`, score: 1, coverage: 1 }));
  const candidate = [1, 2, 3].map((id) => ({ worldId: `probe-${id}`, score: 2, coverage: 1 }));
  assert.deepEqual(composeSearchConfig([
    { config: incumbent, probes }, { config: winner, probes: candidate },
  ], incumbent, 4), incumbent, "a higher configured k cannot be met by three probes");
  assert.deepEqual(composeSearchConfig([
    { config: incumbent, probes: [...probes, probes[0]] },
    { config: winner, probes: [...candidate, candidate[0]] },
  ], incumbent), winner, "duplicate identities do not inflate evidence count");
  assert.deepEqual(composeSearchConfig([
    { config: incumbent, probes },
    { config: winner, probes: candidate.map((probe, index) => ({ ...probe, coverage: index === 0 ? 0.59 : 1 })) },
  ], incumbent), incumbent, "low replay coverage blocks adoption");
});

function dreamWorld(cycle) {
  return { version: 1, worldId: `campaign:${cycle}`, cycle, status: "complete", fingerprint: `f${cycle}`, config: defaultSearchConfig,
    baseline: 1, threshold: 0.1, rounds: 1, stopped: "round limit", nodes: [1, 2, 3].map((seq) => ({
      id: `n${seq}`, parent: null, kind: "branch", round: 1, seq, stage: "done", score: 2 + seq / 10, valid: true,
      failClass: "ok", timedOut: false, cost: 1, retries: 1,
    })) };
}

test("malformed dream-agent output is ignored and the dream attempt is charged", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const agent = path.join(project.projectDir, "dream-agent.mjs");
  fs.writeFileSync(agent, `import { writeFileSync } from "node:fs";\nprocess.stdin.resume();\nprocess.stdin.on("end", () => writeFileSync("configs.json", "{ malformed"));\n`);
  let charges = 0;
  const incumbent = { ...defaultSearchConfig };
  const result = await maybeDream({ projectDir: project.projectDir, loopRoot: path.join(project.dreamRoot, "loop"),
    agent: { ...project.task.agent, args: [agent] }, signal: new AbortController().signal, worlds: [dreamWorld(1), dreamWorld(2), dreamWorld(3)], incumbent,
    beforeAgentSpawn: () => { charges += 1; } });
  assert.deepEqual(result, incumbent);
  assert.equal(charges, 1, "the agent start is charged before it is spawned");
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop", "search-config.json")), false);
});

test("dream requires three fresh world probes and does not reuse consumed probes", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const agent = path.join(project.projectDir, "dream-agent.mjs");
  fs.writeFileSync(agent, `import { writeFileSync } from "node:fs"; process.stdin.resume(); process.stdin.on("end", () => writeFileSync("configs.json", JSON.stringify({ configs: [] })));`);
  const loopRoot = path.join(project.dreamRoot, "loop");
  let charges = 0;
  const options = { projectDir: project.projectDir, loopRoot, agent: { ...project.task.agent, args: [agent] },
    signal: new AbortController().signal, beforeAgentSpawn: () => { charges += 1; } };
  const incumbent = { ...defaultSearchConfig };
  assert.deepEqual(await maybeDream({ ...options, worlds: [dreamWorld(1), dreamWorld(2)], incumbent }), incumbent);
  assert.equal(charges, 0, "two worlds cannot trigger a meta proposal");
  await maybeDream({ ...options, worlds: [dreamWorld(1), dreamWorld(2), dreamWorld(3)], incumbent });
  assert.equal(charges, 1);
  await maybeDream({ ...options, worlds: [1, 2, 3, 4, 5, 6].map(dreamWorld), incumbent });
  assert.equal(charges, 2, "three fresh worlds can form a new probe set");
  await maybeDream({ ...options, worlds: [1, 2, 3, 4, 5, 6, 7].map(dreamWorld), incumbent });
  assert.equal(charges, 2, "a later run cannot reuse probes consumed by any earlier dream");
  const records = fs.readFileSync(path.join(loopRoot, "dreams.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.worldIds), [
    ["campaign:1", "campaign:2", "campaign:3"], ["campaign:4", "campaign:5", "campaign:6"],
  ]);
  assert.equal(records[0].minProbes, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(loopRoot, "dream-state.json"), "utf8")).consumedWorldIds,
    ["campaign:1", "campaign:2", "campaign:3", "campaign:4", "campaign:5", "campaign:6"]);
});

test("corrupt probe state blocks proposals and failed config persistence consumes the probes", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const agent = path.join(project.projectDir, "dream-agent.mjs");
  fs.writeFileSync(agent, `import { writeFileSync } from "node:fs"; process.stdin.resume(); process.stdin.on("end", () => writeFileSync("configs.json", JSON.stringify({ configs: [] })));`);
  const loopRoot = path.join(project.dreamRoot, "loop");
  const options = { projectDir: project.projectDir, loopRoot, agent: { ...project.task.agent, args: [agent] },
    signal: new AbortController().signal, worlds: [dreamWorld(1), dreamWorld(2), dreamWorld(3)], incumbent: { ...defaultSearchConfig } };
  let charges = 0;
  options.beforeAgentSpawn = () => { charges += 1; };
  fs.mkdirSync(loopRoot, { recursive: true });
  fs.writeFileSync(path.join(loopRoot, "dream-state.json"), "{broken");
  assert.deepEqual(await maybeDream(options), options.incumbent);
  assert.equal(charges, 0, "corrupt state fails closed before proposal dispatch");
  fs.rmSync(path.join(loopRoot, "dream-state.json"));
  fs.mkdirSync(path.join(loopRoot, "search-config.json"));
  await assert.rejects(maybeDream(options));
  assert.equal(charges, 1);
  const state = JSON.parse(fs.readFileSync(path.join(loopRoot, "dream-state.json"), "utf8"));
  assert.deepEqual(state.consumedWorldIds, ["campaign:1", "campaign:2", "campaign:3"]);
  assert.deepEqual(await maybeDream(options), options.incumbent);
  assert.equal(charges, 1, "a failed config write cannot replay consumed evidence");
});

test("failure to persist consumed probes prevents config promotion and blocks retries", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const agent = path.join(project.projectDir, "dream-agent.mjs");
  fs.writeFileSync(agent, `import { mkdirSync, writeFileSync } from "node:fs"; process.stdin.resume(); process.stdin.on("end", () => { writeFileSync("configs.json", JSON.stringify({ configs: [] })); mkdirSync("../dream-state.json"); });`);
  const loopRoot = path.join(project.dreamRoot, "loop");
  let charges = 0;
  const incumbent = { ...defaultSearchConfig };
  const options = { projectDir: project.projectDir, loopRoot, agent: { ...project.task.agent, args: [agent] },
    signal: new AbortController().signal, worlds: [dreamWorld(1), dreamWorld(2), dreamWorld(3)], incumbent,
    beforeAgentSpawn: () => { charges += 1; } };
  await assert.rejects(maybeDream(options));
  assert.equal(charges, 1);
  assert.equal(fs.existsSync(path.join(loopRoot, "search-config.json")), false, "config cannot be promoted without persisted probe state");
  assert.equal(fs.existsSync(path.join(loopRoot, "dreams.jsonl")), false);
  assert.deepEqual(await maybeDream(options), incumbent, "the corrupt state blocks retries");
  assert.equal(charges, 1);
});

test("a completed dream durably saves the replay-selected config and consumed world ids", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const agent = path.join(project.projectDir, "dream-agent.mjs");
  fs.writeFileSync(agent, `import { writeFileSync } from "node:fs";\nlet prompt = ""; process.stdin.on("data", d => prompt += d);\nprocess.stdin.on("end", () => { const match = prompt.match(/Incumbent: (\\{[^\\n]+\\})/); const incumbent = JSON.parse(match[1]); writeFileSync("configs.json", JSON.stringify({ configs: [incumbent] })); });\n`);
  const loopRoot = path.join(project.dreamRoot, "loop");
  const incumbent = { ...defaultSearchConfig };
  const selected = await maybeDream({ projectDir: project.projectDir, loopRoot, agent: { ...project.task.agent, args: [agent] },
    signal: new AbortController().signal, worlds: [dreamWorld(1), dreamWorld(2), dreamWorld(3)], incumbent, beforeAgentSpawn: () => {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(loopRoot, "search-config.json"), "utf8")), selected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(loopRoot, "dream-state.json"), "utf8")).worldIds, ["campaign:1", "campaign:2", "campaign:3"]);
  assert.equal(fs.readFileSync(path.join(loopRoot, "dreams.jsonl"), "utf8").trim().split(/\r?\n/).length, 1);
});
