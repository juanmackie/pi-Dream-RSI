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

  const orderPath = project.script("campaign-order.jsonl");
  const scorerPath = project.script("loader-score.mjs");
  const agentPath = project.script("loader-agent.mjs");
  fs.writeFileSync(scorerPath, `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(orderPath)}, "score\\n");
const source = readFileSync("solution.py", "utf8");
mkdirSync("eval", { recursive: true });
writeFileSync("eval/score.json", JSON.stringify({ score: (source.match(/x/g) ?? []).length, valid: true, fail_class: "ok", error: null }));
`);
  fs.writeFileSync(agentPath, `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(orderPath)}, "agent\\n");
let prompt = ""; process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (/adversarial review/i.test(prompt)) { writeFileSync("review.json", JSON.stringify({ verdict: "accept", reasons: [] })); return; }
  if (prompt.includes("Do not change files.") || prompt.includes("prefix-only exploration policy")) { process.stdout.write("Inspected.\\n"); return; }
  writeFileSync("solution.py", readFileSync("solution.py", "utf8") + "x\\n");
  writeFileSync("proposal.md", "# fixture win\\n");
});
`);

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
      score_program: `node "${scorerPath}"`,
      problem_file: "PROBLEM.md",
      higher_is_better: true,
      agent_timeout_ms: 20_000,
      evaluator_timeout_ms: 600_000,
      agent_command: "node",
      agent_args: [agentPath],
    },
    scope: ["solution.py"],
    verifier_inputs: [scorerPath],
    max_cycles: 1,
    max_agent_starts: 24,
    max_evaluator_runs: 80,
  }, undefined, (update) => updates.push(update), context);

  if (!result.details?.campaign) throw new Error(`Pi loader campaign start failed: ${result.content?.map((part) => part.text ?? "").join("\n")}`);
  const campaign = JSON.parse(fs.readFileSync(path.join(result.details.campaign.campaignRoot, "campaign.json"), "utf8"));
  const afterBaselineEvaluation = updates.find((update) => update.details?.campaign?.evaluatorRuns >= 5);
  if (!afterBaselineEvaluation) throw new Error("Pi loader did not report completion of the five-score baseline");
  const events = fs.readFileSync(orderPath, "utf8").trim().split(/\r?\n/);
  const firstAgent = events.indexOf("agent");
  const fifthBaselineScore = events.map((event, index) => event === "score" ? index : -1).filter((index) => index >= 0)[4];
  if (fifthBaselineScore === undefined || firstAgent < 0 || fifthBaselineScore >= firstAgent) {
    throw new Error(`Expected five baseline scorer runs before any agent; observed ${JSON.stringify(events)}`);
  }

  process.stdout.write(`${JSON.stringify({
    status: status.details,
    start: result.details,
    persistedTimeoutMs: campaign.task.evaluator_timeout_ms,
    baselineEvaluatorRuns: afterBaselineEvaluation.details.campaign.evaluatorRuns,
    baselineScoreCount: campaign.baselineScores.length,
    baselineRuntime: afterBaselineEvaluation.details.runtime,
    agentStartsAtBaseline: 0,
  })}\n`);
  process.stderr.write("[campaign-loader-smoke] completed provider-free campaign\n");
} finally {
  project.cleanup();
}
