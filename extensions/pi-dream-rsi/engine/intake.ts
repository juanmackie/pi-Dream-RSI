/**
 * The approved run contract.
 *
 * One project, one outcome, one set of permissions, one durable budget. The
 * contract is approved once, then the loop works inside it unattended. It exists
 * so that no autonomous step can widen its own objective, scope, permissions or
 * spend: discovery, metric authoring, instruments and candidates all have to fit
 * an already-approved boundary.
 *
 * Trusted-local means the operator accepted that discovered repository code runs
 * as a host process with host access. It is a risk acceptance, not a sandbox.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentConfig } from "./task.ts";

/** What kind of command a repository declares; the contract lists the categories it allows. */
export const COMMAND_CATEGORIES = ["test", "benchmark", "build", "custom"] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export const CONTRACT_VERSION = 1;

/** Directories never walked for the approval fingerprint. */
const FINGERPRINT_SKIP = new Set([
  ".git", ".dream-rsi", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", "target", ".gradle", "dist", "build", ".next", ".turbo",
]);
const FINGERPRINT_MAX_FILES = 4000;
const FINGERPRINT_MAX_BYTES = 32 * 1024 * 1024;
/** A file larger than this contributes its size and a digest, not a full read into the walk. */
const FINGERPRINT_LARGE_FILE = 4 * 1024 * 1024;

export type MinimumGain = number | `${number}%`;

export interface RunContractOutcome {
  /** What the project should measurably improve, in one sentence. */
  statement: string;
  /** Unit of the primary metric, for reading and reporting. */
  unit: string;
  higherIsBetter: boolean;
  /** Smallest change that is worth applying; a number is absolute, `"10%"` is relative. */
  minimumUsefulGain: MinimumGain;
  /**
   * When the scored metric is a proxy for the stated outcome, why it is a valid
   * one. Required for a proxy, omitted for the primary outcome.
   */
  proxyJustification?: string | null;
}

export interface RunContract {
  version: 1;
  outcome: RunContractOutcome;
  preserved: {
    /** Commands that must keep passing; the loop may never remove or weaken them. */
    gates: string[];
  };
  scope: {
    /** Project-relative roots a candidate may edit. Empty means "the whole workspace". */
    roots: string[];
    /** Project-relative files or directories a candidate may never change. */
    protectedAssets: string[];
  };
  execution: {
    mode: "trusted-local";
    /** Explicit acceptance that discovered repository code runs on this host. */
    consent: boolean;
    /** Environment variables passed to probes and instruments; everything else is withheld. */
    envAllowlist: string[];
    allowedCommandCategories: CommandCategory[];
  };
  models: {
    providers: string[];
  };
  budgets: {
    maxCampaigns: number;
    maxAgentStarts: number;
    maxEvaluatorRuns: number;
    deadlineMs: number;
    /** Loop-level rare-event allowance for promotions, allocated across the whole run. */
    falseAcceptBudget: number;
    /** Reserved sub-allowance for bounded optimizer (self-improvement) trials. */
    optimizerTrials?: number;
  };
  /** Candidate agent; null resolves the active session model at call time. */
  agent?: AgentConfig | null;
}

/** Result of approving a contract against one concrete project directory. */
export interface ApprovedContract {
  contract: RunContract;
  /** Bounded digest of the workspace at approval time. */
  fingerprint: string;
  approvedAt: string;
}

/** The contract is not honoured; the loop maps this to the `not-approved` stop reason. */
export class ContractNotApprovedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "ContractNotApprovedError";
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRelative(value: string): boolean {
  if (!value.trim() || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  if (path.isAbsolute(value) || /^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split("/").some((part) => part === ".." || part === ".");
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isMinimumGain(value: unknown): value is MinimumGain {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  if (typeof value !== "string") return false;
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (!match) return false;
  const percent = Number(match[1]);
  return Number.isFinite(percent) && percent >= 0 && percent < 100;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== "string" || !entry.trim())) return null;
  return value as string[];
}

/**
 * Validate untrusted contract content. Returns human-readable errors; an empty
 * array means the shape is acceptable.
 */
export function validateRunContract(raw: unknown): string[] {
  if (!isRecord(raw)) return ["run contract must be an object"];
  const errors: string[] = [];
  if (raw.version !== CONTRACT_VERSION) errors.push(`run contract version must be ${CONTRACT_VERSION}`);

  const outcome = raw.outcome;
  if (!isRecord(outcome)) errors.push("outcome must be an object");
  else {
    if (typeof outcome.statement !== "string" || !outcome.statement.trim()) errors.push("outcome.statement must be a non-empty sentence");
    if (typeof outcome.unit !== "string" || !outcome.unit.trim()) errors.push("outcome.unit must be a non-empty string");
    if (typeof outcome.higherIsBetter !== "boolean") errors.push("outcome.higherIsBetter must be explicitly true or false");
    if (!isMinimumGain(outcome.minimumUsefulGain)) errors.push('outcome.minimumUsefulGain must be a non-negative number or a percentage such as "10%"');
    if (outcome.proxyJustification !== undefined && outcome.proxyJustification !== null
      && (typeof outcome.proxyJustification !== "string" || !outcome.proxyJustification.trim())) {
      errors.push("outcome.proxyJustification must be a non-empty string when present");
    }
  }

  const preserved = raw.preserved;
  if (!isRecord(preserved)) errors.push("preserved must be an object");
  else if (stringList(preserved.gates) === null) errors.push("preserved.gates must be an array of non-empty command strings");

  const scope = raw.scope;
  if (!isRecord(scope)) errors.push("scope must be an object");
  else {
    const roots = stringList(scope.roots);
    if (roots === null || roots.some((root) => !safeRelative(root) && root !== ".")) errors.push("scope.roots must be project-relative non-empty paths");
    const protectedAssets = stringList(scope.protectedAssets);
    if (protectedAssets === null || protectedAssets.some((asset) => !safeRelative(asset))) {
      errors.push("scope.protectedAssets must be project-relative non-empty paths");
    }
  }

  const execution = raw.execution;
  if (!isRecord(execution)) errors.push("execution must be an object");
  else {
    if (execution.mode !== "trusted-local") errors.push('execution.mode must be "trusted-local"');
    if (typeof execution.consent !== "boolean") errors.push("execution.consent must be explicitly true or false");
    if (stringList(execution.envAllowlist) === null) errors.push("execution.envAllowlist must be an array of non-empty variable names");
    const categories = stringList(execution.allowedCommandCategories);
    if (categories === null || categories.length === 0) errors.push("execution.allowedCommandCategories must be a non-empty array");
    else {
      const unknown = categories.filter((category) => !COMMAND_CATEGORIES.includes(category as CommandCategory));
      if (unknown.length > 0) errors.push(`execution.allowedCommandCategories has unknown categories: ${unknown.join(", ")}`);
    }
  }

  const models = raw.models;
  if (!isRecord(models)) errors.push("models must be an object");
  else if (stringList(models.providers) === null || (models.providers as string[]).length === 0) errors.push("models.providers must be a non-empty array of provider names");

  const budgets = raw.budgets;
  if (!isRecord(budgets)) errors.push("budgets must be an object");
  else {
    for (const key of ["maxCampaigns", "maxAgentStarts", "maxEvaluatorRuns"] as const) {
      if (!positiveInteger(budgets[key])) errors.push(`budgets.${key} must be a positive integer`);
    }
    if (!positiveInteger(budgets.deadlineMs)) errors.push("budgets.deadlineMs must be a positive integer");
    if (typeof budgets.falseAcceptBudget !== "number" || !Number.isFinite(budgets.falseAcceptBudget)
      || budgets.falseAcceptBudget <= 0 || budgets.falseAcceptBudget >= 0.5) {
      errors.push("budgets.falseAcceptBudget must be a finite number greater than 0 and below 0.5");
    }
    if (budgets.optimizerTrials !== undefined && !positiveInteger(budgets.optimizerTrials)) {
      errors.push("budgets.optimizerTrials must be a positive integer when present");
    }
  }

  if (raw.agent !== undefined && raw.agent !== null) {
    const agent = raw.agent;
    if (!isRecord(agent)) errors.push("agent must be an object when present");
    else {
      if (typeof agent.command !== "string" || !agent.command.trim()) errors.push("agent.command must be a non-empty executable name");
      if (!Array.isArray(agent.args) || agent.args.some((arg) => typeof arg !== "string")) errors.push("agent.args must be an array of strings");
      if (agent.prompt_via !== "stdin" && agent.prompt_via !== "arg") errors.push('agent.prompt_via must be "stdin" or "arg"');
    }
  }

  return errors;
}

/** Validate and freeze a contract. Throws one error listing every rejection. */
export function normalizeRunContract(raw: unknown): RunContract {
  const errors = validateRunContract(raw);
  if (errors.length > 0) throw new Error(`run contract is not valid: ${errors.join("; ")}`);
  const value = raw as RunContract;
  return {
    version: CONTRACT_VERSION,
    outcome: {
      statement: value.outcome.statement.trim(),
      unit: value.outcome.unit.trim(),
      higherIsBetter: value.outcome.higherIsBetter,
      minimumUsefulGain: value.outcome.minimumUsefulGain,
      ...(value.outcome.proxyJustification ? { proxyJustification: value.outcome.proxyJustification.trim() } : {}),
    },
    preserved: { gates: [...value.preserved.gates] },
    scope: { roots: [...value.scope.roots], protectedAssets: [...value.scope.protectedAssets] },
    execution: {
      mode: "trusted-local",
      consent: value.execution.consent,
      envAllowlist: [...value.execution.envAllowlist],
      allowedCommandCategories: [...value.execution.allowedCommandCategories],
    },
    models: { providers: [...value.models.providers] },
    budgets: {
      maxCampaigns: value.budgets.maxCampaigns,
      maxAgentStarts: value.budgets.maxAgentStarts,
      maxEvaluatorRuns: value.budgets.maxEvaluatorRuns,
      deadlineMs: value.budgets.deadlineMs,
      falseAcceptBudget: value.budgets.falseAcceptBudget,
      ...(value.budgets.optimizerTrials === undefined ? {} : { optimizerTrials: value.budgets.optimizerTrials }),
    },
    ...(value.agent ? { agent: { ...value.agent, args: [...value.agent.args] } } : {}),
  };
}

/**
 * Bounded, order-independent digest of the workspace contents.
 *
 * Paths, sizes and per-file digests; large files contribute a digest without a
 * full in-memory copy. Generated and dependency directories are skipped, so an
 * install or a build does not by itself invalidate an approved baseline.
 */
export function projectFingerprint(projectDir: string): string {
  const root = fs.realpathSync(projectDir);
  const hash = crypto.createHash("sha256");
  const entries: string[] = [];
  let files = 0;
  let bytes = 0;
  const walk = (directory: string, prefix: string): void => {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files >= FINGERPRINT_MAX_FILES || bytes >= FINGERPRINT_MAX_BYTES) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && FINGERPRINT_SKIP.has(entry.name.toLowerCase())) continue;
      if (entry.isDirectory()) { walk(path.join(directory, entry.name), relative); continue; }
      if (!entry.isFile()) continue;
      const absolute = path.join(directory, entry.name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(absolute); } catch { continue; }
      files += 1;
      bytes += stat.size;
      let digest: string;
      if (stat.size > FINGERPRINT_LARGE_FILE) {
        digest = crypto.createHash("sha256").update(`${stat.size}`).digest("hex");
      } else {
        try { digest = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"); }
        catch { digest = "unreadable"; }
      }
      entries.push(`${relative}\u0000${stat.size}\u0000${digest}`);
    }
  };
  walk(root, "");
  for (const line of entries.sort()) hash.update(`${line}\n`);
  return hash.digest("hex");
}

/**
 * Approve a contract for one project. Refuses without trusted-local consent,
 * with a clear reason, before any probe or agent can run.
 */
export function approveRunContract(projectDir: string, contract: RunContract): ApprovedContract {
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new ContractNotApprovedError(`project directory does not exist: ${projectDir}`);
  }
  if (contract.execution.mode !== "trusted-local") {
    throw new ContractNotApprovedError(`unsupported execution mode: ${contract.execution.mode}`);
  }
  if (!contract.execution.consent) {
    throw new ContractNotApprovedError(
      "trusted-local execution was not approved for this repository; discovered commands run on this host with host access, so the operator must approve that risk once before any probe runs",
    );
  }
  if (contract.execution.allowedCommandCategories.length === 0) {
    throw new ContractNotApprovedError("no command categories are approved, so no workload can be run");
  }
  return { contract, fingerprint: projectFingerprint(projectDir), approvedAt: new Date().toISOString() };
}

/**
 * Environment for probes, instruments and gates: only allowlisted keys, taken
 * from the current process. Everything else (credentials, tokens, session
 * identity, provider keys) is withheld.
 */
export function restrictedEnvironment(contract: RunContract, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  // Path resolution and the Windows command interpreter are needed to start any
  // process at all, and neither carries a secret. Without them an empty allowlist
  // makes every probe fail with "command not found" on a machine whose runtime is
  // not in the shell's default search path (for example a CI runner).
  for (const key of RUNTIME_ENV_BASELINE) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  for (const key of contract.execution.envAllowlist) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/**
 * Non-secret variables a child process needs to start on each platform. Everything
 * else — provider keys, tokens, credentials, session identity — is withheld.
 */
const RUNTIME_ENV_BASELINE = process.platform === "win32"
  ? ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE"]
  : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"];

/** True when `relative` stays inside one of the contract's editable roots. */
export function withinApprovedScope(contract: RunContract, relative: string): boolean {
  const candidate = relative.replace(/\\/g, "/");
  const roots = contract.scope.roots.map((root) => root.replace(/\\/g, "/")).filter((root) => root !== "" && root !== ".");
  if (roots.length === 0) return true;
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

/** True when `relative` names a protected asset or lives inside one. */
export function isProtectedAsset(contract: RunContract, relative: string): boolean {
  const candidate = relative.replace(/\\/g, "/");
  return contract.scope.protectedAssets.some((asset) => {
    const normalized = asset.replace(/\\/g, "/").replace(/\/$/, "");
    return candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}

/**
 * Identity of a contract for experiment comparison. Two experiments are only
 * comparable when this matches: it covers the objective, the preserved
 * behaviour, the scope and the command categories, but not the consent flag or
 * the deadline, which do not change what a measurement means.
 */
export function contractIdentity(contract: RunContract): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    outcome: contract.outcome,
    gates: contract.preserved.gates,
    scope: contract.scope,
    categories: contract.execution.allowedCommandCategories,
    providers: contract.models.providers,
    budgets: {
      maxCampaigns: contract.budgets.maxCampaigns,
      maxAgentStarts: contract.budgets.maxAgentStarts,
      maxEvaluatorRuns: contract.budgets.maxEvaluatorRuns,
    },
  })).digest("hex").slice(0, 16);
}

/** Durable contract location under the loop's state root. */
export function contractFile(loopRoot: string): string {
  return path.join(loopRoot, "contract.json");
}

export interface StoredContract {
  version: 1;
  fingerprint: string;
  approvedAt: string;
  contract: RunContract;
}

/** Read a stored contract; a corrupt or legacy file is reported, never silently replaced. */
export function readStoredContract(loopRoot: string): StoredContract | null {
  const file = contractFile(loopRoot);
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("the stored run contract is unreadable; inspect it before starting another run"); }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.fingerprint !== "string"
    || typeof parsed.approvedAt !== "string" || !isRecord(parsed.contract)) {
    throw new Error("the stored run contract does not match the expected schema; inspect it before starting another run");
  }
  const errors = validateRunContract(parsed.contract);
  if (errors.length > 0) throw new Error(`the stored run contract is invalid: ${errors.join("; ")}`);
  return { version: 1, fingerprint: parsed.fingerprint, approvedAt: parsed.approvedAt, contract: normalizeRunContract(parsed.contract) };
}
