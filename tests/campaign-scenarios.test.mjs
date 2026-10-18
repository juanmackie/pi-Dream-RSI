import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import test from "node:test";
import { jump, makeProject } from "./fixtures.mjs";
import { runControllerBenchmark } from "./helpers/controller.mjs";

test("controller benchmark rejects forged success and ledger claims when its independent gate fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-forged-controller-"));
  try {
    const fake = path.join(root, "fake-campaign.mjs");
    fs.writeFileSync(fake, `import { writeFileSync } from "node:fs"; import * as path from "node:path";
export async function runCampaign({ projectDir, task }) {
 const target = path.join(projectDir, task.workspace, task.eval_program);
 writeFileSync(target, "seed CHEAT\\n");
 return { campaignRoot: projectDir, state: { kind: "complete" }, agentStarts: 1, evaluatorRuns: 1, currentScore: 999,
   baselineScores: [0], stopped: true, stopReason: "success" };
}`);
    const result = await runControllerBenchmark({ campaignModule: fake, workRoot: path.join(root, "runs"), scenarios: ["cheat"] });
    assert.equal(result.passed, false);
    assert.equal(result.falseApplies, 1, "the observed changed target and failing external gate override forged status fields");
    assert.equal(result.agentStarts, 0, "claimed candidate counters do not replace observed fixture subprocesses");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("integrated campaigns enforce win, gate, review, no-op, direction, timeout, and duplicate scenarios", async (t) => {
  const { runCampaign } = await jump("engine/campaign.ts");
  const cases = [
    { name: "truewin", scenario: "truewin", applied: true },
    { name: "cheat is stopped by a correctness gate", scenario: "cheat", applied: false, gate: true },
    { name: "review rejection prevents a false apply", scenario: "reviewReject", applied: false },
    { name: "no-op candidate is not applied", scenario: "noop", applied: false },
    { name: "regression candidate is not applied", scenario: "regression", applied: false, seed: "x\n" },
    { name: "wrong-direction candidate is not applied", scenario: "truewin", applied: false, higherIsBetter: false },
    // The stub hangs forever, so the timeout path always triggers; 5 s only guarantees the
    // stub's Node process starts and writes its edit even under parallel test load.
    { name: "valid edits survive an agent timeout assessment", scenario: "timeout", applied: true, timeoutMs: 5_000 },
    { name: "duplicate candidate patch is applied at most once", scenario: "duplicate", applied: true },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (st) => {
    const project = makeProject({ agent: "agent-scenario.mjs" });
    st.after(() => project.cleanup());
    if (scenario.seed) fs.writeFileSync(path.join(project.seed, "solution.py"), scenario.seed);
    if (scenario.gate) {
      const gate = project.script("gate-no-cheat.mjs");
      fs.writeFileSync(gate, `import { readFileSync } from "node:fs"; process.exit(readFileSync("solution.py", "utf8").includes("CHEAT") ? 1 : 0);\n`);
    }
    const task = {
      ...project.task,
      higher_is_better: scenario.higherIsBetter ?? true,
      agent_timeout_ms: scenario.timeoutMs ?? 20_000,
      agent: { ...project.task.agent, env: { DREAM_SCENARIO: scenario.scenario } },
    };
    const result = await runCampaign({
      baseRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task,
      goal: "Improve the measured solution while preserving correctness",
      scope: ["solution.py"],
      verifierInputs: [project.script("score-ok.mjs"), ...(scenario.gate ? [project.script("gate-no-cheat.mjs")] : [])],
      gates: scenario.gate ? [`node "${project.script("gate-no-cheat.mjs")}"`] : [],
      mechanism: "paired-hill-climb",
      parentCampaignId: "prior-campaign",
      limits: { maxCycles: 1, maxAgentStarts: 18, maxEvaluatorRuns: 80, deadlineMs: 90_000, plateauCycles: 1, maxCandidatesPerCycle: 3 },
    });
    const appliedFile = path.join(result.campaignRoot, "history", "applied.jsonl");
    const applied = fs.existsSync(appliedFile) ? fs.readFileSync(appliedFile, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
    assert.equal(applied.length > 0, scenario.applied, JSON.stringify(result.rejections));
    const ledger = fs.readFileSync(path.join(result.campaignRoot, "history", "ledger.jsonl"), "utf8")
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    if (scenario.applied && scenario.scenario === "truewin") {
      const apply = ledger.find((entry) => entry.kind === "apply" && entry.outcome === "success");
      assert.ok(apply, "the promoted event is present in the experiment ledger");
      assert.match(apply.provenance.contractId, /^[a-f0-9]{64}$/);
      assert.match(apply.provenance.instrumentId, /^[a-f0-9]{64}$/);
      assert.match(apply.provenance.baselineFingerprint, /^[a-f0-9]{64}$/);
      assert.equal(apply.provenance.mechanism, "paired-hill-climb");
      assert.equal(apply.provenance.parentCampaignId, "prior-campaign");
    }
    assert.ok(result.agentStarts <= 18);
    assert.ok(result.evaluatorRuns <= 80);
    if (scenario.gate) assert.ok(result.rejections.some((entry) => entry.stage === "gate"));
    if (scenario.scenario === "reviewReject") assert.ok(result.rejections.some((entry) => entry.stage === "review"));
    if (scenario.scenario === "timeout") {
      const timeoutLedger = fs.readFileSync(path.join(result.campaignRoot, "history", "ledger.jsonl"), "utf8")
        .trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.ok(timeoutLedger.some((record) => record.kind === "attempt" && record.facts?.timedOut === true && record.editCount > 0),
        "campaign records the timed-out edit attempt and its observed diff");
    }
    if (scenario.scenario === "duplicate") {
      const world = JSON.parse(fs.readFileSync(path.join(result.campaignRoot, "cycles", "c0001", "world.json"), "utf8"));
      const proposals = world.nodes.map((node) => path.join(result.campaignRoot, "cycles", "c0001", "attempts", node.id, "proposal.md"))
        .filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file, "utf8"));
      assert.ok(proposals.some((proposal) => proposal.includes("# Same candidate")), "the experiment world retains the proposal");
      assert.equal(applied.length, 1);
    }
    const seedSource = fs.readFileSync(path.join(project.seed, "solution.py"), "utf8");
    if (scenario.applied) assert.notEqual(seedSource, scenario.seed ?? 'print("seed")\n', "a verified win is promoted to the seed workspace");
    else assert.equal(seedSource, scenario.seed ?? 'print("seed")\n', "a rejected candidate leaves the seed workspace unchanged");
  });
});

test("a dependency change during candidate gates rejects the promotion", async () => {
  const { runCampaign } = await jump("engine/campaign.ts");
  const project = makeProject({ agent: "agent-scenario.mjs" });
  const previousLive = process.env.DREAM_RSI_TEST_LIVE;
  process.env.DREAM_RSI_TEST_LIVE = project.seed;
  try {
    const gate = project.script("gate-mutates.mjs");
    // The gate exits cleanly but changes a candidate-visible, unpatched path in the live
    // workspace, the same way a concurrent commit would.
    fs.writeFileSync(gate, `import { writeFileSync } from "node:fs";
import * as path from "node:path";
writeFileSync(path.join(process.env.DREAM_RSI_TEST_LIVE, "dependency.py"), \`print('drift \${Math.random()}')\\n\`);
process.exit(0);
`);
    const result = await runCampaign({
      baseRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task: { ...project.task, agent: { ...project.task.agent, env: { DREAM_SCENARIO: "truewin" } } },
      goal: "Improve the measured solution while preserving correctness",
      scope: ["solution.py"],
      verifierInputs: [project.script("score-ok.mjs"), gate],
      gates: [`node "${gate}"`],
      limits: { maxCycles: 1, maxAgentStarts: 18, maxEvaluatorRuns: 80, deadlineMs: 90_000, plateauCycles: 1, maxCandidatesPerCycle: 3 },
    });
    const appliedFile = path.join(result.campaignRoot, "history", "applied.jsonl");
    assert.equal(fs.existsSync(appliedFile), false, "no candidate is applied onto the drifted workspace");
    const ledger = fs.readFileSync(path.join(result.campaignRoot, "history", "ledger.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(ledger.some((record) => record.kind === "confirm" && record.outcome === "success"),
      "the candidate passed paired verification before the drift");
    assert.ok(result.rejections.some((entry) => entry.stage === "verification"
      && entry.reasons.some((reason) => /changed during candidate verification/.test(reason))),
      `expected a verification-stage drift rejection, saw ${JSON.stringify(result.rejections)}`);
    assert.equal(fs.readFileSync(path.join(project.seed, "solution.py"), "utf8"), 'print("seed")\n', "the seed workspace keeps its content");
  } finally {
    if (previousLive === undefined) delete process.env.DREAM_RSI_TEST_LIVE;
    else process.env.DREAM_RSI_TEST_LIVE = previousLive;
    project.cleanup();
  }
});

test("installing the verified postimage into a patched path during gates does not block the promotion", async () => {
  const { runCampaign } = await jump("engine/campaign.ts");
  const project = makeProject({ agent: "agent-scenario.mjs" });
  const previousLive = process.env.DREAM_RSI_TEST_LIVE;
  process.env.DREAM_RSI_TEST_LIVE = project.seed;
  try {
    const gate = project.script("gate-postimage.mjs");
    // The gate runs inside the patched scratch, so it can read the exact verified result and
    // install it into the live workspace: the idempotent-postimage case, not drift.
    fs.writeFileSync(gate, `import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
writeFileSync(path.join(process.env.DREAM_RSI_TEST_LIVE, "solution.py"), readFileSync(path.join(process.cwd(), "solution.py"), "utf8"));
process.exit(0);
`);
    const result = await runCampaign({
      baseRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task: { ...project.task, agent: { ...project.task.agent, env: { DREAM_SCENARIO: "truewin" } } },
      goal: "Improve the measured solution while preserving correctness",
      scope: ["solution.py"],
      verifierInputs: [project.script("score-ok.mjs"), gate],
      gates: [`node "${gate}"`],
      limits: { maxCycles: 1, maxAgentStarts: 18, maxEvaluatorRuns: 80, deadlineMs: 90_000, plateauCycles: 1, maxCandidatesPerCycle: 3 },
    });
    const appliedFile = path.join(result.campaignRoot, "history", "applied.jsonl");
    const applied = fs.existsSync(appliedFile) ? fs.readFileSync(appliedFile, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
    assert.ok(applied.length >= 1, `the verified promotion applies, saw ${JSON.stringify(result.rejections)}`);
    assert.ok(!result.rejections.some((entry) => entry.reasons.some((reason) => /changed during candidate verification/.test(reason))),
      "a patched path already holding the verified result is not verification drift");
    assert.notEqual(fs.readFileSync(path.join(project.seed, "solution.py"), "utf8"), 'print("seed")\n', "the verified win is promoted");
  } finally {
    if (previousLive === undefined) delete process.env.DREAM_RSI_TEST_LIVE;
    else process.env.DREAM_RSI_TEST_LIVE = previousLive;
    project.cleanup();
  }
});

test("unpatched workspace drift after pending-apply persistence prevents promotion", async () => {
  const project = makeProject({ agent: "agent-scenario.mjs" });
  try {
    const script = path.join(project.dir, "campaign-apply-boundary-child.mjs");
    const configFile = path.join(project.dir, "campaign-apply-boundary.json");
    const resultFile = path.join(project.dir, "campaign-apply-boundary-result.json");
    const campaignUrl = new URL("../extensions/pi-dream-rsi/engine/campaign.ts", import.meta.url).href;
    fs.writeFileSync(script, `import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const cjsFs = require_("node:fs");
const { syncBuiltinESMExports } = require_("node:module");
const path = require_("node:path");
const config = JSON.parse(cjsFs.readFileSync(process.argv[2], "utf8"));
let fired = false;
const realWrite = cjsFs.writeFileSync;
cjsFs.writeFileSync = (file, data, ...args) => {
  const result = realWrite(file, data, ...args);
  if (!fired && typeof file === "string" && typeof data === "string" && path.basename(file).startsWith("campaign.json.tmp-")) {
    try {
      if (JSON.parse(data).pendingApply) {
        fired = true;
        realWrite(path.join(config.seed, "dependency.py"), "print('BROKEN')\\n");
      }
    } catch { /* not campaign state */ }
  }
  return result;
};
syncBuiltinESMExports();
const { runCampaign } = await import(config.campaignUrl);
const result = await runCampaign(config.options);
realWrite(config.resultFile, JSON.stringify({ fired, state: result.state, rejections: result.rejections, campaignRoot: result.campaignRoot }));
`);
    const options = {
      baseRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task: { ...project.task, agent: { ...project.task.agent, env: { DREAM_SCENARIO: "truewin" } } },
      goal: "Improve the measured solution while preserving correctness",
      scope: ["solution.py"],
      verifierInputs: [project.script("score-ok.mjs")],
      limits: { maxCycles: 1, maxAgentStarts: 18, maxEvaluatorRuns: 80, deadlineMs: 90_000, plateauCycles: 1, maxCandidatesPerCycle: 3 },
    };
    fs.writeFileSync(configFile, JSON.stringify({ campaignUrl, seed: project.seed, resultFile, options }));
    const exit = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script, configFile], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => resolve({ code: -1, stderr: String(error) }));
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    assert.equal(exit.code, 0, `boundary child exited ${exit.code}: ${exit.stderr.slice(-1200)}`);
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(result.fired, true, `the unpatched dependency changed after pendingApply was persisted: ${JSON.stringify(result)}`);
    assert.equal(fs.existsSync(path.join(result.campaignRoot, "history", "applied.jsonl")), false,
      "the late workspace drift prevents a recorded apply");
    assert.ok(result.rejections.some((entry) => entry.stage === "apply"
      && /changed immediately before or during promotion/.test(entry.reasons.join(" "))), JSON.stringify(result.rejections));
    assert.equal(fs.readFileSync(path.join(project.seed, "solution.py"), "utf8"), 'print("seed")\n',
      "the candidate patch remains unapplied");
    assert.equal(fs.readFileSync(path.join(project.seed, "dependency.py"), "utf8"), "print('BROKEN')\n",
      "the external change is not overwritten");
  } finally { project.cleanup(); }
});

test("a verified update-and-delete promotion excludes only its own tombstone from the final digest", async () => {
  const { runCampaign } = await jump("engine/campaign.ts");
  const project = makeProject({ agent: "agent-delete-scenario.mjs" });
  try {
    fs.writeFileSync(path.join(project.seed, "legacy.py"), "obsolete = True\n");
    fs.writeFileSync(project.script("agent-delete-scenario.mjs"), `import { appendFileSync, rmSync, writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (/Perform an adversarial review/i.test(prompt)) {
    writeFileSync("review.json", JSON.stringify({ verdict: "accept", reasons: [] }));
    return;
  }
  if (prompt.includes("Do not change files.") || prompt.includes("prefix-only exploration policy")) return;
  appendFileSync("solution.py", "x\\n");
  rmSync("legacy.py", { force: true });
  writeFileSync("proposal.md", "# Replace the obsolete helper\\n");
});
`);
    const result = await runCampaign({
      baseRoot: project.dreamRoot,
      projectDir: project.projectDir,
      task: { ...project.task, agent: { ...project.task.agent, env: {} } },
      goal: "Improve the solution and remove the obsolete helper",
      scope: ["solution.py", "legacy.py"],
      verifierInputs: [project.script("score-ok.mjs")],
      limits: { maxCycles: 1, maxAgentStarts: 18, maxEvaluatorRuns: 80, deadlineMs: 90_000, plateauCycles: 1, maxCandidatesPerCycle: 3 },
    });
    const appliedFile = path.join(result.campaignRoot, "history", "applied.jsonl");
    assert.ok(fs.existsSync(appliedFile), `the verified deletion campaign must apply: ${JSON.stringify(result.rejections)}`);
    const applied = fs.readFileSync(appliedFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(applied[0].paths.includes("legacy.py"), "the promotion records the deleted path");
    assert.ok(applied[0].paths.includes("solution.py"), "the same promotion records the updated path");
    assert.equal(fs.existsSync(path.join(project.seed, "legacy.py")), false, "the obsolete file is deleted");
    assert.notEqual(fs.readFileSync(path.join(project.seed, "solution.py"), "utf8"), 'print("seed")\n', "the verified update is applied");
    const journal = JSON.parse(fs.readFileSync(path.join(result.campaignRoot, "promotion-journal", `${applied[0].campaign_transaction}.json`), "utf8"));
    assert.equal(journal.state, "applied", "the transaction commits after the digest excludes its exact tombstone");
    assert.equal(fs.readdirSync(project.seed).some((name) => name.includes(".dream-rsi-") && name.endsWith(".deleted")), false,
      "the journal-owned tombstone is removed after commit");
  } finally { project.cleanup(); }
});
