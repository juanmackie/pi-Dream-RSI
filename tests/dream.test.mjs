import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { jump, makeProject } from "./fixtures.mjs";

const { replayWorld, worldValue, chooseSearchConfig, maybeDream } = await jump("engine/dream.ts");
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

test("config adoption requires both coverage and a strict score margin", () => {
  const incumbent = defaultSearchConfig;
  const winner = { ...incumbent, patience: 2 };
  assert.equal(chooseSearchConfig([{ config: winner, score: 0.5, coverage: 0.8 }, { config: incumbent, score: 0.48, coverage: 1 }], incumbent).patience, 2);
  assert.deepEqual(chooseSearchConfig([{ config: winner, score: 0.5, coverage: 0.59 }, { config: incumbent, score: 0.48, coverage: 1 }], incumbent), incumbent);
  assert.deepEqual(chooseSearchConfig([{ config: winner, score: 0.49, coverage: 1 }, { config: incumbent, score: 0.48, coverage: 1 }], incumbent), incumbent);
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
    agent: { ...project.task.agent, args: [agent] }, signal: new AbortController().signal, worlds: [dreamWorld(1), dreamWorld(2)], incumbent,
    beforeAgentSpawn: () => { charges += 1; } });
  assert.deepEqual(result, incumbent);
  assert.equal(charges, 1, "the agent start is charged before it is spawned");
  assert.equal(fs.existsSync(path.join(project.dreamRoot, "loop", "search-config.json")), false);
});

test("a completed dream durably saves the replay-selected config and consumed world ids", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const agent = path.join(project.projectDir, "dream-agent.mjs");
  fs.writeFileSync(agent, `import { writeFileSync } from "node:fs";\nlet prompt = ""; process.stdin.on("data", d => prompt += d);\nprocess.stdin.on("end", () => { const match = prompt.match(/Incumbent: (\\{[^\\n]+\\})/); const incumbent = JSON.parse(match[1]); writeFileSync("configs.json", JSON.stringify({ configs: [incumbent] })); });\n`);
  const loopRoot = path.join(project.dreamRoot, "loop");
  const incumbent = { ...defaultSearchConfig };
  const selected = await maybeDream({ projectDir: project.projectDir, loopRoot, agent: { ...project.task.agent, args: [agent] },
    signal: new AbortController().signal, worlds: [dreamWorld(1), dreamWorld(2)], incumbent, beforeAgentSpawn: () => {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(loopRoot, "search-config.json"), "utf8")), selected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(loopRoot, "dream-state.json"), "utf8")).worldIds, ["campaign:1", "campaign:2"]);
  assert.equal(fs.readFileSync(path.join(loopRoot, "dreams.jsonl"), "utf8").trim().split(/\r?\n/).length, 1);
});
