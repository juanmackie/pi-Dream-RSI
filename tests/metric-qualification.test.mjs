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
import { getAgentContainmentSupport } from "../extensions/pi-dream-rsi/engine/containment.ts";
import { qualifyInstrument, resolveGainThreshold, synthesizeMetric } from "../extensions/pi-dream-rsi/engine/metrics.ts";

/** Deterministic busy work, so the measured span is the project's work. */
const WORK = `export function work(ms) {
  if (ms <= 0) return 0;
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

/**
 * Each launch flips a marker outside the copied workspace, so consecutive readings
 * alternate between two very different durations. The instability is deterministic
 * rather than random, so a slow CI runner cannot accidentally produce a stable
 * series. The marker lives in the temp directory because every qualification run
 * starts from a fresh copy of the project.
 */
const BENCH_NOISY = (marker) => `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { work } from "./src/work.mjs";
// One evaluator run launches the workload four times (one warmup plus three
// samples), so grouping by launch count gives each run a single duration and makes
// consecutive runs disagree sharply -- exactly the instability the stability check
// must catch, without relying on chance.
const count = existsSync(${JSON.stringify(marker)}) ? Number(readFileSync(${JSON.stringify(marker)}, "utf8")) : 0;
writeFileSync(${JSON.stringify(marker)}, String(count + 1));
const group = Math.floor(count / 4) % 2;
work(group === 0 ? 40 : 800);
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
if (work(0) !== 0) { console.error("zero work changed"); process.exit(1); }
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
  const evaluator = runContract.outcome.evaluator;
  const plan = await synthesizeMetric({
    projectDir,
    loopRoot: path.join(projectDir, ".dream-rsi", "loop"),
    lever,
    ...(lever.command ? { command: lever.command } : {}),
    ...(lever.metricKind === "score" && evaluator ? {
      scoreEvaluator: {
        argv: [...evaluator.argv],
        output: evaluator.output,
        ...(evaluator.inputs ? { inputs: [...evaluator.inputs] } : {}),
        unit: runContract.outcome.unit,
        higherIsBetter: runContract.outcome.higherIsBetter,
      },
    } : {}),
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
  for (const required of ["workload", "baseline", "stability", "direction", "sensitivity", "missing-workload", "oracle", "mutation", "budget-fit"]) {
    assert.ok(named.includes(required), `qualification must report the ${required} check`);
  }
  const sensitivity = report.checks.find((check) => check.name === "sensitivity");
  assert.equal(sensitivity.passed, true, sensitivity.detail);
  const mutation = report.checks.find((check) => check.name === "mutation");
  assert.equal(mutation.passed, true, mutation.detail);
  assert.match(mutation.detail, /killed 2\/2 deterministic/);
  assert.ok(plan.evaluationContract.baseline.length >= 2, "the contract records its baseline readings");
  assert.ok(plan.evaluationContract.sensitivity > 0, "the contract records the measured response to the degraded control");
});

test("measurement refuses an insufficient evaluator allowance before spending", async () => {
  const projectDir = nodeProject();
  let started = 0;
  const { plan, report } = await qualify(projectDir, contract(), {
    availableEvaluatorRuns: 10,
    beforeEvaluatorRun: () => { started += 1; },
  });

  assert.equal(report.passed, false);
  assert.equal(plan.ready, false);
  assert.equal(started, 0, "budget admission happens before any evaluator process starts");
  assert.equal(report.checks.length, 1, "an infeasible measurement returns a direct admission diagnosis");
  assert.equal(report.checks[0].name, "budget-fit");
  assert.match(report.checks[0].detail, /before spending evaluator runs/);
  assert.match(report.checks[0].detail, /only 10 evaluator run\(s\) remain/);
});

const agentContainmentSupport = await getAgentContainmentSupport();

test("metric qualification runs its evaluator and correctness gates in contained copies", {
  skip: agentContainmentSupport.available ? false : agentContainmentSupport.reason,
}, async () => {
  const projectDir = nodeProject();
  const readonlyRoots = [path.dirname(process.execPath), process.env.SystemRoot].filter(Boolean);
  const { plan, report } = await qualify(projectDir, contract(), { containment: { readonlyRoots } });

  assert.equal(report.passed, true, `contained qualification should pass: ${JSON.stringify(report.rejections)}`);
  assert.equal(plan.ready, true);
});

test("an instrument that cannot resolve the useful gain is refused, not accommodated", async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-noise-marker-")), "toggle");
  const projectDir = nodeProject({ bench: BENCH_NOISY(marker) });
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

// ---------------------------------------------------------------------------
// W10: a contract-declared score evaluator is the instrument
// ---------------------------------------------------------------------------

const SCORE_MODEL = "export const accuracy = () => 0.62;\n";
const SCORE_TEST_OK = `import { accuracy } from "./src/model.mjs";
if (!(accuracy() >= 0.6)) { console.error("accuracy regressed"); process.exit(1); }
`;
const SCORE_TEST_ALWAYS_PASSES = `console.log("nothing checked");
`;
const SCORE_EVAL_JSON = `import { accuracy } from "../src/model.mjs";
import * as fs from "node:fs";
fs.mkdirSync("eval", { recursive: true });
fs.writeFileSync("eval/score.json", JSON.stringify({ score: accuracy(), raw_score: accuracy(), valid: true, fail_class: "ok", error: null }));
`;

/**
 * Each launch alternates between two very different scores, so the repeated
 * baseline readings disagree deterministically. A score instrument that cannot
 * reproduce its own reading cannot resolve a useful gain.
 */
const SCORE_EVAL_NOISY = (marker) => `import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const count = existsSync(${JSON.stringify(marker)}) ? Number(readFileSync(${JSON.stringify(marker)}, "utf8")) : 0;
writeFileSync(${JSON.stringify(marker)}, String(count + 1));
mkdirSync("eval", { recursive: true });
writeFileSync("eval/score.json", JSON.stringify({ score: count % 2 === 0 ? 0.4 : 0.9, valid: true, fail_class: "ok", error: null }));
`;

function scoreProject({ evaluator = SCORE_EVAL_JSON, testScript = SCORE_TEST_OK } = {}) {
  return project({
    "package.json": `${JSON.stringify({
      name: "score-qualify", private: true, type: "module",
      scripts: { bench: "node bench.mjs", test: "node test.mjs" },
    }, null, 2)}\n`,
    "bench.mjs": 'import { accuracy } from "./src/model.mjs";\nconsole.log(accuracy());\n',
    "test.mjs": testScript,
    "src/model.mjs": SCORE_MODEL,
    "eval/score.mjs": evaluator,
  });
}

function scoreContract(overrides = {}) {
  return contract({
    outcome: {
      statement: "raise the benchmark accuracy",
      unit: "points",
      higherIsBetter: true,
      minimumUsefulGain: "10%",
      evaluator: { argv: ["node", "eval/score.mjs"], output: "score-json", inputs: ["eval/score.mjs"] },
    },
    budgets: { maxCampaigns: 2, maxAgentStarts: 20, maxEvaluatorRuns: 240, deadlineMs: 240_000, falseAcceptBudget: 0.01 },
    ...overrides,
  });
}

test("a declared score evaluator is qualified as the instrument, with its inputs pinned", async () => {
  const projectDir = scoreProject();
  const runContract = scoreContract();
  const { plan, report } = await qualify(projectDir, runContract);

  assert.equal(report.passed, true, `expected qualification to pass: ${JSON.stringify(report.rejections)}`);
  assert.equal(plan.ready, true);
  assert.equal(plan.metricKind, "score");
  assert.deepEqual(plan.argv, ["node", "eval/score.mjs"], "the declared evaluator is the measured program");
  assert.deepEqual(plan.evaluatorInputs, ["eval/score.mjs"], "the evaluator code is pinned, never candidate-editable");
  assert.equal(plan.evaluatorOutput, "score-json");

  const frozen = plan.evaluationContract;
  assert.ok(frozen, "a qualified score instrument is frozen as an evaluation contract");
  assert.equal(frozen.metricKind, "score");
  assert.equal(frozen.unit, "points");
  assert.equal(frozen.higherIsBetter, true);
  assert.deepEqual(frozen.gates, ["npm run test"], "the declared test command is still the oracle");
  assert.ok(frozen.assets.some((asset) => asset.path === "eval/score.mjs"), "the paused evaluator input is digested into the identity");
  assert.ok(frozen.assets.some((asset) => /evaluate\.mjs$/.test(asset.path)), "the generated instrument is digested too");
  assert.ok(frozen.baseline.length >= 2, "the contract records repeated baseline readings");

  const named = report.checks.map((check) => check.name);
  for (const required of ["workload", "baseline", "stability", "direction", "sensitivity", "missing-workload", "oracle", "budget-fit"]) {
    assert.ok(named.includes(required), `qualification must report the ${required} check`);
  }
  const sensitivity = report.checks.find((check) => check.name === "sensitivity");
  assert.equal(sensitivity.passed, true, sensitivity.detail);
  assert.match(sensitivity.detail, /inert|editable/i, "the score control is the inert editable scope");
});

test("the score budget-fit check reports the promotion floor the confirmation actually needs", async () => {
  const projectDir = scoreProject();
  const { report } = await qualify(projectDir, scoreContract());
  const budget = report.checks.find((check) => check.name === "budget-fit");
  assert.equal(budget.passed, true, budget.detail);
  assert.match(budget.detail, /deterministic/, "an exact score reading plans the two-run confirmation");
  assert.match(budget.detail, /promotion floor|evaluator run/i, "the check explains the floor instead of repeating the old timeout estimate");

  const tightProject = scoreProject();
  const tight = await qualify(tightProject, scoreContract({ budgets: { maxCampaigns: 2, maxAgentStarts: 20, maxEvaluatorRuns: 240, deadlineMs: 90_000, falseAcceptBudget: 0.01 } }));
  const tightBudget = tight.report.checks.find((check) => check.name === "budget-fit");
  assert.equal(tightBudget.passed, false, "a deadline below the promotion floor is refused");
  assert.match(tightBudget.detail, /does not fit|does not cover/);
});

test("a score evaluator that ignores the editable code is refused: inert code must invalidate or worsen the score", async () => {
  // The evaluator always reports 0.62, so inert editable code changes nothing.
  const projectDir = scoreProject({ evaluator: `import * as fs from "node:fs";\nfs.mkdirSync("eval", { recursive: true });\nfs.writeFileSync("eval/score.json", JSON.stringify({ score: 0.62, valid: true, fail_class: "ok", error: null }));\n` });
  const { plan, report } = await qualify(projectDir, scoreContract());

  assert.equal(report.passed, false, "an insensitive score instrument must be refused");
  const sensitivity = report.checks.find((check) => check.name === "sensitivity");
  assert.equal(sensitivity.passed, false);
  assert.match(sensitivity.detail, /did not change the score|wrong direction/);
  assert.equal(plan.ready, false);
});

test("a score instrument whose declared gate accepts inert code cannot be qualified", async () => {
  const projectDir = scoreProject({ testScript: SCORE_TEST_ALWAYS_PASSES });
  const { report } = await qualify(projectDir, scoreContract());

  assert.equal(report.passed, false);
  const oracle = report.checks.find((check) => check.name === "oracle");
  assert.equal(oracle.passed, false);
  assert.match(oracle.detail, /an inert version of the editable code still passes/);
});

test("a noisy score evaluator cannot resolve the useful gain", async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-score-noise-")), "toggle");
  const projectDir = scoreProject({ evaluator: SCORE_EVAL_NOISY(marker) });
  const { plan, report } = await qualify(projectDir, scoreContract(), { attempts: 1 });

  assert.equal(report.passed, false);
  const stability = report.checks.find((check) => check.name === "stability");
  assert.equal(stability.passed, false, "a noisy score channel cannot resolve a 10% change");
  assert.match(stability.detail, /cannot be distinguished from noise/);
  assert.equal(plan.ready, false);
});

void qualifyInstrument;
