/** Provider-free smoke of the protected self-scorer and the real promotion journal. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setupSelfCampaign } from "./setup-self-campaign.mjs";
import { normalizeTask } from "../extensions/pi-dream-rsi/engine/task.ts";
import { runCampaign } from "../extensions/pi-dream-rsi/engine/campaign.ts";
import { readTree } from "../extensions/pi-dream-rsi/engine/world.ts";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-smoke-"));
const quote = (value) => process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
try {
  for (const entry of ["extensions", "prompts", "eval", "skills", "docs", "scripts", "tests", ".auto"]) {
    fs.cpSync(path.join(source, entry), path.join(root, entry), { recursive: true });
  }
  for (const entry of ["package.json", "package-lock.json", "tsconfig.json", "PROBLEM.md"]) fs.copyFileSync(path.join(source, entry), path.join(root, entry));
  fs.symlinkSync(path.join(source, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const measureFile = path.join(root, "extensions/pi-dream-rsi/engine/measure.ts");
  const redundant = "      if (Math.abs(gain - plan.threshold) <= plan.exactTolerance) return { decision: decide({ plan, gains: [gain] }), baseline, pairs, runs };\n";
  fs.writeFileSync(measureFile, fs.readFileSync(measureFile, "utf8").replace("    if (plan.deterministic) {", `    if (plan.deterministic) {\n${redundant}`));
  const scenarios = JSON.parse(fs.readFileSync(path.join(source, "eval/scenarios.json"), "utf8"));
  const prepared = setupSelfCampaign(root, root, { target: "measure", scenarioConfig: { ...scenarios, seeds: 2000, held_out_seeds: 1000 } });
  const agent = path.join(root, ".dream-rsi", "smoke-agent.mjs");
  fs.writeFileSync(agent, `import fs from "node:fs";
let prompt="";process.stdin.on("data",part=>prompt+=part);process.stdin.on("end",()=>{
if(/adversarial review/i.test(prompt)){fs.writeFileSync("review.json",JSON.stringify({verdict:"accept",reasons:[]}));return;}
if(prompt.includes("Do not change files.")||prompt.includes("prefix-only exploration policy"))return;
const file="extensions/pi-dream-rsi/engine/measure.ts"; const before=fs.readFileSync(file,"utf8");
const after=before.replace(/      if \\(Math\\.abs\\(gain - plan\\.threshold\\) <= plan\\.exactTolerance\\) return \\{ decision: decide\\(\\{ plan, gains: \\[gain\\] \\}\\), baseline, pairs, runs \\};\\r?\\n/, "");
fs.writeFileSync(file,after);fs.writeFileSync("proposal.md","# Remove a redundant deterministic return\\nThe same decision is returned unconditionally on the following line.\\n");
process.stdout.write("removed bytes="+(before.length-after.length)+"\\n");
});
`);
  const scoped = prepared.intake.task;
  const task = normalizeTask({ ...scoped, agent: { command: "node", args: [agent], model: null, thinking: null, prompt_via: "stdin" } });
  const result = await runCampaign({ baseRoot: path.join(root, ".dream-rsi"), projectDir: root, task,
    goal: prepared.intake.goal, scope: prepared.intake.scope, verifierInputs: [...prepared.intake.verifier_inputs, agent],
    gates: [`node ${quote(path.join(prepared.verifierRoot, "eval/purity.mjs"))} extensions/pi-dream-rsi/engine/measure.ts`, "node --test tests/measure.test.mjs"],
    limits: { maxCycles: 1, maxAgentStarts: 12, maxEvaluatorRuns: 40, deadlineMs: 600_000, plateauCycles: 1 },
  });
  const applied = path.join(result.campaignRoot, "history/applied.jsonl");
  if (!fs.existsSync(applied)) {
    const attempts = readTree(result.campaignRoot, 1)?.list().filter((node) => node.meta.branch >= 0).map((node) => {
      const cwd = node.workspace ? path.resolve(root, node.workspace) : null;
      const scorePath = cwd ? path.join(cwd, "eval/score.json") : null;
      const score = scorePath && fs.existsSync(scorePath) ? JSON.parse(fs.readFileSync(scorePath, "utf8")) : null;
      return { cell: node.meta.cell_id, outcome: node.fail_class, score: score?.score, tokenDelta: score?.delta_tokens,
        proposal: cwd && fs.existsSync(path.join(cwd, "proposal.md")) ? fs.readFileSync(path.join(cwd, "proposal.md"), "utf8") : null };
    });
    process.stdout.write(`${JSON.stringify({ attempts, state: result.state })}\n`);
  }
  assert.equal(result.state.kind, "complete", result.stopReason);
  assert.ok(fs.existsSync(applied), JSON.stringify(result.rejections));
  assert.ok(result.currentScore > JSON.parse(fs.readFileSync(path.join(result.campaignRoot, "campaign.json"))).baselineScore);
  const entries = fs.readFileSync(path.join(result.campaignRoot, "history/ledger.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(entries.some((entry) => entry.kind === "review" && entry.outcome === "accept"));
  assert.ok(entries.some((entry) => entry.kind === "apply"));
  process.stdout.write(`${JSON.stringify({ passed: true, agentStarts: result.agentStarts, evaluatorRuns: result.evaluatorRuns,
    verifiedScore: result.currentScore, primarySeeds: 2000, heldoutSeeds: 1000, gate: "purity and measurement behavior", committed: false })}\n`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
