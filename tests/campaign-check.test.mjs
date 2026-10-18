import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { jump, makeProject } from "./fixtures.mjs";

test("check measures fresh copies, keeps per-reading evidence, and persists only a check report", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const result = await campaign.checkCampaignEvaluator({
      baseRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task: project.task,
      verifierInputs: [path.join(project.projectDir, "score-ok.mjs")],
      runs: 3,
    });
    assert.equal(result.runs.length, 3);
    assert.ok(result.runs.every((run) => run.code === 0 && run.valid && run.score === 0 && run.durationMs >= 0));
    assert.ok(result.runs.every((run) => typeof run.logPath === "string" && fs.existsSync(run.logPath)), "each reading keeps its own log on disk");
    assert.ok(result.runs.every((run) => "stdoutTail" in run && "stderrTail" in run), "each reading keeps bounded tails");
    assert.equal(result.qualified, true);
    assert.equal(result.plannedRuns, 3);
    assert.equal(result.spread, 0);
    assert.equal(result.recommendedMinimumGain, 0);
    assert.ok(fs.existsSync(result.reportPath));
    assert.deepEqual(fs.readdirSync(path.join(project.dreamRoot, "checks")).filter((file) => file.endsWith(".json")), [path.basename(result.reportPath)]);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "campaigns")), false);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "history", "seed", "score.json")), false);
    assert.equal(fs.existsSync(path.join(project.seed, "eval", "score.json")), false);
  } finally { project.cleanup(); }
});

test("check fails fast on the first invalid reading and does not spawn the gates", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "invalid-first.mjs");
    const counter = path.join(project.dir, "invalid-first-count.txt");
    const gateMarker = path.join(project.dir, "gate-ran.txt");
    fs.writeFileSync(scorer, `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\nconst counter = ${JSON.stringify(counter)};\nconst n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;\nwriteFileSync(counter, String(n));\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: 0, valid: false, fail_class: "wrong_answer", error: "answer is wrong" }));\n`);
    const gate = path.join(project.projectDir, "gate-marker.mjs");
    fs.writeFileSync(gate, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(gateMarker)}, "ran");\n`);
    const report = await campaign.checkCampaignEvaluator({
      baseRoot: project.dreamRoot, projectDir: project.projectDir,
      task: { ...project.task, score_program: `node "${scorer}"` },
      verifierInputs: [scorer, gate], gates: [`node "${gate}"`], runs: 3,
    });
    assert.equal(Number(fs.readFileSync(counter, "utf8")), 1, "an invalid reading is not retried");
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0].failClass, "wrong_answer");
    assert.match(report.runs[0].error, /answer is wrong/);
    assert.equal(report.qualified, false);
    assert.equal(report.gateRuns.length, 1);
    assert.equal(report.gateRuns[0].passed, false);
    assert.equal(report.gateRuns[0].code, null, "the gate is recorded as not run, not as a pass or a failure");
    assert.match(report.gateRuns[0].error, /not run/i);
    assert.equal(fs.existsSync(gateMarker), false, "no gate process is spawned after an invalid reading");
    assert.ok(report.diagnoses.some((message) => /invalid|valid score/i.test(message)), "the report names the failing reading");
    assert.ok(fs.existsSync(report.reportPath), "the report survives the failure");
  } finally { project.cleanup(); }
});

test("check resumes from paid readings instead of re-running them", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "counted-score.mjs");
    const counter = path.join(project.dir, "counted-score-count.txt");
    fs.writeFileSync(scorer, `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\nconst counter = ${JSON.stringify(counter)};\nconst n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;\nwriteFileSync(counter, String(n));\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: 0, valid: true, fail_class: "ok", error: null }));\n`);
    const file = path.join(project.projectDir, "counted-score.mjs");
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const prior = await campaign.checkCampaignEvaluator({ baseRoot: project.dreamRoot, projectDir: project.projectDir, task, verifierInputs: [file], runs: 3 });
    assert.equal(Number(fs.readFileSync(counter, "utf8")), 3);
    const resumed = await campaign.checkCampaignEvaluator({
      baseRoot: project.dreamRoot, projectDir: project.projectDir, task, verifierInputs: [file], runs: 5,
      priorRuns: prior.runs,
    });
    assert.equal(Number(fs.readFileSync(counter, "utf8")), 5, "only the two missing readings are paid for");
    assert.equal(resumed.runs.length, 5);
    assert.deepEqual(
      resumed.runs.slice(0, 3).map((run) => ({ durationMs: run.durationMs, code: run.code, valid: run.valid, failClass: run.failClass, score: run.score })),
      prior.runs.map((run) => ({ durationMs: run.durationMs, code: run.code, valid: run.valid, failClass: run.failClass, score: run.score })),
      "saved readings are carried through unchanged",
    );
    assert.equal(resumed.qualified, true);
  } finally { project.cleanup(); }
});

test("promotion floors expose the same minimums the campaign enforces", async () => {
  const campaign = await jump("engine/campaign.ts");
  const exact = campaign.promotionFloor({ readings: 5, gates: 0, deterministic: true, evaluatorTimeoutMs: 200_000 });
  assert.equal(exact.evaluatorRuns, 7, "5 readings + one exact 2-run confirmation");
  assert.equal(exact.agentStarts, 3, "two first-round experiment attempts + review");
  assert.equal(exact.durationMs, 7 * 200_000);
  const noisy = campaign.promotionFloor({ readings: 5, gates: 2, deterministic: false, evaluatorTimeoutMs: 200_000 });
  assert.equal(noisy.evaluatorRuns, 28, "5 readings + 2 gates + a 21-run noisy confirmation");
  assert.ok(noisy.durationMs >= 28 * 200_000);
  assert.equal(noisy.confirmationRuns, 21);
});


test("check keeps unrepresentable score spreads out of its JSON report", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "extreme-score.mjs");
    const marker = path.join(project.dir, "extreme-score-count.txt");
    fs.writeFileSync(scorer, `import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";\nconst marker=${JSON.stringify(marker)}; const n=existsSync(marker)?Number(readFileSync(marker,"utf8")):0; writeFileSync(marker,String(n+1)); mkdirSync("eval",{recursive:true}); writeFileSync("eval/score.json",JSON.stringify({score:n===0?Number.MAX_VALUE:-Number.MAX_VALUE,valid:true,fail_class:"ok",error:null}));\n`);
    const report = await campaign.checkCampaignEvaluator({
      baseRoot: project.dreamRoot, projectDir: project.projectDir,
      task: { ...project.task, score_program: `node "${scorer}"` },
      verifierInputs: [scorer], runs: 2,
    });
    assert.equal(report.spread, null);
    assert.ok(Number.isFinite(report.recommendedMinimumGain));
    assert.ok(report.diagnoses.some((message) => /finite numeric range/i.test(message)));
    assert.equal(JSON.parse(fs.readFileSync(report.reportPath, "utf8")).spread, null);
  } finally { project.cleanup(); }
});

test("check diagnoses relative evaluator paths that only resolve from the target", async () => {
  const project = makeProject();
  let scratchScript;
  try {
    const campaign = await jump("engine/campaign.ts");
    const workspace = path.join(project.projectDir, "nested");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "solution.py"), "print('nested')\n");
    const relativeName = `relative-check-${crypto.randomUUID()}.mjs`;
    const declaredScript = path.join(project.projectDir, relativeName);
    scratchScript = path.join(os.tmpdir(), relativeName);
    const marker = path.join(project.dir, "escaped-script-started.txt");
    fs.writeFileSync(declaredScript, "process.exit(0);\n");
    fs.writeFileSync(scratchScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started"); process.exit(0);\n`);
    const task = { ...project.task, workspace: "nested", score_program: `node ../${relativeName}` };
    const report = await campaign.checkCampaignEvaluator({
      baseRoot: project.dreamRoot, projectDir: project.projectDir, task,
      verifierInputs: [declaredScript], gates: ["node -e \"process.exit(0)\""], runs: 2,
    });
    assert.ok(report.diagnoses.some((message) => /use an absolute path/i.test(message)));
    assert.equal(fs.existsSync(marker), false, "the escaped relative scorer is diagnosed without execution");
    assert.equal(report.runs.length, 1, "a configuration error fails fast instead of repeating the same invalid reading");
    assert.ok(report.runs.every((run) => run.code === null && run.failClass === "configuration_error" && !run.valid));
    assert.equal(report.gateRuns.length, 1);
    assert.equal(report.gateRuns[0].code, null);
    assert.equal(report.gateRuns[0].passed, false);
    assert.ok(fs.existsSync(report.reportPath), "configuration failures still produce the check report");
  } finally {
    if (scratchScript) fs.rmSync(scratchScript, { force: true });
    project.cleanup();
  }
});

test("check diagnoses missing interpreters without imposing the old timeout ceiling", async () => {
  const project = makeProject({ evaluatorTimeoutMs: 900_000 });
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "missing-command.mjs");
    fs.writeFileSync(scorer, "process.exit(127);\n");
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const report = await campaign.checkCampaignEvaluator({
      baseRoot: project.dreamRoot, projectDir: project.projectDir, task,
      verifierInputs: [scorer], runs: 1,
    });
    assert.ok(report.diagnoses.some((message) => /interpreter not found on PATH/i.test(message)));
    assert.equal(report.diagnoses.some((message) => /capped/i.test(message)), false);
    assert.equal(report.runs[0].code, 127);
  } finally { project.cleanup(); }
});

test("check records a real evaluator timeout diagnosis", async () => {
  const project = makeProject({ evaluatorTimeoutMs: 1000 });
  try {
    const campaign = await jump("engine/campaign.ts");
    const scorer = path.join(project.projectDir, "hang.mjs");
    fs.writeFileSync(scorer, "setInterval(() => {}, 1000);\n");
    const task = { ...project.task, score_program: `node "${scorer}"` };
    const report = await campaign.checkCampaignEvaluator({
      baseRoot: project.dreamRoot, projectDir: project.projectDir, task,
      verifierInputs: [scorer], runs: 1,
    });
    assert.equal(report.runs[0].failClass, "timeout");
    assert.ok(report.diagnoses.some((message) => /evaluator takes \d+ s/i.test(message)));
  } finally { project.cleanup(); }
});

test("check reports gates that fail on the unchanged target", async () => {
  const project = makeProject();
  try {
    const campaign = await jump("engine/campaign.ts");
    const gate = path.join(project.projectDir, "gate.mjs");
    fs.writeFileSync(gate, "process.exit(4);\n");
    const report = await campaign.checkCampaignEvaluator({
      baseRoot: project.dreamRoot, projectDir: project.projectDir, task: project.task,
      verifierInputs: [path.join(project.projectDir, "score-ok.mjs"), gate], gates: [`node "${gate}"`], runs: 1,
    });
    assert.equal(report.gateRuns.length, 1);
    assert.equal(report.gateRuns[0].passed, false);
    assert.ok(report.diagnoses.some((message) => /gate failed on the unchanged target/i.test(message)));
  } finally { project.cleanup(); }
});
