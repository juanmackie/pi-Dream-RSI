import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { EXT, makeProject, mockPi } from "../fixtures.mjs";

const configuredPackageRoot = process.env.DREAM_RSI_PI_PACKAGE_ROOT;
const packageEntry = configuredPackageRoot
  ? path.join(configuredPackageRoot, "dist", "index.js")
  : fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const packageRoot = path.dirname(path.dirname(packageEntry));
const extensionLoader = await import(pathToFileURL(path.join(packageRoot, "dist", "core", "extensions", "loader.js")).href);
const { loadExtensions, createExtensionRuntime } = extensionLoader;
const project = makeProject();

try {
  process.stderr.write("[campaign-loader-smoke] loading extension through Pi's loader\n");
  const loaded = await loadExtensions([path.join(EXT, "index.ts")], project.projectDir, undefined, createExtensionRuntime());
  if (loaded.errors.length > 0) throw new Error(loaded.errors.map((item) => item.error).join("\n"));
  const extension = loaded.extensions.find((item) => item.tools.has("dream_rsi_improve"));
  if (!extension) throw new Error("Pi loader did not register dream_rsi_improve");
  process.stderr.write("[campaign-loader-smoke] invoking registered status and start tools\n");

  const contextBundle = mockPi();
  const context = contextBundle.context;
  context.cwd = project.projectDir;
  loaded.runtime.getActiveTools = () => contextBundle.harness.activeTools;
  loaded.runtime.setActiveTools = (tools) => { contextBundle.harness.activeTools = [...tools]; };
  loaded.runtime.appendEntry = (customType, data) => contextBundle.harness.entries.push({ type: "custom", customType, data });
  await extension.handlers.get("session_start")?.[0]?.({}, context);

  const improve = extension.tools.get("dream_rsi_improve")?.definition;
  if (!improve) throw new Error("Pi loader returned no registered improve tool definition");
  const status = await improve.execute("loader-status", { action: "status" }, undefined, undefined, context);
  await extension.handlers.get("input")?.[0]?.({
    type: "input", source: "interactive", text: "Use Dream-RSI to improve the fixture score",
  }, context);

  const updates = [];
  const result = await improve.execute("loader-timeout-smoke", {
    action: "start",
    project_dir: project.projectDir,
    goal: "Increase the fixture score while preserving validity",
    task: {
      name: "Pi loader timeout smoke",
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
  }, undefined, (update) => updates.push(update), context);

  const campaign = JSON.parse(fs.readFileSync(path.join(result.details.campaign.campaignRoot, "campaign.json"), "utf8"));
  const beforeBaselineEvaluation = updates.find((update) => /effective evaluator timeout: 300000ms/.test(update.content?.[0]?.text ?? ""));
  if (!beforeBaselineEvaluation) throw new Error("Pi loader did not report the effective timeout before baseline evaluation");

  process.stdout.write(`${JSON.stringify({
    status: status.details,
    start: result.details,
    persistedTimeoutMs: campaign.task.evaluator_timeout_ms,
    baselineEvaluatorRuns: beforeBaselineEvaluation.details.campaign.evaluatorRuns,
    baselineRuntime: beforeBaselineEvaluation.details.runtime,
  })}\n`);
  process.stderr.write("[campaign-loader-smoke] completed provider-free campaign\n");
} finally {
  project.cleanup();
}
