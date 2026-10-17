import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { copyWorkspace, runShellCommand } from "../agent/runner.ts";
import { restrictedEnvironment, type MinimumGain, type RunContract } from "./intake.ts";
import type { LeverCommand, LeverProposal } from "./levers.ts";

/**
 * Synthesize and pre-calibrate the instrument for a lever when the intake has
 * no evaluator. The generated evaluator lives under the loop's own state
 * directory (outside any candidate-editable scope), runs one canonical command,
 * and writes a numeric score plus a validity verdict. Trust requires a
 * known-better control patch, checked by the campaign preflight before any
 * agent work starts; a lever without one stays unready and is rejected instead
 * of being explored blind.
 */

export interface MetricPlan {
  leverId: string;
  metricKind: LeverProposal["metricKind"];
  direction: "minimize" | "maximize";
  higherIsBetter: boolean;
  unit: string;
  /** Project-relative evaluator path, safe to declare as a verifier input. */
  evaluatorPath: string;
  scorePath: string;
  /** Exact argv the generated evaluator runs in the candidate copy. */
  argv: string[];
  headCommand: string;
  gates: string[];
  controlPatchPath: string | null;
  sampleTimeoutMs: number;
  ready: boolean;
  rejections: string[];
  notes: string[];
  /** Frozen identity of the instrument once it is qualified. */
  evaluationContract?: EvaluationContract;
  /** Qualification evidence, when the instrument was validated without a winning patch. */
  qualification?: QualificationReport;
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
  name: "workload" | "baseline" | "stability" | "sensitivity" | "direction" | "missing-workload" | "oracle" | "budget-fit";
  passed: boolean;
  detail: string;
}

export interface QualificationReport {
  passed: boolean;
  checks: QualificationCheck[];
  contract: EvaluationContract | null;
  rejections: string[];
}

export interface QualificationOptions {
  contract: RunContract;
  /** Directory for disposable copies; never inside the project. */
  workRoot: string;
  /** The approved outcome this instrument is supposed to observe. */
  outcome: string;
  /** Smallest change worth applying, from the approved contract. */
  minimumUsefulGain: MinimumGain;
  /** Durable accounting, called immediately before each qualification process starts. */
  beforeEvaluatorRun?: () => void;
  signal?: AbortSignal;
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
  /** Exact declared workload from cold-start discovery, preferred over head resolution. */
  command?: LeverCommand;
  /** Qualify the instrument without a supplied winning patch. */
  qualification?: QualificationOptions;
  /** Defaults to <projectDir>/.dream-rsi/loop. */
  loopRoot?: string;
  lever: LeverProposal;
  /** Known-better control patch, project-relative or absolute. Required for trust. */
  controlPatchPath?: string;
  /** Test seam: override the argv resolved for a canonical head. */
  commandOverrides?: Record<string, string[]>;
  /** Evaluator sample count for failure-count metrics. */
  repeats?: number;
  /**
   * Plateau restarts re-explore a tried lever through a different signal on the
   * same evidence. The head still comes from the lever's own nature (command
   * levers use their canonical head, suite levers their gate command).
   */
  metricOverride?: { metricKind: LeverProposal["metricKind"] };
}

const FAILURE_REPEATS = 3;
const DURATION_REPEATS = 3;
const MIN_SAMPLE_TIMEOUT_MS = 30_000;
const MAX_SAMPLE_TIMEOUT_MS = 600_000;
const SCORE_PATH = "eval/score.json";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Resolve a canonical command label into argv using only standard project
 * evidence (lockfiles). No repository name, path, or answer participates.
 */
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

function evaluatorSource(argv: string[], mode: "duration" | "failures", repeats: number, sampleTimeoutMs: number, injectedDelayMs = 0): string {
  return `// Generated by pi-dream-rsi engine/metrics.ts. Pinned metric evaluator.
// Runs one canonical command in the current copy and writes ${SCORE_PATH}.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const COMMAND = ${JSON.stringify(argv)};
const MODE = ${JSON.stringify(mode)};
const REPEATS = ${repeats};
const WARMUP = MODE === "duration" ? 1 : 0;
const SAMPLE_TIMEOUT_MS = ${sampleTimeoutMs};
// Host-side extra work inside the measured span. Zero for the real instrument; a
// positive value is the sensitivity control that proves the channel responds to
// duration changes at this exact seam.
const INJECTED_DELAY_MS = ${injectedDelayMs};
const OUTPUT = ${JSON.stringify(SCORE_PATH)};

function write(fields) {
  const file = path.resolve(process.cwd(), OUTPUT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ score: 0, raw_score: null, valid: false, fail_class: "evaluator_error", error: null, ...fields }, null, 2) + "\\n", "utf8");
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

function runOnce() {
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
    return { result: { error: blocked, status: null }, elapsedMs: 0 };
  }
  const file = shim ? (process.env.ComSpec || "cmd.exe") : COMMAND[0];
  const args = shim ? ["/d", "/s", "/c", COMMAND.join(" ")] : COMMAND.slice(1);
  const result = spawnSync(file, args, {
    cwd: process.cwd(), encoding: "utf8", timeout: SAMPLE_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  const elapsedMs = performance.now() - started;
  return { result, elapsedMs };
}

function main() {
  if (MODE === "failures") {
    let failures = 0;
    const samples = [];
    for (let index = 0; index < REPEATS; index += 1) {
      const { result } = runOnce();
      if (result.error && result.error.code !== "ETIMEDOUT") {
        return write({ error: String(result.error.message || result.error), fail_class: "spawn_error", mode: MODE });
      }
      const failed = result.error?.code === "ETIMEDOUT" || result.status !== 0;
      if (failed) failures += 1;
      samples.push(failed ? 1 : 0);
    }
    return write({ score: failures, raw_score: failures, valid: true, fail_class: "ok", error: null, mode: MODE, samples });
  }
  const samples = [];
  for (let index = 0; index < WARMUP + REPEATS; index += 1) {
    const { result, elapsedMs } = runOnce();
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

main();
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
  // A plateau restart keeps the lever's evidence and scope but measures a
  // different signal (for example the duration of the command that failed).
  const kind = options.metricOverride?.metricKind ?? lever.metricKind;
  const notes: string[] = [];
  const rejections: string[] = [];
  // Both synthesized metric kinds are counts of badness: milliseconds (lower is
  // better) and failures (lower is better).
  const direction = "minimize" as const;
  const higherIsBetter = false;
  const unit = kind === "command-duration" ? "ms" : "failures";
  // Command-backed levers carry the canonical head in their first evidence ref;
  // suite levers carry file scopes there and take the command from their gate.
  const head = lever.metricKind === "suite-failures"
    ? lever.gates[0] ?? "unknown"
    : lever.evidence[0]?.ref ?? lever.gates[0] ?? "unknown";

  const plan: MetricPlan = {
    leverId: lever.id,
    metricKind: kind,
    direction,
    higherIsBetter,
    unit,
    evaluatorPath: "",
    scorePath: SCORE_PATH,
    argv: [],
    headCommand: head,
    gates: [],
    controlPatchPath: options.controlPatchPath ? path.resolve(projectDir, options.controlPatchPath) : null,
    sampleTimeoutMs: MIN_SAMPLE_TIMEOUT_MS,
    ready: false,
    rejections,
    notes,
  };

  if (kind === "unmeasurable") {
    rejections.push("lever has no measurable metric kind; nothing can be synthesized");
    return plan;
  }

  // A recon lever states its declared workload exactly; a signal lever falls back
  // to the canonical-head table.
  const argv = options.command?.argv ? [...options.command.argv] : commandForHead(head, projectDir, options.commandOverrides);
  if (!argv || argv.length === 0) {
    rejections.push(`canonical head "${head}" cannot be reconstructed into a runnable command`);
    return plan;
  }
  plan.argv = argv;
  if (head === "npm test" && argv[0] !== "npm") notes.push(`npm-test head resolved to the ${argv[0]} runner from lockfile evidence.`);

  const mode = kind === "command-duration" ? "duration" : "failures";
  const repeats = clamp(Math.round(options.repeats ?? (mode === "failures" ? FAILURE_REPEATS : DURATION_REPEATS)), 1, 10);
  const estimatedMs = lever.estimates.costSeconds * 1000;
  plan.sampleTimeoutMs = clamp(Math.ceil(estimatedMs * 4), MIN_SAMPLE_TIMEOUT_MS, MAX_SAMPLE_TIMEOUT_MS);

  // Gate policy: a pass/fail gate equal to the metric command cannot pass on the
  // unfixed target, so failure-count metrics keep only additional declared gates.
  const metricCommand = head;
  plan.gates = mode === "duration"
    ? [...lever.gates]
    : lever.gates.filter((gate) => gate !== metricCommand);
  if (mode !== "duration" && plan.gates.length < lever.gates.length) {
    notes.push(`the "${metricCommand}" gate is the metric command itself and is excluded from gates; the evaluator must keep tests authentic via review and scope.`);
  }

  const evaluatorDir = path.join(loopRoot, "metrics", lever.id);
  fs.mkdirSync(evaluatorDir, { recursive: true });
  const evaluatorFile = path.join(evaluatorDir, "evaluate.mjs");
  fs.writeFileSync(evaluatorFile, evaluatorSource(argv, mode, repeats, plan.sampleTimeoutMs), "utf8");
  plan.evaluatorPath = path.relative(projectDir, evaluatorFile).replace(/\\/g, "/");

  if (!plan.controlPatchPath) {
    if (options.qualification) {
      // No supplied winning patch: qualify the instrument from independent evidence
      // (baseline reproducibility, a degraded control, a missing workload, and an
      // inert editable scope that the oracle must reject) before any agent runs.
      notes.push("no known-better control patch supplied; qualifying the instrument from independent evidence instead.");
      const qualification = await qualifyInstrument(plan, {
        ...options.qualification,
        projectDir,
        minimumUsefulGain: options.qualification.minimumUsefulGain,
        outcome: options.qualification.outcome,
        gates: plan.gates,
        editableScope: [...lever.scopeFiles],
      });
      if (!qualification.passed) notes.push("instrument qualification refused the lever; see the rejection reasons.");
      return plan;
    }
    rejections.push("no known-better control patch: the instrument cannot be validated before agent work (supply control_patch from assessment, history, or calibration authoring)");
    return plan;
  }
  if (!fs.existsSync(plan.controlPatchPath) || !fs.lstatSync(plan.controlPatchPath).isFile()) {
    rejections.push(`control patch file not found: ${plan.controlPatchPath}`);
    return plan;
  }
  if (fs.readFileSync(plan.controlPatchPath, "utf8").trim() === "") {
    rejections.push("control patch file is empty");
    return plan;
  }
  notes.push("ready for campaign preflight: baseline reads, noise floor, MDE, and control validation run inside checkCampaignEvaluator.");
  plan.ready = true;
  return plan;
}

// ---------------------------------------------------------------------------
// Instrument qualification without a supplied winning patch
// ---------------------------------------------------------------------------

/** The score an instrument must move by before a promotion is worth applying. */
export function resolveGainThreshold(minimumUsefulGain: MinimumGain, baseline: number): number {
  if (typeof minimumUsefulGain === "number") return minimumUsefulGain;
  const percent = Number(/^(\d+(?:\.\d+)?)%$/.exec(minimumUsefulGain)?.[1] ?? 0) / 100;
  return Math.abs(baseline) * percent;
}

interface InstrumentProbe {
  valid: boolean;
  score: number | null;
  error: string | null;
}

function digestOf(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Write an inert version of an editable file: no exports, no work. */
function writeInert(target: string): void {
  fs.writeFileSync(target, target.toLowerCase().endsWith(".py") ? "# inert qualification stub\n" : "export {};\n");
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
  /** Project-relative files replaced with an inert version before measuring. */
  inert?: string[];
}): Promise<InstrumentProbe> {
  const scratch = path.join(options.workRoot, `qualify-${crypto.randomUUID()}`);
  try {
    await copyWorkspace(options.sourceDir, scratch, {
      exclude: [path.join(options.sourceDir, ".git"), path.join(options.sourceDir, ".dream-rsi")],
    });
    for (const relative of options.inert ?? []) {
      const target = path.join(scratch, ...relative.split("/"));
      if (fs.existsSync(target)) writeInert(target);
    }
    fs.rmSync(path.join(scratch, ...options.scorePath.split("/")), { force: true });
    options.before?.();
    const result = await runShellCommand(`node "${options.evaluatorFile.replace(/"/g, '""')}"`, {
      cwd: scratch,
      timeoutMs: options.timeoutMs,
      envOnly: true,
      env: restrictedEnvironment(options.contract),
      logPath: null,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(fs.readFileSync(path.join(scratch, ...options.scorePath.split("/")), "utf8")) as Record<string, unknown>; }
    catch { parsed = null; }
    const valid = result.ok && parsed?.valid === true && typeof parsed.score === "number" && Number.isFinite(parsed.score);
    return {
      valid,
      score: valid ? (parsed!.score as number) : null,
      error: valid ? null : (result.spawnError ?? (parsed?.error as string | undefined) ?? (result.timedOut ? "instrument timed out" : `instrument exited ${result.code}`)),
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
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
  inert?: string[];
}): Promise<{ passed: boolean; detail: string }> {
  const scratch = path.join(options.workRoot, `gate-${crypto.randomUUID()}`);
  try {
    await copyWorkspace(options.sourceDir, scratch, {
      exclude: [path.join(options.sourceDir, ".git"), path.join(options.sourceDir, ".dream-rsi")],
    });
    for (const relative of options.inert ?? []) {
      const target = path.join(scratch, ...relative.split("/"));
      if (fs.existsSync(target)) writeInert(target);
    }
    options.before?.();
    const result = await runShellCommand(options.command, {
      cwd: scratch,
      timeoutMs: options.timeoutMs,
      envOnly: true,
      env: restrictedEnvironment(options.contract),
      logPath: null,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      passed: result.ok,
      detail: result.ok
        ? `"${options.command}" exited 0`
        : `"${options.command}" failed: ${(result.spawnError ?? result.stderrTail.trim().split(/\r?\n/, 1)[0]) || `exit ${result.code}`}`,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
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
  const gates = [...(options.gates ?? plan.gates)];
  const baselineRuns = Math.max(2, options.baselineRuns ?? 3);
  const evaluatorFile = path.resolve(projectDir, plan.evaluatorPath);
  const common = {
    sourceDir: projectDir,
    workRoot,
    scorePath: plan.scorePath,
    timeoutMs: plan.sampleTimeoutMs,
    contract: options.contract,
    ...(options.beforeEvaluatorRun ? { before: options.beforeEvaluatorRun } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const record = (name: QualificationCheck["name"], passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
    if (!passed) rejections.push(detail);
  };

  // 1. The declared workload must complete on the unchanged target, and repeated
  //    readings must resolve the smallest worthwhile change. A busy host can make one
  //    series jittery, so the same measurement is taken again before refusing; the
  //    thresholds never change between passes.
  const passes = Math.max(1, Math.min(options.baselinePasses ?? 2, 4));
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
        const failed: QualificationReport = { passed: false, checks, contract: null, rejections };
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
    threshold = resolveGainThreshold(options.minimumUsefulGain, baseline);
    stable = spread <= threshold;
    stabilityDetail = stable
      ? `baseline spread ${Math.round(spread * 1000) / 1000} is within the useful gain ${Math.round(threshold * 1000) / 1000}`
      : `baseline spread ${Math.round(spread * 1000) / 1000} exceeds the useful gain ${Math.round(threshold * 1000) / 1000}, so a real improvement of that size cannot be distinguished from noise`;
    if (stable) break;
  }
  record("workload", true, `"${plan.headCommand}" completed ${readings.length} time(s) on the unchanged target${passedPasses > 1 ? ` (pass ${passedPasses} of ${passes})` : ""}`);
  record("baseline", true, `baseline readings ${readings.map((value) => Math.round(value * 1000) / 1000).join(", ")} (median ${Math.round(baseline * 1000) / 1000})`);
  record("stability", stable, stabilityDetail);

  const editable = options.editableScope ?? [];
  const metricMode = plan.metricKind === "command-duration" ? "duration" : "failures";

  // 3. The instrument must respond to a real change in the measured behaviour, in the
  //    right direction, by more than the useful gain. What "a real change" means
  //    depends on what the metric counts:
  //
  //    - a duration metric responds to host-side extra work inside the same measured
  //      operation, injected on the host so the project is never touched;
  //    - a failure-count metric responds to broken behaviour, so the control is an
  //      inert version of the editable code, which must raise the failure count. A
  //      baseline that already fails cannot move further, and no independent control
  //      can show sensitivity for it without a known-better patch.
  //    In both cases the control is disposable and never becomes a candidate.
  let sensitivity: number | null = null;
  if (metricMode === "duration") {
    const injectedDelayMs = options.injectedDelayMs ?? Math.max(250, Math.ceil(threshold * 3));
    const degradedFile = path.join(workRoot, `metric-degraded-${crypto.randomUUID()}.mjs`);
    try {
      fs.mkdirSync(workRoot, { recursive: true });
      fs.writeFileSync(degradedFile, evaluatorSource(plan.argv, metricMode, 3, plan.sampleTimeoutMs, injectedDelayMs), "utf8");
      const degraded = await runInstrument({ ...common, evaluatorFile: degradedFile });
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
      fs.rmSync(degradedFile, { force: true });
    }
  } else if (baseline > 0) {
    record("sensitivity", false,
      `the measured target already reports ${Math.round(baseline * 1000) / 1000} ${plan.unit} on the unchanged target, so no independent control can show that the instrument detects an improvement; supply a known-better control patch`);
  } else if (editable.length === 0) {
    record("sensitivity", false, "no editable file was named, so no failure control could be constructed");
  } else {
    const faulted = await runInstrument({ ...common, evaluatorFile, inert: editable });
    if (!faulted.valid) {
      record("sensitivity", false, `the failure control produced no valid reading: ${faulted.error}`);
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
    fs.writeFileSync(missingFile, evaluatorSource(["__dream_rsi_absent_command__"], metricMode, 1, Math.min(plan.sampleTimeoutMs, 15_000)), "utf8");
    const missing = await runInstrument({ ...common, evaluatorFile: missingFile });
    record("missing-workload", !missing.valid, missing.valid
      ? "a nonexistent workload still produced a valid score, so the instrument does not prove the workload ran"
      : `a nonexistent workload is reported as invalid (${missing.error})`);
  } finally {
    fs.rmSync(missingFile, { force: true });
  }

  // 5. An inert version of the editable code must not survive the correctness oracle --
  //    and the oracle must already pass on the unchanged tree, or its rejection of
  //    inert code proves nothing.
  if (gates.length === 0) {
    record("oracle", false, "no declared correctness command exists, so an independent oracle cannot reject a fast but wrong result");
  } else if (editable.length === 0) {
    record("oracle", false, "no editable file was named, so the correctness oracle could not be exercised");
  } else {
    for (const gate of gates) {
      const pristineGate = await runGateOnCopy({ ...common, command: gate });
      if (!pristineGate.passed) {
        record("oracle", false, `${gate} already fails on the unchanged target (${pristineGate.detail}), so it cannot show that broken code would be caught`);
        break;
      }
      const inertGate = await runGateOnCopy({ ...common, command: gate, inert: editable });
      const oracleHolds = !inertGate.passed;
      record("oracle", oracleHolds, oracleHolds
        ? `${gate} rejects an inert version of the editable code (${inertGate.detail}), so a fast but wrong result cannot pass silently`
        : `an inert version of the editable code still passes ${gate}, so the oracle does not constrain the measured behaviour`);
      if (!oracleHolds) break;
    }
  }

  // 6. The confirmation must fit the remaining allowance.
  const confirmationCostMs = plan.sampleTimeoutMs * (metricMode === "duration" ? 4 : 3);
  const budgetFits = confirmationCostMs <= options.contract.budgets.deadlineMs;
  record("budget-fit", budgetFits, budgetFits
    ? `one confirmation (${Math.round(confirmationCostMs / 1000)} s) fits the run deadline (${Math.round(options.contract.budgets.deadlineMs / 1000)} s)`
    : `one confirmation (${Math.round(confirmationCostMs / 1000)} s) does not fit the run deadline (${Math.round(options.contract.budgets.deadlineMs / 1000)} s)`);

  const passed = checks.every((check) => check.passed);
  // The identity covers what *defines* the instrument, not what it *measured*.
  // Baseline readings and sensitivity change on every qualification; including them
  // would give the same instrument a new id each time and silently discard every
  // comparable experiment from the durable history.
  const identity = {
    outcome: options.outcome,
    unit: plan.unit,
    higherIsBetter: plan.higherIsBetter,
    minimumUsefulGain: options.minimumUsefulGain,
    metricKind: plan.metricKind,
    argv: plan.argv,
    gates,
    assets: [{ path: plan.evaluatorPath, sha256: digestOf(evaluatorFile) }],
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
    assets: [{ path: plan.evaluatorPath, sha256: digestOf(evaluatorFile) }],
    baseline: readings,
    sensitivity,
    confirmationPerspective: "candidates never receive the baseline readings, the gate set, or this contract",
  } : null;

  const report: QualificationReport = { passed, checks, contract, rejections };
  plan.qualification = report;
  if (!passed) {
    plan.ready = false;
    plan.evaluationContract = undefined;
    plan.rejections.push(...rejections);
  } else {
    plan.ready = true;
    plan.evaluationContract = contract!;
    // A qualified instrument replaces the "no control patch" refusal.
    plan.rejections = plan.rejections.filter((reason) => !reason.startsWith("no known-better control patch"));
    plan.notes.push(`instrument ${contract!.id} qualified without a supplied winning patch: ${contract!.baseline.length} baseline reading(s), sensitivity ${Math.round((sensitivity ?? 0) * 1000) / 1000} ${plan.unit}.`);
  }
  return report;
}
