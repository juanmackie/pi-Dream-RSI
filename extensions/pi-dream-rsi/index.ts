/**
 * Dream-RSI assessment and autonomous improvement loop for pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { Dashboard } from "./dashboard.ts";
import { campaignRuntimeDiagnostics, failPausedV2Campaign, readCampaignStatus, runCampaign, stopCampaign, type CampaignRuntimeDiagnostics, type CampaignStatus } from "./engine/campaign.ts";
import { runLoop, type LoopLimits } from "./engine/loop.ts";
import { copyWorkspace, runAgent } from "./agent/runner.ts";
import { writeFileAtomic } from "./engine/fsutil.ts";
import { pathProtected, pathWithin } from "./engine/scope.ts";
import { phaseIsActive } from "./engine/ownership.ts";
import { progressSummary, type ProgressSnapshot } from "./engine/progress.ts";
import { mementoNotes, readMemory } from "./engine/search.ts";
import { normalizeRunContract, readStoredContract } from "./engine/intake.ts";
import { collectSignals } from "./engine/signals.ts";
import { defaultTask, type TaskConfig } from "./engine/task.ts";
import { SKILLS_DIR } from "./layout.ts";

const MODE_ENTRY = "pi-dream-rsi/mode";
const LOOP_TARGET_ENTRY = "pi-dream-rsi/loop-target";

/**
 * A loop run in this session. The slot is reserved before consent is asked for, so a
 * second command cannot start a run that the first one would overwrite.
 */
interface LoopRunSlot {
  /** The abort controller of the run; it also covers the consent dialog. */
  controller: AbortController;
  /** Canonical project owned by this session's active run. */
  projectDir: string;
}
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
    action: { type: "string", enum: ["start", "status", "stop", "resume", "confirm"], description: "Start, inspect, stop, resume, or continue saved confirmation pairs." },
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
      output: { type: "string", enum: ["score-json", "stdout-number", "stdout-json"] },
      inputs: { type: "array", items: { type: "string" } },
    }, required: ["argv", "output"], additionalProperties: false },
    evaluator_bootstrap: { type: "object", properties: {
      authorized: { type: "boolean", description: "Must be true to let an agent create a pinned workload in an isolated project copy." },
      paths: { type: "array", items: { type: "string" }, description: "Exact project-relative files the bootstrap agent may create or update; every path must be in approved editable scope." },
    }, required: ["authorized", "paths"], additionalProperties: false },
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
  /** One running or reserved loop per session; the controller aborts the run. */
  const activeLoopRuns = new Map<string, LoopRunSlot>();
  const loopIndicators = new Map<string, { timer: ReturnType<typeof setInterval> | undefined; frame: number }>();
  const reserveLoopRun = (sessionId: string, projectDir: string, controller = new AbortController()): LoopRunSlot | null => {
    if (activeLoopRuns.has(sessionId)) return null;
    const slot = { controller, projectDir: path.resolve(projectDir) };
    activeLoopRuns.set(sessionId, slot);
    return slot;
  };
  const releaseLoopRun = (sessionId: string, slot: LoopRunSlot): void => {
    if (activeLoopRuns.get(sessionId) === slot) activeLoopRuns.delete(sessionId);
  };
  const signalForLoopRun = (signal: AbortSignal | undefined, slot: LoopRunSlot): AbortSignal =>
    signal ? AbortSignal.any([signal, slot.controller.signal]) : slot.controller.signal;
  const alreadyRunning = (slot?: LoopRunSlot): any => ({
    content: [{ type: "text", text: slot?.controller.signal.aborted
      ? "A Dream-RSI loop is still stopping in this session. Wait for it to finish before starting another; use /dream-rsi status to check progress."
      : "A Dream-RSI loop is already running in this session. Use /dream-rsi status, watch or stop." }],
    details: { ok: false },
  });
  const setStatusUnlessAnimating = (ctx: ExtensionContext, sessionId: string, status: string | undefined): void => {
    if (!closingSessions.has(sessionId) && !loopIndicators.has(sessionId)) ctx.ui.setStatus("dream-rsi", status);
  };
  const withLoopIndicator = async <T>(ctx: ExtensionContext, sessionId: string, run: () => Promise<T>): Promise<T> => {
    if (ctx.mode !== "tui") return run();
    // Every caller owns the session's activeLoopRuns slot before entering this helper.
    const frames = ["◳", "◲", "◱", "◰"];
    const indicator = { frame: 0, timer: undefined as ReturnType<typeof setInterval> | undefined };
    loopIndicators.set(sessionId, indicator);
    const showLooping = (): void => {
      if (closingSessions.has(sessionId)) return;
      ctx.ui.setStatus("dream-rsi", `dream-rsi: ${frames[indicator.frame]} looping`);
      indicator.frame = (indicator.frame + 1) % frames.length;
    };
    showLooping();
    indicator.timer = setInterval(showLooping, 150);
    try {
      return await run();
    } finally {
      if (indicator.timer) clearInterval(indicator.timer);
      if (loopIndicators.get(sessionId) === indicator) {
        loopIndicators.delete(sessionId);
        if (!closingSessions.has(sessionId)) ctx.ui.setStatus("dream-rsi", modes.get(sessionId) ? "dream-rsi: active" : undefined);
      }
    }
  };
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
    setStatusUnlessAnimating(ctx, ctx.sessionManager.getSessionId(), enabled ? "dream-rsi: active" : undefined);
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
    setStatusUnlessAnimating(ctx, id, active ? "dream-rsi: active" : undefined);
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
  type LoopUpdate = (update: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void;

  /**
   * Shared start path for the dream_rsi_loop tool and the /dream-rsi loop command.
   * The command runs this detached so the chat turn does not block on the campaign.
   */
  const startLoop = async (params: Record<string, any>, ctx: ExtensionContext, signal: AbortSignal | undefined, onUpdate?: LoopUpdate): Promise<any> => {
    if (params.consent !== true) return { content: [{ type: "text", text: "consent must be true: discovered repository code runs on this host with host access." }], details: { ok: false } };
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
    let evaluatorBootstrap: { authorized: boolean; paths: string[]; run: (input: { projectDir: string; contract: ReturnType<typeof normalizeRunContract>; focus?: string; scopeRoots: string[]; deadlineMs: number; beforeAgentSpawn: () => void; signal?: AbortSignal }) => Promise<{ validatedPaths: string[] }> } | undefined;
    if (params.evaluator_bootstrap !== undefined) {
      const config = params.evaluator_bootstrap as { authorized?: unknown; paths?: unknown };
      if (!config || typeof config !== "object" || typeof config.authorized !== "boolean" || !Array.isArray(config.paths)
        || config.paths.length === 0 || config.paths.length > 10 || config.paths.some((entry) => typeof entry !== "string" || !entry.trim())) {
        return { content: [{ type: "text", text: "evaluator_bootstrap must set authorized and a non-empty exact paths array." }], details: { ok: false } };
      }
      const paths = config.paths.map((entry) => (entry as string).replace(/\\/g, "/").replace(/^\.\//, ""));
      if (paths.some((entry) => entry === "" || entry.startsWith("/") || entry.split("/").some((part) => !part || part === "." || part === "..")) || new Set(paths).size !== paths.length) {
        return { content: [{ type: "text", text: "evaluator_bootstrap.paths must contain unique normalized project-relative paths." }], details: { ok: false } };
      }
      if (config.authorized) {
        const agent = taskDefaults.agent ?? defaultTask().agent;
        const timeoutMs = taskDefaults.agent_timeout_ms ?? defaultTask().agent_timeout_ms;
        evaluatorBootstrap = {
          authorized: true,
          paths,
          run: async ({ projectDir: target, contract: approvedContract, focus, scopeRoots, deadlineMs, beforeAgentSpawn, signal: bootstrapSignal }) => {
            if (bootstrapSignal?.aborted) throw new Error("bootstrap cancelled before it started");
            if (deadlineMs <= 0) throw new Error("bootstrap deadline elapsed before the agent started");
            const bootstrapDeadlineAt = Date.now() + deadlineMs;
            const scratch = path.join(loopRoot, "bootstrap", crypto.randomUUID());
            try {
              await copyWorkspace(target, scratch, { exclude: [path.join(target, ".git"), path.join(target, ".dream-rsi")] });
              const remainingAfterCopyMs = bootstrapDeadlineAt - Date.now();
              if (bootstrapSignal?.aborted) throw new Error("bootstrap cancelled while preparing its workspace");
              if (remainingAfterCopyMs <= 0) throw new Error("bootstrap deadline elapsed while preparing its workspace");
              const prompt = [
                "Create the smallest deterministic benchmark workload and pinned evaluator needed to measure this approved objective.",
                `Objective: ${approvedContract.outcome.statement}`,
                `Metric unit: ${approvedContract.outcome.unit}; higher is better: ${approvedContract.outcome.higherIsBetter}.`,
                focus ? `Additional workload details: ${focus}` : "",
                `You may create or update only these exact project-relative files: ${paths.join(", ")}.`,
                "Do not change the declared metric, direction, correctness behavior, or unrelated source files.",
                "Make the workload discoverable as a benchmark command in the existing project manifest when one of the allowed files permits it.",
                "Use deterministic pinned synthetic inputs when the objective requires them. Ensure the command runs locally without network access.",
                "Do not claim a measurement result. The host will run the generated workload and existing gates independently.",
              ].filter(Boolean).join("\n");
              const run = await runAgent({ agent, resolveAgent: resolveAgent(ctx), cwd: scratch, prompt, timeoutMs: Math.max(1, Math.min(timeoutMs, remainingAfterCopyMs)), signal: bootstrapSignal, beforeSpawn: beforeAgentSpawn, logPath: path.join(loopRoot, "bootstrap", "agent.log") });
              if (!run.ok) throw new Error(run.spawnError ?? (run.timedOut ? "bootstrap agent timed out" : `bootstrap agent exited ${run.code}`));
              const pendingWrites: Array<{ relative: string; targetPath: string; contents: string; previous: string | null }> = [];
              let totalBootstrapBytes = 0;
              for (const relative of paths) {
                const source = path.resolve(scratch, relative);
                const targetPath = path.resolve(target, relative);
                const assertSafeFilePath = (base: string, absolute: string): void => {
                  const within = path.relative(path.resolve(base), absolute);
                  if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error(`bootstrap path escapes its workspace: ${relative}`);
                  let current = path.resolve(base);
                  const parts = path.relative(current, absolute).split(path.sep);
                  for (const [index, part] of parts.entries()) {
                    current = path.join(current, part);
                    if (!fs.existsSync(current)) continue;
                    const stat = fs.lstatSync(current);
                    if (stat.isSymbolicLink()) throw new Error(`bootstrap path uses a symbolic link: ${relative}`);
                    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`bootstrap parent is not a directory: ${relative}`);
                    if (index === parts.length - 1 && !stat.isFile()) throw new Error(`bootstrap path is not a regular file: ${relative}`);
                  }
                };
                assertSafeFilePath(scratch, source);
                assertSafeFilePath(target, targetPath);
                if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) throw new Error(`bootstrap did not create a regular file: ${relative}`);
                const sourceStat = fs.statSync(source);
                if (sourceStat.size > 2 * 1024 * 1024) throw new Error(`bootstrap file exceeds the 2 MiB limit: ${relative}`);
                totalBootstrapBytes += sourceStat.size;
                if (totalBootstrapBytes > 5 * 1024 * 1024) throw new Error("bootstrap output exceeds the 5 MiB total limit");
                if (!pathWithin(relative, scopeRoots) || pathProtected(relative, approvedContract.scope.protectedAssets)) throw new Error(`bootstrap path is outside editable scope or protected: ${relative}`);
                const contents = fs.readFileSync(source, "utf8");
                if (contents.includes("\0")) throw new Error(`bootstrap produced a non-text file: ${relative}`);
                const previous = fs.existsSync(targetPath) && fs.lstatSync(targetPath).isFile() ? fs.readFileSync(targetPath, "utf8") : null;
                pendingWrites.push({ relative, targetPath, contents, previous });
              }
              const validatedPaths = pendingWrites.map(({ relative }) => relative);
              for (const { relative, targetPath, contents, previous } of pendingWrites) {
                if (bootstrapSignal?.aborted) throw new Error("bootstrap cancelled before copy-back");
                if (Date.now() >= bootstrapDeadlineAt) throw new Error("bootstrap deadline elapsed before copy-back");
                if (!pathWithin(relative, scopeRoots) || pathProtected(relative, approvedContract.scope.protectedAssets)) throw new Error(`bootstrap path became out of scope or protected before copy-back: ${relative}`);
                if (previous === contents) continue;
                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                writeFileAtomic(targetPath, contents, true);
              }
              return { validatedPaths };
            } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
          },
        };
      } else evaluatorBootstrap = { authorized: false, paths, run: async () => ({ validatedPaths: [] }) };
    }
    setMode(ctx, true);
    // Retain the loop target in the session so the advertised stop and status can reach a
    // loop that runs outside the calling directory.
    pi.appendEntry(LOOP_TARGET_ENTRY, { version: 1, project: projectDir });
    const includeLogs = params.include_logs !== false;
    const sessionId = ctx.sessionManager.getSessionId();
    let result: Awaited<ReturnType<typeof runLoop>>;
    result = await withLoopIndicator(ctx, sessionId, () => runLoop({
        projectDir,
        limits,
        campaignDefaults,
        ...(typeof params.focus === "string" && params.focus.trim() ? { focus: params.focus.trim() } : {}),
        includeLogs,
        ...(includeLogs && ctx.sessionManager.getSessionDir() ? { sessionDir: ctx.sessionManager.getSessionDir() } : {}),
        contract,
        ...(Object.keys(taskDefaults).length > 0 ? { taskDefaults } : {}),
        ...(evaluatorBootstrap ? { evaluatorBootstrap } : {}),
        resolveAgent: resolveAgent(ctx),
        signal,
        onProgress: (message) => {
          setStatusUnlessAnimating(ctx, sessionId, `dream-rsi: loop — ${message.replace(/^loop:\s*/, "").slice(0, 48)}`);
          onUpdate?.({ content: [{ type: "text", text: `Dream-RSI loop: ${message}` }], details: { campaign: readCampaignStatus(baseRoot) } });
        },
        onPhaseProgress: campaignPhaseProgress(dashboardFor(ctx), baseRoot, onUpdate, () => closingSessions.has(sessionId)),
        onCampaignUpdate: campaignUpdate(ctx, onUpdate, () => closingSessions.has(sessionId), () => loopIndicators.has(sessionId)),
      }));
    const lines = [
      `Dream-RSI loop finished (${result.stopCode}): ${result.stopReason}`,
      `  campaigns this run: ${result.campaigns} (${result.wins} verified win(s))`,
      `  spend this run: ${result.agentStarts} agent start(s), ${result.evaluatorRuns} evaluator run(s) (${result.preflightEvaluatorRuns} preflight; ${result.campaignEvaluatorRuns} campaign)`,
      `  preflight: ${result.preflight.status}${result.preflight.checks.length ? ` — ${result.preflight.checks.filter((check) => check.status === "blocked").length} blocker(s), ${result.preflight.checks.length} check(s)` : " — not run"}`,
      ...result.preflight.checks.map((check) => `    ${check.status}: ${check.name} — ${check.reason}${check.remedy ? ` Next step: ${check.remedy}` : ""}`),
      `  levers ranked: ${result.inventory?.levers.length ?? 0}; memory: ${result.memoryPath}`,
      ...(result.contract ? [`  trusted-local contract recorded ${result.contract.fingerprint.slice(0, 12)} (${result.contract.approvedAt}); this is consent/settings, not campaign readiness`] : []),
      ...(result.verifications.length > 0
        ? [`  independent post-apply checks: ${result.verifications.filter((check) => check.passed).length}/${result.verifications.length} passed`]
        : []),
    ];
    try {
      const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8")) as { campaigns?: number; max_campaigns?: number; agent_starts?: number; max_agent_starts?: number; evaluator_runs?: number; max_evaluator_runs?: number };
      lines.push(`  durable caps: ${budget.campaigns}/${budget.max_campaigns} campaigns, ${budget.agent_starts}/${budget.max_agent_starts} agent starts, ${budget.evaluator_runs}/${budget.max_evaluator_runs} evaluator runs`);
    } catch { /* the loop just wrote the file; a missing report line is not fatal */ }
    return { content: [{ type: "text", text: lines.join("\n") }], details: { loop: result } };
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
          const reportPath = path.join(loopRoot, "latest-report.json");
          if (fs.existsSync(reportPath)) {
            try {
              const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { version?: number; stopCode?: string; stopReason?: string; campaigns?: number; wins?: number; evaluatorRuns?: number; preflightEvaluatorRuns?: number; campaignEvaluatorRuns?: number; agentStarts?: number; preflight?: { status?: string; checks?: Array<{ name?: string; status?: string; reason?: string; remedy?: string }> } };
              if (report.version === 1 && typeof report.stopCode === "string" && typeof report.stopReason === "string"
                && [report.campaigns, report.wins, report.evaluatorRuns, report.agentStarts].every((value) => Number.isSafeInteger(value) && value! >= 0)) {
                lines.push(`Latest run report: ${report.stopCode} — ${report.stopReason.slice(0, 300)}; ${report.campaigns} campaign(s), ${report.wins} verified win(s), ${report.evaluatorRuns} evaluator run(s) (${report.preflightEvaluatorRuns ?? 0} preflight, ${report.campaignEvaluatorRuns ?? 0} campaign), ${report.agentStarts} agent start(s).`);
                for (const check of report.preflight?.checks ?? []) lines.push(`  ${check.status ?? "unknown"}: ${check.name ?? "preflight"} — ${(check.reason ?? "").slice(0, 300)}${check.remedy ? ` Next step: ${check.remedy.slice(0, 300)}` : ""}`);
              } else lines.push("Latest run report is invalid; the next run remains governed by the durable budget and contract.");
            } catch { lines.push("Latest run report is unreadable."); }
          }
        }
        lines.push(campaign ? renderCampaignStatus(campaign) : "No active campaign.");
        return { content: [{ type: "text", text: lines.join("\n") }], details: { loop: { budgetPath, memoryPath, reportPath: path.join(loopRoot, "latest-report.json") }, campaign } };
      }
      if (action === "stop") {
        const sessionId = ctx.sessionManager.getSessionId();
        const slot = activeLoopRuns.get(sessionId);
        const hasRequestedProject = params.project_dir !== undefined;
        const requestedProject = hasRequestedProject ? resolveCampaignProjectDir(params.project_dir, ctx.cwd) : null;
        const retainedTarget = !hasRequestedProject ? loopTargetRoot(ctx) : null;
        const targetProject = hasRequestedProject
          ? requestedProject
          : slot?.projectDir ?? (retainedTarget ? path.dirname(retainedTarget) : ctx.cwd);
        const aborted = Boolean(slot && targetProject && path.resolve(targetProject) === slot.projectDir);
        if (aborted) slot!.controller.abort();
        const campaign = targetProject ? stopCampaign(path.join(targetProject, ".dream-rsi")) : null;
        const lines = campaign
          ? [`Stop requested.\n${renderCampaignStatus(campaign)}`]
          : [aborted ? "The running Dream-RSI loop was asked to stop; no campaign is recorded yet." : "No active loop campaign."];
        if (slot && !aborted) {
          const state = slot.controller.signal.aborted ? "still stopping" : "still running";
          lines.push(`A loop is ${state} in this session for ${slot.projectDir}; the requested project did not match, so that run was not stopped.`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { campaign, aborted, running: Boolean(slot) } };
      }
      if (action === "resume" || action === "confirm") {
        const sessionId = ctx.sessionManager.getSessionId();
        const activeSlot = activeLoopRuns.get(sessionId);
        if (activeSlot) return alreadyRunning(activeSlot);
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
        if (action === "confirm" && !campaign.pendingConfirmation) {
          return { content: [{ type: "text", text: "No saved candidate confirmation is pending; use action=resume for an interrupted campaign." }], details: { ok: false, campaign } };
        }
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
        const slot = reserveLoopRun(sessionId, projectDir);
        if (!slot) return alreadyRunning(activeLoopRuns.get(sessionId));
        setMode(ctx, true);
        pi.appendEntry(LOOP_TARGET_ENTRY, { version: 1, project: projectDir });
        try {
          const result = await withLoopIndicator(ctx, sessionId, () => runLoop({
            projectDir, baseRoot, loopRoot, contract: stored.contract, resumeActiveCampaign: true, confirmationOnly: action === "confirm",
            limits: {
              maxCampaigns: durable.max_campaigns!, maxAgentStarts: durable.max_agent_starts!,
              maxEvaluatorRuns: durable.max_evaluator_runs!, deadlineMs: stored.contract.budgets.deadlineMs,
            },
            includeLogs: params.include_logs !== false,
            ...(ctx.sessionManager.getSessionDir() ? { sessionDir: ctx.sessionManager.getSessionDir() } : {}),
            resolveAgent: resolveAgent(ctx), signal: signalForLoopRun(signal, slot),
            onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: `Dream-RSI resume: ${message}` }], details: { campaign: readCampaignStatus(baseRoot) } }),
            onPhaseProgress: campaignPhaseProgress(dashboardFor(ctx), baseRoot, onUpdate, () => closingSessions.has(sessionId)),
            onCampaignUpdate: campaignUpdate(ctx, onUpdate, () => closingSessions.has(sessionId), () => loopIndicators.has(sessionId)),
          }));
          return {
            content: [{ type: "text", text: `${action === "confirm" ? "Continued saved confirmation" : "Resumed Dream-RSI loop"} (${result.stopCode}): ${result.stopReason}; ${result.campaigns} campaign(s), ${result.wins} verified win(s).` }],
            details: { ok: result.stopReason !== "resume failed", loop: result },
          };
        } finally { releaseLoopRun(sessionId, slot); }
      }
      if (action !== "start") return { content: [{ type: "text", text: "action must be start, status, stop, resume or confirm." }], details: { ok: false } };
      if (params.consent !== true) return await startLoop(params, ctx, signal, onUpdate);
      const projectDir = resolveCampaignProjectDir(params.project_dir, ctx.cwd);
      if (!projectDir) return { content: [{ type: "text", text: "project_dir must name an existing local project directory." }], details: { ok: false } };
      const sessionId = ctx.sessionManager.getSessionId();
      const slot = reserveLoopRun(sessionId, projectDir);
      if (!slot) return alreadyRunning(activeLoopRuns.get(sessionId));
      try { return await startLoop(params, ctx, signalForLoopRun(signal, slot), onUpdate); }
      finally { releaseLoopRun(sessionId, slot); }
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
        const tokens = rest.split(/\s+/).filter(Boolean);
        const explicitConsent = tokens.includes("--consent");
        const includeLogs = !tokens.includes("--no-logs");
        const focus = tokens.filter((token) => token !== "--consent" && token !== "--no-logs").join(" ");
        const sessionId = ctx.sessionManager.getSessionId();
        const currentSlot = activeLoopRuns.get(sessionId);
        if (currentSlot) {
          report(alreadyRunning(currentSlot).content[0].text, "error");
          return;
        }
        // A one-shot session ends when this handler returns, so the run must finish first.
        // A persistent session keeps running after the handler returns.
        const oneShot = ctx.mode === "print" || ctx.mode === "json";
        // The slot is reserved before the consent dialog, so a second command cannot
        // start a run that this one would later overwrite. The controller exists from the
        // start, so a stop during the dialog still reaches this command.
        const slot = reserveLoopRun(sessionId, ctx.cwd);
        if (!slot) {
          report(alreadyRunning(activeLoopRuns.get(sessionId)).content[0].text, "error");
          return;
        }
        const controller = slot.controller;
        const release = (): void => releaseLoopRun(sessionId, slot);
        let consent = explicitConsent;
        if (!consent && ctx.hasUI) {
          consent = await ctx.ui.confirm(
            "Dream-RSI unattended loop",
            "This runs repository commands on this host with your access and spends the configured agent and evaluator budget. Start the loop?",
          );
          if (!consent) {
            release();
            report("Dream-RSI loop not started: consent was not given.");
            return;
          }
        }
        if (!consent) {
          release();
          // No UI and no explicit flag: ask the user for consent in the chat. The model
          // must not supply consent on the user's behalf.
          sendWhenReady(`The user asked to start the Dream-RSI loop${focus ? ` focused on: ${focus}` : ""}. Ask the user for explicit trusted-local consent first: discovered repository code runs on this host with host access. Only after the user confirms, call dream_rsi_loop with action=start, consent=true${includeLogs ? "" : " and include_logs=false"}${focus ? ` and focus ${JSON.stringify(focus)}` : ""}. The loop ranks levers, calibrates metrics and chains bounded verified campaigns; it stops on its own at the durable budget.`);
          report("Dream-RSI loop needs consent: rerun /dream-rsi loop --consent in a non-interactive session, or continue with the agent request just sent.");
          return;
        }
        // A stop or a session shutdown during the consent dialog must not be undone by
        // this command starting a run afterwards.
        if (activeLoopRuns.get(sessionId) !== slot || controller.signal.aborted || closingSessions.has(sessionId)) {
          release();
          report("The Dream-RSI loop was stopped before it started.", "error");
          return;
        }
        const finish = (text: string, type: "info" | "error"): void => {
          if (closingSessions.has(sessionId)) return;
          ctx.ui.notify(text.split("\n")[0], type);
          pi.sendMessage({ customType: "dream-rsi/loop", content: text, display: true }, { triggerTurn: false });
          // A one-shot print session shows only its own final assistant message, so the
          // report also goes to the standard error stream.
          if (oneShot) process.stderr.write(`${text}\n`);
        };
        const summarize = (result: any): { text: string; type: "info" | "error" } => {
          const text = Array.isArray(result?.content)
            ? result.content.map((part: { text?: string }) => part?.text ?? "").filter(Boolean).join("\n")
            : "Dream-RSI loop finished.";
          return { text: text || "Dream-RSI loop finished.", type: result?.details?.ok === false ? "error" : "info" };
        };
        report(`Dream-RSI unattended loop starting${focus ? ` (${focus})` : ""}: bounded campaigns until a stop rule. Use /dream-rsi status to inspect or /dream-rsi stop to halt the active campaign.`);
        const run = startLoop({ action: "start", consent: true, include_logs: includeLogs, ...(focus ? { focus } : {}) }, ctx, controller.signal);
        if (oneShot) {
          try {
            const summary = summarize(await run);
            finish(summary.text, summary.type);
          } catch (error) {
            finish(`Dream-RSI loop stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`, "error");
          } finally {
            release();
          }
          return;
        }
        void run
          .then((result) => {
            const summary = summarize(result);
            finish(summary.text, summary.type);
          })
          .catch((error: unknown) => {
            finish(`Dream-RSI loop stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`, "error");
          })
          .finally(release);
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
        // The detached loop spends money before its first campaign exists, so the stop
        // must reach the run itself and not only a recorded campaign.
        const slot = activeLoopRuns.get(ctx.sessionManager.getSessionId());
        let aborted = false;
        if (slot) {
          slot.controller.abort();
          aborted = true;
        }
        let where = root;
        if (!readCampaignStatus(root)) {
          const target = loopTargetRoot(ctx);
          if (target && target !== root && readCampaignStatus(target)) where = target;
        }
        const campaign = stopCampaign(where);
        const lines: string[] = [];
        if (aborted) lines.push("The running Dream-RSI loop was asked to stop.");
        lines.push(campaign
          ? where === root
            ? `Stop requested.\n${renderCampaignStatus(campaign)}`
            : `Stop requested for the loop target ${path.dirname(where)}.\n${renderCampaignStatus(campaign)}`
          : "No active campaign is recorded here.");
        report(lines.join("\n"), campaign || aborted ? "info" : "error");
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
    const indicator = loopIndicators.get(id);
    if (indicator) {
      if (indicator.timer) clearInterval(indicator.timer);
      loopIndicators.delete(id);
    }
    const slot = activeLoopRuns.get(id);
    if (slot) {
      slot.controller.abort();
      activeLoopRuns.delete(id);
    }
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
    "  /dream-rsi loop [what you want] [--consent] [--no-logs]  unattended bounded loop over levers",
    "  /dream-rsi watch  open the campaign dashboard · Ctrl+Shift+D",
    "  /dream-rsi status | stop | resume  inspect or control the campaign",
  ].join("\n");
}

function commandCompletions(prefix: string) {
  const query = prefix.trimStart().replace(/\s+/g, " ");
  const choices = [
    { value: "assess", label: "assess [what you want] [--no-logs]", description: "Rank project levers without changing files" },
    { value: "loop", label: "loop [what you want] [--consent] [--no-logs]", description: "Run the unattended bounded loop over ranked levers" },
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
    ...(campaign.effectiveAgent ? [`  agent: ${campaign.effectiveAgent.command} (model ${campaign.effectiveAgent.model ?? "child default"}${campaign.effectiveAgent.modelSource === "child-default" ? "; no session or saved model was resolved" : `; ${campaign.effectiveAgent.modelSource}`})`] : []),
    `  effective evaluator timeout: ${campaign.effectiveEvaluatorTimeoutMs}ms`,
    `  deadline: ${campaign.deadlineAt}`,
    ...(campaign.pendingConfirmation ? [`  pending confirmation: ${campaign.pendingConfirmation.cell}, ${campaign.pendingConfirmation.pairs}/${campaign.pendingConfirmation.maxPairs} paired samples; use action=confirm to continue without repeating paid pairs`] : []),
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

export function campaignUpdate(
  ctx: ExtensionContext,
  onUpdate: ((update: any) => void) | undefined,
  isClosing: () => boolean,
  isIndicatorActive: () => boolean = () => false,
): (campaign: CampaignStatus) => void {
  return (campaign) => {
    if (!isClosing() && !isIndicatorActive()) {
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
