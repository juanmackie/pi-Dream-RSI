import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setup = JSON.parse(fs.readFileSync(path.join(root, ".audit", "self-setup-report.json"), "utf8"));
const intake = JSON.parse(fs.readFileSync(setup.intake, "utf8"));
const { normalizeTask } = await import(pathToFileURL(path.join(root, "extensions/pi-dream-rsi/engine/task.ts")).href);
const { checkCampaignEvaluator } = await import(pathToFileURL(path.join(root, "extensions/pi-dream-rsi/engine/campaign.ts")).href);
const report = await checkCampaignEvaluator({
  baseRoot: path.join(root, ".dream-rsi"),
  projectDir: intake.project_dir,
  task: normalizeTask(intake.task),
  verifierInputs: intake.verifier_inputs,
  gates: intake.gates,
  runs: 3,
});
fs.writeFileSync(path.join(root, ".audit", "self-campaign-check.json"), `${JSON.stringify(report, null, 2)}\n`);
assert.ok(report.runs.every((run) => run.valid), "snapshot scorer must return valid scores");
assert.ok(report.gateRuns.every((run) => run.passed), "both policy and full project-test gates must pass in fresh copies");
assert.deepEqual(report.diagnoses, []);
console.log(JSON.stringify({
  validScores: report.runs.map((run) => run.score),
  gates: report.gateRuns.map((run) => ({ command: run.command, passed: run.passed })),
  diagnoses: report.diagnoses,
  reportPath: report.reportPath,
}));
