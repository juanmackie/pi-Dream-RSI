/**
 * Timeout assessment classification (Phase 2).
 *
 * One pure function constructs every agent-timeout outcome with a diagnostic
 * assessment, so guidance, reporting and live orchestration never duplicate the
 * rule. Ordinary scores stay null: partial values never enter rewards,
 * attainment, ranking, baselines or apply eligibility.
 */

import type { AgentTimeoutDiagnostics, TimeoutAssessment } from "./tree.ts";

/** Minimal evaluator outcome shape (mirrors `ScoreOutcome` without importing live.ts). */
export interface EvalOutcomeForTimeout {
  score: number | null;
  raw_score: number | null;
  valid: boolean;
  fail_class: string;
  error: string | null;
}

export interface ClassifiedTimeout {
  evaluated: true;
  score: null;
  raw_score: null;
  valid: false;
  fail_class: "timeout" | "timeout_scored";
  error: string;
  partial: true;
  agent_timeout: AgentTimeoutDiagnostics;
  timeout_assessment: TimeoutAssessment;
}

/**
 * Classify an agent timeout plus its fresh evaluator interpretation.
 *
 * - `timeout_scored` only when the evaluator returns `fail_class: "ok"`, no
 *   error, and a finite numeric score (the evaluator's own `valid` flag is
 *   preserved as-is, even when false).
 * - Otherwise retains `timeout` with the unresolved assessment (evaluator
 *   failure, missing file, malformed/non-finite score, evaluator timeout).
 * - Never synthesizes zero for a missing assessment.
 */
export function classifyAgentTimeout(
  agentError: string,
  agentTimeout: AgentTimeoutDiagnostics,
  evalOutcome: EvalOutcomeForTimeout,
): ClassifiedTimeout {
  const accepted =
    evalOutcome.fail_class === "ok" &&
    evalOutcome.error === null &&
    typeof evalOutcome.score === "number" &&
    Number.isFinite(evalOutcome.score) &&
    typeof evalOutcome.raw_score === "number" &&
    Number.isFinite(evalOutcome.raw_score);
  if (accepted) {
    return {
      evaluated: true,
      score: null,
      raw_score: null,
      valid: false,
      fail_class: "timeout_scored",
      error: agentError,
      partial: true,
      agent_timeout: { ...agentTimeout },
      timeout_assessment: {
        score: evalOutcome.score,
        raw_score: evalOutcome.raw_score,
        valid: evalOutcome.valid,
        fail_class: "ok",
        error: null,
      },
    };
  }
  return {
    evaluated: true,
    score: null,
    raw_score: null,
    valid: false,
    fail_class: "timeout",
    error: agentError,
    partial: true,
    agent_timeout: { ...agentTimeout },
    timeout_assessment: {
      score: typeof evalOutcome.score === "number" && Number.isFinite(evalOutcome.score) ? evalOutcome.score : null,
      raw_score: typeof evalOutcome.raw_score === "number" && Number.isFinite(evalOutcome.raw_score) ? evalOutcome.raw_score : null,
      valid: evalOutcome.valid,
      fail_class: evalOutcome.fail_class,
      error: evalOutcome.error,
    },
  };
}
