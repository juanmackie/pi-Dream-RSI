/**
 * Test fixtures: a throwaway project with a seed workspace, a fixed scorer, stub agents and a mocked pi
 * API. Everything here is deterministic and cheap — no LLM is ever involved.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXT = path.join(REPO, "extensions", "pi-dream-rsi");
export const PACKAGE = REPO;

/** Import one of the extension's TypeScript modules from a test. */
export function jump(name) {
  return import(pathToFileURL(path.join(EXT, name)).href);
}

const SCRIPTS = {
  "agent-ok.mjs": `
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
let prompt = ""; process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const depth = (readFileSync("solution.py", "utf8").match(/x/g) ?? []).length;
  appendFileSync("solution.py", "x".repeat(1 + (depth % 3)) + "\\n");
  writeFileSync("proposal.md", "# mechanism\\ndepth=" + depth + "\\nprompt_bytes=" + prompt.length + "\\n");
});
`,
  "agent-noproposal.mjs": `
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});
`,
  "agent-fail.mjs": `
console.error("stub agent refused");
process.exit(3);
`,
  "agent-hang.mjs": `
process.stdin.on("data", () => {});
process.stdin.on("end", () => { setInterval(() => {}, 1000); });
`,
  "score-ok.mjs": `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const src = readFileSync("solution.py", "utf8");
mkdirSync("eval", { recursive: true });
const broken = src.includes("BROKEN");
writeFileSync("eval/score.json", JSON.stringify({
  score: (src.match(/x/g) ?? []).length,
  valid: !broken,
  fail_class: broken ? "wrong_answer" : "ok",
  error: broken ? "candidate marked BROKEN" : null,
}));
`,
  "score-fail.mjs": `
console.error("evaluator exploded");
process.exit(4);
`,
  "score-nofile.mjs": `
process.exit(0);
`,
  "agent-router.mjs": `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  // One CLI, two prompts: discover whether the discovery prompt or the improvement prompt arrived.
  const policyWork = prompt.includes("prefix-only exploration policy");
  appendFileSync("agent-prompts.log", (policyWork ? "development" : "discovery") + " " + prompt.length + "\\n");
  if (policyWork) {
    const file = "policy/method.ts";
    const src = readFileSync(file, "utf8");
    const next = src.includes("default_beta = 0.8;") ? "0.7" : "0.8";
    writeFileSync(file, src.replace(/default_beta = [0-9.]+;/, "default_beta = " + next + ";"));
    return;
  }
  const depth = (readFileSync("solution.py", "utf8").match(/x/g) ?? []).length;
  appendFileSync("solution.py", "x".repeat(1 + (depth % 3)) + "\\n");
  writeFileSync("proposal.md", "# mechanism\\ndepth=" + depth + "\\nprompt_bytes=" + prompt.length + "\\n");
});
`,
  "developer-improve.mjs": `
import { readFileSync, writeFileSync } from "node:fs";
let prompt = ""; process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const file = "policy/method.ts";
  const src = readFileSync(file, "utf8");
  const next = src.includes("default_beta = 0.8;") ? "0.6" : "0.8";
  writeFileSync(file, src.replace(/default_beta = [0-9.]+;/, "default_beta = " + next + ";")
    .replace("// EVOLVE-BLOCK-START", "// EVOLVE-BLOCK-START (revised; prompt bytes " + prompt.length + ")"));
});
`,
  "developer-regress.mjs": `
import { readFileSync, writeFileSync } from "node:fs";
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const file = "policy/method.ts";
  const src = readFileSync(file, "utf8");
  // A policy that refuses to probe anything: worse on every world, so selection must keep pi_0.
  writeFileSync(file, src.replace(
    "    while (!_budget_done(question, budget)) {",
    "    while (false) {",
  ));
});
`,
};

/** Build a throwaway project. Returns paths plus a task object already pointing at the fixtures. */
export function makeProject(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-test-"));
  const projectDir = path.join(dir, "proj");
  const seed = path.join(projectDir, "seed");
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, "solution.py"), 'print("seed")\n', "utf8");
  fs.writeFileSync(path.join(projectDir, "PROBLEM.md"), "Maximize the number of x markers in solution.py.\n", "utf8");
  for (const [name, source] of Object.entries(SCRIPTS)) {
    fs.writeFileSync(path.join(projectDir, name), source, "utf8");
  }
  const taskDefaults = {
    name: "fixture",
    workspace: "seed",
    eval_program: "solution.py",
    score_program: `node "${path.join(projectDir, options.scorer ?? "score-ok.mjs")}"`,
    problem_file: "PROBLEM.md",
    workers: 2,
    k1: 3,
    k2: 4,
    revisions: 2,
    beta_grid: [0, 0.6],
    default_beta: 0.6,
    agent_timeout_ms: options.agentTimeoutMs ?? 20_000,
    evaluator_timeout_ms: options.evaluatorTimeoutMs ?? 20_000,
    agent: {
      command: "node",
      args: [path.join(projectDir, options.agent ?? "agent-ok.mjs")],
      model: null,
      prompt_via: "stdin",
    },
  };
  const task = { ...taskDefaults, ...(options.task ?? {}) };
  return {
    dir,
    projectDir,
    seed,
    dreamRoot: path.join(projectDir, ".dream-rsi"),
    task,
    script: (name) => path.join(projectDir, name),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export async function writeTaskJson(project) {
  const { writeTask } = await jump("engine/task.ts");
  fs.mkdirSync(project.dreamRoot, { recursive: true });
  writeTask(project.dreamRoot, project.task);
}

/** Deploy the shipped policy into the project, with its relative imports. */
export async function deployShippedPolicy(project, source = null) {
  const world = await jump("engine/world.ts");
  world.ensurePolicyRuntime(project.dreamRoot, path.join(EXT, "policy"));
  const shipped = source ?? fs.readFileSync(path.join(EXT, "policy", "method.ts"), "utf8");
  return world.deployPolicy(project.dreamRoot, shipped);
}

/** Mock of the pi ExtensionAPI surface this extension uses. */
export function mockPi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const entries = [];
  const statuses = [];
  const notifications = [];
  const harness = {
    tools,
    commands,
    handlers,
    entries,
    statuses,
    notifications,
    /** User messages the extension asked pi to send to the agent. */
    sentMessages: [],
    activeTools: ["read", "write", "bash"],
    /** Entries of the current branch; tests can narrow it to simulate a rewired session tree. */
    branch: null,
    /** Whether the agent counts as idle, for `sendUserMessage` delivery mode. */
    idle: true,
  };
  const pi = {
    // Registered tools become active, as in pi; the extension then gates the expensive ones.
    registerTool: (tool) => {
      tools.set(tool.name, tool);
      if (!harness.activeTools.includes(tool.name)) harness.activeTools.push(tool.name);
    },
    registerCommand: (name, definition) => commands.set(name, definition),
    on: (event, handler) => handlers.set(event, handler),
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    getActiveTools: () => [...harness.activeTools],
    setActiveTools: (list) => {
      harness.activeTools = [...list];
    },
    sendUserMessage: (content, options) => harness.sentMessages.push({ content, options }),
  };
  const context = {
    cwd: null,
    sessionManager: {
      getSessionId: () => "test-session",
      getEntries: () => entries,
      getBranch: () => harness.branch ?? entries,
    },
    ui: {
      notify: (message) => notifications.push(message),
      setStatus: (key, value) => statuses.push([key, value ?? null]),
    },
    isIdle: () => harness.idle,
    hasPendingMessages: () => false,
  };
  return { pi, context, harness };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function exists(file) {
  return fs.existsSync(file);
}
