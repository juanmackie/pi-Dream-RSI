import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { EXT, jump, makeProject, mockPi } from "./fixtures.mjs";

const { default: dreamRsi } = await jump("index.ts");

/**
 * Write a minimal but internally consistent campaign record so status rendering can be
 * exercised without spending a real campaign. `readCampaignStatus` reads the active pointer,
 * the process ledger and the record, so all three are created here.
 */
function writeCampaignState(project, record = {}) {
  const id = "a1b2c3d4e5f60718";
  const campaignsRoot = path.join(project.dreamRoot, "campaigns");
  const campaignRoot = path.join(campaignsRoot, id);
  fs.mkdirSync(campaignRoot, { recursive: true });
  fs.writeFileSync(path.join(campaignsRoot, "active.json"), `${JSON.stringify({ id })}\n`);
  fs.writeFileSync(path.join(campaignRoot, "campaign-processes.json"), `${JSON.stringify({
    version: 1, agent_limit: 24, evaluator_limit: 80, agent_starts: 7, evaluator_runs: 12, last_start: null,
  })}\n`);
  fs.writeFileSync(path.join(campaignRoot, "campaign.json"), `${JSON.stringify({
    version: 1,
    id,
    campaignRoot,
    baseRoot: project.dreamRoot,
    projectDir: project.projectDir,
    targetRoot: project.seed,
    scope: ["solution.py"],
    goal: "Increase the fixture score while preserving validity",
    task: { name: "fixture", workspace: "seed", eval_program: "solution.py", score_program: project.task.score_program, higher_is_better: true, evaluator_timeout_ms: 20_000 },
    verifierInputs: ["score-ok.mjs"],
    gates: [],
    taskFingerprint: "fixture-task-fingerprint",
    verifierIdentity: "fixture-verifier-identity",
    minimumGain: 0,
    baselineScores: [0, 0],
    limits: { maxCycles: 5, maxAgentStarts: 24, maxEvaluatorRuns: 80, deadlineMs: 3_600_000, plateauCycles: 2, maxCandidatesPerCycle: 3 },
    state: { kind: "paused", phase: "baseline", iteration: null, reason: "stopped by request" },
    completedCycles: [],
    currentScore: 0,
    bestScore: 0,
    baselineScore: 0,
    noGainCycles: 0,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...record,
  }, null, 2)}\n`);
  return campaignRoot;
}

test("status renders the evaluator check report with per-reading durations, exits, scores and logs", async () => {
  const project = makeProject();
  try {
    const { pi, context, harness } = mockPi();
    dreamRsi(pi);
    context.cwd = project.projectDir;
    const checkDir = path.join(project.dreamRoot, "checks");
    const reportPath = path.join(checkDir, "2026-01-01T00-00-00-000Z-report.json");
    writeCampaignState(project, {
      checkReport: {
        checkedAt: "2026-01-01T00:00:00.000Z",
        runs: [
          { durationMs: 1500, code: 0, valid: true, failClass: "ok", score: 3, error: null, logPath: path.join(checkDir, "reading-1.log") },
          { durationMs: 200, code: 4, valid: false, failClass: "evaluator_error", score: null, error: "evaluator exploded", logPath: path.join(checkDir, "reading-2.log") },
        ],
        spread: null,
        recommendedEvaluatorTimeoutMs: 30_000,
        recommendedMinimumGain: 0,
        diagnoses: ["evaluator did not produce a valid score on the unchanged target"],
        gateRuns: [],
        reportPath,
        direction: "maximize",
        deterministic: false,
        noise_rel: null,
        mde_rel: null,
        threshold_resolved: 0,
        confirmationCostMs: 0,
        control: { validated: false, gain: null, reason: "instrument unvalidated: no control_patch supplied" },
        qualified: false,
        plannedRuns: 5,
      },
    });

    const result = await harness.tools.get("dream_rsi_improve").execute("status-check", { action: "status" }, undefined, undefined, context);
    const text = result.content[0].text;
    assert.equal(result.details.campaign.check.runs.length, 2, "status details carry the check readings");
    assert.equal(result.details.campaign.check.reportPath, reportPath);
    assert.match(text, /evaluator check: unqualified; 2 readings/);
    assert.match(text, /reading 1: 2s, exit 0, score 3; log .*reading-1\.log/);
    assert.match(text, /reading 2: 1s, exit 4, evaluator_error: evaluator exploded; log .*reading-2\.log/);
    assert.match(text, /diagnosis: evaluator did not produce a valid score on the unchanged target/);
    assert.match(text, /report: .*report\.json/);
  } finally {
    project.cleanup();
  }
});

test("status renders a partial check without a report and without failing", async () => {
  const project = makeProject();
  try {
    const { pi, context, harness } = mockPi();
    dreamRsi(pi);
    context.cwd = project.projectDir;
    writeCampaignState(project, {
      checkRuns: [
        { durationMs: 0, code: 0, valid: true, failClass: "ok", score: 2, error: null, logPath: null },
        { durationMs: 3000, code: null, valid: false, failClass: "timeout", score: null, error: "evaluator timed out", logPath: path.join(project.dreamRoot, "checks", "reading-2.log") },
      ],
    });

    const result = await harness.tools.get("dream_rsi_improve").execute("status-partial-check", { action: "status" }, undefined, undefined, context);
    const text = result.content[0].text;
    assert.equal(result.details.campaign.check.qualified, false);
    assert.equal(result.details.campaign.check.reportPath, null);
    assert.match(text, /evaluator check: unqualified; 2 readings/);
    assert.match(text, /reading 1: 0s, exit 0, score 2; seeded/);
    assert.match(text, /reading 2: 3s, exit unknown, timeout: evaluator timed out; log /);
    assert.doesNotMatch(text, /report:/);
    assert.doesNotMatch(text, /diagnosis:/);
    assert.match(text, /Improvement campaign: paused/);
  } finally {
    project.cleanup();
  }
});

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
    assert.doesNotMatch(result.content[0].text, /evaluator check:/, "no check evidence is rendered before a campaign exists");
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
      max_deadline_minutes: 45,
    }, undefined, undefined, context);

    const result = await resultPromise;
    const campaign = JSON.parse(fs.readFileSync(path.join(result.details.campaign.campaignRoot, "campaign.json"), "utf8"));
    assert.equal(campaign.baselineScores.length, 5);
    assert.equal(campaign.task.evaluator_timeout_ms, 600_000);
    assert.equal(campaign.limits.deadlineMs, 45 * 60_000, "max_deadline_minutes becomes the campaign wall-clock limit");
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
