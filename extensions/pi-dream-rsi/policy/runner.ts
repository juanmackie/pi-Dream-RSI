/**
 * Host side of policy execution: run one candidate policy version in a worker thread.
 *
 * Responsibilities:
 * - one worker per policy run, always terminating it (deadline, error, or completion);
 * - relay live `probe_batch` requests to the caller-supplied probe (real agent attempts);
 * - a cheap source guardrail: policy code may not import I/O modules or exit the process. This is a
 *   guardrail against accidental damage, not a sandbox — the worker thread is the isolation boundary.
 */
import { Worker } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { DiscoveryTree } from "../engine/tree.ts";
import type { Decision, ProbeFn } from "./host.ts";
import type { Budget, CellId, EpisodeResult, GridPlan, GridPlanningContext, PolicyConfig } from "./api.ts";

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "policy-worker.ts");

const DEFAULT_TIMEOUT_MS = 120_000;

/** Modules a prefix-only policy has no business importing. */
const FORBIDDEN = [
  "node:fs",
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
  "node:dgram",
  "node:worker_threads",
  "node:vm",
  "node:module",
  "node:os",
  "child_process",
  "process.exit",
  "process.kill",
  "globalThis.process",
  // `process.getBuiltinModule('fs')` would otherwise reach the filesystem without an import.
  "getBuiltinModule",
  "createRequire",
];

export interface PolicyRunOptions {
  policyPath: string;
  mode: "grid" | "live" | "replay";
  maxParallelism: number;
  config?: Partial<PolicyConfig>;
  /** Live mode: executes one batch of generation-evaluation attempts. */
  probe?: ProbeFn;
  /** Live mode only: called before each batch is executed. */
  onBatch?: (cells: CellId[], round: number) => void;
  world?: DiscoveryTree | null;
  slots?: number[];
  grid?: { branch_count: number; refine_count: number } | null;
  /** K1 (live) or K2 (replay): the environment stops offering legal cells after this many rounds. */
  maxRounds?: number;
  baselineScore?: number | null;
  refineCount?: number;
  budget?: Budget | null;
  gridPlanContext?: GridPlanningContext | null;
  verifyDeterminism?: boolean;
  timeoutMs?: number;
  workerPath?: string;
}

export interface PolicyRunResult {
  ok: boolean;
  error?: string;
  /** Static or protocol-level contract violations (illegal batches, I/O imports, …). */
  violations?: string[];
  timedOut?: boolean;
  policyName?: string;
  /** The beta the policy actually ran at (baked-in default unless the runtime forced one). */
  beta?: number;
  result?: EpisodeResult;
  /** Number of revealed non-root nodes = N in the replay objective. */
  revealed?: number;
  trace?: Decision[];
  deterministic?: boolean | null;
  plan?: GridPlan;
  durationMs?: number;
}

/** Guardrail scan over policy source. Returns human-readable violations. */
export function scanPolicySource(rawSource: string): string[] {
  // Comments are stripped first: a docstring saying "never touches node:fs" is not a violation.
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const violations: string[] = [];
  for (const needle of FORBIDDEN) {
    if (source.includes(needle)) violations.push(`policy references "${needle}" (prefix-only policies must be pure)`);
  }
  if (/^\s*import\s+.*\bfrom\s+["'](?!\.)/m.test(source)) {
    violations.push("policy imports a bare module specifier; only relative imports are allowed");
  }
  return violations;
}

export function readPolicyViolations(policyPath: string): string[] {
  try {
    return scanPolicySource(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    return [`cannot read policy file ${policyPath}: ${error instanceof Error ? error.message : String(error)}`];
  }
}


/**
 * Policy code is TypeScript, so the worker needs a Node that can execute it. Checking up front turns a
 * cryptic worker failure into an actionable message.
 */
export function policyRuntimeProblem(version = process.versions.node): string | null {
  const [major, minor] = version.split(".").map((part) => Number(part));
  const stripsTypes = Boolean(process.features?.typescript) || (major === 22 && minor >= 6) || major > 22;
  if (stripsTypes) return null;
  return (
    `policy execution needs Node >= 22.18 (or >= 22.6 with --experimental-strip-types) because the ` +
    `exploration policy is TypeScript; this process is running Node ${version}`
  );
}

/** Run one policy version. Never throws: policy failures are reported as `ok: false`. */
export async function runPolicy(options: PolicyRunOptions): Promise<PolicyRunResult> {
  const started = Date.now();
  const runtimeProblem = options.workerPath ? null : policyRuntimeProblem();
  if (runtimeProblem) return { ok: false, error: runtimeProblem, durationMs: 0 };
  const violations = readPolicyViolations(options.policyPath);
  if (violations.length > 0) return { ok: false, violations, error: violations.join("; "), durationMs: 0 };

  const worker = new Worker(options.workerPath ?? WORKER_PATH, {
    // Forward nothing from the parent: test runners and CLIs inject flags a worker rejects
    // (`--test`, `--input-type`, `--use-largepages`, …). The only flag a worker may need is the
    // TypeScript loader, and only on Node versions that strip types behind a flag.
    execArgv: process.features?.typescript ? [] : ["--experimental-strip-types"],
    workerData: {
      policyPath: options.policyPath,
      mode: options.mode,
      config: options.config ?? {},
      maxParallelism: options.maxParallelism,
      slots: options.slots,
      grid: options.grid ?? null,
      maxRounds: options.maxRounds,
      baselineScore: options.baselineScore ?? null,
      refineCount: options.refineCount ?? 0,
      budget: options.budget ?? null,
      world: options.world ? options.world.toJSON() : null,
      gridPlanContext: options.gridPlanContext ?? null,
    },
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    if (timer) clearTimeout(timer);
    void worker.terminate();
  };

  return await new Promise<PolicyRunResult>((resolve) => {
    let settled = false;
    const finish = (value: PolicyRunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...value, durationMs: Date.now() - started });
    };

    timer = setTimeout(() => {
      finish({ ok: false, timedOut: true, error: `policy exceeded ${timeoutMs}ms and was terminated` });
    }, timeoutMs);

    worker.on("message", async (message: Record<string, unknown>) => {
      const type = String(message.type ?? "");
      if (type === "probe") {
        if (!options.probe) {
          finish({ ok: false, error: "policy requested a live probe, but no probe executor was supplied" });
          return;
        }
        const cells = (message.cells ?? []) as CellId[];
        const round = Number(message.round ?? 0);
        try {
          options.onBatch?.(cells, round);
          const records = await options.probe(cells, round);
          worker.postMessage({ type: "probe-reply", records });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          // A rejected batch is a contract violation: stop the run and say why.
          finish({ ok: false, error: reason, violations: [reason] });
        }
        return;
      }
      if (type === "grid-plan") {
        finish({ ok: true, plan: message.plan as GridPlan, beta: Number(message.beta ?? 0) });
        return;
      }
      if (type === "result") {
        finish({
          ok: true,
          policyName: String(message.policyName ?? "OptimalPolicy"),
          beta: Number(message.beta ?? 0),
          result: message.result as EpisodeResult,
          revealed: Number(message.revealed ?? 0),
          trace: (message.trace ?? []) as Decision[],
        });
        return;
      }
      if (type === "error") {
        finish({ ok: false, error: String(message.message ?? "policy error") });
      }
    });

    worker.on("error", (error) => finish({ ok: false, error: `policy worker error: ${error.message}` }));
    worker.on("exit", (code) => {
      if (!settled) finish({ ok: false, error: `policy worker exited with code ${code} before returning a result` });
    });
  });
}

/**
 * Run one policy episode, optionally proving it is reproducible.
 *
 * Replay is supposed to be deterministic, so the same version on the same world must produce the same
 * decision trace. The check runs the episode in a *second, independent worker* — a fresh module
 * instance and a fresh process-like thread — and compares traces. Hidden state (clocks, caches,
 * counters, randomness) shows up here instead of silently corrupting the sweep.
 */
export async function runPolicyChecked(options: PolicyRunOptions): Promise<PolicyRunResult> {
  const first = await runPolicy({ ...options, verifyDeterminism: false });
  if (!options.verifyDeterminism || !first.ok) return first;
  const repeat = await runPolicy({ ...options, verifyDeterminism: false });
  const deterministic =
    repeat.ok && JSON.stringify(first.trace ?? []) === JSON.stringify(repeat.trace ?? []);
  return { ...first, deterministic };
}

/** Convenience wrapper for the grid-planning phase. */
export async function planGrid(
  options: Omit<PolicyRunOptions, "mode"> & { gridPlanContext: GridPlanningContext },
): Promise<{ ok: boolean; plan?: GridPlan; beta?: number; error?: string }> {
  const run = await runPolicy({ ...options, mode: "grid" });
  return run.ok && run.plan ? { ok: true, plan: run.plan, beta: run.beta } : { ok: false, error: run.error ?? "plan_grid failed" };
}
