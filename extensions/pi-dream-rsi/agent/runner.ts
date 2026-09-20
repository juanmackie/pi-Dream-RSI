/**
 * Process execution — one attempt is one agent process; one evaluation is one evaluator process.
 *
 * The agent command is configurable so any CLI agent can be plugged in (the paper uses an external
 * CLI discovery agent). Prompts travel over stdin by default: no argv limits, no shell quoting, and
 * a task's prose can never turn into command syntax.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { THINKING_LEVELS, type AgentConfig } from "../engine/task.ts";

const TAIL_BYTES = 64 * 1024;

export interface CommandResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Spawn failure (missing executable, EINVAL, …). */
  spawnError: string | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  logPath: string | null;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  logPath?: string | null;
  env?: Record<string, string>;
  /** Kill the whole process tree, not just the direct child. */
  killTree?: boolean;
}

/** Model ids are embedded in a shell command line when `shell` is used: allow only inert characters. */
export const MODEL_PATTERN = /^[A-Za-z0-9._:@/\-]+$/;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fall through to the plain kill below
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/** Quote one argv element for a shell command line. Rejects quotes we cannot represent safely. */
export function quoteForShell(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  if (arg.includes('"')) throw new Error(`argument cannot be quoted safely for a shell: ${arg}`);
  return `"${arg}"`;
}

async function collect(
  command: string,
  args: string[],
  options: RunOptions & { shell: boolean; stdin?: string },
): Promise<CommandResult> {
  const started = Date.now();
  if (options.logPath) fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
  const logStream = options.logPath
    ? fs.createWriteStream(options.logPath, { flags: "a" })
    : null;
  let stdoutTail = "";
  let stderrTail = "";
  const append = (current: string, chunk: string): string => {
    const next = current + chunk;
    return next.length > TAIL_BYTES ? next.slice(next.length - TAIL_BYTES) : next;
  };

  return await new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: Partial<CommandResult>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      logStream?.end();
      resolve({
        ok: false,
        code: null,
        signal: null,
        timedOut,
        spawnError: null,
        durationMs: Date.now() - started,
        stdoutTail,
        stderrTail,
        logPath: options.logPath ?? null,
        ...result,
      });
    };

    try {
      // With a shell we pass one pre-quoted command line: Node would otherwise concatenate `args`
      // unescaped (and warn about it). `command` is never quoted (it may itself be a command line).
      const argv = options.shell
        ? [`${command}${args.length ? ` ${args.map(quoteForShell).join(" ")}` : ""}`, []]
        : [command, args];
      child = spawn(argv[0] as string, argv[1] as string[], {
        cwd: options.cwd,
        shell: options.shell,
        windowsHide: true,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);

    child.on("error", (error) => finish({ spawnError: error.message }));
    child.stdout?.on("data", (chunk: Buffer) => {      const text = chunk.toString();
      stdoutTail = append(stdoutTail, text);
      logStream?.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = append(stderrTail, text);
      logStream?.write(text);
    });
    child.on("close", (code, signal) => finish({ ok: code === 0 && !timedOut, code, signal }));

    if (child.stdin) {
      if (options.stdin !== undefined) child.stdin.end(options.stdin);
      else child.stdin.end();
    }
  });
}

/** Run a task's evaluator. `command` is a shell command line by design (task-controlled). */
export function runShellCommand(command: string, options: RunOptions): Promise<CommandResult> {
  return collect(command, [], { ...options, shell: true });
}

export interface AgentRun extends RunOptions {
  agent: AgentConfig;
  prompt: string;
}

/**
 * Build the argument vector for one attempt (or one policy revision).
 *
 * `{model}` is substituted where present; when a model is configured but the arguments carry no
 * placeholder, `--model <id>` is appended — otherwise the configured model is silently ignored and
 * every attempt runs on whatever default the agent CLI happens to have.
 */
export function buildAgentArgs(agent: AgentConfig): string[] {
  const hasModelPlaceholder = agent.args.some((arg) => arg.includes("{model}"));
  const hasThinkingPlaceholder = agent.args.some((arg) => arg.includes("{thinking}"));
  const args = agent.args.map((arg) =>
    arg.replaceAll("{model}", agent.model ?? "").replaceAll("{thinking}", agent.thinking ?? ""),
  );
  if (agent.model && !hasModelPlaceholder) args.push("--model", agent.model);
  // Same rule as the model: an explicit `--thinking` in `args` wins, a placeholder is already filled.
  if (agent.thinking && !hasThinkingPlaceholder && !args.includes("--thinking")) {
    args.push("--thinking", agent.thinking);
  }
  return args;
}

/**
 * The invocation that re-runs the pi CLI hosting this extension.
 *
 * A bare `pi` depends on PATH/shim resolution and fails when pi is not on the child's PATH (or is only a
 * shell shim on Windows). Resolve the running executable instead — node/bun + the running cli.js, or the
 * compiled pi binary — mirroring pi's own subagent example. Returns null when not running inside pi so a
 * caller (SDK host, tests) falls back to `pi`.
 */
export interface PiSelfOptions {
  argv1?: string;
  execPath?: string;
  insidePi?: boolean;
  exists?: (candidate: string) => boolean;
}

export function piSelfInvocation(options: PiSelfOptions = {}): { command: string; args: string[] } | null {
  const insidePi =
    options.insidePi ?? (process.env.PI_CODING_AGENT === "true" || process.env.AI_AGENT === "pi");
  if (!insidePi) return null;
  const argv1 = options.argv1 ?? process.argv[1];
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? fs.existsSync;
  const isBunVirtualScript = typeof argv1 === "string" && argv1.startsWith("/$bunfs/root/");
  if (typeof argv1 === "string" && argv1 !== "" && !isBunVirtualScript && exists(argv1)) {
    return { command: execPath, args: [argv1] };
  }
  const execName = path.basename(execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: execPath, args: [] };
  return null;
}

/** Run one discovery attempt / policy revision. */
export function runAgent(options: AgentRun): Promise<CommandResult> {
  const { agent } = options;
  const args = buildAgentArgs(agent);
  const unsafeModel = Boolean(agent.model && !MODEL_PATTERN.test(agent.model));
  const unsafeThinking = Boolean(agent.thinking && !THINKING_LEVELS.includes(agent.thinking));
  if (unsafeModel || unsafeThinking) {
    return Promise.resolve({
      ok: false,
      code: null,
      signal: null,
      timedOut: false,
      spawnError: unsafeThinking ? `unsafe agent.thinking: ${agent.thinking}` : `unsafe characters in agent.model: ${agent.model}`,
      durationMs: 0,
      stdoutTail: "",
      stderrTail: "",
      logPath: options.logPath ?? null,
    });
  }
  // The default `pi` agent re-spawns the running pi invocation, so it never depends on PATH. A custom
  // command keeps the platform shell so Windows .cmd/.bat shims still resolve.
  const self = agent.command === "pi" ? piSelfInvocation() : null;
  const command = self ? self.command : agent.command;
  const invocationArgs = self ? [...self.args, ...args] : args;
  const shell = self ? false : process.platform === "win32";
  if (agent.prompt_via === "arg") {
    return collect(command, [...invocationArgs, options.prompt], { ...options, shell });
  }
  return collect(command, invocationArgs, { ...options, shell, stdin: options.prompt });
}

/** Fresh workspace copy: the attempt resumes its parent's saved workspace state. */
export interface CopyWorkspaceOptions {
  /**
   * Paths that must never appear inside the copy — typically the Dream-RSI root, so an attempt can
   * never read sibling scores or the policy versions. Ignored when an entry contains the source
   * itself (a refinement copies a workspace that already lives inside that root).
   */
  exclude?: string[];
}

function isInside(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(parent + path.sep);
}

/**
 * Recursive copy that can skip subtrees.
 *
 * `fs.cpSync` cannot do this job: it rejects a destination nested inside the source
 * (`ERR_FS_CP_EINVAL: cannot copy to a subdirectory of self`) before any filter runs, and
 * `workspace: "."` makes the attempt workspaces exactly that. Walking the tree explicitly also
 * makes both rules obvious: never descend into the destination, never descend into an excluded root.
 */
function copyTree(from: string, to: string, skip: (resolved: string) => boolean): void {
  const stats = fs.lstatSync(from);
  if (stats.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const childFrom = path.join(from, entry.name);
      const childTo = path.join(to, entry.name);
      // Only the source side is tested: children of the destination are trivially "inside" it.
      if (skip(path.resolve(childFrom))) continue;
      copyTree(childFrom, childTo, skip);
    }
    return;
  }
  if (stats.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(from);
    try {
      fs.symlinkSync(linkTarget, to);
    } catch {
      // No symlink privilege (typical on Windows without developer mode): copy what it points at.
      const resolved = fs.statSync(from);
      if (resolved.isDirectory()) copyTree(from, to, skip);
      else fs.copyFileSync(fs.realpathSync(from), to);
    }
    return;
  }
  fs.copyFileSync(from, to);
}

export function copyWorkspace(from: string, to: string, options: CopyWorkspaceOptions = {}): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  const source = path.resolve(from);
  const destination = path.resolve(to);
  const excluded = (options.exclude ?? [])
    .map((entry) => path.resolve(entry))
    .filter((entry) => !isInside(source, entry));
  copyTree(from, to, (resolved) => {
    if (isInside(resolved, destination)) return true;
    return excluded.some((root) => isInside(resolved, root));
  });
}
