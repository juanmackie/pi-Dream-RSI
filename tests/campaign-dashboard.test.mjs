import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { jump, makeProject } from "./fixtures.mjs";

const { readProgress, progressPath, progressSummary } = await jump("engine/progress.ts");
const { DashboardView } = await jump("dashboard.ts");

function seedCampaign(project) {
  const id = "12345678-1234-1234-1234-123456789abc";
  const campaigns = path.join(project.dreamRoot, "campaigns");
  const root = path.join(campaigns, id);
  const cycle = path.join(root, "cycles", "c0001");
  fs.mkdirSync(cycle, { recursive: true });
  fs.mkdirSync(path.join(cycle, "attempts", "n1"), { recursive: true });
  fs.writeFileSync(path.join(cycle, "attempts", "n1", "agent.log"), "candidate output\n");
  const config = { version: 1, batchSize: 2, exploreShare: 0.5, refineTop: 1, maxRounds: 3, patience: 1 };
  fs.writeFileSync(path.join(campaigns, "active.json"), JSON.stringify({ id }));
  fs.writeFileSync(path.join(root, "campaign-processes.json"), JSON.stringify({
    version: 1, agent_limit: 36, evaluator_limit: 100, agent_starts: 1, evaluator_runs: 0, last_start: null,
  }));
  fs.writeFileSync(path.join(root, "campaign.json"), JSON.stringify({
    version: 1, id, baseRoot: project.dreamRoot, campaignRoot: root, projectDir: project.projectDir,
    targetRoot: project.projectDir, task: {},
    limits: { maxCycles: 5, maxAgentStarts: 36, maxEvaluatorRuns: 100, deadlineMs: 3600000 }, completedCycles: [],
    state: { kind: "running", phase: "experiment", iteration: 1 }, searchConfig: config,
  }));
  fs.writeFileSync(path.join(cycle, "world.json"), JSON.stringify({
    version: 1, cycle: 1, status: "running", fingerprint: "fixture", config, baseline: 10,
    threshold: 1, rounds: 1, agentStarts: 1, evaluatorRuns: 0, stopped: null,
    nodes: [{ id: "n1", parent: null, kind: "branch", round: 1, seq: 1, stage: "agent", score: null,
      valid: false, failClass: null, timedOut: false, cost: 1, retries: 1 }],
  }));
  return { root, cycle };
}

test("progress rebuilds from world.json when the progress snapshot is missing", (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const campaign = seedCampaign(project);
  const snapshot = readProgress(campaign.root, 1);
  assert.ok(snapshot);
  assert.equal(fs.existsSync(progressPath(campaign.root, 1)), false);
  assert.equal(snapshot.phase, "experiment");
  assert.equal(snapshot.attempts.n1.kind, "branch");
  assert.equal(snapshot.attempts.n1.stage, "agent");
  assert.equal(snapshot.best, 10);
  assert.match(progressSummary(snapshot), /experiment 1: running/);
});

test("dashboard displays experiment attempts and the adopted search config", (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const campaign = seedCampaign(project);
  const dreams = path.join(project.dreamRoot, "loop", "dreams.jsonl");
  fs.mkdirSync(path.dirname(dreams), { recursive: true });
  fs.writeFileSync(dreams, `${JSON.stringify({ at: "2026-10-01T12:00:00.000Z", adopted: { version: 1, batchSize: 2, exploreShare: 0.5, refineTop: 1, maxRounds: 3, patience: 1 } })}\n`);
  const view = new DashboardView(campaign.root, 1);
  const theme = { fg: (_color, value) => value, bold: (value) => value,
    getBgAnsi: () => "\x1b[48;5;236m", bg: (_color, value) => `\x1b[48;5;236m${value}\x1b[0m` };
  const rendered = view.framed(100, theme, 24).join("\n");
  assert.match(rendered, /n1 ← root branch r1 agent/);
  assert.match(rendered, /search b2\/e0\.5\/r1×3\/p1/);
  assert.match(rendered, /adopted 2026-10-01/);
});
