/**
 * pi-dream-rsi — Dream-RSI for pi (arXiv 2609.14858).
 *
 * Created by Juan Mackie — https://juanmackie.com
 *
 * The extension owns the deterministic machinery of the method and nothing else:
 *
 *   dream_rsi_init    write task.json, seed the policy, validate the evaluator contract
 *   dream_rsi_live    one online rollout (policy pi_t, W workers, <= K1 rounds) -> discovery tree T_t
 *   dream_rsi_dream   the offline phase: replay every candidate on every world, revise, select, deploy
 *   dream_rsi_status  what the loop currently is: iterations, worlds, versions, sweep, beta
 *
 * No LLM runs in the driver: the only agents are the discovery attempts (one per selected node) and
 * the policy-development agent (one per revision), both spawned through the configured agent command.
 */

import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import { readTask, validateTask, writeTask, defaultTask, type TaskConfig } from "./engine/task.ts";
import { runLiveEpisode } from "./engine/live.ts";
import { planNextGrid, runDreamPhase } from "./engine/dream.ts";
import { loadPrompt } from "./engine/prompt.ts";
import {
  activeRuns,
  dreamRootFor,
  iterationReport,
  saveTaskEntry,
  statusSummary,
  type DreamState,
} from "./state.ts";
import { ensurePolicyRuntime } from "./engine/world.ts";
import { BUNDLED_POLICY_DIR, SKILLS_DIR } from "./layout.ts";


const TASK_ENTRY = "pi-dream-rsi/task";
const MODE_ENTRY = "pi-dream-rsi/mode";

/** Tools that spend real agent time — gated so they cannot fire by accident. */
const GATED_TOOLS = ["dream_rsi_live", "dream_rsi_dream"];

// Plain JSON-Schema parameter objects (what pi validates against), so the package needs no runtime deps.
const taskParams = {
  type: "object",
  properties: {
    name: { type: "string", description: "Task name (used in reports)." },
    workspace: { type: "string", description: "Seed workspace directory for the discovery root (relative to the project)." },
    eval_program: { type: "string", description: "Path of the candidate program attempts must implement ($eval_program in the discovery prompt)." },
    score_program: { type: "string", description: "Fixed scoring command run in an attempt workspace; must write eval/score.json." },
    problem_file: { type: "string", description: "Optional problem statement file shown to attempts." },
    workers: { type: "number", description: "W — parallel attempts (default 4)." },
    k1: { type: "number", description: "K1 — online decision rounds per live episode (default 6)." },
    k2: { type: "number", description: "K2 — replay decision rounds per evaluation (default 8)." },
    revisions: { type: "number", description: "M — policy revisions per offline phase (default 3)." },
    default_beta: { type: "number", description: "Beta baked into a freshly seeded policy (default 0.6)." },
    beta_grid: { type: "array", items: { type: "number" }, description: "Beta grid swept during offline evaluation." },
    higher_is_better: { type: "boolean", description: "False when score_program reports a cost (smaller is better)." },
    beta1: { type: "number", description: "Eq. 1 execution-cost coefficient (default 0.01)." },
    beta2: { type: "number", description: "Eq. 1 parallelism-bonus coefficient (default 0.01)." },
    agent_command: { type: "string", description: "Executable spawned for one attempt (default 'pi')." },
    agent_args: { type: "array", items: { type: "string" }, description: "Arguments for the attempt agent; '{model}' is substituted." },
    model: { type: "string", description: "Model id passed to the attempt agent." },
    reset: { type: "boolean", description: "Also reset the seeded policy to the shipped default (does not delete history)." },
  },
  required: ["name", "workspace", "eval_program", "score_program"],
  additionalProperties: false,
};

const liveParams = {
  type: "object",
  properties: {
    grid: { type: "string", description: "Optional explicit grid as 'branches x refinements' (e.g. '4x6'); default: plan_grid from the policy." },
    note: { type: "string", description: "Free-form note recorded in the live-cycle manifest." },
  },
  additionalProperties: false,
};

const dreamParams = {
  type: "object",
  properties: {
    revision: { type: "number", description: "Override M (policy revisions) for this offline phase." },
    evaluate_only: { type: "boolean", description: "Score the current policy on the frozen history without revising it." },
  },
  additionalProperties: false,
};

const statusParams = {
  type: "object",
  properties: {
    detail: { type: "string", description: "'summary' (default) or 'full' for the per-version score table." },
  },
  additionalProperties: false,
};

export default function dreamRsi(pi: ExtensionAPI): void {
  // The factory only registers things: no processes, sockets, watchers or timers start here, because
  // factories also run in invocations that never start a session. All work happens in tools/commands,
  // and the only session-scoped handles (per-session state) are dropped in `session_shutdown`.
  const runtimes = new Map<string, DreamState>();
  const gatedNames = new Set<string>();

  const projectDir = (ctx: ExtensionContext): string => ctx.cwd;
  const dreamRoot = (ctx: ExtensionContext): string => dreamRootFor(ctx.cwd);

  const stateFor = (ctx: ExtensionContext): DreamState => {
    const key = ctx.sessionManager.getSessionId();
    let state = runtimes.get(key);
    if (!state) {
      state = { mode: false, iteration: 0, running: null };
      runtimes.set(key, state);
    }
    return state;
  };

  const refreshTools = (ctx: ExtensionContext): void => {
    const state = stateFor(ctx);
    const active = new Set(pi.getActiveTools());
    for (const name of gatedNames) {
      if (state.mode) active.add(name);
      else active.delete(name);
    }
    pi.setActiveTools([...active]);
  };

  const setMode = (ctx: ExtensionContext, enabled: boolean): void => {
    stateFor(ctx).mode = enabled;
    pi.appendEntry(MODE_ENTRY, { version: 1, project: dreamRoot(ctx), active: enabled });
    refreshTools(ctx);
    ctx.ui.setStatus("dream-rsi", enabled ? "dream-rsi: active" : undefined);
  };

  const reconstruct = (ctx: ExtensionContext): void => {
    const state = { mode: false, iteration: 0, running: null } as DreamState;
    // `getBranch()` (not `getEntries()`): a mode or iteration recorded on another branch must not
    // leak back in when the session tree is rewired.
    for (const entry of ctx.sessionManager.getBranch() as CustomEntry[]) {
      if (entry.type !== "custom") continue;
      if (entry.customType === MODE_ENTRY) {
        const data = entry.data as { project?: string; active?: boolean };
        if (data?.project === dreamRoot(ctx)) state.mode = data.active === true;
      }
      if (entry.customType === TASK_ENTRY) {
        const data = entry.data as { iteration?: number };
        if (typeof data?.iteration === "number") state.iteration = Math.max(state.iteration, data.iteration);
      }
    }
    runtimes.set(ctx.sessionManager.getSessionId(), state);
    refreshTools(ctx);
    ctx.ui.setStatus("dream-rsi", state.mode ? "dream-rsi: active" : undefined);
  };

  const registerGatedTool = (tool: Parameters<typeof pi.registerTool>[0]): void => {
    gatedNames.add(tool.name);
    pi.registerTool(tool);
  };

  // -- tools ---------------------------------------------------------------

  pi.registerTool({
    name: "dream_rsi_init",
    label: "Dream-RSI Init",
    description:
      "Configure a Dream-RSI task: seed workspace, candidate program, fixed scoring command, budgets (W, K1, K2, M), beta grid and the agent command used for discovery attempts. Writes <project>/.dream-rsi/task.json and seeds .dream-rsi/policy/method.ts from the shipped parallel-refine policy.",
    promptSnippet: "Configure the Dream-RSI task (workspace, eval_program, score_program, budgets, agent).",
    promptGuidelines: [
      "Call dream_rsi_init before dream_rsi_live: it writes .dream-rsi/task.json and seeds the exploration policy.",
      "dream_rsi_init does not run anything expensive; it only writes configuration and validates that the workspace and problem file exist.",
    ],
    parameters: taskParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = dreamRoot(ctx);
      fs.mkdirSync(root, { recursive: true });
      const existing = fs.existsSync(path.join(root, "task.json")) ? readTask(root) : null;
      const task: TaskConfig = {
        ...(existing ?? defaultTask(String(params.name))),
        ...(params.name ? { name: String(params.name) } : {}),
        ...(params.workspace ? { workspace: normalizePathArg(String(params.workspace)) } : {}),
        ...(params.eval_program ? { eval_program: normalizePathArg(String(params.eval_program)) } : {}),
        ...(params.score_program ? { score_program: String(params.score_program) } : {}),
        ...(params.problem_file !== undefined
          ? { problem_file: params.problem_file ? normalizePathArg(String(params.problem_file)) : null }
          : {}),
        ...(typeof params.workers === "number" ? { workers: params.workers } : {}),
        ...(typeof params.k1 === "number" ? { k1: params.k1 } : {}),
        ...(typeof params.k2 === "number" ? { k2: params.k2 } : {}),
        ...(typeof params.revisions === "number" ? { revisions: params.revisions } : {}),
        ...(typeof params.default_beta === "number" ? { default_beta: params.default_beta } : {}),
        ...(Array.isArray(params.beta_grid) ? { beta_grid: params.beta_grid as number[] } : {}),
        ...(typeof params.higher_is_better === "boolean" ? { higher_is_better: params.higher_is_better } : {}),
        ...(typeof params.beta1 === "number" ? { beta1: params.beta1 } : {}),
        ...(typeof params.beta2 === "number" ? { beta2: params.beta2 } : {}),
      };
      task.agent = {
        ...task.agent,
        ...(params.agent_command ? { command: String(params.agent_command) } : {}),
        ...(Array.isArray(params.agent_args) ? { args: params.agent_args as string[] } : {}),
        ...(params.model !== undefined ? { model: params.model ? String(params.model) : null } : {}),
      };

      const errors = validateTask(task);
      const workspacePath = path.resolve(projectDir(ctx), task.workspace);
      if (!fs.existsSync(workspacePath)) errors.push(`workspace does not exist: ${workspacePath}`);
      if (task.problem_file && !fs.existsSync(path.resolve(projectDir(ctx), task.problem_file))) {
        errors.push(`problem_file does not exist: ${path.resolve(projectDir(ctx), task.problem_file)}`);
      }
      if (errors.length > 0) {
        return { content: [{ type: "text", text: `❌ task.json not written:\n- ${errors.join("\n- ")}` }], details: { errors } };
      }

      writeTask(root, task);
      const seeded = fs.existsSync(path.join(root, "policy", "method.ts"));
      const policyPath = seedPolicy(root, task, !seeded || params.reset === true);
      saveTaskEntry(pi, root, { task: task.name, policy: policyPath, iteration: 0 });
      setMode(ctx, true);
      return {
        content: [
          {
            type: "text",
            text: [
              `Dream-RSI configured: ${task.name}`,
              `  root:       ${root}`,
              `  workspace:  ${workspacePath}`,
              `  candidate:  ${task.eval_program}`,
              `  scorer:     ${task.score_program}`,
              `  budgets:    W=${task.workers} K1=${task.k1} K2=${task.k2} M=${task.revisions} beta_grid=[${task.beta_grid.join(", ")}]`,
              `  agent:      ${task.agent.command} ${task.agent.args.join(" ")}`,
              `  policy:     ${policyPath}${seeded && params.reset !== true ? " (existing policy kept)" : " (seeded from the shipped parallel-refine baseline)"}`,
              `Next: dream_rsi_live to run one online rollout.`,
            ].join("\n"),
          },
        ],
        details: { task, policy: policyPath },
      };
    },
  });

  registerGatedTool({
    name: "dream_rsi_live",
    label: "Dream-RSI Live Cycle",
    description:
      "Run one online exploration episode with the current policy: plan_grid decides the branch x refinement grid, the policy batches up to W nodes per decision round (<= K1 rounds), each selected node runs one discovery attempt, and the task's scorer evaluates it. Records the discovery tree as a replay world and appends it to the history.",
    promptSnippet: "Run one Dream-RSI online exploration cycle (policy pi_t, W workers, <= K1 rounds).",
    promptGuidelines: [
      "Use dream_rsi_live to collect one discovery tree; it spends real agent time (W attempts per round), so report the plan and budgets before running it.",
      "After dream_rsi_live, run dream_rsi_dream to improve the exploration policy from the newly recorded world.",
    ],
    parameters: liveParams,
    async execute(_id, params, _signal, onUpdate, ctx) {
      const root = dreamRoot(ctx);
      const state = stateFor(ctx);
      if (state.running) {
        return { content: [{ type: "text", text: `❌ a Dream-RSI phase is already running: ${state.running}` }], details: {} };
      }
      let task: TaskConfig;
      try {
        task = readTask(root);
      } catch (error) {
        return { content: [{ type: "text", text: `❌ ${(error as Error).message}` }], details: {} };
      }
      const iteration = Math.max(state.iteration, latestIteration(root)) + 1;
      const baseline = readBaselineScore(root);
      const previous = latestBest(root);

      const planned = await planNextGrid(root, task, iteration, baseline);
      const grid = params.grid ? parseGrid(String(params.grid), planned.plan) : planned.plan;
      const bakedBeta = typeof planned.beta === "number" ? planned.beta : task.default_beta;

      state.running = `live cycle ${iteration}`;
      ctx.ui.setStatus("dream-rsi", `dream-rsi: live ${iteration} (${grid.branch_count}x${grid.refine_count})`);
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Live cycle ${iteration}: grid ${grid.branch_count} branches x ${grid.refine_count} refinements, W=${task.workers}, K1=${task.k1}, beta=${bakedBeta}\n${grid.reason}`,
          },
        ],
      });
      try {
        const episode = await runLiveEpisode({
          dreamRoot: root,
          projectDir: projectDir(ctx),
          task,
          iteration,
          policyPath: path.join(root, "policy", "method.ts"),
          bakedBeta,
          grid: { branch_count: grid.branch_count, refine_count: grid.refine_count },
          baselineScore: baseline,
          previousBestScore: previous,
          log: (message) => onUpdate?.({ content: [{ type: "text", text: message }] }),
        });
        state.iteration = iteration;
        saveTaskEntry(pi, root, { task: task.name, policy: episode.manifest.policy_version, iteration });
        const report = iterationReport(root, iteration, episode.manifest);
        return {
          content: [{ type: "text", text: report }],
          details: {
            ok: episode.ok,
            iteration,
            grid,
            beta: bakedBeta,
            attempts: episode.tree.nNonRoot,
            rounds: episode.manifest.decision_rounds,
            best: episode.manifest.best_score,
            error: episode.error,
          },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `❌ live cycle failed: ${(error as Error).message}` }], details: {} };
      } finally {
        state.running = null;
        ctx.ui.setStatus("dream-rsi", state.mode ? "dream-rsi: active" : undefined);
      }
    },
  });

  registerGatedTool({
    name: "dream_rsi_dream",
    label: "Dream-RSI Offline Phase",
    description:
      "Run the offline phase: freeze the recorded history as replay worlds, evaluate the current policy version and M-1 revisions of it on every world (deterministic replay, Eq. 1), sweep the beta grid, then select argmax V and deploy the winner for the next live cycle. Each revision is produced by the policy-development agent editing .dream-rsi/policy/method.ts.",
    promptSnippet: "Improve the exploration policy offline: replay M versions over the frozen history, select argmax V, deploy.",
    promptGuidelines: [
      "Use dream_rsi_dream after dream_rsi_live; it spends agent time only on policy revisions, and replay itself is deterministic and cheap.",
      "dream_rsi_dream asserts V* >= V_0: a reported failure means the policy was non-deterministic or non-prefix-only, so its result must not be trusted.",
    ],
    parameters: dreamParams,
    async execute(_id, params, _signal, onUpdate, ctx) {
      const root = dreamRoot(ctx);
      const state = stateFor(ctx);
      if (state.running) {
        return { content: [{ type: "text", text: `❌ a Dream-RSI phase is already running: ${state.running}` }], details: {} };
      }
      let task: TaskConfig;
      try {
        task = readTask(root);
      } catch (error) {
        return { content: [{ type: "text", text: `❌ ${(error as Error).message}` }], details: {} };
      }
      const iteration = Math.max(state.iteration, latestIteration(root));
      if (!fs.existsSync(path.join(root, "trace_pool", `iter${String(iteration).padStart(4, "0")}`))) {
        return {
          content: [{ type: "text", text: "❌ no recorded world yet — run dream_rsi_live first (replay needs a live cycle)." }],
          details: {},
        };
      }

      state.running = `dream phase ${iteration}`;
      ctx.ui.setStatus("dream-rsi", `dream-rsi: dreaming ${iteration}`);
      try {
        const result = await runDreamPhase({
          dreamRoot: root,
          projectDir: projectDir(ctx),
          task: { ...task, revisions: typeof params.revision === "number" ? params.revision : task.revisions },
          iteration,
          evaluateOnly: params.evaluate_only === true,
          log: (message) => onUpdate?.({ content: [{ type: "text", text: message }] }),
        });
        return {
          content: [
            {
              type: "text",
              text: [
                result.ok ? `Dreaming phase ${iteration} complete` : `⚠️ Dreaming phase ${iteration} FAILED: ${result.error}`,
                result.report,
                `  artifacts: ${path.join(root, "history", `r${String(iteration).padStart(4, "0")}_dream`, "proposal_results")}`,
                result.ok
                  ? `Next: dream_rsi_live runs cycle ${iteration + 1} with the deployed policy (beta=${result.deployed_beta}).`
                  : "Do not deploy this result: re-check the policy for hidden state or unrevealed-data access.",
              ].join("\n"),
            },
          ],
          details: {
            ok: result.ok,
            iteration,
            worlds: result.worlds,
            revisions: result.revisions,
            selected: result.selected,
            v_mean: result.evaluations.map((e) => e.v_mean),
            deployed_beta: result.deployed_beta,
            improved: result.improved,
          },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `❌ dream phase failed: ${(error as Error).message}` }], details: {} };
      } finally {
        state.running = null;
        ctx.ui.setStatus("dream-rsi", state.mode ? "dream-rsi: active" : undefined);
      }
    },
  });

  pi.registerTool({
    name: "dream_rsi_status",
    label: "Dream-RSI Status",
    description:
      "Report the Dream-RSI state: recorded iterations with their best scores and baked-in beta, replay worlds, deployed policy version, and the last beta sweep (pareto.reward, AUC, parallel penalty, per-beta frontier).",
    promptSnippet: "Report Dream-RSI iterations, worlds, policy versions and the last beta sweep.",
    promptGuidelines: [
      "Use dream_rsi_status before deciding the next cycle: it shows the live trend (best score per iteration) and the beta sweep that the cross-cycle beta rule reads.",
    ],
    parameters: statusParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = dreamRoot(ctx);
      const state = stateFor(ctx);
      if (!fs.existsSync(path.join(root, "task.json"))) {
        return { content: [{ type: "text", text: `No Dream-RSI task at ${root}. Use dream_rsi_init to configure one.` }], details: {} };
      }
      const summary = statusSummary(root, { full: params.detail === "full", sessionIteration: state.iteration });
      return { content: [{ type: "text", text: summary }], details: { root } };
    },
  });

  // -- command -------------------------------------------------------------

  pi.registerCommand("dream-rsi", {
    description: "Dream-RSI: status | run [n] | live | dream | off",
    async handler(args, ctx) {
      const root = dreamRoot(ctx);
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const verb = parts[0] ?? "help";
      const configured = fs.existsSync(path.join(root, "task.json"));
      const missingTask = (): void => {
        ctx.ui.notify(
          [
            `No Dream-RSI task in this project: ${path.join(root, "task.json")} is missing.`,
            `Ask the agent to configure one (dream_rsi_init: seed workspace, candidate file, scoring command),`,
            `or copy a task.json you configured elsewhere into ${root}.`,
            `Current directory: ${ctx.cwd}`,
          ].join("\n"),
          "error",
        );
      };

      if (verb === "off") {
        setMode(ctx, false);
        ctx.ui.notify("Dream-RSI mode off (state on disk is untouched).", "info");
        return;
      }
      if (verb === "status") {
        ctx.ui.notify(configured ? statusSummary(root, { sessionIteration: stateFor(ctx).iteration }) : `No Dream-RSI task at ${root}.`, "info");
        return;
      }
      if (verb === "run" || verb === "live" || verb === "dream") {
        if (!configured) {
          missingTask();
          return;
        }
        const state = stateFor(ctx);
        if (state.running) {
          ctx.ui.notify(`A Dream-RSI phase is already running: ${state.running}.`, "error");
          return;
        }
        setMode(ctx, true);
        const requested = parts[1];
        if (verb === "run" && requested !== undefined) {
          const parsed = Number(requested);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
            ctx.ui.notify(`/dream-rsi run takes a cycle count between 1 and 100; got "${requested}".`, "error");
            return;
          }
        }
        const cycles = verb === "run" ? (requested === undefined ? 1 : Number(requested)) : 1;
        const instruction =
          verb === "live"
            ? "Run one Dream-RSI online cycle (dream_rsi_live): report the planned grid and beta first, then the attempts, best score and where the records landed."
            : verb === "dream"
              ? "Run the Dream-RSI offline phase (dream_rsi_dream): report the V table, the beta sweep and which policy version was deployed."
              : `Run ${cycles} full Dream-RSI cycle${cycles === 1 ? "" : "s"} in ${root}: for each one call dream_rsi_live, then dream_rsi_dream. Report the planned grid and beta before the first cycle, and after each pair the live score trend with the sweep's pareto.reward. Stop early and tell me why if the live best plateaus while the beta sweep stays flat.`;
        // The command drives the agent rather than dead-ending in a notification: a human at the prompt
        // cannot call tools, and "ask the agent to run the loop" is not an instruction that does anything.
        const delivery = ctx.isIdle() ? {} : { deliverAs: "followUp" as const };
        pi.sendUserMessage(instruction, delivery);
        ctx.ui.notify(`Dream-RSI mode active — asked the agent to run ${verb === "run" ? `${cycles} cycle${cycles === 1 ? "" : "s"}` : verb}.`, "info");
        return;
      }
      ctx.ui.notify(
        [
          "Dream-RSI (arXiv 2609.14858)",
          "  /dream-rsi status        iterations, worlds, policy versions, last sweep",
          "  /dream-rsi live          ask the agent for one online exploration cycle",
          "  /dream-rsi dream         ask the agent for one offline policy-improvement phase",
          "  /dream-rsi run [n]       ask the agent for n full cycles (live then dream)",
          "  /dream-rsi off           leave Dream-RSI mode",
          "",
          `Everything except status/off/help needs a configured task: ${path.join(root, "task.json")}`,
          "Ask the agent to configure one first (dream_rsi_init), in the project you want to optimize.",
          `  root: ${root}`,
        ].join("\n"),
        "info",
      );
    },
  });

  // -- lifecycle -----------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
  // Contribute the skill from this package, so the loop is documented to the agent even when the
  // extension is loaded by path (`pi -e …`) rather than as a package with `pi.skills`.
  pi.on("resources_discover", async () => ({ skillPaths: [SKILLS_DIR] }));
  pi.on("session_shutdown", async (_event, ctx) => {
    runtimes.delete(ctx.sessionManager.getSessionId());
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const state = stateFor(ctx);
    if (!state.mode) return;
    const root = dreamRoot(ctx);
    let note =
      "\n\n## Dream-RSI Mode (ACTIVE)" +
      `\nRoot: ${root} (task.json, policy/method.ts, history/, trace_pool/).` +
      "\nThe loop is: dream_rsi_live (one online exploration cycle -> discovery tree T_t) then dream_rsi_dream (replay every candidate policy version over the frozen history, revise, select argmax V, deploy)." +
      "\nRead the task problem statement and .dream-rsi/history/baseline before proposing a first cycle, and report grid/budget before spending agent time." +
      "\nPolicy code is prefix-only and deterministic; replay is deterministic, so a V* >= V_0 violation means the policy is unsound — do not deploy it.";
    const status = statusSummary(root, { sessionIteration: state.iteration });
    if (status) note += `\n\n${status}`;
    return { systemPrompt: event.systemPrompt + note };
  });

  // Keep the status line honest about in-flight phases.
  pi.on("agent_start", async (_event, ctx) => {
    const runs = activeRuns(dreamRoot(ctx));
    if (runs.length === 0) return;
    const state = stateFor(ctx);
    ctx.ui.setStatus("dream-rsi", `dream-rsi: ${state.running ?? runs[runs.length - 1]}`);
  });
}

/** Seed `.dream-rsi/policy/method.ts` (+ its relative imports) from the shipped baseline. */
function seedPolicy(root: string, task: TaskConfig, overwrite: boolean): string {
  // One implementation of the runtime copy lives in the engine; seeding must not duplicate it.
  ensurePolicyRuntime(root, BUNDLED_POLICY_DIR);
  const target = path.join(root, "policy", "method.ts");
  if (overwrite || !fs.existsSync(target)) {
    const template = fs.readFileSync(path.join(BUNDLED_POLICY_DIR, "method.ts"), "utf8");
    fs.writeFileSync(target, template.replace(/default_beta = 0\.6;/, `default_beta = ${task.default_beta};`), "utf8");
  }
  // Fail early if the package was installed without its prompt templates.
  for (const name of ["discovery-agent.md", "policy-improvement.md"]) loadPrompt(name);
  return target;
}

/**
 * Models sometimes prefix path arguments with `@` (pi's built-in tools accept that too). Normalize it
 * before resolving, or a perfectly good path looks like a missing directory.
 */
function normalizePathArg(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function parseGrid(value: string, fallback: { branch_count: number; refine_count: number }): { branch_count: number; refine_count: number; reason: string } {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/.exec(value.trim());
  if (!match) return { ...fallback, reason: `${fallback.reason} (grid argument "${value}" not understood; expected e.g. 4x6)` };
  return {
    branch_count: Math.max(1, Number(match[1])),
    refine_count: Math.max(1, Number(match[2])),
    reason: `explicit grid from the operator: ${match[1]} branches x ${match[2]} refinements`,
  };
}

function readBaselineScore(root: string): number | null {
  const file = path.join(root, "history", "baseline", "score.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { score?: number };
    return typeof parsed.score === "number" ? parsed.score : null;
  } catch {
    return null;
  }
}

function latestBest(root: string): number | null {
  const dir = path.join(root, "trace_pool");
  if (!fs.existsSync(dir)) return null;
  const iterations = fs
    .readdirSync(dir)
    .map((name) => /^iter(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const last = iterations[iterations.length - 1];
  if (last === undefined) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, `iter${String(last).padStart(4, "0")}`, "live_cycle_manifest.json"), "utf8")) as {
      best_score?: number | null;
    };
    return typeof manifest.best_score === "number" ? manifest.best_score : null;
  } catch {
    return null;
  }
}

function latestIteration(root: string): number {
  // The audit trail on disk decides the next iteration, never session state: a fresh session in a
  // project that already has recorded cycles must continue the history, not restart at t=1 and
  // overwrite the attempt records and workspaces of the cycles before it.
  const dir = path.join(root, "trace_pool");
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .map((name) => /^iter(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .reduce((best, value) => Math.max(best, value), 0);
}
