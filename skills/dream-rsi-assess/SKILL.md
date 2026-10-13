---
name: dream-rsi-assess
description: Assess the active project and suggest the best targets for Dream-RSI. Use for `/dream-rsi assess`, "what should I improve?", or requests to inspect a project for measurable opportunities.
---

# Assess improvement targets

Inspect the target and return up to three evidence-backed goals. Assessment is read-only. It does not configure a task, run project commands, start candidate agents, or change files.

## Resolve the target

Use the explicit target from `/dream-rsi assess <target>`. If the user gives no target, inspect the active project at the current working directory. Resolve the project root and state the path, branch, and whether the working tree has local changes.

If the target is a file or subtree, keep findings and proposed scope inside it unless the goal needs a related path. Name each related path and why it is needed. If the user asks to assess Dream-RSI itself, inspect this repository's code and its documented workflow as separate target areas.

## Gather evidence

Read the files that can show a concrete problem or a usable measurement:

- source code and nearby tests;
- package scripts, build and lint configuration, CI workflows, and benchmark definitions;
- project goals and constraints in README, problem, or design files;
- recorded benchmark results, failures, and Dream-RSI campaign history, when present.

Use `rg` and file reads. Do not run tests, benchmarks, build scripts, install commands, or candidate agents during assessment. Report existing commands as unevaluated until a campaign runs them.

Look for a specific gap: a stated requirement without coverage, an observed failure, a measured performance cost, repeated work, or an existing evaluator that can compare an improvement. A TODO, large file, or personal style preference alone does not establish impact.

Separate observed facts from hypotheses. Link every finding to a path and line or a named recorded result. Do not invent issue history, user pain, performance numbers, or a quality score.

## Rank targets

Return at most three distinct target cards. Prefer, in order:

1. A documented user goal, defect, or measured gap with direct evidence.
2. A goal with an existing repeatable evaluator and a baseline.
3. A bounded change that can be isolated and checked within the stated scope.

Use confidence labels `high`, `medium`, or `low`. Explain the evidence behind each label. Do not sum impact, feasibility, or confidence into a numeric ranking.

For each target, report:

- **Target and scope:** the exact project area and likely files.
- **Goal:** one concrete outcome that a user can choose.
- **Evidence:** observed facts with paths and lines, followed by any inference.
- **Evaluation:** a repeatable metric, baseline, and correctness gates. Name existing commands without running them.
- **Readiness:** `ready`, `needs a baseline`, `needs a clearer goal`, `already satisfied`, or `no defensible measure`.
- **Confidence:** `high`, `medium`, or `low`, with a reason.

Passing tests show that a candidate meets those tests. They do not prove improvement by themselves. If all proposed acceptance cases pass on the baseline and no separate metric has room to improve, mark the target `already satisfied` and ask the user to choose a different measurable goal.

## Hand off the selected target

End with a ready-to-use command such as:

```text
/dream-rsi improve <selected goal>
```

Include the target path or scope when the command needs it. If no target has a defensible evaluator, ask the user to choose a measurable outcome before starting a campaign. Do not start the campaign from an assessment request alone.

## Report format

Open with the resolved target and working-tree state. Then list the ranked target cards. If the evidence supports fewer than three targets, return fewer. If it supports none, say what evidence is missing and ask one focused question that would make the next assessment useful.
