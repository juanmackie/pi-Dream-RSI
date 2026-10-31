# Dream-RSI product-engineering handoff checkpoint

## Goal and user choices

- Goal: continue implementation against `C:/Users/juanm/Downloads/dream-rsi-product-engineering-handoff.md`.
- User authorized scheduled nightly renewal of the handoff's per-night caps: 6 campaigns, 400,000 tokens, 240 wall minutes. There is no lifetime spend ceiling. Preserve lifetime accounting and explicit stop/revocation; do not run real-model campaigns without a separately bounded provider/model setup.
- User chose to skip external-repository proof and adoption metrics. Never claim those are verified or that the evidence plan is 100% complete.
- No push. Keep work on `dream-rsi/improve`; commit only intended, verified files.

## Baseline observed

- Branch `dream-rsi/improve`, HEAD `f59306e48cf792e32a5366fd8107ed9955f6a070`.
- `main` is unchanged. Preserve untracked `.audit/failure-remediation-checkpoint.md` and `.audit/loop-preparation-checkpoint.md`.
- `plans/current.md` describes the 3.0.0 baseline and excludes a self-campaign/tournament rewrite. The user's current request names the newer handoff as target; do not revive the withdrawn Hermes brief or unrelated tournament effort.
- Existing loop already has explicit consent, approved run contracts, durable lifetime budgets, hourly process rates, budget-bounded continuation, plateau handling, RSI-branch auto-commit, structured reports, and manual recovery.
- `@earendil-works/pi-durable` is experimental and is not installed. Official README and article were inspected. The 0.87.0 and 1.4.0 package metadata require Node >=22.19 (the project currently declares >=22.18); Durable storage has one process owner and no cross-process lock. It resumes tasks only after a host reopens the Harness, so a local unattended worker still needs a process/host supervisor. Pin exact versions and isolate replay-sensitive side effects if adding it.

## Decision log

| Decision | Rationale |
| --- | --- |
| Per-night renewal selected | User explicitly approved recurring caps. Keep lifetime counters; renew only at a scheduler-defined night boundary. |
| External repositories and adoption proof skipped | User selected this. Keep external efficacy/adoption findings unverified and excluded from completion claims. |
| No live model spend without configured provider/model ceiling | User approved a token cap but did not name provider, model, or dollar cap. Verify deterministic paths locally. |
| Never register a host scheduler silently | Worker code may be developed locally; persistent OS registration/deployment needs explicit target authorization. |

## Current phase

- Added atomic `.dream-rsi/loop/status.json` snapshots for live activity and terminal status. Final status is written while the process owns the loop lease; blocked contenders cannot clobber another run's snapshot. It reports the configured branch, last observed branch tip, latest observed child command/model, and campaign/agent/evaluator totals; it does not report cumulative token totals.
- Added a package-manifest regression test and narrowed the published docs list after `npm pack --dry-run --json` exposed internal remediation reports and a patch in the npm tarball.
- Fixed an existing Windows test setup race: 500 ms could expire before Python wrote the child PID; the test now allows 5 s startup while retaining timeout and descendant-kill assertions.
- No real model calls or external repository runs were made.

## Verification and continuation

- Current tree: `npm run typecheck` passed. `npm test` passed (428 tests: 425 passed, 0 failed, 3 skipped). The full held-out invocation exceeded the 300-second command limit; the three held-out acceptance tests then passed directly (multi-bottleneck cold start, nested fixture, randomized fixture; 131 seconds). `git diff --cached --check` passed before commit. Earlier checks remain valid: package dry-run and packaged-doc assertions passed.
- Branch-tip reporting committed as `cd6d40e`. Effective child command/model reporting committed as `f59306e`; a fresh-context review found missing resume capture, missing non-campaign child capture, and weak snapshot validation. All three were fixed and regression-tested before commit.
- Independent read-only review `5dc5f142-d863-4612-bcbe-2c3bfdcce825` found two issues: thrown exceptions looked like successful completion, and status writes did not verify current lease ownership. Both were fixed and regression-tested. Fresh-context re-review `8d62b4f9-9660-4caf-b9fb-72fefec4f5f1` confirmed both fixes and found no new issues.
- Local commits on `dream-rsi/improve`: `72f9086` (lease-safe status and package contents), `cd6d40e` (observed branch tip), and `f59306e` (effective child command/model). `main` remains at `ae7e841f1ee53b9ee9bd9383edd76dd99a2a4919`; nothing was pushed. Only the three `.audit/*-checkpoint.md` operator files remain untracked and are preserved.
- Branch-tip and latest child command/model reporting are present in live/terminal `status.json` and `/dream-rsi status`; child metadata is captured for resume/confirm, liveness probes, campaigns, and dream runs, and malformed/unsupported metadata is not presented as fact. Branch-tip observations are explicitly labeled potentially stale after external movement. Still outstanding: distinct RSI mode with scheduled per-night caps and cumulative token accounting; host-owned restartable Pi Durable runner; RSI-mode default cold-start setup; and a multi-hour fixture worker test. External proof/adoption evidence is skipped by user choice. No OS scheduler was installed and no provider/model spend was incurred.
- Do not claim 100% plan completion. Continue from commit `f59306e` and proceed to remaining engineering gaps or report blockers requiring host provisioning/provider settings.
