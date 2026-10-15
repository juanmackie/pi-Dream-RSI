import * as fs from "node:fs";
import * as path from "node:path";
import { DREAM_DIR } from "./engine/task.ts";
import { historyDir, readJson, tracePoolDir, type LiveCycleManifest } from "./engine/world.ts";
import { checkpointPath } from "./engine/checkpoint.ts";

export interface RunningPhase {
  label: string;
  iterations: number[];
}

export function dreamRootFor(cwd: string): string {
  return path.join(cwd, DREAM_DIR);
}

/** Live cycles still marked as running, including claims left by an interrupted process. */
export function activeRuns(root: string): string[] {
  const dir = tracePoolDir(root);
  if (!fs.existsSync(dir)) return [];
  const runs: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const match = /^iter(\d+)_current$/.exec(entry);
    if (!match) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, entry, "live_cycle_manifest.json"), "utf8")) as LiveCycleManifest;
      if (manifest.status === "running") runs.push(`live cycle ${match[1]} (in flight)`);
    } catch {
      runs.push(`live cycle ${match[1]} (unreadable manifest)`);
    }
  }
  return runs.sort((a, b) => a.localeCompare(b));
}

/** Iterations whose in-flight mirrors still carry a running claim. */
export function runningIterations(root: string): number[] {
  const dir = tracePoolDir(root);
  if (!fs.existsSync(dir)) return [];
  const iterations: number[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const match = /^iter(\d+)_current$/.exec(entry);
    if (!match) continue;
    const manifest = readJson<LiveCycleManifest>(path.join(dir, entry, "live_cycle_manifest.json"));
    if (manifest?.status === "running") iterations.push(Number(match[1]));
  }
  return iterations.sort((a, b) => a - b);
}

/** Compact live-cycle report, including diagnostic timeout values without promoting them to scores. */
export function iterationReport(root: string, iteration: number, manifest: LiveCycleManifest): string {
  const scored = manifest.best_score;
  const baseline = manifest.baseline_score;
  const delta = typeof scored === "number" && typeof baseline === "number" ? scored - baseline : null;
  const tag = `r${String(iteration).padStart(4, "0")}`;
  const lines = [
    `${manifest.status === "complete" ? "Live cycle" : manifest.status === "interrupted" ? "⚠️ Live cycle INTERRUPTED" : "⚠️ Live cycle FAILED"} ${iteration}`,
    `  grid:       ${manifest.grid.branch_count} branches x ${manifest.grid.refine_count} refinements (beta=${manifest.baked_beta})`,
    `  attempts:   ${manifest.attempts} across ${manifest.decision_rounds} decision round(s), W=${manifest.grid.branch_count}`,
    `  score:      best=${scored ?? "n/a"}${baseline === null ? "" : ` baseline=${baseline}`}${delta === null ? "" : ` delta=${delta > 0 ? "+" : ""}${delta}`}`,
    `  stopped:    ${manifest.stopped ?? "n/a"}${manifest.error ? ` | error: ${manifest.error}` : ""}`,
    manifest.status === "complete" ? `  world:      ${path.join(tracePoolDir(root), `iter${String(iteration).padStart(4, "0")}`, "tree.json")}` :
      `  recovery:   ${fs.existsSync(checkpointPath(root, iteration)) ? checkpointPath(root, iteration) : "no checkpoint (cycle did not start)"}`,
    `  records:    ${path.join(historyDir(root), `${tag}_live`)}`,
  ];
  try {
    const tree = readJson<{ cells?: { meta?: { cell_id?: string; seq?: number }; partial?: boolean; fail_class?: string; timeout_assessment?: { raw_score?: unknown; fail_class?: string; error?: string | null; valid?: boolean } }[] }>(
      path.join(tracePoolDir(root), `iter${String(iteration).padStart(4, "0")}`, "tree.json"),
    ) ?? readJson<{ cells?: { meta?: { cell_id?: string; seq?: number }; partial?: boolean; fail_class?: string; timeout_assessment?: { raw_score?: unknown; fail_class?: string; error?: string | null; valid?: boolean } }[] }>(
      path.join(historyDir(root), `${tag}_live`, "tree.json"),
    );
    const assessed = (tree?.cells ?? []).filter((n) => n?.partial || n?.timeout_assessment || n?.fail_class === "timeout_scored").sort((a, b) => (a.meta?.seq ?? 0) - (b.meta?.seq ?? 0));
    if (assessed.length) {
      lines.push("  partial assessments (diagnostic only, excluded from attainment and promotion):");
      const recent = assessed.slice(-10);
      for (const n of recent) {
        const cell = n.meta?.cell_id ?? "unknown";
        const cls = n.fail_class ?? "timeout";
        const raw = typeof n.timeout_assessment?.raw_score === "number" && Number.isFinite(n.timeout_assessment.raw_score) ? String(Math.round(n.timeout_assessment.raw_score * 10000) / 10000) : "n/a";
        if (cls === "timeout_scored" && raw !== "n/a") lines.push(`    ${cell} timeout_scored partial raw ${raw}${n.timeout_assessment?.valid === false ? " valid:false" : ""}`);
        else {
          const fail = n.timeout_assessment ? `${n.timeout_assessment.fail_class ?? "unresolved"}${n.timeout_assessment.error ? `: ${n.timeout_assessment.error}` : ""}` : "unresolved";
          lines.push(`    ${cell} ${cls} partial raw ${raw} assessment ${fail}`);
        }
      }
      if (assessed.length > recent.length) lines.push(`    ... ${assessed.length - recent.length} more partial assessment(s) omitted; see ${path.join(historyDir(root), `${tag}_live`)}`);
    }
  } catch { /* An unreadable tree must not break the cycle report. */ }
  return lines.join("\n");
}
