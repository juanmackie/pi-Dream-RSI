# Dream-RSI 2 review record

Implemented on `codex/dream-rsi-2` with GPT-6 Luna workers under parent integration and independent review. The original checkout was clean. Baseline typecheck and 202 tests passed. This is local release preparation; no push, merge, publish, global installation, or scheduler installation was performed.

## General tool behavior

- Explicit direction, absolute or percentage gains, evaluator preflight before agent starts, candidate briefs, and shared unattended intake.
- Language-independent command evaluation with finite numeric output, validity, samples, warmups, and repeated measurements. Node and Python fixtures exercise separate metric kinds.
- Pure paired measurement decisions, alternating evaluation order, invalid-run rejection, noise calibration, conservative Student cutoffs, bounded confirmation, and up to two confirmations per cycle.
- Scoped patches, correctness gates, adversarial review, journaled apply/recovery, verifier identity checks, and cumulative process budgets.
- Bounded factual experiment memory and content-free session mining, with session opt-out checked before accessing log paths. No repository-specific answers or provider branches in production decisions.
- Candidate-backed measurement/controller self-targets and opt-in prompt scoring with immutable baselines, held-out checks, code-size penalty, pinned fixture sets/model, and durable shared model budgets.

## Evidence and changes made during review

The benchmark initially duplicated a decision rule instead of calling the candidate runner. It now invokes actual `runPaired` callbacks and records their count/order. A template-literal scanner bug understated code tokens; the AST counter now covers tokens after templates and ignores comments. An integration smoke exposed excluded dependency symlinks being rejected as candidate edits; scoped validation now honors exclusions while rejecting in-scope links. The smoke then completed a verified self-improvement with 8 scripted starts and 17 evaluator runs.

DreamBench ran 20,000 primary and 5,000 held-out seeds across 13 scenarios. Maximum one-sided 95% false-accept bounds among null/boundary cases were 0.000526 and 0.000949, below the configured 0.01 per-confirmation target. Reports include the measurement source hash and Node version. The pair-count curve also exercises 8, 16, and 32 pairs.

These are finite simulation results. They do not prove control for arbitrary noise, dependence, or contamination. Five identical baselines can misclassify discrete noisy instruments. Eight pairs have low power when a five-percent minimum leaves little detectable gain; runtime budgets can permit up to 32 pairs. The original plan's optimistic power estimates were not treated as guarantees.

The full suite initially passed 247/248 after integration. Its remaining deadline test expired during five preflight subprocesses under concurrent load before its expected child started. A larger startup allowance retains an assertion that the campaign kills the child well before the child timeout; that focused check passed. Final validation results are recorded below when complete.

## Real-model release check

The user authorized at most 18 agent starts total across fixtures. A single durable counter under `.dream-rsi/release-model-budget.json` applies to the current Luna 6 release checks. Full private execution evidence remains under `.dream-rsi/release-tier2-20261016/`. Sanitized measured results and final validation are appended below.

The query-parser fixture passed offline baseline/control qualification. Assessment structural hit rates and prompt-quality non-regression require distinct evidence; planted manifest levers alone are not model results. No claim of general prompt superiority follows from a small current-prompt release sample.
