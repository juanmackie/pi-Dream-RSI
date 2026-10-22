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
  if (/adversarial review/i.test(prompt)) {
    writeFileSync("review.json", JSON.stringify({ verdict: "accept", reasons: [] }));
    return;
  }
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
  // Reports a provider error on the attempts named in DREAM_STREAK_MODE and a clean
  // reply on the others. The counter lives outside the candidate workspace so the
  // attempt order survives the per-attempt copy.
  "agent-streak.mjs": `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = process.env.DREAM_STREAK_FILE ?? "";
const steps = (process.env.DREAM_STREAK_MODE ?? "").split(",");
const count = file && existsSync(file) ? Number(readFileSync(file, "utf8").trim() || "0") : 0;
if (file) writeFileSync(file, String(count + 1));
const step = steps[count] ?? "ok";
if (step === "error") {
  console.log(JSON.stringify({ type: "message_end", message: { model: "fixture/streak", stopReason: "error", errorMessage: "fixture provider failed" } }));
} else {
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } }));
  console.log(JSON.stringify({ type: "message_end", message: { model: "fixture/streak", stopReason: "stop" } }));
}
`,
  "agent-scenario.mjs": `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
let prompt = ""; process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const scenario = process.env.DREAM_SCENARIO ?? "truewin";
  if (/Perform an adversarial review/i.test(prompt)) {
    const reject = scenario === "reviewReject";
    writeFileSync("review.json", JSON.stringify({ verdict: reject ? "reject" : "accept", reasons: reject ? ["scripted review rejection"] : [] }));
    return;
  }
  if (prompt.includes("Do not change files.")) { process.stdout.write("Ready to inspect the target.\\n"); return; }
  if (prompt.includes("prefix-only exploration policy")) { process.stdout.write("Policy revision left unchanged.\\n"); return; }
  const source = readFileSync("solution.py", "utf8");
  if (scenario === "noop") { writeFileSync("proposal.md", "# No change\\n"); return; }
  if (scenario === "regression") { writeFileSync("solution.py", "print('seed')\\n"); writeFileSync("proposal.md", "# Regression\\n"); return; }
  if (scenario === "cheat") { writeFileSync("solution.py", source + "x # CHEAT\\n"); writeFileSync("proposal.md", "# Hidden-path change\\n"); return; }
  if (scenario === "duplicate") { writeFileSync("solution.py", "x\\n"); writeFileSync("proposal.md", "# Same candidate\\n"); return; }
  appendFileSync("solution.py", "x\\n");
  writeFileSync("proposal.md", "# Add a valid marker\\n");
  if (scenario === "timeout") setInterval(() => {}, 1000);
});
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
  // A candidate that moves part of its change into a second file, and a scorer that needs both.
  "agent-helper.mjs": `
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const depth = (readFileSync("solution.py", "utf8").match(/x/g) ?? []).length;
  appendFileSync("solution.py", "import helper\\n" + "x".repeat(1 + (depth % 3)) + "\\n");
  writeFileSync("helper.py", "FAST = True\\n");
  writeFileSync("proposal.md", "# split the hot path into helper.py\\ndepth=" + depth + "\\n");
});
`,
  "score-helper.mjs": `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const src = readFileSync("solution.py", "utf8");
mkdirSync("eval", { recursive: true });
const broken = src.includes("import helper") && !existsSync("helper.py");
writeFileSync("eval/score.json", JSON.stringify({
  score: broken ? 0 : (src.match(/x/g) ?? []).length,
  valid: !broken,
  fail_class: broken ? "import_error" : "ok",
  error: broken ? "ModuleNotFoundError: helper" : null,
}));
`,
  "score-fail.mjs": `
console.error("evaluator exploded");
process.exit(4);
`,
  "score-nofile.mjs": `
process.exit(0);
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
    higher_is_better: true,
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
  fs.mkdirSync(project.dreamRoot, { recursive: true });
  fs.writeFileSync(path.join(project.dreamRoot, "task.json"), `${JSON.stringify(project.task, null, 2)}\n`, "utf8");
}

/** Mock of the pi ExtensionAPI surface this extension uses. */
export function mockPi() {
  const tools = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const handlers = new Map();
  const entries = [];
  const statuses = [];
  const notifications = [];
  const harness = {
    tools,
    commands,
    shortcuts,
    widgets: [],
    customViews: [],
    terminal: { rows: 30, columns: 80 },
    handlers,
    entries,
    statuses,
    notifications,
    /** User messages the extension asked pi to send to the agent. */
    sentMessages: [],
    /** Custom (non-turn) messages injected into the session. */
    injectedMessages: [],
    activeTools: ["read", "write", "bash"],
    /** Entries of the current branch; tests can narrow it to simulate a rewired session tree. */
    branch: null,
    /** Whether the agent counts as idle, for `sendUserMessage` delivery mode. */
    idle: true,
    /** Scripted answers for `ctx.ui.select` / `ctx.ui.confirm`; an empty queue means "no dialog". */
    uiAnswers: { select: [], confirm: [] },
    /** Dialogs the extension opened, so a test can assert the choice was offered at all. */
    uiPrompts: [],
  };
  const pi = {
    // Registered tools become active, as in pi; the extension then gates the expensive ones.
    registerTool: (tool) => {
      tools.set(tool.name, tool);
      if (!harness.activeTools.includes(tool.name)) harness.activeTools.push(tool.name);
    },
    registerCommand: (name, definition) => commands.set(name, definition),
    registerShortcut: (name, definition) => shortcuts.set(name, definition),
    on: (event, handler) => handlers.set(event, handler),
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    getActiveTools: () => [...harness.activeTools],
    setActiveTools: (list) => {
      harness.activeTools = [...list];
    },
    sendUserMessage: (content, options) => harness.sentMessages.push({ content, options }),
    sendMessage: (message, options) => harness.injectedMessages.push({ message, options }),
  };
  const context = {
    mode: "print",
    hasUI: false,
    cwd: null,
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionDir: () => path.join(context.cwd ?? process.cwd(), ".pi-sessions"),
      getEntries: () => entries,
      getBranch: () => harness.branch ?? entries,
    },
    ui: {
      setWidget: (key, value) => harness.widgets.push([key, value]),
      custom: (factory, options) => new Promise((resolve) => {
        const fgCodes = { border: 33, accent: 35, success: 32, warning: 33, error: 31, muted: 37, dim: 90, text: 37 };
        const bgCodes = { customMessageBg: 236, selectedBg: 24, userMessageBg: 24, toolPendingBg: 24, toolSuccessBg: 24, toolErrorBg: 24, searchMatchBg: 24 };
        const theme = {
          fg: (color, text) => `\x1b[38;5;${fgCodes[color] ?? 37}m${text}\x1b[0m`,
          bg: (color, text) => `\x1b[48;5;${bgCodes[color] ?? 24}m${text}\x1b[0m`,
          bold: (text) => `\x1b[1m${text}\x1b[0m`,
          getBgAnsi: (color) => `\x1b[48;5;${bgCodes[color] ?? 24}m`,
        };
        const tui = { requestRender: () => {}, terminal: harness.terminal };
        const view = factory(tui, theme, {}, resolve);
        harness.customViews.push({ view, options, theme, tui });
      }),
      notify: (message) => notifications.push(message),
      setStatus: (key, value) => statuses.push([key, value ?? null]),
      // A host without a TUI (print mode, RPC without a client) answers undefined/false, which must land
      // on the same path as "Cancel"; so does a test that scripts nothing.
      select: async (title, options) => {
        harness.uiPrompts.push({ kind: "select", title, options });
        return harness.uiAnswers.select.shift();
      },
      confirm: async (title, message) => {
        harness.uiPrompts.push({ kind: "confirm", title, message });
        return harness.uiAnswers.confirm.shift() ?? false;
      },
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
