---
name: dream-rsi-improve
description: Prepare and run a bounded Dream-RSI improvement campaign for a repository, project, or file. Use for an explicit request to improve or optimize a target.
---

# Improve a project

Choose a measurable goal supported by the project and the user's request. For a vague goal, use the assess skill to rank levers first. Prefer a ready lever with a correctness gate and an evaluator that measures the intended outcome.

Prepare `dream_rsi_improve` with `action: "start"`, `project_dir`, `goal`, `scope`, `verifier_inputs`, `gates`, and `task`. The task names `workspace`, `eval_program`, `score_program`, and explicit `higher_is_better`. Keep the fixed scorer, its fixtures, and gate inputs outside writable scope and declare them in `verifier_inputs`. Exclude dependencies or generated artifacts only when evaluation does not require them.

Use a number for an absolute `minimum_gain`, or a string such as `"5%"` for relative improvement. Percentages require positive raw metric values. Omission tests for positive improvement above zero. It does not convert baseline spread into a gain threshold. Choose an effect the instrument can detect within the budget.

The shipped `evaluators/measure.mjs` wraps local commands. It takes `--mode=elapsed|stdout-number`, `--output=<path>`, `--unit=<label>`, `--warmup=N`, `--repeats=N`, `--timeout=MS`, then `--`, then the command and its arguments. Defaults are elapsed time, 1 warmup, 3 repeats, 300,000 ms, unit `ms`, and `eval/score.json`; it has no help flag. It discards warmups and writes a median plus samples to the output path. A custom evaluator can report any scalar outcome, including acceptance rate, operation count, latency, or size. Explain the connection between the metric and the requested outcome.

Supply an optional `control_patch` for a known improvement. The runtime checks its direction and detectability. Without one, the instrument is reported as unvalidated. Put a slow evaluator's timeout in `task.evaluator_timeout_ms`; the default is 300 seconds. Pass `max_deadline_minutes` (1..720) only when the user names a longer deadline; the campaign default is 60 minutes.

Start runs preflight before any agent. The controller owns candidate briefs, isolated exploration, paired confirmation, gates, review, at most one apply per cycle, and recovery journals. Do not pass internal worker, round, revision, guidance, or repeat settings. Lower ceilings with `max_cycles`, `max_agent_starts`, and `max_evaluator_runs` when requested.

A start whose caps cannot fund one verified promotion is refused before any campaign directory or process exists: fewer than 7 agent starts, or fewer evaluator runs than five baseline readings, one paired confirmation (2 runs deterministic, at least 21 noisy), one run per gate, and one extra paired verification when a control patch is supplied. Until two readings are observed it uses the deterministic floor; two different valid scores switch it to the noisy floor. Relay the refusal's floor and recommended evaluator runs, agent starts, and deadline; unblock it with a higher `max_evaluator_runs`, `max_agent_starts`, or `max_deadline_minutes`, never by retrying the same caps. The deadline is estimated from the fastest observed reading once two readings exist and checked at resume, not at start.

Read the check evidence from status: whether the preflight qualified, each reading's duration, exit code, score or fail class and error, and log path, plus the diagnoses and report path. Cite that report. Never cite a project score file such as `eval/score.json` as evidence: each campaign copy deletes the configured score path before scoring, so a leftover file is not this campaign's measurement.

Use `status`, `stop`, and `resume` to control the saved campaign. Resume keeps its remaining budget and deadline and reuses the readings already saved: it does not pay for them again and fails immediately when a saved reading is invalid. Report applied changes, confirmation evidence, gate and review outcomes, stop reason, and actual process counts. Relay the check's reason when a start or check fails; a campaign that runs out of budget or deadline before a qualified baseline is a failed preflight, not a complete one. A failed measurement is unmeasured, not evidence of no improvement.

For unattended intake, save the same start payload as JSON and invoke `/dream-rsi start <intake.json>`. The runtime uses the same tool parser. Scheduling, committing, pushing, and publishing remain separate actions.
