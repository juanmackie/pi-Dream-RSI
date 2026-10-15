import { visibleWidth } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jump, makeProject, deployShippedPolicy, writeTaskJson, mockPi } from "./fixtures.mjs";
const { runLiveEpisode } = await jump("engine/live.ts");
const { readCheckpoint, saveCheckpoint, recoverableIterations, checkpointPath } = await jump("engine/checkpoint.ts");
const { readProgress, ProgressRecorder } = await jump("engine/progress.ts");
const { liveMethodPath, readTree, pruneWorkspaces, nodeWorkspace } = await jump("engine/world.ts");
const { OutputDecoder, BoundedTail } = await jump("agent/output.ts");
const { runAgent, copyWorkspace, buildAgentArgs } = await jump("agent/runner.ts");
const { defaultTask, normalizeTask } = await jump("engine/task.ts");
const { Dashboard, DashboardView, readLogPage } = await jump("dashboard.ts");

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, tries = 500, stage = "requested stage") { for (let i = 0; i < tries; i++) { if (predicate()) return; await pause(20); } throw new Error(`fixture never reached ${stage}`); }
const options = (p, extra = {}) => ({ dreamRoot: p.dreamRoot, projectDir: p.projectDir, task: p.task,
  iteration: 1, policyPath: liveMethodPath(p.dreamRoot), bakedBeta: .6,
  grid: { branch_count: 2, refine_count: 2 }, baselineScore: null, ...extra });
async function setup(p) { await writeTaskJson(p); await deployShippedPolicy(p); }
const records = (tree) => tree.list().map(({ meta, score, raw_score, evaluated, valid, fail_class, error }) => ({ meta, score, raw_score, evaluated, valid, fail_class, error }));
function controlledAgent(p) {
  const counts = path.join(p.projectDir, "calls.jsonl"); const gate = path.join(p.projectDir, "allow");
  const file = path.join(p.projectDir, "controlled.mjs");
  fs.writeFileSync(file, `import * as fs from 'node:fs'; import * as path from 'node:path';
let prompt=''; process.stdin.on('data', d=>prompt+=d); process.stdin.on('end',()=>{
const cell=path.basename(process.cwd()); fs.appendFileSync(${JSON.stringify(counts)},cell+'\\n');
const finish=()=>{const depth=(fs.readFileSync('solution.py','utf8').match(/x/g)??[]).length;
fs.appendFileSync('solution.py','x'.repeat(1+depth%3)+'\\n');fs.writeFileSync('proposal.md','# proposal');};
if(cell==='b1a0'&&!fs.existsSync(${JSON.stringify(gate)})){const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);finish();}},20);}else finish(); });`);
  p.task.agent = { command: "node", args: [file], model: null, prompt_via: "stdin" };
  return { counts, gate, calls: () => fs.existsSync(counts) ? fs.readFileSync(counts, "utf8").trim().split("\n") : [] };
}

test("pi JSONL decoding handles chunk boundaries, tool events and malformed raw lines", () => {
  const events = []; const decoder = new OutputDecoder(true, (e) => events.push(e));
  const lines = [JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hé🙂" } }),
    JSON.stringify({ type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: { command: "echo ok" } }),
    JSON.stringify({ type: "tool_execution_update", toolCallId: "x", partialResult: { content: [{ text: "ok" }] } }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "x", result: { content: [] } }), "plain fallback", "{bad"].join("\n");
  for (const char of lines) decoder.feed("stdout", char); decoder.finish();
  assert.equal(events[0].text, "hé🙂"); assert.deepEqual(events.slice(1, 4).map((e) => e.kind), ["tool-start", "tool-update", "tool-end"]);
  assert.match(events.at(-1).text, /bad/);
  const tail = new BoundedTail(); for (let i = 0; i < 1000; i++) tail.append("🙂".repeat(500) + "\n");
  assert.ok(Buffer.byteLength(tail.text) <= 65536); assert.ok(tail.text.split("\n").length <= 200);
  const mode = defaultTask().agent;
  assert.deepEqual(buildAgentArgs({ ...mode, args: ["--mode", "text"] }), ["--mode", "text"]);
  assert.ok(buildAgentArgs(mode).includes("json")); assert.equal(buildAgentArgs({ ...mode, output_format: "text" }).includes("json"), false);
});

test("runner preserves UTF-8 across byte chunks and observer errors cannot fail a child", async () => {
  const p = makeProject(); try {
    const script = p.script("utf8.mjs"); fs.writeFileSync(script, `const b=Buffer.from('hé🙂\\n');for(const byte of b)process.stdout.write(Buffer.from([byte]));`);
    const events = [];
    const result = await runAgent({ agent: { command: "node", args: [script], model: null, thinking: null, prompt_via: "stdin" },
      cwd: p.seed, prompt: "", timeoutMs: 5000, logPath: p.script("unicode.log"), onOutput: (e) => { events.push(e); throw new Error("observer"); } });
    assert.equal(result.ok, true); assert.equal(events.map((e) => e.text).join(""), "hé🙂\n");
    assert.equal(fs.readFileSync(p.script("unicode.log"), "utf8"), "hé🙂\n");
  } finally { p.cleanup(); }
});

test("nested workspace copies do not exhaust recursive limiter permits", async () => {
  const p = makeProject(); try {
    for (let i = 0; i < 12; i++) { fs.mkdirSync(path.join(p.seed, `d${i}`, "nested"), { recursive: true }); fs.writeFileSync(path.join(p.seed, `d${i}`, "nested", "a"), "x"); }
    await Promise.race([copyWorkspace(p.seed, p.script("copied")), pause(5000).then(() => { throw new Error("copy deadlocked"); })]);
    assert.equal(fs.readFileSync(p.script("copied/d11/nested/a"), "utf8"), "x");
  } finally { p.cleanup(); }
});

test("resume reconstructs private policy state, keeps completed siblings, and uses the frozen seed", async () => {
  const p = makeProject({ task: { k1: 2 } }); const reference = makeProject({ task: { k1: 2 } });
  try {
    const controlled = controlledAgent(p); await setup(p); await setup(reference);
    const abort = new AbortController();
    const run = runLiveEpisode(options(p, { signal: abort.signal }));
    await until(() => { try { return readCheckpoint(p.dreamRoot, 1).batches[0]?.attempts.some((a) => a.record) && controlled.calls().length === 2; } catch { return false; } });
    abort.abort(); const interrupted = await run;
    assert.equal(interrupted.manifest.status, "interrupted"); assert.equal(readTree(p.dreamRoot, 1), null);
    assert.deepEqual(recoverableIterations(p.dreamRoot), [1]);
    assert.equal(readCheckpoint(p.dreamRoot, 1).batches[0].attempts.filter((a) => a.record).length, 1);
    fs.writeFileSync(path.join(p.seed, "solution.py"), "BROKEN xxxxxxxxx");
    fs.writeFileSync(controlled.gate, "yes");
    const resumed = await runLiveEpisode(options(p, { resume: true }));
    const full = await runLiveEpisode(options(reference));
    assert.equal(resumed.ok, true, resumed.error); assert.deepEqual(records(resumed.tree), records(full.tree));
    assert.deepEqual(readCheckpoint(p.dreamRoot, 1).final.trace, readCheckpoint(reference.dreamRoot, 1).final.trace);
    assert.equal(controlled.calls().filter((c) => c === "b0a0").length, 1, "completed sibling must not run again");
    assert.equal(controlled.calls().filter((c) => c === "b1a0").length, 2, "unfinished generator restarts under its original cell id");
    assert.equal(readCheckpoint(p.dreamRoot, 1).extra_agent_calls, 1);
    assert.ok(fs.existsSync(p.script(".dream-rsi/history/r0001_live/attempt_b1a0/retry_1/workspace")));
    assert.deepEqual(recoverableIterations(p.dreamRoot), []);
  } finally { p.cleanup(); reference.cleanup(); }
});

test("generation completion survives an interrupted evaluator without another agent call", async () => {
  const p = makeProject({ task: { k1: 1, workers: 1 } });
  try {
    const controlled = controlledAgent(p); fs.writeFileSync(controlled.gate, "yes");
    const scored = p.script("eval-calls"); const gate = p.script("eval-allow"); const scorer = p.script("controlled-score.mjs");
    fs.writeFileSync(scorer, `import * as fs from 'node:fs';fs.appendFileSync(${JSON.stringify(scored)},'call\\n');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);fs.mkdirSync('eval',{recursive:true});fs.writeFileSync('eval/score.json',JSON.stringify({score:1,valid:true}));}},20);`);
    p.task.score_program = `node "${scorer}"`; await setup(p);
    const abort = new AbortController(); const run = runLiveEpisode(options(p, { grid: { branch_count: 1, refine_count: 1 }, signal: abort.signal }));
    await until(() => fs.existsSync(scored)); abort.abort(); await run;
    const saved = readCheckpoint(p.dreamRoot, 1); assert.equal(saved.batches[0].attempts[0].stage, "evaluation");
    const originalModel = saved.task.agent.model;
    fs.writeFileSync(gate, "yes"); p.task.agent.model = "changed/model"; p.task.k1 = 99;
    const resumed = await runLiveEpisode(options(p, { resume: true })); assert.equal(resumed.ok, true, resumed.error);
    assert.equal(controlled.calls().length, 1); assert.equal(readCheckpoint(p.dreamRoot, 1).task.agent.model, originalModel);
    assert.equal(readCheckpoint(p.dreamRoot, 1).extra_eval_calls, 1);
    assert.equal(readCheckpoint(p.dreamRoot, 1).task.k1, 1);
  } finally { p.cleanup(); }
});

test("zero-batch checkpoint resumes and corrupted contracts/requests spend zero extra calls", async () => {
  const p = makeProject({ task: { k1: 1 } }); try {
    const controlled = controlledAgent(p); await setup(p);
    const abort = new AbortController(); const stopped = await runLiveEpisode(options(p, { signal: abort.signal,
      onProgress: (s) => { if (s.tree && Object.keys(s.attempts).length === 0) abort.abort(); } }));
    assert.equal(stopped.ok, false); const cp = readCheckpoint(p.dreamRoot, 1); assert.equal(cp.batches.length, 0);
    p.task.score_program += " changed";
    await assert.rejects(runLiveEpisode(options(p, { resume: true })), /contract changed/); assert.equal(controlled.calls().length, 0);
    p.task.score_program = cp.task.score_program; fs.writeFileSync(controlled.gate, "yes");
    const resumed = await runLiveEpisode(options(p, { resume: true })); assert.equal(resumed.ok, true, resumed.error);
  } finally { p.cleanup(); }
});

test("divergent saved batch order fails preflight without running agents", async () => {
  const p = makeProject({ task: { k1: 1 } }); try {
    const controlled = controlledAgent(p); await setup(p); const abort = new AbortController();
    const run = runLiveEpisode(options(p, { signal: abort.signal }));
    await until(() => controlled.calls().length === 2); abort.abort(); await run;
    const cp = readCheckpoint(p.dreamRoot, 1); cp.batches[0].cells.reverse(); saveCheckpoint(p.dreamRoot, cp);
    const before = controlled.calls().length;
    await assert.rejects(runLiveEpisode(options(p, { resume: true })), /diverged/); assert.equal(controlled.calls().length, before);
    fs.appendFileSync(checkpointPath(p.dreamRoot, 1), "x");
    await assert.rejects(runLiveEpisode(options(p, { resume: true })), /JSON|Unexpected/);
  } finally { p.cleanup(); }
});

test("one live owner blocks duplicate resume and retention protects recoverable snapshots", async () => {
  const p = makeProject({ task: { k1: 1 } }); try {
    const controlled = controlledAgent(p); await setup(p); const abort = new AbortController();
    const run = runLiveEpisode(options(p, { signal: abort.signal })); await until(() => controlled.calls().length === 2);
    await assert.rejects(runLiveEpisode(options(p, { resume: true })), /active run/);
    abort.abort(); await run;
    fs.mkdirSync(path.dirname(nodeWorkspace(p.dreamRoot, 9, "x")), { recursive: true });
    assert.equal(pruneWorkspaces(p.dreamRoot, 1, 9).includes(1), false); assert.ok(fs.existsSync(readCheckpoint(p.dreamRoot, 1).seed));
  } finally { p.cleanup(); }
});

test("telemetry is bounded, throttled, scoped by iteration, and final events are immediate", () => {
  const p = makeProject(); try {
    const observed = []; const a = new ProgressRecorder(p.dreamRoot, 1, "live", 2, 2, (s) => observed.push(s.activity));
    const b = new ProgressRecorder(p.dreamRoot, 2, "live", 2, 2);
    a.stage("b0a0", "root", 1, "agent"); b.stage("b0a0", "root", 1, "evaluation");
    for (let i = 0; i < 1000; i++) a.output("b0a0", false, { stream: "stdout", kind: "text", text: "x".repeat(200) + "\n" });
    assert.ok(observed.length <= 2); assert.equal(b.snapshot.attempts.b0a0.agent_tail, "");
    a.finish("complete"); assert.equal(readProgress(p.dreamRoot, 1).status, "complete");
    assert.ok(Buffer.byteLength(a.snapshot.attempts.b0a0.agent_tail) <= 65536);
  } finally { p.cleanup(); }
});

test("dashboard tree navigation, bounded historical log reads, headless modes and overlay cleanup", async () => {
  const p = makeProject(); try {
    await setup(p);
    const recorder = new ProgressRecorder(p.dreamRoot, 1, "live", 2, 2);
    recorder.stage("b0a0", "root", 1, "agent"); recorder.stage("b1a0", "root", 1, "evaluation"); recorder.finish("interrupted");
    const log = p.script("big.log"); fs.writeFileSync(log, "entry\n".repeat(100000));
    const last = readLogPage(log); assert.ok(Buffer.byteLength(last.text) <= 65536); assert.ok(last.start > 0);
    const older = readLogPage(log, last.start); assert.ok(older.start < last.start);
    const view = new DashboardView(p.dreamRoot); assert.equal(view.iteration, 1);
    view.handleInput("\x1b[B"); assert.equal(view.nodeIndex, 1); view.handleInput("\t"); assert.equal(view.pane, 1);
    assert.ok(view.render(40).every((line) => visibleWidth(line) <= 40));
    for (const mode of ["print", "json", "rpc"]) {
      const { context, harness } = mockPi(); context.mode = mode; const dashboard = new Dashboard(context);
      dashboard.observe(recorder.snapshot); await dashboard.watch(p.dreamRoot);
      assert.equal(harness.widgets.length, 0); assert.equal(harness.customViews.length, 0); dashboard.dispose();
    }
    const { context, harness } = mockPi(); context.mode = "tui"; const dashboard = new Dashboard(context);
    const watching = dashboard.watch(p.dreamRoot); assert.equal(harness.customViews.length, 1);
    harness.customViews[0].view.handleInput("\x1b"); await watching; dashboard.dispose();
    const watching2 = dashboard.watch(p.dreamRoot); dashboard.dispose(); await watching2;
    assert.equal(fs.existsSync(checkpointPath(p.dreamRoot, 1)), false);
  } finally { p.cleanup(); }
});

test("a crash during publication is repaired idempotently without repeating completed work", async () => {
  const p = makeProject({ task: { k1: 1 } }); try {
    const controlled = controlledAgent(p); fs.writeFileSync(controlled.gate, "yes"); await setup(p);
    const blocked = p.script(".dream-rsi/history/r0001_live/tree.json");
    await assert.rejects(runLiveEpisode(options(p, { onProgress: (s) => {
      if (s.completed) fs.mkdirSync(blocked, { recursive: true });
    } })), /EISDIR|directory/);
    assert.equal(readCheckpoint(p.dreamRoot, 1).status, "complete");
    assert.deepEqual(recoverableIterations(p.dreamRoot), [1]);
    const count = controlled.calls().length;
    fs.mkdirSync(path.dirname(nodeWorkspace(p.dreamRoot, 9, "x")), { recursive: true });
    assert.equal(pruneWorkspaces(p.dreamRoot, 1, 9).includes(1), false, "incomplete publication is still recoverable");
    fs.rmSync(blocked, { recursive: true });
    const recovered = await runLiveEpisode(options(p, { resume: true }));
    assert.equal(recovered.ok, true, recovered.error); assert.equal(controlled.calls().length, count);
    assert.ok(readTree(p.dreamRoot, 1)); assert.deepEqual(recoverableIterations(p.dreamRoot), []);
  } finally { p.cleanup(); }
});

test("phase ownership blocks new live work during dream", async () => {
  const { allocator, acquirePhase } = await jump("engine/ownership.ts");
  const p = makeProject(); try {
    await setup(p);
    const release = allocator(p.dreamRoot, () => acquirePhase(p.dreamRoot, "dream"));
    try {
      await assert.rejects(runLiveEpisode(options(p, { iteration: 1 })), /dream phase/);
    } finally { release(); }
  } finally { p.cleanup(); }
});

test("missing parent snapshots and edited frozen helpers fail before resumed calls", async () => {
  const p = makeProject({ task: { k1: 1 } }); try {
    const controlled = controlledAgent(p); await setup(p); const abort = new AbortController();
    const live = runLiveEpisode(options(p, { signal: abort.signal }));
    await until(() => { try { return readCheckpoint(p.dreamRoot, 1).batches[0]?.attempts.some((a) => a.record) && controlled.calls().length === 2; } catch { return false; } });
    abort.abort(); await live;
    const saved = readCheckpoint(p.dreamRoot, 1); const entry = saved.policy;
    const source = fs.readFileSync(entry, "utf8"); fs.appendFileSync(entry, "\n// edited helper closure");
    const count = controlled.calls().length;
    await assert.rejects(runLiveEpisode(options(p, { resume: true })), /frozen policy changed/); assert.equal(controlled.calls().length, count);
    fs.writeFileSync(entry, source);
    fs.rmSync(nodeWorkspace(p.dreamRoot, 1, "b0a0"), { recursive: true });
    await assert.rejects(runLiveEpisode(options(p, { resume: true })), /ENOENT|saved workspace/); assert.equal(controlled.calls().length, count);
  } finally { p.cleanup(); }
});

test("a forcibly killed host recovers completed work and stops its matching orphan child", async () => {
  const { spawn } = await import("node:child_process"); const { once } = await import("node:events");
  const { pathToFileURL } = await import("node:url"); const { childIdentity, stopRecoveredChild } = await jump("agent/runner.ts");
  const p = makeProject({ task: { k1: 1 } }); let child; let orphan; let restoring;
  const recovery = new AbortController();
  try {
    const controlled = controlledAgent(p); await setup(p);
    const script = p.script("crash-host.mjs");
    const liveUrl = pathToFileURL(path.resolve("extensions/pi-dream-rsi/engine/live.ts")).href;
    fs.writeFileSync(script, `import { runLiveEpisode } from ${JSON.stringify(liveUrl)};const options=JSON.parse(process.argv[2]);const result=await runLiveEpisode({...options,owner:{pid:process.pid,session_id:'crash-host',claimed_at:new Date().toISOString()}});if(!result.ok){console.error("crash-host live episode ended not-ok: "+(result.error ?? "unknown"));process.exit(2);}`);
    child = spawn(process.execPath, [script, JSON.stringify(options(p))], { stdio: ["ignore", "pipe", "pipe"] });
    let hostOutput = "";
    child.stdout?.on("data", (d) => { hostOutput += String(d); });
    child.stderr?.on("data", (d) => { hostOutput += String(d); });
    let hostExit = null;
    child.on("exit", (code, signal) => { hostExit = { code, signal }; });
    // A full child host importing the TS engine is slow to boot, and the suite runs files in
    // parallel: 10s is marginal under load (the recorded flake), so allow 120s here. Fail fast
    // when the host exits before publishing the expected checkpoint, surfacing its output.
    const deadline = Date.now() + 120_000;
    let lastState = "no checkpoint yet";
    for (;;) {
      let ready = false;
      try {
        const cp = readCheckpoint(p.dreamRoot, 1);
        const batch = cp.batches[0];
        lastState = `batches=${cp.batches.length} attempts=${batch?.attempts.map((a) => `${a.cell}:${a.record ? "record" : a.stage}${a.process ? "+proc" : ""}`).join(",") ?? "none"} calls=${controlled.calls().join(",")}`;
        ready = Boolean(batch?.attempts.some((a) => a.record) && batch.attempts[1]?.process);
      } catch (error) { lastState = `checkpoint unreadable: ${String(error).slice(0, 200)} calls=${controlled.calls().join(",")}`; }
      if (ready) break;
      if (hostExit) throw new Error(`crash-host exited early code=${hostExit.code} signal=${hostExit.signal} state=${lastState} output=${hostOutput.slice(-2000)}`);
      if (Date.now() > deadline) throw new Error(`fixture never reached live host with one record and an in-flight child (state=${lastState} hostExit=${JSON.stringify(hostExit)} output=${hostOutput.slice(-2000)})`);
      await pause(20);
    }
    orphan = readCheckpoint(p.dreamRoot, 1).batches[0].attempts[1].process;
    if (child.exitCode === null && child.signalCode === null && !hostExit) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    } else try { child.kill("SIGKILL"); } catch { /* already gone */ }
    const owned = [orphan, ...(orphan.children ?? [])];
    assert.ok(owned.some((process) => process.identity && childIdentity(process.pid) === process.identity));
    restoring = runLiveEpisode(options(p, { resume: true, signal: recovery.signal }));
    await until(() => controlled.calls().filter((c) => c === "b1a0").length === 2, 3000, "restarted b1a0 attempt");
    fs.writeFileSync(controlled.gate, "yes");
    const resumed = await restoring;
    assert.equal(resumed.ok, true, resumed.error); assert.equal(controlled.calls().filter((c) => c === "b0a0").length, 1);
    assert.equal(controlled.calls().filter((c) => c === "b1a0").length, 2);
    if (process.platform === "linux") {
      try { const stat = fs.readFileSync(`/proc/${orphan.pid}/stat`, "utf8"); assert.ok(stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } else assert.ok(owned.filter((process) => process.identity).every((process) => childIdentity(process.pid) !== process.identity));
  } finally {
    recovery.abort();
    if (restoring) await Promise.allSettled([restoring]);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (orphan) await stopRecoveredChild(orphan);
    fs.rmSync(p.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("checkpoint write failure aborts children and preserves the last durable completed sibling", async () => {
  const mutableFs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const p = makeProject({ task: { k1: 1 } }); const rename = mutableFs.renameSync;
  let fail = false;
  try {
    const controlled = controlledAgent(p); await setup(p);
    const run = runLiveEpisode(options(p, { onProgress: (s) => {
      if (s.completed && !fail) {
        fail = true;
        mutableFs.renameSync = (from, to) => {
          if (to === checkpointPath(p.dreamRoot, 1)) throw Object.assign(new Error("fixture disk failure"), { code: "ENOSPC" });
          return rename(from, to);
        };
        syncBuiltinESMExports(); fs.writeFileSync(controlled.gate, "yes");
      }
    } }));
    await assert.rejects(run, /disk failure/);
    const saved = readCheckpoint(p.dreamRoot, 1);
    assert.equal(saved.batches[0].attempts.filter((a) => a.record).length, 1, "last durable checkpoint is intact");
    mutableFs.renameSync = rename; syncBuiltinESMExports();
    const result = await runLiveEpisode(options(p, { resume: true })); assert.equal(result.ok, true, result.error);
    assert.equal(controlled.calls().filter((c) => c === "b0a0").length, 1);
  } finally { mutableFs.renameSync = rename; syncBuiltinESMExports(); p.cleanup(); }
});

test("resumed and restarted attempts preserve their batch guidance", async () => {
  const p = makeProject({ task: { k1: 2, guidance: "summary" } });
  try {
    const controlled = controlledAgent(p); await setup(p);
    const abort = new AbortController();
    const run = runLiveEpisode(options(p, { signal: abort.signal }));
    await until(() => { try { return readCheckpoint(p.dreamRoot, 1).batches[0]?.attempts.some((a) => a.record) && controlled.calls().length === 2; } catch { return false; } });
    abort.abort(); await run;
    const interrupted = readCheckpoint(p.dreamRoot, 1);
    assert.equal(interrupted.timeout_recovery_version, 2);
    const firstGuidance = interrupted.batches[0].direction_guidance;
    assert.match(firstGuidance ?? "", /no evaluated attempts yet/);
    // The interrupted batch must not be recomputed from a tree containing its own completed sibling.
    fs.writeFileSync(controlled.gate, "yes");
    const resumed = await runLiveEpisode(options(p, { resume: true }));
    assert.equal(resumed.ok, true, resumed.error);
    const saved = readCheckpoint(p.dreamRoot, 1);
    assert.equal(saved.batches[0].direction_guidance, firstGuidance, "interrupted batch reuses saved guidance");
    const restartedPrompt = fs.readFileSync(path.join(p.dreamRoot, "history", "r0001_live", "attempt_b1a0", "prompt.md"), "utf8");
    assert.ok(restartedPrompt.includes(firstGuidance), "restarted agent reuses the batch guidance, not a recomputed summary");
    assert.doesNotMatch(restartedPrompt, /b0a0  .*\/ ok.*b1a0/, "restarted prompt does not see its own completed sibling");
    // A later batch still receives earlier diagnostics.
    if (saved.batches.length >= 2) {
      assert.match(saved.batches[1].direction_guidance ?? "", /b0a0/);
    }
  } finally { p.cleanup(); }
});

test("interruption during timeout assessment resumes evaluation without another agent call", async () => {
  const p = makeProject({ task: { k1: 1, workers: 2 } });
  try {
    const callsFile = path.join(p.projectDir, "agent-calls.jsonl");
    const gate = path.join(p.projectDir, "eval-allow");
    fs.writeFileSync(path.join(p.projectDir, "agent-count-hang.mjs"), `import * as fs from 'node:fs';\nimport * as path from 'node:path';\nlet pr='';process.stdin.on('data',d=>pr+=d);process.stdin.on('end',()=>{const cell=path.basename(process.cwd());fs.appendFileSync(${JSON.stringify(callsFile)},cell+'\\n');fs.appendFileSync('solution.py','x\\n');console.log('edited '+cell);setInterval(()=>{},1000);});\n`, "utf8");
    p.task.agent = { command: "node", args: [path.join(p.projectDir, "agent-count-hang.mjs")], model: null, prompt_via: "stdin" };
    p.task.agent_timeout_ms = 5000;
    fs.writeFileSync(path.join(p.projectDir, "score-gated.mjs"), `import * as fs from 'node:fs';\nimport * as path from 'node:path';\nconst cell=path.basename(process.cwd());\nif(cell==='b1a0'&&!fs.existsSync(${JSON.stringify(gate)})){const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);fs.mkdirSync('eval',{recursive:true});fs.writeFileSync('eval/score.json',JSON.stringify({score:2,valid:true,fail_class:'ok',error:null}));}},20);}else{fs.mkdirSync('eval',{recursive:true});fs.writeFileSync('eval/score.json',JSON.stringify({score:2,valid:true,fail_class:'ok',error:null}));}\n`, "utf8");
    p.task.score_program = `node "${path.join(p.projectDir, "score-gated.mjs")}"`;
    await setup(p);
    const abort = new AbortController();
    const run = runLiveEpisode(options(p, { grid: { branch_count: 2, refine_count: 1 }, signal: abort.signal }));
    await until(() => { try { const cp = readCheckpoint(p.dreamRoot, 1); return cp.batches[0]?.attempts.some((a) => a.record) && cp.batches[0].attempts.some((a) => !a.record && a.stage === "evaluation"); } catch { return false; } });
    abort.abort(); await run;
    const interrupted = readCheckpoint(p.dreamRoot, 1);
    assert.equal(interrupted.batches[0].attempts.filter((a) => a.record).length, 1, "one sibling completed with its assessment");
    assert.equal(interrupted.batches[0].attempts.filter((a) => !a.record).length, 1);
    const callsBefore = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").length : 0;
    fs.writeFileSync(gate, "yes");
    const resumed = await runLiveEpisode(options(p, { resume: true }));
    assert.equal(resumed.ok, true, resumed.error);
    const saved = readCheckpoint(p.dreamRoot, 1);
    assert.equal(saved.extra_eval_calls, 1, "assessment retry counts through existing retry accounting");
    const callsAfter = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").length : 0;
    assert.equal(callsAfter, callsBefore, "no additional agent calls for evaluation-only recovery");
    assert.equal(resumed.manifest.attempts, 2, "assessment retries do not add probes");
    for (const node of resumed.tree.list()) {
      assert.equal(node.fail_class, "timeout_scored");
      assert.equal(node.partial, true);
    }
  } finally { p.cleanup(); }
});

test("cycle reports append partial assessments only when present and keep best-score lines", async () => {
  const { iterationReport } = await jump("state.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-report-"));
  try {
    const manifest = { iteration: 1, status: "complete", created_at: new Date().toISOString(), completed_at: new Date().toISOString(), baked_beta: 0.6, policy_version: "p", policy_name: null, grid: { branch_count: 1, refine_count: 1 }, decision_rounds: 1, attempts: 1, baseline_score: 0, best_score: 5, previous_best_score: null, stopped: "budget", error: null, note: null };
    fs.mkdirSync(path.join(root, "trace_pool", "iter0001"), { recursive: true });
    fs.mkdirSync(path.join(root, "history", "r0001_live"), { recursive: true });
    const base = iterationReport(root, 1, manifest);
    assert.doesNotMatch(base, /partial assessment/, "reports without new records retain existing text");
    assert.match(base, /best=5/);
    const { DiscoveryTree } = await jump("engine/tree.ts");
    const { writeJson: write } = await jump("engine/world.ts");
    const tree = new DiscoveryTree({ baselineScore: 0, branchCount: 12, refineCount: 1 });
    for (let b = 0; b < 12; b += 1) {
      tree.addBranchSlot(b);
      tree.setOutcome(`b${b}a0`, {
        evaluated: true, valid: false, fail_class: b % 3 === 0 ? "timeout" : "timeout_scored",
        error: "discovery agent timed out after 10s with output (see agent.log)", score: null, raw_score: null,
        duration_ms: 12000, partial: true, agent_timeout: { duration_ms: 10000, had_output: true },
        timeout_assessment: b % 3 === 0
          ? { score: null, raw_score: null, valid: false, fail_class: "eval_error", error: "boom" }
          : { score: b, raw_score: b, valid: true, fail_class: "ok", error: null },
      });
    }
    write(path.join(root, "trace_pool", "iter0001", "tree.json"), tree.toJSON());
    const withPartial = iterationReport(root, 1, manifest);
    assert.match(withPartial, /best=5/, "main best-score line is unchanged");
    assert.match(withPartial, /partial assessments \(diagnostic only/);
    assert.match(withPartial, /b11a0 timeout_scored partial raw 11/);
    assert.match(withPartial, /assessment eval_error: boom/, "unresolved failures stay readable");
    assert.match(withPartial, /2 more partial assessment\(s\) omitted/, "ten most recent with omitted count");
    assert.match(withPartial, /history[\\/]r0001_live/, "records location is shown");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("dashboard distinguishes partial scores, stays within width and keeps logs accessible", async () => {
  const p = makeProject(); try {
    await setup(p);
    const recorder = new ProgressRecorder(p.dreamRoot, 1, "live", 2, 2);
    recorder.stage("b0a0", "root", 1, "failed", 0, null, "discovery agent timed out after 480s with output (see agent.log)");
    recorder.stage("b1a0", "root", 1, "failed", 0, null, "discovery agent timed out after 480s");
    recorder.snapshot.tree = {
      version: 1, branch_count: 2, refine_count: 1, seq: 3, baseline_score: null,
      cells: [
        { meta: { cell_id: "b0a0", branch: 0, attempt: 0, parent_id: "root", seq: 1, tags: [] }, evaluated: true, valid: false, fail_class: "timeout_scored", error: "discovery agent timed out after 480s with output (see agent.log)", score: null, raw_score: null, workspace: null, proposal: null, artifacts: [], duration_ms: 500000, partial: true, agent_timeout: { duration_ms: 480000, had_output: true }, timeout_assessment: { score: 0.72, raw_score: 0.72, valid: true, fail_class: "ok", error: null } },
        { meta: { cell_id: "b1a0", branch: 1, attempt: 0, parent_id: "root", seq: 2, tags: [] }, evaluated: true, valid: false, fail_class: "timeout", error: "discovery agent timed out after 480s", score: null, raw_score: null, workspace: null, proposal: null, artifacts: [], duration_ms: 500000, partial: true, agent_timeout: { duration_ms: 480000, had_output: false }, timeout_assessment: { score: null, raw_score: null, valid: false, fail_class: "eval_error", error: "boom" } },
      ],
    };
    recorder.finish("complete");
    const view = new DashboardView(p.dreamRoot);
    const lines = view.render(80).join("\n");
    assert.match(lines, /timeout_scored/, "timeout_scored is shown explicitly");
    assert.match(lines, /partial_score=0\.72/, "diagnostic value is separate from ordinary score");
    assert.match(lines, /score=n\/a/, "ordinary score field never carries partial values");
    assert.match(lines, /discovery agent timed out/, "agent timeout explanation is preserved");
    view.nodeIndex = 1;
    const unresolvedLines = view.render(120).join("\n");
    assert.match(unresolvedLines, /assessment eval_error: boom/, "evaluator failures are shown separately");
    assert.ok(view.render(40).every((line) => visibleWidth(line) <= 40), "dashboard stays within its width limit");
    // Agent and evaluator logs remain accessible via panes.
    view.handleInput("\t"); assert.equal(view.pane, 1);
    view.handleInput("\t"); assert.equal(view.pane, 2);
  } finally { p.cleanup(); }
});
