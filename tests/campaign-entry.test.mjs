import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { jump, makeProject, mockPi, writeTaskJson } from "./fixtures.mjs";

const { default: dreamRsi } = await jump("index.ts");
const { progressPath } = await jump("engine/progress.ts");

test("campaign entry improves a full-repo workspace without copying or changing legacy Dream-RSI state", async () => {
  const project = makeProject();
  try {
    fs.writeFileSync(path.join(project.projectDir, "solution.py"), "x\n", "utf8");
    fs.mkdirSync(path.join(project.dreamRoot, "verifier"), { recursive: true });
    await writeTaskJson(project);
    const legacyTask = fs.readFileSync(path.join(project.dreamRoot, "task.json"));
    const secret = Buffer.from("legacy private state\n");
    fs.writeFileSync(path.join(project.dreamRoot, "task.json"), legacyTask);
    fs.writeFileSync(path.join(project.dreamRoot, "legacy-secret.txt"), secret);

    const verifier = path.join(project.dreamRoot, "verifier", "score.mjs");
    fs.writeFileSync(verifier, `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const source = readFileSync("solution.py", "utf8");
mkdirSync("eval", { recursive: true });
writeFileSync("eval/score.json", JSON.stringify({ score: (source.match(/x/g) ?? []).length, valid: true, fail_class: "ok", error: null }));
`, "utf8");

    const observed = path.join(project.dir, "agent-observations.jsonl");
    const agent = path.join(project.dir, "campaign-agent.mjs");
    fs.writeFileSync(agent, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const secretPresent = existsSync(".dream-rsi/legacy-secret.txt");
  appendFileSync(process.argv[2], JSON.stringify({ secretPresent, promptPrefix: prompt.slice(0, 35) }) + "\\n");
  if (prompt.includes("Do not change files.")) { process.stdout.write("I can inspect the target.\\n"); return; }
  if (prompt.includes("prefix-only exploration policy")) { process.stdout.write("Policy remains unchanged.\\n"); return; }
  const source = readFileSync("solution.py", "utf8");
  writeFileSync("solution.py", source + "x\\n");
  writeFileSync("proposal.md", "# Added one verified marker\\n");
});
`, "utf8");

    const { pi, context, harness } = mockPi();
    dreamRsi(pi);
    context.cwd = project.projectDir;
    await harness.handlers.get("session_start")({}, context);
    context.mode = "tui";
    await harness.handlers.get("input")({
      type: "input",
      source: "interactive",
      text: "Use Dream-RSI to improve this repository's measured score",
    }, context);

    const task = {
      name: "full repository marker score",
      workspace: ".",
      eval_program: "solution.py",
      score_program: `node "${verifier}"`,
      score_path: "eval/score.json",
      score_field: "score",
      valid_field: "valid",
      fail_class_field: "fail_class",
      error_field: "error",
      higher_is_better: true,
      workers: 2,
      k1: 3,
      k2: 4,
      revisions: 2,
      beta_grid: [0, 0.6],
      default_beta: 0.6,
      agent_timeout_ms: 20_000,
      evaluator_timeout_ms: 300_000,
      agent_command: "node",
      agent_args: [agent, observed],
    };
    const updates = [];
    const result = await harness.tools.get("dream_rsi_improve").execute("campaign", {
      action: "start",
      project_dir: project.projectDir,
      goal: "Increase the score by adding valid x markers",
      task,
      scope: ["solution.py"],
      verifier_inputs: [verifier],
      max_cycles: 2,
    }, undefined, (update) => updates.push(update), context);

    assert.equal(result.details.campaign.state.kind, "complete", result.content[0].text);
    assert.deepEqual(result.details.campaign.completedCycles, [1, 2], "the second campaign cycle starts after the first promotion");
    const campaignRecord = JSON.parse(fs.readFileSync(path.join(result.details.campaign.campaignRoot, "campaign.json"), "utf8"));
    assert.equal(campaignRecord.task.evaluator_timeout_ms, 300_000, "campaign preserves the requested evaluator timeout up to its safe ceiling");
    assert.ok((fs.readFileSync(path.join(project.projectDir, "solution.py"), "utf8").match(/x/g) ?? []).length > 2,
      "verified improvements from both cycles were promoted into the full-repo workspace");
    const applied = fs.readFileSync(path.join(result.details.campaign.campaignRoot, "history", "applied.jsonl"), "utf8")
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(applied.map((entry) => entry.iteration), [1, 2], "each cycle records its own verified promotion");
    assert.ok(applied[1].score > applied[0].score, "cycle two measures a win on top of cycle one's promoted seed");
    assert.deepEqual(fs.readFileSync(path.join(project.dreamRoot, "task.json")), legacyTask,
      "direct campaign intake leaves the legacy task byte-for-byte unchanged");
    assert.deepEqual(fs.readFileSync(path.join(project.dreamRoot, "legacy-secret.txt")), secret,
      "legacy state remains untouched");
    const observations = fs.readFileSync(observed, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(observations.length >= 3, "probe and campaign agents actually ran as local subprocesses");
    assert.ok(observations.every((entry) => entry.secretPresent === false),
      "the protected .dream-rsi verifier and legacy state are omitted from agent workspaces");
    assert.ok(fs.existsSync(verifier), "the original protected evaluator remains available to score candidates");

    const campaignProgressUpdates = updates.filter((update) => update.details?.progress?.project === result.details.campaign.campaignRoot);
    assert.ok(campaignProgressUpdates.some((update) => update.details.progress.phase === "live"),
      "campaign live snapshots are forwarded through the tool's progress updates");
    assert.ok(harness.widgets.some(([key, value]) => key === "dream-rsi" && value?.some((row) => /live 1:/.test(row))),
      "campaign live progress reaches the same TUI widget as legacy live cycles");

    const legacySnapshot = {
      version: 1, project: project.dreamRoot, iteration: 97, phase: "live", status: "complete",
      round: 1, round_budget: 1, workers: 1, completed: 1, best: 7,
      activity: "LEGACY_MANUAL_HISTORY", updated_at: Date.now(), attempts: {},
    };
    const legacyProgressPath = progressPath(project.dreamRoot, 97);
    fs.mkdirSync(path.dirname(legacyProgressPath), { recursive: true });
    fs.writeFileSync(legacyProgressPath, JSON.stringify(legacySnapshot), "utf8");

    const command = harness.commands.get("dream-rsi");
    context.mode = "print";
    await command.handler("watch", context);
    assert.match(harness.notifications.at(-1), /live 2:/,
      "default watch opens the completed campaign dashboard");
    await command.handler("watch legacy 97", context);
    assert.equal(harness.notifications.at(-1), "watch legacy 97 was removed in 1.0. Use /dream-rsi improve <what you want>.",
      "the legacy watch selector is retired without touching saved history");

    const status = await harness.tools.get("dream_rsi_improve").execute("status-with-campaign", { action: "status" }, undefined, undefined, context);
    assert.equal(status.details.campaign.campaignRoot, result.details.campaign.campaignRoot,
      "the campaign controller status reports the saved campaign");
    assert.doesNotMatch(status.content[0].text, /LEGACY_MANUAL_HISTORY/,
      "campaign status does not display the separate legacy progress snapshot");
  } finally {
    project.cleanup();
  }
});

test("campaign entry rejects an evaluator script that lives in the editable full-repository workspace", async () => {
  const project = makeProject();
  try {
    fs.writeFileSync(path.join(project.projectDir, "solution.py"), "x\n", "utf8");
    fs.mkdirSync(path.join(project.dreamRoot, "verifier"), { recursive: true });
    const declaredVerifier = path.join(project.dreamRoot, "verifier", "score.mjs");
    fs.writeFileSync(declaredVerifier, "process.exit(0);\n", "utf8");
    const { pi, context, harness } = mockPi();
    dreamRsi(pi);
    context.cwd = project.projectDir;
    await harness.handlers.get("session_start")({}, context);
    await harness.handlers.get("input")({ type: "input", source: "interactive", text: "Use Dream-RSI to improve this repository" }, context);

    const task = {
      name: "untrusted scorer",
      workspace: ".",
      eval_program: "solution.py",
      score_program: `node "${project.script("score-ok.mjs")}"`,
      agent_command: "node",
      agent_args: [project.script("agent-ok.mjs")],
    };
    await assert.rejects(harness.tools.get("dream_rsi_improve").execute("untrusted", {
      action: "start",
      project_dir: project.projectDir,
      goal: "Improve the score while preserving correctness",
      task,
      scope: ["solution.py"],
      verifier_inputs: [declaredVerifier],
    }, undefined, undefined, context), /score_program references evaluator code inside the editable workspace/);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "campaigns")), false,
      "untrusted scorer rejection happens before creating campaign state");
  } finally {
    project.cleanup();
  }
});
