/**
 * Magnitude estimation for lever ranking.
 *
 * A measured workload says where a gain can be verified. It does not say how
 * large that gain could be. This module reads structural evidence from the code
 * a workload exercises and classifies the campaign that has the best chance of
 * an order-of-magnitude result. The estimate is deliberately coarse and
 * conservative: it orders search, it never replaces the evaluator, gates,
 * review, or the independent post-apply check that decide whether a change is
 * real.
 */

import type { CampaignType, LeverMagnitude } from "./levers.ts";

/** Structural facts about the code a lever can edit. */
export interface MagnitudeSignals {
  /** A loop body contains another loop. */
  nestedLoops?: boolean;
  /** A loop body calls a linear scan such as includes, indexOf, find, or filter. */
  linearScanInLoop?: boolean;
  /** A loop body performs blocking I/O or process work. */
  syncIoInLoop?: boolean;
  /** Several awaits run in sequence without a parallel combinator. */
  serialAwait?: boolean;
  /** Branch density is high enough that control flow is hard to follow. */
  branchHeavy?: boolean;
  /** The file is large enough to be a maintenance hotspot. */
  largeFile?: boolean;
  /** The file is both large and function-dense. */
  godFile?: boolean;
  /** Count of declared dependencies that lag a whole major version, when known. */
  dependencyMajorLag?: number;
  /** Number of local modules that import this file. */
  inboundImports?: number;
  /** Physical lines in the file. */
  lines?: number;
}

const CAMPAIGN_PRIORITY: Record<CampaignType, number> = {
  "local-hill": 0,
  structural: 1,
  dependency: 2,
  systemic: 3,
  algorithmic: 4,
};

/** Higher means a more ambitious campaign type. The order is part of the taxonomy contract. */
export function campaignTypePriority(type: CampaignType): number {
  return CAMPAIGN_PRIORITY[type];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Estimate the best campaign type and its plausible multiplier.
 *
 * Each rule names the mechanism that could produce the gain and the reason the
 * confidence is limited. A high multiplier with low confidence can still rank
 * first: that is the point of magnitude-seeking, not a claim that the gain will
 * happen.
 */
export function estimateMagnitude(signals: MagnitudeSignals): LeverMagnitude {
  const candidates: LeverMagnitude[] = [];
  const inbound = Math.max(0, signals.inboundImports ?? 0);
  const lines = Math.max(0, signals.lines ?? 0);
  const hot = inbound >= 2 ? `; ${inbound} local modules import this file` : "";

  if (signals.nestedLoops) {
    candidates.push({
      campaignType: "algorithmic",
      expectedGainMultiplier: signals.linearScanInLoop ? 8 : 6,
      confidence: 0.35,
      rationale: [
        `a loop body contains another loop${hot}; an algorithmic or data-structure change can remove repeated work, but the multiplier is unproven until the evaluator confirms it`,
      ],
    });
  } else if (signals.linearScanInLoop) {
    candidates.push({
      campaignType: "algorithmic",
      expectedGainMultiplier: 3.5,
      confidence: 0.45,
      rationale: [
        `a loop body performs a linear scan${hot}; a set, index, or single-pass aggregation can remove repeated scans, subject to evaluator evidence`,
      ],
    });
  }

  if (signals.syncIoInLoop || signals.serialAwait) {
    const mechanisms = [
      ...(signals.syncIoInLoop ? ["blocking I/O inside a loop"] : []),
      ...(signals.serialAwait ? ["sequential awaits without a parallel combinator"] : []),
    ];
    candidates.push({
      campaignType: "systemic",
      expectedGainMultiplier: signals.syncIoInLoop && signals.serialAwait ? 3.5 : signals.syncIoInLoop ? 3 : 2.2,
      confidence: 0.5,
      rationale: [
        `${mechanisms.join(" and ")}${hot}; batching, caching, or bounded concurrency can reduce wall time, but the measured result decides`,
      ],
    });
  }

  if ((signals.dependencyMajorLag ?? 0) >= 1) {
    const lag = Math.min(4, signals.dependencyMajorLag ?? 1);
    candidates.push({
      campaignType: "dependency",
      expectedGainMultiplier: 1.5 + 0.25 * lag,
      confidence: 0.4,
      rationale: [
        `${lag} declared dependency major version${lag === 1 ? " is" : "s are"} behind the pinned range; a measured upgrade can help, but compatibility and the evaluator decide`,
      ],
    });
  }

  if (signals.godFile || signals.largeFile || signals.branchHeavy) {
    const reasons = [
      ...(signals.godFile ? ["the file is large and function-dense"] : signals.largeFile ? ["the file is large"] : []),
      ...(signals.branchHeavy ? ["branch density is high"] : []),
    ];
    candidates.push({
      campaignType: "structural",
      expectedGainMultiplier: 1.4,
      confidence: 0.55,
      rationale: [
        `${reasons.join(" and ")}${hot}; a shape-preserving refactor can reduce maintenance and repeated work, but it is a smaller bet than an algorithmic change`,
      ],
    });
  }

  if (candidates.length === 0) {
    return {
      campaignType: "local-hill",
      expectedGainMultiplier: 1.15,
      confidence: 0.7,
      rationale: [
        lines > 0
          ? `no structural magnitude signal was found in ${lines} line(s); optimize locally inside the measured workload and let the evaluator decide`
          : "no structural magnitude signal was found; optimize locally inside the measured workload and let the evaluator decide",
      ],
    };
  }

  candidates.sort((left, right) => magnitudeUtility(right) - magnitudeUtility(left)
    || CAMPAIGN_PRIORITY[right.campaignType] - CAMPAIGN_PRIORITY[left.campaignType]
    || left.campaignType.localeCompare(right.campaignType));
  const best = candidates[0]!;
  return {
    ...best,
    expectedGainMultiplier: round(clamp(best.expectedGainMultiplier, 1, 100)),
    confidence: round(clamp(best.confidence, 0, 1)),
    rationale: [...best.rationale, ...(candidates.length > 1
      ? [`other signals present: ${candidates.slice(1).map((entry) => entry.campaignType).join(", ")}`]
      : [])],
  };
}

/**
 * Log-utility of a magnitude estimate. A 6x bet at 35% confidence beats a 15%
 * local gain at 70% confidence; that ordering is the product decision this
 * module encodes.
 */
export function magnitudeUtility(magnitude: LeverMagnitude): number {
  const multiplier = Math.max(1, magnitude.expectedGainMultiplier);
  return Math.log2(multiplier) * clamp(magnitude.confidence, 0, 1);
}

/** One file's structural facts, as read from a project card or a scope scan. */
export interface ScopeFileSignals {
  path: string;
  signals: MagnitudeSignals;
}

/**
 * Merge per-file estimates for one lever scope. The most useful estimate wins;
 * repeated evidence of the same campaign type raises confidence slightly, and
 * the rationale names the files that supplied it.
 */
export function estimateScopeMagnitude(files: ScopeFileSignals[]): LeverMagnitude {
  if (files.length === 0) return estimateMagnitude({});
  const estimates = files.map((file) => ({ path: file.path, magnitude: estimateMagnitude(file.signals) }));
  estimates.sort((left, right) => magnitudeUtility(right.magnitude) - magnitudeUtility(left.magnitude)
    || left.path.localeCompare(right.path));
  const best = estimates[0]!;
  const sameType = estimates.filter((entry) => entry.magnitude.campaignType === best.magnitude.campaignType);
  const supporting = sameType.slice(0, 3).map((entry) => entry.path);
  return {
    campaignType: best.magnitude.campaignType,
    expectedGainMultiplier: best.magnitude.expectedGainMultiplier,
    // Repeated independent evidence is weak evidence; cap the bonus so one
    // repeated pattern cannot look like a certainty.
    confidence: round(clamp(best.magnitude.confidence + Math.min(0.1, 0.02 * (sameType.length - 1)), 0, 0.85)),
    rationale: [
      ...best.magnitude.rationale,
      ...(supporting.length > 1 ? [`supporting scope: ${supporting.join(", ")}`] : []),
    ],
  };
}

/** Short operator-facing description, used in status and reports. */
export function magnitudeLabel(magnitude: LeverMagnitude): string {
  const multiplier = magnitude.expectedGainMultiplier >= 10
    ? Math.round(magnitude.expectedGainMultiplier)
    : round(magnitude.expectedGainMultiplier, 1);
  return `${magnitude.campaignType} ~${multiplier}x best case at ${Math.round(magnitude.confidence * 100)}% confidence`;
}
