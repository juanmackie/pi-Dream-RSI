import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { EXT, jump, makeProject, mockPi } from "./fixtures.mjs";

const { default: dreamRsi } = await jump("index.ts");

test("registered improve status reports its loaded runtime and default evaluator timeout before a campaign exists", async () => {
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
    assert.equal(result.details.runtime.defaultEvaluatorTimeoutMs, 300_000);
    assert.match(result.content[0].text, /default evaluator timeout: 300000ms/);
    assert.match(result.content[0].text, /campaign module:/);
  } finally {
    project.cleanup();
  }
});

test("registered campaign start preserves the configured evaluator timeout and five-score baseline", async () => {
  const project = makeProject();
  try {
    const { pi, context, harness } = mockPi();
    dreamRsi(pi);
    context.cwd = project.projectDir;
    await harness.handlers.get("session_start")({}, context);
    await harness.handlers.get("input")({
      type: "input", source: "interactive", text: "Use Dream-RSI to improve the fixture score",
    }, context);

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
        higher_is_better: true,
        agent_timeout_ms: 20_000,
        evaluator_timeout_ms: 600_000,
        agent_command: "node",
        agent_args: [project.script("agent-ok.mjs")],
      },
      scope: ["solution.py"],
      verifier_inputs: ["score-ok.mjs"],
      max_cycles: 1,
      max_agent_starts: 24,
      max_evaluator_runs: 80,
    }, undefined, undefined, context);

    const result = await resultPromise;
    const campaign = JSON.parse(fs.readFileSync(path.join(result.details.campaign.campaignRoot, "campaign.json"), "utf8"));
    assert.equal(campaign.baselineScores.length, 5);
    assert.equal(campaign.task.evaluator_timeout_ms, 600_000);
    assert.equal(result.details.campaign.effectiveEvaluatorTimeoutMs, 600_000);
    assert.equal(result.details.runtime.defaultEvaluatorTimeoutMs, 300_000);
    assert.ok(result.details.campaign.evaluatorRuns >= 5, "five baseline measurements precede candidate evaluation");
    assert.ok(result.details.campaign.agentStarts >= 1, "the local fixture campaign agent ran");
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
        higher_is_better: true,
        agent_timeout_ms: 20_000,
        evaluator_timeout_ms: 40_000,
        agent_command: "node",
        agent_args: [project.script("agent-ok.mjs")],
      },
      scope: ["solution.py"],
      verifier_inputs: ["score-ok.mjs"],
      max_cycles: 1,
      max_agent_starts: 24,
      max_evaluator_runs: 80,
    }, undefined, undefined, context);

    assert.equal(result.details.campaign.effectiveEvaluatorTimeoutMs, 40_000);
    assert.match(result.content[0].text, /effective evaluator timeout: 40000ms/);
  } finally {
    project.cleanup();
  }
});
