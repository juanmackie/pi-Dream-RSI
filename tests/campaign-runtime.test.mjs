import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { jump, makeProject, mockPi } from "./fixtures.mjs";

const { failPausedV2Campaign, pruneCampaignWork } = await jump("engine/campaign.ts");

const waitFor = async (predicate, timeoutMs = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for campaign fixture state");
};

test("a paused 2.x campaign is marked failed with the 3.0 restart path", () => {
  const project = makeProject();
  try {
    const id = "aaaaaaaaaaaaaaaa";
    const campaignRoot = path.join(project.dreamRoot, "campaigns", id);
    fs.mkdirSync(campaignRoot, { recursive: true });
    fs.writeFileSync(path.join(project.dreamRoot, "campaigns", "active.json"), JSON.stringify({ id }));
    const recordPath = path.join(campaignRoot, "campaign.json");
    fs.writeFileSync(recordPath, JSON.stringify({ version: 1, id, state: { kind: "paused", phase: "live", iteration: "iter1" }, engine: "live" }));

    const reason = failPausedV2Campaign(project.dreamRoot);
    const migrated = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.equal(migrated.state.kind, "failed");
    assert.match(reason, /2\.x.*cannot resume in 3\.0/);
    assert.match(migrated.state.reason, /start a new \/dream-rsi loop/);
  } finally { fs.rmSync(project.dir, { recursive: true, force: true }); }
});

test("a campaign record without magnitude fields still reads, and the new fields stay optional", async () => {
  const project = makeProject();
  try {
    const { readCampaignStatus } = await jump("engine/campaign.ts");
    const id = "bbbbbbbbbbbbbbbb";
    const campaignRoot = path.join(project.dreamRoot, "campaigns", id);
    fs.mkdirSync(campaignRoot, { recursive: true });
    fs.writeFileSync(path.join(project.dreamRoot, "campaigns", "active.json"), JSON.stringify({ id }));
    const limits = { maxCycles: 1, maxAgentStarts: 2, maxEvaluatorRuns: 4, deadlineMs: 60_000, plateauCycles: 1, maxCandidatesPerCycle: 2 };
    const record = {
      version: 1, id, baseRoot: project.dreamRoot, campaignRoot,
      projectDir: project.projectDir, targetRoot: project.projectDir,
      goal: "Improve the fixture", task: project.task, scope: ["solution.py"],
      verifierInputs: [], verifierIdentity: "identity", taskFingerprint: "fingerprint",
      searchConfig: { version: 1, batchSize: 2, exploreShare: 0.5, refineTop: 1, maxRounds: 3, patience: 1 },
      minimumGain: 1, limits,
      startedAt: "2026-10-31T00:00:00.000Z", deadlineAt: "2026-10-31T00:01:00.000Z",
      completedCycles: [], currentScore: 1, bestScore: 1, noGainCycles: 0,
      state: { kind: "complete", reason: "done" },
    };
    const recordPath = path.join(campaignRoot, "campaign.json");
    fs.writeFileSync(recordPath, JSON.stringify(record));
    fs.writeFileSync(path.join(campaignRoot, "campaign-processes.json"), JSON.stringify({
      version: 1, agent_limit: limits.maxAgentStarts, evaluator_limit: limits.maxEvaluatorRuns,
      agent_starts: 0, evaluator_runs: 0, last_start: null,
    }));

    const legacy = readCampaignStatus(project.dreamRoot);
    assert.equal(legacy?.id, id);
    assert.equal(legacy?.campaignType, undefined, "an older record stays readable without the new field");
    assert.equal(legacy?.strategy, undefined);

    fs.writeFileSync(recordPath, JSON.stringify({ ...record, campaignType: "algorithmic", strategy: "Replace the nested scan with an index." }));
    const typed = readCampaignStatus(project.dreamRoot);
    assert.equal(typed?.campaignType, "algorithmic");
    assert.equal(typed?.strategy, "Replace the nested scan with an index.");
  } finally { project.cleanup(); }
});

test("campaign retention prunes only workspaces older than the two newest terminal campaigns", () => {
  const project = makeProject();
  try {
    for (let index = 1; index <= 4; index += 1) {
      const root = path.join(project.dreamRoot, "campaigns", `retention-${index}`);
      const cycle = path.join(root, "cycles", "c0001");
      fs.mkdirSync(path.join(cycle, "work"), { recursive: true });
      fs.mkdirSync(path.join(cycle, "seed"), { recursive: true });
      fs.writeFileSync(path.join(cycle, "world.json"), "{}\n");
      fs.writeFileSync(path.join(root, "campaign.json"), JSON.stringify({ version: 1, startedAt: `2026-10-0${index}T00:00:00.000Z`, state: { kind: "complete", reason: "done" } }));
    }
    const pausedRoot = path.join(project.dreamRoot, "campaigns", "paused");
    const pausedCycle = path.join(pausedRoot, "cycles", "c0001");
    fs.mkdirSync(path.join(pausedCycle, "work"), { recursive: true });
    fs.writeFileSync(path.join(pausedRoot, "campaign.json"), JSON.stringify({ version: 1, startedAt: "2026-10-09T00:00:00.000Z", state: { kind: "paused", phase: "experiment", iteration: 1 } }));

    pruneCampaignWork(project.dreamRoot);
    for (let index = 1; index <= 2; index += 1) {
      const cycle = path.join(project.dreamRoot, "campaigns", `retention-${index}`, "cycles", "c0001");
      assert.equal(fs.existsSync(path.join(cycle, "work")), false);
      assert.equal(fs.existsSync(path.join(cycle, "seed")), false);
      assert.equal(fs.existsSync(path.join(cycle, "world.json")), true);
    }
    for (const name of ["retention-3", "retention-4", "paused"]) {
      assert.equal(fs.existsSync(path.join(project.dreamRoot, "campaigns", name, "cycles", "c0001", "work")), true);
    }
  } finally { project.cleanup(); }
});

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

test("start refuses caps that cannot fund one promotion before any scorer call", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "refusal-count.mjs");
    const counter = path.join(project.dir, "refusal-count.txt");
    fs.writeFileSync(scorer, `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, "x");\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: 0, valid: true, fail_class: "ok", error: null }));\n`);
    const gate = (name) => { const file = path.join(project.projectDir, name); fs.writeFileSync(file, "process.exit(0);\n"); return file; };
    const gateA = gate("refusal-gate-a.mjs");
    const gateB = gate("refusal-gate-b.mjs");
    const task = { ...project.task, score_program: `node "${scorer}"` };
    await assert.rejects(
      campaign.runCampaign({
        ...campaignOptions(project, task, { maxCycles: 1, maxAgentStarts: 4, maxEvaluatorRuns: 8 }),
        verifierInputs: [scorer, gateA, gateB],
        gates: [`node "${gateA}"`, `node "${gateB}"`],
      }),
      (error) => error instanceof campaign.CampaignInfeasibleError
        && /8 evaluator run\(s\) remain but 9 are needed/.test(error.message)
        && /Recommended caps: max_evaluator_runs >= 11, max_agent_starts >= 3/.test(error.message),
    );
    assert.equal(fs.existsSync(counter), false, "no evaluator reading is paid for");
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "campaigns")), false, "no campaign directory is created");
  } finally { project.cleanup(); }
});

test("campaign pays for the baseline first and reserves the first experiment attempt before spawn", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const reserved = [];
    const result = await campaign.runCampaign({
      ...campaignOptions(project, project.task, { maxCycles: 1 }),
      beforeAgentSpawn: (key) => { reserved.push(key); throw new Error("cheap stop at the first experiment attempt"); },
    });
    assert.deepEqual(reserved, ["experiment-1-n1"], "the first saved attempt is reserved before the test stops the run");
    assert.equal(result.agentStarts, 1);
    assert.equal(result.evaluatorRuns, 5, "the baseline is paid before the probe");
    assert.equal(result.state.kind, "failed");
    assert.match(result.stopReason, /cheap stop at the first experiment attempt/);
    assert.ok(result.check?.qualified, "the status exposes the qualified check");
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.campaignRoot, "cycles", "c0001", "world.json"), "utf8")).nodes[0].id, "n1");

    const ledgerFile = path.join(result.campaignRoot, "history", "ledger.jsonl");
    const lines = fs.readFileSync(ledgerFile, "utf8").trim().split(/\r?\n/);
    assert.ok(lines.length > 1, "the fixture records campaign events before the probe stops");
    const tampered = JSON.parse(lines[0]);
    tampered.facts = { ...(tampered.facts ?? {}), edited: true };
    fs.writeFileSync(ledgerFile, `${[JSON.stringify(tampered), ...lines.slice(1)].join("\n")}\n`);
    assert.throws(() => campaign.readCampaignStatus(project.dreamRoot), /experiment ledger integrity check failed.*hash chain/);
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
      ...campaignOptions(project, task, { maxCycles: 1 }),
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
    // The diagnostic keeps a platform-only failure actionable: it reports why the
    // second spawn did not happen instead of only that it did not.
    const observed = {
      stopReason: result.stopReason,
      state: result.state,
      agentStarts: result.agentStarts,
      evaluatorRuns: result.evaluatorRuns,
      resolverCalls,
      recordedCalls: calls.length,
    };
    assert.deepEqual(
      calls.slice(0, 2).map((args) => args[args.indexOf("--model") + 1]),
      ["session/first", "session/second"],
      `per-spawn model resolution; observed ${JSON.stringify(observed)}`,
    );
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
    const result = await campaign.runCampaign({
      ...campaignOptions(project, task, { maxCycles: 1 }),
      verifierInputs: [scorer],
      beforeAgentSpawn: () => { throw new Error("cheap stop at the campaign probe"); },
    });
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
    const options = campaignOptions(project, project.task, { maxCycles: 1 });
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
    const result = await campaign.runCampaign({
      ...campaignOptions(project, task, { maxCycles: 1 }),
      verifierInputs: [scorer],
      beforeAgentSpawn: () => { throw new Error("cheap stop at the campaign probe"); },
    });
    assert.equal(result.state.kind, "failed");
    assert.match(result.stopReason, /cheap stop at the campaign probe/);
    assert.equal(result.evaluatorRuns, 5);
    const recordPath = path.join(result.campaignRoot, "campaign.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.equal(record.minimumGainSource, "calibrated");
    assert.equal(record.baselineScores.length, 5);
    assert.deepEqual(record.baselineScores, [10, 12, 11, 11, 11]);
    assert.equal(record.minimumGain, 0);
    assert.ok(record.checkReport.mde_rel > 0);
    assert.equal(record.checkReport.runs.length, 5, "the check reads all five planned baselines when they are valid");
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
    assert.ok(ledger.agent_starts >= 3, "experiment attempts and review starts are reserved");
    const resourceEntries = fs.readFileSync(path.join(result.campaignRoot, "history", "ledger.jsonl"), "utf8")
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(resourceEntries.filter((entry) => entry.kind === "agent_start").length, ledger.agent_starts, "each reserved agent start is recorded in the append-only ledger");
    assert.ok(resourceEntries.some((entry) => entry.kind === "agent_result" && entry.agentDurationMs > 0 && entry.usage), "campaign ledger records each agent process time and token usage");
    assert.ok(["experiment", "review"].every((role) => resourceEntries.some((entry) => entry.kind === "agent_result" && entry.agentRole === role)), "experiment and review resource records are captured");
    assert.ok(resourceEntries.some((entry) => ["confirm", "gate", "check"].includes(entry.kind) && entry.evaluatorDurationMs > 0), "campaign ledger records measured evaluator process time");
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
    await waitFor(() => {
      const status = campaign.readCampaignStatus(project.dreamRoot);
      if (!status) return false;
      return status.state.phase === "experiment"
        && fs.existsSync(path.join(status.campaignRoot, "cycles", "c0001", "work", "n1", "started.marker"));
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
  let campaign;
  let run;
  try {
    campaign = await jump("engine/campaign.ts");
    const gate = path.join(project.dir, "resume-gate");
    const agent = path.join(project.projectDir, "pause-until-resume.mjs");
    fs.writeFileSync(agent, `import { existsSync, writeFileSync } from "node:fs";\nconst gate = ${JSON.stringify(gate)};\nwriteFileSync("started.marker", String(process.pid));\nprocess.stdin.on("data", () => {});\nprocess.stdin.on("end", () => { const poll = setInterval(() => { if (existsSync(gate)) { clearInterval(poll); process.exit(0); } }, 20); });\n`);
    const task = { ...project.task, agent: { ...project.task.agent, args: [agent] }, agent_timeout_ms: 30_000 };
    run = campaign.runCampaign(campaignOptions(project, task, { maxCycles: 1, maxAgentStarts: 3 }));
    await Promise.race([waitFor(() => {
      const status = campaign.readCampaignStatus(project.dreamRoot);
      return status?.state.kind === "running" && status.state.phase === "experiment"
        && fs.existsSync(path.join(status.campaignRoot, "cycles", "c0001", "work", "n1", "started.marker"));
    }, 20_000), run.then(() => { throw new Error("campaign finished before its first agent started"); })]);
    await assert.rejects(campaign.resumeCampaign({ baseRoot: project.dreamRoot, projectDir: project.projectDir }), /campaign is already running/);
    const stopped = campaign.stopCampaign(project.dreamRoot);
    assert.equal(stopped?.state.kind, "running");
    const paused = await run;
    assert.equal(paused.state.kind, "paused");
    assert.equal(paused.agentStarts, 1);
    const startedMarker = path.join(paused.campaignRoot, "cycles", "c0001", "work", "n1", "started.marker");
    const agentPid = Number(fs.readFileSync(startedMarker, "utf8"));
    const { childIdentity } = await jump("agent/runner.ts");
    assert.ok(Number.isSafeInteger(agentPid) && agentPid > 0);
    assert.equal(childIdentity(agentPid), null, "pause must not resolve while the cancelled agent still owns project files");

    const recordPath = path.join(paused.campaignRoot, "campaign.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.state = { kind: "running", phase: "experiment", iteration: 1 };
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
    assert.match(harness.sentMessages.at(-1).content, /dream_rsi_loop with action=resume/, "the command routes stale running records through the v3 loop tool");

    fs.writeFileSync(gate, "resume\n");
    const resumed = await campaign.resumeCampaign({ baseRoot: project.dreamRoot, projectDir: project.projectDir });
    assert.ok(resumed.agentStarts >= 2, "the resumed experiment attempt is charged to the same durable budget");
    assert.ok(resumed.agentStarts <= resumed.limits.maxAgentStarts);
    assert.equal(resumed.state.kind, "complete");
    assert.match(resumed.stopReason, /cycle limit reached|agent start limit reached|experiment allowance exhausted/);
    const ledger = JSON.parse(fs.readFileSync(path.join(resumed.campaignRoot, "campaign-processes.json"), "utf8"));
    assert.equal(ledger.agent_starts, resumed.agentStarts, "the durable ledger is the authority, not an in-memory counter");
    const workRoot = path.join(resumed.campaignRoot, "cycles", "c0001", "work");
    for (const attempt of fs.readdirSync(workRoot, { withFileTypes: true })) {
      const marker = path.join(workRoot, attempt.name, "started.marker");
      if (!fs.existsSync(marker)) continue;
      const pid = Number(fs.readFileSync(marker, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.equal(childIdentity(pid), null, `resumed campaign must exit agent ${pid} before returning and cleanup`);
    }
  } finally {
    try {
      if (run && campaign) {
        try {
          if (campaign.readCampaignStatus(project.dreamRoot)?.state.kind === "running") campaign.stopCampaign(project.dreamRoot);
        } finally {
          // Drain the started campaign before deleting its process ledger and workspaces.
          await run.catch(() => undefined);
        }
      }
    } finally { project.cleanup(); }
  }
});

test("resume pays only the readings an interrupted preflight still owes", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "slow-second-reading.mjs");
    const counter = path.join(project.dir, "resume-reading-count.txt");
    const hold = path.join(project.dir, "hold-second-reading");
    fs.writeFileSync(hold, "hold");
    fs.writeFileSync(scorer, `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\nconst counter = ${JSON.stringify(counter)};\nconst n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;\nwriteFileSync(counter, String(n));\nif (n === 2 && existsSync(${JSON.stringify(hold)})) setInterval(() => {}, 1000);\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: 0, valid: true, fail_class: "ok", error: null }));\n`);
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const run = campaign.runCampaign({
      ...campaignOptions(project, task, { maxCycles: 1 }),
      verifierInputs: [scorer],
      beforeAgentSpawn: () => { throw new Error("cheap stop at the campaign probe"); },
    });
    await waitFor(() => (campaign.readCampaignStatus(project.dreamRoot)?.check?.runs.length ?? 0) === 1, 20_000);
    await waitFor(() => Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0) >= 2, 20_000);
    campaign.stopCampaign(project.dreamRoot);
    const stopped = await run;
    assert.equal(stopped.state.kind, "paused", stopped.stopReason);
    assert.equal(stopped.check.runs.length, 1, "only the paid reading is evidence");
    const callsBeforeResume = Number(fs.readFileSync(counter, "utf8"));
    fs.rmSync(hold, { force: true });
    const resumed = await campaign.resumeCampaign({
      baseRoot: project.dreamRoot, projectDir: project.projectDir,
      beforeAgentSpawn: () => { throw new Error("cheap stop at the campaign probe"); },
    });
    assert.equal(Number(fs.readFileSync(counter, "utf8")) - callsBeforeResume, 4, "resume pays exactly the four missing readings");
    assert.equal(resumed.check.runs.length, 5, "the five planned readings are complete");
    assert.equal(JSON.parse(fs.readFileSync(path.join(resumed.campaignRoot, "campaign.json"), "utf8")).baselineScores.length, 5);
    assert.match(resumed.stopReason, /cheap stop at the campaign probe/);
  } finally { project.cleanup(); }
});

test("resume fails at once on a saved invalid reading without spending", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "invalid-second-reading.mjs");
    const counter = path.join(project.dir, "invalid-second-count.txt");
    fs.writeFileSync(scorer, `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\nconst counter = ${JSON.stringify(counter)};\nconst n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;\nwriteFileSync(counter, String(n));\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify(n === 1 ? { score: 0, valid: true, fail_class: "ok", error: null } : { score: 0, valid: false, fail_class: "wrong_answer", error: "saved failure" }));\n`);
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const result = await campaign.runCampaign({ ...campaignOptions(project, task, { maxCycles: 1 }), verifierInputs: [scorer] });
    assert.equal(result.state.kind, "failed");
    assert.equal(result.evaluatorRuns, 2, "the invalid reading fails fast after one prior reading");
    assert.equal(result.check.runs.length, 2);
    assert.match(result.stopReason, /evaluator preflight failed: never produced a qualified baseline/);
    const recordPath = path.join(result.campaignRoot, "campaign.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.state = { kind: "paused", phase: "baseline", iteration: null, reason: "test resume" };
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    const callsBeforeResume = Number(fs.readFileSync(counter, "utf8"));
    const resumed = await campaign.resumeCampaign({ baseRoot: project.dreamRoot, projectDir: project.projectDir });
    assert.equal(resumed.state.kind, "failed");
    assert.match(resumed.stopReason, /[Ff]ix the evaluator, then start a new campaign/);
    assert.equal(Number(fs.readFileSync(counter, "utf8")), callsBeforeResume, "a saved invalid reading is not retried");
    assert.equal(resumed.evaluatorRuns, 2);
  } finally { project.cleanup(); }
});

test("resume revalidates a completed preflight whose baseline was lost", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "latent-baseline.mjs");
    const counter = path.join(project.dir, "latent-baseline-count.txt");
    fs.writeFileSync(scorer, `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\nconst counter = ${JSON.stringify(counter)};\nconst n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;\nwriteFileSync(counter, String(n));\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: 0, valid: true, fail_class: "ok", error: null }));\n`);
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const result = await campaign.runCampaign({
      ...campaignOptions(project, task, { maxCycles: 1 }),
      verifierInputs: [scorer],
      beforeAgentSpawn: () => { throw new Error("cheap stop at the campaign probe"); },
    });
    assert.equal(result.check.qualified, true);
    const recordPath = path.join(result.campaignRoot, "campaign.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.baselineScore;
    delete record.baselineRepeatScore;
    delete record.baselineScores;
    record.state = { kind: "paused", phase: "baseline", iteration: null, reason: "interrupted after preflight" };
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    const callsBeforeResume = Number(fs.readFileSync(counter, "utf8"));
    const resumed = await campaign.resumeCampaign({
      baseRoot: project.dreamRoot, projectDir: project.projectDir,
      beforeAgentSpawn: () => { throw new Error("cheap stop at the campaign probe"); },
    });
    assert.equal(resumed.state.kind, "failed");
    assert.match(resumed.stopReason, /cheap stop at the campaign probe/, "the resumed run reached the probe with a real baseline");
    assert.equal(Number(fs.readFileSync(counter, "utf8")), callsBeforeResume, "a completed check is validated, not re-paid");
    assert.equal(resumed.currentScore, 0);
    assert.equal(JSON.parse(fs.readFileSync(recordPath, "utf8")).baselineScore, 0);
  } finally { project.cleanup(); }
});

test("preflight stops when the remaining runs cannot fund a noisy confirmation", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "noisy-readings.mjs");
    const counter = path.join(project.dir, "noisy-readings-count.txt");
    fs.writeFileSync(scorer, `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\nconst counter = ${JSON.stringify(counter)};\nconst n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;\nwriteFileSync(counter, String(n));\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: n % 2 ? 1 : 1000, valid: true, fail_class: "ok", error: null }));\n`);
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const result = await campaign.runCampaign({ ...campaignOptions(project, task, { maxCycles: 1, maxEvaluatorRuns: 9 }), verifierInputs: [scorer] });
    assert.equal(result.state.kind, "failed");
    assert.equal(result.evaluatorRuns, 5, "the evaluator needs five baseline readings before it can establish noise");
    assert.equal(result.check.runs.length, 5);
    assert.equal(result.agentStarts, 0);
    assert.match(result.stopReason, /cannot fund one verified promotion|minimum detectable effect exceeds 50%/);
  } finally { project.cleanup(); }
});

test("preflight stops when the remaining deadline cannot fund the evaluator floor", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "slow-reading.mjs");
    fs.writeFileSync(scorer, `import { mkdirSync, writeFileSync } from "node:fs";\nsetTimeout(() => { mkdirSync("eval", { recursive: true }); writeFileSync("eval/score.json", JSON.stringify({ score: 0, valid: true, fail_class: "ok", error: null })); }, 900);\n`);
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const result = await campaign.runCampaign({ ...campaignOptions(project, task, { maxCycles: 1, deadlineMs: 4000 }), verifierInputs: [scorer] });
    assert.equal(result.state.kind, "failed");
    assert.equal(result.evaluatorRuns, 2, "the deadline floor is asserted once two readings establish the observation");
    assert.match(result.stopReason, /cannot fund one verified promotion|deadline remain/);
    assert.equal(result.agentStarts, 0);
  } finally { project.cleanup(); }
});

test("a deadline before the baseline is a failed preflight, not a complete campaign", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "hang-baseline.mjs");
    fs.writeFileSync(scorer, "setInterval(() => {}, 1000);\n");
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const result = await campaign.runCampaign({ ...campaignOptions(project, task, { maxCycles: 1, deadlineMs: 800 }), verifierInputs: [scorer] });
    assert.equal(result.state.kind, "failed");
    assert.match(result.stopReason, /evaluator preflight failed: never produced a qualified baseline: campaign deadline expired/);
    assert.match(result.stopReason, /last reading: no reading completed/);
    assert.equal(result.agentStarts, 0);
  } finally { project.cleanup(); }
});

test("seeded qualification readings are reused only under the same verifier identity", async () => {
  for (const matching of [true, false]) {
    const project = makeProject();
    try {
      const campaign = await jump("engine/campaign.ts");
      const scorer = path.join(project.projectDir, "seed-count.mjs");
      const counter = path.join(project.dir, `seed-count-${matching}.txt`);
      fs.writeFileSync(scorer, `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, "x");\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: 0, valid: true, fail_class: "ok", error: null }));\n`);
      const task = { ...project.task, score_program: `node "${scorer}"` };
      const seeds = [0, 0, 0].map((score) => ({ durationMs: 0, code: 0, valid: true, failClass: "ok", score, error: null, stdoutTail: "seeded from loop qualification", logPath: null }));
      const identity = matching ? campaign.campaignVerifierIdentity(project.projectDir, task, [scorer], []) : "not-the-same-evaluator";
      const result = await campaign.runCampaign({
        ...campaignOptions(project, task, { maxCycles: 1 }),
        verifierInputs: [scorer],
        seedReadings: { identity, runs: seeds },
        beforeAgentSpawn: () => { throw new Error("cheap stop at the campaign probe"); },
      });
      const calls = fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").length : 0;
      assert.equal(calls, matching ? 2 : 5, matching ? "three qualified readings are reused, only two are paid" : "a different identity re-pays every reading");
      assert.equal(result.check.runs.length, 5);
      assert.equal(JSON.parse(fs.readFileSync(path.join(result.campaignRoot, "campaign.json"), "utf8")).baselineScores.length, 5);
      if (matching) {
        assert.equal(result.check.runs[0].stdoutTail, "seeded from loop qualification");
        assert.equal(result.check.runs[0].logPath, null);
      } else {
        assert.notEqual(result.check.runs[0].stdoutTail, "seeded from loop qualification");
      }
    } finally { project.cleanup(); }
  }
});

test("extra instrument files are hashed into the campaign identity", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "ident-count.mjs");
    const counter = path.join(project.dir, "ident-count.txt");
    fs.writeFileSync(scorer, `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, "x");\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: 0, valid: true, fail_class: "ok", error: null }));\n`);
    const instrument = path.join(project.projectDir, "instrument.mjs");
    fs.writeFileSync(instrument, "export const version = 1;\n");
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const result = await campaign.runCampaign({
      ...campaignOptions(project, task, { maxCycles: 1 }),
      verifierInputs: [scorer],
      identityInputs: [instrument],
      beforeAgentSpawn: () => { throw new Error("cheap stop at the campaign probe"); },
    });
    assert.equal(result.state.kind, "failed");
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.campaignRoot, "campaign.json"), "utf8")).identityInputs.length, 1);
    const recordPath = path.join(result.campaignRoot, "campaign.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.state = { kind: "paused", phase: "experiment", iteration: 1, reason: "test resume" };
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    const callsBeforeResume = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").length : 0);
    fs.writeFileSync(instrument, "export const version = 2;\n");
    const resumed = await campaign.resumeCampaign({ baseRoot: project.dreamRoot, projectDir: project.projectDir });
    assert.equal(resumed.state.kind, "failed");
    assert.match(resumed.stopReason, /identity changed/);
    assert.equal(Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").length : 0), callsBeforeResume, "an edited instrument is refused before another reading");
  } finally { project.cleanup(); }
});
