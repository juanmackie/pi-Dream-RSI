import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { REPO } from "./fixtures.mjs";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "campaign-cli-e2e-extension.mjs");

test("installed Pi CLI loads Dream-RSI and runs a provider-free guarded campaign end to end", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-cli-e2e-"));
  const project = path.join(root, "project");
  const agentDir = path.join(root, "pi-agent");
  const reportPath = path.join(root, "report.json");
  const recorderPath = path.join(root, "subprocesses.jsonl");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), '{"type":"module"}\n');

  const cli = spawn(process.execPath, [
    path.join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    "--mode", "rpc", "--no-extensions", "-e", fixture,
    "--no-skills", "--no-context-files", "--no-prompt-templates", "--offline",
  ], {
    cwd: project,
    windowsHide: true,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_TELEMETRY: "0",
      JITI_FS_CACHE: "false",
      DREAM_RSI_REPO: REPO,
      DREAM_RSI_CLI_E2E_REPORT: reportPath,
      DREAM_RSI_CLI_E2E_RECORDER: recorderPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  const pending = new Map();
  const closed = once(cli, "close");
  let stderr = "";
  let buffer = "";
  let sequence = 0;
  cli.stdout.setEncoding("utf8");
  cli.stderr.setEncoding("utf8");
  cli.stderr.on("data", (part) => { stderr = (stderr + part).slice(-16_000); });
  cli.stdout.on("data", (part) => {
    buffer += part;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      events.push(event);
      if (event.type === "response" && pending.has(event.id)) {
        pending.get(event.id).resolve(event);
        pending.delete(event.id);
      }
    }
  });
  cli.on("exit", (code) => {
    for (const { reject } of pending.values()) reject(new Error(`Pi CLI exited ${code}: ${stderr}`));
    pending.clear();
  });
  const timeout = setTimeout(() => cli.kill(), 180_000);
  const call = (type, args = {}) => new Promise((resolve, reject) => {
    const id = `campaign-e2e-${++sequence}`;
    pending.set(id, { resolve, reject });
    cli.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
  });

  try {
    const commands = await call("get_commands");
    assert.equal(commands.success, true, JSON.stringify(commands));
    assert.ok(commands.data.commands.some((item) => item.name === "dream-rsi"));
    assert.ok(commands.data.commands.some((item) => item.name === "fixture-e2e"));
    const run = await call("prompt", { message: "/fixture-e2e" });
    assert.equal(run.success, true, `${JSON.stringify(run)}\n${stderr}`);
    assert.ok(fs.existsSync(reportPath), `fixture did not write a report\n${stderr}`);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.ok, true, report.error ?? JSON.stringify(report));
    assert.match(report.signal, /npm test/);
    assert.match(report.relativeCheck, /use an absolute path/);
    assert.equal(report.baselineScores.length, 5);
    assert.equal(report.agentStartsAtBaseline, 0, "the five baseline scores complete before the first agent starts");
    assert.deepEqual(report.cycle, 1);
    assert.equal(report.counters.agentStarts, report.counters.recordedAgentStarts);
    assert.equal(report.counters.evaluatorRuns, report.counters.recordedEvaluatorStarts);
    assert.ok(report.roles.includes("review"));
    assert.equal(report.reviewVerdict, "accept");
    assert.equal(report.pairedMeasurements.length, report.confirmationCount,
      "review measurements agree with the campaign's confirmation ledger");
    assert.match(report.appliedHash, /^[a-f0-9]{64}$/);
    assert.equal(report.finalState.kind, "complete");
    assert.equal(report.applied, true);
    assert.ok(report.routedSkills.includes("/skill:dream-rsi-assess make the parser faster"));
    assert.ok(report.routedSkills.includes("/skill:dream-rsi-improve make the parser faster"));
    assert.equal(events.some((event) => event.type === "agent_start"), false, "the fixture made no hosted or model-backed agent calls");
    if (process.env.DREAM_RSI_E2E_AUDIT_DIR) {
      fs.mkdirSync(process.env.DREAM_RSI_E2E_AUDIT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.DREAM_RSI_E2E_AUDIT_DIR, "self-campaign-cli-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    } else {
      t.diagnostic(`CLI loader E2E passed: ${report.counters.agentStarts} agent starts, ${report.counters.evaluatorRuns} evaluator starts, review=${report.reviewVerdict}, applied SHA-256=${report.appliedHash}`);
    }
  } finally {
    clearTimeout(timeout);
    cli.kill();
    await closed;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
