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
  const result = spawnSync(process.execPath, [script], { cwd: projectDir, encoding: "utf8", timeout: 120_000, windowsHide: true });
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

test("cold start: loop finds a causal bottleneck from source and a declared command, then proves the improvement independently", async () => {
  const fixture = coldStartProject();
  const baselineMs = measureScript(fixture.projectDir, "bench.mjs");
  const baselineGate = runFixtureCommand(fixture.projectDir, "test.mjs");
  assert.equal(baselineGate.status, 0, "the fixture's correctness oracle passes before the change");

  const contract = contractFor({ agentPath: fixture.agentPath });
  const messages = [];
  const result = await runLoop({
    projectDir: fixture.projectDir,
    contract,
    limits: { maxCampaigns: 2, maxAgentStarts: 24, maxEvaluatorRuns: 120, deadlineMs: 20 * 60 * 1000 },
    now: () => new Date("2026-10-20T00:00:00.000Z"),
    onProgress: (message) => messages.push(message),
  });

  assert.ok(result.campaigns >= 1, `the loop must run at least one campaign; stopped with "${result.stopReason}"`);
  assert.equal(result.wins, 1, `exactly one verified improvement; stop reason "${result.stopReason}"`);
  assert.ok(result.contract, "the result reports the frozen contract identity");

  const applied = fs.readFileSync(path.join(fixture.projectDir, "src", "pipeline.mjs"), "utf8");
  assert.ok(!applied.includes("for (let inner"), "the applied patch removed the quadratic re-scan");

  // Independent of the loop's own instrumentation.
  const gateAfter = runFixtureCommand(fixture.projectDir, "test.mjs");
  assert.equal(gateAfter.status, 0, "the correctness oracle still passes after the apply");
  const afterMs = measureScript(fixture.projectDir, "bench.mjs");
  assert.ok(afterMs < baselineMs * 0.5, `the declared benchmark must actually get faster (${baselineMs.toFixed(0)} ms -> ${afterMs.toFixed(0)} ms)`);

  assert.ok(fs.existsSync(path.join(fixture.projectDir, ".dream-rsi", "loop", "contract.json")), "the approved contract is durable");
  const postApply = result.verifications ?? [];
  assert.ok(postApply.length >= 1, "the loop records an independent post-apply verification");
  assert.equal(postApply[0].passed, true, "the independent verification agreed with the promotion");
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
