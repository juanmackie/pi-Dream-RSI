/**
 * Dream-RSI assessment and autonomous improvement loop for pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import { Dashboard } from "./dashboard.ts";
import { campaignRuntimeDiagnostics, failPausedV2Campaign, readCampaignStatus, runCampaign, stopCampaign, type CampaignRuntimeDiagnostics, type CampaignStatus } from "./engine/campaign.ts";
import { runLoop, type LoopLimits } from "./engine/loop.ts";
import { phaseIsActive } from "./engine/ownership.ts";
import { progressSummary, type ProgressSnapshot } from "./engine/progress.ts";
import { mementoNotes, readMemory } from "./engine/search.ts";
import { normalizeRunContract, readStoredContract } from "./engine/intake.ts";
import { collectSignals } from "./engine/signals.ts";
import { defaultTask, type TaskConfig } from "./engine/task.ts";
import { SKILLS_DIR } from "./layout.ts";

const MODE_ENTRY = "pi-dream-rsi/mode";
const LOOP_TARGET_ENTRY = "pi-dream-rsi/loop-target";
const signalsParams = {
  type: "object",
  properties: {
    focus: { type: "string", description: "Optional plain-language intent used to rank matching evidence." },
    include_logs: { type: "boolean", description: "Read bounded local session aggregates. Defaults to true; false skips all session-file access." },
  },
  additionalProperties: false,
};

const loopParams = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["start", "status", "stop", "resume"], description: "Start, inspect, stop or resume the unattended loop." },
    project_dir: { type: "string", description: "Local project path; defaults to the current project." },
    consent: { type: "boolean", description: "Required for start: discovered repository code runs on this host with host access." },
    focus: { type: "string", description: "Improvement goal. Defaults to reducing declared workload wall-clock time without changing results." },
    include_logs: { type: "boolean", description: "Read bounded local session aggregates. Defaults to true; false skips all session-file access." },
    unit: { type: "string", description: "Metric unit; defaults to ms when no evaluator is supplied." },
    higher_is_better: { type: "boolean", description: "Metric direction; defaults to false without an evaluator." },
    minimum_gain: { type: ["number", "string"], description: "Minimum useful gain, default 5%." },
    proxy_justification: { type: "string", description: "Why a proxy metric represents the stated goal." },
    evaluator: { type: "object", properties: {
      argv: { type: "array", items: { type: "string" } },
      output: { type: "string", enum: ["score-json", "stdout-number"] },
      inputs: { type: "array", items: { type: "string" } },
    }, required: ["argv", "output"], additionalProperties: false },
    scope_roots: { type: "array", items: { type: "string" }, description: "Editable project roots. Defaults to recon's discovered scope." },
    protected_assets: { type: "array", items: { type: "string" } },
    gates: { type: "array", items: { type: "string" }, description: "Correctness commands that must continue to pass." },
    command_categories: { type: "array", items: { type: "string", enum: ["test", "benchmark", "build", "custom"] }, description: "Allowed repository command categories; defaults to all." },
    env_allowlist: { type: "array", items: { type: "string" } },
    max_campaigns: { type: "integer", minimum: 1, maximum: 64, description: "Durable campaign cap across runs. Default 6." },
    max_agent_starts: { type: "integer", minimum: 1, maximum: 1000, description: "Durable spawned-agent cap across runs. Default 72." },
    max_evaluator_runs: { type: "integer", minimum: 1, maximum: 5000, description: "Durable evaluator-run cap across runs. Default 200." },
    deadline_minutes: { type: "integer", minimum: 1, maximum: 720, description: "Wall-clock budget for this run in minutes. Default 120." },
    agent_command: { type: "string", description: "Agent CLI executable for chained campaigns." },
    agent_args: { type: "array", items: { type: "string" }, description: "Arguments passed to the agent CLI." },
    agent_timeout_ms: { type: "number", description: "Maximum time allowed for one agent call." },
    evaluator_timeout_ms: { type: "number", description: "Maximum time allowed for one evaluator call." },
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
  const resolveAgent = (ctx: ExtensionContext) => (savedAgent: TaskConfig["agent"]): TaskConfig["agent"] | null => {
    const model = ctx.model;
    if (!model) return null;
    return {
      ...savedAgent,
      model: `${model.provider}/${model.id}`,
      thinking: ctx.thinkingLevel ?? savedAgent.thinking,
    };
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
  /**
   * The project of the last loop started in this session, as a canonical `.dream-rsi` root.
   * The advertised stop and status reach a loop that runs in a different project than the
   * calling directory through this retained target; without it, stop would address the
   * caller and leave the loop's campaign running.
   */
  const loopTargetRoot = (ctx: ExtensionContext): string | null => {
    let project: string | null = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== LOOP_TARGET_ENTRY) continue;
      const data = entry.data as { project?: string };
      if (typeof data.project === "string" && data.project) project = data.project;
    }
    return project ? path.join(project, ".dream-rsi") : null;
  };
  // -- tools ---------------------------------------------------------------

  pi.registerTool({
    name: "dream_rsi_signals",
    label: "Dream-RSI Signals",
    description: "Read bounded, privacy-filtered project signals for lever assessment. The tool is free and read-only.",
    promptSnippet: "Read project signals and rank evidence for an improvement intent. This tool does not run project commands or change files.",
    promptGuidelines: [
      "For dream_rsi_signals, pass the user's plain-language improvement intent as focus when available.",
      "For dream_rsi_signals, report only returned aggregates and diagnostics. Do not repeat raw commands, paths, errors, commit subjects or campaign text.",
      "For dream_rsi_signals, use include_logs=false when the user disables session-log analysis.",
    ],
    parameters: signalsParams,
    async execute(_id, params: any, _signal, _onUpdate, ctx): Promise<any> {
      const includeLogs = params.include_logs !== false;
      const result = await collectSignals({
        projectDir: ctx.cwd,
        ...(typeof params.focus === "string" && params.focus.trim() ? { focus: params.focus.trim() } : {}),
        includeLogs,
        ...(includeLogs ? { sessionDir: ctx.sessionManager.getSessionDir() } : {}),
        now: new Date(),
      });
      const lines = result.weaknesses.map((weakness) => `- ${weakness.summary}`);
      for (const diagnostic of result.diagnostics) lines.push(`- ${diagnostic}`);
      const text = lines.length > 0 ? lines.join("\n") : "No relevant project signals found.";
      return { content: [{ type: "text", text }], details: { signals: result } };
    },
  });

  pi.registerTool({
    name: "dream_rsi_loop",
    label: "Dream-RSI Loop",
    description:
      "Run a bounded Dream-RSI loop: rank project levers, qualify a metric, explore isolated experiments, review and confirm candidates, then independently verify applied changes. Repository code runs on this host with host access.",
    promptSnippet: "Run or inspect the unattended multi-lever Dream-RSI loop. Start only after an explicit improvement request.",
    promptGuidelines: [
      "For dream_rsi_loop, use action=start when the user asks for autonomous improvement and pass consent=true after the user accepts trusted-local execution.",
      "For dream_rsi_loop, without an evaluator the default objective is to reduce declared workload wall-clock time without changing results. With an evaluator, require the user to declare its unit and score direction.",
      "For dream_rsi_loop, set the durable caps explicitly when the user names a budget; defaults are 6 campaigns, 72 agent starts, 200 evaluator runs and 120 minutes.",
      "For dream_rsi_loop, never edit .dream-rsi/loop by hand; action=status reports the durable budget, lever memory and the active campaign.",
      "For dream_rsi_loop, report the final stop reason, campaigns and verified wins, spend against the caps, and the memory path. Stop reasons include budget, deadline, blocked, cancelled, and no verifiable lever.",
    ],
    parameters: loopParams,
    async execute(_id, params: any, signal, onUpdate: any, ctx): Promise<any> {
      const action = typeof params.action === "string" ? params.action : "";
      if (action === "status") {
        const projectDir = resolveCampaignProjectDir(params.project_dir, ctx.cwd);
        if (!projectDir) return { content: [{ type: "text", text: "project_dir must name an existing local project directory." }], details: { ok: false } };
        // State lives under the resolved project, not the calling directory:
        // one extension session can inspect loops in several projects.
        const baseRoot = path.join(projectDir, ".dream-rsi");
        const loopRoot = path.join(baseRoot, "loop");
        const campaign = readCampaignStatus(baseRoot);
        const lines: string[] = [];
        const budgetPath = path.join(loopRoot, "budget.json");
        const memoryPath = path.join(loopRoot, "memory.json");
        if (!fs.existsSync(budgetPath)) {
          lines.push("No loop state yet. Run /dream-rsi loop <what you want>.");
        } else {
          try {
            const budget = JSON.parse(fs.readFileSync(budgetPath, "utf8")) as { campaigns?: number; max_campaigns?: number; agent_starts?: number; max_agent_starts?: number; evaluator_runs?: number; max_evaluator_runs?: number };
            lines.push(`Dream-RSI loop budget (durable): ${budget.campaigns}/${budget.max_campaigns} campaigns, ${budget.agent_starts}/${budget.max_agent_starts} agent starts, ${budget.evaluator_runs}/${budget.max_evaluator_runs} evaluator runs.`);
          } catch { lines.push("Loop budget is unreadable; the next start fails closed."); }
          try {
            const phases = (JSON.parse(fs.readFileSync(budgetPath, "utf8")) as { phases?: Record<string, { agent_starts?: number; evaluator_runs?: number; campaigns?: number }> }).phases ?? {};
            const rendered = Object.entries(phases)
              .filter(([, spend]) => (spend.agent_starts ?? 0) + (spend.evaluator_runs ?? 0) + (spend.campaigns ?? 0) > 0)
              .map(([phase, spend]) => `${phase}: ${spend.evaluator_runs ?? 0} evaluator run(s), ${spend.agent_starts ?? 0} agent start(s)`);
            if (rendered.length > 0) lines.push(`Spend by phase: ${rendered.join("; ")}.`);
          } catch { /* the budget line above already reports unreadable state */ }
          try {
            const stored = readStoredContract(loopRoot);
            lines.push(stored
              ? `Run contract: "${stored.contract.outcome.statement}" (${stored.contract.outcome.unit}, ${stored.contract.outcome.higherIsBetter ? "higher" : "lower"} is better), approved ${stored.approvedAt}.`
              : "No run contract stored for this project; the next start requires explicit consent and objective details.");
          } catch { lines.push("The stored run contract is unreadable; the next start fails closed."); }
          try { lines.push(mementoNotes(readMemory(memoryPath))); }
          catch { lines.push("Loop memory is unreadable; the next start fails closed."); }
        }
        lines.push(campaign ? renderCampaignStatus(campaign) : "No active campaign.");
        return { content: [{ type: "text", text: lines.join("\n") }], details: { loop: { budgetPath, memoryPath }, campaign } };
      }
      if (action === "stop") {
        const campaign = stopCampaign(path.join(resolveCampaignProjectDir(params.project_dir, ctx.cwd) ?? ctx.cwd, ".dream-rsi"));
        return campaign
          ? { content: [{ type: "text", text: `Stop requested.\n${renderCampaignStatus(campaign)}` }], details: { campaign } }
          : { content: [{ type: "text", text: "No active loop campaign." }], details: { campaign: null } };
      }
      if (action === "resume") {
        const projectDir = resolveCampaignProjectDir(params.project_dir, ctx.cwd);
        if (!projectDir) return { content: [{ type: "text", text: "project_dir must name an existing local project directory." }], details: { ok: false } };
        const baseRoot = path.join(projectDir, ".dream-rsi");
        const legacyFailure = failPausedV2Campaign(baseRoot);
        if (legacyFailure) return { content: [{ type: "text", text: legacyFailure }], details: { ok: false, reason: legacyFailure } };
        const campaign = readCampaignStatus(baseRoot);
        if (!campaign || (campaign.state.kind !== "paused" && campaign.state.kind !== "running")) {
          return { content: [{ type: "text", text: "No paused or interrupted campaign is available to resume." }], details: { ok: false, campaign } };
        }
        if (campaign.state.kind === "running" && phaseIsActive(campaign.campaignRoot, "campaign")) {
          return { content: [{ type: "text", text: "The campaign is already running." }], details: { ok: false, campaign } };
        }
        setMode(ctx, true);
        pi.appendEntry(LOOP_TARGET_ENTRY, { version: 1, project: projectDir });
        const loopRoot = path.join(baseRoot, "loop");
        const stored = readStoredContract(loopRoot);
        if (!stored) return { content: [{ type: "text", text: "The paused campaign has no saved loop contract; it cannot resume safely." }], details: { ok: false } };
        let durable: { max_campaigns?: number; max_agent_starts?: number; max_evaluator_runs?: number };
        try { durable = JSON.parse(fs.readFileSync(path.join(loopRoot, "budget.json"), "utf8")) as typeof durable; }
        catch { return { content: [{ type: "text", text: "The durable loop budget is unreadable; resume stopped without spending." }], details: { ok: false } };
        }
        if (![durable.max_campaigns, durable.max_agent_starts, durable.max_evaluator_runs].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0)) {
          return { content: [{ type: "text", text: "The durable loop budget is invalid; resume stopped without spending." }], details: { ok: false } };
        }
        const result = await runLoop({
          projectDir, baseRoot, loopRoot, contract: stored.contract, resumeActiveCampaign: true,
          limits: {
            maxCampaigns: durable.max_campaigns!, maxAgentStarts: durable.max_agent_starts!,
            maxEvaluatorRuns: durable.max_evaluator_runs!, deadlineMs: stored.contract.budgets.deadlineMs,
          },
          includeLogs: params.include_logs !== false,
          ...(ctx.sessionManager.getSessionDir() ? { sessionDir: ctx.sessionManager.getSessionDir() } : {}),
          resolveAgent: resolveAgent(ctx), signal,
          onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: `Dream-RSI resume: ${message}` }], details: { campaign: readCampaignStatus(baseRoot) } }),
          onPhaseProgress: campaignPhaseProgress(dashboardFor(ctx), baseRoot, onUpdate, () => closingSessions.has(ctx.sessionManager.getSessionId())),
          onCampaignUpdate: campaignUpdate(ctx, onUpdate, () => closingSessions.has(ctx.sessionManager.getSessionId())),
        });
        return {
          content: [{ type: "text", text: `Resumed Dream-RSI loop: ${result.stopReason}; ${result.campaigns} campaign(s), ${result.wins} verified win(s).` }],
          details: { ok: result.stopReason !== "resume failed", loop: result },
        };
      }
      if (action !== "start") return { content: [{ type: "text", text: "action must be start, status, stop or resume." }], details: { ok: false } };
      if (params.consent !== true) return { content: [{ type: "text", text: "consent must be true: discovered repository code runs on this host with host access." }], details: { ok: false } };
      setMode(ctx, true);
      const projectDir = resolveCampaignProjectDir(params.project_dir, ctx.cwd);
      if (!projectDir) return { content: [{ type: "text", text: "project_dir must name an existing local project directory." }], details: { ok: false } };
      // Progress and phase callbacks report the campaign state of the project
      // the loop actually runs in, which may differ from the calling directory.
      const baseRoot = path.join(projectDir, ".dream-rsi");
      const loopRoot = path.join(baseRoot, "loop");
      const limitResult = parseLoopLimits(params);
      if (limitResult.error || !limitResult.value) return { content: [{ type: "text", text: limitResult.error ?? "loop limits are invalid" }], details: { ok: false } };
      let limits = limitResult.value.limits;
      const campaignDefaults = limitResult.value.campaignDefaults;
      const evaluatorInput = params.evaluator;
      const evaluator = evaluatorInput === undefined ? undefined : evaluatorInput;
      if (evaluator !== undefined && (typeof params.unit !== "string" || !params.unit.trim() || typeof params.higher_is_better !== "boolean")) {
        return { content: [{ type: "text", text: "unit and higher_is_better are required when an evaluator is supplied." }], details: { ok: false } };
      }
      const asList = (key: string): string[] => {
        const value = params[key];
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.some((entry: unknown) => typeof entry !== "string" || !entry.trim())) throw new Error(`${key} must be an array of non-empty strings`);
        return value.map((entry: string) => entry.trim());
      };
      let contract: ReturnType<typeof normalizeRunContract>;
      try {
        const contractFields = ["focus", "unit", "higher_is_better", "minimum_gain", "proxy_justification", "evaluator", "scope_roots", "protected_assets", "gates", "command_categories", "env_allowlist", "max_campaigns", "max_agent_starts", "max_evaluator_runs", "deadline_minutes"];
        const hasContractFields = contractFields.some((key) => params[key] !== undefined);
        const stored = readStoredContract(loopRoot);
        if (stored && !hasContractFields) {
          contract = stored.contract;
          limits = {
            maxCampaigns: contract.budgets.maxCampaigns,
            maxAgentStarts: contract.budgets.maxAgentStarts,
            maxEvaluatorRuns: contract.budgets.maxEvaluatorRuns,
            deadlineMs: contract.budgets.deadlineMs,
          };
        } else {
        const minimumGain = params.minimum_gain ?? "5%";
        const statement = typeof params.focus === "string" && params.focus.trim()
          ? params.focus.trim()
          : "Reduce the wall-clock time of the project's declared workloads without changing their results";
        const hasEvaluator = evaluator !== undefined;
        const categories = asList("command_categories");
        contract = normalizeRunContract({
          version: 1,
          outcome: {
            statement,
            unit: typeof params.unit === "string" && params.unit.trim() ? params.unit.trim() : "ms",
            higherIsBetter: typeof params.higher_is_better === "boolean" ? params.higher_is_better : false,
            minimumUsefulGain: minimumGain,
            ...(typeof params.proxy_justification === "string" && params.proxy_justification.trim() ? { proxyJustification: params.proxy_justification.trim() } : {}),
            ...(hasEvaluator ? { evaluator } : {}),
          },
          preserved: { gates: asList("gates") },
          scope: { roots: asList("scope_roots"), protectedAssets: asList("protected_assets") },
          execution: { consent: true, envAllowlist: asList("env_allowlist"), allowedCommandCategories: categories.length ? categories : ["test", "benchmark", "build", "custom"] },
          budgets: {
            maxCampaigns: limits.maxCampaigns,
            maxAgentStarts: limits.maxAgentStarts,
            maxEvaluatorRuns: limits.maxEvaluatorRuns,
            deadlineMs: limits.deadlineMs,
            falseAcceptBudget: 0.10,
          },
        });
        }
      } catch (error) {
        return { content: [{ type: "text", text: `loop settings are invalid: ${error instanceof Error ? error.message : String(error)}` }], details: { ok: false } };
      }
      const agentArgs = stringArray(params.agent_args);
      if (params.agent_args !== undefined && !agentArgs) {
        return { content: [{ type: "text", text: "agent_args must be an array of strings" }], details: { ok: false } };
      }
      const taskDefaults: Partial<TaskConfig> = {};
      if ((typeof params.agent_command === "string" && params.agent_command.trim()) || agentArgs) {
        taskDefaults.agent = {
          ...defaultTask().agent,
          ...(typeof params.agent_command === "string" && params.agent_command.trim() ? { command: params.agent_command.trim() } : {}),
          ...(agentArgs ? { args: agentArgs } : {}),
        };
      }
      if (typeof params.agent_timeout_ms === "number") taskDefaults.agent_timeout_ms = params.agent_timeout_ms;
      if (typeof params.evaluator_timeout_ms === "number") taskDefaults.evaluator_timeout_ms = params.evaluator_timeout_ms;
      setMode(ctx, true);
      // Retain the loop target in the session so the advertised stop and status can reach a
      // loop that runs outside the calling directory.
      pi.appendEntry(LOOP_TARGET_ENTRY, { version: 1, project: projectDir });
      const includeLogs = params.include_logs !== false;
      const result = await runLoop({
        projectDir,
        limits,
        campaignDefaults,
        ...(typeof params.focus === "string" && params.focus.trim() ? { focus: params.focus.trim() } : {}),
        includeLogs,
        ...(includeLogs && ctx.sessionManager.getSessionDir() ? { sessionDir: ctx.sessionManager.getSessionDir() } : {}),
        contract,
        ...(Object.keys(taskDefaults).length > 0 ? { taskDefaults } : {}),
        resolveAgent: resolveAgent(ctx),
        signal,
        onProgress: (message) => {
          if (!closingSessions.has(ctx.sessionManager.getSessionId())) ctx.ui.setStatus("dream-rsi", `dream-rsi: loop — ${message.replace(/^loop:\s*/, "").slice(0, 48)}`);
          onUpdate?.({ content: [{ type: "text", text: `Dream-RSI loop: ${message}` }], details: { campaign: readCampaignStatus(baseRoot) } });
        },
        onPhaseProgress: campaignPhaseProgress(dashboardFor(ctx), baseRoot, onUpdate, () => closingSessions.has(ctx.sessionManager.getSessionId())),
        onCampaignUpdate: campaignUpdate(ctx, onUpdate, () => closingSessions.has(ctx.sessionManager.getSessionId())),
      });
      const lines = [
        `Dream-RSI loop finished: ${result.stopReason}`,
        `  campaigns this run: ${result.campaigns} (${result.wins} verified win(s))`,
        `  spend this run: ${result.agentStarts} agent start(s), ${result.evaluatorRuns} evaluator run(s)`,
        `  levers ranked: ${result.inventory?.levers.length ?? 0}; memory: ${result.memoryPath}`,
        ...(result.contract ? [`  contract: ${result.contract.fingerprint.slice(0, 12)} (approved ${result.contract.approvedAt})`] : []),
        ...(result.verifications.length > 0
          ? [`  independent post-apply checks: ${result.verifications.filter((check) => check.passed).length}/${result.verifications.length} passed`]
          : []),
      ];
      try {
        const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8")) as { campaigns?: number; max_campaigns?: number; agent_starts?: number; max_agent_starts?: number; evaluator_runs?: number; max_evaluator_runs?: number };
        lines.push(`  durable caps: ${budget.campaigns}/${budget.max_campaigns} campaigns, ${budget.agent_starts}/${budget.max_agent_starts} agent starts, ${budget.evaluator_runs}/${budget.max_evaluator_runs} evaluator runs`);
      } catch { /* the loop just wrote the file; a missing report line is not fatal */ }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { loop: result } };
    },
  });

  // -- command -------------------------------------------------------------

  pi.registerCommand("dream-rsi", {
    description: "Dream-RSI: assess | loop | watch | status | stop | resume",
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
          ? "Data from a pre-3.0 manual campaign is in .dream-rsi/ (task.json, history/). The 3.0 loop does not use it."
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
      if (verb === "loop") {
        setMode(ctx, true);
        const focus = rest.trim();
        sendWhenReady(`Start the unattended Dream-RSI loop${focus ? ` focused on: ${focus}` : ""}. Call dream_rsi_loop with action=start${focus ? ` and focus ${JSON.stringify(focus)}` : ""}. The loop ranks levers, calibrates metrics and chains bounded verified campaigns; it stops on its own at the durable budget.`);
        report("Dream-RSI unattended loop starting: bounded campaigns until a stop rule. Use /dream-rsi status to inspect or /dream-rsi stop to halt the active campaign.");
        return;
      }
      if (verb === "improve" || verb === "start") {
        report(`${verb} was removed in 3.0. Use /dream-rsi loop.`);
        return;
      }
      if (verb === "status") {
        let where = root;
        if (!readCampaignStatus(root)) {
          const target = loopTargetRoot(ctx);
          if (target && target !== root && readCampaignStatus(target)) where = target;
        }
        const campaign = readCampaignStatus(where);
        const lines = [campaign ? renderCampaignStatus(campaign) : "No campaign yet. Run /dream-rsi loop."];
        if (campaign && where !== root) lines.push(`(loop target: ${path.dirname(where)})`);
        const notice = manualDataNotice();
        if (notice) lines.push(notice);
        report(lines.join("\n"));
        return;
      }
      if (verb === "stop") {
        let where = root;
        if (!readCampaignStatus(root)) {
          const target = loopTargetRoot(ctx);
          if (target && target !== root && readCampaignStatus(target)) where = target;
        }
        const campaign = stopCampaign(where);
        report(campaign
          ? where === root
            ? `Stop requested.\n${renderCampaignStatus(campaign)}`
            : `Stop requested for the loop target ${path.dirname(where)}.\n${renderCampaignStatus(campaign)}`
          : "No active campaign is recorded here.", campaign ? "info" : "error");
        return;
      }
      if (verb === "resume") {
        if (rest) {
          report(`resume ${rest} was removed in 3.0. Use /dream-rsi loop.`);
          return;
        }
        const campaign = readCampaignStatus(root);
        const interrupted = campaign?.state.kind === "running";
        const canResume = campaign?.state.kind === "paused" || interrupted;
        if (interrupted && campaign && phaseIsActive(campaign.campaignRoot, "campaign")) {
          report("The campaign is already running. Use /dream-rsi status, watch or stop.", "info");
        } else if (canResume) {
          setMode(ctx, true);
          sendWhenReady("Resume the saved Dream-RSI loop using dream_rsi_loop with action=resume.");
          report(interrupted
            ? "Recovering the interrupted Dream-RSI campaign through its guarded resume path."
            : "Resuming the paused Dream-RSI campaign with its saved goal and remaining budget.");
        } else {
          report("No paused campaign is available to resume.", "error");
        }
        return;
      }
      if (verb === "watch") {
        if (rest) {
          report("watch takes no arguments.");
          return;
        }
        const campaign = readCampaignStatus(root);
        if (!campaign) {
          const notice = manualDataNotice();
          report(notice ? `No campaign yet. Run /dream-rsi loop.\n${notice}` : "No campaign yet. Run /dream-rsi loop.", "info");
          return;
        }
        const summary = await dashboardFor(ctx).watch(resolveWatchRoot(campaign));
        if (summary) pi.sendMessage({ customType: "dream-rsi/watch", content: summary, display: true }, { triggerTurn: false });
        return;
      }
      const removed = new Set(["create", "suggest", "best", "live", "dream", "run", "off"]);
      if (removed.has(verb)) {
        report(`${verb} was removed in 3.0. Use /dream-rsi loop.`);
        return;
      }
      report(`Unknown Dream-RSI command. Use /dream-rsi help.`);
    },
  });
  // -- lifecycle -----------------------------------------------------------

  pi.registerShortcut("ctrl+shift+d", { description: "Watch the Dream-RSI campaign", handler: async (ctx) => {
    const campaign = readCampaignStatus(dreamRoot(ctx));
    if (!campaign) { ctx.ui.notify("No campaign yet. Run /dream-rsi loop.", "info"); return; }
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
    "  /dream-rsi assess [what you want] [--no-logs]  rank project levers (read-only)",
    "  /dream-rsi loop [what you want]  unattended bounded loop over levers",
    "  /dream-rsi watch  open the campaign dashboard · Ctrl+Shift+D",
    "  /dream-rsi status | stop | resume  inspect or control the campaign",
  ].join("\n");
}

function commandCompletions(prefix: string) {
  const query = prefix.trimStart().replace(/\s+/g, " ");
  const choices = [
    { value: "assess", label: "assess [what you want] [--no-logs]", description: "Rank project levers without changing files" },
    { value: "loop", label: "loop [what you want]", description: "Run the unattended bounded loop over ranked levers" },
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
  if (/^\/dream-rsi\s+(assess|status|watch|stop|resume|loop|help|\?)\b/i.test(input)) return false;
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
  return `  loaded runtime: ${runtime.extensionDir} (package ${runtime.packageVersion ?? "unknown"})\n  campaign module: ${runtime.campaignModule}\n  default evaluator timeout: ${runtime.defaultEvaluatorTimeoutMs}ms`;
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
    ...(campaign.check ? renderCampaignCheckStatus(campaign.check) : []),
    renderCampaignRuntime(runtime),
  ];
  if (campaign.health) lines.push(
    `  health: ${(campaign.health.timeoutRate * 100).toFixed(1)}% timeouts; ${(campaign.health.noEditRate * 100).toFixed(1)}% known no-edit attempts`,
    `  live/confirm sign disagreements: ${campaign.health.liveConfirmSignDisagreements}`,
    `  direction anomalies: ${campaign.health.directionAnomalies}`,
    `  duplicate patch rate: ${(campaign.health.duplicateRate * 100).toFixed(1)}%`,
    `  verified wins per agent start: ${(campaign.health.wins / Math.max(campaign.agentStarts, 1)).toFixed(3)}`,
  );
  if (state.kind === "paused" || state.kind === "complete" || state.kind === "failed") lines.push(`  stopped because: ${state.reason}`);
  if ("stopReason" in campaign && campaign.stopReason) lines.push(`  stop reason: ${campaign.stopReason}`);
  for (const rejection of campaign.rejections.slice(-3)) lines.push(`  rejected ${rejection.cell} (${rejection.stage}): ${rejection.reasons.join("; ")}`);
  return lines.join("\n");
}

/**
 * Render the evaluator preflight evidence persisted with a campaign. The check may be
 * partial (readings persisted after an abort) or complete, so both `reportPath` and the
 * diagnoses list are optional here.
 */
function renderCampaignCheckStatus(check: NonNullable<CampaignStatus["check"]>): string[] {
  const lines = [`  evaluator check: ${check.qualified ? "qualified" : "unqualified"}; ${check.runs.length} reading${check.runs.length === 1 ? "" : "s"}`];
  check.runs.forEach((run, index) => {
    const log = run.logPath === null ? "; seeded" : run.logPath ? `; log ${run.logPath}` : "";
    const result = run.valid ? `score ${run.score}` : `${run.failClass}${run.error ? `: ${run.error}` : ""}`;
    lines.push(`    reading ${index + 1}: ${Math.ceil(run.durationMs / 1000)}s, exit ${run.code ?? "unknown"}, ${result}${log}`);
  });
  for (const diagnosis of check.diagnoses) lines.push(`    diagnosis: ${diagnosis}`);
  if (check.reportPath) lines.push(`    report: ${check.reportPath}`);
  return lines;
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

function parseLoopLimits(params: Record<string, unknown>): { value?: { limits: LoopLimits; campaignDefaults: { maxCycles: number; maxAgentStarts: number; maxEvaluatorRuns: number; deadlineMs: number } }; error?: string } {
  const read = (input: string, fallback: number, maximum: number): number | string => {
    const value = params[input];
    if (value === undefined) return fallback;
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maximum
      ? value
      : `${input} must be an integer from 1 to ${maximum}`;
  };
  const values = {
    maxCampaigns: read("max_campaigns", 6, 64),
    maxAgentStarts: read("max_agent_starts", 72, 1000),
    maxEvaluatorRuns: read("max_evaluator_runs", 200, 5000),
    deadlineMinutes: read("deadline_minutes", 120, 720),
  };
  for (const value of Object.values(values)) {
    if (typeof value === "string") return { error: value };
  }
  const numbers = values as Record<keyof typeof values, number>;
  return {
    value: {
      limits: {
        maxCampaigns: numbers.maxCampaigns,
        maxAgentStarts: numbers.maxAgentStarts,
        maxEvaluatorRuns: numbers.maxEvaluatorRuns,
        deadlineMs: numbers.deadlineMinutes * 60_000,
      },
      campaignDefaults: { maxCycles: 2, maxAgentStarts: 18, maxEvaluatorRuns: 48, deadlineMs: 60 * 60 * 1000 },
    },
  };
}
