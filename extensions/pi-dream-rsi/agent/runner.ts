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
import { StringDecoder } from "node:string_decoder";
import { OutputDecoder, type AgentOutputEvidence, type OutputEvent } from "./output.ts";

import { THINKING_LEVELS, type AgentConfig } from "../engine/task.ts";

const TAIL_BYTES = 64 * 1024;
const AGENT_LOG_BYTES = 50 * 1024;
/** cmd.exe text for a command it could not resolve; shell:true otherwise reports only the exit code. */
const WINDOWS_MISSING_COMMAND = /(?:is not recognized as an internal or external command|The system cannot find the (?:file|path) specified)/i;

export interface CommandResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutKind?: "wall" | "idle";
  idleMs?: number;
  lastOutputAgeMs?: number;
  /** True when the caller's AbortSignal cancelled the run (the tree was killed). */
  aborted?: boolean;
  /** Spawn failure (missing executable, EINVAL, …). */
  spawnError: string | null;
  /** Set when the log stream failed (disk full, permission): a controlled outcome, not a crash. */
  logError?: string | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  logPath: string | null;
  /**
   * Whether the process emitted any stdout or stderr bytes. Recorded for newly
   * executed attempts so timeout diagnostics can distinguish silent hangs from
   * slow ones. Absent in older serialized results: callers must fall back to
   * checking `stdoutTail`/`stderrTail` instead of inferring silence.
   */
  hadOutput?: boolean;
  /** Structural, content-free telemetry decoded from pi JSONL output. */
  evidence?: AgentOutputEvidence;
  /** How this process's output was decoded: `pi-json` or plain text. */
  outputFormat?: "text" | "pi-json";
  /** The executable and model this process actually used, including a child default. */
  effectiveAgent?: EffectiveAgent;
}

/** What a spawned agent really ran, as opposed to what the saved task asked for. */
export interface EffectiveAgent {
  command: string;
  model: string | null;
  /** Where the model came from; `child-default` means no model was resolved. */
  modelSource: "session" | "saved" | "child-default";
}

export interface RunOptions {
  onOutput?: (event: OutputEvent) => void;
  /** Synchronous durable budget reservation immediately before the child process is spawned. */
  beforeSpawn?: () => void;
  /** Durable child ownership; unlike output observers, errors cancel execution. */
  onSpawn?: (pid: number) => void;
  outputFormat?: "text" | "pi-json";
  cwd: string;
  timeoutMs: number;
  /** Optional inactivity timeout reset whenever stdout or stderr emits bytes. */
  idleTimeoutMs?: number;
  logPath?: string | null;
  env?: Record<string, string>;
  /**
   * Do not inherit the parent environment at all; use only `env`. Probes,
   * instruments and gates for an unvetted repository run this way so provider
   * keys, tokens and session identity cannot reach them.
   */
  envOnly?: boolean;
  /** Kill the whole process tree, not just the direct child. */
  killTree?: boolean;
  /** Cancellation: aborting kills the process tree and resolves once it is gone. */
  signal?: AbortSignal;
  /** Exact verifier files whose reads should be counted; paths are never retained in evidence. */
  protectedReadPaths?: string[];
  /** Store decoded, bounded presentation text and tool names instead of raw JSONL. */
  compactAgentLog?: boolean;
  /** Persist process-level accounting after output decoding and duration measurement. */
  onComplete?: (result: CommandResult) => void;
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
  options: RunOptions & { shell: boolean; stdin?: string; quoteExecutable?: boolean },
): Promise<CommandResult> {
  const started = Date.now();
  if (options.logPath) fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
  const compactAgentLog = options.compactAgentLog ?? false;
  const logStream = options.logPath && !compactAgentLog
    ? fs.createWriteStream(options.logPath, { flags: "a" })
    : null;
  // A disk-full or permission error on the log must not crash the host: record it as an outcome.
  let logError: string | null = null;
  // Flush (or fail) the log before reporting the result, so a caller that reads the log right after
  // `runAgent`/`runShellCommand` resolves sees everything the child wrote.
  const logClosed: Promise<void> = logStream
    ? new Promise<void>((resolve) => {
        let done = false;
        const settle = (): void => {
          if (done) return;
          done = true;
          resolve();
        };
        logStream.on("error", (error: Error) => {
          logError = error.message;
          settle();
        });
        logStream.on("close", settle);
      })
    : Promise.resolve();
  // Observer failures cannot change execution or the score.
  const evidence: AgentOutputEvidence = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, stopReasons: {}, modelChanges: 0, editCount: 0, verifierRead: false, errorCount: 0, terminalError: false, assistantText: false };
  let lastModel: string | undefined;
  let compactLog = Buffer.alloc(0);
  const appendCompactLog = (line: string, newline = true): void => {
    const combined = Buffer.concat([compactLog, Buffer.from(newline ? `${line}\n` : line, "utf8")]);
    compactLog = combined.length > AGENT_LOG_BYTES ? combined.subarray(combined.length - AGENT_LOG_BYTES) : combined;
    while (compactLog.length && (compactLog[0]! & 0xc0) === 0x80) compactLog = compactLog.subarray(1);
  };
  const compactText = (text: string): string => (options.protectedReadPaths ?? []).reduce((safe, file) => {
    const absolute = path.resolve(options.cwd, file);
    const variants = new Set([file, absolute, absolute.replaceAll("\\", "/"), absolute.replaceAll("/", "\\")]);
    return [...variants].filter(Boolean).reduce((current, value) => current.split(value).join("[protected path]"), safe);
  }, text);
  const decoder = new OutputDecoder(options.outputFormat === "pi-json", (event) => {
    if (compactAgentLog) {
      if (event.kind === "text" && event.text) appendCompactLog(compactText(event.text), false);
      else if (event.kind.startsWith("tool-")) appendCompactLog(`${event.kind} ${event.toolName ?? "tool"}`);
      else if (event.kind === "usage") appendCompactLog(`usage ${event.model ?? ""} ${event.stopReason ?? ""} ${event.usage?.total ?? 0}`.trim());
      else if (event.kind === "agent-error") appendCompactLog(compactText(`agent-error ${event.text.slice(0, 500)}`));
    }
    if (event.kind === "text" && event.assistant && event.text.trim()) evidence.assistantText = true;
    if (event.kind === "agent-error") evidence.errorCount += 1;
    if (event.kind === "agent-outcome") evidence.terminalError = event.terminalError === true;
    if (event.kind === "usage") {
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) evidence.usage[key] += event.usage?.[key] ?? 0;
      if (event.stopReason) evidence.stopReasons[event.stopReason] = (evidence.stopReasons[event.stopReason] ?? 0) + 1;
      if (event.model) {
        if (lastModel && lastModel !== event.model) evidence.modelChanges += 1;
        lastModel = event.model;
      }
    }
    if (event.kind === "tool-start" && event.edit) evidence.editCount += 1;
    // A tool's read name is evidence only that a read happened. File paths and arguments are never retained.
    if (event.kind === "tool-start" && event.verifierRead) evidence.verifierRead = true;
    try { options.onOutput?.(event); } catch { /* presentation only */ }
  }, { protectedReadPaths: options.protectedReadPaths, cwd: options.cwd });
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdoutTail = "";
  let stderrTail = "";
  // Whether the child emitted any stdout/stderr bytes at all. Tails alone cannot
  // prove this for older results, so record it explicitly for new executions.
  let sawOutput = false;
  const append = (current: string, chunk: string): string => {
    const next = current + chunk;
    return next.length > TAIL_BYTES ? next.slice(next.length - TAIL_BYTES) : next;
  };

  return await new Promise<CommandResult>((resolve, reject) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let timedOut = false;
    let timeoutKind: "wall" | "idle" | undefined;
    let lastOutputAt = started;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: Partial<CommandResult>): void => {
      if (settled) return;
      settled = true;
      evidence.durationMs = Date.now() - started;
      const stdoutEnd = stdoutDecoder.end();
      const stderrEnd = stderrDecoder.end();
      stdoutTail = append(stdoutTail, stdoutEnd); stderrTail = append(stderrTail, stderrEnd);
      decoder.feed("stdout", stdoutEnd); decoder.feed("stderr", stderrEnd); decoder.finish();
      if (compactAgentLog && options.logPath) {
        try { fs.writeFileSync(options.logPath, compactLog, { flag: "w" }); }
        catch (error) { logError = error instanceof Error ? error.message : String(error); }
      }
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (grace) clearTimeout(grace);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        logStream?.end();
      } catch {
        // the stream is already gone; the error listener recorded why
      }
      void logClosed.then(() => {
        // With shell:true, Windows reports a missing executable only as cmd.exe text plus a
        // non-zero exit code; without this, a missing agent looks like an ordinary failed attempt.
        const shellSpawnError = !result.spawnError && options.shell && process.platform === "win32"
          && (result.code === 1 || result.code === 3 || result.code === 9009)
          && WINDOWS_MISSING_COMMAND.test(stderrTail)
          ? `command not found: ${command} — check the executable name or install it on PATH`
          : null;
        const completed: CommandResult = {
          ok: false,
          code: null,
          signal: null,
          timedOut,
          ...(timeoutKind ? { timeoutKind } : {}),
          ...(options.idleTimeoutMs ? { idleMs: Date.now() - lastOutputAt, lastOutputAgeMs: Date.now() - lastOutputAt } : {}),
          aborted,
          spawnError: shellSpawnError,
          logError,
          durationMs: Date.now() - started,
          stdoutTail,
          stderrTail,
          logPath: options.logPath ?? null,
          hadOutput: sawOutput,
          evidence,
          outputFormat: options.outputFormat === "pi-json" ? "pi-json" : "text",
          ...result,
        };
        try {
          options.onComplete?.(completed);
        } catch (error) {
          completed.ok = false;
          completed.spawnError = `failed to persist process accounting: ${error instanceof Error ? error.message : String(error)}`;
        }
        resolve(completed);
      });
    };

    /** Cancel: kill the tree, then wait (bounded) for it to actually go away before resolving. */
    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      if (child) killTree(child);
      if (!grace) grace = setTimeout(() => finish({ aborted: true }), 2000);
    };

    try {
      // Session identity is stripped unless the caller re-adds it: a nested attempt must not
      // attach to the session it was spawned from (see STRIPPED_SESSION_ENV).
      const env: NodeJS.ProcessEnv = options.envOnly ? {} : { ...process.env };
      if (!options.envOnly) for (const key of STRIPPED_SESSION_ENV) delete env[key];
      Object.assign(env, options.env ?? {});
      // With a shell, quote each argument before joining it. Agent executables can opt into quoting;
      // runShellCommand keeps its caller-owned command line intact.
      const commandText = options.quoteExecutable ? quoteForShell(command) : command;
      const argv = options.shell
        ? [`${commandText}${args.length ? ` ${args.map(quoteForShell).join(" ")}` : ""}`, []]
        : [command, args];
      try { options.beforeSpawn?.(); }
      catch (error) {
        logStream?.end();
        reject(error);
        return;
      }
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

    const running = child;
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutRun = (kind: "wall" | "idle"): void => {
      if (settled || timedOut) return;
      timedOut = true;
      timeoutKind = kind;
      killTree(running);
      // A grandchild can inherit stdio after the agent exits; bound the wait for pipe closure.
      grace = setTimeout(() => finish({}), 2000);
    };
    timer = setTimeout(() => timeoutRun("wall"), options.timeoutMs);
    const resetIdleTimer = (): void => {
      if (!options.idleTimeoutMs) return;
      lastOutputAt = Date.now();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => timeoutRun("idle"), options.idleTimeoutMs);
    };
    if (options.idleTimeoutMs) idleTimer = setTimeout(() => timeoutRun("idle"), options.idleTimeoutMs);

    // A missing agent CLI must not read as a silent hang: say which command was not found and how the
    // task can pin it, because the runner resolves `pi` itself and only falls back to PATH otherwise.
    running.on("error", (error: NodeJS.ErrnoException) => finish({ spawnError: describeSpawnError(error, options.shell) }));
    // Respect backpressure: a slow/failed log pauses the child's stream until it drains, so heavy
    // output cannot accumulate unbounded in memory (the OS pipe throttles the child in turn).
    const writeLog = (source: NodeJS.ReadableStream, text: string | Buffer): void => {
      if (!logStream || !logStream.writable || logStream.destroyed) return;
      if (!logStream.write(text)) {
        source.pause();
        logStream.once("drain", () => source.resume());
      }
    };
    running.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.length > 0) { sawOutput = true; resetIdleTimer(); }
      const text = stdoutDecoder.write(chunk);
      decoder.feed("stdout", text);
      stdoutTail = append(stdoutTail, text);
      writeLog(running.stdout as NodeJS.ReadableStream, chunk);
    });
    running.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.length > 0) { sawOutput = true; resetIdleTimer(); }
      const text = stderrDecoder.write(chunk);
      decoder.feed("stderr", text);
      stderrTail = append(stderrTail, text);
      writeLog(running.stderr as NodeJS.ReadableStream, chunk);
    });
    running.on("close", (code, signal) => finish({ ok: code === 0 && !timedOut && !aborted, code, signal }));
    if (running.pid !== undefined) {
      try { options.onSpawn?.(running.pid); } catch { onAbort(); }
    }

    // An agent that exits before reading its prompt closes the pipe; the EPIPE is an outcome of the
    // attempt (recorded from its exit code), never a reason to take down the host running the loop.
    running.stdin?.on("error", () => {});
    if (running.stdin) {
      if (options.stdin === undefined) running.stdin.end();
      else running.stdin.end(options.stdin);
    }
    // An already-aborted signal never fires 'abort': cancel the freshly spawned child explicitly.
    if (options.signal?.aborted) onAbort();
  });
}

/** Run a task's evaluator. `command` is a shell command line by design (task-controlled). */
export function runShellCommand(command: string, options: RunOptions): Promise<CommandResult> {
  return collect(command, [], { ...options, shell: true });
}

export interface AgentRun extends RunOptions {
  agent: AgentConfig;
  /** Resolve the saved agent against the active session immediately before this process starts. */
  resolveAgent?: (saved: AgentConfig) => AgentConfig | null;
  prompt: string;
}

/**
 * Build the argument vector for one attempt (or one policy revision).
 *
 * `{model}` is substituted where present; when a model is configured but the arguments carry no
 * placeholder, `--model <id>` is appended — otherwise the configured model is silently ignored and
 * every attempt runs on whatever default the agent CLI happens to have.
 */
export function buildAgentArgs(agent: AgentConfig, options: { overrideExplicit?: boolean } = {}): string[] {
  const hasModelPlaceholder = agent.args.some((arg) => arg.includes("{model}"));
  const hasThinkingPlaceholder = agent.args.some((arg) => arg.includes("{thinking}"));
  let args = agent.args.map((arg) =>
    arg.replaceAll("{model}", agent.model ?? "").replaceAll("{thinking}", agent.thinking ?? ""),
  );
  if (options.overrideExplicit) {
    const replaced: string[] = [];
    let sawModel = false;
    let sawThinking = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === undefined) break;
      if (arg.startsWith("--model=")) {
        sawModel = true;
        replaced.push(agent.model ? `--model=${agent.model}` : arg);
      } else if (arg === "--model") {
        sawModel = true;
        const next = args[index + 1];
        replaced.push(arg);
        if (next !== undefined && !next.startsWith("-")) {
          replaced.push(agent.model ?? next);
          index += 1;
        } else if (agent.model) replaced.push(agent.model);
      } else if (arg.startsWith("--thinking=")) {
        sawThinking = true;
        replaced.push(agent.thinking ? `--thinking=${agent.thinking}` : arg);
      } else if (arg === "--thinking") {
        sawThinking = true;
        const next = args[index + 1];
        replaced.push(arg);
        if (next !== undefined && !next.startsWith("-")) {
          replaced.push(agent.thinking ?? next);
          index += 1;
        } else if (agent.thinking) replaced.push(agent.thinking);
      } else replaced.push(arg);
    }
    args = replaced;
    if (agent.model && !sawModel && !hasModelPlaceholder) args.push("--model", agent.model);
    if (agent.thinking && !sawThinking && !hasThinkingPlaceholder) args.push("--thinking", agent.thinking);
  } else {
    if (agent.model && !hasModelPlaceholder) args.push("--model", agent.model);
    // Same rule as the model: an explicit `--thinking` in `args` wins, a placeholder is already filled.
    if (agent.thinking && !hasThinkingPlaceholder && !args.includes("--thinking")) {
      args.push("--thinking", agent.thinking);
    }
  }
  const explicitMode = args.some((arg) => arg === "--mode" || arg.startsWith("--mode="));
  if (!explicitMode && (agent.output_format === "pi-json" || (agent.command === "pi" && agent.output_format !== "text"))) args.push("--mode", "json");
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
 * The model an argument list selects, if any. A task may pin the model in its own
 * command line (`--model provider/model` or `--model=provider/model`) instead of
 * in the `model` field.
 */
function modelFromArgs(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--model") {
      const value = args[index + 1];
      return value && !value.startsWith("-") ? value : null;
    }
    if (argument.startsWith("--model=")) {
      const value = argument.slice("--model=".length);
      return value ? value : null;
    }
  }
  return null;
}

/**
 * Run one discovery attempt / policy revision. `agent.env` (task.json's `agent.env`) is merged over the
 * stripped inherited environment, so a task can hand the agent a variable it genuinely needs.
 */
export function runAgent(options: AgentRun): Promise<CommandResult> {
  const resolved = options.resolveAgent?.(options.agent) ?? null;
  const agent = resolved ?? options.agent;
  // The default `pi` agent re-spawns the running pi invocation, so it never depends on PATH. A custom
  // command keeps the platform shell so Windows .cmd/.bat shims still resolve.
  const self = agent.command === "pi" ? piSelfInvocation() : null;
  const command = self ? self.command : agent.command;
  const args = buildAgentArgs(agent, { overrideExplicit: resolved !== null });
  // A configured model can also travel as an explicit argument. Without this the status would
  // claim a child default while the child really ran with that model.
  const argumentModel = modelFromArgs(args);
  const effectiveAgent: EffectiveAgent = {
    command,
    model: agent.model ?? argumentModel,
    modelSource: agent.model ? (resolved ? "session" : "saved") : argumentModel ? "saved" : "child-default",
  };
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
      hadOutput: false,
      effectiveAgent,
    });
  }
  const invocationArgs = self ? [...self.args, ...args] : args;
  const shell = self ? false : process.platform === "win32";
  const modeIndex = args.indexOf("--mode");
  const json = agent.output_format === "pi-json" || (agent.output_format !== "text" &&
    (args.includes("--mode=json") || (modeIndex >= 0 && args[modeIndex + 1] === "json")));
  options = { ...options, outputFormat: json ? "pi-json" : "text", compactAgentLog: true };
  const env = { ...(agent.env ?? {}), ...(options.env ?? {}) };
  const userOnComplete = options.onComplete;
  const withEffectiveAgent = (result: CommandResult): void => {
    result.effectiveAgent = effectiveAgent;
    userOnComplete?.(result);
  };
  if (agent.prompt_via === "arg") {
    return collect(command, [...invocationArgs, options.prompt], { ...options, shell, quoteExecutable: shell, env, onComplete: withEffectiveAgent });
  }
  return collect(command, invocationArgs, { ...options, shell, quoteExecutable: shell, env, stdin: options.prompt, onComplete: withEffectiveAgent });
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
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  const normalizedCandidate = process.platform === "win32" ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const normalizedParent = process.platform === "win32" ? resolvedParent.toLowerCase() : resolvedParent;
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(normalizedParent + path.sep);
}

/** Bounded async work queue: at most `max` copies in flight, so a large workspace cannot flood the
 *  filesystem or the libuv threadpool. */
function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      active += 1;
      next();
    }
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiters.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const COPY_CONCURRENCY = 8;

/**
 * Recursive copy that can skip subtrees, asynchronously and with bounded concurrency.
 *
 * `fs.cpSync` cannot do this job: it rejects a destination nested inside the source
 * (`ERR_FS_CP_EINVAL: cannot copy to a subdirectory of self`) before any filter runs, and
 * `workspace: "."` makes the attempt workspaces exactly that. Walking the tree explicitly also
 * makes both rules obvious: never descend into the destination, never descend into an excluded root.
 *
 * `seen` holds the real paths on the current descent, so dereferencing a directory symlink (the
 * Windows fallback when symlink creation is denied) cannot follow a link back into an ancestor and
 * recurse forever — the old fallback re-walked the same symlink path and overflowed the stack.
 */
async function copyTree(
  from: string,
  to: string,
  skip: (resolved: string) => boolean,
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
  seen: Set<string>,
): Promise<void> {
  const stats = await fs.promises.lstat(from);
  if (stats.isDirectory()) {
    let real: string;
    try {
      real = await fs.promises.realpath(from);
    } catch {
      real = path.resolve(from);
    }
    if (seen.has(real)) return; // symlink cycle: never re-enter a directory already on this path
    const nested = new Set(seen);
    nested.add(real);
    await fs.promises.mkdir(to, { recursive: true });
    const entries = await fs.promises.readdir(from, { withFileTypes: true });
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
          const childFrom = path.join(from, entry.name);
          const childTo = path.join(to, entry.name);
          // Only the source side is tested: children of the destination are trivially "inside" it.
          if (skip(path.resolve(childFrom))) return;
          await copyTree(childFrom, childTo, skip, limit, nested);
        }),
    );
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    return;
  }
  if (stats.isSymbolicLink()) {
    const linkTarget = await fs.promises.readlink(from);
    try {
      await fs.promises.symlink(linkTarget, to);
      return;
    } catch {
      // No symlink privilege (typical on Windows without developer mode): copy what it points at.
      // Dereference to the real target and walk *that*, so the fallback cannot re-enter the same
      // symlink path (which used to recurse until the stack overflowed).
      const real = await fs.promises.realpath(from);
      if (skip(path.resolve(real))) return;
      const targetStats = await fs.promises.stat(real);
      if (targetStats.isDirectory()) await copyTree(real, to, skip, limit, seen);
      else await limit(() => fs.promises.copyFile(real, to));
    }
    return;
  }
  await limit(() => fs.promises.copyFile(from, to));
}

/**
 * Copy a workspace asynchronously. The copy is bounded, so a big workspace no longer blocks the host
 * event loop for the whole attempt-preparation window; `exclude` keeps dependencies/build artifacts
 * out when the task names them.
 */
export async function copyWorkspace(from: string, to: string, options: CopyWorkspaceOptions = {}): Promise<void> {
  const source = path.resolve(from);
  const destination = path.resolve(to);
  if (isInside(source, destination)) throw new Error("workspace destination cannot be the source root or one of its ancestors");
  const excluded = (options.exclude ?? [])
    .map((entry) => path.resolve(entry))
    .filter((entry) => !isInside(source, entry));
  await fs.promises.rm(to, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await copyTree(
    from,
    to,
    (resolved) => {
      if (isInside(resolved, destination)) return true;
      return excluded.some((root) => isInside(resolved, root));
    },
    createLimiter(COPY_CONCURRENCY),
    new Set(),
  );
}

/** PID plus process birth identity prevents stale recovery records killing a reused PID. */
export function childIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return `linux:${fields[19]}`;
    }
    if (process.platform === "win32") return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$dreamProcess = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($dreamProcess) { $dreamProcess.StartTime.ToUniversalTime().Ticks.ToString() }`], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).trim() || null;
  } catch { return null; }
}
export interface OwnedChild { pid: number; identity: string | null; children?: OwnedChild[] }
/** Windows shell wrappers can exit before their agent; save the agent's own birth identity too. */
export function childOwnership(pid: number): OwnedChild {
  if (process.platform !== "win32") return { pid, identity: childIdentity(pid) };
  try {
    const script = `
function Get-DreamIdentity($dreamPid) {
  $dreamProcess = Get-Process -Id $dreamPid -ErrorAction SilentlyContinue
  if ($dreamProcess) { return $dreamProcess.StartTime.ToUniversalTime().Ticks.ToString() }
  return $null
}
$dreamAll = @(Get-CimInstance Win32_Process)
$dreamQueue = [System.Collections.Generic.Queue[int]]::new()
$dreamQueue.Enqueue(${pid})
$dreamChildren = @()
$dreamSeen = @{}
while ($dreamQueue.Count -gt 0) {
  $dreamParent = $dreamQueue.Dequeue()
  if ($dreamSeen.ContainsKey($dreamParent)) { continue }
  $dreamSeen[$dreamParent] = $true
  foreach ($dreamChild in $dreamAll) {
    if ($dreamChild.ParentProcessId -eq $dreamParent) {
      $dreamChildren += @{pid=[int]$dreamChild.ProcessId; identity=(Get-DreamIdentity $dreamChild.ProcessId)}
      $dreamQueue.Enqueue([int]$dreamChild.ProcessId)
    }
  }
}
@{pid=${pid}; identity=(Get-DreamIdentity ${pid}); children=@($dreamChildren)} | ConvertTo-Json -Compress -Depth 5`;
    return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch { return { pid, identity: childIdentity(pid) }; }
}
export async function stopRecoveredChild(child: OwnedChild): Promise<void> {
  for (const descendant of child.children ?? []) await stopRecoveredChild(descendant);
  const current = childIdentity(child.pid);
  if (!current) {
    try { process.kill(child.pid, 0); }
    catch { return; }
    throw new Error(`cannot verify interrupted child ${child.pid}; wait for it to exit before resuming`);
  }
  if (current !== child.identity) {
    if (!child.identity && current) throw new Error(`cannot verify interrupted child ${child.pid}; wait for it to exit before resuming`);
    return; // exited, zombie, or PID belongs to a different process
  }
  killTree({ pid: child.pid } as ChildProcess);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (childIdentity(child.pid) !== current) return;
    if (process.platform === "linux") {
      try {
        const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return;
      } catch { return; }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`interrupted child ${child.pid} did not stop`);
}
