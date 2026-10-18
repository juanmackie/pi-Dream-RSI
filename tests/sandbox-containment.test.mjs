import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getAgentContainmentSupport, getContainmentSupport, runContainedCommand } from "../extensions/pi-dream-rsi/engine/containment.ts";
import { runShellCommand } from "../extensions/pi-dream-rsi/agent/runner.ts";
import { normalizeRunContract } from "../extensions/pi-dream-rsi/engine/intake.ts";
import { probeCommand } from "../extensions/pi-dream-rsi/engine/recon.ts";

const support = await getContainmentSupport();
const agentSupport = await getAgentContainmentSupport();
const runtimeRoots = [process.env.SystemRoot, path.dirname(process.execPath)].filter(Boolean);

test("agent containment support checks that a Node workload can actually start", () => {
  if (process.platform !== "win32" || !support.available) return;
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supportsManagedStdio = (major === 24 && minor >= 21) || (major >= 26 && (major > 26 || minor >= 8));
  if (!supportsManagedStdio) {
    assert.match(agentSupport.reason ?? "", /require Node\.js 24\.21\+ or 26\.8\+/);
  } else if (agentSupport.available) {
    assert.equal(agentSupport.reason, null);
  } else {
    assert.match(agentSupport.reason ?? "", /managed process containment|could not start the Node runtime|STATUS_DLL_INIT_FAILED/);
  }
});

test("OS containment blocks host filesystem, loopback network, and secret environment canaries", {
  skip: support.available ? false : support.reason,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-contained-test-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  const secretFile = path.join(outside, "host-canary.txt");
  const writeTarget = path.join(outside, "sandbox-write.txt");
  fs.writeFileSync(secretFile, "DREAM_RSI_HOST_CANARY_" + crypto.randomUUID());
  const hostCanary = fs.readFileSync(secretFile, "utf8");

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.end("HOST_LOOPBACK_CANARY");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const hostResponse = await new Promise((resolve, reject) => {
    const socket = net.createConnection(address.port, "127.0.0.1");
    socket.once("error", reject);
    socket.on("data", (chunk) => { resolve(chunk.toString("utf8")); socket.destroy(); });
  });
  assert.match(hostResponse, /HOST_LOOPBACK_CANARY/, "the host-side network canary is reachable before sandbox execution");

  const run = (command, env) => runShellCommand(command, {
    cwd: workspace,
    timeoutMs: 10_000,
    envOnly: true,
    containment: { writableRoots: [workspace], readonlyRoots: runtimeRoots },
    env,
  });
  try {
    const shell = await run("echo DREAM_RSI_CONTAINED_SHELL_OK");
    assert.equal(shell.ok, true, shell.stderrTail);
    assert.match(shell.stdoutTail, /DREAM_RSI_CONTAINED_SHELL_OK/);

    const allowedWriteTarget = path.join(workspace, "allowed-write.txt");
    const allowedWrite = await run(`echo DREAM_RSI_ALLOWED_WRITE>"${allowedWriteTarget}"`);
    assert.equal(allowedWrite.ok, true, allowedWrite.stderrTail);
    assert.match(fs.readFileSync(allowedWriteTarget, "utf8"), /DREAM_RSI_ALLOWED_WRITE/);

    const read = await run(`type "${secretFile}"`);
    assert.equal(read.ok, false);
    assert.doesNotMatch(read.stdoutTail, /DREAM_RSI_HOST_CANARY_/);

    const write = await run(`echo DREAM_RSI_WRITE_CANARY>"${writeTarget}"`);
    assert.equal(write.ok, false);
    assert.equal(fs.existsSync(writeTarget), false, "a contained write cannot create a sibling host file");

    const curl = await run("curl.exe --version");
    assert.equal(curl.ok, true, "the sandbox must run the network client before its network denial is meaningful");
    const network = await run(`curl.exe --connect-timeout 2 --max-time 4 -sS http://127.0.0.1:${address.port}`);
    assert.equal(network.ok, false);
    assert.doesNotMatch(network.stdoutTail + network.stderrTail, /HOST_LOOPBACK_CANARY/);

    const secretEnv = await run("if defined DREAM_RSI_TEST_API_KEY (exit /b 9) else (exit /b 0)", {
      DREAM_RSI_TEST_API_KEY: "NEVER_FORWARD_THIS",
      DREAM_RSI_SAFE_VALUE: "allowed",
    });
    assert.equal(secretEnv.ok, true);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("contained execution refuses a working directory outside its write allowlist", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-contained-root-"));
  const allowed = path.join(root, "allowed");
  const denied = path.join(root, "denied");
  fs.mkdirSync(allowed);
  fs.mkdirSync(denied);
  try {
    await assert.rejects(runContainedCommand({
      command: "echo no",
      cwd: denied,
      timeoutMs: 1000,
      writableRoots: [allowed],
    }), /working directory must be inside/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recon probes run from a disposable workspace and cannot read host files", {
  skip: support.available ? false : support.reason,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-contained-recon-"));
  const project = path.join(root, "project");
  const hostFile = path.join(root, "host-canary.txt");
  const canary = `DREAM_RSI_RECON_HOST_${crypto.randomUUID()}`;
  fs.mkdirSync(project);
  fs.writeFileSync(hostFile, canary);
  const runContract = normalizeRunContract({
    version: 1,
    outcome: { statement: "reduce benchmark duration", unit: "ms", higherIsBetter: false, minimumUsefulGain: "10%" },
    preserved: { gates: [] },
    scope: { roots: ["src"], protectedAssets: [] },
    execution: { mode: "trusted-local", consent: true, envAllowlist: [], allowedCommandCategories: ["benchmark"] },
    models: { providers: ["fixture"] },
    budgets: { maxCampaigns: 1, maxAgentStarts: 1, maxEvaluatorRuns: 2, deadlineMs: 30_000, falseAcceptBudget: 0.01 },
  });
  try {
    const result = await probeCommand({ projectDir: project, contract: runContract, containment: { readonlyRoots: runtimeRoots } }, {
      label: "host-file canary", argv: ["type", hostFile], declaredArgv: ["type", hostFile],
      category: "benchmark", source: "fixture", shim: false, entry: null,
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error ?? "", new RegExp(canary));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("contained processes accept prompt stdin, expose ownership, stream output, and stop on abort", {
  skip: agentSupport.available ? false : agentSupport.reason,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-contained-lifecycle-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const pids = [];
  let streamed = "";
  try {
    const prompted = await runContainedCommand({
      command: "findstr /r .",
      cwd: workspace,
      timeoutMs: 10_000,
      writableRoots: [workspace],
      stdin: "DREAM_RSI_CONTAINED_PROMPT\r\n",
      onSpawn: (pid) => pids.push(pid),
      onOutput: (_stream, text) => { streamed += text; },
    });
    assert.equal(prompted.ok, true, prompted.spawnError ?? prompted.stderrTail);
    assert.ok(pids[0] > 0, "the process container reports the owned child process");
    assert.match(streamed, /DREAM_RSI_CONTAINED_PROMPT/);
    assert.match(prompted.stdoutTail, /DREAM_RSI_CONTAINED_PROMPT/);

    const controller = new AbortController();
    const started = Date.now();
    const execution = runContainedCommand({
      command: "ping -n 30 127.0.0.1 >nul",
      cwd: workspace,
      timeoutMs: 30_000,
      writableRoots: [workspace],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const aborted = await execution;
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.ok, false);
    assert.ok(Date.now() - started < 10_000, "abort kills and reaps the contained process promptly");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
