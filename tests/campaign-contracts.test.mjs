import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { jump, makeProject } from "./fixtures.mjs";

test("SDK intake rejects omitted score direction without any subprocess", async () => {
  const project = makeProject();
  try {
    const { runCampaign } = await jump("engine/campaign.ts");
    const { higher_is_better, ...task } = project.task;
    await assert.rejects(runCampaign({ baseRoot: project.dreamRoot, projectDir: project.projectDir, task,
      goal: "Improve correctness", verifierInputs: [project.script("score-ok.mjs")] }), /higher_is_better.*explicit/);
    assert.equal(fs.existsSync(path.join(project.dreamRoot, "campaigns", "active.json")), false);
  } finally { project.cleanup(); }
});

test("a wrong-direction known-better control fails before any agent starts", async () => {
  const project = makeProject();
  try {
    const { runCampaign } = await jump("engine/campaign.ts");
    const scorer = project.script("score-control.mjs");
    fs.writeFileSync(scorer, 'import fs from "node:fs"; const s=fs.readFileSync("solution.py","utf8"); fs.mkdirSync("eval",{recursive:true}); fs.writeFileSync("eval/score.json",JSON.stringify({score:100+(s.match(/x/g)||[]).length,valid:true,fail_class:"ok",error:null}));\n');
    const patch = project.script("control.patch");
    fs.writeFileSync(patch, '--- a/solution.py\n+++ b/solution.py\n@@ -1 +1,2 @@\n print("seed")\n+x\n');
    const result = await runCampaign({ baseRoot: project.dreamRoot, projectDir: project.projectDir,
      task: { ...project.task, higher_is_better: false, score_program: `node "${scorer}"` },
      goal: "Reduce cost", scope: ["solution.py"], verifierInputs: [scorer], controlPatch: patch });
    assert.equal(result.agentStarts, 0);
    assert.equal(result.state.kind, "failed");
    assert.match(result.stopReason, /preflight failed/);
    assert.equal(fs.readFileSync(path.join(project.seed, "solution.py"), "utf8"), 'print("seed")\n');
    const record = JSON.parse(fs.readFileSync(path.join(result.campaignRoot, "campaign.json")));
    assert.equal(record.checkReport.control.validated, false);
    assert.equal(record.checkReport.direction, "minimize");
  } finally { project.cleanup(); }
});

test("percentage thresholds resolve in raw metric units before the probe", async () => {
  const project = makeProject();
  try {
    const { runCampaign } = await jump("engine/campaign.ts");
    const scorer = project.script("score-scaled.mjs");
    fs.writeFileSync(scorer, 'import fs from "node:fs"; fs.mkdirSync("eval",{recursive:true}); fs.writeFileSync("eval/score.json",JSON.stringify({score:600,valid:true,fail_class:"ok",error:null}));\n');
    // A campaign refuses caps that cannot fund one verified promotion, so the cheap
    // stop is now the shared reservation before the probe spawn, not a 1-start cap.
    const result = await runCampaign({ baseRoot: project.dreamRoot, projectDir: project.projectDir,
      task: { ...project.task, score_program: `node "${scorer}"` }, goal: "Improve the metric", scope: ["solution.py"],
      verifierInputs: [scorer], minimumGain: "5%", limits: { maxCycles: 1, maxAgentStarts: 7 },
      beforeAgentSpawn: () => { throw new Error("cheap stop at the campaign probe"); } });
    const record = JSON.parse(fs.readFileSync(path.join(result.campaignRoot, "campaign.json")));
    assert.equal(record.minimumGain, 30);
    assert.equal(record.checkReport.threshold_resolved, 30);
    assert.equal(record.baselineScores.length, 5);
    assert.equal(result.agentStarts, 1);
  } finally { project.cleanup(); }
});
