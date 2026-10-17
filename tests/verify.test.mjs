/**
 * Independent post-apply verification.
 *
 * The campaign proved its own instrument moved. This check starts from a fresh
 * copy of the resulting tree, runs the declared correctness commands, and
 * measures the same workload again. A promoted change that does not survive it
 * must stop the run rather than become the next baseline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { normalizeRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";
import { verifyPostApply } from "../extensions/pi-dream-rsi/engine/verify.ts";

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
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

/** Deterministic busy work, so a stubbed reading is not needed to make the workload real. */
const WORK = `export function work(ms) {
  const until = performance.now() + ms;
  let spins = 0;
  while (performance.now() < until) spins += 1;
  return spins;
}
`;
const BENCH = `import { work } from "./src/work.mjs";
if (work(40) <= 0) process.exit(1);
`;
const TEST_OK = `import { work } from "./src/work.mjs";
if (work(1) <= 0) process.exit(1);
`;
const TEST_FAILS = `console.error("behaviour regressed");
process.exit(1);
`;

function fixture({ testScript = TEST_OK } = {}) {
  return project({
    "package.json": `${JSON.stringify({ name: "verify", private: true, type: "module", scripts: { test: "node test.mjs", bench: "node bench.mjs" } }, null, 2)}\n`,
    "bench.mjs": BENCH,
    "test.mjs": testScript,
    "src/work.mjs": WORK,
  });
}

test("a real improvement clears the useful gain against the pre-campaign baseline", async () => {
  const projectDir = fixture();
  const baseline = [520, 530, 540];
  const result = await verifyPostApply({
    projectDir,
    contract: contract(),
    argv: ["node", "bench.mjs"],
    gates: ["npm run test"],
    baseline,
    minimumUsefulGain: "20%",
    unit: "ms",
    higherIsBetter: false,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    measureImpl: async () => 120,
  });

  assert.equal(result.passed, true, result.reason ?? "");
  assert.equal(result.gain, 410, "the gain is measured against the recorded baseline median");
  assert.match(result.detail, /1 gate\(s\) passed/);
  assert.match(result.detail, /workload 530 -> 120 ms/);
});

test("an improvement smaller than the useful gain is not accepted", async () => {
  const projectDir = fixture();
  const result = await verifyPostApply({
    projectDir,
    contract: contract(),
    argv: ["node", "bench.mjs"],
    gates: [],
    baseline: [500, 500, 500],
    minimumUsefulGain: "20%",
    unit: "ms",
    higherIsBetter: false,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    measureImpl: async () => 460,
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /short of the useful gain 100 ms/);
});

test("a regressed correctness gate fails the check before the workload is even measured", async () => {
  const projectDir = fixture({ testScript: TEST_FAILS });
  let measured = false;
  const result = await verifyPostApply({
    projectDir,
    contract: contract(),
    argv: ["node", "bench.mjs"],
    gates: ["npm run test"],
    baseline: [500, 500, 500],
    minimumUsefulGain: "20%",
    unit: "ms",
    higherIsBetter: false,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    measureImpl: async () => { measured = true; return 10; },
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /the applied state fails "npm run test"/);
  assert.equal(measured, false, "a broken gate is decisive; the workload is not consulted");
});

test("a workload that does not complete on the applied state fails the check", async () => {
  const projectDir = fixture();
  const result = await verifyPostApply({
    projectDir,
    contract: contract(),
    argv: ["node", "missing-bench.mjs"],
    gates: [],
    baseline: [500, 500, 500],
    minimumUsefulGain: "20%",
    unit: "ms",
    higherIsBetter: false,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 30_000,
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /did not complete on the applied state/);
});

test("a higher-is-better objective takes the opposite gain direction", async () => {
  const projectDir = fixture();
  const result = await verifyPostApply({
    projectDir,
    contract: contract({ outcome: { statement: "raise the benchmark score", unit: "points", higherIsBetter: true, minimumUsefulGain: "20%" } }),
    argv: ["node", "bench.mjs"],
    gates: [],
    baseline: [100, 100, 100],
    minimumUsefulGain: "20%",
    unit: "points",
    higherIsBetter: true,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    measureImpl: async () => 300,
  });
  assert.equal(result.passed, true, result.reason ?? "");
  assert.equal(result.gain, 200);
});

test("the check runs the gates against a copy and leaves the project untouched", async () => {
  const projectDir = fixture({ testScript: "import { writeFileSync } from \"node:fs\";\nwriteFileSync(\"gate-ran\", \"x\");\n" });
  await verifyPostApply({
    projectDir,
    contract: contract(),
    argv: ["node", "bench.mjs"],
    gates: ["npm run test"],
    baseline: [500, 500, 500],
    minimumUsefulGain: "20%",
    unit: "ms",
    higherIsBetter: false,
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-verify-work-")),
    timeoutMs: 60_000,
    measureImpl: async () => 10,
  });
  assert.equal(fs.existsSync(path.join(projectDir, "gate-ran")), false, "gate side effects stay inside the throwaway copy");
});
