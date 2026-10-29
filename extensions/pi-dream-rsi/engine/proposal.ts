import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { approvalIdentity, isCommitPolicy, projectFingerprint, normalizeRunContract, type CommitPolicy, type RunContract } from "./intake.ts";
import { withMeasurementHarness } from "./harness.ts";
import { defaultTask, isTaskTimeout, type AgentConfig, type TaskConfig } from "./task.ts";
import { bootstrapWritePlan, type LoopLimits } from "./loop.ts";
import { constitutionProtectedAssets } from "./scope.ts";

export interface LoopProposal {
  contract: RunContract;
  /** Reusable, unexpanded tool settings. Action and approval controls are separate. */
  settings: Record<string, any>;
  setup?: { mode: "generated-harness" | "custom-bootstrap"; writePolicy: "create-only" | "replace-authorized"; authorized: boolean; paths: string[]; language?: string };
  execution: { agent: AgentConfig; agent_timeout_ms: number; evaluator_timeout_ms: number | { policy: "qualified-workload-derived"; maximum_ms: number } };
  params: Record<string, any>;
  limits: LoopLimits;
  campaignDefaults: { maxCycles: number; maxAgentStarts: number; maxEvaluatorRuns: number; deadlineMs: number };
  taskDefaults: Partial<TaskConfig>;
  notices: string[];
}

const DEFAULT_COMMIT_BRANCH = "dream-rsi/improve";

function hasGitMetadata(projectDir: string): boolean {
  let current = path.resolve(projectDir);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

/** Resolve every entry path without writing state, running commands, or granting approval. */
export function resolveLoopProposal(raw: Record<string, any>, projectDir: string, prior?: RunContract, allowedKeys?: readonly string[]): LoopProposal {
  if (allowedKeys) assertKeys(raw, allowedKeys, "loop settings");
  let params = structuredClone(raw);
  for (const key of ["consent", "include_logs", "approve_proposal"] as const) {
    if (params[key] !== undefined && typeof params[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  }
  if (params.replace_contract !== undefined && typeof params.replace_contract !== "boolean") throw new Error("replace_contract must be a boolean");
  if (params.auto_commit !== undefined && typeof params.auto_commit !== "boolean") throw new Error("auto_commit must be a boolean");
  if (params.commit_policy !== undefined && !isCommitPolicy(params.commit_policy)) {
    throw new Error("commit_policy must be commit-per-accepted-change, squash-per-campaign, or no-commit");
  }
  if (params.commit_policy !== undefined && params.auto_commit !== undefined
    && params.auto_commit !== (params.commit_policy !== "no-commit")) throw new Error("auto_commit conflicts with commit_policy");
  if (params.continuous !== undefined && typeof params.continuous !== "boolean") throw new Error("continuous must be a boolean");
  if (params.commit_branch !== undefined && (typeof params.commit_branch !== "string" || !params.commit_branch.trim() || params.commit_branch.length > 255)) throw new Error("commit_branch must be a non-empty local branch name of at most 255 characters");
  if (params.focus !== undefined && (typeof params.focus !== "string" || !params.focus.trim())) throw new Error("focus requires an explicit improvement goal (a non-empty sentence)");
  if (params.evaluator !== undefined) {
    if (!params.evaluator || typeof params.evaluator !== "object" || Array.isArray(params.evaluator)) throw new Error("evaluator must be an object");
    assertKeys(params.evaluator, ["argv", "output", "inputs"], "evaluator");
  }
  try { params = withMeasurementHarness(params, projectDir, prior); }
  catch (error) { throw new Error(`harness setup is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const readLimit = (key: string, fallback: number, maximum: number): number => {
    const value = params[key] === undefined ? fallback : params[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${key} must be an integer from 1 to ${maximum}`);
    return value;
  };
  const limits: LoopLimits = {
    maxCampaigns: readLimit("max_campaigns", prior?.budgets.maxCampaigns ?? 6, 64),
    maxAgentStarts: readLimit("max_agent_starts", prior?.budgets.maxAgentStarts ?? 72, 1000),
    maxEvaluatorRuns: readLimit("max_evaluator_runs", prior?.budgets.maxEvaluatorRuns ?? 200, 5000),
    deadlineMs: params.deadline_minutes === undefined && prior ? prior.budgets.deadlineMs : readLimit("deadline_minutes", 120, 720) * 60_000,
  };
  if (prior && (limits.maxCampaigns < prior.budgets.maxCampaigns || limits.maxAgentStarts < prior.budgets.maxAgentStarts
    || limits.maxEvaluatorRuns < prior.budgets.maxEvaluatorRuns || limits.deadlineMs < prior.budgets.deadlineMs)) {
    throw new Error("A saved contract exists. Budget replacement may only raise limits; it cannot reduce caps or reset accumulated spend.");
  }
  const evaluator = params.evaluator;
  if (evaluator !== undefined && (typeof (params.unit ?? prior?.outcome.unit) !== "string" || typeof (params.higher_is_better ?? prior?.outcome.higherIsBetter) !== "boolean")) {
    throw new Error("unit and higher_is_better are required when an evaluator is supplied.");
  }
  const list = (key: string, fallback: string[]): string[] => {
    const value = params[key];
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || !entry.trim())) throw new Error(`${key} must be an array of non-empty strings`);
    return value.map(entry => entry.trim());
  };
  const statement = params.focus ?? prior?.outcome.statement ?? "Reduce the wall-clock time of the project's declared workloads without changing their results";
  const changed = prior !== undefined && statement.trim() !== prior.outcome.statement;
  const notices: string[] = [];
  if (changed && params.proxy_justification === undefined && evaluator === undefined) {
    const dropped = [prior.outcome.evaluator ? "evaluator" : null, prior.outcome.proxyJustification ? "proxy justification" : null].filter(Boolean);
    if (dropped.length) notices.push(`The goal changed, so the previous ${dropped.join(" and ")} ${dropped.length > 1 ? "are" : "is"} not inherited. Supply the instrument for the new goal.`);
  }
  const falseAcceptBudget = params.false_accept_budget ?? prior?.budgets.falseAcceptBudget ?? 0.10;
  if (prior && falseAcceptBudget !== prior.budgets.falseAcceptBudget) throw new Error("A saved contract exists. Keep its false_accept_budget; replacement preserves the statistical budget.");
  const taskDefaults: Partial<TaskConfig> = {};
  if (params.agent_args !== undefined && (!Array.isArray(params.agent_args) || params.agent_args.some((arg: unknown) => typeof arg !== "string"))) throw new Error("agent_args must be an array of strings");
  if (params.agent_command !== undefined && (typeof params.agent_command !== "string" || !params.agent_command.trim())) throw new Error("agent_command must be a non-empty executable name");
  if (params.agent_command !== undefined || params.agent_args !== undefined) {
    taskDefaults.agent = { ...(prior?.agent ?? defaultTask().agent),
      ...(params.agent_command === undefined ? {} : { command: params.agent_command.trim() }),
      ...(params.agent_args === undefined ? {} : { args: params.agent_args }),
    };
  }
  for (const key of ["agent_timeout_ms", "evaluator_timeout_ms"] as const) {
    if (params[key] !== undefined) {
      if (!isTaskTimeout(params[key])) throw new Error(`${key} must be an integer from 1 through 2147483647 milliseconds`);
      taskDefaults[key] = params[key];
    }
  }
  if (params.evaluator_bootstrap !== undefined) {
    const setup = params.evaluator_bootstrap;
    if (!setup || typeof setup !== "object" || Array.isArray(setup)) throw new Error("evaluator_bootstrap must be an object");
    assertKeys(setup, ["authorized", "paths"], "evaluator_bootstrap");
    if (typeof setup.authorized !== "boolean" || !Array.isArray(setup.paths) || !setup.paths.length || setup.paths.length > 10 || setup.paths.some((entry: unknown) => typeof entry !== "string" || !entry.trim())) throw new Error("evaluator_bootstrap must set authorized and a non-empty exact paths array.");
    setup.paths = setup.paths.map((entry: string) => entry.replace(/\\/g, "/").replace(/^\.\//, ""));
    if (setup.paths.some((entry: string) => !entry || entry.startsWith("/") || /^[a-z]:/i.test(entry) || entry.includes("\0") || entry.split("/").some(part => !part || part === "." || part === "..")) || new Set(setup.paths).size !== setup.paths.length) throw new Error("evaluator_bootstrap.paths must contain unique normalized project-relative paths.");
  }
  const continuous = params.continuous ?? Boolean(prior?.continuation);
  if (!continuous && (params.plateau_campaigns !== undefined || params.minimum_campaign_interval_seconds !== undefined
    || params.agent_starts_per_hour !== undefined || params.evaluator_runs_per_hour !== undefined)) {
    throw new Error("continuous-mode limits require continuous: true");
  }
  const continuation = continuous ? {
    plateauCampaigns: readLimit("plateau_campaigns", prior?.continuation?.plateauCampaigns ?? 3, 64),
    minimumCampaignIntervalMs: readLimit("minimum_campaign_interval_seconds", prior?.continuation ? Math.ceil(prior.continuation.minimumCampaignIntervalMs / 1000) : 60, 86_400) * 1000,
    agentStartsPerHour: readLimit("agent_starts_per_hour", prior?.continuation?.agentStartsPerHour ?? 36, 10_000),
    evaluatorRunsPerHour: readLimit("evaluator_runs_per_hour", prior?.continuation?.evaluatorRunsPerHour ?? 96, 10_000),
  } : undefined;
  const inheritedCommitPolicy = prior?.git?.commitPolicy;
  const commitPolicy: CommitPolicy = params.commit_policy
    ?? (params.auto_commit === undefined ? inheritedCommitPolicy : params.auto_commit ? "commit-per-accepted-change" : "no-commit")
    ?? ((prior?.git?.autoCommit ?? (!prior && hasGitMetadata(projectDir))) ? "commit-per-accepted-change" : "no-commit");
  const gitPolicy = params.auto_commit !== undefined || params.commit_policy !== undefined || params.commit_branch !== undefined || prior?.git || !prior
    ? {
      autoCommit: commitPolicy !== "no-commit",
      branch: (params.commit_branch ?? prior?.git?.branch ?? DEFAULT_COMMIT_BRANCH).trim(),
      ...(params.commit_policy !== undefined || inheritedCommitPolicy ? { commitPolicy } : {}),
    }
    : undefined;
  if (gitPolicy?.autoCommit && !hasGitMetadata(projectDir)) throw new Error("auto_commit requires a project inside an existing Git working tree");
  if (gitPolicy?.autoCommit && params.evaluator_bootstrap?.authorized) {
    throw new Error("auto_commit cannot be combined with evaluator bootstrap in v1 because setup writes are not campaign patches; set auto_commit: false or create and qualify setup files before enabling auto-commit");
  }
  const protectedAssets = [...new Set([...list("protected_assets", prior?.scope.protectedAssets ?? []), ...constitutionProtectedAssets(projectDir)])];
  const contract = normalizeRunContract({
    version: 1,
    outcome: {
      statement, unit: params.unit === undefined ? prior?.outcome.unit ?? "ms" : params.unit,
      higherIsBetter: params.higher_is_better === undefined ? prior?.outcome.higherIsBetter ?? false : params.higher_is_better,
      minimumUsefulGain: params.minimum_gain === undefined ? prior?.outcome.minimumUsefulGain ?? "5%" : params.minimum_gain,
      ...(!changed && prior?.outcome.proxyJustification ? { proxyJustification: prior.outcome.proxyJustification } : {}),
      ...(!changed && prior?.outcome.evaluator ? { evaluator: prior.outcome.evaluator } : {}),
      ...(params.proxy_justification === undefined ? {} : { proxyJustification: params.proxy_justification }),
      ...(evaluator === undefined ? {} : { evaluator }),
    },
    preserved: { gates: list("gates", prior?.preserved.gates ?? []) },
    scope: { roots: list("scope_roots", prior?.scope.roots ?? []), protectedAssets },
    execution: { consent: params.consent === true, envAllowlist: list("env_allowlist", prior?.execution.envAllowlist ?? []), allowedCommandCategories: list("command_categories", prior?.execution.allowedCommandCategories ?? ["test", "benchmark", "build", "custom"]) },
    budgets: { ...limits, falseAcceptBudget },
    ...(gitPolicy ? { git: gitPolicy } : {}),
    ...(continuation ? { continuation } : {}),
    ...(taskDefaults.agent || prior?.agent ? { agent: taskDefaults.agent ?? prior?.agent } : {}),
  });
  if (params.evaluator_bootstrap?.authorized) {
    const { checks } = bootstrapWritePlan(contract, params.evaluator_bootstrap.paths);
    if (checks.length > 0) throw new Error(checks.map((check) => `${check.reason} Next step: ${check.remedy}`).join(" "));
  }
  const defaults = defaultTask();
  const setup: LoopProposal["setup"] = params.evaluator_bootstrap === undefined ? undefined : {
    mode: params.setup_harness === true ? "generated-harness" : "custom-bootstrap",
    writePolicy: params.setup_harness === true ? "create-only" : "replace-authorized",
    authorized: params.evaluator_bootstrap.authorized, paths: [...params.evaluator_bootstrap.paths],
    ...(params.setup_harness === true ? { language: params.harness_language } : {}),
  };
  const execution = { agent: taskDefaults.agent ?? contract.agent ?? defaults.agent,
    agent_timeout_ms: taskDefaults.agent_timeout_ms ?? defaults.agent_timeout_ms,
    evaluator_timeout_ms: taskDefaults.evaluator_timeout_ms ?? { policy: "qualified-workload-derived" as const, maximum_ms: 3_605_000 } };
  const settings = structuredClone(raw);
  for (const key of ["action", "consent", "preparation_id", "proposal_id", "approve_proposal", "replace_contract"]) delete settings[key];
  return { contract, settings, params, limits, taskDefaults, notices, setup, execution,
    campaignDefaults: { maxCycles: 2, maxAgentStarts: 18, maxEvaluatorRuns: 48, deadlineMs: 60 * 60 * 1000 } };
}

/** Display the executable proposal as well as the persisted contract; this is not approval. */
export function proposalReview(proposal: LoopProposal): string {
  return JSON.stringify({ settings: proposal.settings, contract: proposal.contract, setup: proposal.setup ?? null,
    execution: proposal.execution,
    evaluator_credentials: "Use env_allowlist to approve evaluator credentials. Values supplied through this allowlist are redacted from captured process output before it is persisted; evaluator code must not print, return, or otherwise disclose credentials.",
    session_logs: proposal.params.include_logs !== false }, null, 2);
}

/** Bind review to exact semantics and source. A digest identifies a proposal; it grants no authority. */
export function proposalIdentity(projectDir: string, proposal: LoopProposal, prior?: RunContract): string {
  const contract = { ...proposal.contract, execution: { ...proposal.contract.execution, consent: false } };
  return crypto.createHash("sha256").update(JSON.stringify({
    project: projectDir, source: projectFingerprint(projectDir),
    prior: prior ? approvalIdentity(prior) : null, contract: approvalIdentity(contract),
    setup: proposal.setup ?? null, execution: proposal.execution,
    logs: proposal.params.include_logs !== false,
  })).digest("hex");
}
