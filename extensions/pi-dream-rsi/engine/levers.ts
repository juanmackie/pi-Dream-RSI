import { createHash } from "node:crypto";
import type { SignalEvidence, SignalWeakness } from "./signals.ts";

/** Metric families synthesized from contract-bounded recon evidence. */
export type LeverMetricKind = "command-duration" | "command-success" | "suite-failures" | "score" | "unmeasurable";

/** Where a recon proposal came from. */
export type LeverSourceKind = SignalWeakness["kind"] | "recon-command";

/** A declared command a recon lever measures, kept as exact argv. */
export interface LeverCommand {
  argv: string[];
  shim: boolean;
  source: string;
  entry: string | null;
}

export interface LeverAttempt {
  leverId: string;
  outcome: "win" | "no-win" | "rejected" | "error";
}

export interface LeverEstimates {
  expectedGain: number;
  costSeconds: number;
  confidence: number;
  readiness: number;
}

export interface LeverProposal {
  id: string;
  sourceKind: LeverSourceKind;
  goal: string;
  mechanism: string;
  metric: string;
  metricKind: LeverMetricKind;
  scopeFiles: string[];
  gates: string[];
  estimates: LeverEstimates;
  score: number;
  evidence: SignalEvidence[];
  reasons: string[];
  command?: LeverCommand;
}

export interface RejectedLever {
  id: string;
  sourceKind: LeverSourceKind;
  reason: string;
  readiness: number;
}

export interface LeverInventory {
  levers: LeverProposal[];
  rejected: RejectedLever[];
  diagnostics: string[];
}

export function leverId(kind: LeverSourceKind, refs: string[]): string {
  const stable = `${kind}\u0000${[...refs].sort().join("\u0000")}`;
  return createHash("sha256").update(stable).digest("hex").slice(0, 12);
}

/** Shared attempt demotion applied by recon when ranking a previously tried lever. */
const ATTEMPT_DEMOTION: Record<LeverAttempt["outcome"], number> = {
  win: 0.15,
  "no-win": 0.5,
  rejected: 0.35,
  error: 0.6,
};

export function attemptDemotion(outcome: LeverAttempt["outcome"] | undefined): number {
  return outcome === undefined ? 1 : ATTEMPT_DEMOTION[outcome];
}
