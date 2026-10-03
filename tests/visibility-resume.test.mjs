import { visibleWidth } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { jump, makeProject, deployShippedPolicy, writeTaskJson, mockPi } from "./fixtures.mjs";
const { runLiveEpisode } = await jump("engine/live.ts");
const { readCheckpoint, saveCheckpoint, recoverableIterations, checkpointPath } = await jump("engine/checkpoint.ts");
const { readProgress, ProgressRecorder } = await jump("engine/progress.ts");
const { liveMethodPath, readTree, pruneWorkspaces, nodeWorkspace, iterationDir, writeJson } = await jump("engine/world.ts");
const { OutputDecoder, BoundedTail } = await jump("agent/output.ts");
const { runAgent, copyWorkspace, buildAgentArgs } = await jump("agent/runner.ts");
const { defaultTask, normalizeTask } = await jump("engine/task.ts");
const { Dashboard, DashboardView, readLogPage } = await jump("dashboard.ts");
const { default: extension } = await jump("index.ts");

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate) { for (let i = 0; i < 500; i++) { if (predicate()) return; await pause(20); } throw new Error("fixture never reached requested stage"); }
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

test("resume command/tool is gated and a shortcut watches without starting model work", async () => {
  const p = makeProject(); try {
    await setup(p); const { pi, context, harness } = mockPi(); context.cwd = p.projectDir; extension(pi);
    await harness.handlers.get("session_start")({}, context);
    assert.equal(harness.activeTools.includes("dream_rsi_resume"), false);
    await harness.commands.get("dream-rsi").handler("resume", context);
    assert.equal(harness.activeTools.includes("dream_rsi_resume"), true);
    assert.match(harness.sentMessages[0].content, /dream_rsi_resume/);
    const before = harness.sentMessages.length;
    await harness.shortcuts.get("ctrl+shift+d").handler(context);
    assert.equal(harness.sentMessages.length, before);
    const result = await harness.tools.get("dream_rsi_resume").execute("x", {}, undefined, undefined, context);
    assert.equal(result.details.ok, false); assert.match(result.content[0].text, /no recoverable/);
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
    fs.rmSync(blocked, { recursive: true });
    const recovered = await runLiveEpisode(options(p, { resume: true }));
    assert.equal(recovered.ok, true, recovered.error); assert.equal(controlled.calls().length, count);
    assert.ok(readTree(p.dreamRoot, 1)); assert.deepEqual(recoverableIterations(p.dreamRoot), []);
  } finally { p.cleanup(); }
});

test("reload cancels and drains live children, closes the overlay, and leaves a recoverable tree", async () => {
  const p = makeProject({ task: { k1: 1 } }); try {
    const controlled = controlledAgent(p); await setup(p);
    const { pi, context, harness } = mockPi(); context.cwd = p.projectDir; context.mode = "tui";
    extension(pi); await harness.handlers.get("session_start")({}, context);
    const live = harness.tools.get("dream_rsi_live").execute("live", {}, undefined, undefined, context);
    await until(() => controlled.calls().length === 2);
    const watch = harness.shortcuts.get("ctrl+shift+d").handler(context);
    assert.equal(harness.customViews.length, 1);
    await harness.handlers.get("session_shutdown")({ reason: "reload" }, context);
    await watch; const result = await live;
    assert.equal(result.details.ok, false); assert.deepEqual(recoverableIterations(p.dreamRoot), [1]);
    assert.equal(fs.existsSync(p.script(".dream-rsi/live-1.lock")), false);
    assert.equal(readProgress(p.dreamRoot, 1).status, "interrupted");
  } finally { p.cleanup(); }
});

test("legacy worlds can be watched and failed worlds are excluded from dream replay", async () => {
  const p = makeProject(); try {
    await setup(p);
    writeJson(path.join(iterationDir(p.dreamRoot, 1), "live_cycle_manifest.json"), { iteration: 1, status: "failed", grid: { branch_count: 1 }, created_at: new Date().toISOString() });
    writeJson(path.join(iterationDir(p.dreamRoot, 1), "tree.json"), { version: 1, branch_count: 1, refine_count: 1, seq: 2, baseline_score: null, cells: [] });
    const view = new DashboardView(p.dreamRoot); assert.match(view.render(120).join("\n"), /legacy/);
    const { runDreamPhase } = await jump("engine/dream.ts");
    await assert.rejects(runDreamPhase({ dreamRoot: p.dreamRoot, projectDir: p.projectDir, task: p.task, iteration: 1, evaluateOnly: true }), /no recorded worlds/);
  } finally { p.cleanup(); }
});

test("allocator shares max_loops across independent processes and blocks new work during dream", async () => {
  const { spawn } = await import("node:child_process"); const { pathToFileURL } = await import("node:url");
  const { reserveIterations, runningIterations } = await jump("state.ts");
  const { allocator, acquirePhase } = await jump("engine/ownership.ts");
  const p = makeProject(); try {
    await setup(p);
    const script = p.script("reserve.mjs");
    const stateUrl = pathToFileURL(path.resolve("extensions/pi-dream-rsi/state.ts")).href;
    fs.writeFileSync(script, `import {reserveIterations} from ${JSON.stringify(stateUrl)};const root=process.argv[2];try{console.log(JSON.stringify({iterations:reserveIterations(root,1,1,{session_id:String(process.pid),pid:process.pid,claimed_at:new Date().toISOString()},1)}));}catch(e){console.log(JSON.stringify({error:e.message}));}`);
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, p.dreamRoot]); let output = ""; let error = "";
      child.stdout.on("data", (d) => output += d); child.stderr.on("data", (d) => error += d);
      child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
    });
    const results = await Promise.all([run(), run()]);
    assert.equal(results.filter((r) => r.iterations).length, 1); assert.equal(runningIterations(p.dreamRoot).length, 1);
    const release = allocator(p.dreamRoot, () => acquirePhase(p.dreamRoot, "dream"));
    try {
      assert.throws(() => reserveIterations(p.dreamRoot, 1, 2, undefined, 2), /dream phase/);
      await assert.rejects(runLiveEpisode(options(p, { iteration: 2 })), /dream phase/);
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
  const p = makeProject({ task: { k1: 1 } }); let child; let orphan;
  try {
    const controlled = controlledAgent(p); await setup(p);
    const script = p.script("crash-host.mjs");
    const liveUrl = pathToFileURL(path.resolve("extensions/pi-dream-rsi/engine/live.ts")).href;
    fs.writeFileSync(script, `import { runLiveEpisode } from ${JSON.stringify(liveUrl)};const options=JSON.parse(process.argv[2]);await runLiveEpisode({...options,owner:{pid:process.pid,session_id:'crash-host',claimed_at:new Date().toISOString()}});`);
    child = spawn(process.execPath, [script, JSON.stringify(options(p))], { stdio: "ignore" });
    await until(() => { try { const cp = readCheckpoint(p.dreamRoot, 1); return cp.batches[0]?.attempts.some((a) => a.record) && cp.batches[0].attempts[1].process; } catch { return false; } });
    orphan = readCheckpoint(p.dreamRoot, 1).batches[0].attempts[1].process;
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    assert.equal(childIdentity(orphan.pid), orphan.identity);
    const restoring = runLiveEpisode(options(p, { resume: true }));
    await until(() => controlled.calls().filter((c) => c === "b1a0").length === 2);
    fs.writeFileSync(controlled.gate, "yes");
    const resumed = await restoring;
    assert.equal(resumed.ok, true, resumed.error); assert.equal(controlled.calls().filter((c) => c === "b0a0").length, 1);
    assert.equal(controlled.calls().filter((c) => c === "b1a0").length, 2);
    if (process.platform === "linux") {
      try { const stat = fs.readFileSync(`/proc/${orphan.pid}/stat`, "utf8"); assert.ok(stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } else assert.notEqual(childIdentity(orphan.pid), orphan.identity);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (orphan) await stopRecoveredChild(orphan);
    p.cleanup();
  }
});
