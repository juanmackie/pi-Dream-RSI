import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { jump, makeProject, mockPi } from "./fixtures.mjs";

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
    const reserved = [];
    const result = await campaign.runCampaign({ ...campaignOptions(project, project.task, { maxCycles: 1, maxAgentStarts: 1 }), beforeAgentSpawn: (key) => reserved.push(key) });
    assert.deepEqual(reserved, ["campaign-probe"], "shared reservations occur only after local capacity is available");
    assert.equal(result.agentStarts, 1);
    assert.equal(result.evaluatorRuns, 5, "all preflight baseline measurements are charged before the probe");
    assert.equal(result.completedCycles.length, 0);
    assert.equal(result.state.kind, "complete");
    assert.match(result.stopReason, /agent start limit reached/);
  } finally { project.cleanup(); }
});

test("campaign resolves the active agent model again at each spawned call", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const agent = path.join(project.projectDir, "capture-session-model.mjs");
    const output = path.join(project.dir, "models.jsonl");
    fs.writeFileSync(agent, `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";\nconst args = process.argv.slice(2); appendFileSync(${JSON.stringify(output)}, JSON.stringify(args) + "\\n");\nlet prompt = ""; process.stdin.on("data", d => prompt += d); process.stdin.on("end", () => { if (prompt.includes("Do not change files.")) { process.stdout.write("ready\\n"); return; } if (prompt.includes("prefix-only exploration policy")) return; const source = readFileSync("solution.py", "utf8"); writeFileSync("solution.py", source + "x\\n"); writeFileSync("proposal.md", "# candidate\\n");\nif (process.argv[3]) writeFileSync(process.argv[3], source + "x\\n"); });\n`);
    const task = { ...project.task, agent: { ...project.task.agent, args: [agent, output, "--model", "saved/model", "--thinking", "low"], model: "saved/model", thinking: "low" } };
    let active = { model: "session/first", thinking: "medium" };
    let resolverCalls = 0;
    const result = await campaign.runCampaign({
      ...campaignOptions(project, task, { maxCycles: 1, maxAgentStarts: 2 }),
      resolveAgent: (saved) => {
        resolverCalls += 1;
        const resolved = { ...saved, model: active.model, thinking: active.thinking };
        if (resolverCalls === 1) active = { model: "session/second", thinking: "high" };
        return resolved;
      },
    });
    assert.equal(result.state.kind, "complete");
    assert.ok(resolverCalls >= 2, "each actual spawned phase call resolves the current session config");
    const calls = fs.readFileSync(output, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(calls.slice(0, 2).map((args) => args[args.indexOf("--model") + 1]), ["session/first", "session/second"]);
    assert.deepEqual(calls.slice(0, 2).map((args) => args.slice(args.indexOf("--thinking") + 1, args.indexOf("--thinking") + 2)), [["medium"], ["high"]]);
  } finally { project.cleanup(); }
});

test("lower-is-better baseline initializes the best score below zero", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "cost-score.mjs");
    fs.writeFileSync(scorer, `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: 10, valid: true, fail_class: "ok", error: null }));\n`);
    const task = { ...project.task, score_program: `node "${scorer}"`, higher_is_better: false };
    const result = await campaign.runCampaign({ ...campaignOptions(project, task, { maxCycles: 1, maxAgentStarts: 1 }), verifierInputs: [scorer] });
    assert.equal(result.currentScore, -10);
    assert.equal(result.bestScore, -10);
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
    assert.match(result.stopReason, /preflight failed.*valid score/);
    assert.equal(result.agentStarts, 0);
    assert.equal(result.completedCycles.length, 0);
  } finally { project.cleanup(); }
});

test("campaign stops before any agent when noise makes meaningful effects undetectable", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "varying-score.mjs");
    const counter = path.join(project.dir, "baseline-count.txt");
    fs.writeFileSync(scorer, `import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";\nconst counter = ${JSON.stringify(counter)};\nconst n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;\nwriteFileSync(counter, String(n));\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: n % 2 ? 1 : 1000, valid: true, fail_class: "ok", error: null }));\n`);
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const result = await campaign.runCampaign({ ...campaignOptions(project, task, { maxCycles: 1 }), verifierInputs: [scorer], minimumGain: 0 });
    assert.equal(result.state.kind, "failed");
    assert.match(result.stopReason, /minimum detectable effect exceeds 50%/);
    assert.equal(result.evaluatorRuns, 5);
    assert.equal(result.agentStarts, 0);
    assert.equal(result.completedCycles.length, 0);
  } finally { project.cleanup(); }
});

test("omitted minimum gain tests positive improvement using five baseline measurements", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "varying-score.mjs");
    const counter = path.join(project.dir, "calibration-count.txt");
    fs.writeFileSync(scorer, `import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";\nconst counter = ${JSON.stringify(counter)};\nconst n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;\nwriteFileSync(counter, String(n));\nconst score = [10,12,11][n - 1] ?? 11;\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score, valid: true, fail_class: "ok", error: null }));\n`);
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const result = await campaign.runCampaign({ ...campaignOptions(project, task, { maxCycles: 1, maxAgentStarts: 1 }), verifierInputs: [scorer] });
    assert.equal(result.state.kind, "complete");
    assert.equal(result.evaluatorRuns, 5);
    const recordPath = path.join(result.campaignRoot, "campaign.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.equal(record.minimumGainSource, "calibrated");
    assert.equal(record.baselineScores.length, 5);
    assert.deepEqual(record.baselineScores, [10, 12, 11, 11, 11]);
    assert.equal(record.minimumGain, 0);
    assert.ok(record.checkReport.mde_rel > 0);
  } finally { project.cleanup(); }
});

test("noisy search scores rank candidates while paired confirmation enforces an explicit gain", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "calibrated-threshold-score.mjs");
    const counter = path.join(project.dir, "calibrated-threshold-count.txt");
    fs.writeFileSync(scorer, `import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";\nconst counter = ${JSON.stringify(counter)};\nconst n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;\nwriteFileSync(counter, String(n));\nconst source = readFileSync("solution.py", "utf8");\nconst score = n <= 3 ? [100,120,110][n - 1] : 100 + (source.match(/x/g) ?? []).length;\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score, valid: true, fail_class: "ok", error: null }));\n`);
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const result = await campaign.runCampaign({
      ...campaignOptions(project, task),
      verifierInputs: [scorer],
      limits: { maxCycles: 1, maxAgentStarts: 36, maxEvaluatorRuns: 100 },
      minimumGain: 30,
    });
    assert.equal(result.state.kind, "complete", result.stopReason);
    assert.ok(result.rejections.some((rejection) => rejection.stage === "verification"));
    const record = JSON.parse(fs.readFileSync(path.join(result.campaignRoot, "campaign.json"), "utf8"));
    assert.equal(record.minimumGain, 30);
    assert.equal(fs.existsSync(path.join(result.campaignRoot, "history", "applied.jsonl")), false);
  } finally { project.cleanup(); }
});

test("start rejects an evaluator path that escapes the scratch workspace", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const nested = path.join(project.projectDir, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "solution.py"), "print('nested')\n");
    const task = { ...project.task, workspace: "nested", score_program: "node ../score-ok.mjs" };
    await assert.rejects(
      campaign.runCampaign({ ...campaignOptions(project, task), verifierInputs: [path.join(project.projectDir, "score-ok.mjs")] }),
      /use an absolute path/i,
    );
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "campaigns")), false);
  } finally { project.cleanup(); }
});

test("failing unchanged-target gates stop before the probe and persist no target changes", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const gate = path.join(project.projectDir, "gate.mjs");
    fs.writeFileSync(gate, "process.exit(4);\n");
    const before = fs.readFileSync(path.join(project.seed, "solution.py"), "utf8");
    const result = await campaign.runCampaign({ ...campaignOptions(project), verifierInputs: [path.join(project.projectDir, "score-ok.mjs"), gate], gates: [`node "${gate}"`] });
    assert.equal(result.state.kind, "failed");
    assert.match(result.stopReason, /gate/i);
    assert.equal(result.agentStarts, 0);
    assert.equal(fs.readFileSync(path.join(project.seed, "solution.py"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(project.projectDir, "solution.py")), false);
  } finally { project.cleanup(); }
});

test("a gate that changes a declared input aborts before campaign work", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const gate = path.join(project.projectDir, "mutating-gate.mjs");
    fs.writeFileSync(gate, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(gate)}, "process.exit(0);\\n");\n`);
    const result = await campaign.runCampaign({ ...campaignOptions(project), verifierInputs: [path.join(project.projectDir, "score-ok.mjs"), gate], gates: [`node "${gate}"`] });
    assert.equal(result.state.kind, "failed");
    assert.match(result.stopReason, /identity changed during campaign/);
    assert.equal(result.agentStarts, 0);
    assert.equal(result.evaluatorRuns, 6, "five baselines and the mutating gate are charged");
  } finally { project.cleanup(); }
});

test("stop cancels a baseline evaluator and prevents the repeat start", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const marker = path.join(project.dir, "baseline-started");
    const scorer = path.join(project.projectDir, "slow-baseline.mjs");
    fs.writeFileSync(scorer, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "started");\nsetInterval(() => {}, 1000);\n`);
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const run = campaign.runCampaign({ ...campaignOptions(project, task, { maxCycles: 1 }), verifierInputs: [scorer] });
    await waitFor(() => fs.existsSync(marker));
    campaign.stopCampaign(project.dreamRoot);
    const result = await run;
    assert.equal(result.state.kind, "paused");
    assert.equal(result.evaluatorRuns, 1);
  } finally { project.cleanup(); }
});

test("candidate gate failure records a rejection and leaves the target untouched", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const gate = path.join(project.projectDir, "reject-added-marker.mjs");
    fs.writeFileSync(gate, `import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("solution.py", "utf8").includes("x") ? 3 : 0);\n`);
    const before = fs.readFileSync(path.join(project.seed, "solution.py"), "utf8");
    const result = await campaign.runCampaign({
      ...campaignOptions(project),
      gates: [`node "${gate}"`],
      verifierInputs: [path.join(project.projectDir, "score-ok.mjs"), gate],
      limits: { maxCycles: 1, maxAgentStarts: 36, maxEvaluatorRuns: 100 },
    });
    assert.equal(result.state.kind, "complete", result.stopReason);
    assert.ok(result.rejections.some((rejection) => rejection.stage === "gate"));
    assert.equal(fs.readFileSync(path.join(project.seed, "solution.py"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(result.campaignRoot, "history", "applied.jsonl")), false);
  } finally { project.cleanup(); }
});

test("review rejects missing and malformed verdicts within the confirmation budget", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const agent = path.join(project.projectDir, "review-agent.mjs");
    const counter = path.join(project.dir, "review-count.txt");
    fs.writeFileSync(agent, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";\nlet prompt = ""; process.stdin.on("data", d => prompt += d); process.stdin.on("end", () => {\nif (/adversarial review/i.test(prompt)) {\n  const counter = process.argv[2]; const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0; writeFileSync(counter, String(n + 1));\n  if (n === 0) return;\n  if (n === 1) writeFileSync("review.json", JSON.stringify({ verdict: "approved", reasons: [] }));\n  else writeFileSync("review.json", JSON.stringify({ verdict: "reject", reasons: ["The patch bypasses an acceptance case."] }));\n  return;\n}\nif (prompt.includes("Do not change files.")) { process.stdout.write("I can inspect this target.\\n"); return; }\nif (prompt.includes("prefix-only exploration policy")) return;\nconst source = readFileSync("solution.py", "utf8"); writeFileSync("solution.py", source + "x\\n"); writeFileSync("proposal.md", "# candidate\\n");\nif (process.argv[3]) writeFileSync(process.argv[3], source + "x\\n");\n});\n`);
    const task = { ...project.task, agent: { ...project.task.agent, args: [agent, counter] } };
    const result = await campaign.runCampaign({ ...campaignOptions(project, task), limits: { maxCycles: 1, maxAgentStarts: 36, maxEvaluatorRuns: 100 } });
    assert.equal(result.state.kind, "complete", result.stopReason);
    assert.equal(Number(fs.readFileSync(counter, "utf8")), 2, "two distinct candidates receive one counted review each");
    assert.ok(result.rejections.filter((item) => item.stage === "review").some((item) => /missing|review\.json/i.test(item.reasons.join(" "))));
    assert.ok(result.rejections.filter((item) => item.stage === "review").some((item) => /invalid|verdict/i.test(item.reasons.join(" "))));
    assert.equal(fs.existsSync(path.join(result.campaignRoot, "history", "applied.jsonl")), false);
    const ledger = JSON.parse(fs.readFileSync(path.join(result.campaignRoot, "campaign-processes.json"), "utf8"));
    assert.equal(ledger.agent_starts, result.agentStarts);
    assert.ok(ledger.agent_starts >= 3 + Number(fs.readFileSync(counter, "utf8")));
  } finally { project.cleanup(); }
});

test("accepted review applies the measured patch, not an edited review copy", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const agent = path.join(project.projectDir, "accept-review-agent.mjs");
    const counter = path.join(project.dir, "review-count.txt");
    const measuredPatch = path.join(project.dir, "measured-patch.py");
    fs.writeFileSync(agent, `import { existsSync, readFileSync, writeFileSync } from "node:fs";\nlet prompt = ""; process.stdin.on("data", d => prompt += d); process.stdin.on("end", () => {\nif (/adversarial review/i.test(prompt)) {\n  const counter = process.argv[2]; const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0; writeFileSync(counter, String(n + 1));\n  writeFileSync("review.json", JSON.stringify({ verdict: "accept", reasons: [] }));\n  writeFileSync("after/solution.py", "BROKEN\\n");\n  return;\n}\nif (prompt.includes("Do not change files.")) { process.stdout.write("I can inspect this target.\\n"); return; }\nif (prompt.includes("prefix-only exploration policy")) return;\nconst source = readFileSync("solution.py", "utf8"); writeFileSync("solution.py", source + "x\\n"); writeFileSync("proposal.md", "# candidate\\n");\nif (process.argv[3]) writeFileSync(process.argv[3], source + "x\\n");\n});\n`);
    const task = { ...project.task, agent: { ...project.task.agent, args: [agent, counter, measuredPatch] } };
    const result = await campaign.runCampaign({ ...campaignOptions(project, task), limits: { maxCycles: 1, maxAgentStarts: 36, maxEvaluatorRuns: 100 } });
    assert.equal(result.state.kind, "complete", result.stopReason);
    assert.ok(fs.existsSync(path.join(result.campaignRoot, "history", "applied.jsonl")));
    assert.ok(fs.existsSync(counter), "the reviewer actually ran");
    const applied = fs.readFileSync(path.join(project.seed, "solution.py"), "utf8");
    assert.equal(applied, fs.readFileSync(measuredPatch, "utf8"), "apply uses the exact bytes whose score was verified");
    const ledger = JSON.parse(fs.readFileSync(path.join(result.campaignRoot, "campaign-processes.json"), "utf8"));
    assert.ok(ledger.agent_starts >= 4, "probe, phase agents and review starts are reserved");
  } finally { project.cleanup(); }
});

test("a probe that edits a pinned evaluator aborts after preflight and before search", async () => {
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
    assert.equal(result.evaluatorRuns, 5);
  } finally { project.cleanup(); }
});

test("campaign deadline aborts an in-flight child instead of waiting for its agent timeout", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const agent = path.join(project.projectDir, "wait-for-campaign-end.mjs");
    fs.writeFileSync(agent, `import { writeFileSync } from "node:fs";\nwriteFileSync("started.marker", "yes");\nprocess.stdin.on("data", () => {});\nprocess.stdin.on("end", () => setInterval(() => {}, 1000));\n`);
    const task = { ...project.task, agent: { ...project.task.agent, args: [agent] }, agent_timeout_ms: 60_000 };
    const options = campaignOptions(project, task, { maxCycles: 1, deadlineMs: 15_000 });
    const started = Date.now();
    const resultPromise = campaign.runCampaign(options);
    let probeWorkspace;
    await waitFor(() => {
      const status = campaign.readCampaignStatus(project.dreamRoot);
      if (!status) return false;
      probeWorkspace = path.join(status.campaignRoot, "probe-workspace");
      return fs.existsSync(path.join(probeWorkspace, "started.marker"));
    }, 20_000);
    const result = await resultPromise;
    assert.ok(Date.now() - started < 30_000, "deadline should terminate the child before its 60s timeout");
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
    await assert.rejects(campaign.resumeCampaign({ baseRoot: project.dreamRoot, projectDir: project.projectDir }), /campaign is already running/);
    const stopped = campaign.stopCampaign(project.dreamRoot);
    assert.equal(stopped?.state.kind, "running");
    const paused = await run;
    assert.equal(paused.state.kind, "paused");
    assert.equal(paused.agentStarts, 1);

    const recordPath = path.join(paused.campaignRoot, "campaign.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.state = { kind: "running", phase: "probe", iteration: null };
    delete record.gates;
    delete record.minimumGainSource;
    delete record.baselineScores;
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    const { default: dreamRsi } = await jump("index.ts");
    const ownerLock = path.join(paused.campaignRoot, "campaign.lock");
    fs.writeFileSync(ownerLock, JSON.stringify({ session_id: "active-test-owner", pid: process.pid, claimed_at: new Date().toISOString() }));
    const activeHarness = mockPi();
    dreamRsi(activeHarness.pi);
    activeHarness.context.cwd = project.projectDir;
    await activeHarness.harness.handlers.get("session_start")({}, activeHarness.context);
    await activeHarness.harness.commands.get("dream-rsi").handler("resume", activeHarness.context);
    assert.equal(activeHarness.harness.sentMessages.length, 0, "a live owner is not routed through resume");
    fs.rmSync(ownerLock, { force: true });
    const { pi, context, harness } = mockPi();
    dreamRsi(pi);
    context.cwd = project.projectDir;
    await harness.handlers.get("session_start")({}, context);
    await harness.commands.get("dream-rsi").handler("resume", context);
    assert.equal(harness.sentMessages.at(-1).content, "/skill:dream-rsi-improve resume", "the command routes stale running records through the guarded resume path");

    fs.writeFileSync(gate, "resume\n");
    const resumed = await campaign.resumeCampaign({ baseRoot: project.dreamRoot, projectDir: project.projectDir });
    assert.equal(resumed.agentStarts, 2);
    assert.ok(resumed.agentStarts <= resumed.limits.maxAgentStarts);
    assert.equal(resumed.state.kind, "complete");
    assert.match(resumed.stopReason, /agent start limit reached/);
  } finally { project.cleanup(); }
});
