import * as fs from "node:fs";
import * as path from "node:path";
import { isCommitPolicy } from "./intake.ts";

/** Fields a settings file may not set: they are actions or approvals, not configuration. */
const FORBIDDEN_KEYS = new Set(["action", "consent", "replace_contract", "project_dir", "include_logs", "preparation_id", "proposal_id", "approve_proposal"]);
const MAX_CONFIG_BYTES = 64 * 1024;

/**
 * Load contract settings for the `/dream-rsi loop --config <file>` command.
 *
 * The command line can carry only a goal, which is not enough to declare an
 * evaluator, scope and gates. A small JSON file uses the same field names as the
 * `dream_rsi_loop` tool, so an assessment or handoff can propose settings that the
 * operator reviews and applies with the same validation and replacement approval.
 */
export function readLoopSettingsFile(file: string, cwd: string, allowedKeys: readonly string[]): Record<string, unknown> {
  const target = path.resolve(cwd, file);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); } catch { throw new Error(`settings file does not exist: ${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`settings file must be a regular file: ${file}`);
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`settings file exceeds ${MAX_CONFIG_BYTES} bytes: ${file}`);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(target, "utf8")); }
  catch { throw new Error(`settings file is not valid JSON: ${file}`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`settings file must contain one JSON object: ${file}`);
  let settings = parsed as Record<string, unknown>;
  // Assessment handoffs may use the persisted contract envelope rather than the
  // flat tool-parameter shape. Accept only its known version and explicitly map
  // settings; never import its execution consent or approval metadata.
  if (Object.hasOwn(settings, "contract") || Object.hasOwn(settings, "version")) {
    if (settings.version !== 1 || !isRecord(settings.contract)) {
      throw new Error("contract settings envelope must contain version: 1 and a contract object");
    }
    const envelopeUnknown = Object.keys(settings).filter((key) => !["version", "contract"].includes(key));
    if (envelopeUnknown.length > 0) throw new Error(`contract settings envelope has unknown keys: ${envelopeUnknown.join(", ")}`);
    settings = contractSettings(settings.contract);
  }
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(settings).filter((key) => !allowed.has(key) && !FORBIDDEN_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`settings file has unknown keys: ${unknown.join(", ")}. Allowed keys: ${[...allowed].sort().join(", ")}`);
  const forbidden = Object.keys(settings).filter((key) => FORBIDDEN_KEYS.has(key));
  if (forbidden.length > 0) throw new Error(`settings file cannot set ${forbidden.join(", ")}; consent and replacement approval stay explicit command actions`);
  return settings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], section: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`contract settings ${section} has unknown keys: ${unknown.join(", ")}`);
}

function contractSettings(contract: Record<string, unknown>): Record<string, unknown> {
  if (contract.version !== 1 || !isRecord(contract.outcome) || !isRecord(contract.scope) || !isRecord(contract.preserved)) {
    throw new Error("contract settings must contain version: 1, outcome, scope, and preserved objects");
  }
  assertKeys(contract, ["version", "outcome", "scope", "preserved", "execution", "budgets", "agent", "git", "continuation"], "contract");
  const outcome = contract.outcome;
  const scope = contract.scope;
  const preserved = contract.preserved;
  assertKeys(outcome, ["statement", "unit", "higherIsBetter", "minimumUsefulGain", "proxyJustification", "evaluator"], "outcome");
  assertKeys(scope, ["roots", "protectedAssets"], "scope");
  assertKeys(preserved, ["gates"], "preserved");
  const settings: Record<string, unknown> = {};
  const fields: Array<[string, unknown]> = [
    ["focus", outcome.statement], ["unit", outcome.unit], ["higher_is_better", outcome.higherIsBetter],
    ["minimum_gain", outcome.minimumUsefulGain], ["proxy_justification", outcome.proxyJustification],
    ["evaluator", outcome.evaluator], ["scope_roots", scope.roots], ["protected_assets", scope.protectedAssets],
    ["gates", preserved.gates],
  ];
  for (const [key, value] of fields) if (value !== undefined) settings[key] = value;
  if (contract.budgets !== undefined) {
    if (!isRecord(contract.budgets)) throw new Error("contract settings budgets must be an object");
    const budgets = contract.budgets;
    assertKeys(budgets, ["maxCampaigns", "maxAgentStarts", "maxEvaluatorRuns", "deadlineMs", "falseAcceptBudget"], "budgets");
    if (budgets.deadlineMs !== undefined && (typeof budgets.deadlineMs !== "number" || !Number.isSafeInteger(budgets.deadlineMs) || budgets.deadlineMs <= 0)) throw new Error("contract settings budgets.deadlineMs must be a positive integer");
    const budgetFields: Array<[string, unknown]> = [
      ["max_campaigns", budgets.maxCampaigns], ["max_agent_starts", budgets.maxAgentStarts],
      ["max_evaluator_runs", budgets.maxEvaluatorRuns], ["false_accept_budget", budgets.falseAcceptBudget],
      ["deadline_minutes", typeof budgets.deadlineMs === "number" ? budgets.deadlineMs / 60_000 : undefined],
    ];
    for (const [key, value] of budgetFields) if (value !== undefined) settings[key] = value;
  }
  if (contract.agent !== undefined && contract.agent !== null) {
    if (!isRecord(contract.agent)) throw new Error("contract settings agent must be an object");
    const agent = contract.agent;
    assertKeys(agent, ["command", "args", "model", "thinking", "prompt_via"], "agent");
    if ((agent.model !== undefined && agent.model !== null) || (agent.thinking !== undefined && agent.thinking !== null) || agent.prompt_via !== "stdin") {
      throw new Error("contract settings agent model/thinking overrides or non-stdin prompts cannot be represented by flat loop settings; supply supported agent_command/agent_args explicitly instead");
    }
    settings.agent_command = agent.command;
    settings.agent_args = agent.args;
  }
  if (contract.continuation !== undefined) {
    if (!isRecord(contract.continuation)) throw new Error("contract settings continuation must be an object");
    const continuation = contract.continuation;
    assertKeys(continuation, ["plateauCampaigns", "minimumCampaignIntervalMs", "agentStartsPerHour", "evaluatorRunsPerHour"], "continuation");
    if (typeof continuation.plateauCampaigns !== "number" || !Number.isSafeInteger(continuation.plateauCampaigns)
      || typeof continuation.minimumCampaignIntervalMs !== "number" || !Number.isSafeInteger(continuation.minimumCampaignIntervalMs)
      || (continuation.agentStartsPerHour !== undefined && (typeof continuation.agentStartsPerHour !== "number" || !Number.isSafeInteger(continuation.agentStartsPerHour)))
      || (continuation.evaluatorRunsPerHour !== undefined && (typeof continuation.evaluatorRunsPerHour !== "number" || !Number.isSafeInteger(continuation.evaluatorRunsPerHour)))) {
      throw new Error("contract settings continuation must contain integer plateau and interval values");
    }
    settings.continuous = true;
    settings.plateau_campaigns = continuation.plateauCampaigns;
    settings.minimum_campaign_interval_seconds = continuation.minimumCampaignIntervalMs / 1000;
    if (continuation.agentStartsPerHour !== undefined) settings.agent_starts_per_hour = continuation.agentStartsPerHour;
    if (continuation.evaluatorRunsPerHour !== undefined) settings.evaluator_runs_per_hour = continuation.evaluatorRunsPerHour;
  }
  if (contract.git !== undefined) {
    if (!isRecord(contract.git)) throw new Error("contract settings git must be an object");
    const git = contract.git;
    assertKeys(git, ["autoCommit", "branch", "commitPolicy"], "git");
    if (typeof git.autoCommit !== "boolean" || typeof git.branch !== "string" || !git.branch.trim()) throw new Error("contract settings git must set boolean autoCommit and a non-empty branch");
    if (git.commitPolicy !== undefined && !isCommitPolicy(git.commitPolicy)) throw new Error("contract settings git.commitPolicy is invalid");
    if (git.commitPolicy !== undefined && git.autoCommit !== (git.commitPolicy !== "no-commit")) throw new Error("contract settings git.commitPolicy must match autoCommit");
    settings.auto_commit = git.autoCommit;
    settings.commit_branch = git.branch;
    if (git.commitPolicy !== undefined) settings.commit_policy = git.commitPolicy;
  }
  if (contract.execution !== undefined) {
    if (!isRecord(contract.execution)) throw new Error("contract settings execution must be an object");
    const execution = contract.execution;
    assertKeys(execution, ["consent", "envAllowlist", "allowedCommandCategories"], "execution");
    // consent is deliberately omitted; only --consent or interactive confirmation authorizes execution.
    if (execution.envAllowlist !== undefined) settings.env_allowlist = execution.envAllowlist;
    if (execution.allowedCommandCategories !== undefined) settings.command_categories = execution.allowedCommandCategories;
  }
  return settings;
}
