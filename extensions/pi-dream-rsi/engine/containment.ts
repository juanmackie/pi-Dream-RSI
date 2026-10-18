/** OS-enforced process containment for repository-owned commands. */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { StringDecoder } from "node:string_decoder";

export class ContainmentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainmentUnavailableError";
  }
}

export interface ContainmentSupport {
  available: boolean;
  backend: "process" | null;
  reason: string | null;
}

export interface ContainedCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  /** Only these roots are writable inside the process container. */
  writableRoots: string[];
  /** Explicit runtime/tool roots, read-only inside the process container. */
  readonlyRoots?: string[];
  /** Non-secret environment values only. Secret-like keys are always removed. */
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

/** Opt-in policy for repository commands and agents run in disposable workspaces. */
export interface RepositoryCommandContainment {
  /** Additional read-only tool/runtime roots required by repository commands. PATH roots are added automatically. */
  readonlyRoots?: string[];
}

/** Give one process only its disposable workspace as a writable root. */
export function workspaceContainment(
  policy: RepositoryCommandContainment | undefined,
  workspace: string,
): { writableRoots: string[]; readonlyRoots?: string[] } | undefined {
  if (!policy) return undefined;
  return {
    writableRoots: [path.resolve(workspace)],
    ...(policy.readonlyRoots ? { readonlyRoots: [...policy.readonlyRoots] } : {}),
  };
}

export interface ContainedCommandResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError: string | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  warnings: string[];
}

const OUTPUT_TAIL_CHARS = 64 * 1024;
const SECRET_ENV_KEY = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|AUTHORIZATION|COOKIE)/i;

interface MxcRunRequest {
  containment: { type: "process" };
  command: string;
  workingDirectory: string;
  timeoutMs: number;
  filesystem: { readwritePaths: string[]; readonlyPaths?: string[] };
  network: { egress: { default: "deny" }; ingress: { default: "deny"; hostLoopback: "deny" } };
  environment: Record<string, string>;
  inheritDefaultEnvironment: false;
}

interface MxcRuntime {
  getPlatformSupport(): unknown;
  getAvailableBackends(): unknown;
  run(request: MxcRunRequest): Promise<unknown>;
  spawn?(request: MxcRunRequest): Promise<unknown>;
}

interface MxcExecutionResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  warnings: string[];
}

interface MxcProcess {
  id: number;
  standardInput: { write(value: string): unknown; end(): unknown } | null;
  standardOutput: AsyncIterable<Uint8Array> | null;
  standardError: AsyncIterable<Uint8Array> | null;
  warnings: readonly string[];
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  kill(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMxcRuntime(value: unknown): value is MxcRuntime {
  return isRecord(value) && typeof value.getPlatformSupport === "function"
    && typeof value.getAvailableBackends === "function" && typeof value.run === "function";
}

function isExecutionResult(value: unknown): value is MxcExecutionResult {
  return isRecord(value) && typeof value.exitCode === "number" && Number.isInteger(value.exitCode)
    && typeof value.timedOut === "boolean" && typeof value.stdout === "string"
    && typeof value.stderr === "string" && Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === "string");
}

function isMxcProcess(value: unknown): value is MxcProcess {
  return isRecord(value) && typeof value.id === "number" && Number.isInteger(value.id)
    && (value.standardInput === null || isRecord(value.standardInput))
    && (value.standardOutput === null || isRecord(value.standardOutput))
    && (value.standardError === null || isRecord(value.standardError))
    && Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === "string")
    && typeof value.wait === "function" && typeof value.kill === "function";
}

function absoluteRoots(roots: readonly string[] | undefined): string[] {
  const normalized = [...new Set((roots ?? []).map((root) => path.resolve(root)))];
  if (normalized.some((root) => !path.isAbsolute(root))) throw new ContainmentUnavailableError("sandbox filesystem roots must be absolute");
  return normalized;
}

function hostToolRoots(): string[] {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.dirname(process.execPath),
    ...(systemRoot ? [systemRoot] : []),
  ].map((root) => root.trim()).filter(Boolean).map((root) => path.resolve(root));
  return [...new Set(candidates)].filter((root) => fs.existsSync(root) && path.dirname(root) !== root);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sanitizeEnvironment(env: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || SECRET_ENV_KEY.test(key) || /^(PI_SESSION_ID|PI_SESSION_FILE|PI_WEB_SESSION|NODE_OPTIONS)$/i.test(key)) continue;
    if (value.includes("\0")) throw new ContainmentUnavailableError(`sandbox environment value for ${key} contains a NUL byte`);
    result[key] = value;
  }
  return result;
}

function sandboxEnvironment(env: Record<string, string> | undefined): Record<string, string> {
  const required: Record<string, string> = {};
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (systemRoot) required.SYSTEMROOT = systemRoot;
  if (process.env.LOCALAPPDATA) required.LOCALAPPDATA = process.env.LOCALAPPDATA;
  if (process.env.PATH) required.PATH = process.env.PATH;
  if (process.env.ComSpec) required.ComSpec = process.env.ComSpec;
  return sanitizeEnvironment({ ...required, ...env });
}

async function sdk(): Promise<MxcRuntime> {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new ContainmentUnavailableError("the installed MXC process-container runtime requires Node.js 24 or later");
  }
  try {
    const moduleName = "@microsoft/mxc-sdk/v1";
    const loaded: unknown = await import(moduleName);
    if (!isMxcRuntime(loaded)) throw new Error("the MXC SDK did not expose the required V1 sandbox interface");
    return loaded;
  } catch (error) {
    throw new ContainmentUnavailableError(`the optional MXC containment runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Probe the real host backend. Export presence alone is not an availability check. */
export async function getContainmentSupport(): Promise<ContainmentSupport> {
  let runtime: Awaited<ReturnType<typeof sdk>>;
  try { runtime = await sdk(); }
  catch (error) {
    return { available: false, backend: null, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const platform = runtime.getPlatformSupport();
    const backends = runtime.getAvailableBackends();
    if (!isRecord(platform) || typeof platform.isSupported !== "boolean" || typeof platform.reason !== "string" || !Array.isArray(backends)) {
      return { available: false, backend: null, reason: "the MXC host probe returned an invalid response" };
    }
    const backend = backends.find((entry) => isRecord(entry) && typeof entry.backend === "string"
      && ["processcontainer", "bubblewrap", "seatbelt"].includes(entry.backend));
    if (!platform.isSupported || !backend) {
      return {
        available: false,
        backend: null,
        reason: platform.reason || "no OS-enforced process-containment backend is available on this host",
      };
    }
    return { available: true, backend: "process", reason: null };
  } catch (error) {
    return { available: false, backend: null, reason: `the host containment probe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Managed agent containment needs streaming stdio and a real Node launch inside this host session. */
export async function getAgentContainmentSupport(): Promise<ContainmentSupport> {
  if (process.platform === "win32") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    const supported = (major === 24 && minor >= 21) || (major >= 26 && (major > 26 || minor >= 8));
    if (!supported) {
      return { available: false, backend: null, reason: `managed MXC agent processes on Windows require Node.js 24.21+ or 26.8+; current version is ${process.versions.node}` };
    }
  }
  const support = await getContainmentSupport();
  if (!support.available) return support;
  try {
    const runtime = await sdk();
    if (typeof runtime.spawn !== "function") {
      return { available: false, backend: null, reason: "the MXC runtime does not expose managed process containment" };
    }
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-agent-preflight-"));
    try {
      const result = await runContainedCommand({
        command: "node.exe --version",
        cwd: workspace,
        timeoutMs: 5_000,
        writableRoots: [workspace],
      });
      if (!result.ok) {
        const detail = result.stderrTail.trim().split(/\r?\n/, 1)[0] || `exit code ${result.code}`;
        const reason = result.code === -1073741502
          ? `MXC can start cmd.exe, but the contained Node runtime exited with STATUS_DLL_INIT_FAILED (${detail}). This is consistent with BaseContainer rejecting USER32-dependent workloads from a non-interactive Windows session; agent containment requires an interactive session or a backend that passes the Node-start canary.`
          : `the OS container could not start the Node runtime required by repository agents: ${detail}`;
        return { available: false, backend: null, reason };
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
    return support;
  } catch (error) {
    return { available: false, backend: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run a command inside the platform's OS process container with no network
 * egress and explicit writable/read-only roots. Missing backends fail closed.
 */
export async function runContainedCommand(options: ContainedCommandOptions): Promise<ContainedCommandResult> {
  const cwd = path.resolve(options.cwd);
  const writableRoots = absoluteRoots(options.writableRoots);
  const readonlyRoots = absoluteRoots([...hostToolRoots(), ...(options.readonlyRoots ?? [])]);
  if (writableRoots.length === 0 || !writableRoots.some((root) => inside(root, cwd))) {
    throw new ContainmentUnavailableError("the command working directory must be inside an explicit sandbox writable root");
  }
  if (!options.command.trim()) throw new ContainmentUnavailableError("the contained command is empty");

  const support = await getContainmentSupport();
  if (!support.available) throw new ContainmentUnavailableError(support.reason ?? "no containment backend is available");

  const runtime = await sdk();
  const startedAt = Date.now();
  const request: MxcRunRequest = {
    containment: { type: "process" },
    command: process.platform === "win32" ? `cmd.exe /d /s /c ${options.command}` : `/bin/sh -c ${JSON.stringify(options.command)}`,
    workingDirectory: cwd,
    timeoutMs: options.timeoutMs,
    filesystem: {
      readwritePaths: writableRoots,
      ...(readonlyRoots.length ? { readonlyPaths: readonlyRoots } : {}),
    },
    network: {
      egress: { default: "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
    },
    environment: sandboxEnvironment(options.env),
    inheritDefaultEnvironment: false,
  };
  const managedLifecycle = options.stdin !== undefined || options.signal !== undefined || options.onSpawn !== undefined || options.onOutput !== undefined;
  if (!managedLifecycle) {
    try {
      const raw: unknown = await runtime.run(request);
      if (!isExecutionResult(raw)) throw new Error("the MXC runtime returned an invalid execution result");
      return {
        ok: raw.exitCode === 0 && !raw.timedOut,
        code: raw.exitCode,
        timedOut: raw.timedOut,
        aborted: false,
        spawnError: null,
        durationMs: Date.now() - startedAt,
        stdoutTail: raw.stdout.slice(-OUTPUT_TAIL_CHARS),
        stderrTail: raw.stderr.slice(-OUTPUT_TAIL_CHARS),
        warnings: [...raw.warnings],
      };
    } catch (error) {
      return {
        ok: false, code: null, timedOut: false, aborted: false,
        spawnError: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt, stdoutTail: "", stderrTail: "", warnings: [],
      };
    }
  }
  if (typeof runtime.spawn !== "function") {
    return { ok: false, code: null, timedOut: false, aborted: false, spawnError: "the MXC runtime does not expose managed process containment", durationMs: Date.now() - startedAt, stdoutTail: "", stderrTail: "", warnings: [] };
  }
  let aborted = false;
  let child: MxcProcess | null = null;
  let stdoutTail = "";
  let stderrTail = "";
  const append = (tail: string, chunk: string): string => (tail + chunk).slice(-OUTPUT_TAIL_CHARS);
  const drain = async (stream: AsyncIterable<Uint8Array> | null, name: "stdout" | "stderr"): Promise<void> => {
    if (!stream) return;
    const decoder = new StringDecoder("utf8");
    const consume = (text: string): void => {
      if (!text) return;
      if (name === "stdout") stdoutTail = append(stdoutTail, text);
      else stderrTail = append(stderrTail, text);
      try { options.onOutput?.(name, text); } catch { /* output observers cannot change execution */ }
    };
    for await (const chunk of stream) consume(decoder.write(Buffer.from(chunk)));
    consume(decoder.end());
  };
  const abort = (): void => {
    aborted = true;
    child?.kill();
  };
  if (options.signal?.aborted) {
    return { ok: false, code: null, timedOut: false, aborted: true, spawnError: null, durationMs: Date.now() - startedAt, stdoutTail, stderrTail, warnings: [] };
  }
  try {
    const rawChild: unknown = await runtime.spawn(request);
    if (!isMxcProcess(rawChild)) throw new Error("the MXC runtime returned an invalid process handle");
    child = rawChild;
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if (options.onSpawn) {
      if (child.id <= 0) throw new Error("the MXC backend did not expose a process id required for child ownership");
      options.onSpawn(child.id);
    }
    if (options.stdin !== undefined && child.standardInput) {
      child.standardInput.write(options.stdin);
      child.standardInput.end();
    } else child.standardInput?.end();
    const output = Promise.all([drain(child.standardOutput, "stdout"), drain(child.standardError, "stderr")]);
    const completion = await child.wait();
    await output;
    return {
      ok: completion.exitCode === 0 && !completion.timedOut && !aborted,
      code: completion.exitCode,
      timedOut: completion.timedOut,
      aborted,
      spawnError: null,
      durationMs: Date.now() - startedAt,
      stdoutTail,
      stderrTail,
      warnings: [...child.warnings],
    };
  } catch (error) {
    if (child) {
      child.kill();
      await child.wait().catch(() => undefined);
    }
    return {
      ok: false,
      code: null,
      timedOut: false,
      aborted,
      spawnError: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      stdoutTail,
      stderrTail,
      warnings: child ? [...child.warnings] : [],
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
