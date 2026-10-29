---
name: dream-rsi-assess
description: Analyze a project for measurable improvement opportunities. Use for `/dream-rsi assess` or when asked what to improve.
---

# Assess improvement opportunities

Assessment is read-only. Do not run project commands, agents, tests, benchmarks, or installation commands.

Use `dream_rsi_loop` with `action: "prepare"`, the target project, goal, and privacy setting for read-only normalized settings and measurement options when useful. These are source-based suggestions, not approval or proof of qualification. Call `dream_rsi_signals` with the user's focus when available. Otherwise infer a provisional goal from project documentation and returned signals. Read the relevant source, tests, evaluator definitions, and evidence paths. Inspect the saved approval with `dream_rsi_loop` using only `action: "status"`; this is read-only. If an approval exists, read `.dream-rsi/loop/contract.json` to compare its objective, scope, evaluator, and gates with the recommended lever. Separate live activity from historical reports and memory. A previous report, especially one older than the current approval, is not proof of a current blocker. Recheck its remedy against current code and settings; existing gate and evaluator files never need write scope merely to run.

Return up to five distinct levers, ranked by relevance and evidence. For each, name the mechanism, likely files, evidence, measurable outcome, evaluator and correctness gates, expected effect with confidence, and readiness. Label causal claims as inference. Do not invent gains or claim that unrun commands passed.

Recommend the strongest lever that is ready for qualification, not one whose gain is already proved. If it needs different saved settings, name the pending replacement approval. When evidence identifies a dedicated evaluator, provide a proposed `dream_rsi_loop` configuration with its exact argv, output format, unit, direction, pinned inputs, implementation scope, and gates. Mark any unresolved setting as a setup requirement; do not invent it. Existing evaluator, fixture, and gate files need read/run access, not permission to edit them. Only candidate edits and planned bootstrap writes belong in editable scope.

End with `/dream-rsi loop "<goal>"`. Explain that the command prepares the setup in chat, rechecks the recommended evaluator/scope/gates, and obtains any remaining approvals before the guarded engine starts. Provide the proposed settings inline, not as a claimed file write. A settings file is optional for automation; offer `--config <file>` only when such a reviewed file actually exists. Assessment never starts a loop, writes a settings file, or changes an approval. See [loop preparation](../dream-rsi-loop/SKILL.md) for the handoff.