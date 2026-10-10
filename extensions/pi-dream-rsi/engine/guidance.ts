/**
 * Opt-in semantic direction guidance (SwarmResearch-style Shepherd prompt).
 *
 * `renderDirectionGuidance` builds a deterministic, bounded summary of
 * evaluated history for the discovery-agent prompt's `$direction_guidance`
 * slot. It deliberately contains only what attempts can already read as
 * files (cell ids, scores, fail classes) — no workspaces, proposals, trace
 * internals, or policy state. The synthesis (what to try next) stays with
 * the attempt agent; this is just the shared evidence in compact form.
 *
 * Off by default (`task.guidance === "off"` renders `""`, byte-identical to
 * the historical prompt). Experimental: the paper's §4 ablation found
 * prompt-level guidance over-constrains search, so measure before adopting.
 */

import type { TreeNode } from "./tree.ts";

/** Hard cap so guidance can never crowd out the attempt's working context. */
export const GUIDANCE_MAX_CHARS = 1500;

function fmtScore(score: number | null): string {
  return typeof score === "number" ? String(Math.round(score * 10000) / 10000) : "n/a";
}

/**
 * Summarize evaluated cells in cell-id order (deterministic). When the full
 * listing would exceed the cap, keep the header plus as many of the most
 * recent cells as fit and note the truncation count.
 */
export function renderDirectionGuidance(cells: TreeNode[]): string {
  const evaluated = cells
    .filter((n) => n.evaluated)
    .sort((a, b) => (a.meta.cell_id < b.meta.cell_id ? -1 : a.meta.cell_id > b.meta.cell_id ? 1 : 0));
  if (evaluated.length === 0) {
    return "Direction guidance: no evaluated attempts yet this run — explore broadly.";
  }
  const succeeded = evaluated.filter((n) => n.error === null && n.fail_class === "ok" && typeof n.score === "number");
  const best = succeeded.reduce<TreeNode | null>(
    (top, n) => (top === null || (n.score as number) > (top.score as number) ? n : top),
    null,
  );
  const failed = evaluated.filter((n) => !(n.error === null && n.fail_class === "ok"));
  const header =
    `Direction guidance: ${evaluated.length} evaluated attempt(s), ` +
    `${succeeded.length} successful` +
    (best !== null ? `, best score ${fmtScore(best.score)} (${best.meta.cell_id})` : ", no successful score yet") +
    (failed.length > 0 ? `, ${failed.length} repairable failure(s) (see their error.txt before retrying the idea)` : "") +
    ". Per-cell outcomes (id score/fail_class):";
  const lines = evaluated.map(
    (n) => `- ${n.meta.cell_id} ${n.error === null && n.fail_class === "ok" ? fmtScore(n.score) : "failed"} / ${n.fail_class}`,
  );
  const tailFor = (d: number) =>
    d > 0 ? `\n… ${d} oldest cell(s) omitted for length; read their proposal.md/score.json directly.` : "";
  let kept = lines;
  let dropped = 0;
  while (kept.length > 0) {
    const total = header.length + 1 + kept.join("\n").length + tailFor(dropped).length;
    if (total <= GUIDANCE_MAX_CHARS) break;
    kept = kept.slice(1);
    dropped += 1;
  }
  return `${header}\n${kept.join("\n")}${tailFor(dropped)}`;
}
