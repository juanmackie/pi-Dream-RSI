import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { REPO } from "./fixtures.mjs";

const { setupSelfCampaign } = await import("../scripts/setup-self-campaign.mjs");

test("self-campaign setup writes a content-addressed verifier and preserves old task data", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-setup-"));
  try {
    const legacyTask = path.join(project, ".dream-rsi", "task.json");
    const legacyHistory = path.join(project, ".dream-rsi", "history", "old.json");
    fs.mkdirSync(path.dirname(legacyHistory), { recursive: true });
    fs.writeFileSync(legacyTask, "{\"old\":true}\n");
    fs.writeFileSync(legacyHistory, "legacy bytes\n");
    const legacyBytes = [fs.readFileSync(legacyTask), fs.readFileSync(legacyHistory)];

    const first = setupSelfCampaign(project);
    const second = setupSelfCampaign(project);
    assert.equal(second.hash, first.hash);
    assert.equal(second.verifierRoot, first.verifierRoot);
    assert.deepEqual(fs.readFileSync(legacyTask), legacyBytes[0]);
    assert.deepEqual(fs.readFileSync(legacyHistory), legacyBytes[1]);

    const manifest = JSON.parse(fs.readFileSync(path.join(first.verifierRoot, "snapshot.json"), "utf8"));
    const paths = manifest.files.map((file) => file.path);
    for (const required of [
      ".auto/score.mjs",
      ".auto/replay-worlds.mjs",
      ".auto/policy-gate.mjs",
      "extensions/pi-dream-rsi/worker/policy-worker.ts",
      "extensions/pi-dream-rsi/policy/api.ts",
      "extensions/pi-dream-rsi/policy/observation-signal.ts",
      "prompts/discovery-agent.md",
      "PROBLEM.md",
      "package.json",
    ]) assert.ok(paths.includes(required), `snapshot includes ${required}`);
    assert.equal(paths.some((file) => file.endsWith("/policy/method.ts")), false);

    const intake = JSON.parse(fs.readFileSync(first.intakePath, "utf8"));
    assert.equal(intake.project_dir, fs.realpathSync(project));
    assert.equal(intake.action, "start");
    assert.equal(Object.hasOwn(intake, "version"), false);
    assert.equal(intake.task.workspace, ".");
    assert.equal(intake.task.eval_program, "extensions/pi-dream-rsi/policy/method.ts");
    assert.equal(intake.task.problem_file, path.relative(project, path.join(first.verifierRoot, "PROBLEM.md")));
    const scorerPath = intake.task.score_program.match(/"([^"]+\.mjs)"|'([^']+\.mjs)'/);
    assert.equal(path.isAbsolute(scorerPath?.[1] ?? scorerPath?.[2]), true);
    assert.ok(intake.scope.includes("extensions/pi-dream-rsi/policy/method.ts"));
    assert.ok(intake.verifier_inputs.every((file) => path.isAbsolute(file)));
    assert.ok(intake.verifier_inputs.every((file) => !file.endsWith(`${path.sep}policy${path.sep}method.ts`)));
    assert.ok(intake.verifier_inputs.includes(path.join(first.verifierRoot, "snapshot.json")));
    assert.deepEqual(intake.gates.map((gate) => gate.endsWith("npm test") ? "npm test" : "policy gate"), ["policy gate", "npm test"]);

    const protectedFile = path.join(first.verifierRoot, ".auto", "score.mjs");
    const original = fs.readFileSync(protectedFile);
    fs.appendFileSync(protectedFile, "// changed after creation\n");
    assert.throws(() => setupSelfCampaign(project), /will not be overwritten/);
    assert.notDeepEqual(fs.readFileSync(protectedFile), original);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a changed trusted verifier gets a new snapshot and leaves the previous intake intact", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-version-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-source-"));
  try {
    fs.cpSync(path.join(REPO, ".auto"), path.join(source, ".auto"), { recursive: true });
    fs.cpSync(path.join(REPO, "extensions"), path.join(source, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(source, "prompts"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "prompts", "discovery-agent.md"), path.join(source, "prompts", "discovery-agent.md"));
    fs.copyFileSync(path.join(REPO, "PROBLEM.md"), path.join(source, "PROBLEM.md"));
    const first = setupSelfCampaign(project, source);
    const firstIntake = fs.readFileSync(first.intakePath);
    const engineFile = path.join(source, "extensions", "pi-dream-rsi", "engine", "tree.ts");
    fs.appendFileSync(engineFile, "\n// verifier version change\n");

    const second = setupSelfCampaign(project, source);
    assert.notEqual(second.hash, first.hash);
    assert.notEqual(second.intakePath, first.intakePath);
    assert.equal(fs.existsSync(first.intakePath), true);
    assert.deepEqual(fs.readFileSync(first.intakePath), firstIntake);
    assert.equal(fs.existsSync(path.join(first.verifierRoot, ".auto", "score.mjs")), true);
    assert.equal(fs.existsSync(path.join(second.verifierRoot, ".auto", "score.mjs")), true);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("the generated task checks the staged shipped policy with its snapshot scorer and gate", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-self-control-"));
  try {
    const candidate = path.join(project, "extensions", "pi-dream-rsi", "policy");
    fs.mkdirSync(candidate, { recursive: true });
    for (const file of ["method.ts", "api.ts", "observation-signal.ts"]) {
      fs.copyFileSync(path.join(REPO, "extensions", "pi-dream-rsi", "policy", file), path.join(candidate, file));
    }
    const setup = setupSelfCampaign(project);
    const scorerMatch = setup.intake.task.score_program.match(/"([^"]+\.mjs)"|'([^']+\.mjs)'/);
    const scorer = scorerMatch?.[1] ?? scorerMatch?.[2];
    assert.ok(scorer);
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, [scorer, "--benchmark-version=2"], { cwd: project, encoding: "utf8", timeout: 30_000 });
    const score = JSON.parse(fs.readFileSync(path.join(project, "eval", "score.json"), "utf8"));
    assert.equal(score.valid, true);
    assert.equal(score.fail_class, "ok");
    assert.equal(typeof score.score, "number");

    const policyGate = setup.intake.gates.find((gate) => gate.includes("policy-gate.mjs"));
    assert.ok(policyGate);
    const gateMatch = policyGate.match(/"([^"]+\.mjs)"|'([^']+\.mjs)'/);
    const gateScript = gateMatch?.[1] ?? gateMatch?.[2];
    execFileSync(process.execPath, [gateScript, setup.intake.task.eval_program], { cwd: project, encoding: "utf8", timeout: 10_000 });
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("the bundled self-campaign PROBLEM names the frozen campaign contract", () => {
  const problem = fs.readFileSync(path.join(REPO, "PROBLEM.md"), "utf8");
  assert.match(problem, /\.dream-rsi\/verifier/);
  assert.match(problem, /absolute `score_program`/);
  assert.match(problem, /verifier_inputs/);
  assert.match(problem, /extensions\/pi-dream-rsi\/policy\/method\.ts/);
  assert.doesNotMatch(problem, /dream_rsi_init/);
});
