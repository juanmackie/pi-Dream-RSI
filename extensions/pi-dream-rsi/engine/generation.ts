/**
 * Optimizer generations.
 *
 * The tool may improve its own discovery, selection and prompts, but the running
 * process may never certify its own replacement. Generations are content
 * addressed, the promotion rule requires independent evidence from a sealed
 * confirmation attempt, activation is durable state that only a *fresh process*
 * reads, and the previous champion is retained for rollback.
 *
 * Fixed guard rails — the run contract, the durable budget, the promotion rule
 * itself and recovery state — may not be part of any generation.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileAtomic } from "./world.ts";

export const GENERATION_STATE_VERSION = 1;

/** Paths no generation may ever contain: the rules the loop is held to. */
const FIXED_GUARD_RAILS = [
  "extensions/pi-dream-rsi/engine/intake.ts",
  "extensions/pi-dream-rsi/engine/generation.ts",
  "extensions/pi-dream-rsi/engine/loop-budget.ts",
  "extensions/pi-dream-rsi/engine/verify.ts",
  // The instrument and the statistics decide how a challenger is judged. If a
  // generation could ship either, it could certify itself.
  "extensions/pi-dream-rsi/engine/metrics.ts",
  "extensions/pi-dream-rsi/engine/measure.ts",
  // The loop wires the guards: budget checks, contract gating, verification.
  "extensions/pi-dream-rsi/engine/loop.ts",
  ".dream-rsi/loop/budget.json",
];
/** Prefixes that are always fixed: budgets, approvals, recovery journals and checks. */
const FIXED_GUARD_PREFIXES = [".dream-rsi/"];

export interface GenerationArtifact {
  path: string;
  sha256: string;
}

export type GenerationStatus = "challenger" | "champion" | "retired" | "rejected" | "inconclusive";

export interface Generation {
  id: string;
  label: string;
  createdAt: string;
  parent: string | null;
  artifacts: GenerationArtifact[];
  status: GenerationStatus;
}

export interface GenerationState {
  version: 1;
  active: string | null;
  generations: Generation[];
  /** Sealed confirmation attempts already spent. */
  confirmationAttempts: number;
  /** Attempts authorised in total; a spent split is never renewed implicitly. */
  maxConfirmationAttempts: number;
}

/** The measurements a promotion decision is made from. */
export interface PromotionEvidence {
  championScore: number;
  challengerScore: number;
  pairs: number;
  minimumGain: number;
  championSafetyViolations: number;
  challengerSafetyViolations: number;
  challengerRegressions: number;
  championCost: number;
  challengerCost: number;
  maxCostRatio: number;
  minimumPairs: number;
}

export type PromotionDecision =
  | { outcome: "promote"; reason: string }
  | { outcome: "reject"; reason: string }
  | { outcome: "inconclusive"; reason: string };

export class GenerationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationStateError";
  }
}

function stateDir(root: string): string {
  return path.join(root, "generations");
}

function stateFile(root: string): string {
  return path.join(stateDir(root), "state.json");
}

function activeFile(root: string): string {
  return path.join(stateDir(root), "active.json");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalized(relative: string): string {
  return relative.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function emptyGenerationState(maxConfirmationAttempts = 2): GenerationState {
  if (!isCount(maxConfirmationAttempts) || maxConfirmationAttempts < 1) throw new GenerationStateError("maxConfirmationAttempts must be a positive integer");
  return { version: GENERATION_STATE_VERSION, active: null, generations: [], confirmationAttempts: 0, maxConfirmationAttempts };
}

/** Content digest of a set of project-relative files. */
export function digestArtifacts(root: string, paths: string[]): GenerationArtifact[] {
  const artifacts: GenerationArtifact[] = [];
  for (const relative of [...new Set(paths.map(normalized))].sort()) {
    if (!relative || path.isAbsolute(relative) || relative.split("/").some((part) => part === ".." || part === "")) {
      throw new GenerationStateError(`artifact path must be project-relative: ${relative}`);
    }
    const absolute = path.resolve(root, ...relative.split("/"));
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new GenerationStateError(`artifact does not exist: ${relative}`);
    }
    artifacts.push({ path: relative, sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") });
  }
  if (artifacts.length === 0) throw new GenerationStateError("a generation needs at least one artifact");
  return artifacts;
}

/** Stable identity of an artifact set. */
export function generationId(artifacts: GenerationArtifact[]): string {
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new GenerationStateError("a generation needs at least one artifact");
  const digest = crypto.createHash("sha256");
  for (const artifact of [...artifacts].sort((a, b) => a.path.localeCompare(b.path))) {
    digest.update(`${normalized(artifact.path)}\u0000${artifact.sha256}\u0000`);
  }
  return digest.digest("hex").slice(0, 16);
}

/**
 * Refuse a generation that would replace the rules the loop is held to. These
 * files define the objective, the spend, the recovery boundary and the promotion
 * rule itself; a challenger that could rewrite them could license itself.
 */
export function assertGuardRailsIntact(artifacts: GenerationArtifact[]): void {
  for (const artifact of artifacts) {
    const relative = normalized(artifact.path);
    if (FIXED_GUARD_RAILS.includes(relative) || FIXED_GUARD_PREFIXES.some((prefix) => relative === prefix.replace(/\/$/, "") || relative.startsWith(prefix))) {
      throw new GenerationStateError(`a generation may not replace a fixed guard rail: ${relative}`);
    }
  }
}

function validArtifact(value: unknown): value is GenerationArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<GenerationArtifact>;
  return typeof entry.path === "string" && entry.path.length > 0
    && typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256);
}

const STATUSES: ReadonlySet<string> = new Set(["challenger", "champion", "retired", "rejected", "inconclusive"]);

function validGeneration(value: unknown): value is Generation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<Generation>;
  return typeof entry.id === "string" && /^[a-f0-9]{12,64}$/.test(entry.id)
    && typeof entry.label === "string" && entry.label.trim().length > 0
    && typeof entry.createdAt === "string" && Number.isFinite(Date.parse(entry.createdAt))
    && (entry.parent === null || (typeof entry.parent === "string" && /^[a-f0-9]{12,64}$/.test(entry.parent)))
    && Array.isArray(entry.artifacts) && entry.artifacts.length > 0 && entry.artifacts.every(validArtifact)
    && typeof entry.status === "string" && STATUSES.has(entry.status);
}

/** Read the durable ledger. A missing file is an empty state; a corrupt one fails closed. */
export function readGenerationState(root: string): GenerationState {
  const file = stateFile(root);
  if (!fs.existsSync(file)) return emptyGenerationState();
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new GenerationStateError(`the generation ledger is unreadable; inspect ${file} before running again`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GenerationStateError("the generation ledger is not an object");
  const value = parsed as Partial<GenerationState>;
  if (value.version !== GENERATION_STATE_VERSION || !Array.isArray(value.generations)) {
    throw new GenerationStateError("the generation ledger does not match the expected schema");
  }
  if (value.generations.some((entry) => !validGeneration(entry))) {
    throw new GenerationStateError("the generation ledger contains an invalid entry; inspect it before running again");
  }
  if (!(value.active === null || (typeof value.active === "string" && /^[a-f0-9]{12,64}$/.test(value.active)))) {
    throw new GenerationStateError("the generation ledger has an invalid active pointer");
  }
  if (!isCount(value.confirmationAttempts)) throw new GenerationStateError("the generation ledger has an invalid confirmation-attempt counter");
  const max = value.maxConfirmationAttempts;
  if (!isCount(max) || max < 1) throw new GenerationStateError("the generation ledger has an invalid confirmation-attempt allowance");
  if (value.confirmationAttempts > max) throw new GenerationStateError("the generation ledger spends more confirmation attempts than it allows");
  return {
    version: GENERATION_STATE_VERSION,
    active: value.active,
    generations: value.generations,
    confirmationAttempts: value.confirmationAttempts,
    maxConfirmationAttempts: max,
  };
}

export function writeGenerationState(root: string, state: GenerationState): void {
  writeFileAtomic(stateFile(root), `${JSON.stringify(state, null, 2)}\n`, true);
}

/**
 * Stage a challenger against the current champion. Staging records only what was
 * built; it neither activates it nor spends a confirmation attempt.
 */
export function registerChallenger(root: string, options: { label: string; artifacts: GenerationArtifact[]; now?: Date }): Generation {
  if (typeof options.label !== "string" || !options.label.trim()) throw new GenerationStateError("a challenger needs a label");
  assertGuardRailsIntact(options.artifacts);
  const state = readGenerationState(root);
  const id = generationId(options.artifacts);
  if (state.generations.some((entry) => entry.id === id)) {
    throw new GenerationStateError(`this challenger is already registered: ${id}`);
  }
  const champion = state.generations.find((entry) => entry.status === "champion") ?? null;
  const challenger: Generation = {
    id,
    label: options.label.trim().slice(0, 200),
    createdAt: (options.now ?? new Date()).toISOString(),
    parent: champion?.id ?? null,
    artifacts: [...options.artifacts],
    status: "challenger",
  };
  writeGenerationState(root, { ...state, generations: [...state.generations, challenger] });
  return challenger;
}

/**
 * The promotion rule. Every requirement is decisive, and the reasons name the
 * measurement that failed so a retained champion is an explained outcome.
 */
export function decidePromotion(evidence: PromotionEvidence): PromotionDecision {
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  for (const key of ["championScore", "challengerScore", "minimumGain", "championCost", "challengerCost", "maxCostRatio"] as const) {
    if (!finite(evidence[key])) return { outcome: "inconclusive", reason: `${key} is not a finite measurement` };
  }
  for (const key of ["pairs", "minimumPairs", "championSafetyViolations", "challengerSafetyViolations", "challengerRegressions"] as const) {
    if (!isCount(evidence[key])) return { outcome: "inconclusive", reason: `${key} is not a measurement count` };
  }

  // Fixed constraints outrank any measured gain.
  if (evidence.challengerSafetyViolations > 0) {
    return { outcome: "reject", reason: `the challenger failed ${evidence.challengerSafetyViolations} fixed safety constraint(s)` };
  }
  if (evidence.championSafetyViolations > 0) {
    return { outcome: "reject", reason: `the champion already failed ${evidence.championSafetyViolations} fixed safety constraint(s), so this comparison is not a valid baseline` };
  }
  if (evidence.challengerRegressions > 0) {
    return { outcome: "reject", reason: `the challenger regressed ${evidence.challengerRegressions} fixed case(s)` };
  }
  if (evidence.pairs < evidence.minimumPairs) {
    return {
      outcome: "inconclusive",
      reason: `${evidence.pairs} paired comparison(s) is not enough to decide; ${evidence.minimumPairs} are required`,
    };
  }
  const gain = evidence.challengerScore - evidence.championScore;
  if (!(gain > 0) || !(gain >= evidence.minimumGain)) {
    const round = (value: number): string => value.toFixed(3);
    return {
      outcome: "reject",
      reason: `the challenger scored ${round(evidence.challengerScore)} against the champion's ${round(evidence.championScore)}, a gain of ${round(gain)} against a required ${round(evidence.minimumGain)}`,
    };
  }
  const ratio = evidence.championCost > 0 ? evidence.challengerCost / evidence.championCost : Number.POSITIVE_INFINITY;
  if (!(ratio <= evidence.maxCostRatio)) {
    const round = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : "infinite");
    return {
      outcome: "reject",
      reason: `the challenger costs ${round(ratio)}x the champion, above the ${round(evidence.maxCostRatio)}x ceiling`,
    };
  }
  return {
    outcome: "promote",
    reason: `the challenger gained ${gain.toFixed(3)} over ${evidence.pairs} paired comparison(s) at ${ratio.toFixed(2)}x the champion's cost`,
  };
}

function findGeneration(state: GenerationState, id: string): Generation {
  const generation = state.generations.find((entry) => entry.id === id);
  if (!generation) throw new GenerationStateError(`unknown generation: ${id}`);
  return generation;
}

function writeActiveMarker(root: string, id: string): void {
  fs.mkdirSync(stateDir(root), { recursive: true });
  writeFileAtomic(activeFile(root), `${JSON.stringify({ id })}\n`, true);
}

/**
 * Apply a decision to the durable ledger.
 *
 * Any decision spends one sealed confirmation attempt, because the split has now
 * been observed and cannot be used again as if it were fresh. Promotion swaps the
 * active pointer for the next process and retires the previous champion; the
 * running process keeps using the code it already loaded.
 */
export function applyPromotionDecision(root: string, challengerId: string, decision: PromotionDecision, maxAttempts?: number): GenerationState {
  const state = readGenerationState(root);
  // The challenger must exist before any decision is applied to it.
  findGeneration(state, challengerId);
  // The ledger's own allowance is the ceiling. A caller may ask for fewer attempts
  // (for example a per-run reservation) but can never widen what the ledger permits.
  const requested = maxAttempts ?? state.maxConfirmationAttempts;
  if (!isCount(requested) || requested < 1) throw new GenerationStateError("maxAttempts must be a positive integer");
  const limit = Math.min(requested, state.maxConfirmationAttempts);
  if (state.confirmationAttempts >= limit) {
    throw new GenerationStateError(`no sealed confirmation attempts remain (${state.confirmationAttempts}/${limit}); a fresh split must be authorised before another challenger is judged`);
  }
  const attempts = state.confirmationAttempts + 1;

  if (decision.outcome !== "promote") {
    const status: GenerationStatus = decision.outcome === "reject" ? "rejected" : "inconclusive";
    writeGenerationState(root, {
      ...state,
      confirmationAttempts: attempts,
      generations: state.generations.map((entry) => (entry.id === challengerId ? { ...entry, status } : entry)),
    });
    return readGenerationState(root);
  }

  const previousChampion = state.generations.find((entry) => entry.status === "champion" && entry.id !== challengerId) ?? null;
  const generations = state.generations.map((entry) => {
    if (entry.id === challengerId) return { ...entry, status: "champion" as GenerationStatus };
    if (previousChampion && entry.id === previousChampion.id) return { ...entry, status: "retired" as GenerationStatus };
    return entry;
  });
  const next: GenerationState = {
    ...state,
    active: challengerId,
    confirmationAttempts: attempts,
    generations,
  };
  writeGenerationState(root, next);
  writeActiveMarker(root, challengerId);
  return next;
}

/**
 * Return to the previous generation. The retired champion is restored as the
 * activation target; the rejected or superseded generation stays in the ledger.
 */
export function rollbackGeneration(root: string): { restored: string; previous: string | null } {
  const state = readGenerationState(root);
  const marker = readActiveMarker(root);
  const previous = marker?.id ?? state.active;
  if (!previous) throw new GenerationStateError("nothing is active, so there is nothing to roll back");
  const active = findGeneration(state, previous);
  const candidates = state.generations.filter((entry) => entry.id !== active.id && (entry.status === "champion" || entry.status === "retired"));
  const target = active.parent
    ? candidates.find((entry) => entry.id === active.parent) ?? null
    : candidates.find((entry) => entry.status === "champion") ?? candidates[candidates.length - 1] ?? null;
  if (!target) throw new GenerationStateError("no previous generation is recorded; the champion cannot be restored");

  writeGenerationState(root, {
    ...state,
    active: target.id,
    generations: state.generations.map((entry) => {
      if (entry.id === active.id) return { ...entry, status: "retired" as GenerationStatus };
      if (entry.id === target.id) return { ...entry, status: "champion" as GenerationStatus };
      return entry;
    }),
  });
  writeActiveMarker(root, target.id);
  return { restored: target.id, previous: active.id };
}

function readActiveMarker(root: string): { id: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(activeFile(root), "utf8")) as { id?: unknown } | null;
    if (!parsed || typeof parsed.id !== "string" || !/^[a-f0-9]{12,64}$/.test(parsed.id)) return null;
    return { id: parsed.id };
  } catch { return null; }
}

/**
 * The generation a *fresh process* should load. Reading is the only way a
 * promotion takes effect: nothing here mutates the code this process runs.
 */
export function loadActiveGeneration(root: string): { id: string; label: string; artifacts: GenerationArtifact[] } | null {
  const marker = readActiveMarker(root);
  if (!marker) return null;
  const state = readGenerationState(root);
  const generation = state.generations.find((entry) => entry.id === marker.id);
  if (!generation) return null;
  return { id: generation.id, label: generation.label, artifacts: generation.artifacts.map((artifact) => ({ ...artifact })) };
}
