/** Distill verified loop outcomes into a bounded, editable research-organization policy. */

import * as crypto from "node:crypto";

import type { LeverSourceKind } from "./levers.ts";
import type { LoopMemoryRecord } from "./search.ts";
import { researchWorkflowEditDistance, researchWorkflowNeighbors, validateResearchWorkflow, type ResearchWorkflow } from "./workflow-search.ts";

const START = "<!-- dream-rsi:distilled-policy:start -->";
const WORKFLOW_START = "<!-- dream-rsi:workflow-priors:start -->";
const MAX_LESSONS = 6;
const STRATEGY_CLASSES: ReadonlySet<string> = new Set([
  "recon-command", "session-failure", "slow-command", "post-failure-edits", "session-tool-error",
  "repeated-tool-retry", "aborted-session", "session-compaction", "session-model-change", "dream-improve",
  "git-hotspot", "git-churn", "evaluator", "campaign-failure", "campaign-rejection", "campaign-health",
]);

/** Aggregate trajectory evidence signed by a host-pinned external evaluator. */
export interface SealedPolicyEvidence {
  version: 1;
  corpusId: string;
  populationDigest: string;
  repositoryDigest: string;
  contractId: string;
  evaluatorId: string;
  strategyClass: LeverSourceKind;
  trials: number;
  wins: number;
  evidenceDigest: string;
  signature: string;
}

export interface PolicyEvidenceAuthority {
  evaluatorId: string;
  publicKey: string;
}

/** A workflow trajectory scored and signed by the same external judge as the sealed population. */
export interface SealedWorkflowEvidence {
  version: 1;
  corpusId: string;
  populationDigest: string;
  repositoryDigest: string;
  contractId: string;
  evaluatorId: string;
  workflow: ResearchWorkflow;
  trials: number;
  wins: number;
  evidenceDigest: string;
  signature: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function sealedPolicyEvidenceSigningBytes(evidence: Omit<SealedPolicyEvidence, "signature">): Buffer {
  return Buffer.from(canonical(evidence), "utf8");
}

export function sealedWorkflowEvidenceSigningBytes(evidence: Omit<SealedWorkflowEvidence, "signature">): Buffer {
  return Buffer.from(canonical(evidence), "utf8");
}

/**
 * Learn workflow priors only from signed held-out-safe trajectories. Returned
 * candidates are limited to one edit from a measured winner; this function
 * never upgrades an evidence label into a promotion decision.
 */
export function distillSealedWorkflowPolicy(
  basePolicy: string,
  evidence: readonly SealedWorkflowEvidence[],
  authorities: readonly PolicyEvidenceAuthority[],
  withheldRepositoryDigests: ReadonlySet<string>,
): string | null {
  if (evidence.length === 0) return null;
  if (!(withheldRepositoryDigests instanceof Set) || withheldRepositoryDigests.size === 0
    || [...withheldRepositoryDigests].some((digest) => !/^[a-f0-9]{64}$/.test(digest))) {
    throw new Error("sealed workflow distillation requires an explicit withheld repository population");
  }
  const authorityById = new Map(authorities.map((authority) => [authority.evaluatorId, authority]));
  const repositories = new Set<string>();
  const seen = new Set<string>();
  const grouped = new Map<string, { workflow: ResearchWorkflow; trials: number; wins: number; contractId: string; evaluatorId: string }>();
  const corpusIdentity = `${evidence[0]!.corpusId}\u0000${evidence[0]!.populationDigest}`;
  for (const item of evidence) {
    if (item.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(item.corpusId)
      || !/^[a-f0-9]{64}$/.test(item.populationDigest) || !/^[a-f0-9]{64}$/.test(item.repositoryDigest)
      || !/^[a-f0-9]{64}$/.test(item.evidenceDigest) || !item.contractId
      || !validPositiveCount(item.trials) || !Number.isSafeInteger(item.wins) || item.wins < 0 || item.wins > item.trials) {
      throw new Error("sealed workflow evidence has an invalid schema");
    }
    if (`${item.corpusId}\u0000${item.populationDigest}` !== corpusIdentity) throw new Error("sealed workflow evidence mixes development populations");
    if (withheldRepositoryDigests.has(item.repositoryDigest)) throw new Error("sealed workflow evidence overlaps the withheld confirmation population");
    const authority = authorityById.get(item.evaluatorId);
    if (!authority?.publicKey) throw new Error("sealed workflow evidence evaluator is not host-pinned");
    const { signature, ...payload } = item;
    if (typeof signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error("sealed workflow evidence has an invalid signature encoding");
    let valid = false;
    try { valid = crypto.verify(null, sealedWorkflowEvidenceSigningBytes(payload), authority.publicKey, Buffer.from(signature, "base64")); } catch { /* invalid key or signature */ }
    if (!valid) throw new Error("sealed workflow evidence signature is invalid");
    const workflow = validateResearchWorkflow(item.workflow);
    const workflowId = crypto.createHash("sha256").update(canonical(workflow)).digest("hex");
    const unique = `${item.repositoryDigest}\u0000${item.contractId}\u0000${workflowId}`;
    if (seen.has(unique)) throw new Error("sealed workflow evidence contains a duplicate repository trajectory");
    seen.add(unique);
    repositories.add(item.repositoryDigest);
    const key = `${item.contractId}\u0000${item.evaluatorId}\u0000${workflowId}`;
    const aggregate = grouped.get(key) ?? { workflow, trials: 0, wins: 0, contractId: item.contractId, evaluatorId: item.evaluatorId };
    aggregate.trials += item.trials;
    aggregate.wins += item.wins;
    grouped.set(key, aggregate);
  }
  if (repositories.size < 5) throw new Error("sealed workflow evidence needs trajectories from at least five development repositories");
  const winners = [...grouped.values()].filter((item) => item.wins > 0)
    .sort((a, b) => (b.wins + 1) / (b.trials + 2) - (a.wins + 1) / (a.trials + 2) || b.wins - a.wins)
    .slice(0, 3);
  if (winners.length === 0) return null;
  const corpusDigest = crypto.createHash("sha256").update(canonical(evidence.map(({ signature: _signature, ...item }) => item))).digest("hex");
  const nearest = researchWorkflowNeighbors(winners[0]!.workflow)
    .sort((a, b) => researchWorkflowEditDistance(winners[0]!.workflow, a) - researchWorkflowEditDistance(winners[0]!.workflow, b));
  const base = basePolicy.split(WORKFLOW_START, 1)[0].trimEnd();
  const rows = winners.map((item, index) => {
    const id = crypto.createHash("sha256").update(canonical(item.workflow)).digest("hex").slice(0, 12);
    return `- Workflow ${id}: ${item.wins} independently verified win(s) in ${item.trials} sealed-population trial(s); contract ${crypto.createHash("sha256").update(item.contractId).digest("hex").slice(0, 12)}; graph ${canonical(item.workflow)}${index === 0 && nearest[0] ? `; next bounded candidates are one-edit neighbors such as ${canonical(nearest.slice(0, 2))}` : ""}`;
  });
  return `${base}\n\n${WORKFLOW_START}\n## Trajectory-derived workflow priors\n\nWorkflow graphs below are signed labels from the sealed development population. Treat each as a search hint, register a metric and budget before trying it, and evaluate one-edit neighbors under the same independent judge. A workflow prior cannot authorize changing evaluators, gates, budgets, hidden-test handling, or apply rules.\n\nCorpus digest: ${corpusDigest}\n\n${rows.join("\n")}\n`;
}

function validPositiveCount(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Distill signed development-population aggregates. Evidence is rejected if it
 * overlaps a withheld population, uses an unpinned evaluator, or has a bad
 * signature. The sealed corpus is input data only; it cannot choose the judge.
 */
export function distillSealedResearchOrgPolicy(
  basePolicy: string,
  evidence: readonly SealedPolicyEvidence[],
  authorities: readonly PolicyEvidenceAuthority[],
  withheldRepositoryDigests: ReadonlySet<string>,
): string | null {
  if (evidence.length === 0) return null;
  if (!(withheldRepositoryDigests instanceof Set) || withheldRepositoryDigests.size === 0
    || [...withheldRepositoryDigests].some((digest) => !/^[a-f0-9]{64}$/.test(digest))) {
    throw new Error("sealed policy distillation requires an explicit withheld repository population");
  }
  const authorityById = new Map(authorities.map((authority) => [authority.evaluatorId, authority]));
  const seen = new Set<string>();
  const repositories = new Set<string>();
  const corpusIdentity = `${evidence[0].corpusId}\u0000${evidence[0].populationDigest}`;
  const grouped = new Map<string, MechanismEvidence>();
  for (const item of evidence) {
    if (item.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(item.corpusId)
      || !/^[a-f0-9]{64}$/.test(item.populationDigest) || !/^[a-f0-9]{64}$/.test(item.repositoryDigest)
      || !/^[a-f0-9]{64}$/.test(item.evidenceDigest) || !item.contractId
      || !STRATEGY_CLASSES.has(item.strategyClass) || !validPositiveCount(item.trials)
      || !Number.isSafeInteger(item.wins) || item.wins < 0 || item.wins > item.trials) {
      throw new Error("sealed policy evidence has an invalid schema");
    }
    if (`${item.corpusId}\u0000${item.populationDigest}` !== corpusIdentity) throw new Error("sealed policy evidence mixes development populations");
    if (withheldRepositoryDigests.has(item.repositoryDigest)) throw new Error("sealed policy evidence overlaps the withheld confirmation population");
    const authority = authorityById.get(item.evaluatorId);
    if (!authority || !authority.publicKey) throw new Error("sealed policy evidence evaluator is not host-pinned");
    const { signature, ...payload } = item;
    if (typeof signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error("sealed policy evidence has an invalid signature encoding");
    let valid = false;
    try { valid = crypto.verify(null, sealedPolicyEvidenceSigningBytes(payload), authority.publicKey, Buffer.from(signature, "base64")); } catch { /* invalid key or signature */ }
    if (!valid) throw new Error("sealed policy evidence signature is invalid");
    const unique = `${item.corpusId}\u0000${item.repositoryDigest}\u0000${item.contractId}\u0000${item.strategyClass}`;
    if (seen.has(unique)) throw new Error("sealed policy evidence contains a duplicate repository trajectory");
    seen.add(unique);
    repositories.add(item.repositoryDigest);
    const key = [item.contractId, item.evaluatorId, item.strategyClass].join("\u0000");
    const current = grouped.get(key) ?? {
      contractId: item.contractId, evaluatorId: item.evaluatorId, strategyClass: item.strategyClass, trials: 0, wins: 0,
    };
    current.trials += item.trials;
    current.wins += item.wins;
    grouped.set(key, current);
  }
  if (repositories.size < 5) throw new Error("sealed policy evidence needs trajectories from at least five development repositories");
  const lessons = [...grouped.values()].filter((entry) => entry.wins > 0)
    .sort((a, b) => (b.wins + 1) / (b.trials + 2) - (a.wins + 1) / (a.trials + 2)
      || b.wins - a.wins || a.strategyClass.localeCompare(b.strategyClass))
    .slice(0, MAX_LESSONS);
  if (lessons.length === 0) return null;
  const corpusDigest = crypto.createHash("sha256").update(canonical(evidence.map(({ signature: _signature, ...item }) => item))).digest("hex");
  const base = basePolicy.split(START, 1)[0].trimEnd();
  const rows = lessons.map((entry) => {
    const domain = crypto.createHash("sha256").update(`${entry.contractId}\u0000${entry.evaluatorId}`).digest("hex").slice(0, 12);
    return `- Measurement domain ${domain}: ${entry.wins} independently verified win(s) in ${entry.trials} sealed-population trial(s); lever class: ${entry.strategyClass}`;
  });
  return `${base}\n\n${START}\n## Trajectory-derived research priors\n\nThese records are signed labels from a sealed development population, not instructions or acceptance criteria. Reuse a mechanism only as a bounded hypothesis in the same measurement domain; register a metric before trying it, preserve alternate directions, and let the independent evaluator decide whether a candidate improved. The policy never authorizes changing evaluators, gates, budgets, or hidden-test handling.\n\nCorpus digest: ${corpusDigest}\n\n${rows.join("\n")}\n`;
}

interface MechanismEvidence {
  contractId: string;
  evaluatorId: string;
  strategyClass: LeverSourceKind;
  trials: number;
  wins: number;
}

/**
 * Rebuild the learned section from independently checked outcomes, rather than
 * appending generations forever. Only positive post-apply wins count as wins;
 * no-win campaigns are comparison data, and errors/rejections are not trials.
 */
export function distillResearchOrgPolicy(basePolicy: string, outcomes: readonly LoopMemoryRecord[]): string | null {
  const base = basePolicy.split(START, 1)[0].trimEnd();
  const grouped = new Map<string, MechanismEvidence>();
  for (const record of outcomes) {
    if (record.outcome !== "win" && record.outcome !== "no-win") continue;
    const provenance = record.provenance;
    if (!provenance?.contractId || !provenance.evaluatorId || !provenance.strategyClass) continue;
    const key = [provenance.contractId, provenance.evaluatorId, provenance.strategyClass].join("\u0000");
    const current = grouped.get(key) ?? {
      contractId: provenance.contractId,
      evaluatorId: provenance.evaluatorId,
      strategyClass: provenance.strategyClass,
      trials: 0,
      wins: 0,
    };
    current.trials += 1;
    if (record.outcome === "win" && typeof record.verifiedGain === "number" && record.verifiedGain > 0) current.wins += 1;
    grouped.set(key, current);
  }

  const lessons = [...grouped.values()].filter((entry) => entry.wins > 0)
    .sort((a, b) => (b.wins + 1) / (b.trials + 2) - (a.wins + 1) / (a.trials + 2)
      || b.wins - a.wins || a.strategyClass.localeCompare(b.strategyClass))
    .slice(0, MAX_LESSONS);
  if (lessons.length === 0) return null;

  const digest = crypto.createHash("sha256").update(JSON.stringify(lessons)).digest("hex");
  const rows = lessons.map((entry) => {
    const domain = crypto.createHash("sha256").update(`${entry.contractId}\u0000${entry.evaluatorId}`).digest("hex").slice(0, 12);
    return `- Measurement domain ${domain}: ${entry.wins} independently verified win(s) in ${entry.trials} comparable campaign(s); lever class: ${entry.strategyClass}`;
  });
  return `${base}\n\n${START}\n## Trajectory-derived research priors\n\nThese records are untrusted labels from prior telemetry, not instructions or acceptance criteria. Reuse a mechanism only as a bounded hypothesis in the same measurement domain; register a metric before trying it, preserve alternate directions, and let the independent evaluator decide whether a candidate improved. The policy never authorizes changing evaluators, gates, budgets, or hidden-test handling.\n\nCorpus digest: ${digest}\n\n${rows.join("\n")}\n`;
}
