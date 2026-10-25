import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { copyWorkspace, runShellCommand } from "../agent/runner.ts";
import { absoluteGain, restrictedEnvironment, type MinimumGain, type RunContract } from "./intake.ts";
import type { LeverCommand, LeverProposal } from "./levers.ts";
import { PROMOTION_AGENT_STARTS, promotionFloor } from "./campaign.ts";
import { planAdmission } from "./admission.ts";

/**
 * Synthesize and pre-calibrate the instrument for a lever when the intake has
 * no evaluator. The generated evaluator lives under the loop's own state
 * directory (outside any candidate-editable scope), runs one canonical command,
 * and writes a numeric score plus a validity verdict. The approved contract's
 * independent qualification runs before any agent starts.
 */

export interface MetricPlan {
  leverId: string;
  metricKind: LeverProposal["metricKind"];
  direction: "minimize" | "maximize";
  higherIsBetter: boolean;
  unit: string;
  /** Project-relative evaluator path, safe to declare as a verifier input. */
  evaluatorPath: string;
  /** Declared evaluator inputs (project-relative) pinned as verifier inputs, never candidate-editable. */
  evaluatorInputs: string[];
  /** Where the declared score evaluator reports its number; absent for synthesized duration/failure metrics. */
  evaluatorOutput?: "score-json" | "stdout-number" | "stdout-json";
  scorePath: string;
  /** Exact argv the generated evaluator runs in the candidate copy. */
  argv: string[];
  headCommand: string;
  gates: string[];
  /** Per-workload timeout inside the evaluator wrapper. */
  sampleTimeoutMs: number;
  workloadTimeoutMs: number;
  /** Overall wrapper timeout, corresponding to task evaluator_timeout_ms. */
  wrapperTimeoutMs: number;
  /** Grace reserved inside the wrapper for cleanup and verdict writing. */
  cleanupGraceMs: number;
  /** Expected evaluator duration used for admission; never the timeout budget. */
  expectedReadMs: number;
  ready: boolean;
  rejections: string[];
  notes: string[];
  /** Frozen identity of the instrument once it is qualified. */
  evaluationContract?: EvaluationContract;
  /** Qualification evidence, when the instrument was validated without a winning patch. */
  qualification?: QualificationReport;
}

/** The approved contract's score instrument, as the metric authoring stage consumes it. */
export interface ScoreMetricSpec {
  /** Exact declared evaluator argv; measured verbatim. */
  argv: string[];
  /** Where the number comes from. */
  output: "score-json" | "stdout-number" | "stdout-json";
  /** Project-relative evaluator code/data pinned as verifier inputs. */
  inputs?: string[];
  /** Approved outcome unit (for example "points"). */
  unit: string;
  /** Approved outcome direction. */
  higherIsBetter: boolean;
}

/**
 * The frozen instrument. Its id is a digest over everything that can change a
 * score, so a revised evaluator, workload, gate set or baseline starts a new,
 * non-comparable history instead of silently reusing old results.
 */
export interface EvaluationContract {
  id: string;
  outcome: string;
  unit: string;
  higherIsBetter: boolean;
  minimumUsefulGain: MinimumGain;
  metricKind: LeverProposal["metricKind"];
  /** Exact argv of the measured workload. */
  argv: string[];
  /** Commands that must keep passing for an improvement to count. */
  gates: string[];
  /** Digests of the evaluator script and any declared control asset. */
  assets: { path: string; sha256: string }[];
  /** Readings of the unchanged target that the instrument must reproduce. */
  baseline: number[];
  /** Measured response to the degraded control, in the metric's units. */
  sensitivity: number | null;
  /** How confirmation inputs are kept out of candidate copies. */
  confirmationPerspective: string;
}

export interface QualificationCheck {
  name: "workload" | "baseline" | "stability" | "sensitivity" | "direction" | "missing-workload" | "oracle" | "budget-fit" | "identity-stability";
  passed: boolean;
  /** False for diagnostic oracle channels that cannot distinguish allowed optimization from regression. */
  required: boolean;
  detail: string;
}

export interface QualificationReport {
  passed: boolean;
  checks: QualificationCheck[];
  contract: EvaluationContract | null;
  rejections: string[];
  /** Restart-readable bounded execution evidence, stored outside disposable copies. */
  evidencePath?: string;
}

export interface QualificationOptions {
  contract: RunContract;
  /** Directory for disposable copies; never inside the project. */
  workRoot: string;
  /** The approved outcome this instrument is supposed to observe. */
  outcome: string;
  /** Smallest change worth applying, from the approved contract. */
  minimumUsefulGain: MinimumGain;
  /** Candidate-visible files used to test oracle sensitivity. */
  editableScope?: string[];
  /** Seam for tests and diagnostics: replace the scratch remover to observe cleanup failures. */
  removeScratch?: typeof fs.rmSync;
  /** Durable accounting, called immediately before each qualification process starts. */
  beforeEvaluatorRun?: () => void;
  /** Remaining evaluator allowance after discovery and earlier loop work. */
  availableEvaluatorRuns?: number;
  /** Run qualification evaluators and gates in disposable OS-contained copies. */
  signal?: AbortSignal;
  /** Absolute loop deadline; qualification child calls never outlive this bound. */
  deadlineAt?: number;
  /** Host-side extra work injected into the same measured operation, in milliseconds. */
  injectedDelayMs?: number;
  /**
   * Baseline passes to take before refusing on instability. A busy machine can
   * produce one unusually jittery series; taking a second sample with exactly the
   * same thresholds distinguishes that from an instrument that is genuinely unable
   * to resolve the useful gain. A truly noisy instrument fails every pass.
   */
  baselinePasses?: number;
  /** Baseline readings to take. */
  baselineRuns?: number;
}

export interface SynthesizeMetricOptions {
  projectDir: string;
  /** Observed duration of the declared workload from discovery, when available. */
  expectedReadMs?: number;
  /** Exact declared workload from cold-start discovery, preferred over head resolution. */
  command?: LeverCommand;
  /**
   * The approved contract's declared score evaluator. Required for a "score"
   * metric kind; the evaluator, not wall time, is what a score lever measures.
   */
  scoreEvaluator?: ScoreMetricSpec;
  /** Qualify the instrument without a supplied winning patch. */
  qualification?: QualificationOptions;
  /** Explicit task evaluator timeout; absent preserves synthesized defaults. */
  evaluatorTimeoutMs?: number;
  /** Defaults to <projectDir>/.dream-rsi/loop. */
  loopRoot?: string;
  lever: LeverProposal;
  /** Test seam: override the argv resolved for a canonical head. */
  commandOverrides?: Record<string, string[]>;
  /** Evaluator sample count for failure-count metrics. */
  repeats?: number;
}

const FAILURE_REPEATS = 3;
const DURATION_REPEATS = 3;
const MIN_SAMPLE_TIMEOUT_MS = 30_000;
const MIN_SCORE_SAMPLE_TIMEOUT_MS = 10 * 60 * 1000;
const SCORE_PATH = "eval/score.json";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Resolve a canonical command label into argv using only standard project
 * evidence (lockfiles). No repository name, path, or answer participates.
 */
export function parseFailureCount(output: string): number {
  const unitTest = [...output.matchAll(/(?:failures?|errors?)\s*=\s*(\d+)/gi)];
  if (unitTest.length > 0) {
    const count = unitTest.reduce((sum, match) => sum + Number(match[1]), 0);
    return Math.max(1, Math.min(1_000_000, Number.isSafeInteger(count) ? count : 1));
  }
  const junit = output.match(/Failures:\s*(\d+)(?:\s*,\s*Errors:\s*(\d+))?/i);
  if (junit) return Math.max(1, Math.min(1_000_000, Number(junit[1]) + Number(junit[2] ?? 0)));
  const common = output.match(/\b(\d+)\s+(?:failed|failing)\b/i) ?? output.match(/\b(?:fail(?:ed)?)\s+(\d+)\b/i);
  if (common) {
    const failures = Number(common[1]);
    const errors = output.match(/\b(\d+)\s+errors?\b/i);
    return Math.max(1, Math.min(1_000_000, failures + Number(errors?.[1] ?? 0)));
  }
  const tapFailures = output.match(/^\s*not ok\b/gim)?.length ?? 0;
  return Math.max(1, Math.min(1_000_000, tapFailures || 1));
}

export function commandForHead(head: string, projectDir: string, overrides?: Record<string, string[]>): string[] | null {
  if (overrides?.[head]) return [...overrides[head]];
  switch (head) {
    case "npm test": {
      if (fs.existsSync(path.join(projectDir, "bun.lockb")) || fs.existsSync(path.join(projectDir, "bun.lock"))) return ["bun", "test"];
      if (fs.existsSync(path.join(projectDir, "pnpm-lock.yaml"))) return ["pnpm", "test"];
      if (fs.existsSync(path.join(projectDir, "yarn.lock"))) return ["yarn", "test"];
      return ["npm", "test"];
    }
    case "pytest": return process.platform === "win32" ? ["python", "-m", "pytest"] : ["python3", "-m", "pytest"];
    case "make test": return ["make", "test"];
    case "cargo test": return ["cargo", "test"];
    case "cargo benchmark": return ["cargo", "bench"];
    case "go test": return ["go", "test", "./..."];
    case "maven test": return ["mvn", "test"];
    case "gradle test": return ["gradle", "test"];
    case "composer test": return ["composer", "test"];
    case "bundle exec rake test": return ["bundle", "exec", "rake", "test"];
    case "mix test": return ["mix", "test"];
    case "dotnet test": return ["dotnet", "test"];
    default: return null;
  }
}

interface EvaluatorSourceSpec {
  argv: string[];
  mode: "duration" | "failures" | "score";
  repeats: number;
  sampleTimeoutMs: number;
  wrapperTimeoutMs: number;
  injectedDelayMs?: number;
  /** score mode: where the declared evaluator reports its number. */
  scoreOutput?: "score-json" | "stdout-number" | "stdout-json";
  /** score mode: the approved unit, recorded in the reading. */
  unit?: string;
  /** Environment keys whose values must not appear in evaluator diagnostics. */
  redactEnvKeys?: string[];
}

function evaluatorSource(spec: EvaluatorSourceSpec): string {
  const { argv, mode, repeats, sampleTimeoutMs, injectedDelayMs = 0 } = spec;
  return `// Generated by pi-dream-rsi engine/metrics.ts. Pinned metric evaluator.
// Runs the declared program in the current copy and writes ${SCORE_PATH}.
import { runCommand } from ${JSON.stringify(new URL("../agent/runner.ts", import.meta.url).href)};
import * as fs from "node:fs";
import * as path from "node:path";

const COMMAND = ${JSON.stringify(argv)};
const MODE = ${JSON.stringify(mode)};
const REPEATS = ${repeats};
const WARMUP = MODE === "duration" ? 1 : 0;
const SAMPLE_TIMEOUT_MS = ${sampleTimeoutMs};
const WRAPPER_TIMEOUT_MS = ${spec.wrapperTimeoutMs};
// Host-side extra work inside the measured span. Zero for the real instrument; a
// positive value is the sensitivity control that proves the channel responds to
// duration changes at this exact seam.
const INJECTED_DELAY_MS = ${injectedDelayMs};
const OUTPUT = ${JSON.stringify(SCORE_PATH)};
// score mode only: the declared evaluator's output contract and the outcome unit.
const SCORE_OUTPUT = ${JSON.stringify(spec.scoreOutput ?? null)};
const SCORE_UNIT = ${JSON.stringify(spec.unit ?? "")};
const REDACT_ENV_KEYS = ${JSON.stringify(spec.redactEnvKeys ?? [])};
const MAX_DIAGNOSTIC_CHARS = 4096;
// Provenance of the invocation that produced this verdict. Report execution rows are
// otherwise wrapper-level, which hides an inner child that was killed or exited non-zero.
let CHILD_PROVENANCE = null;

function safeDiagnostic(value) {
  let text = String(value || "");
  const secrets = REDACT_ENV_KEYS.map((key) => process.env[key]).filter((secret) => typeof secret === "string" && secret.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join("[redacted]");
  return text.length > MAX_DIAGNOSTIC_CHARS ? "…" + text.slice(-MAX_DIAGNOSTIC_CHARS) : text;
}

function write(fields) {
  const file = path.resolve(process.cwd(), OUTPUT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ score: 0, raw_score: null, valid: false, fail_class: "evaluator_error", error: null, wrapper_timeout_ms: WRAPPER_TIMEOUT_MS, workload_timeout_ms: SAMPLE_TIMEOUT_MS, ...(CHILD_PROVENANCE ? { child: CHILD_PROVENANCE } : {}), ...fields }, null, 2) + "\\n", "utf8");
}

function hostDelay(ms) {
  if (!(ms > 0)) return;
  const until = performance.now() + ms;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    while (performance.now() < until) { /* busy wait where Atomics is unavailable */ }
  }
}

async function runOnce() {
  const started = performance.now();
  hostDelay(INJECTED_DELAY_MS);
  // Windows resolves the npm/pnpm/yarn/bun/composer/bundle shims only through the command
  // interpreter. A path-like command is a real executable and spawns directly, so spaced paths
  // stay intact; a bare name goes through cmd.exe, and those canonical arguments carry no spaces
  // and no user text, so the plain command string is safe.
  const shim = process.platform === "win32" && (!/[\\\\/]/.test(COMMAND[0]) || /\\.(?:cmd|bat)$/i.test(COMMAND[0]));
  // The plain string reaches the interpreter unquoted. Refuse anything the interpreter could
  // split or expand instead of silently running a different command (fail closed).
  if (shim && COMMAND.some((part) => typeof part !== "string" || part.length === 0 || part.includes(" ") || /[&|<>^"%!()]/.test(part))) {
    const blocked = new Error("command is not safe for the Windows command interpreter: " + COMMAND.join(" "));
    blocked.code = "ESPAWN_GUARD";
    CHILD_PROVENANCE = { refused: true, argv: COMMAND.slice(0, 8).map((part) => safeDiagnostic(part)), exit_code: null, signal: null, timed_out: false };
    return { result: { error: blocked, status: null }, elapsedMs: 0 };
  }
  const file = shim ? (process.env.ComSpec || "cmd.exe") : COMMAND[0];
  const args = shim ? ["/d", "/s", "/c", COMMAND.join(" ")] : COMMAND.slice(1);
  const child = await runCommand(file, args, { cwd: process.cwd(), timeoutMs: SAMPLE_TIMEOUT_MS, killTree: true });
  const elapsedMs = performance.now() - started;
  CHILD_PROVENANCE = { refused: false, argv: [file, ...args].slice(0, 8).map((part) => safeDiagnostic(part)),
    exit_code: child.code, signal: child.signal ?? null, timed_out: Boolean(child.timedOut) };
  const error = child.spawnError ? Object.assign(new Error(child.spawnError), { code: "ESPAWN" })
    : child.timedOut ? Object.assign(new Error("workload timed out"), { code: "ETIMEDOUT" }) : null;
  return { result: { error, status: child.code, stdout: child.stdoutTail, stderr: child.stderrTail, signal: child.signal }, elapsedMs };
}

async function main() {
  if (MODE === "score") {
    // Never read a stale number: the declared evaluator must write this reading.
    if (SCORE_OUTPUT === "score-json") {
      try { fs.rmSync(path.resolve(process.cwd(), OUTPUT), { force: true }); } catch { /* absent is fine */ }
    }
    const { result } = await runOnce();
    if (result.error) {
      return write({ error: safeDiagnostic(result.error.message || result.error), fail_class: result.error.code === "ETIMEDOUT" ? "timeout" : "spawn_error", mode: MODE, unit: SCORE_UNIT });
    }
    if (result.status !== 0) {
      let structured = null;
      try { structured = JSON.parse(String(result.stdout || "").trim()); } catch { /* stdout may be plain diagnostics */ }
      if ((!structured || typeof structured !== "object") && SCORE_OUTPUT === "score-json") {
        try { structured = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), OUTPUT), "utf8")); } catch { /* no usable score file */ }
      }
      const failClass = typeof structured?.fail_class === "string" && structured.fail_class
        ? safeDiagnostic(structured.fail_class).slice(0, 100)
        : "evaluator_error";
      const structuredError = typeof structured?.error === "string" && structured.error ? safeDiagnostic(structured.error) : "";
      const stdout = safeDiagnostic(result.stdout);
      const stderr = safeDiagnostic(result.stderr);
      const diagnostics = [
        structuredError ? "evaluator error: " + structuredError : "",
        stdout ? "stdout: " + stdout : "",
        stderr ? "stderr: " + stderr : "",
      ].filter(Boolean).join("\\n");
      return write({ error: "evaluator exited with status " + result.status + (diagnostics ? "\\n" + diagnostics : ""), fail_class: failClass, mode: MODE, unit: SCORE_UNIT });
    }
    if (SCORE_OUTPUT === "stdout-json") {
      let parsed = null;
      try { parsed = JSON.parse(String(result.stdout || "").trim()); } catch { parsed = null; }
      if (!parsed || typeof parsed !== "object" || parsed.valid !== true || parsed.fail_class && parsed.fail_class !== "ok") {
        return write({ error: "stdout-json evaluator must print one valid JSON score verdict", fail_class: "invalid_output", mode: MODE, unit: SCORE_UNIT });
      }
      if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score)) {
        return write({ error: "stdout-json evaluator score must be a finite number", fail_class: "invalid_output", mode: MODE, unit: SCORE_UNIT });
      }
      return write({ score: parsed.score, raw_score: parsed.score, valid: true, fail_class: "ok", error: null, mode: MODE, unit: SCORE_UNIT, samples: [parsed.score] });
    }
    if (SCORE_OUTPUT === "stdout-number") {
      const text = String(result.stdout || "").trim();
      if (!/^[+-]?(?:(?:\\d+(?:\\.\\d*)?)|(?:\\.\\d+))(?:e[+-]?\\d+)?$/i.test(text)) {
        return write({ error: "evaluator stdout must contain one finite number", fail_class: "invalid_output", mode: MODE, unit: SCORE_UNIT });
      }
      const value = Number(text);
      if (!Number.isFinite(value)) {
        return write({ error: "evaluator stdout must contain one finite number", fail_class: "invalid_output", mode: MODE, unit: SCORE_UNIT });
      }
      return write({ score: value, raw_score: value, valid: true, fail_class: "ok", error: null, mode: MODE, unit: SCORE_UNIT, samples: [value] });
    }
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), OUTPUT), "utf8")); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object") {
      return write({ error: "score-json evaluator did not write a valid score to " + OUTPUT, fail_class: "invalid_output", mode: MODE, unit: SCORE_UNIT });
    }
    if (parsed.valid !== true) {
      return write({
        error: typeof parsed.error === "string" && parsed.error ? safeDiagnostic(parsed.error) : "score-json evaluator reported an invalid score",
        fail_class: typeof parsed.fail_class === "string" && parsed.fail_class ? safeDiagnostic(parsed.fail_class).slice(0, 100) : "invalid_output",
        mode: MODE, unit: SCORE_UNIT,
      });
    }
    if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score)) {
      return write({ error: "score-json evaluator score must be a finite number", fail_class: "invalid_output", mode: MODE, unit: SCORE_UNIT });
    }
    return write({ score: parsed.score, raw_score: parsed.score, valid: true, fail_class: "ok", error: null, mode: MODE, unit: SCORE_UNIT, samples: [parsed.score] });
  }
  if (MODE === "failures") {
    let failures = 0;
    const samples = [];
    for (let index = 0; index < REPEATS; index += 1) {
      const { result } = await runOnce();
      if (result.error && result.error.code !== "ETIMEDOUT") {
        return write({ error: String(result.error.message || result.error), fail_class: "spawn_error", mode: MODE });
      }
      const stderr = String(result.stderr || "");
      const missingCommand = stderr.split(String.fromCharCode(10)).some((line) => {
        const text = line.trim().toLowerCase();
        return (text.startsWith("/bin/sh:") || text.startsWith("/usr/bin/bash:")) && text.endsWith(": not found")
          || text.startsWith("'") && text.includes("' is not recognized as an internal or external command")
          || text.startsWith("the system cannot find the path specified")
          || text.startsWith("the system cannot find the file specified");
      });
      if (missingCommand) {
        return write({ error: "workload command could not be found", fail_class: "missing_workload", mode: MODE });
      }
      const failed = result.error?.code === "ETIMEDOUT" || result.status !== 0;
      const output = String(result.stdout || "") + String(result.stderr || "");
      // Count individual failures when the runner reports a machine-readable
      // summary (Node test, TAP and Jest). A deterministic one-test regression
      // can then be distinguished from inert code that breaks additional tests.
      const unitTest = [...output.matchAll(/(?:failures?|errors?)\\s*=\\s*(\\d+)/gi)];
      const junit = output.match(/Failures:\\s*(\\d+)(?:\\s*,\\s*Errors:\\s*(\\d+))?/i);
      const common = output.match(/\\b(\\d+)\\s+(?:failed|failing)\\b/i) || output.match(/\\b(?:fail(?:ed)?)\\s+(\\d+)\\b/i);
      const commonErrors = output.match(/\\b(\\d+)\\s+errors?\\b/i);
      const tapFailures = (output.match(/^\\s*not ok\\b/gim) || []).length;
      const reportedFailures = unitTest.length ? unitTest.reduce((sum, match) => sum + Number(match[1]), 0)
        : junit ? Number(junit[1]) + Number(junit[2] || 0) : common ? Number(common[1]) + Number(commonErrors?.[1] || 0) : tapFailures;
      const failureCount = failed ? Math.max(1, Math.min(1_000_000, Number.isSafeInteger(reportedFailures) ? reportedFailures : 1)) : 0;
      failures += failureCount;
      samples.push(failureCount);
    }
    return write({ score: failures, raw_score: failures, valid: true, fail_class: "ok", error: null, mode: MODE, samples });
  }
  const samples = [];
  for (let index = 0; index < WARMUP + REPEATS; index += 1) {
    const { result, elapsedMs } = await runOnce();
    if (result.error || result.status !== 0) {
      return write({
        error: result.error ? String(result.error.message || result.error) : "command exited with status " + result.status,
        fail_class: result.error && result.error.code === "ETIMEDOUT" ? "timeout" : "command_failed", mode: MODE,
      });
    }
    if (index >= WARMUP) samples.push(elapsedMs);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const score = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  write({ score, raw_score: score, valid: true, fail_class: "ok", error: null, mode: MODE, unit: "ms", samples });
}

await main();
`;
}

/**
 * Build the evaluator, gates, and calibration prerequisites for a lever.
 * Fail closed: any missing prerequisite leaves ready=false with an exact reason.
 */
export async function synthesizeMetric(options: SynthesizeMetricOptions): Promise<MetricPlan> {
  const projectDir = path.resolve(options.projectDir);
  const loopRoot = path.resolve(options.loopRoot ?? path.join(projectDir, ".dream-rsi", "loop"));
  const lever = options.lever;
  const kind = lever.metricKind;
  const notes: string[] = [];
  const rejections: string[] = [];
  // Synthesized metric kinds are counts of badness: milliseconds and failures
  // (lower is better). A declared score evaluator instead takes its direction and
  // unit from the approved outcome, which is the only honest source for them.
  let direction: "minimize" | "maximize" = "minimize";
  let higherIsBetter = false;
  let unit = kind === "command-duration" ? "ms" : "failures";
  // Command-backed levers carry their workload label in the metric and exact argv
  // in the proposal. Suite-failure levers use their failing test label as the head.
  const head = lever.metricKind === "suite-failures"
    ? lever.metric.match(/^"([^"]+)"/)?.[1] ?? "unknown"
    : lever.evidence[0]?.ref ?? lever.gates[0] ?? "unknown";

  const plan: MetricPlan = {
    leverId: lever.id,
    metricKind: kind,
    direction,
    higherIsBetter,
    unit,
    evaluatorPath: "",
    evaluatorInputs: [],
    scorePath: SCORE_PATH,
    argv: [],
    headCommand: head,
    gates: [],
    sampleTimeoutMs: MIN_SAMPLE_TIMEOUT_MS,
    workloadTimeoutMs: MIN_SAMPLE_TIMEOUT_MS,
    wrapperTimeoutMs: MIN_SAMPLE_TIMEOUT_MS + 2_000,
    cleanupGraceMs: 5_000,
    expectedReadMs: Math.max(1, Math.ceil(options.expectedReadMs ?? lever.estimates.costSeconds * 1000)),
    ready: false,
    rejections,
    notes,
  };

  if (kind === "unmeasurable") {
    rejections.push("lever has no measurable metric kind; nothing can be synthesized");
    return plan;
  }

  const score = kind === "score" ? options.scoreEvaluator : undefined;
  if (kind === "score" && !score) {
    rejections.push("score metric kind requires the contract's declared outcome.evaluator; a score instrument cannot be invented");
    return plan;
  }
  if (score && (score.argv.length === 0 || score.argv.some((part) => typeof part !== "string" || !part.trim()))) {
    rejections.push("the declared score evaluator argv is not a non-empty array of non-empty strings");
    return plan;
  }

  // A recon lever states its declared workload exactly; a signal lever falls back
  // to the canonical-head table. A score lever measures the declared evaluator.
  let argv: string[] | null;
  let mode: "duration" | "failures" | "score";
  if (score) {
    direction = score.higherIsBetter ? "maximize" : "minimize";
    higherIsBetter = score.higherIsBetter;
    unit = score.unit;
    argv = [...score.argv];
    mode = "score";
    plan.evaluatorInputs = [...(score.inputs ?? [])].map((input) => input.replace(/\\/g, "/"));
    plan.evaluatorOutput = score.output;
    plan.headCommand = score.argv.join(" ");
    notes.push(`score evaluator ${score.argv.join(" ")} reports ${score.output}; one reading per candidate, no warmup and no synthesized repeat.`);
    if (plan.evaluatorInputs.length > 0) {
      notes.push(`evaluator inputs pinned as verifier inputs and never candidate-editable: ${plan.evaluatorInputs.join(", ")}.`);
    }
  } else {
    argv = options.command?.argv ? [...options.command.argv] : commandForHead(head, projectDir, options.commandOverrides);
    if (!argv || argv.length === 0) {
      rejections.push(`canonical head "${head}" cannot be reconstructed into a runnable command`);
      return plan;
    }
    mode = kind === "command-duration" ? "duration" : "failures";
  }
  plan.direction = direction;
  plan.higherIsBetter = higherIsBetter;
  plan.unit = unit;
  plan.argv = argv;
  if (mode === "score") {
    const missingInputs = plan.evaluatorInputs.filter((input) => !fs.existsSync(path.resolve(projectDir, input)));
    if (missingInputs.length > 0) {
      rejections.push(`declared score evaluator input(s) are missing: ${missingInputs.join(", ")}`);
      return plan;
    }
  }
  if (mode !== "score" && head === "npm test" && argv[0] !== "npm") notes.push(`npm-test head resolved to the ${argv[0]} runner from lockfile evidence.`);

  const repeats = mode === "score" ? 1 : clamp(Math.round(options.repeats ?? (mode === "failures" ? FAILURE_REPEATS : DURATION_REPEATS)), 1, 10);
  const estimatedMs = Math.max(1, Math.ceil(options.expectedReadMs ?? lever.estimates.costSeconds * 1000));
  plan.expectedReadMs = estimatedMs;
  const minimumSampleTimeoutMs = mode === "score" ? MIN_SCORE_SAMPLE_TIMEOUT_MS : MIN_SAMPLE_TIMEOUT_MS;
  const executionCount = repeats + (mode === "duration" ? 1 : 0);
  if (options.evaluatorTimeoutMs !== undefined && (!Number.isSafeInteger(options.evaluatorTimeoutMs) || options.evaluatorTimeoutMs <= 0)) {
    rejections.push("evaluator_timeout_ms must be a positive safe integer");
    return plan;
  }
  const defaultWorkloadTimeoutMs = clamp(Math.ceil(estimatedMs * 2 + 60_000), minimumSampleTimeoutMs, 15 * 60 * 1000);
  const wrapperTimeoutMs = options.evaluatorTimeoutMs ?? defaultWorkloadTimeoutMs * executionCount + plan.cleanupGraceMs;
  const workloadTimeoutMs = Math.floor((wrapperTimeoutMs - plan.cleanupGraceMs) / executionCount);
  if (workloadTimeoutMs < 1_000) {
    rejections.push(`evaluator_timeout_ms ${wrapperTimeoutMs} ms is too small for ${executionCount} workload run(s) plus ${plan.cleanupGraceMs} ms cleanup grace; at least ${executionCount * 1_000 + plan.cleanupGraceMs} ms is required`);
    return plan;
  }
  plan.wrapperTimeoutMs = wrapperTimeoutMs;
  plan.sampleTimeoutMs = workloadTimeoutMs;
  plan.workloadTimeoutMs = workloadTimeoutMs;
  if (options.evaluatorTimeoutMs !== undefined) notes.push(`explicit evaluator_timeout_ms ${wrapperTimeoutMs} ms is the outer wrapper cap; each of ${executionCount} workload run(s) gets ${workloadTimeoutMs} ms and ${plan.cleanupGraceMs} ms is reserved for cleanup and verdict writing.`);
  else notes.push(`generated evaluator wrapper cap ${wrapperTimeoutMs} ms covers ${executionCount} workload run(s) at ${workloadTimeoutMs} ms each plus ${plan.cleanupGraceMs} ms cleanup/write grace.`);

  // Gate policy: a pass/fail gate equal to the metric command cannot pass on the
  // unfixed target, so failure-count metrics keep only additional declared gates.
  // A duration or score metric is not its own gate, so every declared gate stays.
  const metricCommand = head;
  plan.gates = mode === "failures"
    ? lever.gates.filter((gate) => gate !== metricCommand)
    : [...lever.gates];
  if (mode === "failures" && plan.gates.length < lever.gates.length) {
    notes.push(`the "${metricCommand}" gate is the metric command itself and is excluded from gates; the evaluator must keep tests authentic via review and scope.`);
  }

  const evaluatorDir = path.join(loopRoot, "metrics", lever.id);
  fs.mkdirSync(evaluatorDir, { recursive: true });
  const evaluatorFile = path.join(evaluatorDir, "evaluate.mjs");
  fs.writeFileSync(evaluatorFile, evaluatorSource({
    argv,
    mode,
    repeats,
    sampleTimeoutMs: plan.sampleTimeoutMs,
    wrapperTimeoutMs: plan.wrapperTimeoutMs,
    ...(mode === "score" ? { scoreOutput: score!.output, unit: score!.unit, redactEnvKeys: options.qualification?.contract.execution.envAllowlist ?? [] } : {}),
  }), "utf8");
  plan.evaluatorPath = path.relative(projectDir, evaluatorFile).replace(/\\/g, "/");

  if (options.qualification) {
    // Qualify before any agent runs using reproducibility, degraded/missing workload
    // controls, and an inert editable scope that the oracle must reject.
    const qualification = await qualifyInstrument(plan, {
      ...options.qualification,
      projectDir,
      minimumUsefulGain: options.qualification.minimumUsefulGain,
      outcome: options.qualification.outcome,
      gates: plan.gates,
      editableScope: [...lever.scopeFiles],
    });
    if (!qualification.passed) {
      notes.push("instrument qualification refused the lever; see the rejection reasons.");
      return plan;
    }
  }
  plan.ready = true;
  return plan;
}

// ---------------------------------------------------------------------------
// Instrument qualification without a supplied winning patch
// ---------------------------------------------------------------------------

/** The score an instrument must move by before a promotion is worth applying. */
interface InstrumentProbe {
  valid: boolean;
  score: number | null;
  error: string | null;
}

function digestOf(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Identity of the engine source that is actually loaded, captured once.
 *
 * Re-reading the file per receipt would describe whatever is on disk when the
 * receipt is written, not the code that ran: a mid-run edit would silently
 * report a different runtime under the same measurements.
 */
const LOADED_ENGINE_DIGEST: string = (() => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(new URL("./metrics.ts", import.meta.url))).digest("hex");
  } catch {
    return "unavailable";
  }
})();
const LOADED_RUNTIME = Object.freeze({ node: process.version, platform: process.platform, arch: process.arch });

/** Content digest of one declared evaluator input (file or directory), for the frozen identity. */
function digestAsset(absolute: string): string | null {
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isFile()) return digestOf(absolute);
    if (stat.isDirectory()) {
      const hash = crypto.createHash("sha256");
      const walk = (directory: string, prefix: string): void => {
        for (const name of fs.readdirSync(directory).sort()) {
          const child = path.join(directory, name);
          const relative = prefix ? `${prefix}/${name}` : name;
          const childStat = fs.lstatSync(child);
          if (childStat.isDirectory()) { hash.update(`d\0${relative}\0`); walk(child, relative); }
          else if (childStat.isFile()) hash.update(`f\0${relative}\0`).update(fs.readFileSync(child));
        }
      };
      walk(absolute, "");
      return hash.digest("hex");
    }
  } catch { /* a missing or unsupported input is refused before qualification runs */ }
  return null;
}

/** The declared agent allowance, reporting only; zero or absent means unknown. */
function declaredAgentTimeoutMs(contract: RunContract): number | undefined {
  const value = (contract.agent as (RunContract["agent"] & { timeoutMs?: unknown }) | null | undefined)?.timeoutMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Write an inert version of an editable file: no exports, no work. */
function writeInert(target: string): void {
  fs.writeFileSync(target, target.toLowerCase().endsWith(".py") ? "# inert qualification stub\n" : "export {};\n");
}

const SCRATCH_CLEANUP_ATTEMPTS = 4;
const SCRATCH_CLEANUP_BACKOFF_MS = 25;

/** What happened to a disposable copy; a failure must reach durable evidence. */
export interface ScratchCleanupResult {
  removed: boolean;
  /** Set only when the copy survived cleanup and needs manual removal. */
  retainedPath: string | null;
  error: string | null;
}

/** Remove a disposable copy; transient Windows locks must not discard a reading. */
export async function removeScratchDirectory(
  scratch: string,
  remove: typeof fs.rmSync = fs.rmSync,
): Promise<ScratchCleanupResult> {
  for (let attempt = 0; attempt < SCRATCH_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      remove(scratch, { recursive: true, force: true });
      return { removed: true, retainedPath: null, error: null };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message = error instanceof Error ? error.message : String(error);
      if ((code !== "EBUSY" && code !== "EPERM") || attempt === SCRATCH_CLEANUP_ATTEMPTS - 1) {
        console.error(`Dream-RSI could not remove scratch directory ${scratch}: ${message}; remove it manually when no process is using it.`);
        return { removed: false, retainedPath: scratch, error: message };
      }
      await new Promise((resolve) => setTimeout(resolve, SCRATCH_CLEANUP_BACKOFF_MS * (attempt + 1)));
    }
  }
  return { removed: false, retainedPath: scratch, error: "cleanup attempts exhausted" };
}

/** Run one instrument script against a throwaway copy of the target. */
async function runInstrument(options: {
  evaluatorFile: string;
  sourceDir: string;
  workRoot: string;
  scorePath: string;
  timeoutMs: number;
  contract: RunContract;
  before?: () => void;
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Project-relative files replaced with an inert version before measuring. */
  inert?: string[];
  role?: string;
  onEvidence?: (event: Record<string, unknown>) => void;
  /** Test/diagnostic seam: observe a cleanup failure instead of only logging it. */
  removeScratch?: typeof fs.rmSync;
  /** Inner workload allowance this process was given; defaults to the process cap. */
  workloadTimeoutMs?: number;
}): Promise<InstrumentProbe> {
  if (options.signal?.aborted) return { valid: false, score: null, error: "qualification cancelled" };
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) return { valid: false, score: null, error: "overall deadline expired" };
  const scratch = path.join(options.workRoot, `qualify-${crypto.randomUUID()}`);
  try {
    await copyWorkspace(options.sourceDir, scratch, {
      exclude: [path.join(options.sourceDir, ".git"), path.join(options.sourceDir, ".dream-rsi")],
    });
    const actuallyInert: string[] = [];
    for (const relative of options.inert ?? []) {
      const target = path.join(scratch, ...relative.split("/"));
      if (fs.existsSync(target)) { writeInert(target); actuallyInert.push(relative); }
    }
    fs.rmSync(path.join(scratch, ...options.scorePath.split("/")), { force: true });
    const evaluatorPath = options.evaluatorFile;
    options.before?.();
    const result = await runShellCommand(`node "${evaluatorPath.replace(/"/g, '""')}"`, {
      cwd: scratch,
      timeoutMs: options.deadlineAt === undefined ? options.timeoutMs : Math.max(1, Math.min(options.timeoutMs, options.deadlineAt - Date.now())),
      envOnly: true,
      env: restrictedEnvironment(options.contract),
      redactEnvKeys: options.contract.execution.envAllowlist,
      logPath: null,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(fs.readFileSync(path.join(scratch, ...options.scorePath.split("/")), "utf8")) as Record<string, unknown>; }
    catch { parsed = null; }
    const valid = result.ok && parsed?.valid === true && typeof parsed.score === "number" && Number.isFinite(parsed.score);
    const redact = (value: unknown): string => {
      let text = String(value ?? "");
      for (const key of options.contract.execution.envAllowlist) {
        const secret = process.env[key];
        if (secret) text = text.split(secret).join("[redacted]");
      }
      return text.slice(-4096);
    }
    const reportedError = typeof parsed?.error === "string" ? parsed.error : undefined;
    const reportedClass = typeof parsed?.fail_class === "string" ? parsed.fail_class : undefined;
    const failureDetail = reportedError
      ? `${reportedClass ? `fail_class=${reportedClass}: ` : ""}${reportedError}`
      : result.stderrTail.trim().split(/\r?\n/, 1)[0] || (result.timedOut ? "instrument timed out" : `instrument exited ${result.code}`);
    const safeError = valid ? null : redact(result.spawnError ?? failureDetail);
    options.onEvidence?.({
      phase: options.role ?? "workload", command: `node ${path.basename(options.evaluatorFile)}`,
      inertFiles: actuallyInert, exitCode: result.code, failed: !valid,
      failClass: redact(parsed?.fail_class ?? (result.timedOut ? "timeout" : result.spawnError ? "spawn_error" : `exit_${result.code}`)).slice(0, 100),
      error: safeError, stdout: redact(result.stdoutTail), stderr: redact(result.stderrTail),
      ...(parsed?.child && typeof parsed.child === "object" ? { child: parsed.child } : {}),
      wrapperTimeoutMs: options.timeoutMs, workloadTimeoutMs: options.workloadTimeoutMs ?? options.timeoutMs,
    });
    return { valid, score: valid ? (parsed!.score as number) : null, error: safeError };
  } finally {
    const cleanup = await removeScratchDirectory(scratch, options.removeScratch);
    if (!cleanup.removed) {
      // A retained copy is actionable evidence, so it must reach the receipt: the
      // console warning dies with the process that saw it.
      options.onEvidence?.({ phase: "cleanup", role: options.role ?? "workload", failed: true, failClass: "cleanup_failed",
        error: cleanup.error, retainedScratch: path.basename(scratch) });
    }
  }
}

/** Run one gate command against a throwaway copy of the target. */
async function runGateOnCopy(options: {
  command: string;
  sourceDir: string;
  workRoot: string;
  timeoutMs: number;
  contract: RunContract;
  before?: () => void;
  signal?: AbortSignal;
  deadlineAt?: number;
  inert?: string[];
  replacement?: { relative: string; source: string };
  role?: string;
  onEvidence?: (event: Record<string, unknown>) => void;
  removeScratch?: typeof fs.rmSync;
}): Promise<{ passed: boolean; detail: string }> {
  if (options.signal?.aborted) return { passed: false, detail: "qualification cancelled" };
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) return { passed: false, detail: "overall deadline expired" };
  const scratch = path.join(options.workRoot, `gate-${crypto.randomUUID()}`);
  try {
    await copyWorkspace(options.sourceDir, scratch, {
      exclude: [path.join(options.sourceDir, ".git"), path.join(options.sourceDir, ".dream-rsi")],
    });
    const actuallyInert: string[] = [];
    for (const relative of options.inert ?? []) {
      const target = path.join(scratch, ...relative.split("/"));
      if (fs.existsSync(target)) { writeInert(target); actuallyInert.push(relative); }
    }
    if (options.replacement) {
      const target = path.join(scratch, ...options.replacement.relative.split("/"));
      fs.writeFileSync(target, options.replacement.source, "utf8");
    }
    options.before?.();
    const result = await runShellCommand(options.command, {
      cwd: scratch,
      timeoutMs: options.deadlineAt === undefined ? options.timeoutMs : Math.max(1, Math.min(options.timeoutMs, options.deadlineAt - Date.now())),
      envOnly: true,
      env: restrictedEnvironment(options.contract),
      redactEnvKeys: options.contract.execution.envAllowlist,
      logPath: null,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const detail = result.ok
      ? `"${options.command}" exited 0`
      : `"${options.command}" failed: ${(result.spawnError ?? result.stderrTail.trim().split(/\r?\n/, 1)[0]) || `exit ${result.code}`}`;
    options.onEvidence?.({ phase: "gate", role: options.role ?? "gate", command: options.command,
      inertFiles: actuallyInert, exitCode: result.code, failed: !result.ok,
      failClass: result.timedOut ? "timeout" : result.spawnError ? "spawn_error" : result.ok ? "ok" : `exit_${result.code}`,
      error: result.spawnError ?? null, stdout: result.stdoutTail.slice(-4096), stderr: result.stderrTail.slice(-4096),
      wrapperTimeoutMs: options.timeoutMs, workloadTimeoutMs: options.timeoutMs });
    return { passed: result.ok, detail };
  } finally {
    const cleanup = await removeScratchDirectory(scratch, options.removeScratch);
    if (!cleanup.removed) {
      options.onEvidence?.({ phase: "cleanup", role: options.role ?? "gate", failed: true, failClass: "cleanup_failed",
        error: cleanup.error, retainedScratch: path.basename(scratch) });
    }
  }
}

/**
 * Qualify an instrument from independent evidence rather than from a supplied
 * winning patch.
 *
 * The instrument must complete on the unchanged target, reproduce its own
 * baseline, respond in the right direction and by more than the useful gain to
 * host-side extra work inside the same measured operation, reject a workload
 * that does not exist, and refuse an inert version of the editable code. A
 * failure is a refusal, not a licence to lower the bar.
 */
export async function qualifyInstrument(
  plan: MetricPlan,
  options: QualificationOptions & {
    projectDir: string;
    minimumUsefulGain: MinimumGain;
    outcome: string;
    gates?: string[];
    /** Editable files the correctness oracle must constrain. */
    editableScope?: string[];
  },
): Promise<QualificationReport> {
  const checks: QualificationCheck[] = [];
  const rejections: string[] = [];
  const projectDir = path.resolve(options.projectDir);
  const workRoot = path.resolve(options.workRoot);
  const gates = [...new Set([...(options.contract.preserved.gates ?? []), ...(options.gates ?? plan.gates)])];
  const baselineRuns = Math.max(2, options.baselineRuns ?? 3);
  const passes = Math.max(1, Math.min(options.baselinePasses ?? 2, 4));
  const editable = options.editableScope ?? [];
  const metricMode: "duration" | "failures" | "score" = plan.metricKind === "command-duration"
    ? "duration"
    : plan.metricKind === "score" ? "score" : "failures";
  const qualificationRunCeiling = passes * baselineRuns
    + (metricMode === "duration" || editable.length > 0 ? 1 : 0)
    + 1 // nonexistent-workload control
    + (gates.length * 2) // pristine and inert correctness controls
  const availableEvaluatorRuns = Math.min(
    options.availableEvaluatorRuns ?? options.contract.budgets.maxEvaluatorRuns,
    options.contract.budgets.maxEvaluatorRuns,
  );
  const admission = planAdmission({
    remaining: { agentStarts: options.contract.budgets.maxAgentStarts, evaluatorRuns: availableEvaluatorRuns, wallMs: options.contract.budgets.deadlineMs },
    expectedReadMs: plan.expectedReadMs,
    gates: gates.length,
    deterministic: false,
    baselineReuse: true,
    postApplyRuns: 1,
    promotionAgentStarts: PROMOTION_AGENT_STARTS,
    search: { agentStarts: 0, evaluatorRuns: qualificationRunCeiling, wallMs: qualificationRunCeiling * plan.expectedReadMs },
  });
  const evaluatorFile = path.resolve(projectDir, plan.evaluatorPath);
  let evaluatorRunsStarted = 0;
  fs.mkdirSync(workRoot, { recursive: true });
  const evidencePath = path.join(workRoot, `qualification-evidence-${crypto.randomUUID()}.json`);
  const evidenceEvents: Record<string, unknown>[] = [];
  const redactEvidence = (value: unknown): string => {
    let text = String(value ?? "");
    for (const key of options.contract.execution.envAllowlist) {
      const secret = process.env[key];
      if (secret) text = text.split(secret).join("[redacted]");
    }
    return text.slice(-4096);
  };
  // Captured once: the receipt must describe the code that ran, not whatever the
  // file holds when a later event flushes it to disk.
  const evaluatorDigestAtStart = fs.existsSync(evaluatorFile) ? digestOf(evaluatorFile) : "missing";
  // The instrument is the wrapper plus every pinned evaluator input. A change to
  // any of them makes the readings incomparable with the reviewed instrument.
  const instrumentDigest = (): string => {
    const hash = crypto.createHash("sha256");
    hash.update(`wrapper\0${plan.evaluatorPath}\0${fs.existsSync(evaluatorFile) ? digestOf(evaluatorFile) : "missing"}`);
    for (const input of [...plan.evaluatorInputs].sort()) {
      hash.update(`\0input\0${input}\0${digestAsset(path.resolve(projectDir, input)) ?? "missing"}`);
    }
    return hash.digest("hex");
  };
  const instrumentDigestAtStart = instrumentDigest();
  const qualificationRuntime = Object.freeze({ ...LOADED_RUNTIME, engineDigest: LOADED_ENGINE_DIGEST,
    evaluatorDigest: evaluatorDigestAtStart, instrumentDigest: instrumentDigestAtStart,
    contentHash: crypto.createHash("sha256").update(`${instrumentDigestAtStart}:${LOADED_ENGINE_DIGEST}`).digest("hex") });
  const saveEvidence = (): void => {
    fs.writeFileSync(evidencePath, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), runtime: qualificationRuntime,
      events: evidenceEvents.slice(-100), checks: checks.map((check) => ({ ...check, detail: redactEvidence(check.detail) })),
      rejections: rejections.map(redactEvidence), evaluatorRunsStarted }, null, 2) + "\n", "utf8");
  };
  const common = {
    sourceDir: projectDir,
    workRoot,
    scorePath: plan.scorePath,
    timeoutMs: plan.wrapperTimeoutMs,
    workloadTimeoutMs: plan.sampleTimeoutMs,
    contract: options.contract,
    before: () => {
      options.beforeEvaluatorRun?.();
      evaluatorRunsStarted += 1;
    },
    role: "workload",
    onEvidence: (event: Record<string, unknown>) => {
      const safe: Record<string, unknown> = { ...event };
      for (const field of ["error", "stdout", "stderr", "command"]) if (safe[field] !== undefined) safe[field] = redactEvidence(safe[field]);
      evidenceEvents.push(safe); saveEvidence();
    },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
    ...(options.removeScratch ? { removeScratch: options.removeScratch } : {}),
  };

  const record = (name: QualificationCheck["name"], passed: boolean, detail: string, required = true): void => {
    const safeDetail = redactEvidence(detail);
    checks.push({ name, passed, required, detail: safeDetail });
    if (!passed && required) rejections.push(safeDetail);
    saveEvidence();
  };

  const missingOracle = gates.length === 0 && metricMode !== "score"
    ? "no correctness gate was declared or discovered; declare a passing test gate or use a score evaluator with an explicit validity oracle"
    : editable.length === 0
      ? "no editable file was identified, so qualification cannot test whether the oracle detects a broken candidate"
      : null;
  if (missingOracle) {
    record("oracle", false, `measurement refused before spending evaluator runs: ${missingOracle}`);
    const failed: QualificationReport = { passed: false, checks, contract: null, rejections, evidencePath };
    plan.qualification = failed;
    plan.ready = false;
    plan.rejections.push(...rejections);
    return failed;
  }

  if (!admission.feasible) {
    const missingRuns = admission.shortfall?.requiredEvaluatorRuns ?? (qualificationRunCeiling + admission.reserve.evaluatorRuns);
    const detail = `measurement refused before spending evaluator runs: ${admission.shortfall?.code ?? "admission"} prevents funding a complete promotion; qualification may need ${qualificationRunCeiling} run(s), with at least ${Math.max(0, missingRuns - qualificationRunCeiling)} more reserved for correctness gates, confirmation, and independent post-apply verification`;
    record("budget-fit", false, detail);
    const failed: QualificationReport = { passed: false, checks, contract: null, rejections, evidencePath };
    plan.qualification = failed;
    plan.ready = false;
    plan.rejections.push(...rejections);
    return failed;
  }

  // Refuse unsafe control targets before any child process or measured workload.
  // Scope comparisons stay textual, so both sides are normalized the same way: a gate written as
  // `node ./check.mjs` must protect the same file as an editable entry `check.mjs`.
  const normalizeScopePath = (item: string): string => item.replace(/\\/g, "/").replace(/^\.\//, "");
  const protectedPaths = new Set([plan.evaluatorPath, plan.scorePath, ...plan.evaluatorInputs].map(normalizeScopePath));
  const addExistingControlPaths = (tokens: string[]): void => {
    for (const token of tokens) {
      const normalized = normalizeScopePath(token);
      if (!normalized || normalized.startsWith("-") || path.isAbsolute(token) || normalized.split("/").some((part) => part === "..")) continue;
      if (fs.existsSync(path.resolve(projectDir, token)) && fs.statSync(path.resolve(projectDir, token)).isFile()) protectedPaths.add(normalized);
    }
  };
  // A declared score evaluator is a verifier, so nothing in its argv may be candidate-editable.
  // In a measured-command mode the same argv is the workload under optimization: its entry file is
  // the candidate's target, and protecting it would refuse every legitimate optimization.
  if (metricMode === "score") addExistingControlPaths(plan.argv);
  const packageFile = path.join(projectDir, "package.json");
  let packageScripts: Record<string, unknown> = {};
  try { packageScripts = JSON.parse(fs.readFileSync(packageFile, "utf8")).scripts ?? {}; } catch { /* no package script evidence */ }
  for (const gate of gates) {
    const tokens = gate.match(/(?:[^\s"']+|"[^"]*"|'[^']*')/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? [];
    addExistingControlPaths(tokens);
    const scriptName = gate.match(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:-]+)/)?.[1];
    const script = typeof packageScripts[scriptName ?? ""] === "string" ? packageScripts[scriptName!] as string : "";
    addExistingControlPaths(script.match(/(?:[^\s"']+|"[^"]*"|'[^']*')/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? []);
  }
  const invalidEditable = editable.find((item) => {
    const normalized = normalizeScopePath(item);
    if (!normalized || path.isAbsolute(item) || normalized.split("/").some((part) => part === "..") || normalized.startsWith("/")) return true;
    if ([...protectedPaths].some((protectedPath) => normalized === protectedPath || normalized.startsWith(`${protectedPath}/`) || protectedPath.startsWith(`${normalized}/`))) return true;
    let current = projectDir;
    for (const part of normalized.split("/")) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) return true; } catch { break; }
    }
    return false;
  });
  if (invalidEditable) {
    record("oracle", false, `measurement refused before spending evaluator runs: unsafe or verifier-overlapping editable control path ${invalidEditable}`);
    const failed: QualificationReport = { passed: false, checks, contract: null, rejections, evidencePath };
    plan.qualification = failed; plan.ready = false; plan.rejections.push(...rejections); return failed;
  }

  // Gate prerequisites/oracle controls run before expensive evaluator readings.
  // A gate only establishes sensitivity when it passes pristine and rejects inert code.
  let sensitiveGate = false;
  for (const gate of gates) {
    const pristine = await runGateOnCopy({ ...common, command: gate, role: "pristine", onEvidence: common.onEvidence });
    if (!pristine.passed) {
      const detail = `${gate} fails on the unchanged target (${pristine.detail})`;
      if (metricMode === "score") { record("oracle", true, `${detail}; retained as a mandatory candidate gate but not counted as oracle sensitivity`); continue; }
      record("oracle", false, `${detail}, so it cannot show that broken code would be caught`);
      continue;
    }
    const inert = await runGateOnCopy({ ...common, command: gate, inert: editable, role: "inert", onEvidence: common.onEvidence });
    const holds = !inert.passed;
    record("oracle", holds, holds
      ? `${gate} rejects an inert version of the editable code (${inert.detail}), so a fast but wrong result cannot pass silently`
      : `an inert version of the editable code still passes ${gate}, so the oracle does not constrain the measured behaviour`, false);
    if (holds) sensitiveGate = true;
  }
  if (!sensitiveGate) {
    record("oracle", false, "no independently passing-on-pristine gate rejects inert editable code; qualification refused before evaluator runs");
    const failed: QualificationReport = { passed: false, checks, contract: null, rejections, evidencePath };
    plan.qualification = failed; plan.ready = false; plan.rejections.push(...rejections); return failed;
  } else {
    record("oracle", true, "at least one independently passing-on-pristine correctness gate rejects inert editable code; every gate remains mandatory for promotion");
  }

  // 1. The declared workload must complete on the unchanged target, and repeated
  //    readings must resolve the smallest worthwhile change. A busy host can make one
  //    series jittery, so the same measurement is taken again before refusing; the
  //    thresholds never change between passes.
  let readings: number[] = [];
  let baseline = 0;
  let spread = 0;
  let threshold = 0;
  let stabilityDetail = "";
  let stable = false;
  let passedPasses = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    passedPasses = pass + 1;
    readings = [];
    for (let index = 0; index < baselineRuns; index += 1) {
      const probe = await runInstrument({ ...common, evaluatorFile });
      if (!probe.valid) {
        record("workload", false, `the declared workload did not produce a valid reading on the unchanged target: ${probe.error}`);
        const failed: QualificationReport = { passed: false, checks, contract: null, rejections, evidencePath };
        plan.qualification = failed;
        plan.ready = false;
        plan.rejections.push(...rejections);
        return failed;
      }
      readings.push(probe.score!);
    }
    const sorted = [...readings].sort((a, b) => a - b);
    baseline = sorted[Math.floor(sorted.length / 2)];
    spread = Math.max(...readings) - Math.min(...readings);
    threshold = absoluteGain(options.minimumUsefulGain, baseline);
    // A small outlier in five process-level readings can exceed the useful gain
    // even when paired confirmation can still resolve it. Allow at most twice
    // the useful gain here; the independent confirmation stage remains stricter.
    const stabilityLimit = threshold * 2;
    stable = spread <= stabilityLimit;
    stabilityDetail = stable
      ? `baseline spread ${Math.round(spread * 1000) / 1000} is within twice the useful gain ${Math.round(stabilityLimit * 1000) / 1000}`
      : `baseline spread ${Math.round(spread * 1000) / 1000} exceeds twice the useful gain ${Math.round(stabilityLimit * 1000) / 1000}, so a real improvement of that size cannot be distinguished from noise`;
    if (stable) break;
  }
  record("workload", true, `"${plan.headCommand}" completed ${readings.length} time(s) on the unchanged target${passedPasses > 1 ? ` (pass ${passedPasses} of ${passes})` : ""}`);
  record("baseline", true, `baseline readings ${readings.map((value) => Math.round(value * 1000) / 1000).join(", ")} (median ${Math.round(baseline * 1000) / 1000})`);
  record("stability", stable, stabilityDetail);

  // 3. The instrument must respond to a real change in the measured behaviour, in the
  //    right direction, by more than the useful gain. What "a real change" means
  //    depends on what the metric counts:
  //
  //    - a duration metric responds to host-side extra work inside the same measured
  //      operation, injected on the host so the project is never touched;
  //    - a failure-count metric responds to broken behaviour, so the control is an
  //      inert version of the editable code, which must raise the failure count or
  //      invalidate the instrument. A nonzero baseline still qualifies when that
  //      independent control makes the result worse;
  //    - a score metric responds to the same inert control: the declared evaluator
  //      must either invalidate the score (fail closed) or move it against the
  //      declared direction. A score evaluator blind to the editable code is refused.
  //    In every case the control is disposable and never becomes a candidate.
  let sensitivity: number | null = null;
  if (metricMode === "duration") {
    const injectedDelayMs = options.injectedDelayMs ?? Math.max(250, Math.ceil(threshold * 3));
    const degradedFile = path.join(workRoot, `metric-degraded-${crypto.randomUUID()}.mjs`);
    try {
      fs.mkdirSync(workRoot, { recursive: true });
      fs.writeFileSync(degradedFile, evaluatorSource({
        argv: plan.argv, mode: "duration", repeats: 3, sampleTimeoutMs: plan.sampleTimeoutMs, wrapperTimeoutMs: plan.wrapperTimeoutMs, injectedDelayMs,
      }), "utf8");
      const degraded = await runInstrument({ ...common, evaluatorFile: degradedFile, role: "degraded-control" });
      if (!degraded.valid) {
        record("sensitivity", false, `the degraded control produced no valid reading: ${degraded.error}`);
      } else {
        sensitivity = plan.higherIsBetter ? baseline - degraded.score! : degraded.score! - baseline;
        const expected = plan.higherIsBetter ? -injectedDelayMs : injectedDelayMs;
        const directionRight = Math.sign(sensitivity) === Math.sign(expected) || expected === 0;
        record("direction", directionRight, directionRight
          ? `the instrument moved ${Math.round(sensitivity * 1000) / 1000} ${plan.unit} in the declared ${plan.direction} direction under a degraded control`
          : `the instrument reported ${Math.round(sensitivity * 1000) / 1000} ${plan.unit} for ${expected > 0 ? "more" : "less"} work, which is the wrong direction`);
        const sensitiveEnough = directionRight && Math.abs(sensitivity) >= threshold;
        record("sensitivity", sensitiveEnough, sensitiveEnough
          ? `the degraded control moved the score by ${Math.round(Math.abs(sensitivity) * 1000) / 1000} ${plan.unit}, above the useful gain ${Math.round(threshold * 1000) / 1000}`
          : `the degraded control moved the score by only ${Math.round(Math.abs(sensitivity) * 1000) / 1000} ${plan.unit}, so the instrument cannot resolve the useful gain ${Math.round(threshold * 1000) / 1000}`);
      }
    } finally {
      try { fs.rmSync(degradedFile, { force: true }); } catch (error) { record("sensitivity", false, `degraded control cleanup failed: ${String((error as NodeJS.ErrnoException).code ?? "cleanup_error")}`); }
    }
  } else if (metricMode === "score") {
    if (editable.length === 0) {
      record("sensitivity", false, "no editable file was named, so no score control could be constructed");
    } else {
      const faulted = await runInstrument({ ...common, evaluatorFile, inert: editable });
      if (!faulted.valid) {
        // Failing closed under inert code is stronger than a directional change:
        // broken or instrument-blind candidates cannot report a promotable score.
        record("direction", true, `an inert version of the editable code does not produce a valid score, which is stricter than moving in the declared ${plan.direction} direction`);
        record("sensitivity", true, `an inert version of the editable code invalidates the score (${faulted.error}), so a fast but wrong result cannot be promoted`);
      } else {
        sensitivity = plan.higherIsBetter ? baseline - faulted.score! : faulted.score! - baseline;
        const directionRight = sensitivity > 0;
        record("direction", directionRight, directionRight
          ? `inert editable code moved the score ${Math.round(sensitivity * 1000) / 1000} ${plan.unit} in the declared ${plan.direction} direction`
          : `inert editable code did not change the score in the declared ${plan.direction} direction (movement ${Math.round(sensitivity * 1000) / 1000} ${plan.unit}), so the instrument is blind to the editable code`);
        const sensitiveEnough = directionRight && Math.abs(sensitivity) >= threshold;
        record("sensitivity", sensitiveEnough, sensitiveEnough
          ? `inert editable code moved the score by ${Math.round(Math.abs(sensitivity) * 1000) / 1000} ${plan.unit}, above the useful gain ${Math.round(threshold * 1000) / 1000}`
          : directionRight
            ? `inert editable code moved the score by only ${Math.round(Math.abs(sensitivity) * 1000) / 1000} ${plan.unit}, below the useful gain ${Math.round(threshold * 1000) / 1000}, so the instrument cannot resolve it`
            : `inert editable code moved the score by ${Math.round(Math.abs(sensitivity) * 1000) / 1000} ${plan.unit} (0 means it did not change the score), which is the wrong direction relative to the declared ${plan.direction} outcome`);
      }
    }
  } else if (editable.length === 0) {
    record("sensitivity", false, "no editable file was named, so no failure control could be constructed");
  } else {
    const faulted = await runInstrument({ ...common, evaluatorFile, inert: editable });
    if (!faulted.valid) {
      if (baseline > 0) {
        record("direction", true, `the inert-code control invalidated the already-failing suite (${faulted.error})`);
        record("sensitivity", true, `an inert-code control fails closed, establishing sensitivity above the existing ${Math.round(baseline * 1000) / 1000} ${plan.unit} baseline`);
      } else {
        record("sensitivity", false, `the failure control produced no valid reading: ${faulted.error}`);
      }
    } else {
      sensitivity = plan.higherIsBetter ? baseline - faulted.score! : faulted.score! - baseline;
      const directionRight = sensitivity > 0;
      record("direction", directionRight, directionRight
        ? `breaking the editable code moved the instrument ${Math.round(sensitivity * 1000) / 1000} ${plan.unit} toward failure, the declared ${plan.direction} direction`
        : `breaking the editable code moved the instrument ${Math.round(sensitivity * 1000) / 1000} ${plan.unit} away from failure, which is the wrong direction`);
      const sensitiveEnough = directionRight && Math.abs(sensitivity) >= Math.max(threshold, 1);
      record("sensitivity", sensitiveEnough, sensitiveEnough
        ? `the failure control moved the score by ${Math.round(Math.abs(sensitivity) * 1000) / 1000} ${plan.unit}`
        : `the failure control moved the score by only ${Math.round(Math.abs(sensitivity) * 1000) / 1000} ${plan.unit}, so the instrument does not detect broken behaviour`);
    }
  }

  // 4. A workload that does not exist must not produce a valid score.
  const missingFile = path.join(workRoot, `metric-missing-${crypto.randomUUID()}.mjs`);
  try {
    fs.mkdirSync(workRoot, { recursive: true });
    fs.writeFileSync(missingFile, evaluatorSource({
      argv: ["__dream_rsi_absent_command__"],
      mode: metricMode,
      repeats: 1,
      sampleTimeoutMs: Math.min(plan.sampleTimeoutMs, 15_000),
      wrapperTimeoutMs: Math.min(plan.wrapperTimeoutMs, 17_000),
      ...(metricMode === "score" ? { scoreOutput: plan.evaluatorOutput ?? "score-json", unit: plan.unit, redactEnvKeys: options.contract.execution.envAllowlist } : {}),
    }), "utf8");
    const missing = await runInstrument({ ...common, evaluatorFile: missingFile, role: "missing-workload" });
    record("missing-workload", !missing.valid, missing.valid
      ? "a nonexistent workload still produced a valid score, so the instrument does not prove the workload ran"
      : `a nonexistent workload is reported as invalid (${missing.error})`);
  } finally {
    try { fs.rmSync(missingFile, { force: true }); } catch (error) { record("missing-workload", false, `missing control cleanup failed: ${String((error as NodeJS.ErrnoException).code ?? "cleanup_error")}`); }
  }


  // 6. The confirmation must fit the remaining allowance. A declared score
  //    instrument is sized by the same promotion floor the campaign enforces: an
  //    exact repeated reading needs one before/after pair, while a jittery reading
  //    needs the campaign's noisy confirmation. A synthesized duration or failure
  //    metric keeps its one-confirmation cost estimate.
  if (metricMode === "score") {
    const deterministic = readings.length >= 2 && spread === 0;
    const deadlineMs = options.contract.budgets.deadlineMs;
    const floor = promotionFloor({
      readings: 1,
      gates: gates.length,
      deterministic,
      expectedReadMs: plan.expectedReadMs,
      evaluatorTimeoutMs: plan.wrapperTimeoutMs,
      agentTimeoutMs: declaredAgentTimeoutMs(options.contract),
    });
    const confirmation = deterministic ? "deterministic: one before/after confirmation pair" : `noisy: a ${floor.confirmationRuns}-run confirmation`;
    const runsRemaining = Math.max(0, availableEvaluatorRuns - evaluatorRunsStarted);
    const budgetFits = floor.durationMs <= deadlineMs && floor.evaluatorRuns <= runsRemaining;
    record("budget-fit", budgetFits, budgetFits
      ? `the promotion floor needs ${floor.evaluatorRuns} evaluator run(s) and ${Math.ceil(floor.durationMs / 1000)} s of evaluator time (${confirmation}), which fits the remaining ${runsRemaining} run(s) and ${Math.round(deadlineMs / 1000)} s run deadline`
      : `the promotion floor needs ${floor.evaluatorRuns} evaluator run(s) and ${Math.ceil(floor.durationMs / 1000)} s of evaluator time (${confirmation}), which does not fit the remaining ${runsRemaining} run(s) or ${Math.round(deadlineMs / 1000)} s run deadline`);
  } else {
    const confirmationCostMs = plan.expectedReadMs * (metricMode === "duration" ? 4 : 3);
    const confirmationRuns = metricMode === "duration" ? 4 : 3;
    const runsRemaining = Math.max(0, availableEvaluatorRuns - evaluatorRunsStarted);
    const budgetFits = confirmationCostMs <= options.contract.budgets.deadlineMs && confirmationRuns <= runsRemaining;
    record("budget-fit", budgetFits, budgetFits
      ? `one confirmation (${Math.round(confirmationCostMs / 1000)} s, ${confirmationRuns} evaluator run(s)) fits the remaining ${runsRemaining} run(s) and ${Math.round(options.contract.budgets.deadlineMs / 1000)} s run deadline`
      : `one confirmation (${Math.round(confirmationCostMs / 1000)} s, ${confirmationRuns} evaluator run(s)) does not fit the remaining ${runsRemaining} run(s) or ${Math.round(options.contract.budgets.deadlineMs / 1000)} s run deadline`);
  }

  // An instrument measured under one identity and reported under another cannot be
  // trusted: fail closed instead of repeating the historical confusion between the
  // reviewed settings and the settings that actually ran.
  const evaluatorDigestAtEnd = fs.existsSync(evaluatorFile) ? digestOf(evaluatorFile) : "missing";
  const identityStable = evaluatorDigestAtStart !== "missing" && LOADED_ENGINE_DIGEST !== "unavailable"
    && evaluatorDigestAtEnd === evaluatorDigestAtStart && instrumentDigest() === instrumentDigestAtStart;
  record("identity-stability", identityStable, identityStable
    ? `evaluator sha256 ${evaluatorDigestAtStart.slice(0, 12)}, instrument sha256 ${instrumentDigestAtStart.slice(0, 12)} and loaded engine sha256 ${LOADED_ENGINE_DIGEST.slice(0, 12)} are unchanged across ${evaluatorRunsStarted} evaluator run(s)`
    : evaluatorDigestAtStart === "missing" ? "the declared evaluator file is missing, so no runtime identity can be pinned"
      : LOADED_ENGINE_DIGEST === "unavailable" ? "the loaded engine source cannot be hashed, so the effective runtime identity is unknown"
        : "the evaluator or one of its pinned inputs changed while qualification was running; these measurements do not describe the reviewed instrument");

  const passed = checks.every((check) => !check.required || check.passed);
  // The identity covers what *defines* the instrument, not what it *measured*.
  // Baseline readings and sensitivity change on every qualification; including them
  // would give the same instrument a new id each time and silently discard every
  // comparable experiment from the durable history.
  const assets = [
    { path: plan.evaluatorPath, sha256: digestOf(evaluatorFile) },
    ...plan.evaluatorInputs.flatMap((input) => {
      const sha256 = digestAsset(path.resolve(projectDir, input));
      return sha256 === null ? [] : [{ path: input.replace(/\\/g, "/"), sha256 }];
    }),
  ];
  const identity = {
    outcome: options.outcome,
    unit: plan.unit,
    higherIsBetter: plan.higherIsBetter,
    minimumUsefulGain: options.minimumUsefulGain,
    metricKind: plan.metricKind,
    argv: plan.argv,
    gates,
    assets,
    ...(plan.evaluatorOutput ? { evaluatorOutput: plan.evaluatorOutput } : {}),
  };
  const contract: EvaluationContract | null = passed ? {
    id: crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16),
    outcome: options.outcome,
    unit: plan.unit,
    higherIsBetter: plan.higherIsBetter,
    minimumUsefulGain: options.minimumUsefulGain,
    metricKind: plan.metricKind,
    argv: [...plan.argv],
    gates: [...gates],
    assets,
    baseline: readings,
    sensitivity,
    confirmationPerspective: "candidates never receive the baseline readings, the gate set, or this contract",
  } : null;

  const report: QualificationReport = { passed, checks, contract, rejections, evidencePath };
  saveEvidence();
  plan.qualification = report;
  if (!passed) {
    plan.ready = false;
    plan.evaluationContract = undefined;
    plan.rejections.push(...rejections);
  } else {
    plan.ready = true;
    plan.evaluationContract = contract!;
    plan.notes.push(`instrument ${contract!.id} qualified without a supplied winning patch: ${contract!.baseline.length} baseline reading(s), ${sensitivity === null ? "sensitivity shown by the control invalidating the score" : `sensitivity ${Math.round(sensitivity * 1000) / 1000} ${plan.unit}`}.`);
  }
  return report;
}
