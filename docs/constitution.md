# Dream-RSI safety constitution

This file maps the roadmap's C1–C8 claims to local enforcement and evidence. Each section names the local evidence and any remaining limit. It does not prove host containment, safety against a malicious process, or results on arbitrary repositories.

## C1 — Commit only an independently verified, in-scope change

The loop runs correctness gates and an independent post-apply measurement before it calls the commit pipeline. The commit pipeline stages only journal-verified paths, checks postimage hashes, validates the resulting tree, and refuses the default branch. Applicable checks: `tests/loop-e2e.test.mjs`, `tests/git-autocommit.test.mjs`, and `tests/loop-preflight.test.mjs`.

## C2 — Protect the verifier, patch applier, and this constitution during self-host runs

For the Dream-RSI repository (identified by `package.json` name or the `extensions/pi-dream-rsi/index.ts` source marker), every proposed and approved contract adds these protected paths:

- `extensions/pi-dream-rsi/engine/verify.ts`
- `extensions/pi-dream-rsi/engine/campaign-patch.ts`
- `docs/constitution.md`

The proposal shows the paths, and direct contract approval adds them before the run can proceed. Bootstrap and candidate scope checks use the resulting protected-assets list. Older saved contracts therefore need explicit replacement approval before reuse with this boundary. The positive self-host and unrelated-project controls are in `tests/run-contract.test.mjs`.

This is an application-level promotion guard. Trusted-local child processes still run with host access, so this list is not a read-only mount or a security boundary against a process that can write to the host directly. Host/container enforcement remains unimplemented and requires separate provisioning approval.

## C3 — Do not exceed durable campaign, process, or evaluator caps

The loop reserves allowance before process dispatch, serializes ownership with a durable lease, reconciles interrupted reservations, and fails closed on malformed accounting. RSI mode preserves lifetime totals and adds renewable UTC-day campaign, process, evaluator, reported-token, and wall-time counters. Each explicit RSI start/resume reserves wall allowance and settles actual elapsed time or conservatively recovers an interrupted reservation. The current loop then blocks before all repository probes, evaluators, agents, and campaigns; campaign/process/token allowances are therefore not spent by RSI work in this build. Receipt accounting is in place for campaigns that do run in legacy mode. Tests cover concurrent reservations, cap edges, migration/recovery, corruption, and blocked RSI dispatch: `tests/loop.test.mjs`, `tests/run-contract.test.mjs`, and `tests/campaign-runtime.test.mjs`.

Reported tokens are not a provider-enforced ceiling. RSI mode blocks all agent dispatch and evaluator bootstrap; no bounded provider adapter or host-isolation boundary is implemented. Legacy trusted-local execution is not an OS/network sandbox: arbitrary code can read host files or make network calls. Do not claim a hard provider spending cap or authorize untrusted/model-backed agent execution based only on these counters.

## C4 — Keep a history-preserving recovery path for each verified commit

Each commit is on the approved local branch and includes campaign, metric, lever, and evidence details; Git retains its parent commit. Status exposes `git revert <commit>` as the operator undo command, and documentation rejects `git reset --hard`. Checks include `tests/git-autocommit.test.mjs`, `tests/loop-e2e.test.mjs`, and the status guidance assertion in `tests/extension.test.mjs`.

There is no automatic post-commit regression check, intent-log reconciliation, or automatic revert. A failed pre-commit check stops before commit; inspect the worktree and report before any recovery action.

## C5 — Do not claim a no-network execution boundary

The current trusted-local runner executes repository commands on the host. Git operations use structured local commands, but no kernel network namespace or container boundary prevents network access from a child or repository Git hook. Network denial is not implemented. Do not run hostile repositories or claim no-network behavior without separately approved sandbox provisioning and tests.

## C6 — Preserve work and report partial state; clean-after-every-abort is not guaranteed

Process trees are cancelled on stop/timeout, and patch journals support cautious recovery that preserves edits made by a person. Some verified or partially applied files can remain in the working tree after an abort so the operator can inspect them. The product does not promise a clean tree after every crash or SIGKILL. Relevant checks include `tests/campaign-patch.test.mjs`, `tests/agent-runner.test.mjs`, and `tests/loop.test.mjs`.

## C7 — Do not treat paired candidate confirmation as contrastive meta-learning

Paired confirmation checks a candidate against its declared metric. Dream/replay tests bounded search configurations; it does not implement a Propose–Probe–Compose harness loop or require consistent contrasts across independent harness probes. C7 is not implemented and must not be claimed.

## C8 — Do not claim a complete reproducibility manifest

Current reports include run and budget information, but there is no schema-validated manifest containing all roadmap fields (pinned repository revision, executor, subset, seed, model IDs, web-access state, statistical results, and commit outcomes). C8 is not implemented. Local fixtures do not substitute for the 10-repository repeated-run evidence.

## Review rule

The constitution records current limits; prose alone does not enforce them. Add an executable guard and a regression test at the owning boundary before upgrading any `not implemented` claim. Container, kernel, provider, scheduler, and external-repository evidence remain gated by separate approval.