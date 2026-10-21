/** Agent runner behavior, scoring identity, and session isolation. */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXT, jump } from "./fixtures.mjs";

const { normalizeTask, scoringFingerprint, scoreMatchesDirection } = await jump("engine/task.ts");
const { buildAgentArgs, piSelfInvocation, runAgent, describeSpawnError, copyWorkspace } = await jump("agent/runner.ts");
const { OutputDecoder } = await jump("agent/output.ts");

test("pi JSON output decodes bounded usage and content-free tool evidence", () => {
  const events = [];
  const decoder = new OutputDecoder(true, (event) => events.push(event));
  decoder.feed("stdout", `${JSON.stringify({ type: "message_end", message: { model: "provider/model", stopReason: "length", usage: { input: 4, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 10 } } })}\n`);
  decoder.feed("stdout", `${JSON.stringify({ type: "tool_execution_start", toolName: "edit", args: { path: "private/file", content: "SECRET" } })}\n`);
  decoder.feed("stdout", `${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "verifier/private.ts" } })}\n`);
  decoder.finish();
  const usage = events.find((event) => event.kind === "usage");
  assert.deepEqual(usage.usage, { input: 4, output: 3, cacheRead: 2, cacheWrite: 1, total: 10 });
  assert.equal(usage.stopReason, "length");
  assert.equal(events.filter((event) => event.edit).length, 1);
  assert.equal(events.filter((event) => event.read).length, 1);
  assert.doesNotMatch(JSON.stringify(events), /SECRET|verifier\/private|private\/file/);
});

test("copyWorkspace refuses a destination that would delete the source root", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-copy-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "project");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "keep.txt"), "keep");
  await assert.rejects(copyWorkspace(source, root), /destination cannot be the source root or one of its ancestors/);
  assert.equal(fs.readFileSync(path.join(source, "keep.txt"), "utf8"), "keep");
});

test("verifier-read telemetry only matches explicitly protected paths", () => {
  const input = `${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/measure.ts" } })}\n`;
  const ordinary = [];
  new OutputDecoder(true, (event) => ordinary.push(event), { cwd: process.cwd() }).feed("stdout", input);
  assert.equal(ordinary[0]?.verifierRead, false);
  const protectedRead = [];
  new OutputDecoder(true, (event) => protectedRead.push(event), { cwd: process.cwd(), protectedReadPaths: [path.join(process.cwd(), "src/measure.ts")] }).feed("stdout", input);
  assert.equal(protectedRead[0]?.verifierRead, true);
  assert.doesNotMatch(JSON.stringify(protectedRead), /src\\measure|measure\.ts/);
});

test("runAgent writes a bounded decoded log without raw tool arguments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-agent-compact-log-"));
  try {
    const script = path.join(dir, "emit.mjs");
    const logPath = path.join(dir, "agent.log");
    fs.writeFileSync(script, `console.log(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"${"x".repeat(60_000)}"}}));\nconsole.log(JSON.stringify({type:"tool_execution_start",toolName:"read",args:{path:"private/verifier-secret.md"}}));\n`);
    const protectedPath = path.join(dir, "private", "verifier-secret.md");
    const result = await runAgent({
      agent: { command: process.execPath, args: [script, "--mode=json"], output_format: "pi-json", prompt_via: "stdin" },
      cwd: dir, prompt: "emit telemetry", timeoutMs: 10_000, logPath, protectedReadPaths: [protectedPath],
    });
    assert.equal(result.ok, true, result.stderrTail);
    const log = fs.readFileSync(logPath);
    assert.ok(log.byteLength <= 50 * 1024);
    assert.ok(log.toString("utf8").includes("x"));
    assert.doesNotMatch(log.toString("utf8"), /verifier-secret|private/);
    assert.equal(result.evidence?.verifierRead, true);
    const ordinary = await runAgent({
      agent: { command: process.execPath, args: [script, "--mode=json"], output_format: "pi-json", prompt_via: "stdin" },
      cwd: dir, prompt: "emit telemetry", timeoutMs: 10_000, logPath: path.join(dir, "ordinary.log"),
    });
    assert.equal(ordinary.evidence?.verifierRead, false, "ordinary reads are not inferred to be verifier reads");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the configured model is actually passed to attempts", () => {
  const base = { command: "pi", args: ["-p", "--no-session"], model: null, thinking: null, prompt_via: "stdin", output_format: "text" };
  assert.deepEqual(buildAgentArgs(base), ["-p", "--no-session"], "no model, no flag");
  assert.deepEqual(buildAgentArgs({ ...base, model: "opencode-go/deepseek-v4.1-flash" }), [
    "-p",
    "--no-session",
    "--model",
    "opencode-go/deepseek-v4.1-flash",
  ], "a configured model is appended when the args carry no placeholder");
  assert.deepEqual(buildAgentArgs({ ...base, args: ["-p", "--model", "{model}"], model: "x/y" }), ["-p", "--model", "x/y"], "placeholder wins");
  assert.deepEqual(buildAgentArgs({ ...base, args: ["-p"], model: null }), ["-p"]);
});

test("the session thinking level is passed to attempts", () => {
  const base = { command: "pi", args: ["-p", "--no-session"], model: null, thinking: null, prompt_via: "stdin", output_format: "text" };
  assert.deepEqual(buildAgentArgs({ ...base, thinking: "high" }), ["-p", "--no-session", "--thinking", "high"]);
  assert.deepEqual(
    buildAgentArgs({ ...base, args: ["-p", "--thinking={thinking}"], thinking: "low" }),
    ["-p", "--thinking=low"],
    "placeholder wins",
  );
  assert.deepEqual(
    buildAgentArgs({ ...base, args: ["-p", "--thinking", "max"], thinking: "low" }),
    ["-p", "--thinking", "max"],
    "saved explicit arguments keep their existing behavior without a resolver",
  );
  assert.deepEqual(buildAgentArgs({ ...base, model: "x/y", thinking: "high" }), [
    "-p",
    "--no-session",
    "--model",
    "x/y",
    "--thinking",
    "high",
  ], "model and thinking travel together");
});

test("resolved session values replace stale explicit flags without changing custom arguments", () => {
  const agent = {
    command: "custom-agent",
    args: ["run", "--model", "old/model", "--thinking=low", "--workspace", "source"],
    model: "new/model",
    thinking: "high",
  };
  assert.deepEqual(buildAgentArgs(agent, { overrideExplicit: true }), ["run", "--model", "new/model", "--thinking=high", "--workspace", "source"]);
});

test("a null session resolver preserves the saved custom CLI flags", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-agent-resolver-null-"));
  try {
    const script = path.join(dir, "capture.mjs");
    const output = path.join(dir, "args.json");
    fs.writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`);
    const saved = { command: "node", args: [script, "--model", "literal/model", "--thinking", "max"], model: "saved/model", thinking: "low", prompt_via: "stdin" };
    const result = await runAgent({ agent: saved, resolveAgent: () => null, cwd: dir, prompt: "capture", timeoutMs: 10_000 });
    assert.equal(result.ok, true, result.spawnError ?? result.stderrTail);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), ["--model", "literal/model", "--thinking", "max", "--model", "saved/model"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runAgent quotes an executable path containing spaces on Windows shell invocation", {
  skip: process.platform !== "win32" ? "Windows shell quoting only" : !process.execPath.includes(" ") ? "Node executable path has no spaces" : false,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-agent-executable-space-"));
  try {
    const script = path.join(dir, "capture.mjs");
    const output = path.join(dir, "ran.txt");
    fs.writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(output)}, "ok");\n`);
    const result = await runAgent({
      agent: { command: process.execPath, args: [script], model: null, thinking: null, prompt_via: "stdin" },
      cwd: dir,
      prompt: "run",
      timeoutMs: 10_000,
    });
    assert.equal(result.ok, true, result.spawnError ?? result.stderrTail);
    assert.equal(fs.readFileSync(output, "utf8"), "ok");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runAgent resolves session configuration separately at each call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-agent-resolver-"));
  try {
    const script = path.join(dir, "capture.mjs");
    const output = path.join(dir, "args.jsonl");
    fs.writeFileSync(script, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
    const saved = { command: "node", args: [script, "--model", "old/model", "--thinking", "low", "--custom", "kept"], model: "old/model", thinking: "low", prompt_via: "stdin" };
    let session = { model: "session/first", thinking: "medium" };
    const resolveAgent = (configured) => ({ ...configured, model: session.model, thinking: session.thinking });
    for (let i = 0; i < 2; i += 1) {
      const result = await runAgent({ agent: saved, resolveAgent, cwd: dir, prompt: "capture", timeoutMs: 10_000 });
      assert.equal(result.ok, true, result.spawnError ?? result.stderrTail);
      session = { model: "session/second", thinking: "high" };
    }
    const calls = fs.readFileSync(output, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
      ["--model", "session/first", "--thinking", "medium", "--custom", "kept"],
      ["--model", "session/second", "--thinking", "high", "--custom", "kept"],
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the default pi agent re-spawns the running pi instead of trusting PATH", () => {
  const argv1 = "/opt/pi/dist/bundle/cli.js";
  const exists = (candidate) => candidate === argv1;
  assert.deepEqual(
    piSelfInvocation({ insidePi: true, argv1, execPath: "/usr/bin/node", exists }),
    { command: "/usr/bin/node", args: [argv1] },
    "node + the running cli.js is PATH-independent",
  );
  assert.equal(
    piSelfInvocation({ insidePi: false, argv1, execPath: "/usr/bin/node", exists }),
    null,
    "outside pi (SDK host, tests) the caller falls back to `pi`",
  );
  assert.deepEqual(
    piSelfInvocation({ insidePi: true, argv1: "/$bunfs/root/cli.js", execPath: "/usr/local/bin/pi", exists: () => true }),
    { command: "/usr/local/bin/pi", args: [] },
    "a bun virtual script is not a real path; the compiled binary is re-run directly",
  );
  assert.equal(
    piSelfInvocation({ insidePi: true, argv1: "/no/such/cli.js", execPath: "/usr/bin/node", exists: () => false }),
    null,
    "generic runtime with no real script falls back to `pi`",
  );
});

test("only a real pi entry point is re-spawned, never the host process that inherited pi's markers", () => {
  // pi sets PI_CODING_AGENT/AI_AGENT on its CLI and RPC entries and every child inherits them, so a host
  // app that embeds pi (or anything launched from inside pi) is `insidePi` while argv1 is its own entry.
  // Re-running that argv1 spawns the host as the "agent": it writes nothing, and the attempt dies 30
  // minutes later as a silent `timeout` with an empty agent.log.
  const exists = () => true;
  for (const host of ["/srv/pi-web/server.js", "/opt/web/sessiond.mjs", "/app/index.cjs", "/app/worker.ts"]) {
    assert.equal(
      piSelfInvocation({ insidePi: true, argv1: host, execPath: "/usr/bin/node", exists }),
      null,
      `${host} is not pi, so it must not be spawned as the discovery agent`,
    );
  }
  for (const entry of [
    "/opt/pi/dist/cli.js",
    "/opt/pi/dist/bundle/cli.js",
    "/opt/pi/dist/bundle/cli-runtime.js",
    "/src/cli.ts",
  ]) {
    assert.deepEqual(
      piSelfInvocation({ insidePi: true, argv1: entry, execPath: "/usr/bin/node", exists }),
      { command: "/usr/bin/node", args: [entry] },
      `${entry} is pi's own entry point`,
    );
  }
});

test("rpc-entry re-spawns as its sibling CLI, never as an RPC server that ignores -p", () => {
  // rpc-entry.js hardcodes `--mode rpc`, which wins over our `-p`: spawned as the agent it waits
  // for JSON-RPC frames, writes nothing, and burns the attempt as a silent timeout with an empty log.
  // Paths go through path.join, so build expectations with the platform's separators.
  const distDir = path.dirname("/opt/pi/dist/rpc-entry.js");
  const siblingCli = path.join(distDir, "cli.js");
  const rpcEntry = path.join(distDir, "rpc-entry.js");
  const realDist = (candidate) => candidate === siblingCli || candidate === rpcEntry;
  assert.deepEqual(
    piSelfInvocation({ insidePi: true, argv1: rpcEntry, execPath: "/usr/bin/node", exists: realDist }),
    { command: "/usr/bin/node", args: [siblingCli] },
    "the CLI entry beside rpc-entry runs print mode",
  );
  // No sibling CLI on disk: fall back to PATH resolution instead of spawning an RPC server.
  assert.equal(
    piSelfInvocation({ insidePi: true, argv1: rpcEntry, execPath: "/usr/bin/node", exists: (c) => c === rpcEntry }),
    null,
    "without a sibling CLI the caller falls back to `pi` rather than spawning rpc mode",
  );
});

test("a missing agent CLI reports the command and the fix instead of a bare ENOENT", async () => {
  const enoent = Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" });
  assert.match(describeSpawnError(enoent, true), /spawn pi ENOENT/);
  assert.doesNotMatch(describeSpawnError(enoent, true), /agent\.command/, "a shell already named the command");
  assert.match(describeSpawnError(enoent, false), /spawn pi ENOENT/);
  assert.match(describeSpawnError(enoent, false), /agent\.command/, "a shell-free miss says how to pin the CLI");
  const other = Object.assign(new Error("spawn pi EPERM"), { code: "EPERM" });
  assert.equal(describeSpawnError(other, false), "spawn pi EPERM", "only a miss gets the hint");

  // POSIX-only wiring check: a custom command spawns without a shell there, so a missing CLI raises ENOENT.
  if (process.platform === "win32") return;
  const result = await runAgent({
    agent: { command: "/nonexistent/dream-rsi-agent", args: [], prompt_via: "stdin" },
    cwd: os.tmpdir(),
    prompt: "propose something",
    timeoutMs: 10_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false, "a missing CLI fails immediately, it must not look like a hang");
  assert.match(result.spawnError, /agent\.command/);
});

test("the scoring fingerprint follows the contract, not the budgets", () => {
  const base = normalizeTask({ name: "t", workspace: "seed", eval_program: "prog.py", score_program: "node s.mjs", higher_is_better: true });
  const migrated = normalizeTask({ ...base, workers: 8, k1: 2, revisions: 5, default_beta: 0.2, max_loops: 4 });
  assert.equal(scoringFingerprint(base), scoringFingerprint(migrated), "legacy fields do not invalidate recorded scores");
  for (const field of ["workers", "max_loops", "k1", "k2", "revisions", "beta1", "beta2", "beta_grid", "default_beta", "work_retention"]) {
    assert.equal(field in migrated, false, field);
  }
  assert.notEqual(scoringFingerprint(base), scoringFingerprint(normalizeTask({ ...base, higher_is_better: false })));
  assert.notEqual(scoringFingerprint(base), scoringFingerprint(normalizeTask({ ...base, score_program: "node other.mjs" })));
  assert.notEqual(scoringFingerprint(base), scoringFingerprint(normalizeTask({ ...base, workspace: "seed2" })));
});

test("a stored score that contradicts the current direction is recognized", () => {
  const higher = normalizeTask({ name: "t", workspace: "seed", eval_program: "prog.py", score_program: "node s.mjs", higher_is_better: true });
  const lower = normalizeTask({ ...higher, higher_is_better: false });
  assert.equal(scoreMatchesDirection(higher, 79, 79), true);
  assert.equal(scoreMatchesDirection(higher, -79, 79), false);
  assert.equal(scoreMatchesDirection(lower, -79, 79), true);
  // The bug report's mix: an old +79 candidate and new -54 candidates cannot both be "best".
  assert.equal(scoreMatchesDirection(lower, 79, 79), false);
  assert.equal(scoreMatchesDirection(lower, -54, 54), true);
  assert.equal(scoreMatchesDirection(lower, -79, null), true, "an unknown raw score cannot be judged");
});

test("a spawned agent does not inherit the host session identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-env-"));
  const script = path.join(dir, "env-probe.mjs");
  fs.writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync("env.json", JSON.stringify({\n` +
      `  sid: process.env.PI_SESSION_ID ?? null,\n` +
      `  file: process.env.PI_SESSION_FILE ?? null,\n` +
      `  web: process.env.PI_WEB_SESSION ?? null,\n` +
      `  keep: process.env.DREAM_TEST_KEEP ?? null,\n` +
      `}));\n`,
    "utf8",
  );
  const sessionVars = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_WEB_SESSION"];
  const saved = new Map(sessionVars.map((key) => [key, process.env[key]]));
  process.env.PI_SESSION_ID = "parent-session";
  process.env.PI_SESSION_FILE = "/tmp/parent-session.jsonl";
  process.env.PI_WEB_SESSION = "1";
  const agent = { command: "node", args: [script], model: null, thinking: null, prompt_via: "stdin" };
  try {
    const first = await runAgent({ agent, cwd: dir, prompt: "hello", timeoutMs: 10_000 });
    assert.equal(first.ok, true, first.spawnError ?? first.stderrTail);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8")), {
      sid: null,
      file: null,
      web: null,
      keep: null,
    });

    // A task that genuinely needs one can put it back via `agent.env` (task.json's documented escape hatch).
    const withEnv = { ...agent, env: { PI_SESSION_FILE: "explicit" } };
    const second = await runAgent({ agent: withEnv, cwd: dir, prompt: "hello", timeoutMs: 10_000 });
    assert.equal(second.ok, true, second.spawnError ?? second.stderrTail);
    const seen = JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8"));
    assert.equal(seen.file, "explicit");
    assert.equal(seen.sid, null, "stripping is per variable");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
