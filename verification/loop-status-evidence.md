# Loop-status change: verification and unresolved lease result

This record documents the current working-tree change. It is not a release-readiness claim.

## Scope and baseline

- Repository: `pi Dream-RSI`, branch `main`.
- Baseline: `ec8efaf1794f56149c53a03ef3d1f2cc382c14f7`.
- Runtime and test changes: `extensions/pi-dream-rsi/index.ts`, `tests/extension.test.mjs`.
- Behavior documentation: `docs/autonomous-loop.md`.
- Lease implementation and lease tests were not changed.

## Parent-run verification

All commands ran from the repository root. Results below are copied from the test command output.

| Command | Result |
|---|---|
| `node --test tests/extension.test.mjs` | 18 tests, 18 passed, 0 failed, 0 skipped. Full output: `verification/logs/extension-test.log`. |
| `npm run typecheck` | Exit 0. Output: `verification/logs/typecheck.log`. |
| `git diff --check` | Exit 0. Output: `verification/logs/diff-check.log`. |
| `npm test` | 316 tests, 313 passed, 0 failed, 3 skipped. Full output: `verification/logs/npm-test.log`. |
| `DREAM_RSI_HELDOUT=1 npm test` | 316 tests, 316 passed, 0 failed, 0 skipped. Full output: `verification/logs/heldout-test.log`. |

The three default-suite skips are conditional acceptance tests: the multi-bottleneck test and the held-out nested and randomized fixtures. The test output requests `DREAM_RSI_HELDOUT=1`; with that variable set, all three ran and passed.

Captured output summaries:

```text
npm test
ℹ tests 316
ℹ pass 313
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3

DREAM_RSI_HELDOUT=1 npm test
ℹ tests 316
ℹ pass 316
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

## Lease failure: unresolved, not reproduced

An earlier run reported `SyntaxError: Unexpected end of JSON input` in the lease-race tests. The exact cause was not established. A reviewer identified one plausible but unconfirmed mechanism: when hard-link publication is unavailable, the exclusive-create fallback opens `lease.json` with `wx` and writes it afterward, so an unsynchronized direct reader could observe an empty or partial file. This is a hypothesis, not a reproduced cause. No lease code or assertion was changed.

A single controlled comparison ran the stale-reaper case that reads the lease from a spawned process, once on clean HEAD and once on the current tree:

```sh
node --test --test-name-pattern='a reaper that finds the old owner already released' tests/loop.test.mjs
```

```text
Clean HEAD (ec8efaf1794f56149c53a03ef3d1f2cc382c14f7)
✔ a reaper that finds the old owner already released claims the absent primary instead of unlinking a new owner
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0

Current working tree
✔ a reaper that finds the old owner already released claims the absent primary instead of unlinking a new owner
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
```

Raw outputs: `verification/logs/lease-clean-head.log` and `verification/logs/lease-current.log`.

The first clean-HEAD attempt did not reach test execution: that detached tree had no `node_modules`, and Node could not resolve `@earendil-works/pi-coding-agent`. Its ignored `node_modules` was then linked to the already-installed current-tree dependencies. The one subsequent baseline execution passed; the one current-tree execution passed. No test was rerun after a test failure. The earlier parse failure therefore remains documented as unresolved, not fixed or attributed.

## Fresh-context review

A fresh-context, read-only reviewer inspected the final runtime/test/docs diff and surrounding callers. Its verdict was: **“None actionable remain.”** It confirmed that prior stop-target, stopping-feedback, non-TUI coverage, and indicator-conflict findings were addressed. The reviewer did not execute tests; the parent-run results above are the test evidence. The full reviewer report is in `verification/logs/final-review.md`. Clarification: the report's note that the three default-suite skips include lease tests is inaccurate. The raw `npm-test.log` shows the skips are the multi-bottleneck, held-out nested, and held-out randomized acceptance tests; the lease tests ran in both suites.

## Release boundary

No autonomous loop, real-model run, push, publish, deployment, or release was performed.
