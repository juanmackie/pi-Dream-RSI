import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

import { jump, makeProject, mockPi } from "./fixtures.mjs";

const { default: dreamRsi } = await jump("index.ts");
const { ProgressRecorder, progressPath } = await jump("engine/progress.ts");
const { Dashboard, DashboardView } = await jump("dashboard.ts");

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

test("watch and Ctrl+Shift+D only open the active campaign", async () => {
  const project = makeProject();
  try {
    const { pi, context, harness } = mockPi();
    context.cwd = project.projectDir;
    context.mode = "tui";
    dreamRsi(pi);
    await harness.handlers.get("session_start")({}, context);

    await harness.commands.get("dream-rsi").handler("watch", context);
    assert.match(harness.notifications.at(-1), /No campaign yet\. Run \/dream-rsi assess\./);
    assert.equal(harness.customViews.length, 0, "watch without a campaign does not open legacy state");
    await harness.shortcuts.get("ctrl+shift+d").handler(context);
    assert.equal(harness.customViews.length, 0, "the shortcut also requires a campaign");

    const campaign = recordCampaign(project);
    seedProgress(campaign.campaignRoot, "campaign-tree-marker");
    let pending = harness.commands.get("dream-rsi").handler("watch", context);
    await inspectWatch(harness, pending, "campaign-tree-marker");

    pending = harness.shortcuts.get("ctrl+shift+d").handler(context);
    await inspectWatch(harness, pending, "campaign-tree-marker");

    const current = JSON.parse(fs.readFileSync(campaign.campaignFile, "utf8"));
    current.state = { kind: "complete", reason: "fixture complete" };
    fs.writeFileSync(campaign.campaignFile, JSON.stringify(current));
    pending = harness.shortcuts.get("ctrl+shift+d").handler(context);
    await inspectWatch(harness, pending, "campaign-tree-marker");

    const completedWatchCount = harness.customViews.length;
    pending = harness.shortcuts.get("ctrl+shift+d").handler(context);
    await inspectWatch(harness, pending, "campaign-tree-marker");
    assert.equal(harness.customViews.length, completedWatchCount + 1, "completed campaigns remain watchable");
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
    assert.match(both, /live 1:/);
    assert.equal((both.match(/live 1:/g) ?? []).length, 2);
    assert.match(both, /legacy worker is running/);
    assert.match(both, /campaign worker is running/);

    campaignProgress.finish("complete");
    dashboard.observe(campaignProgress.snapshot);
    const remaining = harness.widgets.at(-1)?.[1]?.join("\n") ?? "";
    assert.match(remaining, /worker is running/);
    assert.doesNotMatch(remaining, /campaign worker is running/);
    dashboard.dispose();
  } finally {
    project.cleanup();
  }
});

test("framed watch fits its row cap, restores backgrounds, highlights selection and scopes rejection reasons", async () => {
  const project = makeProject();
  try {
    const campaign = recordCampaign(project);
    const recordPath = path.join(campaign.campaignRoot, "campaign.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.state = { kind: "running", phase: "promote", iteration: 2 };
    fs.writeFileSync(recordPath, JSON.stringify(record));

    const recorder = new ProgressRecorder(campaign.campaignRoot, 1, "live", 3, 2);
    const cells = Array.from({ length: 10 }, (_, index) => {
      const cell = `b${index}a0`;
      recorder.stage(cell, "root", 1, index === 0 ? "running" : "complete", 0, index);
      return { meta: { cell_id: cell, parent_id: "root", seq: index + 1 }, evaluated: true, score: index, fail_class: "ok" };
    });
    recorder.snapshot.tree = { cells };
    recorder.snapshot.attempts.b0a0.agent_tail = Array.from({ length: 40 }, (_, i) => `log line ${i}`).join("\n");
    fs.writeFileSync(progressPath(campaign.campaignRoot, 1), JSON.stringify(recorder.snapshot));
    const rejectionPath = path.join(campaign.campaignRoot, "history", "ledger.jsonl");
    fs.mkdirSync(path.dirname(rejectionPath), { recursive: true });
    fs.writeFileSync(rejectionPath, [
      { iteration: 1, cell: "b0a0", stage: "gate", reasons: ["unit test failed"] },
      { iteration: 2, cell: "b0a0", stage: "review", reasons: ["wrong-cycle secret"] },
      { cell: "b0a0", stage: "review", reasons: ["unscoped legacy secret"] },
    ].map((item) => JSON.stringify({ v: 1, t: new Date().toISOString(), entryId: "fixture", kind: "skip", outcome: "rejected", facts: { iteration: item.iteration, cell: item.cell, terminalStage: item.stage, reason: item.reasons.join("; ") } })).join("\n") + "\n");

    const { pi, context, harness } = mockPi();
    context.cwd = project.projectDir;
    context.mode = "tui";
    dreamRsi(pi);
    await harness.handlers.get("session_start")({}, context);
    const pending = harness.commands.get("dream-rsi").handler("watch", context);
    await new Promise(setImmediate);
    const item = harness.customViews.at(-1);
    assert.ok(item, "watch creates the framed view");
    item.view.handleInput("\t");
    try {
      const rows = item.view.render(80);
      const plainRows = rows.map((row) => row.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));

      assert.ok(rows.length <= 27, `frame height ${rows.length} stays within 90% of 30 rows`);
      assert.ok(rows.length >= 20, `frame height ${rows.length} remains stable for content`);
      assert.ok(rows.every((row) => visibleWidth(row) === 80), "every framed row fills the requested width");
      assert.ok(plainRows[0].startsWith("╭"), "top border uses a rounded corner");
      assert.ok(plainRows.at(-1).startsWith("╰"), "bottom border stays visible and uses a rounded corner");
      assert.match(plainRows[0], /Dream-RSI · 12345678 · cycle 2\/5 · promote/);
      assert.match(rows.join("\n"), /\x1b\[48;5;24m/, "selected row uses selectedBg");
      assert.match(rows.join("\n"), /\x1b\[0m\x1b\[48;5;236m/, "custom message background is restored after SGR resets");
      assert.match(rows.join("\n"), /\x1b\[38;5;33mrunning\x1b\[0m/, "selected running status keeps warning color");
      assert.match(plainRows.join("\n"), /unit test failed/);
      assert.doesNotMatch(plainRows.join("\n"), /wrong-cycle secret|unscoped legacy secret/,
        "rejection details from other or unknown cycles do not leak onto the selected cycle");
      assert.match(plainRows.join("\n"), /log line 39/, "trimmed log pane keeps its newest content");
      assert.doesNotMatch(plainRows.join("\n"), /log line 26/, "old log rows are trimmed before dashboard content");

      recorder.stage("b0a0", "root", 1, "evaluation", 0, 0);
      fs.writeFileSync(progressPath(campaign.campaignRoot, 1), JSON.stringify(recorder.snapshot));
      const evaluationView = new DashboardView(campaign.campaignRoot, 1);
      assert.match(evaluationView.framed(80, item.theme, 27).join("\n"), /\x1b\[38;5;33mevaluation\x1b\[0m/, "selected evaluation stage keeps warning color");

      recorder.stage("b0a0", "root", 1, "failed", 0, 0);
      fs.writeFileSync(progressPath(campaign.campaignRoot, 1), JSON.stringify(recorder.snapshot));
      const failedView = new DashboardView(campaign.campaignRoot, 1);
      assert.match(failedView.framed(80, item.theme, 27).join("\n"), /\x1b\[38;5;31mfailed\x1b\[0m/, "selected failure status keeps error color");

      item.tui.terminal.rows = 12;
      const resized = item.view.render(80);
      assert.ok(resized.length <= 10, "resizing the terminal applies the current 90% height cap");
      assert.ok(resized.at(-1).includes("╰"), "bottom border remains visible after resize");

      assert.ok(failedView.framed(80, item.theme, 2).length <= 2, "tiny caps return promptly without exceeding the cap");
    } finally {
      item.view.handleInput("\x1b");
      await pending;
    }
  } finally {
    project.cleanup();
  }
});
