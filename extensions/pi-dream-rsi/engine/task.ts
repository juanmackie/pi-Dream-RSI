/**
 * Task configuration (`task.json`) — everything domain-specific lives here, so the engine stays
 * generic. The paper fixes the *protocol* (attempts, evaluator, scores, budgets), not the task.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Root of all Dream-RSI state, relative to the project directory. */
export const DREAM_DIR = ".dream-rsi";

/** Reasoning levels supported by the pi CLI's `--thinking` flag. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentConfig {
  /** Executable to spawn for one attempt (one generation-evaluation request). */
  command: string;
  /** Arguments; `{model}` and `{thinking}` are substituted when present. */
  args: string[];
  /** Model id passed to the agent, if the command takes one. Fallback for a run without a session model. */
  model: string | null;
  /** Reasoning level passed via `--thinking`, if the command takes one. Fallback for a run without a session level. */
  thinking: ThinkingLevel | null;
  /** How the prompt reaches the agent. `stdin` avoids argv limits and shell quoting entirely. */
  prompt_via: "stdin" | "arg";
}

export interface TaskConfig {
  name: string;
  /** Problem statement shown to attempts (relative to the project dir), if any. */
  problem_file: string | null;
  /** Initial workspace state = `r`, relative to the project dir. Copied for every attempt. */
  workspace: string;
  /**
   * `$eval_program` in the paper's Listing 1: the path (relative to the workspace) of the candidate
   * program an attempt must implement. This is the artifact the discovery agent edits.
   */
  eval_program: string;
  /** Fixed, read-only scoring command run in the attempt workspace; must write `eval/score.json`. */
  score_program: string;
  score_path: string;
  score_field: string;
  valid_field: string;
  fail_class_field: string;
  error_field: string;
  /** False when the evaluator reports a cost (smaller is better); scores are normalized to "larger is better". */
  higher_is_better: boolean;
  /** W — attempts that may run in parallel. */
  workers: number;
  /**
   * Cap on how many online episodes `dream_rsi_live` may run at once (parallel worlds).
   * Real fan-out is `loops x workers` agent processes, so keep it near what the provider allows.
   */
  max_loops: number;
  /** K1 — online decision rounds per live episode. */
  k1: number;
  /** K2 — replay decision rounds per policy-world evaluation. */
  k2: number;
  /** M — policy revisions per offline phase. */
  revisions: number;
  /** Numeric reward shaping for Eq. 1 (the paper states the form, not the values). */
  beta1: number;
  beta2: number;
  /** Beta grid swept during offline evaluation. */
  beta_grid: number[];
  /** Default beta baked into a freshly seeded policy. */
  default_beta: number;
  agent_timeout_ms: number;
  evaluator_timeout_ms: number;
  agent: AgentConfig;
}

export function defaultTask(name = "task"): TaskConfig {
  return {
    name,
    problem_file: null,
    workspace: ".",
    eval_program: "solution.py",
    score_program: "./score.sh",
    score_path: "eval/score.json",
    score_field: "score",
    valid_field: "valid",
    fail_class_field: "fail_class",
    error_field: "error",
    higher_is_better: true,
    workers: 4,
    max_loops: 2,
    k1: 6,
    k2: 8,
    revisions: 3,
    beta1: 0.01,
    beta2: 0.01,
    beta_grid: [0, 0.2, 0.4, 0.6, 0.8, 1],
    default_beta: 0.6,
    agent_timeout_ms: 30 * 60 * 1000,
    evaluator_timeout_ms: 30 * 60 * 1000,
    agent: {
      command: "pi",
      args: ["-p", "--no-session", "-na", "--no-extensions", "--no-skills", "--no-prompt-templates"],
      // A run resolves the *active session* model/thinking level (ctx.model, ctx.thinkingLevel); these are
      // only fallbacks for when no session model is available (SDK/CI). PI_MODEL is not usable here: pi
      // injects it into shell-tool commands, never into the extension process.
      model: null,
      thinking: null,
      prompt_via: "stdin",
    },
  };
}

/** Validation for untrusted `task.json` content. Returns human-readable errors. */
export function validateTask(raw: unknown): string[] {
  const errors: string[] = [];
  const t = raw as Partial<TaskConfig>;
  if (!t || typeof t !== "object") return ["task.json must contain an object"];
  if (typeof t.name !== "string" || t.name.trim() === "") errors.push("name must be a non-empty string");
  if (typeof t.workspace !== "string" || t.workspace.trim() === "") errors.push("workspace must be a non-empty path");
  if (typeof t.eval_program !== "string" || t.eval_program.trim() === "") {
    errors.push("eval_program must be a non-empty path to the candidate program");
  }
  if (typeof t.score_program !== "string" || t.score_program.trim() === "") {
    errors.push("score_program must be a non-empty command");
  }
  for (const key of ["score_path", "score_field"] as const) {
    if (typeof t[key] !== "string" || (t[key] as string).trim() === "") errors.push(`${key} must be a non-empty string`);
  }
  const numbers: [keyof TaskConfig, number, number][] = [
    ["workers", 1, 256],
    ["max_loops", 1, 8],
    ["k1", 1, 10_000],
    ["k2", 0, 10_000],
    ["revisions", 0, 100],
    ["beta1", 0, 1e6],
    ["beta2", 0, 1e6],
  ];
  for (const [key, min, max] of numbers) {
    const value = t[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      errors.push(`${key} must be a number in [${min}, ${max}]`);
    }
  }
  if (!Array.isArray(t.beta_grid) || t.beta_grid.length === 0) {
    errors.push("beta_grid must be a non-empty array");
  } else if (t.beta_grid.some((b) => typeof b !== "number" || !Number.isFinite(b) || b < 0 || b > 1)) {
    errors.push("beta_grid values must be numbers in [0, 1]");
  }
  if (typeof t.default_beta !== "number" || t.default_beta < 0 || t.default_beta > 1) {
    errors.push("default_beta must be a number in [0, 1]");
  }
  const agent = t.agent as Partial<AgentConfig> | undefined;
  if (!agent || typeof agent.command !== "string" || agent.command.trim() === "") {
    errors.push("agent.command must be a non-empty executable name");
  }
  if (agent && (!Array.isArray(agent.args) || agent.args.some((a) => typeof a !== "string"))) {
    errors.push("agent.args must be an array of strings");
  }
  if (agent && agent.thinking != null && !THINKING_LEVELS.includes(agent.thinking)) {
    errors.push(`agent.thinking must be one of ${THINKING_LEVELS.join(", ")} or null`);
  }
  if (agent && agent.prompt_via !== "stdin" && agent.prompt_via !== "arg") {
    errors.push('agent.prompt_via must be "stdin" or "arg"');
  }
  return errors;
}

export function taskPath(dreamRoot: string): string {
  return path.join(dreamRoot, "task.json");
}

/**
 * Merge defaults, then validate. Every entry point into the engine goes through this, so an incomplete
 * object can never reach code that assumes, say, `score_path` exists.
 */
export function normalizeTask(raw: Partial<TaskConfig>): TaskConfig {
  const base = defaultTask(typeof raw?.name === "string" && raw.name ? raw.name : "task");
  const merged: TaskConfig = {
    ...base,
    ...raw,
    agent: { ...base.agent, ...(raw?.agent ?? {}) },
  };
  const errors = validateTask(merged);
  if (errors.length > 0) throw new Error(`invalid task:\n- ${errors.join("\n- ")}`);
  return merged;
}

export function writeTask(dreamRoot: string, task: TaskConfig): void {
  fs.mkdirSync(dreamRoot, { recursive: true });
  fs.writeFileSync(taskPath(dreamRoot), `${JSON.stringify(task, null, 2)}\n`, "utf8");
}

/** Read + validate + fill defaults. Throws with every problem listed, not just the first. */
export function readTask(dreamRoot: string): TaskConfig {
  const file = taskPath(dreamRoot);
  if (!fs.existsSync(file)) throw new Error(`no task.json at ${file}; run dream_rsi_init first`);
  return normalizeTask(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TaskConfig>);
}
