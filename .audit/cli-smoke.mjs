import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-cli-smoke-"));
const project = path.join(root, "project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "package.json"), '{"type":"module"}\n');
const child = spawn(process.execPath, [
  path.join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
  "--mode", "rpc", "--no-extensions", "-e", repo, "--no-skills",
  "--no-context-files", "--no-prompt-templates", "--no-session", "--offline",
], {
  cwd: project,
  windowsHide: true,
  env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_TELEMETRY: "0", JITI_FS_CACHE: "false" },
  stdio: ["pipe", "pipe", "pipe"],
});
const events = [];
const closed = once(child, "close");
const pending = new Map();
let stderr = "";
let buffer = "";
let sequence = 0;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (part) => { stderr = (stderr + part).slice(-8000); });
child.stdout.on("data", (part) => {
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
child.on("exit", (code) => {
  for (const { reject } of pending.values()) reject(new Error(`CLI exited ${code}: ${stderr}`));
  pending.clear();
});
const timeout = setTimeout(() => child.kill(), 60_000);
const call = (type, args = {}) => new Promise((resolve, reject) => {
  const id = `smoke-${++sequence}`;
  pending.set(id, { resolve, reject });
  child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
});
try {
  const commands = await call("get_commands");
  assert.equal(commands.success, true, JSON.stringify(commands));
  assert.ok(commands.data.commands.some((item) => item.name === "dream-rsi"));
  const help = await call("prompt", { message: "/dream-rsi help" });
  assert.equal(help.success, true, JSON.stringify(help));
  const retired = await call("prompt", { message: "/dream-rsi create" });
  assert.equal(retired.success, true, JSON.stringify(retired));
  const status = await call("prompt", { message: "/dream-rsi status" });
  assert.equal(status.success, true, JSON.stringify(status));
  const serialized = JSON.stringify(events);
  assert.match(serialized, /arXiv 2609\.14858/);
  assert.match(serialized, /create was removed in 1\.0/);
  assert.match(serialized, /No campaign yet/);
  assert.equal(fs.existsSync(path.join(project, ".dream-rsi")), false);
  assert.equal(events.some((event) => event.type === "agent_start"), false);
  fs.writeFileSync(path.join(repo, ".audit/cli-smoke-events.json"), `${JSON.stringify(events, null, 2)}\n`);
  console.log(JSON.stringify({ entry: "pi CLI RPC", commands: true, help: true, retired: true, status: true, agentStarts: 0, projectUnchanged: true }));
} finally {
  clearTimeout(timeout);
  child.kill();
  await closed;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
