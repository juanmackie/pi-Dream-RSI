# Task: Improve Dream-RSI exploration policy

`extensions/pi-dream-rsi/policy/method.ts` is the editable candidate program.
Maximize measured exploration quality and efficiency over fixed replay worlds.
The scorer runs the production replay engine; source structure, comments and
candidate-reported result numbers earn no points.

## Scoring contract: benchmark version 2

Invoke the trusted scorer by absolute path from the candidate workspace:

```sh
node "/absolute/path/to/pi-Dream-RSI/.auto/score.mjs" --benchmark-version=2
# Optional Python entry point:
python3 "/absolute/path/to/pi-Dream-RSI/.auto/score.py" --benchmark-version=2
```

Both accept an optional workspace argument and write that workspace's
`eval/score.json`. Keep the scorer, corpus and engine outside the candidate's
editable workspace. Imports resolve relative to the trusted scorer. Only the
candidate's `method.ts` is staged beside trusted policy helpers before execution.

The quality score is the equally weighted mean of four production replay Eq. 1
values:

```text
V = attainment - 0.01 * probes + 0.01 * probes / max(1, rounds)
score = mean(V_deep, V_breadth, V_recovery, V_plateau)
```

Each world has baseline 0, two workers and four decision rounds. The corpus covers
deep improvement, opening new directions, a repairable evaluator failure followed
by success, and a plateau. Scores are fixed synthetic outcomes. A policy runs at
its own default beta; each world runs twice in independent workers to check
determinism. No wall-clock value contributes to quality.

The output keeps `score`, `valid`, `fail_class` and `error`, and adds
`benchmark_version: 2` and `per_world` diagnostics including attainment, probes,
rounds and Eq. 1 value. An idle policy is valid but scores 0. Any guardrail,
execution, batch-contract, timeout or determinism failure invalidates the complete
evaluation with a non-`ok` fail class, even if an earlier world passed. Each policy
run has a two-second deadline; the Python wrapper has a thirty-second outer limit.

## Correctness and edit boundaries

- Export a loadable `OptimalPolicy` extending `LLMDesignedMethod` from `./api.ts`.
- Implement `solve()` and honor the `plan_grid()` contract, including finite positive dimensions.
- Use revealed observations and legal actions only. Preserve legal, duplicate-free batches bounded by the worker count.
- Keep decisions deterministic. Forbidden I/O imports invalidate the policy.

In scope: only `extensions/pi-dream-rsi/policy/method.ts`.
Off limits: scorer, corpus, test fixtures, dependencies, engine modules, policy
helpers, migrations and `.dream-rsi/` state. Policy helpers are always taken from
the trusted harness, regardless of candidate copies.

Do not special-case fixture cell ids, scores or branch counts. Synthetic replay
is a scorer integrity and regression benchmark, not evidence of generalization
to production tasks. Describe any trade-off the scorer cannot measure in
`proposal.md`.

## Upgrading an existing optimization task

Version 1 awarded structure points and could give both shipped and idle policies
130. Those numbers are incompatible with version 2. Reconfigure `score_program`
to the absolute command above, including `--benchmark-version=2`, and remeasure
the seed with `dream_rsi_init remeasure_seed=true`. The changed command updates the
existing scoring fingerprint, excluding old worlds and candidates from ranking
and replay. Record a new live world before dreaming. Preserve old evidence; do
not compare a legacy score against the new behavioral score.
