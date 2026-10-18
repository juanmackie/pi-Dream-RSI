import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { jump, makeProject } from "./fixtures.mjs";

const { runCampaign } = await jump("engine/campaign.ts");

test("campaign entry records an experiment world and attempt evidence", async () => {
  const project = makeProject();
  try {
    const result = await runCampaign({
      baseRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task: project.task,
      goal: "Improve the measured fixture score while preserving validity",
      scope: ["solution.py"],
      verifierInputs: [project.script("score-ok.mjs")],
      mechanism: "fixture hill climb",
      limits: { maxCycles: 1, maxAgentStarts: 12, maxEvaluatorRuns: 48, deadlineMs: 120_000, plateauCycles: 1, maxCandidatesPerCycle: 3 },
    });
    const cycleDir = path.join(result.campaignRoot, "cycles", "c0001");
    const world = JSON.parse(fs.readFileSync(path.join(cycleDir, "world.json"), "utf8"));
    assert.equal(world.status, "complete");
    assert.ok(world.nodes.length >= 1);
    const first = world.nodes.find((node) => node.stage === "done");
    assert.ok(first, "the world records at least one completed attempt");
    for (const file of ["prompt.md", "agent.log", "eval.log", "attempt-evidence.json", "proposal.md"]) {
      assert.ok(fs.existsSync(path.join(cycleDir, "attempts", first.id, file)), `${file} is persisted for ${first.id}`);
    }
  } finally {
    project.cleanup();
  }
});