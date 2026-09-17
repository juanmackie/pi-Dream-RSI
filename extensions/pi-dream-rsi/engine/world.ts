/**
 * On-disk layout. Names follow the paper's prompts so the recorded artifacts read as documented:
 *
 *   .dream-rsi/
 *     task.json
 *     policy/method.ts                     deployed policy
 *     policy_versions/v0001.ts             every candidate version, archived
 *     history/baseline/attempt_<cell>/     parallel-refine floor to beat
 *     history/r0001_live/attempt_<cell>/   one record per live attempt
 *     history/r0001_live/tree.json
 *     history/r0001_dream/proposal_results/{beta_sweep.json,policy_execution_traces.jsonl}
 *     trace_pool/iter0001/{tree.json,live_cycle_manifest.json}
 *     trace_pool/iter0001_current/live_cycle_manifest.json
 *     work/<cellId>/                       attempt workspaces (agent cwd)
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { DiscoveryTree, type TreeJSON } from "./tree.ts";

export interface LiveCycleManifest {
  iteration: number;
  status: "running" | "complete" | "failed";
  created_at: string;
  completed_at: string | null;
  /** The one scalar baked into the policy for this live episode. */
  baked_beta: number;
  policy_version: string;
  policy_name: string | null;
  grid: { branch_count: number; refine_count: number };
  decision_rounds: number;
  attempts: number;
  baseline_score: number | null;
  best_score: number | null;
  /** Best score at the end of the previous iteration, for the live-trend rule. */
  previous_best_score: number | null;
  stopped: string | null;
  error: string | null;
  note: string | null;
}

export function pad(index: number, width = 4): string {
  return String(index).padStart(width, "0");
}

export function policyDir(dreamRoot: string): string {
  return path.join(dreamRoot, "policy");
}

export function liveMethodPath(dreamRoot: string): string {
  return path.join(policyDir(dreamRoot), "method.ts");
}

/**
 * Candidate policy versions live beside the deployed policy and its API files, so a version can keep
 * importing `./api.ts` wherever it is archived.
 */
export function versionedPolicyPath(dreamRoot: string, revision: number): string {
  return path.join(policyDir(dreamRoot), `v${pad(revision)}.ts`);
}

export function workRoot(dreamRoot: string): string {
  return path.join(dreamRoot, "work");
}

export function nodeWorkspace(dreamRoot: string, cell: string): string {
  return path.join(workRoot(dreamRoot), cell);
}

export function historyDir(dreamRoot: string): string {
  return path.join(dreamRoot, "history");
}

export function baselineDir(dreamRoot: string): string {
  return path.join(historyDir(dreamRoot), "baseline");
}

export function roundDir(dreamRoot: string, iteration: number, phase: "live" | "dream"): string {
  return path.join(historyDir(dreamRoot), `r${pad(iteration)}_${phase}`);
}

export function attemptDir(dreamRoot: string, iteration: number, cell: string): string {
  return path.join(roundDir(dreamRoot, iteration, "live"), `attempt_${cell}`);
}

export function proposalResultsDir(dreamRoot: string, iteration: number): string {
  return path.join(roundDir(dreamRoot, iteration, "dream"), "proposal_results");
}

export function tracePoolDir(dreamRoot: string): string {
  return path.join(dreamRoot, "trace_pool");
}

export function iterationDir(dreamRoot: string, iteration: number, current = false): string {
  return path.join(tracePoolDir(dreamRoot), `iter${pad(iteration)}${current ? "_current" : ""}`);
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function appendJsonl(file: string, records: unknown[]): void {
  if (records.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

export function writeTree(root: string, iteration: number, tree: DiscoveryTree, current = false): string {
  const file = path.join(iterationDir(root, iteration, current), "tree.json");
  writeJson(file, tree.toJSON());
  return file;
}

export function readTree(root: string, iteration: number): DiscoveryTree | null {
  const json = readJson<TreeJSON>(path.join(iterationDir(root, iteration), "tree.json"));
  return json ? DiscoveryTree.fromJSON(json) : null;
}

/** Write the live-cycle sidecar the cross-cycle beta rule reads (paper Listing 2). */
export function writeManifest(root: string, manifest: LiveCycleManifest): string {
  const final = path.join(iterationDir(root, manifest.iteration), "live_cycle_manifest.json");
  writeJson(final, manifest);
  return final;
}

/** In-flight mirror, so a crashed/interrupted cycle is still visible. */
export function writeCurrentManifest(root: string, manifest: LiveCycleManifest): string {
  const current = path.join(iterationDir(root, manifest.iteration, true), "live_cycle_manifest.json");
  writeJson(current, manifest);
  return current;
}

export function readManifest(root: string, iteration: number): LiveCycleManifest | null {
  return readJson<LiveCycleManifest>(path.join(iterationDir(root, iteration), "live_cycle_manifest.json"));
}

/** Iterations recorded in the trace pool, ascending. */
export function listIterations(root: string): number[] {
  const dir = tracePoolDir(root);
  if (!fs.existsSync(dir)) return [];
  const found = new Set<number>();
  for (const entry of fs.readdirSync(dir)) {
    const match = /^iter(\d+)$/.exec(entry);
    if (match) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** The most recent `count` manifests, oldest first — input for `plan_grid` and the beta rule. */
export function recentManifests(root: string, count = 3): LiveCycleManifest[] {
  const iterations = listIterations(root).slice(-count);
  return iterations.map((i) => readManifest(root, i)).filter((m): m is LiveCycleManifest => m !== null);
}

/** Copy one attempt's evidence into its `attempt_<cell>` record directory. */
export function archiveAttempt(
  root: string,
  iteration: number,
  cell: string,
  sources: { proposal?: string | null; score?: string | null; error?: string | null; log?: string | null },
): string {
  const target = attemptDir(root, iteration, cell);
  fs.mkdirSync(target, { recursive: true });
  const copyInto = (from: string | null | undefined, to: string): void => {
    if (!from || !fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  };
  copyInto(sources.proposal, path.join(target, "proposal.md"));
  copyInto(sources.score, path.join(target, "eval", "score.json"));
  copyInto(sources.error, path.join(target, "error.txt"));
  copyInto(sources.log, path.join(target, "agent.log"));
  return target;
}

/** Seed `history/baseline/` from the best valid attempt of the first live round. */
export function seedBaseline(root: string, iteration: number, tree: DiscoveryTree): string | null {
  const valid = tree.list().filter((n) => n.valid && typeof n.score === "number");
  if (valid.length === 0) return null;
  const best = valid.reduce((a, b) => ((b.score ?? -Infinity) > (a.score ?? -Infinity) ? b : a));
  const target = path.join(baselineDir(root), `attempt_${best.meta.cell_id}`);
  fs.mkdirSync(target, { recursive: true });
  const source = attemptDir(root, iteration, best.meta.cell_id);
  for (const relative of ["proposal.md", path.join("eval", "score.json"), "error.txt"]) {
    const from = path.join(source, relative);
    if (!fs.existsSync(from)) continue;
    const to = path.join(target, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  writeJson(path.join(baselineDir(root), "score.json"), {
    score: best.score,
    cell: best.meta.cell_id,
    iteration,
    note: "parallel-refine floor to beat: best valid attempt of the first live cycle (paper Listing 2)",
  });
  return target;
}

/** Archive a candidate policy version; every revision keeps its own file so it can be re-imported. */
export function archivePolicyVersion(root: string, revision: number, source: string): string {
  const target = versionedPolicyPath(root, revision);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, "utf8");
  return target;
}

export function deployPolicy(root: string, source: string): string {
  const target = liveMethodPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, "utf8");
  return target;
}

/**
 * Copy the policy runtime (`api.ts`, `observation-signal.ts`) next to the project's policy files.
 * A policy imports them relatively, and both are type-only dependents of the engine, so nothing else
 * has to be shipped for a policy to run standalone in its worker.
 */
export function ensurePolicyRuntime(root: string, packagePolicyDir: string): string[] {
  const target = policyDir(root);
  fs.mkdirSync(target, { recursive: true });
  // Our policy files are ES modules. Scoped to `policy/` on purpose: writing it one level up would
  // change how the *user's* files are interpreted inside attempt workspaces under `work/`.
  const manifest = path.join(target, "package.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`, "utf8");
  }
  const copied: string[] = [];
  for (const name of ["api.ts", "observation-signal.ts"]) {
    const from = path.join(packagePolicyDir, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(target, name);
    fs.copyFileSync(from, to);
    copied.push(to);
  }
  return copied;
}
