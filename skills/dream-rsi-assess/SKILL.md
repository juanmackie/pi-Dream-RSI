---
name: dream-rsi-assess
description: Analyze a project for measurable improvement levers and rank the strongest evidence-backed options. Use for `/dream-rsi assess`, "what should I improve?", or requests to inspect a project for opportunities.
---

# Assess improvement levers

Assessment is read-only. It does not run project commands, start agents, configure a task, or change files.

Use the explicit project or scope named by the user; otherwise use the active project. Always call `dream_rsi_signals`. If the user states a goal, pass it as `focus`. With no goal text, derive a provisional intent from the project's README, roadmap, or `PROBLEM.md` plus the strongest returned signals, then pass that intent as `focus`. For `/dream-rsi assess ... --no-logs`, pass `include_logs: false`. Do not inspect session logs yourself. The signal collector reads only bounded files from the supplied active session directory, verifies each session header's project path, and skips logs when that directory is unavailable. Never call an unbounded session listing API.

Read relevant project goals, problem statements, source, tests, evaluator scripts, and safe signal evidence paths. Do not run tests, benchmarks, builds, install commands, or candidate agents during assessment. Treat declared commands as unevaluated. Use signal counts and sanitized command heads as observed aggregates; do not repeat raw command arguments, error text, chat content, commit subjects, or free-form campaign reasons. If a path or error was omitted, do not reconstruct it.

Restate one or two outcome metrics from the user's goal or, when absent, the provisional intent. Return up to five distinct levers, ordered by relevance to that intent and evidence strength. For each lever, describe:

- **Mechanism and files:** how a bounded change could move the outcome and the concrete files or project area involved.
- **Evidence:** observed facts with file references or returned aggregate counts; label causal claims as inference.
- **Metric and evaluator:** a repeatable measure, its baseline source, and required correctness gates. Name existing commands without running them.
- **Expected effect and confidence:** high, medium, or low, with a short evidence-based reason. Do not invent numerical gains.
- **Readiness:** ready, needs a baseline, needs a clearer goal, already satisfied, or no defensible measure.

For evaluator-backed opportunities, inspect the evaluator definition and baseline evidence to determine whether the metric has room to improve. Passing the current acceptance cases alone is not evidence of headroom. If all cases pass, identify a separate measurable outcome or mark the lever already satisfied. A proposed known-better fixture or control should be outside candidate scope, declared in `verifier_inputs`, and demonstrate that the metric recognizes better behavior while rejecting invalid behavior. Keep the intake small and cite the baseline's actual headroom without inventing an effect size.

When at least one lever is ready, recommend the top ready lever and end with a usable `/dream-rsi improve "<goal>"` command, including its scope when needed. Derive that command goal from the user's request or your stated provisional intent. If no lever is ready, ask one focused question about the missing goal or measurement. An assessment request never starts a campaign.
