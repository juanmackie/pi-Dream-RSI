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
/** Only research-policy artifacts may vary; test, evaluator, package, and runner files stay fixed. */
const EDITABLE_GENERATION_ARTIFACTS: ReadonlySet<string> = new Set([
  "extensions/pi-dream-rsi/policy/method.ts",
  "prompts/discovery-agent.md",
  "prompts/policy-improvement.md",
  "prompts/research-org.md",
]);

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

export interface ActiveGeneration {
  id: string;
  label: string;
  artifacts: GenerationArtifact[];
  /** UTF-8 files verified against the immutable generation snapshot. */
  files: Record<string, string>;
}

export interface GenerationState {
  version: 1;
  active: string | null;
  generations: Generation[];
  /** Sealed confirmation attempts already spent. */
  confirmationAttempts: number;
  /** Attempts authorised in total; a spent split is never renewed implicitly. */
  maxConfirmationAttempts: number;
  /** Hashes of signed evaluator receipts already consumed; a sealed split is single-use. */
  confirmationReceipts: string[];
  /** Opaque identities of consumed evaluator splits; a split cannot judge two candidates. */
  confirmationSplits: string[];
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

/** Signed report produced by an evaluator outside the candidate process. */
export interface IndependentConfirmationReceipt {
  version: 2;
  challengerId: string;
  candidateGenerationId: string;
  splitId: string;
  evaluatorId: string;
  evaluatedAt: string;
  freshProcessReproduced: boolean;
  hiddenSuiteRegressions: number;
  canaryManifestDigest: string;
  canaries: SeededCanaryResult[];
  evidence: PromotionEvidence;
  signature: string;
}

/** Public commitment and result for one canary; the seed itself stays evaluator-side. */
export interface SeededCanaryResult {
  id: string;
  seedCommitment: string;
  detected: boolean;
}

/** Trust comes from the host/operator configuration, never the candidate repository. */
export interface ConfirmationAuthority {
  evaluatorId: string;
  publicKey: string;
  /** Host-pinned digest of the complete canary id/seed-commitment manifest. */
  canaryManifestDigest: string;
}

export interface ConfirmationApplication {
  state: GenerationState;
  decision: PromotionDecision;
  receiptHash: string;
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
  return { version: GENERATION_STATE_VERSION, active: null, generations: [], confirmationAttempts: 0, maxConfirmationAttempts, confirmationReceipts: [], confirmationSplits: [] };
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

function artifactStoreDir(root: string, id: string): string {
  return path.join(stateDir(root), "artifacts", id);
}

function artifactStorePath(root: string, id: string, relative: string): string {
  return path.join(artifactStoreDir(root, id), ...normalized(relative).split("/"));
}

function assertNoSymlinkPath(root: string, relative: string): string {
  const absoluteRoot = fs.realpathSync(root);
  let current = absoluteRoot;
  for (const part of normalized(relative).split("/")) {
    current = path.join(current, part);
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) throw new GenerationStateError("generation artifacts may not traverse symlinks: " + relative);
  }
  const resolved = fs.realpathSync(current);
  const fromRoot = path.relative(absoluteRoot, resolved);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(".." + path.sep) || path.isAbsolute(fromRoot)) {
    throw new GenerationStateError("generation artifact escaped its source root: " + relative);
  }
  return resolved;
}

/** Snapshot allowlisted source files into the immutable, content-addressed generation store. */
export function archiveGenerationArtifacts(root: string, artifactRoot: string, artifacts: GenerationArtifact[]): void {
  assertGuardRailsIntact(artifacts);
  const actual = digestArtifacts(artifactRoot, artifacts.map((artifact) => artifact.path));
  if (generationId(actual) !== generationId(artifacts)) throw new GenerationStateError("artifact source contents do not match the declared generation digest");
  const id = generationId(artifacts);
  const destination = artifactStoreDir(root, id);
  if (fs.existsSync(destination)) throw new GenerationStateError("generation artifact snapshot already exists: " + id);
  fs.mkdirSync(destination, { recursive: true });
  try {
    for (const artifact of artifacts) {
      const source = assertNoSymlinkPath(artifactRoot, artifact.path);
      if (!fs.statSync(source).isFile()) throw new GenerationStateError("generation artifact is not a regular file: " + artifact.path);
      const content = fs.readFileSync(source);
      const digest = crypto.createHash("sha256").update(content).digest("hex");
      if (digest !== artifact.sha256) throw new GenerationStateError("generation artifact changed during snapshot: " + artifact.path);
      const target = artifactStorePath(root, id, artifact.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, content.toString("utf8"), true);
    }
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function readStoredArtifact(root: string, generation: Generation, relative: string): string {
  assertGuardRailsIntact([{ path: relative, sha256: "0".repeat(64) }]);
  const artifact = generation.artifacts.find((entry) => normalized(entry.path) === normalized(relative));
  if (!artifact) throw new GenerationStateError("artifact is not recorded in generation " + generation.id + ": " + relative);
  const snapshotRoot = artifactStoreDir(root, generation.id);
  let content: Buffer;
  try {
    const safeFile = assertNoSymlinkPath(snapshotRoot, artifact.path);
    if (!fs.statSync(safeFile).isFile()) throw new Error("not a regular file");
    content = fs.readFileSync(safeFile);
  } catch {
    throw new GenerationStateError("the immutable generation snapshot is missing or unsafe: " + artifact.path);
  }
  const digest = crypto.createHash("sha256").update(content).digest("hex");
  if (digest !== artifact.sha256) throw new GenerationStateError("the immutable generation snapshot failed its digest check: " + artifact.path);
  return content.toString("utf8");
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
  for (const artifact of artifacts) {
    const relative = normalized(artifact.path);
    if (!EDITABLE_GENERATION_ARTIFACTS.has(relative)) {
      throw new GenerationStateError("a generation artifact is outside the editable research-policy allowlist: " + relative);
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
  const receipts = value.confirmationReceipts ?? [];
  if (!Array.isArray(receipts) || receipts.some((receipt) => typeof receipt !== "string" || !/^[a-f0-9]{64}$/.test(receipt)) || new Set(receipts).size !== receipts.length) {
    throw new GenerationStateError("the generation ledger has invalid confirmation receipt history");
  }
  const splits = value.confirmationSplits ?? [];
  if (!Array.isArray(splits) || splits.some((split) => typeof split !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(split)) || new Set(splits).size !== splits.length) {
    throw new GenerationStateError("the generation ledger has invalid confirmation split history");
  }
  return {
    version: GENERATION_STATE_VERSION,
    active: value.active,
    generations: value.generations,
    confirmationAttempts: value.confirmationAttempts,
    maxConfirmationAttempts: max,
    confirmationReceipts: receipts,
    confirmationSplits: splits,
  };
}

export function writeGenerationState(root: string, state: GenerationState): void {
  writeFileAtomic(stateFile(root), `${JSON.stringify(state, null, 2)}\n`, true);
}

/**
 * Stage a challenger against the current champion. Staging records only what was
 * built; it neither activates it nor spends a confirmation attempt.
 */
export function registerChallenger(root: string, options: { label: string; artifactRoot: string; artifacts: GenerationArtifact[]; now?: Date }): Generation {
  if (typeof options.label !== "string" || !options.label.trim()) throw new GenerationStateError("a challenger needs a label");
  assertGuardRailsIntact(options.artifacts);
  const state = readGenerationState(root);
  const id = generationId(options.artifacts);
  if (state.generations.some((entry) => entry.id === id)) {
    throw new GenerationStateError(`this challenger is already registered: ${id}`);
  }
  archiveGenerationArtifacts(root, options.artifactRoot, options.artifacts);
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
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(object[key])).join(",") + "}";
}

/** Derive a stable public id from a seed commitment without revealing the seed. */
export function seededCanaryId(seedCommitment: string): string {
  return crypto.createHash("sha256").update(`dream-rsi-canary-v1\0${seedCommitment}`).digest("hex");
}

/** Digest the complete public manifest; canary seeds remain in the evaluator's private store. */
export function seededCanaryManifestDigest(canaries: readonly Pick<SeededCanaryResult, "id" | "seedCommitment">[]): string {
  const manifest = canaries.map(({ id, seedCommitment }) => ({ id, seedCommitment })).sort((a, b) => a.id.localeCompare(b.id));
  return crypto.createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function confirmationSigningBytes(receipt: Omit<IndependentConfirmationReceipt, "signature">): Buffer {
  return Buffer.from(canonicalJson(receipt), "utf8");
}

function verifyConfirmationReceipt(
  receipt: IndependentConfirmationReceipt,
  challengerId: string,
  challenger: Generation,
  authority: ConfirmationAuthority,
): string {
  if (!authority || typeof authority.evaluatorId !== "string" || !authority.evaluatorId.trim()
    || typeof authority.publicKey !== "string" || !authority.publicKey.trim()
    || typeof authority.canaryManifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(authority.canaryManifestDigest)) {
    throw new GenerationStateError("a host-pinned confirmation authority is required");
  }
  if (!receipt || receipt.version !== 2 || receipt.challengerId !== challengerId || receipt.candidateGenerationId !== challenger.id) {
    throw new GenerationStateError("confirmation receipt does not identify this staged challenger");
  }
  if (challenger.id !== generationId(challenger.artifacts)) throw new GenerationStateError("staged challenger artifacts do not match their recorded identity");
  if (typeof receipt.splitId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(receipt.splitId)) {
    throw new GenerationStateError("confirmation receipt has an invalid hidden split identity");
  }
  if (typeof receipt.evaluatorId !== "string" || !receipt.evaluatorId || receipt.evaluatorId !== authority.evaluatorId) {
    throw new GenerationStateError("confirmation receipt evaluator is not trusted by this host");
  }
  if (typeof receipt.evaluatedAt !== "string" || !Number.isFinite(Date.parse(receipt.evaluatedAt))) {
    throw new GenerationStateError("confirmation receipt has an invalid evaluation timestamp");
  }
  if (typeof receipt.freshProcessReproduced !== "boolean" || !isCount(receipt.hiddenSuiteRegressions)
    || typeof receipt.canaryManifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.canaryManifestDigest)
    || !Array.isArray(receipt.canaries) || receipt.canaries.length < 1 || receipt.canaries.length > 256) {
    throw new GenerationStateError("confirmation receipt has invalid reproduction or oracle results");
  }
  const canaryIds = new Set<string>();
  for (const canary of receipt.canaries) {
    if (!canary || typeof canary !== "object" || typeof canary.id !== "string" || !/^[a-f0-9]{64}$/.test(canary.id)
      || typeof canary.seedCommitment !== "string" || !/^[a-f0-9]{64}$/.test(canary.seedCommitment) || canary.id !== seededCanaryId(canary.seedCommitment)
      || typeof canary.detected !== "boolean" || canaryIds.has(canary.id)) {
      throw new GenerationStateError("confirmation receipt has invalid or duplicate seeded canary evidence");
    }
    canaryIds.add(canary.id);
  }
  const receiptManifestDigest = seededCanaryManifestDigest(receipt.canaries);
  if (receipt.canaryManifestDigest !== authority.canaryManifestDigest || receiptManifestDigest !== authority.canaryManifestDigest) {
    throw new GenerationStateError("confirmation receipt does not match the host-pinned seeded canary manifest");
  }
  if (typeof receipt.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(receipt.signature)) {
    throw new GenerationStateError("confirmation receipt has no valid Ed25519 signature encoding");
  }
  let key: crypto.KeyObject;
  try { key = crypto.createPublicKey(authority.publicKey); }
  catch { throw new GenerationStateError("the configured confirmation authority public key is invalid"); }
  if (key.asymmetricKeyType !== "ed25519") throw new GenerationStateError("the confirmation authority key must be Ed25519");
  const { signature, ...payload } = receipt;
  let valid = false;
  try { valid = crypto.verify(null, confirmationSigningBytes(payload), key, Buffer.from(signature, "base64")); }
  catch { valid = false; }
  if (!valid) throw new GenerationStateError("confirmation receipt signature is invalid");
  return crypto.createHash("sha256").update(canonicalJson(receipt)).digest("hex");
}

export function applyConfirmationReceipt(
  root: string,
  challengerId: string,
  receipt: IndependentConfirmationReceipt,
  authority: ConfirmationAuthority,
  maxAttempts?: number,
): ConfirmationApplication {
  const state = readGenerationState(root);
  // A confirmation receipt applies once to a staged challenger. Replaying an old
  // decision against a champion, rejected candidate, or retired generation would
  // let stale evidence reactivate code without a new independent confirmation.
  const challenger = findGeneration(state, challengerId);
  if (challenger.status !== "challenger") {
    throw new GenerationStateError("confirmation receipts require a staged challenger; " + challengerId + " is " + challenger.status);
  }
  const receiptHash = verifyConfirmationReceipt(receipt, challengerId, challenger, authority);
  if (state.confirmationReceipts.includes(receiptHash)) throw new GenerationStateError("this independent confirmation receipt was already consumed");
  if (state.confirmationSplits.includes(receipt.splitId)) throw new GenerationStateError("this hidden confirmation split was already consumed");
  // The ledger's own allowance is the ceiling. A caller may ask for fewer attempts
  // (for example a per-run reservation) but can never widen what the ledger permits.
  const requested = maxAttempts ?? state.maxConfirmationAttempts;
  if (!isCount(requested) || requested < 1) throw new GenerationStateError("maxAttempts must be a positive integer");
  const limit = Math.min(requested, state.maxConfirmationAttempts);
  if (state.confirmationAttempts >= limit) {
    throw new GenerationStateError(`no sealed confirmation attempts remain (${state.confirmationAttempts}/${limit}); a fresh split must be authorised before another challenger is judged`);
  }
  const attempts = state.confirmationAttempts + 1;

  let decision: PromotionDecision;
  if (!receipt.freshProcessReproduced) {
    decision = { outcome: "reject", reason: "the independent evaluator could not reproduce the candidate in a fresh process" };
  } else if (receipt.hiddenSuiteRegressions > 0) {
    decision = { outcome: "reject", reason: "the hidden suite reported " + receipt.hiddenSuiteRegressions + " regression(s)" };
  } else if (receipt.canaries.some((canary) => !canary.detected)) {
    const detected = receipt.canaries.filter((canary) => canary.detected).length;
    decision = { outcome: "reject", reason: "the evaluator detected " + detected + "/" + receipt.canaries.length + " seeded canary cheat(s)" };
  } else if (!receipt.evidence || typeof receipt.evidence !== "object") {
    decision = { outcome: "inconclusive", reason: "the signed receipt is missing promotion measurements" };
  } else {
    decision = decidePromotion({ ...receipt.evidence,
      challengerRegressions: Math.max(isCount(receipt.evidence.challengerRegressions) ? receipt.evidence.challengerRegressions : 0, receipt.hiddenSuiteRegressions) });
  }

  if (decision.outcome !== "promote") {
    const status: GenerationStatus = decision.outcome === "reject" ? "rejected" : "inconclusive";
    const next: GenerationState = {
      ...state,
      confirmationAttempts: attempts,
      confirmationReceipts: [...state.confirmationReceipts, receiptHash],
      confirmationSplits: [...state.confirmationSplits, receipt.splitId],
      generations: state.generations.map((entry) => (entry.id === challengerId ? { ...entry, status } : entry)),
    };
    writeGenerationState(root, next);
    return { state: readGenerationState(root), decision, receiptHash };
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
    confirmationReceipts: [...state.confirmationReceipts, receiptHash],
    confirmationSplits: [...state.confirmationSplits, receipt.splitId],
    generations,
  };
  writeGenerationState(root, next);
  writeActiveMarker(root, challengerId);
  return { state: next, decision, receiptHash };
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
export function loadActiveGeneration(root: string): ActiveGeneration | null {
  const marker = readActiveMarker(root);
  if (!marker) return null;
  const state = readGenerationState(root);
  // The activation marker is a cache for the next process, not an authority of
  // its own. Require agreement with the durable ledger and a promoted status so
  // a stale, edited, or partially-written marker cannot load rejected code.
  if (state.active !== marker.id) return null;
  const generation = state.generations.find((entry) => entry.id === marker.id);
  if (!generation || generation.status !== "champion") return null;
  if (generation.id !== generationId(generation.artifacts)) {
    throw new GenerationStateError("the active generation artifact digest does not match its recorded identity");
  }
  assertGuardRailsIntact(generation.artifacts);
  const files: Record<string, string> = {};
  for (const artifact of generation.artifacts) files[artifact.path] = readStoredArtifact(root, generation, artifact.path);
  return { id: generation.id, label: generation.label, artifacts: generation.artifacts.map((artifact) => ({ ...artifact })), files };
}
