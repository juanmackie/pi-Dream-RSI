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

function fmtDurationSeconds(seconds: number): string {
  return `${String(seconds)}s`;
}

/**
 * Kinds of timeout evidence the renderer can distinguish.
 *
 * - `agent-with-output`: recognizable discovery-agent timeout where the agent emitted output.
 * - `agent-silent`: recognizable discovery-agent timeout with no output at all.
 * - `agent-unknown`: timeout with insufficient diagnostic information (legacy/unrecognized).
 * - `evaluator`: evaluator timeout, never described as an agent timeout.
 * - `not-timeout`: not a timeout outcome.
 */
export type TimeoutDiagnosisKind =
  | "agent-with-output"
  | "agent-silent"
  | "agent-unknown"
  | "evaluator"
  | "not-timeout";

export interface TimeoutDiagnosis {
  kind: TimeoutDiagnosisKind;
  /** Agent runtime in seconds parsed from the timeout error, when available. */
  durationSeconds: number | null;
}

/**
 * Pure helper to interpret recognizable discovery-agent timeout diagnostics.
 *
 * Uses the agent runtime from the existing timeout error when available. Never
 * relabels node `duration_ms` (which includes additional attempt work) as agent
 * runtime — that fallback lives in the renderer, with neutral wording.
 */
export function diagnoseTimeout(error: string | null, failClass: string): TimeoutDiagnosis {
  if (failClass !== "timeout") return { kind: "not-timeout", durationSeconds: null };
  if (typeof error !== "string" || error.trim() === "") return { kind: "agent-unknown", durationSeconds: null };
  if (/evaluator timed out/i.test(error)) return { kind: "evaluator", durationSeconds: null };
  if (/discovery agent timed out/i.test(error)) {
    const match = /timed out after\s+(\d+(?:\.\d+)?)s/.exec(error);
    const durationSeconds = match ? Number(match[1]) : null;
    const duration = Number.isFinite(durationSeconds) ? (durationSeconds as number) : null;
    if (/with no output at all/i.test(error)) return { kind: "agent-silent", durationSeconds: duration };
    if (/with output/i.test(error)) return { kind: "agent-with-output", durationSeconds: duration };
    // Recognizable agent timeout without explicit output marking: insufficient
    // information. Do not infer silence from missing metadata.
    return { kind: "agent-unknown", durationSeconds: duration };
  }
  return { kind: "agent-unknown", durationSeconds: null };
}

function fmtAttemptSeconds(durationMs: number): string {
  return fmtDurationSeconds(Math.round(durationMs / 100) / 10);
}

/** Diagnostic suffix for one timeout node, or null to keep the generic rendering. */
function timeoutDetail(
  error: string | null,
  failClass: string,
  durationMs: number | null,
): string | null {
  const diagnosis = diagnoseTimeout(error, failClass);
  if (diagnosis.kind === "not-timeout" || diagnosis.kind === "evaluator") return null;
  if (diagnosis.kind === "agent-with-output") {
    if (diagnosis.durationSeconds !== null) {
      return `: agent ran ${fmtDurationSeconds(diagnosis.durationSeconds)} with output but did not finish`;
    }
    return ": agent produced output but did not finish";
  }
  if (diagnosis.kind === "agent-silent") {
    if (diagnosis.durationSeconds !== null) {
      return `: agent produced no output during ${fmtDurationSeconds(diagnosis.durationSeconds)}`;
    }
    return ": agent produced no output";
  }
  // agent-unknown: neutral wording with available attempt duration. Never claims
  // silence and never relabels attempt duration as precise agent runtime.
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    return `: did not finish (attempt took ${fmtAttemptSeconds(durationMs)})`;
  }
  return ": did not finish";
}

/** Agent phrase for assessed timeouts, preferring stored `agent_timeout` diagnostics. */
function agentPhraseForAssessment(n: TreeNode): string {
  const stored = n.agent_timeout;
  if (stored && typeof stored.duration_ms === "number" && Number.isFinite(stored.duration_ms)) {
    const secs = fmtAttemptSeconds(stored.duration_ms);
    if (stored.had_output) return `agent ran ${secs} with output`;
    return `agent produced no output during ${secs}`;
  }
  const diagnosis = diagnoseTimeout(n.error, n.fail_class === "timeout_scored" ? "timeout" : n.fail_class);
  if (diagnosis.kind === "agent-with-output") {
    return diagnosis.durationSeconds !== null
      ? `agent ran ${fmtDurationSeconds(diagnosis.durationSeconds)} with output`
      : "agent produced output";
  }
  if (diagnosis.kind === "agent-silent") {
    return diagnosis.durationSeconds !== null
      ? `agent produced no output during ${fmtDurationSeconds(diagnosis.durationSeconds)}`
      : "agent produced no output";
  }
  if (typeof n.duration_ms === "number" && Number.isFinite(n.duration_ms) && n.duration_ms >= 0) {
    return `attempt took ${fmtAttemptSeconds(n.duration_ms)}`;
  }
  return "did not finish";
}

/** Full line for a `timeout_scored` node with its diagnostic partial score. */
function timeoutScoredLine(n: TreeNode): string {
  const agent = agentPhraseForAssessment(n);
  const assessment = n.timeout_assessment;
  // Never replace a missing assessment with zero.
  if (!assessment || typeof assessment.raw_score !== "number" || !Number.isFinite(assessment.raw_score)) {
    if (assessment) {
      return `- ${n.meta.cell_id} timeout_scored: ${agent}; assessment ${assessment.fail_class}${assessment.error ? `: ${assessment.error}` : ""}; unfinished`;
    }
    return `- ${n.meta.cell_id} timeout_scored: ${agent}; unfinished`;
  }
  const validNote = assessment.valid === false ? " (valid:false)" : "";
  return `- ${n.meta.cell_id} timeout_scored: ${agent}; diagnostic partial score ${fmtScore(assessment.raw_score)}${validNote}; unfinished`;
}

/** Line for a `timeout` node carrying an unresolved diagnostic assessment. */
function timeoutUnresolvedLine(n: TreeNode): string {
  const agent = agentPhraseForAssessment(n);
  const assessment = n.timeout_assessment;
  if (!assessment) {
    const detail = timeoutDetail(n.error, n.fail_class, n.duration_ms);
    if (detail !== null) return `- ${n.meta.cell_id} timeout${detail}`;
    return `- ${n.meta.cell_id} failed / timeout`;
  }
  return `- ${n.meta.cell_id} timeout: ${agent}; assessment ${assessment.fail_class}${assessment.error ? `: ${assessment.error}` : ""}; unfinished`;
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
  const lines = evaluated.map((n) => {
    if (n.fail_class === "timeout_scored") {
      // Diagnostic partial scores stay in the failure count and out of the
      // successful best-score summary (handled by the header filters above).
      return timeoutScoredLine(n);
    }
    if (n.fail_class === "timeout") {
      if (n.timeout_assessment !== undefined) return timeoutUnresolvedLine(n);
      const detail = timeoutDetail(n.error, n.fail_class, n.duration_ms);
      // Evaluator timeouts keep the generic rendering; agent timeouts get
      // diagnostic detail on the same line (never a second listing).
      if (detail !== null) return `- ${n.meta.cell_id} timeout${detail}`;
    }
    return `- ${n.meta.cell_id} ${n.error === null && n.fail_class === "ok" ? fmtScore(n.score) : "failed"} / ${n.fail_class}`;
  });
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
