import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { jump, makeProject } from "./fixtures.mjs";

const { readProgress, progressPath, progressSummary } = await jump("engine/progress.ts");
const { DashboardView } = await jump("dashboard.ts");
const campaignModule = await jump("engine/campaign.ts");

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

test("loop watch follows preflight into campaign progress and does not retain an old campaign", (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { readCampaignRef, readCampaignStatus } = campaignModule;
  let live = { lines: ["Active loop: running; phase: discovery", "Work: probing the pinned workload"], campaignRoot: null };
  const view = new DashboardView(project.dreamRoot, undefined, () => live);
  assert.match(view.plain(100).join("\n"), /phase: discovery/);
  assert.doesNotMatch(view.plain(100).join("\n"), /cycle 1/);
  const campaign = seedCampaign(project);
  live = { lines: ["Active loop: running; phase: campaign"], campaignRoot: campaign.root };
  view.refresh();
  assert.match(view.plain(100).join("\n"), /n1 ← root branch r1 agent/);
  live = { lines: ["Active loop: running; phase: discovery"], campaignRoot: null };
  view.refresh();
  assert.doesNotMatch(view.plain(100).join("\n"), /n1 ← root/, "a new discovery pass must not look like the prior campaign");
  const theme = { fg: (_color, value) => value, bold: value => value, getBgAnsi: () => "", bg: (_color, value) => value };
  for (const width of [8, 20, 100]) for (const height of [1, 3, 12]) {
    const lines = view.framed(width, theme, height);
    assert.ok(lines.length <= height);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  fs.mkdirSync(path.join(campaign.root, "history"), { recursive: true });
  fs.writeFileSync(path.join(campaign.root, "history", "ledger.jsonl"), "{}\n");
  assert.deepEqual(readCampaignRef(project.dreamRoot), { id: path.basename(campaign.root), campaignRoot: campaign.root, state: { kind: "running", phase: "experiment", iteration: 1 } });
  assert.throws(() => readCampaignStatus(project.dreamRoot), /ledger integrity/i, "the full status path still validates ledger integrity");
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

test("dashboard summarizes score movement and exposes a readable candidate-run table", (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const campaign = seedCampaign(project);
  const worldPath = path.join(campaign.cycle, "world.json");
  const world = JSON.parse(fs.readFileSync(worldPath, "utf8"));
  world.threshold = 1;
  world.nodes.push(
    { id: "n2", parent: "n1", kind: "refine", round: 2, seq: 2, stage: "done", score: 12.5, valid: true, failClass: "ok", timedOut: false, cost: 1, retries: 1 },
    { id: "n3", parent: null, kind: "branch", round: 2, seq: 3, stage: "done", score: null, valid: false, failClass: "agent_error", agentError: true, edited: false, timedOut: false, cost: 1, retries: 1 },
    { id: "n4", parent: null, kind: "branch", round: 2, seq: 4, stage: "done", score: null, valid: false, failClass: "timeout", timedOut: true, cost: 1, retries: 1 },
  );
  fs.writeFileSync(worldPath, JSON.stringify(world));
  const legacySnapshot = readProgress(campaign.root, 1);
  delete legacySnapshot.baseline; delete legacySnapshot.threshold;
  for (const attempt of Object.values(legacySnapshot.attempts)) {
    delete attempt.seq; delete attempt.valid; delete attempt.failClass; delete attempt.agentError; delete attempt.edited; delete attempt.cost;
  }
  fs.writeFileSync(progressPath(campaign.root, 1), JSON.stringify(legacySnapshot));
  const view = new DashboardView(campaign.root, 1);
  const summary = view.plain(180).join("\n");
  assert.match(summary, /baseline 10 · Δ \+2\.5 · valid 1 · invalid 2 · agent errors 1 · timeouts 1/);
  view.handleInput("\t"); view.handleInput("\t"); view.handleInput("\t");
  const table = view.plain(180).join("\n");
  assert.match(table, /Candidate runs · 4 total/);
  assert.match(table, /n2 refine .*done.*12\.5.*\+2\.5.*valid/);
  assert.match(table, /n3 branch .*agent error/);
  assert.match(table, /n4 branch .*timeout/);
  assert.doesNotMatch(table, /kept|discarded/, "candidate validity is not the same as campaign adoption");
});
