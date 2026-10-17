# Changelog

## 2.0.0

- Add a cold-start path: an approved run contract plus bounded discovery let the loop find a measurable bottleneck in a repository it has never seen. Recon reads manifests and source under file, depth and size limits, classifies declared commands (test, benchmark, build, custom), probes each benchmark once, and walks that workload's local import graph so the patch scope is the code the measurement exercises. Session history is no longer required and is still optional.
- Measure a declared script directly when its manifest body is exactly `<runner> <file>` and no lifecycle hook exists, so a package manager's own startup does not dominate every reading. The declared form is preserved for reporting.
- Qualify an instrument without a supplied winning patch: baseline reproducibility, stability against the useful gain, direction and sensitivity under a degraded control in the same measured operation, rejection of a nonexistent workload, an independent correctness oracle that must reject an inert version of the editable code, and a budget-fit check. A failed check rejects the lever with its exact reason. A supplied control patch keeps the existing preflight path.
- Freeze a qualified instrument as a content-addressed evaluation contract carrying the outcome, argv, gates, asset digests, baseline readings and measured sensitivity. Any revision starts a new, non-comparable history.
- Account for the whole run in one durable budget: discovery, qualification, campaigns, post-apply checks and optimizer trials all reserve before a child starts and reconcile after it. Limits stay immutable and a resume never renews them. Legacy budget files keep their counters and are charged a campaign for a leftover reservation.
- Verify every applied change independently: a fresh copy of the result, the declared correctness commands, and the same workload measured again against the pre-campaign baseline. A promoted change that does not clear the useful gain stops the run.
- Add experiment provenance (contract identity, instrument identity, baseline fingerprint, mechanism, parent campaign) and gain-per-confirmation-run allocation for tried levers; a legacy win-rate allocator is retained as the comparison baseline. Experiments from another objective or instrument stay in history but do not steer the run.
- Add versioned optimizer generations with a promotion rule that refuses to certify itself: fixed guard rails cannot be part of a generation, a challenger must beat the champion on a development set and on a sealed confirmation split, any safety violation, regression, cost overrun or too few paired comparisons retains the champion, a decision spends its sealed attempt either way, activation is durable state read by the next process, and rollback restores the previous champion. Optimizer trials are off by default and run only at a plateau with a configured harness.
- Document all of the above in `docs/autonomous-loop.md`, including what trusted-local execution does not contain and what the tool does not promise.
- Require explicit score direction and accept absolute or percentage improvement thresholds.
- Check the evaluator and gates before any campaign agent starts; report noise, detectable effect, cost, and optional control-patch evidence.
- Add a pure paired-measurement engine, seeded DreamBench comparisons, and campaign scenario coverage.
- Record experiment outcomes in an append-only ledger and carry bounded factual memory into later attempts.
- Include the goal, metric, direction, scope, gates, and time budget in candidate briefs.
- Admit valid timeout edits to full confirmation and skip previously decided patch hashes.
- Skip paid policy revisions when replay history is sparse and retain the deployed policy after nonfatal dream failures.
- Add a language-agnostic repeated-command evaluator and JSON-file starts for unattended campaigns.
- Add structural mining and protected self-evaluation with held-out scenarios and a code-size penalty.
- Add the unattended multi-lever loop (`/dream-rsi loop`, `dream_rsi_loop`): it ranks levers from signals, synthesizes and calibrates pinned evaluators for scoped levers, chains bounded campaigns, records outcomes in durable loop memory, and stops on budget, deadline, plateau, blocked state, cancelled, empty inventory, or no verifiable lever. Loop budgets are durable and immutable; applied patches stay uncommitted.
- Ignore runner-created caches and build output (pytest caches, bytecode, dependency trees, virtual environments, compiled targets) when building candidate patches, so a measurement run never counts as an out-of-scope candidate change. A cache-shaped path the repository actually tracks stays candidate-visible at any depth and in either shape (directory or file) — verified with git, with presence in the cycle seed as the fallback when git evidence is unavailable — so an edit inside committed content cannot escape the patch or the scope check.
- Resolve package-manager shims (npm, pnpm, yarn, bun, and similar) through the Windows command interpreter in synthesized evaluators, and spawn real executables directly so paths with spaces stay intact.
- Fail closed on corrupted loop state: the durable budget file (including an explicit null restart counter) and loop memory are schema-validated (safe integers, nonnegative counters, known outcomes, bounded notes and records) before anything is spent or trusted.
- Stop the loop when a campaign ends in a failed state even if an earlier patch was applied and verified; the applied win is still recorded, but the failing campaign is not followed by another one. Lever-level evaluator preflight rejections arrive as failed states too and stay screening outcomes: they are recorded as rejected and the loop continues to the next lever.
- Refuse command arguments that the Windows command interpreter could split or expand in synthesized evaluators, instead of silently running a different command.
- Reserve each campaign's granted budget in the durable loop budget before the campaign starts and reconcile it after it returns: a campaign that throws is charged its full grant and appears in the run's campaign count, a leftover reservation from a killed run is charged once on the next read, and a blocked or overlapping invocation never loads or reconciles the durable budget and persists nothing — no budget or memory write — reporting its blocked state from the returned copy alone.
- Run the loop under a heartbeat lease (`.dream-rsi/loop/lease.json`): the claim publishes the lease as one atomic hard link of a fully written file, so two simultaneous starts cannot both hold it and no contender observes a half-written lease; stale takeover uses a separate exclusive recovery claim, re-reads the lease, and requires a same-host owner process that is no longer alive. If the primary is already absent, the reaper competes for it with an atomic claim and never unlinks a later owner's lease. A live, foreign-host, or unreadable owner blocks takeover. A recovery claim left by a crashed reaper fails closed; inspect `.dream-rsi/loop/lease.json.recovery` and remove it only after confirming its recorded process is not running. Only the current holder removes its lease on exit.
- Treat a dangling junction (or symlink) at the exact transaction tombstone path as a collision rather than hiding it with a following `existsSync`: promotion rejects the collision before any write or journal creation (`entryExists` via non-following `lstatSync`), rollback treats dangling links at target or tombstone as conflicts rather than masking errors with `fileIdentity`, and rollback/reconcile only removes tombstones whose identity matches the recorded original file identity. Ordinary update-plus-delete promotion and collision regression both verified.
- Turn failing and slow command levers into campaigns using the files edited right after their own failures as the declared scope, instead of leaving them unreconstructible, and screen every ranked lever rather than the first four.
- Restart a lever that plateaued through its alternate metric kind once (bounded by the durable `max_restarts` budget) before stopping on plateau.
- Fingerprint the target workspace across verification, gates, review, and patch promotion. Recheck immediately before and after patch writes; reject and roll back when any candidate-visible, unpatched path changes. Exclude only the current transaction's checked, generated deletion tombstones from the promotion digest. Arbitrary external writers are not locked, so a final external change after the post-write check remains outside the atomicity guarantee.
- Key loop start progress, `status`, and the advertised `stop` to the resolved project directory — the session retains the last loop target — so one session can inspect and stop loops that run in another project.

This breaks the intake contract. Internal worker, round, revision, repeat, and guidance fields are not public campaign options. Start a new campaign after upgrading. Commit, push, merge, scheduling, and publication remain manual.

## 1.0.1

Release version only: the campaign-first 1.0.0 merge did not publish to npm. This version makes the 1.0 release available; product behavior is unchanged from 1.0.0.

## 1.0.0

Dream-RSI now guides project improvement through bounded campaigns.

- Added project signals and lever assessment, including bounded session-log summaries and `--no-logs`.
- Added plain-language campaign intake, evaluator check, calibrated baseline noise, and paired verification.
- Added correctness gates and adversarial review before in-scope changes are applied.
- Added campaign status, stop, resume, and framed watch commands with live session model resolution.
- Preserved prior manual task and history data on disk. The 1.0 commands do not read or migrate it.
- Kept version 1 campaign records loadable. Paused campaigns resume with their saved goal, scope, verifier identity, remaining budgets, and deadline.
- Removed the manual create, suggest, live, dream, run, and candidate-ranking command workflow.

This release changes the user-facing workflow. Existing manual-loop data is retained as legacy data and does not become a campaign automatically.
