---
name: dream-rsi-assess
description: Analyze a project for measurable improvement opportunities. Use for `/dream-rsi assess` or when asked what to improve.
---

# Assess improvement opportunities

Assessment is read-only. Do not run project commands, agents, tests, benchmarks, or installation commands.

Call `dream_rsi_signals` with the user's focus when available. Otherwise infer a provisional goal from project documentation and returned signals. Read the relevant source, tests, evaluator definitions, and evidence paths.

Return up to five distinct levers, ranked by relevance and evidence. For each, name the mechanism, likely files, evidence, measurable outcome, evaluator and correctness gates, expected effect with confidence, and readiness. Label causal claims as inference. Do not invent gains or claim that unrun commands passed.

Recommend the strongest ready lever. End with a `/dream-rsi loop "<goal>"` command. Assessment never starts a loop.