/**
 * Cold-start acceptance seam.
 *
 * Every other loop test supplies derived evidence: a session log for scope, an
 * evaluator, a control patch, or a solution manifest. This test supplies none of
 * them. It gives the loop a repository, an approved trusted-local run contract,
 * and a real subprocess agent, then requires the loop to find a causal
 * bottleneck from source and a declared command, author and qualify its own
 * instrument, run a campaign, apply the patch, and prove the improvement with an
 * independent measurement that the loop itself did not produce.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { runLoop } from "../extensions/pi-dream-rsi/engine/loop.ts";
import { normalizeRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";
import dreamRsi from "../extensions/pi-dream-rsi/index.ts";
import { mockPi } from "./fixtures.mjs";

const COMSHELL = process.env.ComSpec ?? "cmd.exe";
/**
 * The multi-bottleneck acceptance run is the heaviest test here (two full campaigns
 * over real subprocesses, ~2-3 minutes). Like the existing held-out acceptance set it
 * is opt-in, so the default suite does not starve the other timing-sensitive end-to-end
 * tests of CPU. Run it with `DREAM_RSI_HELDOUT=1 npm test`.
 */
const HELDOUT = process.env.DREAM_RSI_HELDOUT === "1";

/** Run one fixture command independently of the loop's own instrumentation. */
function runFixtureCommand(projectDir, script) {
  const result = spawnSync(process.execPath, Array.isArray(script) ? script : [script], { cwd: projectDir, encoding: "utf8", timeout: 120_000, windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ?? null };
}

function runNpm(projectDir, script) {
  const result = process.platform === "win32"
    ? spawnSync(COMSHELL, ["/d", "/s", "/c", `npm run ${script}`], { cwd: projectDir, encoding: "utf8", timeout: 180_000, windowsHide: true })
    : spawnSync("npm", ["run", script], { cwd: projectDir, encoding: "utf8", timeout: 180_000, windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ?? null };
}

/**
 * Best observed wall-clock milliseconds of a declared fixture script, measured
 * outside the loop. The fastest run is the one least disturbed by whatever else
 * the machine is doing, so it answers "is this code actually faster" without
 * turning background load into a failed assertion.
 */
function measureScript(projectDir, script, repeats = 5) {
  const samples = [];
  for (let index = 0; index < repeats; index += 1) {
    const started = process.hrtime.bigint();
    const run = runFixtureCommand(projectDir, script);
    assert.equal(run.status, 0, `${script} must succeed: ${run.stderr}`);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return Math.min(...samples);
}

/**
 * A planted, causal performance bottleneck: `buildReport` concatenates into one
 * growing string, so its cost is quadratic in `count`. The declared benchmark
 * command measures that cost. The correctness oracle checks the exact output, so
 * skipping the work is not a valid improvement.
 */
const BENCH = `import { buildReport } from "./src/pipeline.mjs";

const report = buildReport(24_000);
if (report.length === 0) {
  console.error("pipeline produced no output");
  process.exit(1);
}
console.log(report.length);
`;

/**
 * Genuine quadratic work. Concatenating into a growing string is not slow in V8
 * (rope strings make it linear), so the planted cost is re-scanning everything
 * built so far for each item. The fixed version keeps a running total, which
 * produces byte-identical output in linear time.
 */

const QUADRATIC = `export function buildReport(count) {
  const parts = [];
  for (let index = 0; index < count; index += 1) parts.push(\`item-\${index};\`);
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    for (let inner = 0; inner <= index; inner += 1) checksum += parts[inner].length;
  }
  return parts.join("") + "#" + checksum;
}
`;

const LINEAR = `export function buildReport(count) {
  const parts = [];
  let checksum = 0;
  let available = 0;
  for (let index = 0; index < count; index += 1) {
    const item = \`item-\${index};\`;
    parts.push(item);
    available += item.length;
    checksum += available;
  }
  return parts.join("") + "#" + checksum;
}
`;

const CORRECTNESS = `import { buildReport } from "./src/pipeline.mjs";

const items = Array.from({ length: 64 }, (_, index) => \`item-\${index};\`);
const checksum = items.reduce((total, item, index) => total + item.length * (64 - index), 0);
const expected = items.join("") + "#" + checksum;
const actual = buildReport(64);
if (actual !== expected) {
  console.error("pipeline output does not match the specified report");
  process.exit(1);
}
`;

/** The stub agent replaces the quadratic loop with the linear one and accepts the review. */
function agentSource() {
  return `import { readFileSync, writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (/adversarial review/i.test(prompt)) {
    writeFileSync("review.json", JSON.stringify({ verdict: "accept", reasons: [] }));
    return;
  }
  const before = readFileSync("src/pipeline.mjs", "utf8");
  if (before.includes("for (let inner")) {
    writeFileSync("src/pipeline.mjs", ${JSON.stringify(LINEAR)});
  }
  writeFileSync("proposal.md", "# Replace the quadratic re-scan with a running total\\n");
});
`;
}

/**
 * A repository with no Dream-RSI state, no session logs, no evaluator, no
 * control patch, and no solution manifest.
 */
function coldStartProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-cold-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), `${JSON.stringify({
    name: "cold-start-fixture",
    private: true,
    type: "module",
    scripts: { test: "node test.mjs", bench: "node bench.mjs" },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(projectDir, "bench.mjs"), BENCH);
  fs.writeFileSync(path.join(projectDir, "test.mjs"), CORRECTNESS);
  fs.writeFileSync(path.join(projectDir, "src", "pipeline.mjs"), QUADRATIC);
  const agentPath = path.join(projectDir, "cold-agent.mjs");
  fs.writeFileSync(agentPath, agentSource());
  return { dir, projectDir, agentPath };
}

function contractFor({ agentPath, maxCampaigns = 2, minimumUsefulGain = "50%", maxAgentStarts = 24, maxEvaluatorRuns = 120, deadlineMs = 20 * 60 * 1000 }) {
  return normalizeRunContract({
    version: 1,
    projectDir: null,
    outcome: {
      statement: "reduce the wall-clock duration of the declared benchmark command",
      unit: "ms",
      higherIsBetter: false,
      minimumUsefulGain,
    },
    preserved: { gates: [] },
    scope: { roots: ["src"], protectedAssets: [] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    models: { providers: ["fixture"] },
    budgets: {
      maxCampaigns,
      maxAgentStarts,
      maxEvaluatorRuns,
      deadlineMs,
      falseAcceptBudget: 0.01,
    },
    agent: { command: process.execPath, args: [agentPath], prompt_via: "stdin", model: null, thinking: null },
  });
}

test("cold start: dream_rsi_loop with consent and focus applies and independently verifies an improvement", async () => {
  const fixture = coldStartProject();
  // Use enough deterministic quadratic work for the default 5% threshold to
  // sit above process-startup jitter while keeping the change substantial.
  fs.writeFileSync(path.join(fixture.projectDir, "bench.mjs"), BENCH.replace("24_000", "60_000"));
  const baselineMs = measureScript(fixture.projectDir, "bench.mjs");
  const baselineGate = runFixtureCommand(fixture.projectDir, "test.mjs");
  assert.equal(baselineGate.status, 0, "the fixture's correctness oracle passes before the change");

  const { pi, context, harness } = mockPi();
  dreamRsi(pi);
  context.cwd = fixture.projectDir;
  await harness.handlers.get("session_start")({}, context);
  const result = await harness.tools.get("dream_rsi_loop").execute("cold-start", {
    action: "start", consent: true,
    focus: "reduce the wall-clock duration of the declared benchmark without changing its output",
    minimum_gain: "25%",
    agent_command: process.execPath, agent_args: [fixture.agentPath],
  }, undefined, undefined, context);
  assert.match(result.content[0].text, /Dream-RSI loop finished/);
  const loopResult = result.details.loop;

  assert.ok(loopResult.campaigns >= 1, `the loop must run at least one campaign; stopped with "${loopResult.stopReason}": ${JSON.stringify({ inventory: loopResult.inventory, memory: loopResult.memory.notes })}`);
  assert.equal(loopResult.wins, 1, `exactly one verified improvement; stop reason "${loopResult.stopReason}"`);
  assert.ok(loopResult.contract, "the result reports the frozen contract identity");

  const applied = fs.readFileSync(path.join(fixture.projectDir, "src", "pipeline.mjs"), "utf8");
  assert.ok(!applied.includes("for (let inner"), "the applied patch removed the quadratic re-scan");

  // Independent of the loop's own instrumentation.
  const gateAfter = runFixtureCommand(fixture.projectDir, "test.mjs");
  assert.equal(gateAfter.status, 0, "the correctness oracle still passes after the apply");
  const afterMs = measureScript(fixture.projectDir, "bench.mjs");
  assert.ok(afterMs < baselineMs * 0.9, `the declared benchmark must actually improve beyond the default useful gain (${baselineMs.toFixed(0)} ms -> ${afterMs.toFixed(0)} ms)`);

  assert.ok(fs.existsSync(path.join(fixture.projectDir, ".dream-rsi", "loop", "contract.json")), "the approved contract is durable");
  const postApply = loopResult.verifications ?? [];
  assert.ok(postApply.length >= 1, "the loop records an independent post-apply verification");
  assert.equal(postApply[0].passed, true, "the independent verification agreed with the promotion");
  const campaignRecords = fs.readdirSync(path.join(fixture.projectDir, ".dream-rsi", "campaigns"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => {
      const root = path.join(fixture.projectDir, ".dream-rsi", "campaigns", entry.name);
      return JSON.parse(fs.readFileSync(path.join(root, "campaign.json"), "utf8"));
    }).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  assert.ok(campaignRecords.length >= 2, `the fixture runs a follow-up campaign after its verified improvement: ${JSON.stringify({ stopReason: loopResult.stopReason, campaigns: loopResult.campaigns, records: loopResult.records, notes: loopResult.memory.notes })}`);
  const secondCampaign = campaignRecords[1];
  assert.ok(secondCampaign.checkRuns?.some((run) => run.stdoutTail === "seeded from loop qualification"),
    "the second campaign reuses the qualification readings paid for under its baseline fingerprint");
});

test("cold start: a normally failing declared test becomes a qualified and verified failure-count lever", async () => {
  const fixture = coldStartProject();
  fs.writeFileSync(path.join(fixture.projectDir, "package.json"), `${JSON.stringify({
    name: "failing-test-fixture", private: true, type: "module",
    scripts: { "test:broken": "node broken.mjs", "test:smoke": "node smoke.mjs" },
  }, null, 2)}\n`);
fs.writeFileSync(path.join(fixture.projectDir, "broken.mjs"), `import * as pipeline from "./src/pipeline.mjs";\nimport { spawnSync } from "node:child_process";\nconst result = spawnSync(process.execPath, ["--test", "broken.test.mjs"], { encoding: "utf8" });\nprocess.stdout.write(result.stdout ?? "");\nprocess.stderr.write(result.stderr ?? "");\nprocess.exit(result.status ?? 1);\n`);
fs.writeFileSync(path.join(fixture.projectDir, "broken.test.mjs"), `import test from "node:test";\nimport assert from "node:assert/strict";\nimport * as pipeline from "./src/pipeline.mjs";\ntest("the broken report value is repaired", () => assert.equal(pipeline.buildReport(1), 1));\ntest("the editable function remains exported", () => assert.equal(typeof pipeline.buildReport, "function"));\n`);
  fs.writeFileSync(path.join(fixture.projectDir, "smoke.mjs"), 'import { buildReport } from "./src/pipeline.mjs";\nif (buildReport(0) !== 0) process.exit(1);\n');
  fs.writeFileSync(path.join(fixture.projectDir, "src", "pipeline.mjs"), "export const buildReport = (count) => count === 0 ? 0 : 0;\n");

  try {
    const contract = contractFor({ agentPath: fixture.agentPath, maxCampaigns: 1, minimumUsefulGain: "5%", maxEvaluatorRuns: 120 });
    const runCampaignImpl = async (options) => {
      fs.writeFileSync(path.join(fixture.projectDir, "src", "pipeline.mjs"), "export const buildReport = (count) => count === 0 ? 0 : 1;\n");
      const id = "suite-failure-win";
      const campaignRoot = path.join(options.baseRoot, "campaigns", id);
      fs.mkdirSync(path.join(campaignRoot, "history"), { recursive: true });
      fs.writeFileSync(path.join(campaignRoot, "history", "ledger.jsonl"), `${JSON.stringify({ v: 1, t: new Date().toISOString(), entryId: "apply-1", kind: "apply", campaignId: id, stage: "apply", outcome: "success" })}\n`);
      return {
        id, baseRoot: options.baseRoot, campaignRoot, engineRoot: campaignRoot,
        state: { kind: "complete", reason: "verified failure count reduction" }, stopped: true,
        stopReason: "verified failure count reduction", agentStarts: 1, evaluatorRuns: 1,
        currentScore: 0, bestScore: 0, baselineScore: 1, startedAt: new Date().toISOString(),
      };
    };
    const result = await runLoop({
      projectDir: fixture.projectDir, contract,
      limits: { maxCampaigns: 1, maxAgentStarts: 24, maxEvaluatorRuns: 120, deadlineMs: 20 * 60 * 1000 },
      runCampaignImpl,
    });

    assert.ok(result.inventory?.levers.some((lever) => lever.metricKind === "suite-failures"), "recon surfaced a failing suite as a failure-count lever");
    assert.equal(result.campaigns, 1);
    assert.equal(result.wins, 1, JSON.stringify({ stopReason: result.stopReason, records: result.records, verifications: result.verifications, notes: result.memory.notes }));
    assert.equal(result.verifications[0]?.passed, true, result.verifications[0]?.reason ?? "post-apply verification failed");
    assert.equal(runFixtureCommand(fixture.projectDir, "broken.mjs").status, 0, "the applied source makes the declared failing test pass");
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("cold start: a repository without trusted-local consent is refused before any command runs", async () => {
  const fixture = coldStartProject();
  const marker = path.join(fixture.dir, "probe-ran");
  fs.writeFileSync(path.join(fixture.projectDir, "package.json"), `${JSON.stringify({
    name: "cold-start-fixture",
    private: true,
    type: "module",
    scripts: { test: "node -e \"require('node:fs').writeFileSync(process.env.PROBE_MARKER,'x')\"", bench: "node bench.mjs" },
  }, null, 2)}\n`);

  const contract = contractFor({ agentPath: fixture.agentPath, maxCampaigns: 1 });
  const refused = { ...contract, execution: { ...contract.execution, consent: false } };
  const result = await runLoop({
    projectDir: fixture.projectDir,
    contract: refused,
    limits: { maxCampaigns: 1, maxAgentStarts: 4, maxEvaluatorRuns: 8, deadlineMs: 60_000 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });

  assert.equal(result.stopReason, "not-approved");
  assert.equal(result.campaigns, 0);
  assert.equal(fs.existsSync(marker), false, "no probe command ran without consent");
});

test("cold start: a repository with no declared measurable command stops with the reason instead of guessing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-cold-empty-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), `${JSON.stringify({ name: "no-runnable-outcome", private: true }, null, 2)}\n`);
  fs.writeFileSync(path.join(projectDir, "src", "index.js"), "export const value = 1;\n");

  const contract = contractFor({ agentPath: path.join(dir, "unused-agent.mjs"), maxCampaigns: 1 });
  const result = await runLoop({
    projectDir,
    contract,
    limits: { maxCampaigns: 1, maxAgentStarts: 4, maxEvaluatorRuns: 8, deadlineMs: 60_000 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });

  assert.equal(result.stopReason, "no verifiable lever");
  assert.equal(result.campaigns, 0);
  assert.ok(result.inventory && result.inventory.rejected.length > 0, "the refusal names why nothing was measurable");
  void runNpm;
});

// ---------------------------------------------------------------------------
// W10: a contract-declared score evaluator proves an accuracy win
// ---------------------------------------------------------------------------

/**
 * A declared score instrument the loop did not author: the agreed outcome is the
 * classifier's accuracy on a fixed evaluation set, and `eval/score.mjs` writes
 * that number to eval/score.json. The declared evaluator and its fixtures are
 * pinned verifier inputs, so a candidate cannot redefine "improved".
 */
const SCORE_EVALUATOR = `import { classify } from "../src/classify.mjs";
import * as fs from "node:fs";

const cases = [
  ...Array.from({ length: 25 }, (_, index) => ({ input: "cat-" + index, label: "cat" })),
  ...Array.from({ length: 25 }, (_, index) => ({ input: "dog-" + index, label: "dog" })),
];
const correct = cases.filter((item) => classify(item.input) === item.label).length;
const score = correct / cases.length;
fs.mkdirSync("eval", { recursive: true });
fs.writeFileSync("eval/score.json", JSON.stringify({ score, raw_score: score, valid: true, fail_class: "ok", error: null }));
`;

/** Always guessing one label: exactly 50% accuracy on the balanced set. */
const GUESSING_CLASSIFIER = `export function classify(input) {
  return "dog";
}
`;

/** The intended rule: label each input by the animal it names. */
const ACCURATE_CLASSIFIER = `export function classify(input) {
  return String(input).includes("cat") ? "cat" : "dog";
}
`;

const SCORE_BENCH = `import { classify } from "./src/classify.mjs";
const label = classify("cat-0");
if (typeof label !== "string" || label.length === 0) process.exit(1);
console.log(label);
`;

/** The oracle holds before and after the change, and breaks when the module is inert. */
const SCORE_CORRECTNESS = `import { classify } from "./src/classify.mjs";
const label = classify("cat-0");
if (label !== "cat" && label !== "dog") {
  console.error("classifier returned an unknown label");
  process.exit(1);
}
`;

/** The stub agent replaces the guessing classifier and accepts the review. */
function scoreAgentSource() {
  return `import { existsSync, readFileSync, writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  // The review workspace is the one carrying REVIEW.md; the live agent works on
  // the candidate copy.
  if (/adversarial review/i.test(prompt) || existsSync("REVIEW.md")) {
    writeFileSync("review.json", JSON.stringify({ verdict: "accept", reasons: [] }));
    return;
  }
  const before = readFileSync("src/classify.mjs", "utf8");
  if (!before.includes("includes(")) {
    writeFileSync("src/classify.mjs", ${JSON.stringify(ACCURATE_CLASSIFIER)});
  }
  writeFileSync("proposal.md", "# Label each input by the animal it names instead of always guessing\\n");
});
`;
}

function scoreProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-cold-score-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "eval"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), `${JSON.stringify({
    name: "cold-start-score-fixture",
    private: true,
    type: "module",
    scripts: { test: "node test.mjs", bench: "node bench.mjs" },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(projectDir, "bench.mjs"), SCORE_BENCH);
  fs.writeFileSync(path.join(projectDir, "test.mjs"), SCORE_CORRECTNESS);
  fs.writeFileSync(path.join(projectDir, "src", "classify.mjs"), GUESSING_CLASSIFIER);
  fs.writeFileSync(path.join(projectDir, "eval", "score.mjs"), SCORE_EVALUATOR);
  const agentPath = path.join(projectDir, "score-agent.mjs");
  fs.writeFileSync(agentPath, scoreAgentSource());
  return { dir, projectDir, agentPath };
}

function scoreContractFor({ agentPath, maxCampaigns = 2, minimumUsefulGain = "20%", maxAgentStarts = 24, maxEvaluatorRuns = 120, deadlineMs = 20 * 60 * 1000 }) {
  return normalizeRunContract({
    version: 1,
    projectDir: null,
    outcome: {
      statement: "raise the classifier accuracy on the declared evaluation set",
      unit: "accuracy",
      higherIsBetter: true,
      minimumUsefulGain,
      evaluator: { argv: ["node", "eval/score.mjs"], output: "score-json", inputs: ["eval/score.mjs"] },
    },
    preserved: { gates: [] },
    scope: { roots: ["src"], protectedAssets: [] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    models: { providers: ["fixture"] },
    budgets: { maxCampaigns, maxAgentStarts, maxEvaluatorRuns, deadlineMs, falseAcceptBudget: 0.01 },
    agent: { command: process.execPath, args: [agentPath], prompt_via: "stdin", model: null, thinking: null },
  });
}

/** Run the declared evaluator outside the loop and read its number. */
function measureScore(projectDir) {
  fs.rmSync(path.join(projectDir, "eval", "score.json"), { force: true });
  const run = runFixtureCommand(projectDir, "eval/score.mjs");
  assert.equal(run.status, 0, `the score evaluator must run: ${run.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(projectDir, "eval", "score.json"), "utf8")).score;
}

test("cold start: a contract-declared score evaluator proves an accuracy win independently", async () => {
  const fixture = scoreProject();
  const baselineAccuracy = measureScore(fixture.projectDir);
  assert.ok(Math.abs(baselineAccuracy - 0.5) < 1e-9, `the guessing classifier scores 0.5, got ${baselineAccuracy}`);
  assert.equal(runFixtureCommand(fixture.projectDir, "test.mjs").status, 0, "the fixture's correctness oracle passes before the change");
  // The evaluator's own output is not part of the approved tree: the loop re-measures it.
  fs.rmSync(path.join(fixture.projectDir, "eval", "score.json"), { force: true });

  const contract = scoreContractFor({ agentPath: fixture.agentPath });
  const messages = [];
  const result = await runLoop({
    projectDir: fixture.projectDir,
    contract,
    limits: { maxCampaigns: 2, maxAgentStarts: 24, maxEvaluatorRuns: 120, deadlineMs: 20 * 60 * 1000 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
    onProgress: (message) => messages.push(message),
  });

  assert.ok(result.campaigns >= 1, `the loop must run a campaign for the declared score evaluator; stopped with "${result.stopReason}"`);
  assert.equal(result.wins, 1, `exactly one verified improvement; stop reason "${result.stopReason}"; ${messages.join(" | ")}`);
  assert.ok(result.inventory?.levers.some((lever) => lever.metricKind === "score"), "recon turned the declared evaluator into a score lever");

  const applied = fs.readFileSync(path.join(fixture.projectDir, "src", "classify.mjs"), "utf8");
  assert.ok(applied.includes('includes("cat")'), "the applied patch replaced the guessing classifier");

  // Independent of the loop's own instrumentation: the declared evaluator says the
  // accuracy really improved, and the correctness oracle still holds.
  const afterAccuracy = measureScore(fixture.projectDir);
  assert.ok(afterAccuracy >= 0.99, `the declared evaluator must report the accuracy win, got ${afterAccuracy}`);
  assert.ok(afterAccuracy > baselineAccuracy, "the score moved in the declared direction");
  assert.equal(runFixtureCommand(fixture.projectDir, "test.mjs").status, 0, "the correctness oracle still passes after the apply");

  assert.ok(result.verifications && result.verifications.length >= 1, "the loop records an independent post-apply verification");
  assert.equal(result.verifications[0].passed, true, `post-apply verification: ${JSON.stringify(result.verifications[0])}`);

  const win = result.records.find((record) => record.outcome === "win");
  assert.ok(win?.provenance?.evaluatorId, "the win records the qualified score instrument identity");
  assert.equal(typeof win.verifiedGain, "number");
  assert.ok(win.verifiedGain > 0);

  // The declared evaluator is pinned by a protected copy: the campaign hashes and
  // protects it, so a candidate cannot edit the instrument that scored it.
  const verifierRoot = path.join(fixture.projectDir, ".dream-rsi", "loop", "verifiers");
  const pinned = fs.existsSync(verifierRoot)
    ? fs.readdirSync(verifierRoot).flatMap((leverId) => {
      const evaluatorCopy = path.join(verifierRoot, leverId, "eval", "score.mjs");
      return fs.existsSync(evaluatorCopy) ? [evaluatorCopy] : [];
    })
    : [];
  assert.ok(pinned.length > 0, "the declared score evaluator is pinned as a verifier input");
  assert.equal(fs.readFileSync(pinned[0], "utf8"), SCORE_EVALUATOR, "the pinned copy is the approved evaluator");
});

// ---------------------------------------------------------------------------
// Continued autonomy: a second bottleneck appears once the first is fixed
// ---------------------------------------------------------------------------

/** Quadratic work, with a linear equivalent that produces byte-identical output. */
const SLOW_MODULE = (name) => `export function ${name}(count) {
  const parts = [];
  for (let index = 0; index < count; index += 1) parts.push(\`${name}-\${index};\`);
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    for (let inner = 0; inner <= index; inner += 1) checksum += parts[inner].length;
  }
  return parts.join("") + "#" + checksum;
}
`;

const FAST_MODULE = (name) => `export function ${name}(count) {
  const parts = [];
  let checksum = 0;
  let available = 0;
  for (let index = 0; index < count; index += 1) {
    const item = \`${name}-\${index};\`;
    parts.push(item);
    available += item.length;
    checksum += available;
  }
  return parts.join("") + "#" + checksum;
}
`;

/**
 * Two independently declared workloads over disjoint code. Each is a real
 * benchmark with its own import graph, so the two levers cannot borrow each
 * other's files: after the first fix lands, the second workload is what is left
 * to optimize.
 */
const TWO_WORKLOADS = {
  "package.json": `${JSON.stringify({
    name: "cold-start-two", private: true, type: "module",
    scripts: { test: "node test.mjs", "bench:alpha": "node bench-alpha.mjs", "bench:beta": "node bench-beta.mjs" },
  }, null, 2)}\n`,
  "bench-alpha.mjs": `import { alpha } from "./src/alpha.mjs";
if (alpha(24_000).length === 0) process.exit(1);
console.log("alpha ok");
`,
  "bench-beta.mjs": `import { beta } from "./src/beta.mjs";
if (beta(24_000).length === 0) process.exit(1);
console.log("beta ok");
`,
  "test.mjs": `import { alpha } from "./src/alpha.mjs";
import { beta } from "./src/beta.mjs";

const expected = (name, count) => {
  const items = Array.from({ length: count }, (_, index) => \`\${name}-\${index};\`);
  const checksum = items.reduce((total, item, index) => total + item.length * (count - index), 0);
  return items.join("") + "#" + checksum;
};
if (alpha(32) !== expected("alpha", 32)) { console.error("alpha output mismatch"); process.exit(1); }
if (beta(32) !== expected("beta", 32)) { console.error("beta output mismatch"); process.exit(1); }
`,
};

/** Fixes whichever module in its own scope is still quadratic — exactly one per attempt. */
function twoWorkloadAgentSource() {
  return `import { readFileSync, writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (/adversarial review/i.test(prompt)) {
    writeFileSync("review.json", JSON.stringify({ verdict: "accept", reasons: [] }));
    return;
  }
  for (const name of ["alpha", "beta"]) {
    let source = "";
    try { source = readFileSync(\`src/\${name}.mjs\`, "utf8"); } catch { continue; }
    if (!source.includes("for (let inner")) continue;
    writeFileSync(\`src/\${name}.mjs\`, ${JSON.stringify(FAST_MODULE("__NAME__"))}.replaceAll("__NAME__", name));
    writeFileSync("proposal.md", \`# Replace \${name}'s quadratic re-scan with a running total\\n\`);
    return;
  }
  writeFileSync("proposal.md", "# No remaining quadratic scan\\n");
});
`;
}

test("cold start: the loop fixes a second bottleneck after the first, using a fresh baseline each time", {
  skip: HELDOUT ? false : "set DREAM_RSI_HELDOUT=1 to run the multi-bottleneck acceptance",
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-cold-two-"));
  const projectDir = path.join(dir, "proj");
  for (const [relative, content] of Object.entries(TWO_WORKLOADS)) {
    const target = path.join(projectDir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "src", "alpha.mjs"), SLOW_MODULE("alpha"));
  fs.writeFileSync(path.join(projectDir, "src", "beta.mjs"), SLOW_MODULE("beta"));

  const baseline = {
    alpha: measureScript(projectDir, "bench-alpha.mjs"),
    beta: measureScript(projectDir, "bench-beta.mjs"),
  };

  const agentPath = path.join(projectDir, "two-stage-agent.mjs");
  fs.writeFileSync(agentPath, twoWorkloadAgentSource());
  // Each workload is a real, measurable benchmark here, so a 40% target is well
  // above this machine's jitter and still far below what the fix achieves.
  // The contract's budgets are the authority; they must cover the work this test asks
  // for, because the loop no longer grants more than the contract approved.
  const contract = contractFor({
    agentPath, maxCampaigns: 3, minimumUsefulGain: "40%",
    maxAgentStarts: 60, maxEvaluatorRuns: 400, deadlineMs: 30 * 60 * 1000,
  });
  const result = await runLoop({
    projectDir,
    contract,
    limits: { maxCampaigns: 3, maxAgentStarts: 60, maxEvaluatorRuns: 320, deadlineMs: 30 * 60 * 1000 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });

  assert.ok(result.wins >= 2, `expected two successive verified improvements, got ${result.wins} (stop reason "${result.stopReason}")`);
  assert.ok(result.verifications.length >= 2, "each win is checked independently after it is applied");
  assert.ok(result.verifications.every((check) => check.passed), `post-apply checks: ${JSON.stringify(result.verifications)}`);

  const alphaAfter = fs.readFileSync(path.join(projectDir, "src", "alpha.mjs"), "utf8");
  const betaAfter = fs.readFileSync(path.join(projectDir, "src", "beta.mjs"), "utf8");
  assert.ok(!alphaAfter.includes("for (let inner"), "the alpha bottleneck was fixed");
  assert.ok(!betaAfter.includes("for (let inner"), "the beta bottleneck was fixed after the first improvement landed");

  // Independent of the loop's instrumentation.
  assert.equal(runFixtureCommand(projectDir, "test.mjs").status, 0, "both modules still produce correct output");
  const after = {
    alpha: measureScript(projectDir, "bench-alpha.mjs"),
    beta: measureScript(projectDir, "bench-beta.mjs"),
  };
  assert.ok(after.alpha < baseline.alpha * 0.5, `alpha must actually get faster (${baseline.alpha.toFixed(0)} -> ${after.alpha.toFixed(0)} ms)`);
  assert.ok(after.beta < baseline.beta * 0.5, `beta must actually get faster (${baseline.beta.toFixed(0)} -> ${after.beta.toFixed(0)} ms)`);

  // Every experiment records which baseline, objective and instrument it belongs to.
  const wins = result.records.filter((record) => record.outcome === "win");
  assert.ok(wins.length >= 2, `expected at least two winning experiments, got ${wins.length}`);
  for (const record of wins) {
    assert.ok(record.provenance, "a win carries provenance");
    assert.ok(record.provenance.contractId, "the contract identity is recorded");
    assert.ok(record.provenance.evaluatorId, "the instrument identity is recorded");
    assert.ok(record.provenance.baselineFingerprint, "the baseline fingerprint is recorded");
    assert.equal(typeof record.verifiedGain, "number", "the independently measured gain is recorded");
    assert.ok(record.verifiedGain > 0);
  }
  const distinctLever = new Set(wins.map((record) => record.leverId));
  assert.equal(distinctLever.size, 2, "the two improvements came from two different levers, not one repeated win");
  assert.notEqual(wins[0].provenance.baselineFingerprint, wins[1].provenance.baselineFingerprint,
    "the second campaign started from a different baseline than the first");
});
