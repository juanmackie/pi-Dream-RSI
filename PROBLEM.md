# Task: improve the Dream-RSI exploration policy

The editable candidate is `extensions/pi-dream-rsi/policy/method.ts`. Improve its replay score while keeping its decisions deterministic and within the policy contract.

## Campaign setup

Create the protected verifier snapshot and intake details from the repository root:

```sh
node scripts/setup-self-campaign.mjs
```

The script writes a content-addressed snapshot under `.dream-rsi/verifier/<sha256>/` and creates `.dream-rsi/self-campaign-<sha256>.json`. The intake file is a directly usable `dream_rsi_improve` payload with `action: "start"`, the task, scope, gates, and absolute paths for `verifier_inputs`; it has no extra top-level schema fields. Use it only after an explicit improve request activates the intent guard. Omit `minimum_gain` so Dream-RSI measures baseline noise.

The campaign workspace is the repository root (`.`). Its candidate program and scope are `extensions/pi-dream-rsi/policy/method.ts`. The task uses a protected copy of this file as `problem_file`, and an absolute `score_program` under the same verifier snapshot. The snapshot includes `.auto/score.mjs`, its static import closure, the dynamically started worker and its imports, policy runtime files copied by filename, the package-root marker, and this problem statement. The editable `method.ts` is excluded. The snapshot hash covers the normalized relative paths and bytes of every input.

The script reuses an existing snapshot only when every file still matches its manifest. It never replaces a changed snapshot or overwrites a different intake file. Intake data remains outside the hashed snapshot.

## Scoring contract

The scorer runs the trusted production replay engine over four fixed synthetic worlds. It uses replay objective v1:

```text
V = best_score - beta1 * probes + beta2 * probes / max(1, rounds)
score = mean(V_deep, V_breadth, V_recovery, V_plateau)
```

Each world begins at score zero and uses two workers with four decision rounds. The worlds cover deep improvement, opening new directions, a repairable evaluator failure followed by success, and a plateau. Scores are fixed. No wall-clock value contributes to the result.

The output records `score`, `valid`, `fail_class`, and `error`, plus `benchmark_version` and per-world diagnostics. Each policy runs in independent workers to check replay determinism. A guardrail, execution, batch-contract, timeout, or determinism failure invalidates the whole evaluation. The policy worker has a two-second deadline.

The policy gate runs the trusted policy contract scan against the candidate `extensions/pi-dream-rsi/policy/method.ts`. The `npm test` gate runs the repository suite against the candidate copy. The scorer also scans the candidate and its relative imports. Campaign verification compares the unchanged baseline with candidate patches in paired runs, then runs both gates and a separate adversarial review before applying a strict in-scope improvement.

## Correctness and edit boundaries

- Export a loadable `OptimalPolicy` extending `LLMDesignedMethod` from `./api.ts`.
- Implement `solve()` and honor the `plan_grid()` contract, including finite positive dimensions.
- Use revealed observations and legal actions only. Keep batches legal, duplicate-free, and within the worker limit.
- Keep decisions deterministic. Forbidden I/O imports invalidate the policy.
- Edit only `extensions/pi-dream-rsi/policy/method.ts`.

The synthetic replay is an integrity and regression check. It does not establish that a policy generalizes to production tasks. Do not special-case fixture cell ids, scores, or branch counts. Describe trade-offs the scorer cannot measure in the candidate proposal.

## Older task data

Earlier installations may contain `.dream-rsi/task.json`, worlds, and candidate history from the manual policy workflow. Campaigns leave that data untouched and do not rank or replay it. The new self-campaign uses its immutable verifier snapshot and does not require a migration or remeasurement command.
