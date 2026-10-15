import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import fsMutable from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { collectSignals } from "../extensions/pi-dream-rsi/engine/signals.ts";

const execFileAsync = promisify(execFile);
const NOW = new Date("2026-10-15T00:00:00.000Z");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-signals-"));
}

function writeSession(sessionDir, projectDir, entries, name = "session.jsonl", mtime = NOW) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const header = { type: "session", version: 3, id: name, timestamp: mtime.toISOString(), cwd: projectDir };
  const file = path.join(sessionDir, name);
  fs.writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  fs.utimesSync(file, mtime, mtime);
  return file;
}

function toolEntry(id, name, arguments_, time) {
  return {
    type: "message", id: `entry-${id}`, parentId: null, timestamp: new Date(time).toISOString(),
    message: {
      role: "assistant", content: [{ type: "toolCall", id, name, arguments: arguments_ }],
      timestamp: time, provider: "fixture", model: "fixture", api: "fixture", usage: {}, stopReason: "toolUse",
    },
  };
}

function toolResult(id, name, text, time, { isError = false, details } = {}) {
  return {
    type: "message", id: `result-${id}`, parentId: null, timestamp: new Date(time).toISOString(),
    message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: time, details },
  };
}

test("session signals aggregate safe command heads, correlate edits, and redact private text", async () => {
  const projectDir = tempDir();
  const sessionDir = path.join(projectDir, "sessions");
  const secret = "sk-live-fixture-secret-9988";
  const prompt = "PRIVATE USER PROMPT SHOULD NEVER APPEAR";
  writeSession(sessionDir, projectDir, [
    { type: "message", id: "user", parentId: null, timestamp: NOW.toISOString(), message: { role: "user", content: prompt, timestamp: NOW.getTime() } },
    toolEntry("failed", "bash", { command: `npm test -- --token=${secret}` }, NOW.getTime()),
    toolResult("failed", "bash", `Error: Authorization: Bearer ${secret} ${prompt}`, NOW.getTime() + 2500, { isError: true }),
    toolEntry("json-error", "bash", { command: "node private-script.mjs" }, NOW.getTime() + 2600),
    toolResult("json-error", "bash", `TypeError: {"api_key":"short-secret-value"}`, NOW.getTime() + 2700, { isError: true }),
    toolEntry("write", "write", { path: "src/parser.ts", content: secret }, NOW.getTime() + 3000),
    toolResult("write", "write", "written", NOW.getTime() + 3100),
    toolEntry("edit", "edit", { path: "src/lexer.ts", edits: [{ oldText: secret, newText: "fixed" }] }, NOW.getTime() + 3200),
    toolResult("edit", "edit", "edited", NOW.getTime() + 3300),
    toolEntry("sensitive-path", "write", { path: "src/sk-live-fixture-secret-9988.ts", content: "private" }, NOW.getTime() + 3400),
    toolResult("sensitive-path", "write", "written", NOW.getTime() + 3500),
    toolEntry("private", "bash", { command: `curl -H 'Authorization: ${secret}' https://user:${secret}@private.invalid/path?token=${secret}` }, NOW.getTime() + 4000),
    toolResult("private", "bash", "request failed", NOW.getTime() + 5000, { isError: true }),
    { type: "message", id: "assistant-text", parentId: null, timestamp: NOW.toISOString(), message: { role: "assistant", content: [{ type: "text", text: prompt }] } },
    null,
    17,
    "unexpected-json-string",
    { type: "message", id: "bad-message", message: { role: "assistant", content: null } },
    { type: "message", id: "bad-time", timestamp: 8.64e15 + 1, message: { role: "assistant", content: [] } },
  ]);

  try {
    const result = await collectSignals({ projectDir, sessionDir, now: NOW });
    const serialized = JSON.stringify(result);
    assert.match(serialized, /npm test/);
    assert.match(serialized, /src\/parser\.ts/);
    assert.match(serialized, /src\/lexer\.ts/);
    assert.doesNotMatch(serialized, /sk-live-fixture-secret-9988/);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.doesNotMatch(serialized, new RegExp(prompt));
    assert.doesNotMatch(serialized, /private\.invalid|curl -H|Authorization/);
    assert.doesNotMatch(serialized, /short-secret-value/);
    assert.match(serialized, /TypeError: tool reported an error \[details redacted\]/);
    assert.ok(result.weaknesses.length <= 10);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("PowerShell script text supplies the duration command head when command is absent", async () => {
  const projectDir = tempDir();
  const sessionDir = path.join(projectDir, "sessions");
  writeSession(sessionDir, projectDir, [
    toolEntry("powershell-run", "powershell", { script: "npm test -- --runInBand" }, NOW.getTime()),
    toolResult("powershell-run", "powershell", "completed", NOW.getTime() + 4200, { details: { durationMs: 4200 } }),
  ]);
  try {
    const result = await collectSignals({ projectDir, sessionDir, now: NOW });
    const duration = result.weaknesses.find((item) => item.kind === "slow-command");
    assert.equal(duration?.evidence[0]?.ref, "npm test");
    assert.match(duration?.summary ?? "", /4200 ms/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("no-log mode never inspects the session directory", async () => {
  const projectDir = tempDir();
  const sessionDir = path.join(projectDir, "sessions");
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, "sentinel.jsonl"), "must not be read");
  const originals = {
    readdirSync: fsMutable.readdirSync,
    statSync: fsMutable.statSync,
    lstatSync: fsMutable.lstatSync,
    readFileSync: fsMutable.readFileSync,
    openSync: fsMutable.openSync,
  };
  let touched = 0;
  const trap = (operation) => (...args) => {
    if (typeof args[0] === "string" && path.resolve(args[0]).startsWith(path.resolve(sessionDir))) {
      touched += 1;
      throw new Error(`${operation} touched session files`);
    }
    return originals[operation](...args);
  };
  for (const operation of Object.keys(originals)) fsMutable[operation] = trap(operation);
  syncBuiltinESMExports();
  assert.throws(() => fs.readdirSync(sessionDir), /touched session files/, "the filesystem trap observes the collector's named fs imports");
  assert.equal(touched, 1);
  touched = 0;
  try {
    const result = await collectSignals({ projectDir, sessionDir, includeLogs: false, now: NOW });
    assert.equal(touched, 0, "no-log mode performs no session enumeration, stat, open, or read");
    assert.equal(result.diagnostics.some((item) => /session/i.test(item)), false);
    assert.ok(result.weaknesses.length <= 10);
  } finally {
    for (const [operation, original] of Object.entries(originals)) fsMutable[operation] = original;
    syncBuiltinESMExports();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("session reads select the 30 newest recent files and skip oversized or unrelated sessions", async () => {
  const projectDir = tempDir();
  const otherProjectDir = tempDir();
  const sessionDir = path.join(projectDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  for (let index = 0; index < 31; index += 1) {
    const at = new Date(NOW.getTime() - index * 60_000);
    writeSession(sessionDir, projectDir, [
      toolEntry(`call-${index}`, "bash", { command: "npm test" }, at.getTime()),
      toolResult(`call-${index}`, "bash", "failure", at.getTime() + 10, { isError: true }),
    ], `session-${String(index).padStart(2, "0")}.jsonl`, at);
  }
  const outside = writeSession(sessionDir, otherProjectDir, [
    toolEntry("wrong", "bash", { command: "npm test" }, NOW.getTime() - 50_000),
    toolResult("wrong", "bash", "wrong cwd must not count", NOW.getTime() - 49_990, { isError: true }),
  ], "wrong-cwd.jsonl", new Date(NOW.getTime() - 50_000));
  const stale = writeSession(sessionDir, projectDir, [
    toolEntry("stale", "bash", { command: "npm test" }, NOW.getTime() - 31 * 86_400_000),
    toolResult("stale", "bash", "stale must not count", NOW.getTime() - 31 * 86_400_000 + 10, { isError: true }),
  ], "stale.jsonl", new Date(NOW.getTime() - 31 * 86_400_000));
  const oversized = path.join(sessionDir, "oversized.jsonl");
  const fd = fs.openSync(oversized, "w");
  fs.writeSync(fd, `${JSON.stringify({ type: "session", version: 3, id: "large", timestamp: NOW.toISOString(), cwd: projectDir })}\n`);
  fs.ftruncateSync(fd, 20 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  fs.utimesSync(oversized, NOW, NOW);

  const originals = { openSync: fsMutable.openSync };
  const opened = [];
  fsMutable.openSync = (file, ...args) => {
    if (typeof file === "string" && path.resolve(file).startsWith(path.resolve(sessionDir))) opened.push(path.basename(file));
    return originals.openSync(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    const result = await collectSignals({ projectDir, sessionDir, now: NOW });
    const failure = result.weaknesses.find((item) => item.kind === "session-failure" && item.evidence.some((evidence) => evidence.ref === "npm test"));
    assert.equal(failure?.evidence.find((evidence) => evidence.ref === "npm test")?.count, 29);
    assert.ok(result.diagnostics.some((item) => /skipped 2 .*oversized/i.test(item)), "the diagnostic includes the oversized metadata-filtered file and the selected wrong-cwd file");
    assert.equal(opened.length, 30);
    assert.ok(opened.includes("wrong-cwd.jsonl"), "the selected wrong-cwd file is opened only after directory and size bounds");
    assert.ok(!opened.includes("oversized.jsonl"));
    assert.ok(!opened.includes("stale.jsonl"));
    assert.ok(!opened.includes("session-30.jsonl"));
    assert.ok(result.weaknesses.length <= 10);
  } finally {
    fsMutable.openSync = originals.openSync;
    syncBuiltinESMExports();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(otherProjectDir, { recursive: true, force: true });
  }
});

test("post-failure edits begin after the failure result, not a parallel tool call", async () => {
  const projectDir = tempDir();
  const sessionDir = path.join(projectDir, "sessions");
  writeSession(sessionDir, projectDir, [
    toolEntry("failure", "bash", { command: "npm test" }, NOW.getTime()),
    toolEntry("parallel-edit", "edit", { path: "src/parallel.ts", edits: [] }, NOW.getTime() + 10),
    toolResult("failure", "bash", "failed", NOW.getTime() + 20, { isError: true }),
    toolResult("parallel-edit", "edit", "edited", NOW.getTime() + 30),
    toolEntry("after-edit", "edit", { path: "src/after.ts", edits: [] }, NOW.getTime() + 40),
    toolResult("after-edit", "edit", "edited", NOW.getTime() + 50),
  ]);
  try {
    const result = await collectSignals({ projectDir, sessionDir, now: NOW });
    const serialized = JSON.stringify(result);
    assert.match(serialized, /src\/after\.ts/);
    assert.doesNotMatch(serialized, /src\/parallel\.ts/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("git signals use the injected 90-day cutoff, classify subjects, and omit raw subjects and unsafe paths", async () => {
  const projectDir = tempDir();
  const runGit = async (...args) => execFileAsync("git", args, { cwd: projectDir, windowsHide: true });
  try {
    await runGit("init");
    await runGit("config", "user.email", "fixture@example.invalid");
    await runGit("config", "user.name", "Fixture");
    const commit = async (subject, file, daysAgo) => {
      fs.mkdirSync(path.dirname(path.join(projectDir, file)), { recursive: true });
      fs.writeFileSync(path.join(projectDir, file), subject);
      await runGit("add", "--", file);
      const date = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
      await execFileAsync("git", ["commit", "-m", subject], {
        cwd: projectDir,
        windowsHide: true,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    };
    await commit("fix outside window", "src/old.ts", 100);
    await commit("revert sk-live-private-commit-subject", "src/private-token-sk-live-private.ts", 30);
    await commit("fix parser timeout", "src/parser.ts", 20);

    const result = await collectSignals({ projectDir, includeLogs: false, focus: "parser timeout", now: NOW });
    const serialized = JSON.stringify(result);
    assert.match(serialized, /fix|timeout/);
    assert.doesNotMatch(serialized, /sk-live-private-commit-subject|src\/private-token-sk-live-private\.ts|fix outside window/);
    assert.ok(result.weaknesses.length <= 10);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("missing git is reported as unavailable and focus ranks matching evidence", async () => {
  const projectDir = tempDir();
  const oldPath = process.env.PATH;
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs", "bench:fast": "node bench.mjs", "deploy-secret": "node deploy.mjs" } }));
  try {
    process.env.PATH = "";
    const result = await collectSignals({ projectDir, includeLogs: false, focus: "performance", now: NOW });
    assert.ok(result.diagnostics.some((item) => /git/i.test(item)));
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /deploy-secret|node deploy\.mjs/);
    assert.ok(result.weaknesses.length <= 10);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("focus ranks evidence matches without exposing the matching source text", async () => {
  const projectDir = tempDir();
  const initGit = (...args) => execFileAsync("git", args, { cwd: projectDir, windowsHide: true });
  try {
    await initGit("init");
    await initGit("config", "user.email", "fixture@example.invalid");
    await initGit("config", "user.name", "Fixture");
    fs.mkdirSync(path.join(projectDir, "src"));
    fs.writeFileSync(path.join(projectDir, "src", "parser.ts"), "parser");
    await initGit("add", "--", "src/parser.ts");
    const date = NOW.toISOString();
    await execFileAsync("git", ["commit", "-m", "fix parser timeout PRIVATE-SUBJECT-TEXT"], {
      cwd: projectDir,
      windowsHide: true,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));
    const result = await collectSignals({ projectDir, includeLogs: false, focus: "timeout parser", now: NOW });
    assert.equal(result.weaknesses[0]?.kind, "git-hotspot");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SUBJECT-TEXT/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("campaign history emits fixed categories instead of stored free text", async () => {
  const projectDir = tempDir();
  const campaignDir = path.join(projectDir, ".dream-rsi", "campaigns", "one");
  fs.mkdirSync(path.join(campaignDir, "history"), { recursive: true });
  fs.writeFileSync(path.join(campaignDir, "campaign.json"), JSON.stringify({
    state: { kind: "failed", reason: "PRIVATE-CAMPAIGN-REASON sk-private-campaign-token" },
  }));
  fs.writeFileSync(path.join(campaignDir, "history", "rejections.jsonl"), JSON.stringify({
    stage: "review", reasons: ["PRIVATE-REJECTION-REASON sk-private-rejection-token"],
  }) + "\n");
  try {
    const result = await collectSignals({ projectDir, includeLogs: false, now: NOW });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /PRIVATE-CAMPAIGN-REASON|PRIVATE-REJECTION-REASON|sk-private-/);
    assert.ok(result.weaknesses.length <= 10);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("crowded signal collections retain recurring session failures ahead of readiness hints", async () => {
  const projectDir = tempDir();
  const sessionDir = path.join(projectDir, "sessions");
  writeSession(sessionDir, projectDir, [
    toolEntry("failure", "bash", { command: "npm test" }, NOW.getTime()),
    toolResult("failure", "bash", "failure", NOW.getTime() + 10, { isError: true }),
  ]);
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs", bench: "node bench.mjs", perf: "node perf.mjs" } }));
  const campaigns = path.join(projectDir, ".dream-rsi", "campaigns");
  const cases = ["timeout", "evaluator", "gate", "review", "agent", "baseline", "other"];
  for (const [index, reason] of cases.entries()) {
    const folder = path.join(campaigns, `campaign-${index}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "campaign.json"), JSON.stringify({
      state: { kind: "failed", reason },
    }));
  }
  const rejectDir = path.join(campaigns, "campaign-0", "history");
  fs.mkdirSync(rejectDir, { recursive: true });
  fs.writeFileSync(path.join(rejectDir, "rejections.jsonl"), ["metric", "gate", "review", "custom"].map((stage) => JSON.stringify({ stage })).join("\n"));
  try {
    const result = await collectSignals({ projectDir, sessionDir, now: NOW });
    assert.ok(result.weaknesses.some((item) => item.kind === "session-failure" && item.evidence.some((evidence) => evidence.ref === "npm test")));
    assert.equal(result.weaknesses[0]?.kind, "session-failure");
    assert.ok(result.weaknesses.length <= 10);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
