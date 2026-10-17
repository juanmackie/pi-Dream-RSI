/** Independent post-apply verification and closed-loop helpers for the unattended run. */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { copyWorkspace, runShellCommand } from "../agent/runner.ts";
import { restrictedEnvironment, type RunContract } from "./intake.ts";
import { resolveGainThreshold } from "./metrics.ts";

export interface PostApplyExpectation {
  projectDir: string;
  contract: RunContract;
  /** Exact measured workload argv. */
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
  /** Called immediately before each process starts, for durable accounting. */
  beforeProcess?: () => void;
  signal?: AbortSignal;
  /** Test seam replacing the measurement process. */
  measureImpl?: (argv: string[], projectDir: string) => Promise<number | null>;
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
  beforeProcess?: () => void;
  signal?: AbortSignal;
}): Promise<number | null> {
  options.beforeProcess?.();
  const started = performance.now();
  const result = await runShellCommand(options.argv.join(" "), {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    envOnly: true,
    env: restrictedEnvironment(options.contract as RunContract),
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
 * same workload again, and requires the change to clear the useful gain against
 * the baseline that was recorded before any candidate ran. A failure here stops
 * the run: the applied state no longer agrees with the measurement that promoted
 * it.
 */
export async function verifyPostApply(expectation: PostApplyExpectation): Promise<PostApplyResult> {
  const projectDir = path.resolve(expectation.projectDir);
  const contract = expectation.contract;
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

  try {
    await copyWorkspace(projectDir, scratch, {
      exclude: [path.join(projectDir, ".git"), path.join(projectDir, ".dream-rsi")],
    });

    for (const gate of expectation.gates) {
      expectation.beforeProcess?.();
      const result = await runShellCommand(gate, {
        cwd: scratch,
        timeoutMs: expectation.timeoutMs,
        envOnly: true,
        env: restrictedEnvironment(contract),
        logPath: null,
        ...(expectation.signal ? { signal: expectation.signal } : {}),
      });
      if (!result.ok) {
        const detail = (result.spawnError ?? result.stderrTail.trim().split(/\r?\n/, 1)[0]) || `exit ${result.code}`;
        return { passed: false, gain: null, reason: `the applied state fails "${gate}": ${detail}`, detail };
      }
    }

    const readings: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const reading = await measure(scratch);
      if (reading === null) {
        return {
          passed: false, gain: null,
          reason: `the declared workload "${expectation.argv.join(" ")}" did not complete on the applied state`,
          detail: "workload did not complete",
        };
      }
      readings.push(reading);
    }
    const after = median(readings);
    const before = median(expectation.baseline);
    const gain = expectation.higherIsBetter ? after - before : before - after;
    const threshold = resolveGainThreshold(expectation.minimumUsefulGain, before);
    const passed = gain >= threshold && gain > 0;
    const round = (value: number): number => Math.round(value * 1000) / 1000;
    return {
      passed,
      gain,
      reason: passed ? null
        : `the applied state improved by ${round(gain)} ${expectation.unit}, short of the useful gain ${round(threshold)} ${expectation.unit}`,
      detail: `${expectation.gates.length} gate(s) passed; workload ${round(before)} -> ${round(after)} ${expectation.unit} (gain ${round(gain)})`,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
