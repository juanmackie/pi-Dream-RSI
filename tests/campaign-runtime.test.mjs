import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { jump, makeProject } from "./fixtures.mjs";

const waitFor = async (predicate, timeoutMs = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for campaign fixture state");
};

function campaignOptions(project, task = project.task, limits = {}) {
  return {
    baseRoot: project.dreamRoot,
    projectDir: project.projectDir,
    task,
    goal: "Increase the number of x markers without breaking validity.",
    scope: ["solution.py"],
    verifierInputs: [path.join(project.projectDir, "score-ok.mjs")],
    limits,
  };
}

test("campaign reserves the probe before spawn and stops at the actual agent-start cap", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const result = await campaign.runCampaign(campaignOptions(project, project.task, { maxCycles: 1, maxAgentStarts: 1 }));
    assert.equal(result.agentStarts, 1);
    assert.equal(result.evaluatorRuns, 2, "both initial and repeat baseline measurements are charged");
    assert.equal(result.completedCycles.length, 0);
    assert.equal(result.state.kind, "complete");
    assert.match(result.stopReason, /agent start limit reached/);
  } finally { project.cleanup(); }
});

test("campaign status distinguishes a malformed active pointer from no campaign", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const campaigns = path.join(project.dreamRoot, "campaigns");
    fs.mkdirSync(campaigns, { recursive: true });
    fs.writeFileSync(path.join(campaigns, "active.json"), "{broken json\n");
    assert.throws(() => campaign.readCampaignStatus(project.dreamRoot), /active campaign pointer is malformed/);
    assert.throws(() => campaign.stopCampaign(project.dreamRoot), /active campaign pointer is malformed/);
    const id = "9adbe676-5990-4c8c-b5c8-a32bd84ce188";
    fs.mkdirSync(path.join(campaigns, id), { recursive: true });
    fs.writeFileSync(path.join(campaigns, "active.json"), JSON.stringify({ id }));
    assert.throws(() => campaign.readCampaignStatus(project.dreamRoot), /active campaign record is unreadable/);
  } finally { project.cleanup(); }
});

test("concurrent starts serialize on one active campaign pointer", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const options = campaignOptions(project, project.task, { maxCycles: 1, maxAgentStarts: 1 });
    const first = campaign.runCampaign(options);
    const second = campaign.runCampaign(options);
    const settled = await Promise.allSettled([first, second]);
    assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
    const status = campaign.readCampaignStatus(project.dreamRoot);
    assert.ok(status);
    assert.match(settled.find((item) => item.status === "rejected").reason.message, /unfinished campaign|campaign-start/);
    const campaignRoots = fs.readdirSync(path.join(project.dreamRoot, "campaigns"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.equal(campaignRoots.length, 1);
    assert.equal(path.basename(status.campaignRoot), campaignRoots[0].name);
  } finally { project.cleanup(); }
});

test("campaign rejects a baseline the evaluator marks invalid even when fail_class says ok", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "invalid-but-numbered.mjs");
    fs.writeFileSync(scorer, `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: 1000, valid: false, fail_class: "ok", error: null }));\n`);
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const result = await campaign.runCampaign({ ...campaignOptions(project, task, { maxCycles: 1 }), verifierInputs: [scorer] });
    assert.equal(result.state.kind, "failed");
    assert.match(result.stopReason, /trustworthy baseline/);
    assert.equal(result.completedCycles.length, 0);
  } finally { project.cleanup(); }
});

test("campaign stops before live when repeated baseline scores exceed the declared tolerance", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "varying-score.mjs");
    fs.writeFileSync(scorer, `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: Math.random() * 1000, valid: true, fail_class: "ok", error: null }));\n`);
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const result = await campaign.runCampaign({ ...campaignOptions(project, task, { maxCycles: 1 }), verifierInputs: [scorer], minimumGain: 0 });
    assert.equal(result.state.kind, "failed");
    assert.match(result.stopReason, /repeated baseline changed/);
    assert.equal(result.evaluatorRuns, 2);
    assert.equal(result.completedCycles.length, 0);
  } finally { project.cleanup(); }
});

test("a probe that edits a pinned evaluator aborts before the first evaluation", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "score-ok.mjs");
    const agent = path.join(project.projectDir, "tamper-pinned-evaluator.mjs");
    fs.writeFileSync(agent, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(scorer)}, "process.exit(0);\\n");\nprocess.stdin.on("data", () => {});\nprocess.stdin.on("end", () => {});\n`);
    const task = { ...project.task, agent: { ...project.task.agent, args: [agent] } };
    const result = await campaign.runCampaign(campaignOptions(project, task, { maxCycles: 1 }));
    assert.equal(result.state.kind, "failed");
    assert.match(result.stopReason, /identity changed/);
    assert.equal(result.agentStarts, 1);
    assert.equal(result.evaluatorRuns, 0);
  } finally { project.cleanup(); }
});

test("campaign deadline aborts an in-flight child instead of waiting for its agent timeout", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const agent = path.join(project.projectDir, "wait-for-campaign-end.mjs");
    fs.writeFileSync(agent, `import { writeFileSync } from "node:fs";\nwriteFileSync("started.marker", "yes");\nprocess.stdin.on("data", () => {});\nprocess.stdin.on("end", () => setInterval(() => {}, 1000));\n`);
    const task = { ...project.task, agent: { ...project.task.agent, args: [agent] }, agent_timeout_ms: 30_000 };
    const options = campaignOptions(project, task, { maxCycles: 1, deadlineMs: 2500 });
    const started = Date.now();
    const resultPromise = campaign.runCampaign(options);
    let probeWorkspace;
    await waitFor(() => {
      const status = campaign.readCampaignStatus(project.dreamRoot);
      if (!status) return false;
      probeWorkspace = path.join(status.campaignRoot, "probe-workspace");
      return fs.existsSync(path.join(probeWorkspace, "started.marker"));
    });
    const result = await resultPromise;
    assert.ok(Date.now() - started < 7000, "deadline should terminate the child before its 30s timeout");
    assert.equal(result.state.kind, "complete");
    assert.match(result.stopReason, /deadline expired/);
    assert.equal(fs.existsSync(path.join(project.seed, "started.marker")), false);
  } finally { project.cleanup(); }
});

test("stop pauses durably and explicit resume consumes the same agent-start budget", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const gate = path.join(project.dir, "resume-gate");
    const agent = path.join(project.projectDir, "pause-until-resume.mjs");
    fs.writeFileSync(agent, `import { existsSync, writeFileSync } from "node:fs";\nconst gate = ${JSON.stringify(gate)};\nwriteFileSync("started.marker", "yes");\nprocess.stdin.on("data", () => {});\nprocess.stdin.on("end", () => { const poll = setInterval(() => { if (existsSync(gate)) { clearInterval(poll); process.exit(0); } }, 20); });\n`);
    const task = { ...project.task, agent: { ...project.task.agent, args: [agent] }, agent_timeout_ms: 30_000 };
    const run = campaign.runCampaign(campaignOptions(project, task, { maxCycles: 1, maxAgentStarts: 2 }));
    await waitFor(() => {
      const status = campaign.readCampaignStatus(project.dreamRoot);
      return status?.state.kind === "running" && status.state.phase === "probe" && fs.existsSync(path.join(status.campaignRoot, "probe-workspace", "started.marker"));
    });
    const stopped = campaign.stopCampaign(project.dreamRoot);
    assert.equal(stopped?.state.kind, "running");
    const paused = await run;
    assert.equal(paused.state.kind, "paused");
    assert.equal(paused.agentStarts, 1);

    fs.writeFileSync(gate, "resume\n");
    const resumed = await campaign.resumeCampaign({ baseRoot: project.dreamRoot, projectDir: project.projectDir });
    assert.equal(resumed.agentStarts, 2);
    assert.ok(resumed.agentStarts <= resumed.limits.maxAgentStarts);
    assert.equal(resumed.state.kind, "complete");
    assert.match(resumed.stopReason, /agent start limit reached/);
  } finally { project.cleanup(); }
});
