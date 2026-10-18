import { createHash } from "node:crypto";

import type { SignalEvidence, SignalWeakness } from "./signals.ts";

/**
 * Evidence-ranked lever inventory for the unattended RSI loop.
 *
 * The inventory converts bounded signal weaknesses into patchable improvement
 * levers with explicit estimates for expected gain, cost, confidence, and
 * verification readiness. It never inspects repository names, paths, or
 * benchmark answers: every decision uses only the canonical labels and counts
 * that `collectSignals` already emits, so the same logic runs unchanged on any
 * project and any language stack.
 */

export type LeverMetricKind = "command-duration" | "command-success" | "suite-failures" | "score" | "unmeasurable";

/**
 * Where a lever came from. `recon-command` is cold-start discovery: a declared
 * workload measured by the project's own manifest, with no session history.
 */
export type LeverSourceKind = SignalWeakness["kind"] | "recon-command";

/** A declared command a recon lever measures, kept as exact argv. */
export interface LeverCommand {
  argv: string[];
  /** True when argv[0] is a package-manager shim that needs the command interpreter on Windows. */
  shim: boolean;
  source: string;
  entry: string | null;
}

export interface LeverAttempt {
  leverId: string;
  outcome: "win" | "no-win" | "rejected" | "error";
}

export interface LeverEstimates {
  /** Normalized 0..1 estimate of the achievable improvement. */
  expectedGain: number;
  /** Estimated evaluator cost in seconds for one measurement sample. */
  costSeconds: number;
  /** Normalized 0..1 confidence that the evidence reflects a real bottleneck. */
  confidence: number;
  /** Normalized 0..1 readiness to build, calibrate, and verify a metric. */
  readiness: number;
}

export interface LeverProposal {
  /** Stable content-addressed id over the signal kind and its evidence refs. */
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
  /** Present for a recon lever: the exact declared workload to measure. */
  command?: LeverCommand;
}

export interface RejectedLever {
  id: string;
  sourceKind: LeverSourceKind;
  reason: string;
  readiness: number;
}

export interface LeverInventory {
  /** Ready-for-verification levers, highest score first. */
  levers: LeverProposal[];
  /** Signals that cannot become a verifiable lever yet, with the exact reason. */
  rejected: RejectedLever[];
  diagnostics: string[];
}

export interface BuildLeverInventoryOptions {
  weaknesses: SignalWeakness[];
  /** Outcome history from prior loop iterations, keyed by lever id. */
  attempts?: LeverAttempt[];
}

/**
 * Canonical command heads that can be reconstructed and re-run from their label
 * alone. Membership is deliberately limited to the language-agnostic heads that
 * `signals.ts` emits and whose argv can be rebuilt without guessing (the generic
 * "node" and "git" heads are excluded: they do not identify what to run).
 */
const RUNNABLE_HEADS = new Set([
  "npm test", "pytest", "make test", "cargo test", "cargo benchmark",
  "go test", "maven test", "gradle test", "composer test",
  "bundle exec rake test", "mix test", "dotnet test",
]);

/** Estimated seconds for one evaluator sample when no measured duration exists. */
const DEFAULT_SAMPLE_SECONDS: Record<string, number> = {
  "npm test": 90, pytest: 60, "make test": 90, "cargo test": 60, "cargo benchmark": 120,
  "go test": 45, "maven test": 180, "gradle test": 120, "composer test": 60,
  "bundle exec rake test": 90, "mix test": 60, "dotnet test": 90,
};
const FALLBACK_SAMPLE_SECONDS = 60;
const MIN_SAMPLE_SECONDS = 5;
const MAX_SAMPLE_SECONDS = 600;

/** Canonical gate command per manifest that `signals.ts` labels as a test target. */
const TEST_COMMANDS: Record<string, string> = {
  "package.json": "npm test",
  "pyproject.toml": "pytest",
  Makefile: "make test",
  "Cargo.toml": "cargo test",
  "go.mod": "go test",
  "pom.xml": "maven test",
  "build.gradle": "gradle test",
  "build.gradle.kts": "gradle test",
  "composer.json": "composer test",
  Gemfile: "bundle exec rake test",
  "mix.exs": "mix test",
  dotnet: "dotnet test",
};

/** Attempt-outcome demotion factors: a solved or failing lever loses priority. */
const ATTEMPT_DEMOTION: Record<LeverAttempt["outcome"], number> = {
  win: 0.15,
  "no-win": 0.5,
  rejected: 0.35,
  error: 0.6,
};

const MAX_DURATION_BAIT = 30_000;

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function leverId(kind: LeverSourceKind, refs: string[]): string {
  const stable = `${kind}\u0000${[...refs].sort().join("\u0000")}`;
  return createHash("sha256").update(stable).digest("hex").slice(0, 12);
}

/** Extract the "took up to N ms" value from a slow-command summary (format produced by signals.ts). */
function measuredDurationMs(weakness: SignalWeakness): number | null {
  const match = /took up to (\d+) ms/.exec(weakness.summary);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function eventCount(weakness: SignalWeakness): number {
  return weakness.evidence.reduce((total, item) => total + (Number.isFinite(item.count) ? item.count : 0), 0);
}

/**
 * Declared gate commands from evaluator signals. The ref format is
 * "manifest:category" and only canonical test targets become gates.
 */
function declaredGates(weaknesses: SignalWeakness[]): string[] {
  const gates = new Set<string>();
  for (const weakness of weaknesses) {
    if (weakness.kind !== "evaluator") continue;
    for (const item of weakness.evidence) {
      const [source, category] = item.ref.split(":");
      // signals.ts reports pyproject pytest config under the "pytest" category
      // and every other manifest under "test".
      const command = category === "pytest" && source === "pyproject.toml"
        ? "pytest"
        : category === "test" ? TEST_COMMANDS[source] : undefined;
      if (command) gates.add(command);
    }
  }
  return [...gates].sort();
}

/**
 * Confidence from evidence breadth: more distinct sources and more recorded
 * events raise confidence, with a saturating event term.
 */
function confidenceOf(weakness: SignalWeakness, corroborating: SignalWeakness[]): number {
  const sources = new Set(weakness.evidence.map((item) => item.source));
  for (const other of corroborating) for (const item of other.evidence) sources.add(item.source);
  const events = eventCount(weakness) + corroborating.reduce((total, other) => total + eventCount(other), 0);
  const breadth = 0.3 + 0.2 * Math.max(0, sources.size - 1);
  const volume = 0.3 * (1 - Math.exp(-events / 10));
  return clamp01(breadth + volume);
}

function computeScore(estimates: LeverEstimates, demotion: number): number {
  const gainTerm = estimates.expectedGain * estimates.confidence * estimates.readiness;
  const costTerm = Math.pow(clamp(estimates.costSeconds, MIN_SAMPLE_SECONDS, MAX_SAMPLE_SECONDS), 0.25);
  return demotion * gainTerm / costTerm;
}

function sampleSecondsFor(head: string, measuredMs: number | null): number {
  if (measuredMs !== null) return clamp(measuredMs / 1000, MIN_SAMPLE_SECONDS, MAX_SAMPLE_SECONDS);
  return clamp(DEFAULT_SAMPLE_SECONDS[head] ?? FALLBACK_SAMPLE_SECONDS, MIN_SAMPLE_SECONDS, MAX_SAMPLE_SECONDS);
}

export function buildLeverInventory(options: BuildLeverInventoryOptions): LeverInventory {
  const weaknesses = options.weaknesses;
  const attempts = options.attempts ?? [];
  const diagnostics: string[] = [];
  const gates = declaredGates(weaknesses);
  if (gates.length > 0) diagnostics.push(`Declared test gates: ${gates.join(", ")}.`);

  const attemptByLever = new Map<string, LeverAttempt>();
  for (const attempt of attempts) {
    if (!attemptByLever.has(attempt.leverId)) attemptByLever.set(attempt.leverId, attempt);
    else diagnostics.push(`Multiple recorded attempts for one lever; the first is used for ranking.`);
  }

  const evaluatorKinds = weaknesses.filter((item) => item.kind === "evaluator").length;
  if (evaluatorKinds > 0) diagnostics.push(`${evaluatorKinds} evaluator target signal(s) treated as gate capability, not as levers.`);

  const levers: LeverProposal[] = [];
  const rejected: RejectedLever[] = [];
  const indexed = weaknesses.map((weakness) => ({ weakness, refs: new Set(weakness.evidence.map((item) => item.ref)) }));

  const reject = (weakness: SignalWeakness, reason: string, readiness: number): void => {
    rejected.push({ id: leverId(weakness.kind, weakness.evidence.map((item) => item.ref)), sourceKind: weakness.kind, reason, readiness });
  };

  const corroboratingFor = (weakness: SignalWeakness): SignalWeakness[] => {
    const own = indexed.find((entry) => entry.weakness === weakness);
    if (!own) return [];
    return indexed
      .filter((entry) => entry.weakness !== weakness && [...entry.refs].some((ref) => own.refs.has(ref)))
      .map((entry) => entry.weakness);
  };

  const push = (weakness: SignalWeakness, fields: {
    goal: string; mechanism: string; metric: string; metricKind: LeverMetricKind;
    scopeFiles: string[]; readiness: number; expectedGain: number; costSeconds: number;
  }): void => {
    const refs = weakness.evidence.map((item) => item.ref);
    const id = leverId(weakness.kind, refs);
    const confidence = confidenceOf(weakness, corroboratingFor(weakness));
    const estimates: LeverEstimates = {
      expectedGain: clamp01(fields.expectedGain),
      costSeconds: fields.costSeconds,
      confidence,
      readiness: clamp01(fields.readiness),
    };
    const attempt = attemptByLever.get(id);
    const reasons: string[] = [
      `evidence: ${eventCount(weakness)} event(s) across ${new Set(weakness.evidence.map((item) => item.source)).size} source(s); ${weakness.summary}`,
      `metric: ${fields.metricKind} — ${fields.metric}`,
    ];
    if (fields.scopeFiles.length > 0) reasons.push(`scope: ${fields.scopeFiles.length} known file(s) from recorded evidence.`);
    if (gates.length > 0 && fields.metricKind !== "unmeasurable") reasons.push(`gate: ${gates.join(", ")} declared by the project.`);
    let demotion = 1;
    if (attempt) {
      demotion = ATTEMPT_DEMOTION[attempt.outcome];
      reasons.push(`history: prior outcome ${attempt.outcome} for this lever; score adjusted by x${demotion}.`);
    }
    const score = computeScore(estimates, demotion);
    levers.push({
      id,
      sourceKind: weakness.kind,
      goal: fields.goal,
      mechanism: fields.mechanism,
      metric: fields.metric,
      metricKind: fields.metricKind,
      scopeFiles: fields.scopeFiles,
      gates: [...gates],
      estimates,
      score,
      evidence: weakness.evidence.map((item) => ({ ...item })),
      reasons,
    });
  };

  for (const weakness of weaknesses) {
    switch (weakness.kind) {
      case "session-failure": {
        const head = weakness.evidence[0]?.ref ?? "shell command";
        const count = eventCount(weakness);
        if (!RUNNABLE_HEADS.has(head)) {
          reject(weakness, `the canonical "${head}" label cannot be reconstructed into a runnable command, so no evaluator can be synthesized`, 0.2);
          break;
        }
        const slow = indexed.find((entry) => entry.weakness.kind === "slow-command" && entry.refs.has(head))?.weakness;
        const measured = slow ? measuredDurationMs(slow) : null;
        push(weakness, {
          goal: `Make the "${head}" command pass reliably without regressing other checks.`,
          mechanism: "repair the failing canonical command",
          metric: `"${head}" failure count (count, lower is better)`,
          metricKind: "command-success",
          scopeFiles: [...(weakness.scopeHints ?? [])].slice(0, 5),
          readiness: 0.5 + 0.25 + (gates.length > 0 ? 0.15 : 0),
          expectedGain: count / (count + 3),
          costSeconds: sampleSecondsFor(head, measured),
        });
        break;
      }
      case "slow-command": {
        const head = weakness.evidence[0]?.ref ?? "shell command";
        const measured = measuredDurationMs(weakness);
        if (!RUNNABLE_HEADS.has(head) || measured === null) {
          reject(weakness, `the canonical "${head}" label cannot be reconstructed into a runnable command or has no measured duration, so no evaluator can be synthesized`, 0.2);
          break;
        }
        push(weakness, {
          goal: `Reduce the wall-clock duration of "${head}".`,
          mechanism: "optimize the slow canonical command",
          metric: `"${head}" wall-clock duration (ms, lower is better)`,
          metricKind: "command-duration",
          scopeFiles: [...(weakness.scopeHints ?? [])].slice(0, 5),
          readiness: 0.5 + 0.25 + (gates.length > 0 ? 0.15 : 0),
          expectedGain: clamp01(measured / MAX_DURATION_BAIT),
          costSeconds: sampleSecondsFor(head, measured),
        });
        break;
      }
      case "post-failure-edits": {
        const scopeFiles = weakness.evidence.map((item) => item.ref).filter((ref) => ref.includes("/") || ref.includes("."));
        if (gates.length === 0) {
          reject(weakness, "no declared test gate exists, so the follow-up-edit weakness cannot be measured", 0.25);
          break;
        }
        push(weakness, {
          goal: `Reduce failing checks in the area of ${scopeFiles.length} recorded follow-up file edit(s).`,
          mechanism: "stabilize the files that were edited after failures",
          metric: `"${gates[0]}" failing check count (count, lower is better)`,
          metricKind: "suite-failures",
          scopeFiles,
          readiness: 0.5 + (gates.length > 0 ? 0.15 : 0) + (scopeFiles.length > 0 ? 0.1 : 0),
          expectedGain: clamp01(eventCount(weakness) / 5),
          costSeconds: sampleSecondsFor(gates[0], null),
        });
        break;
      }
      case "evaluator":
        break; // capability signal, consumed through declaredGates
      case "session-tool-error":
      case "repeated-tool-retry":
      case "aborted-session":
      case "session-compaction":
      case "session-model-change":
      case "dream-improve":
        reject(weakness, "session-tooling signal does not identify a patchable repository behavior with a measurable outcome", 0);
        break;
      case "git-hotspot":
      case "git-churn":
        reject(weakness, "churn-only evidence has no measurable outcome without a declared benchmark, so no metric can be calibrated", 0.15);
        break;
      case "campaign-failure":
      case "campaign-rejection":
      case "campaign-health":
        reject(weakness, "campaign-history signal is used for memory and stop rules, not as a patchable lever", 0);
        break;
    }
  }

  levers.sort((a, b) => b.score - a.score
    || b.estimates.expectedGain - a.estimates.expectedGain
    || a.id.localeCompare(b.id));
  rejected.sort((a, b) => a.sourceKind.localeCompare(b.sourceKind) || a.id.localeCompare(b.id));
  if (levers.length === 0) diagnostics.push("No lever passed verification-readiness screening; only rejections are available.");
  return { levers, rejected, diagnostics };
}

export interface LeverIntake {
  goal: string;
  scope_files: string[];
  metric: string;
  evaluator_kind: "command";
  readiness: "ready" | "needs_setup";
}

/**
 * Map a proposal onto the public campaign intake lever shape. A lever is ready
 * only when its readiness estimate and a known patch scope support synthesis,
 * calibration, and a scoped patch without further discovery.
 */
export function leverIntake(proposal: LeverProposal): LeverIntake {
  const ready = proposal.estimates.readiness >= 0.7 && proposal.scopeFiles.length > 0 && proposal.metricKind !== "unmeasurable";
  return {
    goal: proposal.goal,
    scope_files: [...proposal.scopeFiles],
    metric: proposal.metric,
    evaluator_kind: "command",
    readiness: ready ? "ready" : "needs_setup",
  };
}
