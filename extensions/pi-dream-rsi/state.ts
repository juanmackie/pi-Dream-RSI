/**
 * Session state and human-readable reporting.
 *
 * Session state is intentionally thin: the *durable* state is the on-disk layout under `.dream-rsi/`
 * (task, policy, history, trace pool). Session entries only record which iteration the session reached and
 * whether Dream-RSI mode is active, so a resumed session can pick the loop back up. They are read back by
 * `reconstruct` in the extension, which is why the entry type written here has to match the one read there.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { DREAM_DIR, readTask, type TaskConfig } from "./engine/task.ts";
import { listIterations, readJson, readManifest, historyDir, liveMethodPath, policyDir, tracePoolDir, type LiveCycleManifest } from "./engine/world.ts";

export const LIVE_MANIFEST_ENTRY = "pi-dream-rsi/live";

export interface DreamState {
  mode: boolean;
  /** Highest iteration this session reached (never decreases). */
  iteration: number;
  /** Human label of the phase currently running, if any. */
  running: string | null;
}

export function dreamRootFor(cwd: string): string {
  return path.join(cwd, DREAM_DIR);
}

export function saveTaskEntry(
  pi: { appendEntry: (type: string, data: unknown) => void },
  root: string,
  data: { task?: string; policy?: string; iteration?: number; model?: string | null; reset?: boolean },
): void {
  pi.appendEntry(LIVE_MANIFEST_ENTRY, { version: 1, root, ...data });
}

/** Phases left marked `running` in the in-flight mirrors — also catches crashed cycles. */
export function activeRuns(root: string): string[] {
  const dir = tracePoolDir(root);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const match = /^iter(\d+)_current$/.exec(entry);
    if (!match) continue;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, entry, "live_cycle_manifest.json"), "utf8"),
      ) as LiveCycleManifest;
      if (manifest.status === "running") out.push(`live cycle ${match[1]} (in flight)`);
    } catch {
      out.push(`live cycle ${match[1]} (unreadable manifest)`);
    }
  }
  return out;
}

/**
 * A run left `running` on disk while no phase is active in this session was interrupted (crash, killed
 * process). Dream-RSI runs one phase at a time, so it is safe to mark those failed — otherwise the
 * interrupted cycle looks permanently in flight and blocks the next one from being trusted.
 *
 * Only the in-flight mirror is touched, not the final sidecar: the interrupted iteration had no completed
 * world, so the next live cycle restarts that iteration number with a clean tree.
 */
export function recoverInterruptedRuns(root: string): number[] {
  const dir = tracePoolDir(root);
  if (!fs.existsSync(dir)) return [];
  const recovered: number[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const match = /^iter(\d+)_current$/.exec(entry);
    if (!match) continue;
    const file = path.join(dir, entry, "live_cycle_manifest.json");
    const manifest = readJson<LiveCycleManifest>(file);
    if (!manifest || manifest.status !== "running") continue;
    const updated: LiveCycleManifest = {
      ...manifest,
      status: "failed",
      completed_at: new Date().toISOString(),
      error: manifest.error ?? "interrupted — the previous run did not finish",
    };
    fs.writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    recovered.push(Number(match[1]));
  }
  return recovered.sort((a, b) => a - b);
}

export interface LoadedState {
  task: TaskConfig;
  iterations: { iteration: number; manifest: LiveCycleManifest | null }[];
  policy: string;
  policyVersions: string[];
  sweeps: { iteration: number; auc: number; pareto_reward: number; parallel_penalty: number }[];
}

export function loadState(root: string): LoadedState {
  const task = readTask(root);
  const iterations = listIterations(root).map((iteration) => ({ iteration, manifest: readManifest(root, iteration) }));
  const policyVersions = fs.existsSync(policyDir(root))
    ? fs
        .readdirSync(policyDir(root))
        .filter((name) => /^v\d+\.ts$/.test(name))
        .sort()
    : [];
  const sweeps: LoadedState["sweeps"] = [];
  for (const { iteration } of iterations) {
    const file = path.join(historyDir(root), `r${String(iteration).padStart(4, "0")}_dream`, "proposal_results", "beta_sweep.json");
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        auc?: number;
        pareto_reward?: number;
        parallel_penalty?: number;
      };
      sweeps.push({
        iteration,
        auc: Number(parsed.auc ?? 0),
        pareto_reward: Number(parsed.pareto_reward ?? 0),
        parallel_penalty: Number(parsed.parallel_penalty ?? 0),
      });
    } catch {
      // ignore unreadable sweeps; status must never throw
    }
  }
  return { task, iterations, policy: liveMethodPath(root), policyVersions, sweeps };
}

/** Compact report of one completed live cycle. */
export function iterationReport(root: string, iteration: number, manifest: LiveCycleManifest): string {
  const scored = manifest.best_score;
  const baseline = manifest.baseline_score;
  const delta = typeof scored === "number" && typeof baseline === "number" ? scored - baseline : null;
  const lines = [
    `${manifest.status === "complete" ? "Live cycle" : "⚠️ Live cycle FAILED"} ${iteration}`,
    `  grid:       ${manifest.grid.branch_count} branches x ${manifest.grid.refine_count} refinements (beta=${manifest.baked_beta})`,
    `  attempts:   ${manifest.attempts} across ${manifest.decision_rounds} decision round(s), W=${manifest.grid.branch_count}`,
    `  score:      best=${scored ?? "n/a"}${baseline === null ? "" : ` baseline=${baseline}`}${delta === null ? "" : ` delta=${delta > 0 ? "+" : ""}${delta}`}`,
    `  stopped:    ${manifest.stopped ?? "n/a"}${manifest.error ? ` | error: ${manifest.error}` : ""}`,
    `  world:      ${path.join(tracePoolDir(root), `iter${String(iteration).padStart(4, "0")}`, "tree.json")}`,
    `  records:    ${path.join(historyDir(root), `r${String(iteration).padStart(4, "0")}_live`)}`,
  ];
  return lines.join("\n");
}

export interface StatusOptions {
  full?: boolean;
  sessionIteration?: number;
}

/** Everything an operator needs to decide the next cycle, and nothing more. */
export function statusSummary(root: string, options: StatusOptions = {}): string {
  if (!fs.existsSync(path.join(root, "task.json"))) return `No Dream-RSI task at ${root}.`;
  let state: LoadedState;
  try {
    state = loadState(root);
  } catch (error) {
    return `Dream-RSI state unreadable: ${(error as Error).message}`;
  }
  const { task } = state;
  const lines = [
    `Dream-RSI — ${task.name}`,
    `  root:     ${root}`,
    `  budgets:  W=${task.workers} K1=${task.k1} K2=${task.k2} M=${task.revisions} beta_grid=[${task.beta_grid.join(", ")}]`,
    `  scoring:  ${task.score_program} -> ${task.score_path}.${task.score_field} (${task.higher_is_better ? "higher" : "lower"} is better)`,
    `  policy:   ${path.relative(root, state.policy)} (versions: ${state.policyVersions.length === 0 ? "none archived" : state.policyVersions.join(", ")})`,
  ];
  const active = activeRuns(root);
  if (active.length > 0) lines.push(`  in flight: ${active.join("; ")}`);
  const worlds = state.iterations.length;
  lines.push(
    worlds === 0
      ? "  worlds:   none recorded yet — run dream_rsi_live first (dream_rsi_dream replays recorded worlds, it does not create them)"
      : `  worlds:   ${worlds} recorded (t=${state.iterations.map((i) => i.iteration).join(",")}) — dream_rsi_dream can replay them now`,
  );
  if (typeof options.sessionIteration === "number" && options.sessionIteration > 0) {
    lines.push(`  session iteration: ${options.sessionIteration}`);
  }
  if (state.iterations.length === 0) {
    lines.push("  no live cycles recorded yet — run dream_rsi_live to record the first world.");
    return lines.join("\n");
  }  lines.push("  iterations (world t, best, beta, attempts, rounds):");
  for (const { iteration, manifest } of state.iterations) {
    if (!manifest) {
      lines.push(`    t=${iteration}: manifest missing`);
      continue;
    }
    const sweep = state.sweeps.find((s) => s.iteration === iteration);
    lines.push(
      `    t=${iteration}: status=${manifest.status} best=${manifest.best_score ?? "n/a"} beta=${manifest.baked_beta}` +
        ` attempts=${manifest.attempts} rounds=${manifest.decision_rounds}` +
        (sweep ? ` | sweep pareto.reward=${sweep.pareto_reward.toFixed(3)} auc=${sweep.auc.toFixed(3)} penalty=${sweep.parallel_penalty.toFixed(3)}` : ""),
    );
  }
  const trend = state.iterations
    .map(({ manifest }) => (typeof manifest?.best_score === "number" ? manifest.best_score : null))
    .filter((value): value is number => value !== null);
  if (trend.length >= 2) {
    const improving = trend[trend.length - 1] > trend[trend.length - 2];
    lines.push(`  live trend: ${trend.join(" -> ")} (${improving ? "still improving" : "plateaued"})`);
  }
  if (options.full && state.sweeps.length > 0) {
    const last = state.sweeps[state.sweeps.length - 1];
    const file = path.join(historyDir(root), `r${String(last.iteration).padStart(4, "0")}_dream`, "proposal_results", "beta_sweep.json");
    lines.push(`  last sweep (t=${last.iteration}, ${file}):`);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        versions?: { revision: number; v_mean: number; default_beta: number; deterministic: boolean | null }[];
      };
      for (const version of parsed.versions ?? []) {
        lines.push(
          `    pi_${version.revision}: V=${version.v_mean.toFixed(4)} beta=${version.default_beta} deterministic=${version.deterministic ?? "n/a"}`,
        );
      }
    } catch {
      lines.push("    (sweep unreadable)");
    }
  }
  return lines.join("\n");
}
