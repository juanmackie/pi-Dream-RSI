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

/**
 * Session-identity variables a spawned attempt must not inherit.
 *
 * A discovery agent is a fresh, headless process: inheriting the parent session's id/file (or
 * pi-web's `PI_WEB_SESSION`) makes a nested pi attach to the session it runs inside instead of
 * processing its own prompt — several parallel attempts then serialize on that identity (or wait
 * on it forever) and burn the attempt as a silent `timeout` with an empty `agent.log`, while the
 * same command probed alone succeeds instantly. `RunOptions.env` can re-add a variable when a
 * task genuinely needs one.
 */
export const STRIPPED_SESSION_ENV = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_WEB_SESSION"];

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
  // POSIX: the child is spawned detached (its own process group), so signal the whole group —
  // grandchildren keep the stdio pipes open and would otherwise outlive the timeout.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
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
    let grace: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: Partial<CommandResult>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
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
      // Session identity is stripped unless the caller re-adds it: a nested attempt must not
      // attach to the session it was spawned from (see STRIPPED_SESSION_ENV).
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of STRIPPED_SESSION_ENV) delete env[key];
      Object.assign(env, options.env ?? {});
      // With a shell we pass one pre-quoted command line: Node would otherwise concatenate `args`
      // unescaped (and warn about it). `command` is never quoted (it may itself be a command line).
      const argv = options.shell
        ? [`${command}${args.length ? ` ${args.map(quoteForShell).join(" ")}` : ""}`, []]
        : [command, args];
      child = spawn(argv[0] as string, argv[1] as string[], {
        cwd: options.cwd,
        shell: options.shell,
        windowsHide: true,
        env,
        // Own process group off Windows, so a timeout kills grandchildren too.
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // 'close' waits for the stdio pipes, and a grandchild that inherited them can keep them
      // open forever after the agent itself is gone — settle after a grace period instead of
      // hanging the whole episode (which is how a timed-out attempt used to leave its live cycle
      // stuck `running` and block dreaming indefinitely).
      grace = setTimeout(() => finish({}), 2000);
    }, options.timeoutMs);

    // A missing agent CLI must not read as a silent hang: say which command was not found and how the
    // task can pin it, because the runner resolves `pi` itself and only falls back to PATH otherwise.
    child.on("error", (error: NodeJS.ErrnoException) => finish({ spawnError: describeSpawnError(error, options.shell) }));
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutTail = append(stdoutTail, text);
      if (logStream && logStream.writable) logStream.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = append(stderrTail, text);
      if (logStream && logStream.writable) logStream.write(text);
    });
    child.on("close", (code, signal) => finish({ ok: code === 0 && !timedOut, code, signal }));

    // An agent that exits before reading its prompt closes the pipe; the EPIPE is an outcome of the
    // attempt (recorded from its exit code), never a reason to take down the host running the loop.
    child.stdin?.on("error", () => {});
    if (child.stdin) {
      if (options.stdin === undefined) child.stdin.end();
      else child.stdin.end(options.stdin);
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
 * Entry-point file names the pi CLI is launched from under node/bun: `dist/cli.js`, the bundled
 * `dist/bundle/cli.js` / `cli-runtime.js`, the RPC entry, or their TypeScript sources in a checkout.
 * `argv1` is pi's own entry point only when it carries one of these names.
 */
const PI_ENTRY_BASENAME = /^(cli|cli-runtime|rpc-entry)\.(js|cjs|mjs|ts|tsx)$/i;

/**
 * The invocation that re-runs the pi CLI hosting this extension.
 *
 * A bare `pi` depends on PATH/shim resolution and fails when pi is not on the child's PATH (or is only a
 * shell shim on Windows). Resolve the running executable instead — node/bun + the running cli.js, or the
 * compiled pi binary — mirroring pi's own subagent example. Returns null when not running inside pi so a
 * caller (SDK host, tests) falls back to `pi`.
 *
 * `PI_CODING_AGENT`/`AI_AGENT` only prove that pi is *somewhere* up the process tree: pi sets them on the
 * CLI and RPC entries and every child inherits them. `argv1` alone therefore does not prove this process
 * *is* pi, so it is only re-run when it is a pi entry point (`PI_ENTRY_BASENAME`). Without that check an
 * embedding host (a web/session daemon, a test runner, anything started from inside pi) would be spawned
 * as the discovery agent, sit there producing no output, and burn the whole attempt timeout as a silent
 * `timeout` with an empty `agent.log`.
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
  const isPiEntry =
    typeof argv1 === "string" && argv1 !== "" && PI_ENTRY_BASENAME.test(path.basename(argv1));
  if (isPiEntry && !isBunVirtualScript && exists(argv1)) {
    // rpc-entry hardcodes `--mode rpc` ahead of our `-p`, and rpc mode wins over print mode —
    // spawned that way the "agent" waits for JSON-RPC frames on stdin, writes nothing, and burns
    // the attempt as a silent timeout with an empty agent.log. Re-run the CLI entry next to it
    // (dist/cli.js sits beside rpc-entry.js) so the prompt is actually processed.
    if (/^rpc-entry\./i.test(path.basename(argv1))) {
      const ext = path.extname(argv1);
      for (const name of ["cli", "cli-runtime"]) {
        const sibling = path.join(path.dirname(argv1), `${name}${ext}`);
        if (exists(sibling)) return { command: execPath, args: [sibling] };
      }
      return null;
    }
    return { command: execPath, args: [argv1] };
  }
  const execName = path.basename(execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: execPath, args: [] };
  return null;
}

/**
 * Run one discovery attempt / policy revision. `agent.env` (task.json's `agent.env`) is merged over the
 * stripped inherited environment, so a task can hand the agent a variable it genuinely needs.
 */
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
  const env = { ...(agent.env ?? {}), ...(options.env ?? {}) };
  if (agent.prompt_via === "arg") {
    return collect(command, [...invocationArgs, options.prompt], { ...options, shell, env });
  }
  return collect(command, invocationArgs, { ...options, shell, env, stdin: options.prompt });
}

/**
 * Turn a spawn failure into something the operator can act on.
 *
 * With `shell: false` the command was resolved by the runner or by PATH, so `ENOENT` means the agent CLI
 * is genuinely unreachable — the state where a bare `spawn pi ENOENT` in `error.txt` reads as "Dream-RSI
 * is broken" instead of "pin the agent command". With a shell the message already names the command.
 */
export function describeSpawnError(error: NodeJS.ErrnoException, shell: boolean): string {
  if (error.code !== "ENOENT" || shell) return error.message;
  return `${error.message} — the agent CLI is not on this process's PATH; set agent.command to an absolute path in .dream-rsi/task.json`;
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
