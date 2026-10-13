import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { jump, makeProject, mockPi } from "./fixtures.mjs";

const { default: dreamRsi } = await jump("index.ts");
const { ProgressRecorder } = await jump("engine/progress.ts");
const { Dashboard } = await jump("dashboard.ts");

function recordCampaign(project) {
  const id = "12345678-1234-1234-1234-123456789abc";
  const campaigns = path.join(project.dreamRoot, "campaigns");
  const campaignRoot = path.join(campaigns, id);
  fs.mkdirSync(campaignRoot, { recursive: true });
  fs.writeFileSync(path.join(campaigns, "active.json"), JSON.stringify({ id }));
  fs.writeFileSync(path.join(campaignRoot, "campaign-processes.json"), JSON.stringify({
    version: 1, agent_limit: 36, evaluator_limit: 100, agent_starts: 2, evaluator_runs: 3, last_start: null,
  }));
  fs.writeFileSync(path.join(campaignRoot, "campaign.json"), JSON.stringify({
    version: 1,
    id,
    baseRoot: project.dreamRoot,
    campaignRoot,
    projectDir: project.projectDir,
    targetRoot: project.projectDir,
    goal: "exercise dashboard root selection",
    task: {},
    scope: ["solution.py"],
    verifierInputs: [project.script("score-ok.mjs")],
    verifierIdentity: "test",
    taskFingerprint: "test",
    minimumGain: 0,
    limits: { maxCycles: 5, maxAgentStarts: 36, maxEvaluatorRuns: 100, deadlineMs: 3600000, plateauCycles: 2, maxCandidatesPerCycle: 3 },
    startedAt: new Date(0).toISOString(),
    deadlineAt: new Date(Date.now() + 3600000).toISOString(),
    completedCycles: [],
    currentScore: 0,
    bestScore: 0,
    noGainCycles: 0,
    state: { kind: "running", phase: "live", iteration: 1 },
  }));
  return { campaignRoot, campaignFile: path.join(campaignRoot, "campaign.json") };
}

function seedProgress(root, activity) {
  const recorder = new ProgressRecorder(root, 1, "live", 1, 1);
  recorder.stage("b0a0", "root", 1, "agent");
  recorder.activity(activity);
}

async function inspectWatch(harness, pending, expectedActivity) {
  await new Promise(setImmediate);
  const item = harness.customViews.at(-1);
  assert.ok(item, "watch opens a TUI view");
  assert.match(item.view.render(120).join("\n"), new RegExp(expectedActivity));
  item.view.handleInput("\x1b");
  await pending;
}

test("watch selectors and Ctrl+Shift+D retain access to active campaign and legacy trees", async () => {
  const project = makeProject();
  try {
    seedProgress(project.dreamRoot, "legacy-tree-marker");
    const { pi, context, harness } = mockPi();
    context.cwd = project.projectDir;
    context.mode = "tui";
    dreamRsi(pi);
    await harness.handlers.get("session_start")({}, context);

    let pending = harness.shortcuts.get("ctrl+shift+d").handler(context);
    await inspectWatch(harness, pending, "legacy-tree-marker");

    const campaign = recordCampaign(project);
    seedProgress(campaign.campaignRoot, "campaign-tree-marker");
    pending = harness.commands.get("dream-rsi").handler("watch", context);
    await inspectWatch(harness, pending, "campaign-tree-marker");

    pending = harness.commands.get("dream-rsi").handler("watch legacy", context);
    await inspectWatch(harness, pending, "legacy-tree-marker");

    pending = harness.commands.get("dream-rsi").handler("watch campaign", context);
    await inspectWatch(harness, pending, "campaign-tree-marker");

    pending = harness.shortcuts.get("ctrl+shift+d").handler(context);
    await inspectWatch(harness, pending, "campaign-tree-marker");

    const current = JSON.parse(fs.readFileSync(campaign.campaignFile, "utf8"));
    current.state = { kind: "complete", reason: "fixture complete" };
    fs.writeFileSync(campaign.campaignFile, JSON.stringify(current));
    pending = harness.shortcuts.get("ctrl+shift+d").handler(context);
    await inspectWatch(harness, pending, "legacy-tree-marker");

    const shortcutCount = harness.customViews.length;
    pending = harness.commands.get("dream-rsi").handler("watch campaign", context);
    await inspectWatch(harness, pending, "campaign-tree-marker");
    assert.equal(harness.customViews.length, shortcutCount + 1, "explicit campaign selection remains available after completion");
  } finally {
    project.cleanup();
  }
});

test("worker widget keeps same-cycle campaign and legacy progress distinct and clears only completed work", async () => {
  const project = makeProject();
  try {
    const campaign = recordCampaign(project);
    const legacyProgress = new ProgressRecorder(project.dreamRoot, 1, "live", 1, 1);
    legacyProgress.stage("b0a0", "root", 1, "agent");
    legacyProgress.activity("legacy worker is running");
    const campaignProgress = new ProgressRecorder(campaign.campaignRoot, 1, "live", 1, 1);
    campaignProgress.stage("b0a0", "root", 1, "agent");
    campaignProgress.activity("campaign worker is running");

    const { context, harness } = mockPi();
    context.mode = "tui";
    const dashboard = new Dashboard(context);
    dashboard.observe(legacyProgress.snapshot);
    await new Promise((resolve) => setTimeout(resolve, 260));
    dashboard.observe(campaignProgress.snapshot);
    const both = harness.widgets.at(-1)?.[1]?.join("\n") ?? "";
    assert.match(both, /legacy live 1:/);
    assert.match(both, /campaign live 1:/);
    assert.match(both, /legacy worker is running/);
    assert.match(both, /campaign worker is running/);

    campaignProgress.finish("complete");
    dashboard.observe(campaignProgress.snapshot);
    const remaining = harness.widgets.at(-1)?.[1]?.join("\n") ?? "";
    assert.match(remaining, /legacy worker is running/);
    assert.doesNotMatch(remaining, /campaign worker is running/);
    dashboard.dispose();
  } finally {
    project.cleanup();
  }
});
