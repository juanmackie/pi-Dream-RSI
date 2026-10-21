/** Pure decisions for paired score confirmation. No runtime, clock, or I/O dependencies. */

export type ThresholdInput = number | `${number}%`;
export interface ParsedThreshold { kind: "absolute" | "relative"; value: number; }
export type TestDecision = "continue" | "accept" | "reject" | "futile";

export interface MeasurementPlan {
  deterministic: boolean;
  relative: boolean;
  threshold: number;
  maxCycles: number;
  baselineRuns: number;
  maxPairs: number;
  looks: number;
  alphaConf: number;
  criticalValue: number;
  /** Absolute tolerance used to classify an evaluator as deterministic. */
  exactTolerance: number;
  baselineNoise: number;
  minimumDetectableEffect: number;
  noiseRel: number | null;
  mdeRel: number | null;
  estimatedPowerAtEffect(effect: number): number;
}

export interface DecisionInput {
  plan: MeasurementPlan;
  gains: number[];
  baseline?: number[];
  look?: number;
}

export interface MeasurementDecision {
  decision: TestDecision;
  estimate: number | null;
  statistic: number | null;
  critical: number | null;
  pairs: number;
  reason: string;
}

export interface InstrumentResult { valid: boolean; value: number; }
export interface PairedRunInput {
  plan: MeasurementPlan;
  instrument: (sample: { condition: "before" | "after"; pair: number; order: number; baseline: boolean }) => number | InstrumentResult | Promise<number | InstrumentResult>;
  higherIsBetter?: boolean;
  /** Previously qualified baseline readings. When supplied, do not spend runs repeating them. */
  baselineReadings?: number[];
  /** Stop after this many pairs and return `continue` if later confirmation remains affordable. */
  maxPairsToRun?: number;
  /** Persisted observations from an interrupted confirmation. */
  initialPairs?: Array<{ before: number; after: number; gain: number }>;
  /** Persist the baseline once collected so an interrupted confirmation does not repeat it. */
  onBaselineReadings?: (readings: number[]) => void;
  /** Called after a complete before/after pair, so campaign state can persist it. */
  onPair?: (pair: { before: number; after: number; gain: number }, index: number) => void | Promise<void>;
}

export interface PairedRunResult {
  decision: MeasurementDecision;
  baseline: number[];
  pairs: Array<{ before: number; after: number; gain: number }>;
  runs: number;
}

export function parseThreshold(input: ThresholdInput | string): ParsedThreshold {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new Error("threshold must be a finite non-negative number");
    return { kind: "absolute", value: input };
  }
  const match = /^(\d+(?:\.\d+)?)%$/.exec(input);
  if (!match) throw new Error("threshold must be a non-negative number or percentage such as 5%");
  const percent = Number(match[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent >= 100) throw new Error("percentage threshold must be in [0%, 100%)");
  return { kind: "relative", value: percent / 100 };
}

export function resolveThreshold(threshold: ParsedThreshold, baselineRaw: number, higherIsBetter: boolean): number {
  if (threshold.kind === "absolute") return threshold.value;
  if (!Number.isFinite(baselineRaw) || baselineRaw <= 0) throw new Error("relative threshold requires a positive baseline score");
  if (!higherIsBetter && threshold.value >= 1) throw new Error("relative reduction threshold must be below 100%");
  return higherIsBetter ? Math.log1p(threshold.value) : -Math.log1p(-threshold.value);
}

export function planTest(options: {
  baseline: number[];
  higherIsBetter: boolean;
  threshold: number;
  maxCycles: number;
  deterministic?: boolean;
  relative?: boolean;
  noiseRel?: number;
  exactTolerance?: number;
  maxPairs?: number;
  /**
   * Per-promotion false-accept allowance. A loop that may confirm several
   * campaigns divides its own allowance across them, so the total stays inside the
   * predeclared budget instead of being spent again at every confirmation.
   */
  alphaConf?: number;
}): MeasurementPlan {
  if (!Number.isFinite(options.threshold) || options.threshold < 0) throw new Error("threshold must be finite and non-negative");
  if (!Number.isInteger(options.maxCycles) || options.maxCycles < 1) throw new Error("maxCycles must be a positive integer");
  if (options.noiseRel !== undefined && (!Number.isFinite(options.noiseRel) || options.noiseRel < 0)) throw new Error("noiseRel must be finite and non-negative");
  if (options.baseline.length === 0 || options.baseline.some((value) => !Number.isFinite(value))) throw new Error("baseline must contain finite normalized score samples");
  const deterministic = options.deterministic ?? options.baseline.every((value) => value === options.baseline[0]);
  const noiseSamples = options.relative
    ? options.baseline.map((value) => Math.log(Math.abs(value)))
    : options.baseline;
  if (options.relative && options.baseline.some((value) => value === 0)) throw new Error("relative baseline samples must have non-zero magnitude");
  const baselineNoise = options.noiseRel ?? sampleSd(noiseSamples);
  const requestedPairs = options.maxPairs ?? 8;
  if (!Number.isInteger(requestedPairs) || requestedPairs < 2 || requestedPairs > 64 || requestedPairs % 2 !== 0) throw new Error("maxPairs must be an even number from 2 through 64");
  const maxPairs = deterministic ? 1 : requestedPairs;
  let looks = deterministic ? 1 : Math.min(4, maxPairs / 2);
  while (looks > 1 && maxPairs % looks !== 0) looks -= 1;
  if (options.alphaConf !== undefined && (!Number.isFinite(options.alphaConf) || options.alphaConf <= 0 || options.alphaConf >= 0.5)) {
    throw new Error("alphaConf must be a finite number greater than 0 and below 0.5");
  }
  const alphaConf = options.alphaConf ?? 0.10 / (2 * options.maxCycles);
  const critical = deterministic ? 0 : studentTQuantile(1 - alphaConf / looks, Math.max(1, maxPairs - 1));
  const minimumDetectableEffect = deterministic ? 0 : (critical + normalQuantile(0.75)) * Math.SQRT2 * baselineNoise / Math.sqrt(maxPairs);
  const baselineMagnitude = mean(options.baseline.map(Math.abs));
  const noiseRel = options.relative
    ? Math.sqrt(Math.expm1(baselineNoise ** 2))
    : baselineMagnitude > 0 ? baselineNoise / baselineMagnitude : null;
  const totalDetectableEffect = options.threshold + minimumDetectableEffect;
  const mdeRel = options.relative
    ? (options.higherIsBetter ? Math.expm1(totalDetectableEffect) : -Math.expm1(-totalDetectableEffect))
    : baselineMagnitude > 0 ? totalDetectableEffect / baselineMagnitude : null;
  return {
    deterministic,
    relative: options.relative ?? false,
    threshold: options.threshold,
    maxCycles: options.maxCycles,
    baselineRuns: deterministic ? 0 : 5,
    maxPairs,
    looks,
    alphaConf,
    criticalValue: critical,
    exactTolerance: options.exactTolerance ?? 0,
    baselineNoise,
    minimumDetectableEffect,
    noiseRel,
    mdeRel,
    estimatedPowerAtEffect(effect: number): number {
      if (deterministic) return effect > options.threshold ? 1 : 0;
      const sigma = Math.max(Math.SQRT2 * baselineNoise, Number.EPSILON);
      const z = (effect - options.threshold) * Math.sqrt(maxPairs) / sigma - critical;
      return 1 / (1 + Math.exp(-1.702 * z));
    },
  };
}

function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function sampleSd(values: number[]): number {
  if (values.length < 2) return 0;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

// Acklam inverse-normal approximation, adequate for deterministic critical values, not a guarantee.
function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error("normal quantile probability must be between zero and one");
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425;
  if (p < low) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - low) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function logGamma(z: number): number {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  const shifted = z - 1;
  let sum = 0.99999999999980993;
  coefficients.forEach((coefficient, index) => { sum += coefficient / (shifted + index + 1); });
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

function betaFraction(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const floor = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + aa / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + aa / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  if (x < (a + 1) / (a + b + 2)) return factor * betaFraction(a, b, x) / a;
  return 1 - factor * betaFraction(b, a, 1 - x) / b;
}

function studentTCdf(value: number, degrees: number): number {
  if (value === 0) return 0.5;
  const x = degrees / (degrees + value * value);
  const tail = 0.5 * regularizedBeta(x, degrees / 2, 0.5);
  return value > 0 ? 1 - tail : tail;
}

const quantileCache = new Map<string, number>();
function studentTQuantile(probability: number, degrees: number): number {
  if (!(probability > 0 && probability < 1) || degrees < 1) throw new Error("invalid Student t quantile parameters");
  const key = `${probability}:${degrees}`;
  const cached = quantileCache.get(key);
  if (cached !== undefined) return cached;
  if (probability === 0.9975 && degrees <= 7) {
    let value: number;
    switch (degrees) {
      case 1: value = 127.321336468871; break;
      case 2: value = 14.0890472105; break;
      case 3: value = 7.453318505; break;
      case 4: value = 5.59756836707546; break;
      case 5: value = 4.773341308; break;
      case 6: value = 4.316827104; break;
      case 7: value = 4.0293379; break;
      default: throw new Error("invalid cached Student t degrees of freedom");
    }
    value += 1e-6;
    quantileCache.set(key, value);
    return value;
  }
  if (probability === 0.5) { quantileCache.set(key, 0); return 0; }
  if (probability < 0.5) return -studentTQuantile(1 - probability, degrees);
  let high = 1;
  while (studentTCdf(high, degrees) < probability) high *= 2;
  let low = 0;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (studentTCdf(middle, degrees) < probability) low = middle;
    else high = middle;
  }
  quantileCache.set(key, high);
  return high;
}

export function decide(input: DecisionInput): MeasurementDecision {
  const { plan, gains } = input;
  if (gains.some((value) => !Number.isFinite(value))) return { decision: "reject", estimate: null, statistic: null, critical: null, pairs: gains.length, reason: "invalid measurement" };
  if (plan.deterministic) {
    const gain = gains[0];
    const accept = gains.length === 1 && gain !== undefined && gain > plan.threshold;
    return { decision: accept ? "accept" : "reject", estimate: gain ?? null, statistic: null, critical: null, pairs: gains.length, reason: accept ? "exact pair exceeds threshold" : "exact pair does not exceed threshold" };
  }
  if (gains.length === 0) return { decision: "continue", estimate: null, statistic: null, critical: null, pairs: 0, reason: "no paired observations" };
  const estimate = mean(gains);
  const baselineSd = Math.max(plan.baselineNoise, input.baseline ? sampleSd(input.baseline) : 0);
  const baselineComponent = Math.SQRT2 * baselineSd;
  const pairedSd = sampleSd(gains);
  const sd = Math.max(baselineComponent, pairedSd);
  const look = input.look ?? Math.ceil(gains.length / (plan.maxPairs / plan.looks));
  const degrees = Math.max(1, gains.length - 1);
  const critical = studentTQuantile(1 - plan.alphaConf / plan.looks, degrees);
  const statistic = (estimate - plan.threshold) * Math.sqrt(gains.length) / Math.max(sd, Number.EPSILON);
  if (statistic >= critical) return { decision: "accept", estimate, statistic, critical, pairs: gains.length, reason: "one-sided Student t boundary crossed" };
  const uncertainty = sd / Math.sqrt(gains.length);
  if (estimate + uncertainty < plan.threshold) return { decision: "futile", estimate, statistic, critical, pairs: gains.length, reason: "upper one-standard-error bound is below threshold" };
  if (look >= plan.looks || gains.length >= plan.maxPairs) return { decision: "reject", estimate, statistic, critical, pairs: gains.length, reason: "maximum looks reached without crossing boundary" };
  return { decision: "continue", estimate, statistic, critical, pairs: gains.length, reason: "more paired observations may resolve the result" };
}

function unpack(result: number | InstrumentResult): InstrumentResult {
  return typeof result === "number" ? { valid: Number.isFinite(result), value: result } : result;
}

export async function runPaired(input: PairedRunInput): Promise<PairedRunResult> {
  const { plan, instrument } = input;
  const baseline: number[] = input.baselineReadings ? [...input.baselineReadings] : [];
  if (baseline.some((value) => !Number.isFinite(value)) || (baseline.length > 0 && baseline.length < 2)) {
    return { decision: { decision: "reject", estimate: null, statistic: null, critical: null, pairs: 0, reason: "invalid reused baseline measurements" }, baseline, pairs: [], runs: 0 };
  }
  let runs = 0;
  for (let index = 0; !input.baselineReadings && index < plan.baselineRuns; index += 1) {
    const result = unpack(await instrument({ condition: "before", pair: index, order: runs, baseline: true })); runs += 1;
    if (!result.valid || !Number.isFinite(result.value)) return { decision: { decision: "reject", estimate: null, statistic: null, critical: null, pairs: 0, reason: "invalid baseline measurement" }, baseline, pairs: [], runs };
    baseline.push(result.value);
  }
  if (plan.deterministic && baseline.some((value) => Math.abs(value - baseline[0]!) > plan.exactTolerance)) {
    return { decision: { decision: "reject", estimate: null, statistic: null, critical: null, pairs: 0, reason: "evaluator declared deterministic but baseline varied" }, baseline, pairs: [], runs };
  }
  input.onBaselineReadings?.(baseline);
  const maxPairsToRun = input.maxPairsToRun ?? plan.maxPairs;
  if (!Number.isInteger(maxPairsToRun) || maxPairsToRun < 1 || maxPairsToRun > plan.maxPairs) throw new Error("maxPairsToRun must be between 1 and the plan maximum");
  const initialPairs = input.initialPairs ?? [];
  if (initialPairs.length > maxPairsToRun || initialPairs.some((pair) => !Number.isFinite(pair.before) || !Number.isFinite(pair.after) || !Number.isFinite(pair.gain))) throw new Error("saved confirmation pairs are invalid or exceed the current limit");
  const pairs: PairedRunResult["pairs"] = initialPairs.map((pair) => ({ ...pair }));
  const baselineCenter = baseline.length > 0 ? mean(baseline) : 0;
  const normalizedBaseline = plan.relative && baselineCenter > 0
    ? baseline.map((value) => input.higherIsBetter === false ? Math.log(baselineCenter / value) : Math.log(value / baselineCenter))
    : baseline.map((value) => input.higherIsBetter === false ? -value : value);
  const lookStride = plan.deterministic ? 1 : plan.maxPairs / plan.looks;
  if (pairs.length > 0 && pairs.length % lookStride === 0) {
    const priorDecision = decide({ plan, gains: pairs.map((entry) => entry.gain), baseline: normalizedBaseline, look: Math.min(plan.looks, pairs.length / lookStride) });
    if (priorDecision.decision !== "continue") return { decision: priorDecision, baseline, pairs, runs };
  }
  for (let pair = pairs.length; pair < maxPairsToRun; pair += 1) {
    const reverse = pair % 2 === 1;
    const first = reverse ? "after" : "before";
    const second = reverse ? "before" : "after";
    const firstValue = unpack(await instrument({ condition: first, pair, order: runs, baseline: false })); runs += 1;
    const secondValue = unpack(await instrument({ condition: second, pair, order: runs, baseline: false })); runs += 1;
    if (!firstValue.valid || !secondValue.valid || !Number.isFinite(firstValue.value) || !Number.isFinite(secondValue.value)) {
      return { decision: { decision: "reject", estimate: null, statistic: null, critical: null, pairs: pairs.length, reason: "invalid paired measurement" }, baseline, pairs, runs };
    }
    const before = first === "before" ? firstValue.value : secondValue.value;
    const after = first === "after" ? firstValue.value : secondValue.value;
    let gain = input.higherIsBetter === false ? before - after : after - before;
    if (plan.relative) {
      if (before <= 0 || after <= 0) return { decision: { decision: "reject", estimate: null, statistic: null, critical: null, pairs: pairs.length, reason: "relative measurement requires positive scores" }, baseline, pairs, runs };
      gain = input.higherIsBetter === false ? Math.log(before / after) : Math.log(after / before);
    }
    const observation = { before, after, gain };
    pairs.push(observation);
    await input.onPair?.(observation, pair);
    if (plan.deterministic) {
      return { decision: decide({ plan, gains: [gain] }), baseline, pairs, runs };
    }
    if ((pair + 1) % (plan.maxPairs / plan.looks) === 0) {
      const decision = decide({ plan, gains: pairs.map((entry) => entry.gain), baseline: normalizedBaseline, look: (pair + 1) / (plan.maxPairs / plan.looks) });
      if (decision.decision !== "continue") return { decision, baseline, pairs, runs };
    }
  }
  const decision = maxPairsToRun < plan.maxPairs
    ? decide({ plan, gains: pairs.map((entry) => entry.gain), baseline: normalizedBaseline, look: Math.max(1, Math.ceil(maxPairsToRun / (plan.maxPairs / plan.looks))) })
    : decide({ plan, gains: pairs.map((entry) => entry.gain), baseline: normalizedBaseline, look: plan.looks });
  return { decision: decision.decision === "continue" && maxPairsToRun < plan.maxPairs ? { ...decision, reason: "confirmation remains resumable within the plan maximum" } : decision, baseline, pairs, runs };
}
