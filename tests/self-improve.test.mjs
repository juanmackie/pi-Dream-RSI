import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { REPO } from "./fixtures.mjs";

const { purityViolations } = await import("../eval/purity.mjs");
const { buildMinedScenarios, prepareSelfImprovement } = await import("../scripts/self-improve.mjs");

test("purity AST gate accepts pure code and rejects imports, clocks, randomness, and I/O", () => {
  assert.deepEqual(purityViolations("export function score(x: number) { return Math.max(0, x); }"), []);
  const violations = purityViolations(`import fs from "node:fs";\nexport const x = Date.now() + Math.random();\nfs.readFileSync("secret");`);
  assert.ok(violations.some((item) => /imports and re-exports/.test(item)));
  assert.ok(violations.some((item) => /Date\.now/.test(item)));
  assert.ok(violations.some((item) => /Math\.random/.test(item)));
  assert.ok(violations.some((item) => /process and global access/.test(item)) || violations.some((item) => /imports/.test(item)));
  assert.ok(purityViolations("const x = new Function('return 1'); const y = Math.random;").some((item) => /Function construction|Math\.random/.test(item)));
  assert.ok(purityViolations("const x = ({} as any).constructor.constructor('return process')();").some((item) => /constructor-based/.test(item)));
});

test("snapshot scorer loads the workspace candidate and enforces heldout score and false-accept alpha", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-score-"));
  try {
    const candidate = path.join(project, "extensions", "pi-dream-rsi", "engine", "measure.ts");
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.copyFileSync(path.join(REPO, "extensions", "pi-dream-rsi", "engine", "measure.ts"), candidate);
    const setup = (await import("../scripts/setup-self-campaign.mjs")).setupSelfCampaign(project);
    const scorer = path.join(setup.verifierRoot, "eval", "self-score.mjs");
    const quickSeeds = ["--seeds=2000", "--heldout-seeds=1000"];
    const run = spawnSync(process.execPath, [scorer, project, ...quickSeeds], { cwd: project, encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const score = JSON.parse(fs.readFileSync(path.join(project, "eval", "score.json"), "utf8"));
    assert.equal(score.valid, true, JSON.stringify(score));
    assert.ok(score.primary.candidate.false_accepts.every((item) => item.upper <= score.alpha));
    assert.ok(score.heldout.candidate.false_accepts.every((item) => item.upper <= score.alpha));
    assert.match(score.formula, /primary positive-scenario power - 0\.25/);
    assert.equal(score.score, score.primary.candidate.score);
    assert.equal(score.delta_tokens, 0);

    const honestSource = fs.readFileSync(candidate, "utf8");
    const adapterStart = honestSource.indexOf("export async function runPaired(");
    assert.ok(adapterStart > 0);
    const replacingAdapter = (decision) => honestSource.slice(0, adapterStart) + `export async function runPaired() { return { decision: { decision: "${decision}" }, baseline: [], pairs: [], runs: 0 }; }\n`;
    fs.writeFileSync(candidate, replacingAdapter("accept"));
    const rejected = spawnSync(process.execPath, [scorer, project, ...quickSeeds], { cwd: project, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(rejected.status, 0);
    const failedScore = JSON.parse(fs.readFileSync(path.join(project, "eval", "score.json"), "utf8"));
    assert.equal(failedScore.valid, false);
    assert.equal(failedScore.fail_class, "false_accept_limit");

    fs.writeFileSync(candidate, replacingAdapter("reject"));
    const noop = spawnSync(process.execPath, [scorer, project, ...quickSeeds], { cwd: project, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(noop.status, 0);
    const noopScore = JSON.parse(fs.readFileSync(path.join(project, "eval", "score.json"), "utf8"));
    assert.equal(noopScore.valid, false);
    assert.equal(noopScore.fail_class, "power_regression");
    assert.equal(noopScore.power_floor.primary_passed, false);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("self-improve mines hashed numeric observations and prints a stable intake path", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-miner-"));
  try {
    const first = await prepareSelfImprovement({ projectDir: project, target: "measure", includeLogs: false });
    const observations = JSON.parse(fs.readFileSync(first.observationsPath, "utf8"));
    assert.match(observations.projects[0].project_id, /^[a-f0-9]{24}$/);
    assert.equal(JSON.stringify(observations).includes(project), false);
    assert.deepEqual(observations.features, []);
    const generated = buildMinedScenarios(JSON.parse(fs.readFileSync(path.join(REPO, "eval", "scenarios.json"), "utf8")), {
      features: [{ project_id: "a".repeat(24), source: "session", feature: "repeated-tool-retry", count: 4 }],
    });
    assert.equal(generated.scenarios.length, JSON.parse(fs.readFileSync(path.join(REPO, "eval", "scenarios.json"), "utf8")).scenarios.length + 1);
    const derived = generated.scenarios.at(-1);
    assert.equal(derived.kind, "student");
    assert.equal(typeof derived.noise_sd, "number");
    assert.match(derived.name, /^mined-null-[a-f0-9]+$/);
    const before = fs.readdirSync(path.dirname(first.observationsPath)).sort();
    const second = await prepareSelfImprovement({ projectDir: project, target: "measure", includeLogs: false });
    const after = fs.readdirSync(path.dirname(second.observationsPath)).sort();
    assert.deepEqual(after, before, "repeated setup replaces one observation file without growing a run log");

    const cliProject = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-cli-"));
    try {
      const cli = spawnSync(process.execPath, [path.join(REPO, "scripts", "self-improve.mjs"), cliProject], { cwd: REPO, encoding: "utf8", timeout: 120_000 });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(cli.stdout.trim(), path.join(cliProject, ".dream-rsi", path.basename(cli.stdout.trim())));
      assert.match(cli.stdout.trim(), /self-campaign-[a-f0-9]{64}\.json$/);
    } finally { fs.rmSync(cliProject, { recursive: true, force: true }); }
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("self-improve injects bounded, content-free ledger stress scenarios into its verifier snapshot", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-ledger-miner-"));
  try {
    const candidate = path.join(project, "extensions", "pi-dream-rsi", "engine", "measure.ts");
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.copyFileSync(path.join(REPO, "extensions", "pi-dream-rsi", "engine", "measure.ts"), candidate);
    const ledger = path.join(project, ".dream-rsi", "campaigns", "campaign-a", "history", "ledger.jsonl");
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, `${JSON.stringify({ v: 1, t: "2026-10-15T00:00:00.000Z", entryId: "gate-one", kind: "gate", stage: "gate", title: "PRIVATE TRANSCRIPT" })}\n`);
    const result = await prepareSelfImprovement({ projectDir: project, target: "measure", includeLogs: false });
    const observations = JSON.parse(fs.readFileSync(result.observationsPath, "utf8"));
    assert.ok(observations.features.some((item) => item.source === "ledger" && item.feature === "gate" && item.count === 1));
    assert.doesNotMatch(JSON.stringify(observations), /PRIVATE TRANSCRIPT|campaign-a|dream-rsi-self-ledger-miner/);
    assert.equal(result.derivedScenarioCount, 2, "a gate rejection adds deterministic null and boundary drift stress cases");
    const generated = JSON.parse(fs.readFileSync(result.scenarioPath, "utf8"));
    assert.ok(generated.scenarios.some((item) => item.name.startsWith("mined-null-")));
    assert.ok(generated.scenarios.some((item) => item.name.startsWith("mined-drift-boundary-")));
    const snapshotScenarios = JSON.parse(fs.readFileSync(path.join(result.verifierRoot, "eval", "scenarios.json"), "utf8"));
    assert.deepEqual(snapshotScenarios, generated, "the scorer loads the mined config from its immutable snapshot");
    const scorer = path.join(result.verifierRoot, "eval", "self-score.mjs");
    const scored = spawnSync(process.execPath, [scorer, project, "--seeds=2000", "--heldout-seeds=1000"], { cwd: project, encoding: "utf8", timeout: 30_000 });
    const report = JSON.parse(fs.readFileSync(path.join(project, "eval", "score.json"), "utf8"));
    assert.ok(["ok", "false_accept_limit", "heldout_regression", "primary_regression"].includes(report.fail_class), scored.stderr || scored.stdout);
    assert.ok(report.primary.candidate.false_accepts.some((item) => item.scenario.startsWith("mined-null-")));
    assert.ok(report.primary.candidate.false_accepts.some((item) => item.scenario.startsWith("mined-drift-boundary-")));
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("self-improve discovers session projects and mines their local ledgers by hashed identity", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-project-a-"));
  const discovered = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-project-b-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-sessions-"));
  try {
    const session = path.join(sessionDir, "session.jsonl");
    const now = new Date();
    fs.writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "session-one", timestamp: now.toISOString(), cwd: discovered })}\n`);
    fs.utimesSync(session, now, now);
    const ledger = path.join(discovered, ".dream-rsi", "campaigns", "campaign-b", "history", "ledger.jsonl");
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, `${JSON.stringify({ v: 1, t: now.toISOString(), entryId: "timeout-one", kind: "attempt", outcome: "timeout" })}\n`);
    const result = await prepareSelfImprovement({ projectDir: project, sessionDir, now });
    const observations = JSON.parse(fs.readFileSync(result.observationsPath, "utf8"));
    assert.equal(observations.projects.length, 2);
    assert.ok(observations.features.some((item) => item.source === "ledger" && item.feature === "attempt" && item.count === 1));
    assert.equal(JSON.stringify(observations).includes(discovered), false);
    assert.ok(observations.projects.every((item) => /^[a-f0-9]{24}$/.test(item.project_id)));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(discovered, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("self-improve maps standard per-project session folders to their own project only", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-folders-root-"));
  const firstProject = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-folders-a-"));
  const secondProject = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-folders-b-"));
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_SESSION_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentRoot;
    delete process.env.PI_SESSION_DIR;
    const sessions = path.join(agentRoot, "sessions");
    const writeHeader = (folder, projectDir, stopReason) => {
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, "recent.jsonl");
      const now = new Date();
      fs.writeFileSync(file, [
        { type: "session", version: 3, id: path.basename(folder), timestamp: now.toISOString(), cwd: projectDir },
        { type: "message", message: { role: "assistant", stopReason, content: [] } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      fs.utimesSync(file, now, now);
      fs.utimesSync(folder, now, now);
      return now;
    };
    const firstTime = writeHeader(path.join(sessions, "encoded-project-a"), firstProject, "aborted");
    const secondTime = writeHeader(path.join(sessions, "encoded-project-b"), secondProject, "length");
    const now = new Date(Math.max(firstTime.getTime(), secondTime.getTime()) + 1);
    const result = await prepareSelfImprovement({ projectDir: project, now });
    const observations = JSON.parse(fs.readFileSync(result.observationsPath, "utf8"));
    const firstId = crypto.createHash("sha256").update(fs.realpathSync(firstProject)).digest("hex").slice(0, 24);
    const secondId = crypto.createHash("sha256").update(fs.realpathSync(secondProject)).digest("hex").slice(0, 24);
    assert.equal(observations.features.find((row) => row.project_id === firstId && row.feature === "aborted-session")?.count, 1);
    assert.equal(observations.features.find((row) => row.project_id === secondId && row.feature === "aborted-session")?.count, 1);
    assert.equal(observations.projects.length, 3);
    assert.doesNotMatch(JSON.stringify(observations), /encoded-project|dream-rsi-self-folders|dream-rsi-self-agent/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_SESSION_DIR; else process.env.PI_SESSION_DIR = previousSessionDir;
    for (const dir of [project, firstProject, secondProject, agentRoot]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no-session-logs suppresses configured session paths before accessing them", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-no-logs-"));
  const discovered = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-no-logs-discovered-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-no-logs-sessions-"));
  try {
    fs.writeFileSync(path.join(sessionDir, "session.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "private-session", timestamp: new Date().toISOString(), cwd: discovered })}\n`);
    const options = { projectDir: project, noSessionLogs: true, includeLogs: true };
    Object.defineProperty(options, "sessionDir", { get() { throw new Error("session directory must not be inspected"); } });
    const result = await prepareSelfImprovement(options);
    const observations = JSON.parse(fs.readFileSync(result.observationsPath, "utf8"));
    assert.equal(observations.projects.length, 1);
    assert.deepEqual(observations.features, []);
    const cliProject = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-no-logs-cli-"));
    try {
      const cli = spawnSync(process.execPath, [path.join(REPO, "scripts", "self-improve.mjs"), cliProject,
        `--session-dir=${sessionDir}`, "--no-session-logs"], { cwd: REPO, encoding: "utf8", timeout: 30_000 });
      assert.equal(cli.status, 0, cli.stderr);
      const cliObservations = JSON.parse(fs.readFileSync(path.join(cliProject, ".dream-rsi", "self-improvement", "observations.json"), "utf8"));
      assert.equal(cliObservations.projects.length, 1, "the CLI flag overrides even a configured session directory");
      assert.deepEqual(cliObservations.features, []);
    } finally { fs.rmSync(cliProject, { recursive: true, force: true }); }
  } finally {
    for (const dir of [project, discovered, sessionDir]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
