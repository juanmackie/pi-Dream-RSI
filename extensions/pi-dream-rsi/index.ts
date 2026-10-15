/**
 * pi-dream-rsi — campaign based project improvement for pi (arXiv 2609.14858).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import { Dashboard } from "./dashboard.ts";
import { campaignRuntimeDiagnostics, checkCampaignEvaluator, readCampaignStatus, resumeCampaign, runCampaign, stopCampaign, type CampaignCheckReport, type CampaignRuntimeDiagnostics, type CampaignStatus } from "./engine/campaign.ts";
import { resolveWithinRoot } from "./engine/apply.ts";
import { progressSummary, type ProgressSnapshot } from "./engine/progress.ts";
import { defaultTask, normalizeTask, validateTask, type TaskConfig } from "./engine/task.ts";
import { SKILLS_DIR } from "./layout.ts";

const MODE_ENTRY = "pi-dream-rsi/mode";
const campaignTaskParams = {
  type: "object",
  properties: {
    name: { type: "string", description: "Campaign task name." },
    workspace: { type: "string", description: "Seed workspace directory, relative to project_dir." },
    eval_program: { type: "string", description: "Candidate program path, relative to workspace." },
    score_program: { type: "string", description: "Fixed scoring command that writes the configured score file." },
    problem_file: { type: "string", description: "Optional problem statement path, relative to project_dir." },
    score_path: { type: "string", description: "Score JSON path (default eval/score.json)." },
    score_field: { type: "string", description: "Numeric score field (default score)." },
    valid_field: { type: "string", description: "Boolean correctness field (default valid)." },
    fail_class_field: { type: "string", description: "Failure-class field (default fail_class)." },
    error_field: { type: "string", description: "Error field (default error)." },
    higher_is_better: { type: "boolean", description: "False when the score is a cost." },
    workers: { type: "number", description: "Parallel attempts (campaign default 2)." },
    max_loops: { type: "number", description: "Concurrent online episodes cap (campaign default 1)." },
    k1: { type: "number", description: "Online rounds (campaign default 3)." },
    k2: { type: "number", description: "Replay rounds (campaign default 4)." },
    revisions: { type: "number", description: "Policy revisions per dream (campaign default 2)." },
    beta1: { type: "number", description: "Optional base exploration beta." },
    beta2: { type: "number", description: "Optional refinement beta." },
    beta_grid: { type: "array", items: { type: "number" }, description: "Optional beta values used by replay." },
    default_beta: { type: "number", description: "Initial exploration beta." },
    agent_timeout_ms: { type: "number", description: "Maximum time allowed for one agent call." },
    evaluator_timeout_ms: { type: "number", description: "Maximum time allowed for one evaluator call." },
    copy_exclude: { type: "array", items: { type: "string" }, description: "Workspace-relative paths omitted from copied attempts." },
    work_retention: { type: "number", description: "Number of recent attempt workspaces to retain." },
    guidance: { type: "string", enum: ["off", "summary"], description: "Whether to include bounded prior-work guidance in agent prompts." },
    agent_command: { type: "string", description: "Agent CLI executable." },
    agent_args: { type: "array", items: { type: "string" }, description: "Arguments passed to the agent CLI." },
    model: { type: "string", description: "Optional model name passed to the agent CLI." },
  },
  required: ["name", "workspace", "eval_program", "score_program"],
  additionalProperties: false,
};

const improveParams = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["check", "start", "status", "stop", "resume"], description: "Check an evaluator or start, inspect, stop or resume a campaign." },
    goal: { type: "string", description: "Concrete improvement goal. Required for start." },
    project_dir: { type: "string", description: "Local project or managed clone path; defaults to the current project." },
    task: { ...campaignTaskParams, description: "Direct task/evaluator configuration for this isolated campaign. Does not change the legacy task." },
    scope: { type: "array", items: { type: "string" }, description: "Workspace-relative files the campaign may change and apply." },
    verifier_inputs: { type: "array", items: { type: "string" }, description: "Required evaluator/test inputs outside the editable workspace; use project-relative paths or canonical absolute paths. Their content is hashed and they are excluded from promotion." },
    max_cycles: { type: "integer", minimum: 1, maximum: 5, description: "Optional lower cycle cap (campaign default 5). Use this to honor a request such as 'run 2 cycles'." },
    max_agent_starts: { type: "integer", minimum: 1, maximum: 36, description: "Optional lower spawned-agent cap (campaign default 36)." },
    max_evaluator_runs: { type: "integer", minimum: 1, maximum: 100, description: "Optional lower evaluator-run cap (campaign default 100)." },
    minimum_gain: { type: "number", minimum: 0, description: "Optional finite normalized-score delta; the baseline must repeat within this tolerance, and a candidate must beat it to qualify." },
    runs: { type: "integer", minimum: 1, maximum: 5, description: "Evaluator check repetitions (default 3, maximum 5)." },
    gates: { type: "array", items: { type: "string" }, description: "Optional correctness commands, such as the project's test command. Their inputs belong in verifier_inputs." },
  },
  required: ["action"],
  additionalProperties: false,
};

export default function dreamRsi(pi: ExtensionAPI): void {
  const modes = new Map<string, boolean>();
  const dashboards = new Map<string, Dashboard>();
  const closingSessions = new Set<string>();
  const dashboardFor = (ctx: ExtensionContext): Dashboard => {
    const id = ctx.sessionManager.getSessionId();
    let dashboard = dashboards.get(id);
    if (!dashboard) { dashboard = new Dashboard(ctx); dashboards.set(id, dashboard); }
    return dashboard;
  };
  const dreamRoot = (ctx: ExtensionContext): string => path.join(ctx.cwd, ".dream-rsi");
  const runAgentConfig = (ctx: ExtensionContext, agent: TaskConfig["agent"]): TaskConfig["agent"] => ({
    ...agent,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : agent.model,
    thinking: ctx.thinkingLevel ?? agent.thinking,
  });
  const stateFor = (ctx: ExtensionContext): { mode: boolean } => {
    const id = ctx.sessionManager.getSessionId();
    if (!modes.has(id)) modes.set(id, false);
    return { get mode() { return modes.get(id) === true; } };
  };
  const setMode = (ctx: ExtensionContext, enabled: boolean): void => {
    modes.set(ctx.sessionManager.getSessionId(), enabled);
    pi.appendEntry(MODE_ENTRY, { version: 1, project: dreamRoot(ctx), active: enabled });
    ctx.ui.setStatus("dream-rsi", enabled ? "dream-rsi: active" : undefined);
  };
  const reconstruct = (ctx: ExtensionContext): void => {
    const id = ctx.sessionManager.getSessionId();
    closingSessions.delete(id);
    dashboards.get(id)?.dispose();
    dashboards.delete(id);
    let active = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
      const data = entry.data as { project?: string; active?: boolean };
      if (data.project === dreamRoot(ctx)) active = data.active === true;
    }
    modes.set(id, active);
    ctx.ui.setStatus("dream-rsi", active ? "dream-rsi: active" : undefined);
  };
  // -- tools ---------------------------------------------------------------

  pi.registerTool({
    name: "dream_rsi_improve",
    label: "Dream-RSI Improve",
    description:
      "Start, inspect, stop or resume an isolated, budgeted Dream-RSI improvement campaign. A start supplies its own goal, project directory and task/evaluator config, so it never reconfigures the legacy .dream-rsi task.",
    promptSnippet: "Control the active isolated Dream-RSI campaign. Start only for an explicit improvement request; assess requests are read-only.",
    promptGuidelines: [
      "For dream_rsi_improve, use action=start only after the user explicitly asks to improve or optimize a target and intake has defined a measurable goal, correctness gate, task workspace, candidate program and fixed evaluator outside the candidate workspace, declared in verifier_inputs. Absolute external verifier paths are allowed.",
      "For dream_rsi_improve, pass the direct task and project_dir from intake. Do not read or overwrite a different task in the base .dream-rsi directory.",
      "For dream_rsi_improve, assess a target-only request and offer measurable goals first. Do not call start from /dream-rsi assess or a generic question.",
      "For dream_rsi_improve, start/resume is enabled only after an explicit improve request has activated Dream-RSI mode; status and stop remain controllable while mode is off.",
      "For dream_rsi_improve, use status, stop and resume against the active campaign. Resume uses its frozen goal, task, scope and verifier inputs.",
      "For dream_rsi_improve, run action=check before start and resolve its evaluator and gate diagnoses. Check uses fresh copies and writes no campaign record or seed history.",
      "For dream_rsi_improve, omit minimum_gain to calibrate observed baseline noise. Set it only for a defensible explicit tolerance. Every gate input must be declared in verifier_inputs.",
      "For dream_rsi_improve, the campaign applies at most one in-scope candidate per cycle, only after its verifier measures a strict improvement. Report the final stop reason and call budget.",
    ],
    parameters: improveParams,
    async execute(_id, params: any, signal, onUpdate: any, ctx): Promise<any> {
      const baseRoot = dreamRoot(ctx);
      const action = typeof params.action === "string" ? params.action : "";
      if ((action === "start" || action === "resume" || action === "check") && !stateFor(ctx).mode) {
        return { content: [{ type: "text", text: "Start, resume or check requires an explicit improvement request. Use /dream-rsi improve <what you want> first." }], details: { ok: false } };
      }
      if (action === "status") {
        const campaign = readCampaignStatus(baseRoot);
        const runtime = campaignRuntimeDiagnostics();
        const manualDataNotice = fs.existsSync(path.join(baseRoot, "task.json")) || fs.existsSync(path.join(baseRoot, "history"))
          ? "\nManual-loop data from an earlier version is in .dream-rsi/ (task.json, history/). 1.0 does not use it."
          : "";
        return campaign
          ? { content: [{ type: "text", text: `${renderCampaignStatus(campaign, runtime)}${manualDataNotice}` }], details: { campaign, runtime } }
          : { content: [{ type: "text", text: `No campaign yet. Run /dream-rsi assess.${manualDataNotice}\n${renderCampaignRuntime(runtime)}` }], details: { campaign: null, runtime } };
      }
      if (action === "stop") {
        const campaign = stopCampaign(baseRoot);
        const runtime = campaignRuntimeDiagnostics();
        return campaign
          ? { content: [{ type: "text", text: `Stop requested.\n${renderCampaignStatus(campaign, runtime)}` }], details: { campaign, runtime } }
          : { content: [{ type: "text", text: `No active improvement campaign under ${baseRoot}.\n${renderCampaignRuntime(runtime)}` }], details: { campaign: null, runtime } };
      }
      if (action !== "start" && action !== "resume" && action !== "check") {
        return { content: [{ type: "text", text: "action must be check, start, status, stop or resume." }], details: { ok: false } };
      }
      if (action === "check") {
        const projectDir = resolveCampaignProjectDir(params.project_dir, ctx.cwd);
        if (!projectDir) return { content: [{ type: "text", text: "project_dir must name an existing local project directory." }], details: { ok: false } };
        const parsed = parseCampaignTask(params.task, ctx);
        if (parsed.errors.length > 0 || !parsed.task) return { content: [{ type: "text", text: `Campaign task is invalid:\n- ${parsed.errors.join("\n- ")}` }], details: { ok: false, errors: parsed.errors } };
        const task = { ...parsed.task, agent: runAgentConfig(ctx, parsed.task.agent) };
        const errors = validateCampaignPaths(projectDir, task);
        const verifierInputs = readStringArray(params.verifier_inputs, "verifier_inputs");
        const gates = readStringArray(params.gates, "gates");
        const runs = params.runs === undefined ? 3 : params.runs;
        if (verifierInputs.error || gates.error || !Number.isSafeInteger(runs) || runs < 1 || runs > 5) {
          const messages = [verifierInputs.error, gates.error, (!Number.isSafeInteger(runs) || runs < 1 || runs > 5) ? "runs must be an integer from 1 to 5" : null].filter((message): message is string => message !== null);
          return { content: [{ type: "text", text: messages.join("\n") }], details: { ok: false, errors: messages } };
        }
        if (errors.length > 0) return { content: [{ type: "text", text: `Campaign target is invalid:\n- ${errors.join("\n- ")}` }], details: { ok: false, errors } };
        const inputErrors = validateCampaignInputs(baseRoot, projectDir, task, [task.eval_program], verifierInputs.values);
        if (inputErrors.length > 0) return { content: [{ type: "text", text: `Campaign inputs are invalid:\n- ${inputErrors.join("\n- ")}` }], details: { ok: false, errors: inputErrors } };
        const report = await checkCampaignEvaluator({
          baseRoot,
          projectDir,
          task,
          ...(verifierInputs.values ? { verifierInputs: verifierInputs.values } : {}),
          ...(gates.values ? { gates: gates.values } : {}),
          runs,
          signal,
        });
        const text = renderCampaignCheckReport(report);
        return { content: [{ type: "text", text }], details: { check: report } };
      }

      const projectDir = action === "start"
        ? resolveCampaignProjectDir(params.project_dir, ctx.cwd)
        : readCampaignStatus(baseRoot)?.projectDir ?? null;
      if (!projectDir) {
        return { content: [{ type: "text", text: action === "resume" ? "No resumable campaign with a saved project directory." : "project_dir must name an existing local project directory." }], details: { ok: false } };
      }
      if (action === "start") {
        const goal = typeof params.goal === "string" ? params.goal.trim() : "";
        if (!goal) return { content: [{ type: "text", text: "action=start requires a concrete measurable goal." }], details: { ok: false } };
        const parsed = parseCampaignTask(params.task, ctx);
        if (parsed.errors.length > 0 || !parsed.task) {
          return { content: [{ type: "text", text: `Campaign task is invalid:\n- ${parsed.errors.join("\n- ")}` }], details: { ok: false, errors: parsed.errors } };
        }
        const task = { ...parsed.task, agent: runAgentConfig(ctx, parsed.task.agent) };
        const errors = validateCampaignPaths(projectDir, task);
        if (errors.length > 0) return { content: [{ type: "text", text: `Campaign target is invalid:\n- ${errors.join("\n- ")}` }], details: { ok: false, errors } };
        const scope = readStringArray(params.scope, "scope");
        const verifierInputs = readStringArray(params.verifier_inputs, "verifier_inputs");
        const gates = readStringArray(params.gates, "gates");
        if (scope.error || verifierInputs.error || gates.error) {
          const errors = [scope.error, verifierInputs.error, gates.error].filter((error): error is string => error !== null);
          return { content: [{ type: "text", text: errors.join("\n") }], details: { ok: false, errors } };
        }
        const campaignScope = scope.values?.length ? scope.values : [task.eval_program];
        const inputErrors = validateCampaignInputs(baseRoot, projectDir, task, campaignScope, verifierInputs.values);
        if (inputErrors.length > 0) return { content: [{ type: "text", text: `Campaign inputs are invalid:\n- ${inputErrors.join("\n- ")}` }], details: { ok: false, errors: inputErrors } };
        const limitResult = parseCampaignLimits(params);
        if (limitResult.error) return { content: [{ type: "text", text: limitResult.error }], details: { ok: false } };
        const gainResult = parseCampaignMinimumGain(params.minimum_gain);
        if (gainResult.error) return { content: [{ type: "text", text: gainResult.error }], details: { ok: false } };
        setMode(ctx, true);
        const result = await runCampaign({
          baseRoot,
          projectDir,
          task,
          goal,
          scope: campaignScope,
          ...(verifierInputs.values ? { verifierInputs: verifierInputs.values } : {}),
          ...(gates.values ? { gates: gates.values } : {}),
          ...(limitResult.limits ? { limits: limitResult.limits } : {}),
          ...(gainResult.minimumGain !== undefined ? { minimumGain: gainResult.minimumGain } : {}),
          signal,
          onPhaseProgress: campaignPhaseProgress(dashboardFor(ctx), baseRoot, onUpdate, () => closingSessions.has(ctx.sessionManager.getSessionId())),
          onProgress: campaignProgress(ctx, baseRoot, onUpdate, () => closingSessions.has(ctx.sessionManager.getSessionId())),
          onUpdate: campaignUpdate(ctx, onUpdate, () => closingSessions.has(ctx.sessionManager.getSessionId())),
        });
        const runtime = campaignRuntimeDiagnostics();
        return { content: [{ type: "text", text: renderCampaignStatus(result, runtime) }], details: { campaign: result, runtime } };
      }
      setMode(ctx, true);
      const result = await resumeCampaign({
        baseRoot,
        projectDir,
        sessionId: ctx.sessionManager.getSessionId(),
        signal,
        onPhaseProgress: campaignPhaseProgress(dashboardFor(ctx), baseRoot, onUpdate, () => closingSessions.has(ctx.sessionManager.getSessionId())),
        onProgress: campaignProgress(ctx, baseRoot, onUpdate, () => closingSessions.has(ctx.sessionManager.getSessionId())),
        onUpdate: campaignUpdate(ctx, onUpdate, () => closingSessions.has(ctx.sessionManager.getSessionId())),
      });
      const runtime = campaignRuntimeDiagnostics();
      return { content: [{ type: "text", text: renderCampaignStatus(result, runtime) }], details: { campaign: result, runtime } };
    },
  });

  // -- command -------------------------------------------------------------

  pi.registerCommand("dream-rsi", {
    description: "Dream-RSI: assess | improve | watch | status | stop | resume",
    getArgumentCompletions: commandCompletions,
    async handler(args, ctx) {
      const root = dreamRoot(ctx);
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const verb = parts[0] ?? "help";
      const rest = parts.slice(1).join(" ");
      const report = (text: string, type: "info" | "error" = "info"): void => {
        ctx.ui.notify(text, type);
        if (ctx.mode !== "tui") pi.sendMessage({ customType: "dream-rsi/command", content: text, display: true }, { triggerTurn: false });
      };
      const manualDataNotice = (): string | null =>
        fs.existsSync(path.join(root, "task.json")) || fs.existsSync(path.join(root, "history"))
          ? "Manual-loop data from an earlier version is in .dream-rsi/ (task.json, history/). 1.0 does not use it."
          : null;
      const sendWhenReady = (message: string): void => {
        pi.sendUserMessage(message, { expandPromptTemplates: true, ...(ctx.isIdle() ? {} : { deliverAs: "followUp" }) });
      };
      if (verb === "help" || verb === "?") {
        report(renderCommandHelp());
        return;
      }
      if (verb === "assess") {
        sendWhenReady(`/skill:dream-rsi-assess ${rest}`.trim());
        return;
      }
      if (verb === "improve") {
        setMode(ctx, true);
        sendWhenReady(`/skill:dream-rsi-improve ${rest}`.trim());
        report("Dream-RSI improvement intake started. A target without a measurable goal is assessed first.");
        return;
      }
      if (verb === "watch" && rest === "legacy") {
        report("watch legacy was removed in 1.0. Use /dream-rsi improve <what you want>.");
        return;
      }
      if (verb === "status") {
        const campaign = readCampaignStatus(root);
        const lines = [campaign ? renderCampaignStatus(campaign) : "No campaign yet. Run /dream-rsi assess."];
        const notice = manualDataNotice();
        if (notice) lines.push(notice);
        report(lines.join("\n"));
        return;
      }
      if (verb === "stop") {
        const campaign = stopCampaign(root);
        report(campaign ? `Stop requested.\n${renderCampaignStatus(campaign)}` : "No active improvement campaign is recorded here.", campaign ? "info" : "error");
        return;
      }
      if (verb === "resume") {
        if (rest) {
          report(`resume ${rest} was removed in 1.0. Use /dream-rsi improve <what you want>.`);
          return;
        }
        const campaign = readCampaignStatus(root);
        if (campaign?.state.kind === "paused") {
          setMode(ctx, true);
          sendWhenReady("/skill:dream-rsi-improve resume");
          report("Resuming the paused Dream-RSI improvement campaign with its saved goal, target and remaining budgets.");
        } else {
          report(campaign?.state.kind === "running"
            ? "The improvement campaign is already running. Use /dream-rsi status, watch or stop."
            : "No paused improvement campaign is available to resume.", campaign?.state.kind === "running" ? "info" : "error");
        }
        return;
      }
      if (verb === "watch") {
        if (rest) {
          report(`watch ${rest} was removed in 1.0. Use /dream-rsi improve <what you want>.`);
          return;
        }
        const campaign = readCampaignStatus(root);
        if (!campaign) {
          const notice = manualDataNotice();
          report(notice ? `No campaign yet. Run /dream-rsi assess.\n${notice}` : "No campaign yet. Run /dream-rsi assess.", "info");
          return;
        }
        const summary = await dashboardFor(ctx).watch(resolveWatchRoot(campaign));
        if (summary) pi.sendMessage({ customType: "dream-rsi/watch", content: summary, display: true }, { triggerTurn: false });
        return;
      }
      const removed = new Set(["create", "suggest", "best", "live", "dream", "run", "off"]);
      if (removed.has(verb)) {
        report(`${verb} was removed in 1.0. Use /dream-rsi improve <what you want>.`);
        return;
      }
      report(`Unknown Dream-RSI command. Use /dream-rsi help.`);
    },
  });
  // -- lifecycle -----------------------------------------------------------

  pi.registerShortcut("ctrl+shift+d", { description: "Watch the Dream-RSI campaign", handler: async (ctx) => {
    const campaign = readCampaignStatus(dreamRoot(ctx));
    if (!campaign) { ctx.ui.notify("No campaign yet. Run /dream-rsi assess.", "info"); return; }
    await dashboardFor(ctx).watch(resolveWatchRoot(campaign));
  } });
  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension" && explicitlyRequestsImprovement(event.text)) setMode(ctx, true);
    return { action: "continue" };
  });
  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
  pi.on("resources_discover", async () => ({ skillPaths: [SKILLS_DIR] }));
  pi.on("session_shutdown", async (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    closingSessions.add(id);
    dashboards.get(id)?.dispose();
    dashboards.delete(id);
    modes.delete(id);
  });
}
/**
 * Models sometimes prefix path arguments with `@`; strip it before resolving the path.
 */
function normalizePathArg(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function renderCommandHelp(): string {
  return [
    "Dream-RSI · arXiv 2609.14858",
    "  /dream-rsi assess [what you want]  rank project levers (read-only)",
    "  /dream-rsi improve <what you want>  run a verified improvement campaign",
    "  /dream-rsi watch  open the campaign dashboard · Ctrl+Shift+D",
    "  /dream-rsi status | stop | resume  inspect or control the campaign",
  ].join("\n");
}

function commandCompletions(prefix: string) {
  const query = prefix.trimStart().replace(/\s+/g, " ");
  const choices = [
    { value: "assess", label: "assess [what you want]", description: "Rank project levers without changing files" },
    { value: "improve", label: "improve <what you want>", description: "Run a bounded improvement campaign" },
    { value: "watch", label: "watch", description: "Open the campaign dashboard" },
    { value: "status", label: "status", description: "Inspect campaign state" },
    { value: "stop", label: "stop", description: "Stop the active campaign" },
    { value: "resume", label: "resume", description: "Resume a paused campaign" },
  ];
  const matches = choices.filter((choice) => choice.value.startsWith(query));
  return matches.length ? matches : null;
}

function explicitlyRequestsImprovement(text: string): boolean {
  const input = text.trim();
  if (/^\/dream-rsi\s+(assess|status|watch|stop|resume|help|\?)\b/i.test(input)) return false;
  if (/\b(assess|evaluate|what should|how does|why does|suggest|recommend)\b.{0,100}\b(improve|improvement|optimi[sz]e|optimization)\b/i.test(input)) return false;
  if (/\b(what|how|why|should|could|can)\b.{0,80}\b(improve|improvement|optimi[sz]e|optimization)\b/i.test(input)) return false;
  return (
    /\b(use|run|start|ask)\b.{0,50}\bdream[- ]rsi\b.{0,60}\b(improve|optimi[sz]e)\b/i.test(input) ||
    /\bdream[- ]rsi\b.{0,50}\b(improve|optimi[sz]e)\b/i.test(input) ||
    /\b(improve|optimi[sz]e)\b.{0,100}\b(with|using|via)\s+dream[- ]rsi\b/i.test(input)
  );
}

function resolveWatchRoot(campaign: CampaignStatus): string {
  return campaign.campaignRoot;
}

function resolveCampaignProjectDir(value: unknown, cwd: string): string | null {
  if (value !== undefined && typeof value !== "string") return null;
  const target = path.resolve(cwd, normalizePathArg(typeof value === "string" ? value : cwd));
  try {
    return fs.statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
}
function parseCampaignTask(value: unknown, ctx: ExtensionContext): { task: TaskConfig | null; errors: string[] } {
  if (!isRecord(value)) return { task: null, errors: ["task must be an object with name, workspace, eval_program and score_program"] };
  const raw = value;
  const betaGrid = numberArray(raw.beta_grid);
  const copyExclude = stringArray(raw.copy_exclude);
  const agentArgs = stringArray(raw.agent_args);
  const malformed = [
    ...(raw.beta_grid !== undefined && !betaGrid ? ["beta_grid must be an array of numbers"] : []),
    ...(raw.copy_exclude !== undefined && !copyExclude ? ["copy_exclude must be an array of strings"] : []),
    ...(raw.agent_args !== undefined && !agentArgs ? ["agent_args must be an array of strings"] : []),
  ];
  if (malformed.length > 0) return { task: null, errors: malformed };
  try {
    const task: TaskConfig = normalizeTask({
      name: typeof raw.name === "string" ? raw.name : "",
      workspace: typeof raw.workspace === "string" ? normalizePathArg(raw.workspace) : "",
      eval_program: typeof raw.eval_program === "string" ? normalizePathArg(raw.eval_program) : "",
      score_program: typeof raw.score_program === "string" ? raw.score_program : "",
      ...(typeof raw.problem_file === "string" ? { problem_file: normalizePathArg(raw.problem_file) } : {}),
      ...(typeof raw.score_path === "string" ? { score_path: raw.score_path } : {}),
      ...(typeof raw.score_field === "string" ? { score_field: raw.score_field } : {}),
      ...(typeof raw.valid_field === "string" ? { valid_field: raw.valid_field } : {}),
      ...(typeof raw.fail_class_field === "string" ? { fail_class_field: raw.fail_class_field } : {}),
      ...(typeof raw.error_field === "string" ? { error_field: raw.error_field } : {}),
      ...(typeof raw.higher_is_better === "boolean" ? { higher_is_better: raw.higher_is_better } : {}),
      ...(typeof raw.workers === "number" ? { workers: raw.workers } : {}),
      ...(typeof raw.max_loops === "number" ? { max_loops: raw.max_loops } : {}),
      ...(typeof raw.k1 === "number" ? { k1: raw.k1 } : {}),
      ...(typeof raw.k2 === "number" ? { k2: raw.k2 } : {}),
      ...(typeof raw.revisions === "number" ? { revisions: raw.revisions } : {}),
      ...(typeof raw.beta1 === "number" ? { beta1: raw.beta1 } : {}),
      ...(typeof raw.beta2 === "number" ? { beta2: raw.beta2 } : {}),
      ...(betaGrid ? { beta_grid: betaGrid } : {}),
      ...(typeof raw.default_beta === "number" ? { default_beta: raw.default_beta } : {}),
      ...(typeof raw.agent_timeout_ms === "number" ? { agent_timeout_ms: raw.agent_timeout_ms } : {}),
      ...(typeof raw.evaluator_timeout_ms === "number" ? { evaluator_timeout_ms: raw.evaluator_timeout_ms } : {}),
      ...(copyExclude ? { copy_exclude: copyExclude } : {}),
      ...(typeof raw.work_retention === "number" ? { work_retention: raw.work_retention } : {}),
      ...(raw.guidance === "off" || raw.guidance === "summary" ? { guidance: raw.guidance } : {}),
      agent: {
        ...defaultTask().agent,
        ...(typeof raw.agent_command === "string" ? { command: raw.agent_command } : {}),
        ...(agentArgs ? { args: agentArgs } : {}),
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
        thinking: (ctx.thinkingLevel as TaskConfig["agent"]["thinking"] | undefined) ?? null,
      },
    });
    return { task, errors: validateTask(task) };
  } catch (error) {
    return { task: null, errors: [(error as Error).message] };
  }
}

function validateCampaignPaths(projectDir: string, task: TaskConfig): string[] {
  const errors: string[] = [];
  const workspace = resolveWithinRoot(projectDir, task.workspace);
  if (!workspace || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) errors.push(`workspace must exist inside the project directory: ${task.workspace}`);
  if (task.problem_file) {
    const problemFile = resolveWithinRoot(projectDir, task.problem_file);
    if (!problemFile || !fs.existsSync(problemFile)) errors.push(`problem_file must exist inside the project directory: ${task.problem_file}`);
  }
  if (!workspace) return errors;
  const candidate = resolveWithinRoot(workspace, task.eval_program);
  if (!candidate || !fs.existsSync(candidate)) errors.push(`eval_program must exist inside the campaign workspace: ${task.eval_program}`);
  return errors;
}

function validateCampaignInputs(baseRoot: string, projectDir: string, task: TaskConfig, scope?: string[], verifierInputs?: string[]): string[] {
  const errors: string[] = [];
  const workspace = path.resolve(projectDir, task.workspace);
  let realWorkspace: string | null = null;
  try { realWorkspace = fs.realpathSync(workspace); } catch { /* validateCampaignPaths reports the missing workspace */ }
  let realTrustedRoot: string | null = null;
  try { realTrustedRoot = fs.realpathSync(baseRoot); } catch { /* it is created when the campaign starts */ }
  if (!verifierInputs || verifierInputs.length === 0) errors.push("verifier_inputs must declare at least one fixed evaluator or test input outside the editable workspace");
  for (const relative of scope ?? []) {
    if (path.isAbsolute(relative) || !resolveWithinRoot(workspace, relative)) errors.push(`scope entry must stay inside the campaign workspace: ${relative}`);
  }
  for (const input of verifierInputs ?? []) {
    let resolved: string | null = null;
    if (path.isAbsolute(input)) {
      try {
        const actual = fs.realpathSync(input);
        if (path.resolve(input).toLowerCase() !== actual.toLowerCase()) {
          errors.push(`absolute verifier input must be canonical (real) path: ${input}`);
          continue;
        }
        resolved = actual;
      } catch {
        errors.push(`absolute verifier input does not exist: ${input}`);
        continue;
      }
    } else {
      resolved = resolveWithinRoot(projectDir, input);
    }
    if (!resolved || !fs.existsSync(resolved)) {
      errors.push(`verifier input does not exist or escapes the project directory: ${input}`);
      continue;
    }
    const actual = fs.realpathSync(resolved);
    const insideWorkspace = realWorkspace !== null && isPathWithin(realWorkspace, actual);
    const insideTrustedRoot = realTrustedRoot !== null && isPathWithin(realTrustedRoot, actual);
    if (insideWorkspace && !insideTrustedRoot) {
      errors.push(`verifier input must be outside the editable workspace or inside the trusted host .dream-rsi subtree: ${input}`);
    }
  }
  return errors;
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readStringArray(value: unknown, name: string): { values?: string[]; error: string | null } {
  if (value === undefined) return { error: null };
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    return { error: `${name} must be an array of non-empty strings` };
  }
  return { values: value.map((entry) => entry.trim()), error: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberArray(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((entry): entry is number => typeof entry === "number") ? value : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string") ? value : null;
}

function campaignPhaseProgress(
  dashboard: Dashboard,
  baseRoot: string,
  onUpdate: ((update: any) => void) | undefined,
  isClosing: () => boolean,
): (progress: ProgressSnapshot) => void {
  return (progress) => {
    if (!isClosing()) dashboard.observe(progress);
    onUpdate?.({
      content: [{ type: "text", text: progressSummary(progress) }],
      details: { campaign: readCampaignStatus(baseRoot), progress },
    });
  };
}

function renderCampaignRuntime(runtime: CampaignRuntimeDiagnostics): string {
  return `  loaded runtime: ${runtime.extensionDir} (package ${runtime.packageVersion ?? "unknown"})\n  campaign module: ${runtime.campaignModule}\n  evaluator timeout cap: ${runtime.evaluatorTimeoutCapMs}ms`;
}

function renderCampaignStatus(campaign: CampaignStatus | Awaited<ReturnType<typeof runCampaign>>, runtime = campaignRuntimeDiagnostics()): string {
  const state = campaign.state;
  const cycle = campaign.completedCycles.length;
  const activeIteration = state.kind === "running" || state.kind === "paused" ? state.iteration : null;
  const lines = [
    `Improvement campaign: ${state.kind}${state.kind === "running" || state.kind === "paused" ? ` (${state.phase})` : ""}`,
    `  goal: ${campaign.goal}`,
    `  target: ${campaign.projectDir}${campaign.scope.length ? ` [${campaign.scope.join(", ")}]` : ""}`,
    `  cycles: ${cycle}/${campaign.limits.maxCycles}${activeIteration === null ? "" : `; working on ${activeIteration}`}; no-gain cycles: ${campaign.noGainCycles}`,
    `  verified best: ${campaign.bestScore}`,
    `  calls: ${campaign.agentStarts}/${campaign.limits.maxAgentStarts} agent starts, ${campaign.evaluatorRuns}/${campaign.limits.maxEvaluatorRuns} evaluator runs`,
    `  effective evaluator timeout: ${campaign.effectiveEvaluatorTimeoutMs}ms`,
    `  deadline: ${campaign.deadlineAt}`,
    renderCampaignRuntime(runtime),
  ];
  if (state.kind === "paused" || state.kind === "complete" || state.kind === "failed") lines.push(`  stopped because: ${state.reason}`);
  if ("stopReason" in campaign && campaign.stopReason) lines.push(`  stop reason: ${campaign.stopReason}`);
  for (const rejection of campaign.rejections.slice(-3)) lines.push(`  rejected ${rejection.cell} (${rejection.stage}): ${rejection.reasons.join("; ")}`);
  return lines.join("\n");
}

function renderCampaignCheckReport(report: CampaignCheckReport): string {
  const lines = ["Evaluator check", ...report.runs.map((run, index) =>
    `  run ${index + 1}: ${Math.ceil(run.durationMs / 1000)}s, exit ${run.code ?? "unknown"}, ${run.valid ? `score ${run.score}` : `${run.failClass}${run.error ? `: ${run.error}` : ""}`}`),
  `  spread: ${report.spread ?? "unavailable"}`,
  `  recommended evaluator_timeout_ms: ${report.recommendedEvaluatorTimeoutMs}`,
  `  recommended minimum_gain: ${report.recommendedMinimumGain}`,
  ...report.gateRuns.map((gate) => `  gate ${gate.passed ? "passed" : "failed"}: exit ${gate.code ?? "unknown"}${gate.error ? ` (${gate.error})` : ""}`),
  ...(report.diagnoses.length ? report.diagnoses.map((diagnosis) => `  diagnosis: ${diagnosis}`) : ["  diagnoses: none"]),
  `  report: ${report.reportPath}`];
  return lines.join("\n");
}

function campaignProgress(ctx: ExtensionContext, baseRoot: string, onUpdate: ((update: any) => void) | undefined, isClosing: () => boolean): (progress: string) => void {
  return (progress) => {
    const campaign = readCampaignStatus(baseRoot);
    if (!isClosing()) {
      ctx.ui.setStatus("dream-rsi", `dream-rsi: ${campaign?.state.kind === "running" ? campaign.state.phase : "improving"} (${campaign?.completedCycles.length ?? 0}/${campaign?.limits.maxCycles ?? 5})`);
    }
    onUpdate?.({ content: [{ type: "text", text: `Dream-RSI campaign: ${progress}` }], details: { campaign } });
  };
}

function campaignUpdate(ctx: ExtensionContext, onUpdate: ((update: any) => void) | undefined, isClosing: () => boolean): (campaign: CampaignStatus) => void {
  return (campaign) => {
    if (!isClosing()) {
      const phase = campaign.state.kind === "running" ? campaign.state.phase : campaign.state.kind;
      ctx.ui.setStatus("dream-rsi", `dream-rsi: ${phase} (${campaign.completedCycles.length}/${campaign.limits.maxCycles})`);
    }
    onUpdate?.({ content: [{ type: "text", text: renderCampaignStatus(campaign) }], details: { campaign, runtime: campaignRuntimeDiagnostics() } });
  };
}

function parseCampaignLimits(params: Record<string, unknown>): { limits?: { maxCycles?: number; maxAgentStarts?: number; maxEvaluatorRuns?: number }; error?: string } {
  const fields = [
    ["max_cycles", "maxCycles", 5],
    ["max_agent_starts", "maxAgentStarts", 36],
    ["max_evaluator_runs", "maxEvaluatorRuns", 100],
  ] as const;
  const limits: { maxCycles?: number; maxAgentStarts?: number; maxEvaluatorRuns?: number } = {};
  for (const [input, output, maximum] of fields) {
    const value = params[input];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
      return { error: `${input} must be an integer from 1 to ${maximum}` };
    }
    limits[output] = value;
  }
  return { ...(Object.keys(limits).length > 0 ? { limits } : {}) };
}

function parseCampaignMinimumGain(value: unknown): { minimumGain?: number; error?: string } {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { error: "minimum_gain must be a finite, non-negative normalized-score delta" };
  }
  return { minimumGain: value };
}
