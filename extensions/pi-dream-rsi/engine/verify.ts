/** Independent post-apply verification and closed-loop helpers for the unattended run. */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { copyWorkspace, runShellCommand } from "../agent/runner.ts";
import { restrictedEnvironment, type RunContract } from "./intake.ts";
import type { LeverMetricKind } from "./levers.ts";
import { absoluteGain } from "./intake.ts";

/** Where a score-json evaluator reports its number, relative to the checked copy. */
export const SCORE_READING_PATH = "eval/score.json";

/**
 * A declared evaluator, invoked the way the contract approved it. The argv is a
 * pinned verifier input and is never rebuilt from a candidate-editable label.
 */
export interface PostApplyEvaluator {
  /** Exact evaluator argv. */
  argv: string[];
  /** `score-json` reads `eval/score.json`; `stdout-number` parses exactly one number. */
  output: "score-json" | "stdout-number" | "stdout-json";
}

export interface PostApplyExpectation {
  projectDir: string;
  contract: RunContract;
  /** Exact measured workload argv (the duration path only). */
  argv: string[];
  /** Correctness commands that must pass on the applied state. */
  gates: string[];
  /** Readings of the unchanged target taken before the campaign. */
  baseline: number[];
  /** Smallest change worth applying, from the approved contract. */
  minimumUsefulGain: number | `${number}%`;
  /** Unit label, for reporting. */
  unit: string;
  /** True when a larger reading is better. */
  higherIsBetter: boolean;
  /** Throwaway root for the checked copy. */
  workRoot: string;
  timeoutMs: number;
  /**
   * How the outcome is measured. Omitted means the legacy wall-clock duration
   * path; any non-duration kind is measured through `evaluator`, never wall time.
   */
  kind?: LeverMetricKind;
  /** The declared score instrument. Required for every non-duration kind. */
  evaluator?: PostApplyEvaluator;
  /** Evaluator readings to take. Defaults to 1 for a score kind, 3 for duration. */
  readings?: number;
  /** Called immediately before each process starts, for durable accounting. */
  beforeProcess?: () => void | Promise<void>;
  signal?: AbortSignal;
  /** Test seam replacing the measurement process. */
  measureImpl?: (argv: string[], projectDir: string) => Promise<number | null>;
  /** Test seam replacing the evaluator process. */
  evaluateImpl?: (evaluator: PostApplyEvaluator, projectDir: string) => Promise<number | null>;
}

/**
 * One measurement of a workload, using the restricted environment. Exported so the
 * loop can capture a pre-campaign baseline with exactly the procedure the
 * post-apply check later repeats.
 */
export async function measureWorkload(options: {
  argv: string[];
  cwd: string;
  contract: { execution: { envAllowlist: string[] } };
  timeoutMs: number;
  beforeProcess?: () => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<number | null> {
  await options.beforeProcess?.();
  const started = performance.now();
  const result = await runShellCommand(options.argv.join(" "), {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    envOnly: true,
    env: restrictedEnvironment(options.contract as RunContract),
    redactEnvKeys: options.contract.execution.envAllowlist,
    logPath: null,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!result.ok) return null;
  return performance.now() - started;
}

export interface PostApplyResult {
  passed: boolean;
  /** Independently measured gain in the objective's units; null when nothing could be measured. */
  gain: number | null;
  reason: string | null;
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one evaluator reading from a checked copy.
 *
 * `score-json` requires the evaluator's own `valid: true` verdict and a finite
 * number: a missing file, a malformed file, or a self-reported failure is not a
 * zero score. `stdout-number` requires exactly one finite number, so a log line
 * or a series cannot be mistaken for a reading.
 */
export function readEvaluatorReading(options: {
  cwd: string;
  output: "score-json" | "stdout-number" | "stdout-json";
  /** Captured stdout of the evaluator process (used by stdout-number). */
  stdout?: string;
}): number | null {
  if (options.output === "stdout-number") {
    const text = (options.stdout ?? "").trim();
    if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  if (options.output === "stdout-json") {
    let parsed: unknown;
    try { parsed = JSON.parse(options.stdout ?? ""); } catch { return null; }
    if (!isRecord(parsed) || parsed.valid !== true || ("fail_class" in parsed && parsed.fail_class !== "ok")) return null;
    return typeof parsed.score === "number" && Number.isFinite(parsed.score) ? parsed.score : null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(path.join(options.cwd, ...SCORE_READING_PATH.split("/")), "utf8")); }
  catch { return null; }
  if (!isRecord(parsed) || parsed.valid !== true) return null;
  return typeof parsed.score === "number" && Number.isFinite(parsed.score) ? parsed.score : null;
}

/** Quote one pinned evaluator argv for the task's shell command line. */
function evaluatorCommandLine(argv: string[]): string {
  return argv.map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '""')}"` : part)).join(" ");
}

/** Run one declared evaluator transaction in a checked copy and read its number. */
export interface EvaluatorMeasurementOptions {
  evaluator: PostApplyEvaluator;
  cwd: string;
  contract: RunContract;
  timeoutMs: number;
  beforeProcess?: () => void | Promise<void>;
  signal?: AbortSignal;
}

export async function measureEvaluatorReading(options: EvaluatorMeasurementOptions): Promise<number | null> {
  await options.beforeProcess?.();
  const result = await runShellCommand(evaluatorCommandLine(options.evaluator.argv), {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    envOnly: true,
    env: restrictedEnvironment(options.contract),
    redactEnvKeys: options.contract.execution.envAllowlist,
    logPath: null,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!result.ok) return null;
  return readEvaluatorReading({ cwd: options.cwd, output: options.evaluator.output, stdout: result.stdoutTail });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Check an applied change the way a reviewer would: from outside the campaign.
 *
 * The campaign proved its own instrument moved. This check takes a fresh copy of
 * the resulting working tree, runs the declared correctness commands, measures the
 * same outcome again through the same instrument, and requires the change to clear
 * the useful gain against the baseline that was recorded before any candidate ran.
 * A duration metric measures the declared workload's wall clock; a score metric
 * measures the declared evaluator, never wall time. A failure here stops the run:
 * the applied state no longer agrees with the measurement that promoted it.
 */
export async function verifyPostApply(expectation: PostApplyExpectation): Promise<PostApplyResult> {
  const projectDir = path.resolve(expectation.projectDir);
  const contract = expectation.contract;
  const kind = expectation.kind ?? "command-duration";
  const throughEvaluator = kind !== "command-duration";
  if (throughEvaluator && !expectation.evaluator) {
    return {
      passed: false,
      gain: null,
      reason: `the "${kind}" metric kind requires the declared evaluator; wall time would measure a different outcome`,
      detail: "evaluator missing",
    };
  }
  const readingCount = Math.max(1, Math.round(expectation.readings ?? (throughEvaluator ? 1 : 3)));
  const scratch = path.join(expectation.workRoot, `post-apply-${crypto.randomUUID()}`);
  const measure = async (cwd: string): Promise<number | null> => {
    if (expectation.measureImpl) return expectation.measureImpl(expectation.argv, cwd);
    return measureWorkload({
      argv: expectation.argv,
      cwd,
      contract,
      timeoutMs: expectation.timeoutMs,
      ...(expectation.beforeProcess ? { beforeProcess: expectation.beforeProcess } : {}),
      ...(expectation.signal ? { signal: expectation.signal } : {}),
    });
  };
  const evaluate = async (cwd: string): Promise<number | null> => {
    if (expectation.evaluateImpl) return expectation.evaluateImpl(expectation.evaluator!, cwd);
    return measureEvaluatorReading({
      evaluator: expectation.evaluator!,
      cwd,
      contract,
      timeoutMs: expectation.timeoutMs,
      ...(expectation.beforeProcess ? { beforeProcess: expectation.beforeProcess } : {}),
      ...(expectation.signal ? { signal: expectation.signal } : {}),
    });
  };

  try {
    await copyWorkspace(projectDir, scratch, {
      exclude: [path.join(projectDir, ".git"), path.join(projectDir, ".dream-rsi")],
    });

    for (const gate of expectation.gates) {
      await expectation.beforeProcess?.();
      const result = await runShellCommand(gate, {
        cwd: scratch,
        timeoutMs: expectation.timeoutMs,
        envOnly: true,
        env: restrictedEnvironment(contract),
        redactEnvKeys: contract.execution.envAllowlist,
        logPath: null,
        ...(expectation.signal ? { signal: expectation.signal } : {}),
      });
      if (!result.ok) {
        const detail = (result.spawnError ?? result.stderrTail.trim().split(/\r?\n/, 1)[0]) || `exit ${result.code}`;
        return { passed: false, gain: null, reason: `the applied state fails "${gate}": ${detail}`, detail };
      }
    }

    const readings: number[] = [];
    for (let index = 0; index < readingCount; index += 1) {
      const reading = throughEvaluator ? await evaluate(scratch) : await measure(scratch);
      if (reading === null) {
        return {
          passed: false, gain: null,
          reason: throughEvaluator
            ? `the declared evaluator "${expectation.evaluator!.argv.join(" ")}" did not produce a valid score on the applied state`
            : `the declared workload "${expectation.argv.join(" ")}" did not complete on the applied state`,
          detail: throughEvaluator ? "evaluator did not produce a score" : "workload did not complete",
        };
      }
      readings.push(reading);
    }
    const after = median(readings);
    const before = median(expectation.baseline);
    const gain = expectation.higherIsBetter ? after - before : before - after;
    const threshold = absoluteGain(expectation.minimumUsefulGain, before);
    const passed = gain >= threshold && gain > 0;
    const round = (value: number): number => Math.round(value * 1000) / 1000;
    return {
      passed,
      gain,
      reason: passed ? null
        : `the applied state improved by ${round(gain)} ${expectation.unit}, short of the useful gain ${round(threshold)} ${expectation.unit}`,
      detail: throughEvaluator
        ? `${expectation.gates.length} gate(s) passed; evaluator ${round(before)} -> ${round(after)} ${expectation.unit} (gain ${round(gain)})`
        : `${expectation.gates.length} gate(s) passed; workload ${round(before)} -> ${round(after)} ${expectation.unit} (gain ${round(gain)})`,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
