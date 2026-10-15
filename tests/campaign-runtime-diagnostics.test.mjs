import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { EXT, jump, makeProject, mockPi } from "./fixtures.mjs";

const { default: dreamRsi } = await jump("index.ts");

test("registered improve status reports its loaded runtime and timeout ceiling before a campaign exists", async () => {
  const project = makeProject();
  try {
    const { pi, context, harness } = mockPi();
    dreamRsi(pi);
    context.cwd = project.projectDir;

    const result = await harness.tools.get("dream_rsi_improve").execute("runtime-status", { action: "status" }, undefined, undefined, context);
    const metadata = JSON.parse(fs.readFileSync(path.join(EXT, "..", "..", "package.json"), "utf8"));

    assert.equal(result.details.campaign, null);
    assert.equal(result.details.runtime.packageDir, path.resolve(EXT, "..", ".."));
    assert.equal(result.details.runtime.packageVersion, metadata.version);
    assert.match(result.details.runtime.campaignModule, /engine\/campaign\.ts$/);
    assert.equal(result.details.runtime.evaluatorTimeoutCapMs, 300_000);
    assert.match(result.content[0].text, /evaluator timeout cap: 300000ms/);
    assert.match(result.content[0].text, /campaign module:/);
  } finally {
    project.cleanup();
  }
});

test("registered campaign start persists its effective timeout before the first evaluator runs", async () => {
  const project = makeProject();
  try {
    const { pi, context, harness } = mockPi();
    dreamRsi(pi);
    context.cwd = project.projectDir;
    await harness.handlers.get("session_start")({}, context);
    await harness.handlers.get("input")({
      type: "input", source: "interactive", text: "Use Dream-RSI to improve the fixture score",
    }, context);

    const snapshots = [];
    const resultPromise = harness.tools.get("dream_rsi_improve").execute("timeout-smoke", {
      action: "start",
      project_dir: project.projectDir,
      goal: "Increase the fixture score while preserving validity",
      task: {
        name: "timeout smoke",
        workspace: "seed",
        eval_program: "solution.py",
        score_program: project.task.score_program,
        problem_file: "PROBLEM.md",
        agent_timeout_ms: 20_000,
        evaluator_timeout_ms: 600_000,
        agent_command: "node",
        agent_args: [project.script("agent-ok.mjs")],
      },
      scope: ["solution.py"],
      verifier_inputs: ["score-ok.mjs"],
      max_cycles: 1,
      max_agent_starts: 1,
      max_evaluator_runs: 1,
    }, undefined, (update) => snapshots.push(update), context);

    const result = await resultPromise;
    const campaign = JSON.parse(fs.readFileSync(path.join(result.details.campaign.campaignRoot, "campaign.json"), "utf8"));
    const baselineAnnouncement = snapshots.find((update) => /effective evaluator timeout: 300000ms/.test(update.content?.[0]?.text ?? ""));

    assert.ok(baselineAnnouncement, "tool progress exposes the cap before baseline evaluation");
    assert.equal(baselineAnnouncement.details.campaign.evaluatorRuns, 0, "the baseline announcement precedes the evaluator spawn");
    assert.equal(baselineAnnouncement.details.runtime.evaluatorTimeoutCapMs, 300_000);
    assert.match(baselineAnnouncement.content[0].text, /evaluator timeout cap: 300000ms/);
    assert.equal(campaign.task.evaluator_timeout_ms, 300_000);
    assert.equal(result.details.campaign.effectiveEvaluatorTimeoutMs, 300_000);
    assert.equal(result.details.runtime.evaluatorTimeoutCapMs, 300_000);
    assert.equal(result.details.campaign.evaluatorRuns, 1, "only the local fixture evaluator ran");
    assert.equal(result.details.campaign.agentStarts, 1, "only the local fixture probe ran");
  } finally {
    project.cleanup();
  }
});

test("campaign status keeps lower evaluator timeouts intact", async () => {
  const project = makeProject();
  try {
    const { pi, context, harness } = mockPi();
    dreamRsi(pi);
    context.cwd = project.projectDir;
    await harness.handlers.get("session_start")({}, context);
    await harness.handlers.get("input")({
      type: "input", source: "interactive", text: "Use Dream-RSI to improve the fixture score",
    }, context);

    const result = await harness.tools.get("dream_rsi_improve").execute("short-timeout", {
      action: "start",
      project_dir: project.projectDir,
      goal: "Increase the fixture score while preserving validity",
      task: {
        name: "short timeout",
        workspace: "seed",
        eval_program: "solution.py",
        score_program: project.task.score_program,
        problem_file: "PROBLEM.md",
        agent_timeout_ms: 20_000,
        evaluator_timeout_ms: 40_000,
        agent_command: "node",
        agent_args: [project.script("agent-ok.mjs")],
      },
      scope: ["solution.py"],
      verifier_inputs: ["score-ok.mjs"],
      max_cycles: 1,
      max_agent_starts: 1,
      max_evaluator_runs: 1,
    }, undefined, undefined, context);

    assert.equal(result.details.campaign.effectiveEvaluatorTimeoutMs, 40_000);
    assert.match(result.content[0].text, /effective evaluator timeout: 40000ms/);
  } finally {
    project.cleanup();
  }
});
