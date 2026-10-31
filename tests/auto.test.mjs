import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const { autoProviderRetryCount, initAuto, runAuto, logAuto, recordAutoProviderOutcome, statusAuto, stopAuto } = await import("../extensions/pi-dream-rsi/engine/auto.ts");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-auto-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Dream RSI Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "dream-rsi-test@example.invalid"], { cwd: root });
  fs.cpSync(path.resolve("examples/autoresearch"), root, { recursive: true });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
  return { root, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const contract = (root, overrides = {}) => ({
  consent: true,
  providerCap: 100,
  goal: "Reduce fixture value without changing correctness",
  metric: "value",
  unit: "count",
  higherIsBetter: false,
  command: "node measure.mjs",
  checks: "node check.mjs",
  scope: ["src"],
  minimumGain: 1,
  maxExperiments: 10,
  maxConsecutiveDiscards: 3,
  branch: "dream-rsi/auto",
  ...overrides,
});

test("init qualifies a clean repository, branches, then commits only a passing measurable win", async (t) => {
  const p = project(); t.after(p.close);
  const initialized = await initAuto(p.root, contract(p.root));
  const initialLog = fs.readFileSync(path.join(p.root, ".dream-rsi/auto/log.jsonl"), "utf8");
  assert.equal(initialized.ok, true);
  assert.equal(initialized.config.baseline, 10);
  fs.writeFileSync(path.join(p.root, "src/value.txt"), "8\n");
  const pending = runAuto(p.root);
  await assert.rejects(runAuto(p.root), /auto run is already in progress|another auto run claimed/);
  const run = await pending;
  assert.equal(run.metric, 8);
  fs.appendFileSync(path.join(p.root, ".dream-rsi/auto/log.jsonl"), '{"interrupted":');
  const logged = await logAuto(p.root, { description: "Lower fixture value" });
  assert.equal(logged.status, "kept");
  assert.equal(statusAuto(p.root).runs, 1);
  const durableLog = fs.readFileSync(path.join(p.root, ".dream-rsi/auto/log.jsonl"), "utf8");
  assert.ok(durableLog.startsWith(initialLog), "logging appends without rewriting prior records");
  assert.equal(durableLog.trim().split(/\r?\n/).length, 2, "an interrupted partial row is truncated before the next append");
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: p.root, encoding: "utf8" }).trim(), "dream-rsi/auto");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: p.root, encoding: "utf8" }).trim(), "?? .dream-rsi/");
});

test("logging recovers an exact verified commit after a crash before durable auto state advances", async (t) => {
  const p = project(); t.after(p.close);
  await initAuto(p.root, contract(p.root));
  fs.writeFileSync(path.join(p.root, "src/value.txt"), "8\n");
  const run = await runAuto(p.root);
  execFileSync("git", ["add", "--", "src/value.txt"], { cwd: p.root });
  execFileSync("git", ["commit", "-m", `Dream-RSI: verified improvement (${run.id})`], { cwd: p.root, stdio: "ignore" });
  const committedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.root, encoding: "utf8" }).trim();
  const logged = await logAuto(p.root, { description: "Recover committed experiment" });
  assert.equal(logged.status, "kept");
  assert.equal(logged.commit, committedHead);
  assert.equal(statusAuto(p.root).runs, 1);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.root, encoding: "utf8" }).trim(), committedHead, "recovery does not create a duplicate commit");
});

test("auto logging reconciles a durable log row and stale pending file without duplicating it", async (t) => {
  const p = project(); t.after(p.close);
  await initAuto(p.root, contract(p.root));
  fs.writeFileSync(path.join(p.root, "src/value.txt"), "8\n");
  const run = await runAuto(p.root);
  const pendingRun = fs.readFileSync(path.join(p.root, ".dream-rsi/auto/last-run.json"), "utf8");
  execFileSync("git", ["add", "--", "src/value.txt"], { cwd: p.root });
  execFileSync("git", ["commit", "-m", `Dream-RSI: verified improvement (${run.id})`], { cwd: p.root, stdio: "ignore" });
  const committedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.root, encoding: "utf8" }).trim();
  const item = { run: run.runNumber, id: run.id, status: "kept", metric: run.metric, best: run.metric, commit: committedHead,
    description: "Recovered durable log row", confidence: 0.95, at: new Date().toISOString() };
  fs.appendFileSync(path.join(p.root, ".dream-rsi/auto/log.jsonl"), `${JSON.stringify(item)}\n`);
  const logFile = path.join(p.root, ".dream-rsi/auto/log.jsonl");
  const logged = await logAuto(p.root, { description: "Must not replace durable row" });
  assert.equal(logged.description, item.description);
  assert.equal(statusAuto(p.root).runs, 1);
  assert.equal(fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).length, 2);
  fs.writeFileSync(path.join(p.root, ".dream-rsi/auto/last-run.json"), pendingRun);
  assert.equal((await logAuto(p.root, { description: "Duplicate recovery" })).id, run.id);
  assert.equal(statusAuto(p.root).runs, 1);
  assert.equal(fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).length, 2);
});

test("a crash after discard is recovered as one durable discarded run", async (t) => {
  const p = project(); t.after(p.close);
  await initAuto(p.root, contract(p.root));
  fs.writeFileSync(path.join(p.root, "src/value.txt"), "8\n");
  const run = await runAuto(p.root);
  execFileSync("git", ["restore", "--worktree", "--staged", "--", "src/value.txt"], { cwd: p.root });
  const logged = await logAuto(p.root, {});
  assert.equal(logged.id, run.id);
  assert.equal(logged.status, "discarded");
  assert.equal(logged.description, "recovered interrupted run");
  assert.equal(statusAuto(p.root).runs, 1);
  assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: p.root, encoding: "utf8" }).trim(), "baseline");
});

test("failed checks discard scoped edits and continue without committing", async (t) => {
  const p = project(); t.after(p.close);
  await initAuto(p.root, contract(p.root));
  fs.writeFileSync(path.join(p.root, "src/value.txt"), "7\n");
  fs.mkdirSync(path.join(p.root, "src/nested"));
  fs.writeFileSync(path.join(p.root, "src/nested/new.txt"), "experiment\n");
  const run = await runAuto(p.root);
  assert.equal(run.metric, 7);
  const logged = await logAuto(p.root, { description: "Bad check" });
  assert.equal(logged.status, "discarded");
  assert.equal(fs.readFileSync(path.join(p.root, "src/value.txt"), "utf8").replaceAll("\r\n", "\n"), "10\n");
  assert.equal(fs.existsSync(path.join(p.root, "src/nested/new.txt")), false);
  assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: p.root, encoding: "utf8" }).trim(), "baseline");
  assert.equal(statusAuto(p.root).state, "active", "a failed check is discarded without stopping the loop");
  fs.writeFileSync(path.join(p.root, "src/value.txt"), "8\n");
  await runAuto(p.root);
  assert.equal((await logAuto(p.root, { description: "Next valid experiment" })).status, "kept");
});

test("confirmation compares a candidate to the current best and will not commit a regression", async (t) => {
  const p = project(); t.after(p.close);
  await initAuto(p.root, contract(p.root));
  fs.writeFileSync(path.join(p.root, "src/value.txt"), "8\n");
  await runAuto(p.root);
  const first = await logAuto(p.root, { description: "Improve from baseline" });
  assert.equal(first.status, "kept");
  const bestHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.root, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(p.root, "src/value.txt"), "9\n");
  await runAuto(p.root);
  const regressed = await logAuto(p.root, { description: "Would regress current best" });
  assert.equal(regressed.status, "discarded");
  assert.equal(regressed.best, 8);
  assert.equal(fs.readFileSync(path.join(p.root, "src/value.txt"), "utf8").replaceAll("\r\n", "\n"), "8\n");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.root, encoding: "utf8" }).trim(), bestHead);
});

test("ten fixture experiments retain a verified win and stop at the declared cap", async (t) => {
  const p = project(); t.after(p.close);
  await initAuto(p.root, contract(p.root, { maxConsecutiveDiscards: 10 }));
  let wins = 0;
  for (let index = 0; index < 10; index += 1) {
    if (index === 0) fs.writeFileSync(path.join(p.root, "src/value.txt"), "8\n");
    else fs.writeFileSync(path.join(p.root, `src/idea-${index}.txt`), "no metric change\n");
    await runAuto(p.root);
    const result = await logAuto(p.root, { description: `Fixture experiment ${index + 1}` });
    if (result.status === "kept") wins += 1;
  }
  assert.equal(wins, 1);
  assert.equal(statusAuto(p.root).state, "stopped");
  assert.equal(statusAuto(p.root).runs, 10);
  assert.match(statusAuto(p.root).next, /experiment cap reached/);
});

test("a stop requested while logging is preserved at the run boundary", async (t) => {
  const p = project(); t.after(p.close);
  await initAuto(p.root, contract(p.root));
  fs.writeFileSync(path.join(p.root, "src/value.txt"), "8\n");
  await runAuto(p.root);
  const logging = logAuto(p.root, { description: "Stop at the current boundary" });
  stopAuto(p.root);
  assert.equal((await logging).status, "kept");
  assert.equal(statusAuto(p.root).state, "stopped");
  assert.equal(statusAuto(p.root).config.stopRequested, true);
});

test("resume reads durable state and off completes at the current run boundary", async (t) => {
  const p = project(); t.after(p.close);
  await initAuto(p.root, contract(p.root));
  fs.writeFileSync(path.join(p.root, "src/value.txt"), "8\n");
  const pending = runAuto(p.root);
  stopAuto(p.root);
  const run = await pending;
  assert.equal(run.metric, 8);
  const stopped = await logAuto(p.root, { description: "Finish in-flight experiment" });
  assert.equal(stopped.status, "kept");
  assert.equal(statusAuto(p.root).state, "stopped");
  assert.match(statusAuto(p.root).next, /operator stopped at run boundary/);
});

test("secret-shaped log text is redacted without hiding a pending run", async (t) => {
  const p = project(); t.after(p.close);
  await initAuto(p.root, contract(p.root));
  fs.writeFileSync(path.join(p.root, "src/value.txt"), "8\n");
  await runAuto(p.root);
  const result = await logAuto(p.root, { description: "token sk-abcdefghijk123456" });
  assert.equal(result.description, "token [REDACTED]");
  assert.doesNotMatch(fs.readFileSync(path.join(p.root, ".dream-rsi/auto/log.jsonl"), "utf8"), /sk-abcdefghijk123456/);
  assert.equal(statusAuto(p.root).runs, 1);
});

test("tampered persisted contract or resume prompt fails closed", async (t) => {
  const p = project(); t.after(p.close);
  await initAuto(p.root, contract(p.root));
  const configPath = path.join(p.root, ".dream-rsi/auto/config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.command = "echo 0";
  fs.writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => statusAuto(p.root), /approved state changed/);

  const q = project(); t.after(q.close);
  await initAuto(q.root, contract(q.root));
  fs.appendFileSync(path.join(q.root, ".dream-rsi/auto/prompt.md"), "tampered\n");
  assert.throws(() => statusAuto(q.root), /resume prompt changed/);
});

test("provider quota stops immediately and transient errors stop after three failures", async (t) => {
  const p = project(); t.after(p.close);
  await initAuto(p.root, contract(p.root));
  recordAutoProviderOutcome(p.root, { stopReason: "error", errorMessage: "HTTP 429 rate limit" });
  assert.equal(autoProviderRetryCount(p.root), 1);
  recordAutoProviderOutcome(p.root, { stopReason: "error", errorMessage: "HTTP 503 temporarily unavailable" });
  assert.equal(autoProviderRetryCount(p.root), 2);
  assert.equal(statusAuto(p.root).state, "active");
  recordAutoProviderOutcome(p.root, { stopReason: "error", errorMessage: "HTTP 502 overloaded" });
  assert.equal(statusAuto(p.root).state, "stopped");
  assert.equal(autoProviderRetryCount(p.root), null);
  assert.match(statusAuto(p.root).next, /three transient provider failures/);

  const q = project(); t.after(q.close);
  await initAuto(q.root, contract(q.root));
  recordAutoProviderOutcome(q.root, { stopReason: "error", errorMessage: "provider quota exceeded" });
  assert.equal(statusAuto(q.root).state, "stopped");
  assert.match(statusAuto(q.root).next, /quota rejected/);
});

test("init refuses protected/default branches and run stops on branch drift", async (t) => {
  const p = project(); t.after(p.close);
  await assert.rejects(initAuto(p.root, contract(p.root, { protectedAssets: ["src/value.txt"] })), /overlaps a protected path/i);
  await assert.rejects(initAuto(p.root, contract(p.root, { branch: "main" })), /default branch/i);
  await initAuto(p.root, contract(p.root));
  execFileSync("git", ["checkout", "-b", "operator/other"], { cwd: p.root, stdio: "ignore" });
  await assert.rejects(runAuto(p.root), /branch drift/);
  assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: p.root, encoding: "utf8" }).trim(), "baseline");
});

test("init refuses an auto-state path that is not a real directory", async (t) => {
  const p = project(); t.after(p.close);
  fs.writeFileSync(path.join(p.root, ".dream-rsi"), "not a directory");
  await assert.rejects(initAuto(p.root, contract(p.root)), /auto state path is not a real directory/);
});

test("init refuses dirty and out-of-scope repositories; status is read-only", async (t) => {
  const p = project(); t.after(p.close);
  fs.writeFileSync(path.join(p.root, "user.txt"), "keep me");
  await assert.rejects(initAuto(p.root, contract(p.root)), /clean working tree/i);
  fs.rmSync(path.join(p.root, "user.txt"));
  await initAuto(p.root, contract(p.root));
  const staleLock = path.join(p.root, ".dream-rsi/auto/run.lock");
  fs.writeFileSync(staleLock, JSON.stringify({ pid: 2147483647 }));
  const beforeStatus = fs.readFileSync(staleLock, "utf8");
  statusAuto(p.root);
  assert.equal(fs.readFileSync(staleLock, "utf8"), beforeStatus, "status must not remove stale locks or write state");
  fs.rmSync(staleLock);
  fs.writeFileSync(path.join(p.root, "outside.txt"), "bad");
  await assert.rejects(runAuto(p.root), /out-of-scope diff/i);
  fs.rmSync(path.join(p.root, "outside.txt"));
  const before = fs.readFileSync(path.join(p.root, ".dream-rsi/auto/log.jsonl"), "utf8");
  statusAuto(p.root);
  assert.equal(fs.readFileSync(path.join(p.root, ".dream-rsi/auto/log.jsonl"), "utf8"), before);
});
