---
name: dream-rsi-improve
description: Prepare and run a bounded Dream-RSI improvement campaign for a repository, project, or file. Use for an explicit request to improve or optimize a target.
---

# Improve a project

Choose a measurable goal supported by the project and the user's request. For a vague goal, use the assess skill to rank levers first. Prefer a ready lever with a correctness gate and an evaluator that measures the intended outcome.

Prepare `dream_rsi_improve` with `action: "start"`, `project_dir`, `goal`, `scope`, `verifier_inputs`, `gates`, and `task`. The task names `workspace`, `eval_program`, `score_program`, and explicit `higher_is_better`. Keep the fixed scorer, its fixtures, and gate inputs outside writable scope and declare them in `verifier_inputs`. Exclude dependencies or generated artifacts only when evaluation does not require them.

Use a number for an absolute `minimum_gain`, or a string such as `"5%"` for relative improvement. Percentages require positive raw metric values. Omission tests for positive improvement above zero. It does not convert baseline spread into a gain threshold. Choose an effect the instrument can detect within the budget.

The shipped `evaluators/measure.mjs` wraps local commands. It measures elapsed time or numeric stdout, discards warmups, and writes a median plus samples to `eval/score.json`. Inspect `--help` for options. A custom evaluator can report any scalar outcome, including acceptance rate, operation count, latency, or size. Explain the connection between the metric and the requested outcome.

Supply an optional `control_patch` for a known improvement. The runtime checks its direction and detectability. Without one, the instrument is reported as unvalidated. Set `evaluator_timeout_ms` for a slow evaluator; its default is 300 seconds.

Start runs preflight before any agent. The controller owns candidate briefs, isolated exploration, paired confirmation, gates, review, at most one apply per cycle, and recovery journals. Do not pass internal worker, round, revision, guidance, or repeat settings. Lower ceilings with `max_cycles`, `max_agent_starts`, and `max_evaluator_runs` when requested.

Use `status`, `stop`, and `resume` to control the saved campaign. Resume keeps its remaining budget and deadline. Report applied changes, confirmation evidence, gate and review outcomes, stop reason, and actual process counts. A failed measurement is unmeasured, not evidence of no improvement.

For unattended intake, save the same start payload as JSON and invoke `/dream-rsi start <intake.json>`. The runtime uses the same tool parser. Scheduling, committing, pushing, and publishing remain separate actions.
