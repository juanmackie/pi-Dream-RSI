/**
 * Dream-RSI assessment and autonomous improvement loop for pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { Dashboard } from "./dashboard.ts";
import { campaignRuntimeDiagnostics, failPausedV2Campaign, readCampaignRef, readCampaignStatus, runCampaign, stopCampaign, type CampaignRuntimeDiagnostics, type CampaignStatus } from "./engine/campaign.ts";
import { readLoopActivity, runLoop, type LoopActivity } from "./engine/loop.ts";
import { copyWorkspace, runAgent } from "./agent/runner.ts";
import { writeFileAtomic } from "./engine/fsutil.ts";
import { pathProtected, pathWithin } from "./engine/scope.ts";
import { phaseIsActive } from "./engine/ownership.ts";
import { progressSummary, type ProgressSnapshot } from "./engine/progress.ts";
import { mementoNotes, readMemory } from "./engine/search.ts";
import { approvalIdentity, effectiveCommitPolicy, normalizeRunContract, readStoredContract } from "./engine/intake.ts";
import { measurementHarnessInstructions } from "./engine/harness.ts";
import { resolveLoopProposal, proposalReview, proposalIdentity, type LoopProposal } from "./engine/proposal.ts";
import { discoverMeasurementOptions } from "./engine/recon.ts";
import { recovery, recoveryForLoop } from "./engine/recovery.ts";
import { readLoopSettingsFile } from "./engine/settings.ts";
import { preparationMessage, preparedSettingsError, type LoopPreparation } from "./engine/preparation.ts";
import { collectSignals } from "./engine/signals.ts";
import { MAX_TASK_TIMEOUT_MS, type TaskConfig } from "./engine/task.ts";
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
  activity: LoopActivity;
  /** Present only while the command waits for the current chat agent to prepare settings. */
  preparation?: LoopPreparation;
  /** Prevent replay while retaining branch cancellation and privacy through engine startup. */
  preparationClaimed?: boolean;
  validationFailures?: number;
  proposal?: LoopProposal;
  proposalId?: string;
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
    action: { type: "string", enum: ["prepare", "start", "status", "stop", "resume", "confirm"], description: "Prepare, start, inspect or stop. Resume an interrupted campaign, or explicitly continue an idle saved loop only when continuous mode is approved; confirm saved paired readings." },
    project_dir: { type: "string", description: "Local project path; defaults to the current project." },
    consent: { type: "boolean", description: "Required for start: discovered repository code runs on this host with host access." },
    preparation_id: { type: "string", description: "Session-bound handoff ID supplied by /dream-rsi loop during preparation. Pass it unchanged with complete settings; Stop or reload invalidates it." },
    proposal_id: { type: "string", description: "Digest of the exact settings and source returned by action=prepare. A stale digest is rejected before execution." },
    approve_proposal: { type: "boolean", description: "Explicit approval of the reviewed proposal_id for a headless prepared start. Separate from host consent, setup authorization, and contract replacement." },
    replace_contract: { type: "boolean", description: "Explicitly authorize replacing a different saved run contract. Review objective, scope, gates, permissions, and any increased caps first. Replacement preserves spend, may only raise caps, and keeps one backup; refuses unsettled campaigns." },
    focus: { type: "string", description: "Improvement goal. Defaults to reducing declared workload wall-clock time without changing results." },
    auto_commit: { type: "boolean", description: "Legacy shorthand for commit_policy: true selects per-accepted-change, false selects no-commit." },
    commit_policy: { type: "string", enum: ["commit-per-accepted-change", "squash-per-campaign", "no-commit"], description: "Verified commit policy. Defaults to per-accepted-change for new Git projects; no-commit keeps changes in the working tree." },
    commit_branch: { type: "string", description: "Dedicated local branch for verified auto-commits. Defaults to dream-rsi/improve; main/default branches are refused." },
    continuous: { type: "boolean", description: "Opt in to budget-bounded continuation, a no-win plateau, campaign pacing, and rolling hourly process limits. Resume across days only by explicit action=resume." },
    plateau_campaigns: { type: "integer", minimum: 1, maximum: 64, description: "Continuous-mode stop threshold for consecutive campaigns without a verified win; defaults to 3." },
    minimum_campaign_interval_seconds: { type: "integer", minimum: 1, maximum: 86400, description: "Continuous-mode minimum interval between campaign starts; defaults to 60 seconds." },
    agent_starts_per_hour: { type: "integer", minimum: 1, maximum: 10000, description: "Continuous-mode rolling hourly soft limit for agent process starts; defaults to 36. The loop waits for an available slot and does not renew durable totals." },
    evaluator_runs_per_hour: { type: "integer", minimum: 1, maximum: 10000, description: "Continuous-mode rolling hourly soft limit for evaluator process starts; defaults to 96. The loop waits for an available slot and does not renew durable totals." },
    include_logs: { type: "boolean", description: "Read bounded local session aggregates. Defaults to true; false skips all session-file access." },
    unit: { type: "string", description: "Metric unit; defaults to ms when no evaluator is supplied." },
    higher_is_better: { type: "boolean", description: "Metric direction; defaults to false without an evaluator." },
    minimum_gain: { type: ["number", "string"], description: "Minimum useful gain, default 5%." },
    false_accept_budget: { type: "number", description: "Statistical promotion budget, greater than 0 and below 0.5; immutable after approval. Default 0.1." },
    proxy_justification: { type: "string", description: "Why a proxy metric represents the stated goal." },
    evaluator: { type: "object", properties: {
      argv: { type: "array", items: { type: "string" } },
      output: { type: "string", enum: ["score-json", "stdout-number", "stdout-json"] },
      inputs: { type: "array", items: { type: "string" } },
    }, required: ["argv", "output"], additionalProperties: false },
    setup_harness: { type: "boolean", description: "Authorize setup of a two-file measurement harness (evaluator and correctness check) before experiments. Requires focus, unit and higher_is_better; existing files are never overwritten. Setup uses the durable budget." },
    harness_language: { type: "string", enum: ["python", "node"], description: "Harness language for setup_harness. Defaults to the project's majority source language." },
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
    agent_timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TASK_TIMEOUT_MS, description: "Maximum milliseconds allowed for one agent call." },
    evaluator_timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TASK_TIMEOUT_MS, description: "Maximum milliseconds allowed for one evaluator call." },
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
    const at = new Date().toISOString();
    const slot: LoopRunSlot = { controller, projectDir: path.resolve(projectDir), activity: { state: "running", phase: "setup", detail: "Preparing loop settings", startedAt: at, updatedAt: at } };
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
    const pending = activeLoopRuns.get(id);
    if (pending?.preparation) {
      pending.controller.abort();
      // An accepted handoff may be awaiting approval or unwinding engine work.
      // Keep its slot until finally releases it, so another start cannot overlap.
      if (!pending.preparationClaimed) activeLoopRuns.delete(id);
    }
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
  const activityTarget = (ctx: ExtensionContext): string => {
    const slot = activeLoopRuns.get(ctx.sessionManager.getSessionId());
    const target = loopTargetRoot(ctx);
    return slot?.projectDir ?? (target ? path.dirname(target) : ctx.cwd);
  };
  const noteActivity = (ctx: ExtensionContext, slot: LoopRunSlot | undefined, activity: LoopActivity): void => {
    if (slot && activeLoopRuns.get(ctx.sessionManager.getSessionId()) === slot && !closingSessions.has(ctx.sessionManager.getSessionId())) slot.activity = activity;
  };
  const sessionPhase = (ctx: ExtensionContext, slot: LoopRunSlot | undefined, state: LoopActivity["state"], phase: string, detail: string): void => {
    if (slot) noteActivity(ctx, slot, { state, phase, detail, startedAt: slot.activity.startedAt, updatedAt: new Date().toISOString() });
  };
  const preparationFailure = (ctx: ExtensionContext, slot: LoopRunSlot, text: string): any => {
    slot.preparationClaimed = false;
    slot.validationFailures = (slot.validationFailures ?? 0) + 1;
    const remaining = Math.max(0, 3 - slot.validationFailures);
    if (!remaining) {
      slot.controller.abort();
      releaseLoopRun(ctx.sessionManager.getSessionId(), slot);
    } else sessionPhase(ctx, slot, "running", "preparation", `Settings need correction (${remaining} attempts left): ${text.slice(0, 120)}`);
    return { content: [{ type: "text", text: `${text}${remaining ? ` Correct the proposal; ${remaining} settings-correction attempt(s) remain.` : " Preparation stopped after three invalid settings submissions; a new user command is required."}` }],
      details: { ok: false, remaining_preparation_attempts: remaining, recovery: recovery("configuration") } };
  };
  const inspectActivity = (projectDir: string) => {
    const slot = [...activeLoopRuns.values()].find((run) => run.projectDir === path.resolve(projectDir));
    const activity = slot ? { ...slot.activity, state: slot.controller.signal.aborted ? "stopping" as const : slot.activity.state } : readLoopActivity(path.join(projectDir, ".dream-rsi"));
    const lines: string[] = activity ? [
      `Active loop: ${activity.state}; phase: ${activity.phase}`,
      `Project: ${projectDir}`,
      `Work: ${activity.detail}`,
      `Started: ${activity.startedAt ?? "unknown"}; last progress: ${activity.updatedAt ?? "unknown"}`,
    ] : ["No active loop."];
    if (slot?.proposal && ["setup", "preparation", "approval"].includes(activity?.phase ?? "")) {
      const contract = slot.proposal.contract;
      lines.push(`Pending proposal: ${slot.proposalId?.slice(0, 12) ?? "not identified"} (not a saved approval)`,
        `  outcome: ${contract.outcome.statement.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 180)}`,
        `  scope: ${contract.scope.roots.join(", ") || "whole workspace"}; metric: ${contract.outcome.unit}; gates: ${contract.preserved.gates.length}; setup writes: ${slot.proposal.params.evaluator_bootstrap?.authorized ? slot.proposal.params.evaluator_bootstrap.paths.length : 0}`);
    }
    return { activity, lines };
  };
  const watchLoop = async (ctx: ExtensionContext): Promise<void> => {
    const projectDir = activityTarget(ctx);
    const baseRoot = path.join(projectDir, ".dream-rsi");
    // Watch refreshes several times per second, so it reads only the validated campaign
    // pointer and record; full status (ledgers, health) stays in the one-shot status path.
    const source = () => {
      const live = inspectActivity(projectDir);
      let current: { id: string; campaignRoot: string } | null = null;
      try { current = readCampaignRef(baseRoot); } catch { current = null; }
      const attached = live.activity ? current && current.id === live.activity.campaignId ? current : null : current;
      return { lines: live.lines, campaignRoot: attached ? current!.campaignRoot : null };
    };
    const summary = await dashboardFor(ctx).watch(baseRoot, undefined, source);
    if (summary) pi.sendMessage({ customType: "dream-rsi/watch", content: summary, display: true }, { triggerTurn: false });
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
    const owner = activeLoopRuns.get(ctx.sessionManager.getSessionId());
    sessionPhase(ctx, owner, "running", "setup", "Checking saved contract, metric, and evaluator settings");
    // Progress and phase callbacks report the campaign state of the project
    // the loop actually runs in, which may differ from the calling directory.
    const baseRoot = path.join(projectDir, ".dream-rsi");
    const loopRoot = path.join(baseRoot, "loop");
    if (params.replace_contract !== undefined && typeof params.replace_contract !== "boolean") return { content: [{ type: "text", text: "replace_contract must be a boolean" }], details: { ok: false } };
    let stored: ReturnType<typeof readStoredContract>;
    try { stored = readStoredContract(loopRoot); }
    catch (error) { return { content: [{ type: "text", text: `The stored contract cannot be read; it was not replaced: ${error instanceof Error ? error.message : String(error)}` }], details: { ok: false } }; }
    let proposal: LoopProposal;
    try { proposal = resolveLoopProposal(params, projectDir, stored?.contract, Object.keys(loopParams.properties)); }
    catch (error) { return { content: [{ type: "text", text: `loop settings are invalid: ${error instanceof Error ? error.message : String(error)}` }], details: { ok: false, retryableProposal: true, recovery: recovery("configuration") } }; }
    params = proposal.params;
    const { contract, limits, campaignDefaults, taskDefaults, notices: contractNotices } = proposal;
    const reviewedId = proposalIdentity(projectDir, proposal, stored?.contract);
    if (owner?.preparation) { owner.proposal = proposal; owner.proposalId = reviewedId; }
    const needsReview = (reason: string): any => ({ content: [{ type: "text", text: `${reason}\nProposal ID: ${reviewedId}\nComplete proposed settings (not approved; reuse settings and supply action/approval controls separately):\n${proposalReview(proposal)}` }], details: { ok: false, needsApproval: true, proposal_id: reviewedId, proposal, recovery: recovery("approval") } });
    if (params.proposal_id !== undefined && params.proposal_id !== reviewedId) return needsReview("The proposal or project source changed. Review the new proposal before approving it.");
    if (owner?.preparation && !ctx.hasUI && (params.approve_proposal !== true || params.proposal_id !== reviewedId)) return needsReview("Review this complete proposal, then explicitly approve its proposal_id. Host consent alone does not approve these settings.");
    let replacement: string | undefined;
    if (ctx.hasUI && (!stored || (owner?.preparation && approvalIdentity(stored.contract) === approvalIdentity(contract)))) {
      const setup = params.evaluator_bootstrap?.authorized === true;
      const choice = setup ? "Approve proposal and setup" : "Approve proposal";
      sessionPhase(ctx, owner, "awaiting-approval", "approval", "Waiting for complete proposal approval");
      const answer = await ctx.ui.select(`Proposed complete boundary; host consent is separate.\n${proposalReview(proposal)}`, [choice, "Cancel"]);
      if (answer !== choice || signal?.aborted) return { content: [{ type: "text", text: "Proposal approval was cancelled; the loop was not started." }], details: { ok: false } };
    }
    if (stored && approvalIdentity(stored.contract) !== approvalIdentity(contract)) {
      let replace = params.replace_contract === true;
      if (ctx.hasUI) {
        sessionPhase(ctx, owner, "awaiting-approval", "approval", `Waiting for replacement-contract approval: ${contract.outcome.statement.slice(0, 120)}`);
        replace = false;
        const changed = (Object.keys(contract) as Array<keyof typeof contract>).filter((key) => JSON.stringify(stored.contract[key]) !== JSON.stringify(contract[key]));
        const summary = `Saved: ${stored.contract.outcome.statement.slice(0, 180)}\nProposed: ${contract.outcome.statement.slice(0, 180)}\nChanged: ${changed.join(", ")}. Existing spend is retained; replacement may raise (not lower) caps.\nComplete proposed boundary:\n${proposalReview(proposal)}`;
        const approve = params.evaluator_bootstrap?.authorized === true ? "Approve replacement and setup" : "Approve replacement";
        for (;;) {
          const answer = await ctx.ui.select(summary, [approve, "Inspect full contracts", "Cancel"]);
          if (signal?.aborted) return { content: [{ type: "text", text: "Replacement review was cancelled; the loop was not started." }], details: { ok: false, cancelled: true } };
          if (answer === "Inspect full contracts") {
            await ctx.ui.confirm("Saved and proposed contract — return to review", JSON.stringify({ saved: stored.contract, proposed: contract }, null, 2));
            continue;
          }
          if (answer !== approve) return { content: [{ type: "text", text: "Replacement review was cancelled; the loop was not started." }], details: { ok: false, cancelled: true } };
          replace = true;
          break;
        }
      }
      if (replace) replacement = approvalIdentity(stored.contract);
    }
    if (!signal?.aborted && proposalIdentity(projectDir, proposal, stored?.contract) !== reviewedId) return needsReview("Project source changed during proposal review; review it again before execution.");
    if (owner?.preparation && (signal?.aborted || closingSessions.has(ctx.sessionManager.getSessionId()))) {
      return { content: [{ type: "text", text: "The Dream-RSI loop was stopped before engine startup; no approval or budget was written." }], details: { ok: false } };
    }
    let evaluatorBootstrap: { authorized: boolean; paths: string[]; run: (input: { projectDir: string; contract: ReturnType<typeof normalizeRunContract>; focus?: string; scopeRoots: string[]; deadlineMs: number; beforeAgentSpawn: () => void | Promise<void>; signal?: AbortSignal }) => Promise<{ validatedPaths: string[] }> } | undefined;
    if (params.evaluator_bootstrap !== undefined) {
      const config = params.evaluator_bootstrap as { authorized: boolean; paths: string[] };
      const paths = config.paths;
      if (config.authorized) {
        const agent = proposal.execution.agent;
        const timeoutMs = proposal.execution.agent_timeout_ms;
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
                proposal.setup?.mode === "generated-harness" ? measurementHarnessInstructions(params.harness_language) : "Create the smallest deterministic benchmark workload and pinned evaluator needed to measure this approved objective.",
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
              const assertSafeFilePath = (base: string, absolute: string): void => {
                const within = path.relative(path.resolve(base), absolute);
                if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error(`bootstrap path escapes its workspace: ${within}`);
                let current = path.resolve(base);
                const parts = within.split(path.sep);
                for (const [index, part] of parts.entries()) {
                  current = path.join(current, part);
                  if (!fs.existsSync(current)) continue;
                  const stat = fs.lstatSync(current);
                  if (stat.isSymbolicLink()) throw new Error(`bootstrap path uses a symbolic link: ${within}`);
                  if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`bootstrap parent is not a directory: ${within}`);
                  if (index === parts.length - 1 && !stat.isFile()) throw new Error(`bootstrap path is not a regular file: ${within}`);
                }
              };
              for (const relative of paths) {
                const source = path.resolve(scratch, relative);
                const targetPath = path.resolve(target, relative);
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
              const created: Array<{ file: string; contents: string; identity: fs.Stats }> = [];
              try {
                for (const { relative, targetPath, contents, previous } of pendingWrites) {
                  if (bootstrapSignal?.aborted) throw new Error("bootstrap cancelled before copy-back");
                  if (Date.now() >= bootstrapDeadlineAt) throw new Error("bootstrap deadline elapsed before copy-back");
                  if (!pathWithin(relative, scopeRoots) || pathProtected(relative, approvedContract.scope.protectedAssets)) throw new Error(`bootstrap path became out of scope or protected before copy-back: ${relative}`);
                  assertSafeFilePath(target, targetPath);
                  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                  if (proposal.setup?.writePolicy === "create-only") {
                    // Setup creates new files only; never overwrite edits made while the agent ran.
                    fs.writeFileSync(targetPath, contents, { flag: "wx" });
                    created.push({ file: targetPath, contents, identity: fs.lstatSync(targetPath) });
                  } else if (previous !== contents) writeFileAtomic(targetPath, contents, true);
                }
              } catch (error) {
                const conflicts: string[] = [];
                for (const { file, contents, identity } of created.reverse()) {
                  try {
                    assertSafeFilePath(target, file);
                    const current = fs.lstatSync(file);
                    if (current.dev !== identity.dev || current.ino !== identity.ino || fs.readFileSync(file, "utf8") !== contents) { conflicts.push(file); continue; }
                    fs.unlinkSync(file);
                  } catch (rollbackError) {
                    if ((rollbackError as NodeJS.ErrnoException).code !== "ENOENT") conflicts.push(file);
                  }
                }
                if (conflicts.length) throw new Error(`${String(error)}; setup cleanup preserved changed files: ${conflicts.join(", ")}`);
                throw error;
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
        onActivity: (activity) => noteActivity(ctx, owner, activity),
        ...(replacement ? { replaceContract: replacement } : {}),
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
      ...contractNotices.map((notice) => `  Note: ${notice}`),
      `  requested objective: ${contract.outcome.statement}`,
      `  editable scope: ${contract.scope.roots.join(", ") || "(whole workspace)"}`,
      `  metric: ${contract.outcome.unit}, ${contract.outcome.higherIsBetter ? "higher" : "lower"} is better; ${contract.outcome.evaluator ? "declared evaluator" : "automatic workload discovery"}; correctness gates: ${contract.preserved.gates.length}`,
      `  campaigns this run: ${result.campaigns} (${result.wins} verified win(s))`,
      `  spend this run: ${result.agentStarts} agent start(s), ${result.evaluatorRuns} evaluator run(s) (${result.preflightEvaluatorRuns} preflight; ${result.campaignEvaluatorRuns} campaign)`,
      `  preflight: ${result.preflight.status}${result.preflight.checks.length ? ` — ${result.preflight.checks.filter((check) => check.status === "blocked").length} blocker(s), ${result.preflight.checks.length} check(s)` : " — not run"}`,
      ...result.preflight.checks.map((check) => `    ${check.status}: ${check.name} — ${check.reason}${check.remedy ? ` Next step: ${check.remedy}` : ""}`),
      `  levers ranked: ${result.inventory?.levers.length ?? 0}; memory: ${result.memoryPath}`,
      ...(result.contract ? [`  trusted-local contract recorded ${result.contract.fingerprint.slice(0, 12)} (${result.contract.approvedAt}); this is consent/settings, not campaign readiness`] : []),
      ...(result.verifications.length > 0
        ? [`  independent post-apply checks: ${result.verifications.filter((check) => check.passed).length}/${result.verifications.length} passed`]
        : []),
      ...(result.autoCommits.length > 0
        ? result.autoCommits.flatMap((receipt) => [`  auto-commit: ${receipt.hash} on ${receipt.branch} (${receipt.files.length} file(s))`, ...(receipt.warning ? [`  commit warning: ${receipt.warning}`] : [])])
        : contract.git ? [`  commit policy: ${effectiveCommitPolicy(contract.git)}${contract.git.autoCommit ? ` on ${contract.git.branch}` : ""}; no verified win was committed this run`] : []),
    ];
    try {
      const budget = JSON.parse(fs.readFileSync(result.budgetPath, "utf8")) as { campaigns?: number; max_campaigns?: number; agent_starts?: number; max_agent_starts?: number; evaluator_runs?: number; max_evaluator_runs?: number };
      lines.push(`  durable caps: ${budget.campaigns}/${budget.max_campaigns} campaigns, ${budget.agent_starts}/${budget.max_agent_starts} agent starts, ${budget.evaluator_runs}/${budget.max_evaluator_runs} evaluator runs`);
    } catch { /* the loop just wrote the file; a missing report line is not fatal */ }
    const next = recoveryForLoop(result);
    lines.push(`  recovery: ${next.category} — ${next.next_step}`);
    return { content: [{ type: "text", text: lines.join("\n") }], details: { loop: result, recovery: next } };
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
      const includeLogs = params.include_logs !== false && activeLoopRuns.get(ctx.sessionManager.getSessionId())?.preparation?.include_logs !== false;
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

  const loopTool = {
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
    async execute(_id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext): Promise<any> {
      const action = typeof params.action === "string" ? params.action : "";
      if (action === "prepare") {
        const projectDir = resolveCampaignProjectDir(params.project_dir, ctx.cwd);
        if (!projectDir) return { content: [{ type: "text", text: "project_dir must name an existing local project directory." }], details: { ok: false } };
        try {
          const stored = readStoredContract(path.join(projectDir, ".dream-rsi/loop"));
          const request = activeLoopRuns.get(ctx.sessionManager.getSessionId())?.preparation;
          if (params.preparation_id !== undefined && (!request || request.preparation_id !== params.preparation_id)) throw new Error("loop preparation expired or was cancelled");
          if (request && params.preparation_id !== undefined && (projectDir !== request.project_dir || (params.focus !== undefined && params.focus !== request.focus))) throw new Error("prepared proposal must keep the command's project and goal");
          const proposal = resolveLoopProposal({ ...params, ...(request && params.preparation_id !== undefined ? { focus: request.focus, include_logs: request.include_logs && params.include_logs !== false } : {}), consent: false }, projectDir, stored?.contract, Object.keys(loopParams.properties));
          const proposal_id = proposalIdentity(projectDir, proposal, stored?.contract);
          const measurementOptions = discoverMeasurementOptions(projectDir, proposal.contract);
          return { content: [{ type: "text", text: `Proposal ID: ${proposal_id}\nProposed settings (not approved; no commands run; reuse settings and supply action/approval controls separately):\n${proposalReview(proposal)}\nMeasurement options (source hints, not qualified):\n${JSON.stringify(measurementOptions, null, 2)}` }], details: { proposal, proposal_id, measurementOptions } };
        } catch (error) { return { content: [{ type: "text", text: `Proposal is invalid: ${error instanceof Error ? error.message : String(error)}` }], details: { ok: false } }; }
      }
      if (action === "status") {
        const projectDir = resolveCampaignProjectDir(params.project_dir ?? activityTarget(ctx), ctx.cwd);
        if (!projectDir) return { content: [{ type: "text", text: "project_dir must name an existing local project directory." }], details: { ok: false } };
        // State lives under the resolved project, not the calling directory:
        // one extension session can inspect loops in several projects.
        const baseRoot = path.join(projectDir, ".dream-rsi");
        const loopRoot = path.join(baseRoot, "loop");
        const live = inspectActivity(projectDir);
        const lines: string[] = [...live.lines];
        let campaign: CampaignStatus | null = null;
        try { campaign = readCampaignStatus(baseRoot); }
        catch (error) { lines.push(`Campaign state unavailable: ${error instanceof Error ? error.message : String(error)}`); }
        let approvedAt: string | undefined;
        const budgetPath = path.join(loopRoot, "budget.json");
        const memoryPath = path.join(loopRoot, "memory.json");
        if (!fs.existsSync(budgetPath)) {
          lines.push(fs.existsSync(path.join(loopRoot, "contract.json")) ? "No durable loop budget yet; inspect the saved contract below." : "No loop state yet. Run /dream-rsi loop <what you want>.");
        } else {
          try {
            const budget = JSON.parse(fs.readFileSync(budgetPath, "utf8")) as { campaigns?: number; max_campaigns?: number; agent_starts?: number; max_agent_starts?: number; evaluator_runs?: number; max_evaluator_runs?: number };
            lines.push(`Dream-RSI loop budget (durable): ${budget.campaigns}/${budget.max_campaigns} campaigns, ${budget.agent_starts}/${budget.max_agent_starts} agent starts, ${budget.evaluator_runs}/${budget.max_evaluator_runs} evaluator runs.`);
            if ([budget.campaigns, budget.max_campaigns, budget.agent_starts, budget.max_agent_starts, budget.evaluator_runs, budget.max_evaluator_runs].every(Number.isSafeInteger)) {
              lines.push(`Remaining allowance: ${Math.max(0, budget.max_campaigns! - budget.campaigns!)} campaign(s), ${Math.max(0, budget.max_agent_starts! - budget.agent_starts!)} agent start(s), ${Math.max(0, budget.max_evaluator_runs! - budget.evaluator_runs!)} evaluator run(s).`);
            }
          } catch { lines.push("Loop budget is unreadable; the next start fails closed."); }
          try {
            const phases = (JSON.parse(fs.readFileSync(budgetPath, "utf8")) as { phases?: Record<string, { agent_starts?: number; evaluator_runs?: number; campaigns?: number }> }).phases ?? {};
            const rendered = Object.entries(phases)
              .filter(([, spend]) => (spend.agent_starts ?? 0) + (spend.evaluator_runs ?? 0) + (spend.campaigns ?? 0) > 0)
              .map(([phase, spend]) => `${phase}: ${spend.evaluator_runs ?? 0} evaluator run(s), ${spend.agent_starts ?? 0} agent start(s)`);
            if (rendered.length > 0) lines.push(`Spend by phase: ${rendered.join("; ")}.`);
          } catch { /* the budget line above already reports unreadable state */ }
        }
        try {
          const stored = readStoredContract(loopRoot);
          approvedAt = stored?.approvedAt;
          lines.push(stored
            ? `Run contract: "${stored.contract.outcome.statement}" (${stored.contract.outcome.unit}, ${stored.contract.outcome.higherIsBetter ? "higher" : "lower"} is better), approved ${stored.approvedAt}; commit policy ${effectiveCommitPolicy(stored.contract.git)}${stored.contract.git?.autoCommit ? ` on ${stored.contract.git.branch}` : ""}.`
            : "No run contract stored for this project; the next start requires explicit consent and objective details.");
        } catch { lines.push("The stored run contract is unreadable; the next start fails closed."); }
        try { lines.push(`Recorded loop history (not live progress):\n${mementoNotes(readMemory(memoryPath))}`); }
        catch { lines.push("Loop memory is unreadable; the next start fails closed."); }
        const reportPath = path.join(loopRoot, "latest-report.json");
        const statusPath = path.join(loopRoot, "status.json");
        const lastRunPath = path.join(loopRoot, "last-run.md");
        lines.push(`Machine-readable live status: ${statusPath}`);
        try {
          const status = JSON.parse(fs.readFileSync(statusPath, "utf8")) as { version?: number; state?: string; updatedAt?: string; branch?: string | null; branchTip?: string | null; effectiveAgent?: { command?: string; model?: string | null; modelSource?: string } | null };
          if (status.version === 1) {
            if (typeof status.state === "string" && typeof status.updatedAt === "string" && typeof status.branch === "string") {
              const branch = status.branch.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120);
              const timestamp = Date.parse(status.updatedAt);
              const observedAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "unknown time";
              const state = ["running", "stopping", "stopped", "failed"].includes(status.state) ? status.state : "unknown";
              const tip = typeof status.branchTip === "string" && /^[a-f0-9]{40,64}$/i.test(status.branchTip) ? status.branchTip : "not available";
              lines.push(`Latest recorded RSI branch tip: ${tip} on ${branch} (observed ${observedAt}; status ${state}).`);
            }
            const effectiveAgent = status.effectiveAgent;
            if (effectiveAgent && typeof effectiveAgent.command === "string" && effectiveAgent.command.trim()) {
              const source = effectiveAgent.modelSource;
              const rawModel = effectiveAgent.model;
              const childDefault = source === "child-default" && rawModel === null;
              const configuredModel = (source === "session" || source === "saved") && typeof rawModel === "string" && rawModel.trim().length > 0;
              if (childDefault || configuredModel) {
                const command = effectiveAgent.command.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 200);
                const model = childDefault ? "child default" : (rawModel as string).replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 120);
                if (command && model) lines.push(`Latest child agent: command "${command}", model "${model}" (${source}).`);
              }
            }
          }
        } catch { /* report the status path even when its snapshot is absent or unreadable */ }
        if (fs.existsSync(reportPath)) {
          if (fs.existsSync(lastRunPath)) lines.push(`Human-readable last-run report: ${lastRunPath}`);
          try {
            const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { version?: number; at?: string; stopCode?: string; stopReason?: string; campaigns?: number; wins?: number; evaluatorRuns?: number; preflightEvaluatorRuns?: number; campaignEvaluatorRuns?: number; agentStarts?: number; autoCommits?: Array<{ hash?: string; branch?: string; files?: string[]; warning?: string }>; lastWin?: { leverId?: string; verifiedGain?: number | null; unit?: string | null } | null; preflight?: { status?: string; checks?: Array<{ name?: string; status?: string; reason?: string; remedy?: string }> } };
            if (report.version === 1 && typeof report.stopCode === "string" && typeof report.stopReason === "string"
              && [report.campaigns, report.wins, report.evaluatorRuns, report.agentStarts].every((value) => Number.isSafeInteger(value) && value! >= 0)) {
              const predatesApproval = typeof report.at === "string" && approvedAt !== undefined && Date.parse(report.at) < Date.parse(approvedAt);
              const historical = predatesApproval ? "Historical run report (predates current approval)" : "Previous run report";
              lines.push(`${historical} at ${report.at ?? "unknown time"}${live.activity ? " (not the active run)" : ""}: ${report.stopCode} — ${report.stopReason.slice(0, 300)}; ${report.campaigns} campaign(s), ${report.wins} verified win(s), ${report.evaluatorRuns} evaluator run(s) (${report.preflightEvaluatorRuns ?? 0} preflight, ${report.campaignEvaluatorRuns ?? 0} campaign), ${report.agentStarts} agent start(s).`);
              if (report.lastWin && typeof report.lastWin.leverId === "string") {
                lines.push(`Last verified win: ${report.lastWin.leverId}${typeof report.lastWin.verifiedGain === "number" && typeof report.lastWin.unit === "string" ? ` (${report.lastWin.verifiedGain} ${report.lastWin.unit} gain)` : ""}.`);
              } else if (report.wins === 0) lines.push("Last run had no verified win.");
              for (const receipt of report.autoCommits ?? []) if (typeof receipt.hash === "string" && typeof receipt.branch === "string") {
                const branch = receipt.branch.replace(/[\r\n\0]/g, " ").slice(0, 120);
                lines.push(`  verified commit: ${receipt.hash} on ${branch}${Array.isArray(receipt.files) ? ` (${receipt.files.length} file(s))` : ""}`);
                if (/^[a-f0-9]{40,64}$/i.test(receipt.hash)) lines.push(`  Undo on ${branch}: \`git revert ${receipt.hash}\``);
                if (typeof receipt.warning === "string") lines.push(`  commit warning: ${receipt.warning.slice(0, 300)}`);
              }
              for (const check of report.preflight?.checks ?? []) lines.push(`  ${check.status ?? "unknown"}: ${check.name ?? "preflight"} — ${(check.reason ?? "").slice(0, 300)}${check.remedy ? ` Historical remedy: ${check.remedy.slice(0, 300)}` : ""}`);
              const previousRecovery = recoveryForLoop({ stopCode: report.stopCode, stopReason: report.stopReason, preflight: { checks: (report.preflight?.checks ?? []).map(check => ({ name: check.name ?? "", status: check.status ?? "" })) } });
              lines.push(`Historical recovery: ${previousRecovery.category} — ${previousRecovery.next_step}`);
            } else lines.push("Latest run report is invalid; the next run remains governed by the durable budget and contract.");
          } catch { lines.push("Latest run report is unreadable."); }
        }
        if (campaign) {
          if (live.activity && live.activity.campaignId !== campaign.id) lines.push("Recorded campaign (not the active loop's campaign):");
          lines.push(renderCampaignStatus(campaign));
        } else lines.push(live.activity ? "No campaign record is attached to this loop activity." : "No active campaign.");
        return { content: [{ type: "text", text: lines.join("\n") }], details: { loop: { budgetPath, memoryPath, reportPath, statusPath, lastRunPath }, activity: live.activity, campaign } };
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
        if (aborted) {
          slot!.controller.abort();
          if (slot!.preparation && !slot!.preparationClaimed) releaseLoopRun(sessionId, slot!);
        }
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
        const loopRoot = path.join(baseRoot, "loop");
        const stored = readStoredContract(loopRoot);
        const hasInterruptedCampaign = Boolean(campaign && (campaign.state.kind === "paused" || campaign.state.kind === "running"));
        const hasRetainedRecovery = action === "resume" && fs.existsSync(path.join(loopRoot, "active.json"));
        const continueSavedLoop = action === "resume" && !hasInterruptedCampaign && !hasRetainedRecovery && Boolean(stored?.contract.continuation);
        if (!hasInterruptedCampaign && !hasRetainedRecovery && !continueSavedLoop) {
          return { content: [{ type: "text", text: "No paused campaign is available. A saved continuous loop can be explicitly continued with action=resume." }], details: { ok: false, campaign } };
        }
        if (campaign?.state.kind === "running" && phaseIsActive(campaign.campaignRoot, "campaign")) {
          return { content: [{ type: "text", text: "The campaign is already running." }], details: { ok: false, campaign } };
        }
        if (action === "confirm" && !campaign?.pendingConfirmation) {
          return { content: [{ type: "text", text: "No saved candidate confirmation is pending; use action=resume for an interrupted campaign." }], details: { ok: false, campaign } };
        }
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
            projectDir, baseRoot, loopRoot, contract: stored.contract, resumeActiveCampaign: hasInterruptedCampaign || hasRetainedRecovery, confirmationOnly: action === "confirm",
            onActivity: (activity) => noteActivity(ctx, slot, activity),
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
            details: { ok: result.stopReason !== "resume failed", loop: result, recovery: recoveryForLoop(result) },
          };
        } finally { releaseLoopRun(sessionId, slot); }
      }
      if (action !== "start") return { content: [{ type: "text", text: "action must be prepare, start, status, stop, resume or confirm." }], details: { ok: false } };
      const sessionId = ctx.sessionManager.getSessionId();
      const preparing = activeLoopRuns.get(sessionId);
      if (params.preparation_id !== undefined) {
        const request = preparing?.preparation;
        if (!request || preparing!.preparationClaimed || request.preparation_id !== params.preparation_id || preparing!.controller.signal.aborted || closingSessions.has(sessionId)) {
          return { content: [{ type: "text", text: "Loop preparation expired or was cancelled. Start a new /dream-rsi loop request; do not retry this handoff." }], details: { ok: false } };
        }
        if (params.consent !== true) return { content: [{ type: "text", text: "Prepared settings require consent=true after trusted-local authorization through the command or chat." }], details: { ok: false } };
        const projectDir = resolveCampaignProjectDir(params.project_dir ?? request.project_dir, ctx.cwd);
        if (projectDir !== request.project_dir || (params.focus !== undefined && params.focus !== request.focus)) {
          return { content: [{ type: "text", text: "Prepared settings must keep the command's project and goal. Start a new command to change them." }], details: { ok: false } };
        }
        const error = preparedSettingsError(params);
        if (error) return preparationFailure(ctx, preparing!, error);
        // Claim synchronously before any await, but keep the request attached so
        // tree changes can still cancel startup while replacement approval is open.
        preparing!.preparationClaimed = true;
        const resolved = { ...params, project_dir: request.project_dir, focus: request.focus, include_logs: request.include_logs && params.include_logs !== false };
        try {
          const result = await startLoop(resolved, ctx, signalForLoopRun(signal, preparing!), onUpdate);
          if (result.details?.retryableProposal && !preparing!.controller.signal.aborted && !closingSessions.has(sessionId)) return preparationFailure(ctx, preparing!, result.content[0].text);
          if (result.details?.needsApproval && !preparing!.controller.signal.aborted && !closingSessions.has(sessionId)) {
            preparing!.preparationClaimed = false;
            sessionPhase(ctx, preparing, "awaiting-approval", "approval", "Waiting for approval of the complete proposal");
          }
          return result;
        } finally { if (preparing!.preparationClaimed) releaseLoopRun(sessionId, preparing!); }
      }
      if (preparing?.preparation && !preparing.preparationClaimed) return { content: [{ type: "text", text: "This session is preparing a loop. Return complete settings with its preparation_id, or use /dream-rsi stop before a different start." }], details: { ok: false } };
      if (params.consent !== true) return await startLoop(params, ctx, signal, onUpdate);
      const projectDir = resolveCampaignProjectDir(params.project_dir, ctx.cwd);
      if (!projectDir) return { content: [{ type: "text", text: "project_dir must name an existing local project directory." }], details: { ok: false } };
      const slot = reserveLoopRun(sessionId, projectDir);
      if (!slot) return alreadyRunning(activeLoopRuns.get(sessionId));
      try { return await startLoop(params, ctx, signalForLoopRun(signal, slot), onUpdate); }
      finally { releaseLoopRun(sessionId, slot); }
    },
  };
  pi.registerTool(loopTool);

  // -- command -------------------------------------------------------------

  pi.registerCommand("dream-rsi", {
    description: "Dream-RSI: assess | loop | watch | status | stop | resume",
    getArgumentCompletions: commandCompletions,
    async handler(args, ctx) {
      const root = dreamRoot(ctx);
      const parsed = /^(\S+)(?:\s+([\s\S]*))?$/.exec(String(args ?? "").trim());
      const verb = parsed?.[1] ?? "help";
      const rest = parsed?.[2] ?? "";
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
        const tokens = (rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(token => token.replace(/^(["'])([\s\S]*)\1$/, "$2"));
        const explicitConsent = tokens.includes("--consent");
        const includeLogs = !tokens.includes("--no-logs");
        const setupHarness = tokens.includes("--setup-harness");
        const replaceContract = tokens.includes("--replace-contract");
        const autoCommitFlag = tokens.includes("--auto-commit") ? true : tokens.includes("--no-auto-commit") ? false : undefined;
        const commitPolicyIndex = tokens.indexOf("--commit-policy");
        const commitPolicyFlag = commitPolicyIndex >= 0 ? tokens[commitPolicyIndex + 1] : undefined;
        if (commitPolicyIndex >= 0 && (!commitPolicyFlag || commitPolicyFlag.startsWith("--"))) {
          report("--commit-policy needs commit-per-accepted-change, squash-per-campaign, or no-commit.", "error");
          return;
        }
        const configIndex = tokens.indexOf("--config");
        const configFile = configIndex >= 0 ? tokens[configIndex + 1] : undefined;
        if (configIndex >= 0 && (!configFile || configFile.startsWith("--"))) {
          report("--config needs a settings file path.", "error");
          return;
        }
        const ignored = [...(configIndex >= 0 ? ["--config", configFile!] : []), ...(commitPolicyIndex >= 0 ? ["--commit-policy", commitPolicyFlag!] : [])];
        const focus = tokens.filter((token) => !["--consent", "--no-logs", "--setup-harness", "--replace-contract", "--auto-commit", "--no-auto-commit", ...ignored].includes(token)).join(" ");
        let settings: Record<string, unknown> = {};
        if (configFile) {
          try { settings = readLoopSettingsFile(configFile, ctx.cwd, Object.keys(loopParams.properties)); }
          catch (error) { report(`Loop settings file is invalid: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
        }
        if (autoCommitFlag !== undefined) settings.auto_commit = autoCommitFlag;
        if (commitPolicyFlag !== undefined) settings.commit_policy = commitPolicyFlag;
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
        const needsPreparation = Boolean(focus) && !configFile && !setupHarness;
        // Bind preparation to this branch before the first consent await. An answer
        // from an abandoned branch must not create a new valid handoff afterward.
        if (needsPreparation) slot.preparation = {
          preparation_id: crypto.randomUUID(), project_dir: slot.projectDir, focus,
          consent: false, include_logs: includeLogs, replacement_requested: replaceContract,
          ...(Object.keys(settings).length || setupHarness ? { proposed_settings: { ...settings, ...(setupHarness ? { setup_harness: true, unit: "ms", higher_is_better: false } : {}), ...(focus ? { focus } : {}) } } : {}),
        };
        const prepare = (consent: boolean): void => {
          const request = slot.preparation!;
          request.consent = consent;
          sessionPhase(ctx, slot, consent ? "running" : "awaiting-consent", "preparation", consent
            ? "Reading the project to propose evaluator, scope, gates, and budgets"
            : "Waiting for trusted-local consent in chat before execution");
          try { sendWhenReady(preparationMessage(request)); }
          catch (error) { release(); throw error; }
        };
        let consent = explicitConsent;
        if (!consent) sessionPhase(ctx, slot, "awaiting-consent", "consent", "Waiting for trusted-local execution consent");
        if (!consent && ctx.hasUI) {
          consent = await ctx.ui.confirm(
            "Dream-RSI unattended loop",
            `This runs repository commands on this host with your access and spends the configured agent and evaluator budget.${setupHarness ? " Setup will author a two-file measurement harness (.dream-rsi-harness/measure and check, in this project's language) for the lower-is-better runtime metric (ms), then qualify it before experiments." : ""} Start the loop?`,
          );
          if (!consent) {
            release();
            report("Dream-RSI loop not started: consent was not given.");
            return;
          }
        }
        if (!consent) {
          if (!slot.preparation) {
            const proposedSettings = { ...settings, ...(setupHarness ? { setup_harness: true, unit: "ms", higher_is_better: false } : {}), ...(focus ? { focus } : {}) };
            try {
              const saved = readStoredContract(path.join(slot.projectDir, ".dream-rsi/loop"));
              const proposed = resolveLoopProposal({ ...proposedSettings, consent: false }, slot.projectDir, saved?.contract, Object.keys(loopParams.properties));
              slot.preparation = {
                preparation_id: crypto.randomUUID(), project_dir: slot.projectDir,
                focus: proposed.contract.outcome.statement, consent: false, include_logs: includeLogs,
                replacement_requested: replaceContract, proposed_settings: proposedSettings,
              };
            } catch (error) {
              release();
              report(`Loop settings are invalid: ${error instanceof Error ? error.message : String(error)}`, "error");
              return;
            }
          }
          prepare(false);
          report("Dream-RSI preparation needs consent before execution: confirm trusted-local access in chat, or stop and rerun with --consent. No campaign has started.");
          return;
        }
        // A stop or a session shutdown during the consent dialog must not be undone by
        // this command starting a run afterwards.
        if (activeLoopRuns.get(sessionId) !== slot || controller.signal.aborted || closingSessions.has(sessionId)) {
          release();
          report("The Dream-RSI loop was stopped before it started.", "error");
          return;
        }
        // A natural-language request is a setup task, not an implicit evaluator,
        // write scope, or permission change. Explicit config/setup commands retain
        // their direct engine path; a bare loop still reuses/discovers saved setup.
        if (needsPreparation) {
          prepare(true);
          report("Dream-RSI is preparing the loop in chat. No campaign has started. Review the proposed setup; use /dream-rsi status or /dream-rsi stop while preparing.");
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
        const run = startLoop({ ...settings, action: "start", consent: true, include_logs: includeLogs, ...(replaceContract ? { replace_contract: true } : {}), ...(setupHarness ? { setup_harness: true, unit: "ms", higher_is_better: false } : {}), ...(focus ? { focus } : {}) }, ctx, controller.signal);
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
        const projectDir = activityTarget(ctx);
        const result = await loopTool.execute("command-status", { action: "status", project_dir: projectDir }, undefined, undefined, ctx);
        const lines = result.content.map((part: { text: string }) => part.text);
        if (projectDir !== ctx.cwd) lines.push(`(loop target: ${projectDir})`);
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
          if (slot.preparation && !slot.preparationClaimed) releaseLoopRun(ctx.sessionManager.getSessionId(), slot);
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
        await watchLoop(ctx);
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
    await watchLoop(ctx);
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
    "  /dream-rsi loop [what you want] [--consent] [--no-logs] [--setup-harness] [--commit-policy <mode>] [--auto-commit|--no-auto-commit] [--replace-contract] [--config <settings.json>]  prepare and run a bounded loop",
    "  /dream-rsi watch  open the campaign dashboard · Ctrl+Shift+D",
    "  /dream-rsi status | stop | resume  inspect or control the campaign",
  ].join("\n");
}

function commandCompletions(prefix: string) {
  const query = prefix.trimStart().replace(/\s+/g, " ");
  const choices = [
    { value: "assess", label: "assess [what you want] [--no-logs]", description: "Rank project levers without changing files" },
    { value: "loop", label: "loop [what you want] [--consent] [--no-logs] [--setup-harness] [--commit-policy <mode>] [--auto-commit|--no-auto-commit] [--replace-contract] [--config <file>]", description: "Prepare a goal in chat, or start directly with reviewed config/setup settings" },
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

function resolveCampaignProjectDir(value: unknown, cwd: string): string | null {
  if (value !== undefined && typeof value !== "string") return null;
  const target = path.resolve(cwd, normalizePathArg(typeof value === "string" ? value : cwd));
  try {
    return fs.statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
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
