# Existing evaluation audit

> **Historical audit of the former structural scorer.** Benchmark version 2 now measures production
> replay behavior and fixes the equal-score regression described here. See [PROBLEM.md](../../../PROBLEM.md)
> for the current scoring contract. The measurements below are retained as evidence of the original issue.

Ran the existing scorer on three policies in separate temporary workspaces, then called the production `replayEpisode` entry point on the two valid policies. No model calls were made. The project policy, scorer, and Dream-RSI state were not edited.

| Policy | Existing score | Valid | Replay probes | Replay attainment | Replay V |
|---|---:|---|---:|---:|---:|
| shipped | 130 | true | 6 | 9 | 8.959999999999999 |
| idle | 130 | true | 0 | 0 | 0 |
| syntax-error | 0 | false | n/a | n/a | n/a |

## Finding

The idle policy receives the same 130 points as the shipped policy despite making zero probes and attaining zero on this world. The scorer checks source structure rather than exploration outcomes, so its score cannot distinguish this substantial behavioral regression.

Reuse the production replay engine and Eq. 1 reward calculation for a behavioral eval. Keep the existing import and guardrail checks as validity gates, rather than adding them to a quality score.

## Scope and limits

The frozen world has baseline 0 and two branches with scores [1, 5, 9] and [2, 4, 6], with two workers and four decision rounds. It follows the existing tree/replay fixture format. These are synthetic outcomes, not production traffic or Claude outputs. Ground truth is the explicit world scores and mathematically computed reward; no model-generated answer key is used. Both valid policies are checked for replay determinism. This audit is a scorer integrity check, not a generalization benchmark.

The configured task uses the pi CLI with thinkingmachines/inkling:free. Evaluating Claude generation would require the user's provider/model choice and representative attempt or revision prompts.

## Reproduce

`node eval/audit-existing.mjs`
