/**
 * Metric authoring and qualification.
 *
 * A repository with no supplied winning patch must still be able to trust its
 * instrument, and must refuse when it cannot. These cases exercise each
 * qualification check on a real workload: baseline reproducibility, sensitivity
 * to host-side extra work in the same measured operation, rejection of a
 * workload that does not exist, and an independent oracle that must reject an
 * inert version of the editable code.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { normalizeRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";
import { buildReconInventory, reconProject } from "../extensions/pi-dream-rsi/engine/recon.ts";
import { qualifyInstrument, resolveGainThreshold, synthesizeMetric } from "../extensions/pi-dream-rsi/engine/metrics.ts";

/** Deterministic busy work, so the measured span is the project's work. */
const WORK = `export function work(ms) {
  const until = performance.now() + ms;
  let spins = 0;
  while (performance.now() < until) spins += 1;
  return spins;
}
`;

const BENCH = `import { work } from "./src/work.mjs";
const spins = work(300);
if (spins <= 0) process.exit(1);
console.log(spins);
`;

// The duration is drawn once per process from two very different extremes, so
// repeated readings in one evaluator run agree while separate runs disagree
// sharply. That is exactly the instability the stability check exists to detect.
const BENCH_NOISY = `import { work } from "./src/work.mjs";
work(Math.random() < 0.5 ? 40 : 800);
console.log("done");
`;

// Imports the editable code, so a lever exists, but fails on the unchanged target.
const BENCH_BROKEN = `import { work } from "./src/work.mjs";
work(1);
console.error("benchmark is misconfigured");
process.exit(1);
`;

const TEST_OK = `import { work } from "./src/work.mjs";
if (work(1) <= 0) { console.error("work did not run"); process.exit(1); }
`;

const TEST_ALWAYS_PASSES = `console.log("nothing checked");
`;

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-qualify-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

function nodeProject({ bench = BENCH, testScript = TEST_OK } = {}) {
  return project({
    "package.json": `${JSON.stringify({
      name: "qualify", private: true, type: "module",
      scripts: { bench: "node bench.mjs", test: "node test.mjs" },
    }, null, 2)}\n`,
    "bench.mjs": bench,
    "test.mjs": testScript,
    "src/work.mjs": WORK,
  });
}

function contract(overrides = {}) {
  return normalizeRunContract({
    version: 1,
    outcome: { statement: "reduce benchmark duration", unit: "ms", higherIsBetter: false, minimumUsefulGain: "20%" },
    preserved: { gates: [] },
    scope: { roots: ["src"], protectedAssets: [] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["test", "benchmark"] },
    models: { providers: ["fixture"] },
    budgets: { maxCampaigns: 2, maxAgentStarts: 20, maxEvaluatorRuns: 80, deadlineMs: 120_000, falseAcceptBudget: 0.01 },
    ...overrides,
  });
}

/**
 * Synthesize a plan for the fixture's declared benchmark, then qualify it.
 *
 * A full-suite run puts many agent and evaluator processes on one machine, which
 * can make any wall-clock reading unstable for a moment. The instrument is
 * correct to refuse then. Retrying is a host-noise accommodation, not a lowered
 * standard: every attempt applies exactly the same checks and thresholds, and a
 * genuinely noisy instrument still fails after the last attempt.
 */
async function qualify(projectDir, runContract, overrides = {}) {
  const attempts = overrides.attempts ?? 3;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await qualifyOnce(projectDir, runContract, overrides);
    if (last.report.passed) return last;
    const stabilityOnly = last.report.checks.filter((check) => !check.passed).every((check) => check.name === "stability");
    if (!stabilityOnly || attempt === attempts - 1) return last;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return last;
}

async function qualifyOnce(projectDir, runContract, overrides = {}) {
  const recon = await reconProject({
    projectDir,
    contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 300, timedOut: false, error: null }),
  });
  const inventory = buildReconInventory({ contract: runContract, recon });
  assert.equal(inventory.levers.length, 1, `expected one lever, got ${JSON.stringify(inventory.rejected)}`);
  const lever = inventory.levers[0];
  const plan = await synthesizeMetric({
    projectDir,
    loopRoot: path.join(projectDir, ".dream-rsi", "loop"),
    lever,
    ...(lever.command ? { command: lever.command } : {}),
    qualification: {
      contract: runContract,
      workRoot: path.join(projectDir, ".dream-rsi", "loop", "qualification"),
      outcome: runContract.outcome.statement,
      minimumUsefulGain: runContract.outcome.minimumUsefulGain,
      ...overrides,
      // Retry bookkeeping is a test concern, not a qualification option.
      ...(overrides.attempts === undefined ? {} : { attempts: undefined }),
    },
  });
  return { plan, lever, report: plan.qualification };
}

test("a threshold of a fixed percentage resolves against the measured baseline", () => {
  assert.equal(resolveGainThreshold(25, 1000), 25);
  assert.equal(resolveGainThreshold("20%", 500), 100);
  assert.equal(resolveGainThreshold("2.5%", 1000), 25);
});

test("an instrument is qualified without any supplied winning patch", async () => {
  const projectDir = nodeProject();
  const runContract = contract();
  const { plan, report } = await qualify(projectDir, runContract);

  assert.equal(report.passed, true, `expected qualification to pass: ${JSON.stringify(report.rejections)}`);
  assert.equal(plan.ready, true);
  assert.ok(plan.evaluationContract, "a qualified instrument is frozen as an evaluation contract");
  assert.equal(plan.evaluationContract.id.length, 16, "the contract is content-addressed");
  assert.deepEqual(plan.evaluationContract.gates, ["npm run test"], "the declared test command is the oracle");
  assert.equal(plan.evaluationContract.argv.join(" "), "node bench.mjs", "the workload runs directly, without package-manager startup noise");
  assert.deepEqual([...plan.rejections], [], "the missing-control refusal is cleared by qualification");

  const named = report.checks.map((check) => check.name);
  for (const required of ["workload", "baseline", "stability", "direction", "sensitivity", "missing-workload", "oracle", "budget-fit"]) {
    assert.ok(named.includes(required), `qualification must report the ${required} check`);
  }
  const sensitivity = report.checks.find((check) => check.name === "sensitivity");
  assert.equal(sensitivity.passed, true, sensitivity.detail);
  assert.ok(plan.evaluationContract.baseline.length >= 2, "the contract records its baseline readings");
  assert.ok(plan.evaluationContract.sensitivity > 0, "the contract records the measured response to the degraded control");
});

test("an instrument that cannot resolve the useful gain is refused, not accommodated", async () => {
  const projectDir = nodeProject({ bench: BENCH_NOISY });
  // This fixture is noisy by construction, so a retry would only repeat the same refusal.
  const { plan, report } = await qualify(projectDir, contract(), { attempts: 1 });

  assert.equal(report.passed, false);
  assert.equal(plan.ready, false);
  const stability = report.checks.find((check) => check.name === "stability");
  assert.equal(stability.passed, false, "a noisy channel cannot resolve a 20% change");
  assert.match(stability.detail, /cannot be distinguished from noise/);
  assert.equal(plan.evaluationContract, undefined, "a refused instrument has no contract");
});

test("an oracle that accepts inert editable code cannot qualify the instrument", async () => {
  const projectDir = nodeProject({ testScript: TEST_ALWAYS_PASSES });
  const { plan, report } = await qualify(projectDir, contract());

  assert.equal(report.passed, false);
  const oracle = report.checks.find((check) => check.name === "oracle");
  assert.equal(oracle.passed, false);
  assert.match(oracle.detail, /an inert version of the editable code still passes/);
  assert.equal(plan.ready, false);
});

test("an instrument with no independent oracle is refused", async () => {
  const projectDir = project({
    "package.json": `${JSON.stringify({ name: "no-gate", private: true, type: "module", scripts: { bench: "node bench.mjs" } }, null, 2)}\n`,
    "bench.mjs": BENCH,
    "src/work.mjs": WORK,
  });
  const { report } = await qualify(projectDir, contract());
  assert.equal(report.passed, false);
  const oracle = report.checks.find((check) => check.name === "oracle");
  assert.equal(oracle.passed, false);
  assert.match(oracle.detail, /no declared correctness command exists/);
});

test("a workload that does not complete on the unchanged target is refused immediately", async () => {
  const projectDir = nodeProject({ bench: BENCH_BROKEN });
  const { plan, report } = await qualify(projectDir, contract());

  assert.equal(report.passed, false);
  const workload = report.checks.find((check) => check.name === "workload");
  assert.equal(workload.passed, false);
  assert.match(workload.detail, /did not produce a valid reading/);
  assert.equal(plan.ready, false);
  assert.ok(report.checks.length < 8, "qualification stops at the first failing prerequisite instead of running the rest");
});

test("a provided known-better control patch still takes the supplied-control path", async () => {
  const projectDir = nodeProject();
  const runContract = contract();
  const recon = await reconProject({
    projectDir, contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 120, timedOut: false, error: null }),
  });
  const lever = buildReconInventory({ contract: runContract, recon }).levers[0];
  const controlPatchPath = path.join(projectDir, "control.patch");
  fs.writeFileSync(controlPatchPath, "diff --git a/src/work.mjs b/src/work.mjs\n");

  const plan = await synthesizeMetric({
    projectDir,
    loopRoot: path.join(projectDir, ".dream-rsi", "loop"),
    lever,
    ...(lever.command ? { command: lever.command } : {}),
    controlPatchPath,
    qualification: {
      contract: runContract,
      workRoot: path.join(projectDir, ".dream-rsi", "loop", "qualification"),
      outcome: runContract.outcome.statement,
      minimumUsefulGain: runContract.outcome.minimumUsefulGain,
    },
  });

  assert.equal(plan.ready, true);
  assert.equal(plan.controlPatchPath, controlPatchPath);
  assert.equal(plan.qualification, undefined, "a supplied control is validated by the campaign preflight, not by this path");
});

test("an empty control patch is still refused even when qualification is available", async () => {
  const projectDir = nodeProject();
  const runContract = contract();
  const recon = await reconProject({
    projectDir, contract: runContract,
    probeImpl: async (command) => ({ label: command.label, ok: true, durationMs: 120, timedOut: false, error: null }),
  });
  const lever = buildReconInventory({ contract: runContract, recon }).levers[0];
  const controlPatchPath = path.join(projectDir, "control.patch");
  fs.writeFileSync(controlPatchPath, "   \n");

  const plan = await synthesizeMetric({
    projectDir,
    loopRoot: path.join(projectDir, ".dream-rsi", "loop"),
    lever,
    ...(lever.command ? { command: lever.command } : {}),
    controlPatchPath,
  });
  assert.equal(plan.ready, false);
  assert.match(plan.rejections.join("; "), /control patch file is empty/);
});

void qualifyInstrument;
