import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { normalizeRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";
import { buildReconInventory, reconProject } from "../extensions/pi-dream-rsi/engine/recon.ts";
import { synthesizeMetric } from "../extensions/pi-dream-rsi/engine/metrics.ts";

const CHILD_RUNNER = `import path from "node:path";
import { pathToFileURL } from "node:url";
// Resolve from this process's cwd so qualification's active scratch copy is loaded.
const moduleUrl = pathToFileURL(path.resolve(process.cwd(), "src/model.mjs"));
const { accuracy } = await import(moduleUrl.href);
console.log(JSON.stringify({ score: accuracy(), workspace: process.cwd() }));
`;
const DYNAMIC_EVALUATOR = `import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["child-runner.mjs"], { cwd: process.cwd(), encoding: "utf8" });
if (result.error || result.status !== 0) {
  console.error(result.error?.message || result.stderr || "child workload failed");
  process.exit(1);
}
const child = JSON.parse(result.stdout);
console.log(JSON.stringify({ score: child.score, valid: true }));
`;
const CONSTANT_EVALUATOR = `console.log(JSON.stringify({ score: 0.9, valid: true }));\n`;

function project({ evaluator = DYNAMIC_EVALUATOR } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-dynamic-"));
  const files = {
    "package.json": JSON.stringify({ name: "dynamic-score", private: true, type: "module", scripts: { bench: "node unrelated-bench.mjs", test: "node gate.mjs" } }, null, 2) + "\n",
    "unrelated-bench.mjs": 'import "./docs/unrelated.mjs";\n',
    "docs/unrelated.mjs": "export const irrelevant = true;\n",
    "child-runner.mjs": CHILD_RUNNER,
    "gate.mjs": 'import { accuracy } from "./src/model.mjs";\nif (accuracy() !== 0.9) process.exit(1);\n',
    "src/model.mjs": "export const accuracy = () => 0.9;\n",
    "eval/score.mjs": evaluator,
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

function contract() {
  return normalizeRunContract({
    version: 1,
    outcome: {
      statement: "raise model accuracy", unit: "points", higherIsBetter: true, minimumUsefulGain: "10%",
      evaluator: { argv: ["node", "eval/score.mjs"], output: "stdout-json", inputs: ["eval/score.mjs"] },
    },
    preserved: { gates: [] },
    scope: { roots: ["src"], protectedAssets: [] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    models: { providers: ["fixture"] },
    budgets: { maxCampaigns: 1, maxAgentStarts: 4, maxEvaluatorRuns: 40, deadlineMs: 120_000, falseAcceptBudget: 0.01 },
  });
}

async function qualifyDynamic(projectDir, runContract) {
  const recon = await reconProject({
    projectDir, contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 100, timedOut: false, error: null }),
  });
  const inventory = buildReconInventory({ contract: runContract, recon });
  assert.equal(inventory.levers.length, 1, `expected a dynamic attribution claim: ${JSON.stringify(inventory.rejected)}`);
  const lever = inventory.levers[0];
  assert.deepEqual(lever.scopeFiles, ["src/model.mjs"]);
  assert.ok(lever.reasons.some((reason) => /unverified dynamic claim/i.test(reason)));
  assert.deepEqual(lever.gates, ["npm run test"], "only the one meaningful correctness gate is used");
  const evaluator = runContract.outcome.evaluator;
  const plan = await synthesizeMetric({
    projectDir,
    loopRoot: path.join(projectDir, ".dream-rsi", "loop"),
    lever,
    scoreEvaluator: {
      argv: [...evaluator.argv], output: evaluator.output, inputs: [...evaluator.inputs],
      unit: runContract.outcome.unit, higherIsBetter: runContract.outcome.higherIsBetter,
    },
    qualification: {
      contract: runContract,
      workRoot: path.join(projectDir, ".dream-rsi", "loop", "qualification"),
      outcome: runContract.outcome.statement,
      minimumUsefulGain: runContract.outcome.minimumUsefulGain,
    },
  });
  return { lever, plan, report: plan.qualification };
}

test("dynamic attribution is provisional until active scratch-workspace qualification proves sensitivity", async () => {
  const runContract = contract();
  const positiveProject = project();
  const positive = await qualifyDynamic(positiveProject, runContract);
  assert.equal(positive.report.passed, true, JSON.stringify(positive.report.rejections));
  assert.equal(positive.plan.ready, true);
  const sensitivity = positive.report.checks.find((check) => check.name === "sensitivity");
  assert.ok(sensitivity?.passed);
  assert.match(sensitivity.detail, /inert version of the editable code invalidates the score/i, "the broken implementation control is rejected by the declared evaluator");
  assert.ok(positive.plan.evaluationContract.argv.includes("eval/score.mjs"), "the pinned evaluator remains the measured command");

  const blindProject = project({ evaluator: CONSTANT_EVALUATOR });
  const blind = await qualifyDynamic(blindProject, runContract);
  assert.equal(blind.report.passed, false, "a constant evaluator cannot qualify merely because roots nominate a candidate");
  assert.equal(blind.report.checks.find((check) => check.name === "sensitivity")?.passed, false);
});
