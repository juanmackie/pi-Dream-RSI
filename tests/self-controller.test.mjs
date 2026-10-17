import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { REPO } from "./fixtures.mjs";
import { setupSelfCampaign } from "../scripts/setup-self-campaign.mjs";

test("protected controller scorer imports and measures the actual workspace controller", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-controller-self-"));
  try {
    for (const entry of ["extensions", "prompts"]) fs.cpSync(path.join(REPO, entry), path.join(root, entry), { recursive: true });
    fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
    const setup = setupSelfCampaign(root, REPO, { target: "controller" });
    const run = spawnSync(process.execPath, [path.join(setup.verifierRoot, "eval/self-controller.mjs"), root], {
      cwd: root, encoding: "utf8", timeout: 180_000, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    const score = JSON.parse(fs.readFileSync(path.join(root, "eval/score.json"), "utf8"));
    assert.equal(run.status, 0, run.stderr + JSON.stringify(score));
    assert.equal(score.valid, true);
    assert.equal(score.benchmark.falseApplies, 0);
    assert.equal(score.benchmark.trueWins, 1);
    assert.ok(score.benchmark.agentStarts > 0);
    assert.ok(score.score > 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("prompt self-target requires a matching real-model baseline and preserves its cumulative budget", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-prompts-setup-"));
  try {
    fs.cpSync(path.join(REPO, "prompts"), path.join(root, "prompts"), { recursive: true });
    const names = ["discovery-agent.md", "policy-improvement.md", "adversarial-review.md"];
    const promptHashes = Object.fromEntries(names.map((name) => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "prompts", name))).digest("hex")]));
    const baselinePath = path.join(root, "baseline.json");
    fs.writeFileSync(baselinePath, JSON.stringify({ model: "offline/test", promptHashes, selectedFixtures: ["node-index", "python-csv"],
      rates: { meanWinRate: 0.1, proposalRate: 0.5, editRate: 0.3, timeoutRate: 0.1 } }));
    const options = { target: "prompts", tier2Budget: 18, tier2Model: "offline/test", tier2Baseline: baselinePath };
    const first = setupSelfCampaign(root, REPO, options);
    const config = JSON.parse(fs.readFileSync(path.join(first.verifierRoot, ".auto/prompts-config.json"), "utf8"));
    assert.equal(first.intake.scope.length, 3);
    assert.match(first.intake.task.score_program, /prompt-score\.mjs/);
    assert.equal(config.total_agent_budget, 18);
    assert.deepEqual(config.baselinePromptHashes, promptHashes);
    assert.deepEqual(config.fixtures, ["node-index", "python-csv"]);
    fs.writeFileSync(baselinePath, JSON.stringify({ model: "offline/test", promptHashes, selectedFixtures: [],
      rates: { meanWinRate: 0.1, proposalRate: 0.5, editRate: 0.3, timeoutRate: 0.1 } }));
    assert.throws(() => setupSelfCampaign(root, REPO, options), /non-empty list of unique fixture names/);
    fs.writeFileSync(baselinePath, JSON.stringify({ model: "offline/test", promptHashes, selectedFixtures: ["not-a-fixture"],
      rates: { meanWinRate: 0.1, proposalRate: 0.5, editRate: 0.3, timeoutRate: 0.1 } }));
    assert.throws(() => setupSelfCampaign(root, REPO, options), /unknown fixture/);
    fs.writeFileSync(baselinePath, JSON.stringify({ model: "offline/test", promptHashes, selectedFixtures: ["node-index", "python-csv"],
      rates: { meanWinRate: 0.1, proposalRate: 0.5, editRate: 0.3, timeoutRate: 0.1 } }));
    fs.mkdirSync(path.dirname(config.budget_file), { recursive: true });
    fs.writeFileSync(config.budget_file, '{"version":1,"limit":18,"spent":7}\n');
    assert.equal(setupSelfCampaign(root, REPO, options).hash, first.hash);
    assert.equal(JSON.parse(fs.readFileSync(config.budget_file)).spent, 7);
    assert.throws(() => setupSelfCampaign(root, REPO, { ...options, tier2Model: "different/model" }), /baseline must contain its model/);
    assert.equal(fs.existsSync(path.join(root, "eval/score.json")), false, "setup makes no real-model calls");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
