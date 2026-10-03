#!/usr/bin/env node
/**
 * Measure exploration behavior using the trusted production replay engine.
 * Usage: node /absolute/path/.auto/score.mjs [workspace] --benchmark-version=2
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { replayEpisode } from "../extensions/pi-dream-rsi/engine/replay.ts";
import { ensurePolicyRuntime } from "../extensions/pi-dream-rsi/engine/world.ts";
import { planGrid, readPolicyViolations } from "../extensions/pi-dream-rsi/policy/runner.ts";
import { BENCHMARK_VERSION, REPLAY_CONFIG, createReplayWorlds } from "./replay-worlds.mjs";

const TRUSTED_POLICY_DIR = fileURLToPath(new URL("../extensions/pi-dream-rsi/policy/", import.meta.url));
export const POLICY_RELATIVE_PATH = "extensions/pi-dream-rsi/policy/method.ts";

function verdict(failClass, error, perWorld = []) {
  return {
    score: 0,
    valid: false,
    fail_class: failClass,
    error,
    benchmark_version: BENCHMARK_VERSION,
    per_world: perWorld,
  };
}

/** Scores are host-recorded Eq. 1 values; candidate-reported counters are never trusted. */
export async function scorePolicy(workspace, { timeoutMs = 2_000 } = {}) {
  let scratch;
  const perWorld = [];
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-score-"));
    ensurePolicyRuntime(scratch, TRUSTED_POLICY_DIR);
    const policyPath = path.join(scratch, "policy", "method.ts");
    // Only method.ts is editable for this task. Candidate helpers/engine/scorer are not imported.
    fs.copyFileSync(path.resolve(workspace, POLICY_RELATIVE_PATH), policyPath);
    const violations = readPolicyViolations(policyPath);
    if (violations.length > 0) return verdict("guardrail_failure", violations.join("; "));

    const planned = await planGrid({
      policyPath,
      maxParallelism: REPLAY_CONFIG.maxParallelism,
      timeoutMs,
      gridPlanContext: {
        history: [],
        baseline_score: 0,
        max_parallelism: REPLAY_CONFIG.maxParallelism,
        budget: { workers: REPLAY_CONFIG.maxParallelism, attempts: 6 },
      },
    });
    if (!planned.ok) {
      return verdict("policy_error", planned.error ?? "plan_grid failed");
    }
    if (!Number.isSafeInteger(planned.plan?.branch_count) || planned.plan.branch_count < 1 ||
        !Number.isSafeInteger(planned.plan?.refine_count) || planned.plan.refine_count < 1) {
      return verdict("policy_error", "plan_grid must return finite positive integer dimensions");
    }

    for (const { id, world } of createReplayWorlds()) {
      const episode = await replayEpisode({
        ...REPLAY_CONFIG,
        policyPath,
        world,
        beta: null,
        timeoutMs,
        verifyDeterminism: true,
      });
      perWorld.push({
        id,
        ok: episode.ok,
        error: episode.error,
        deterministic: episode.deterministic,
        beta: episode.beta,
        ...episode.metrics,
      });
      if (!episode.ok) {
        return verdict(episode.timedOut ? "timeout" : "policy_error",
          episode.error ?? `replay failed on ${id}`, perWorld);
      }
      if (episode.deterministic !== true) {
        return verdict("non_deterministic", `replay decisions changed between workers on ${id}`, perWorld);
      }
      if (!Number.isFinite(episode.metrics.value)) {
        return verdict("invalid_score", `non-finite replay value on ${id}`, perWorld);
      }
    }
    return {
      score: perWorld.reduce((sum, episode) => sum + episode.value, 0) / perWorld.length,
      valid: true,
      fail_class: "ok",
      error: null,
      benchmark_version: BENCHMARK_VERSION,
      per_world: perWorld,
    };
  } catch (error) {
    return verdict("scorer_error", error instanceof Error ? error.message : String(error), perWorld);
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function parseArgs(args) {
  let workspace = ".";
  let hasWorkspace = false;
  for (const arg of args) {
    if (arg === `--benchmark-version=${BENCHMARK_VERSION}`) continue;
    if (arg.startsWith("-") || hasWorkspace) {
      throw new Error(`expected [workspace] --benchmark-version=${BENCHMARK_VERSION}; received ${arg}`);
    }
    workspace = arg;
    hasWorkspace = true;
  }
  return path.resolve(workspace);
}

async function main() {
  let workspace = process.cwd();
  let result;
  try {
    // Recover the requested output location even if the version flag is rejected.
    const requested = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
    if (requested) workspace = path.resolve(requested);
    workspace = parseArgs(process.argv.slice(2));
    result = await scorePolicy(workspace);
  } catch (error) {
    result = verdict("scorer_error", error instanceof Error ? error.message : String(error));
  }
  const output = path.join(workspace, "eval", "score.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`score=${result.score} fail_class=${result.fail_class} benchmark_version=${BENCHMARK_VERSION}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
