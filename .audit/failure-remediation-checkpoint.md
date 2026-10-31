# Dream-RSI failure remediation — parent checkpoint

Mission: `740226d4-dd6f-4277-8470-29109c205bc8` · Goal: `mvnhyxfc-nj2i9f`
Repo: `C:/Users/juanm/Documents/GitHub/pi Dream-RSI` (dirty checkout, `main`, base `c42bebc`)
Pre-task snapshot: `C:/Users/juanm/AppData/Local/Temp/dream-rsi-goal-baseline-763v7dm7`

## Lanes

| Lane | State | Evidence |
| --- | --- | --- |
| attribution | done | parent-verified 26/26 exit 0 |
| instrument (receipt/redaction/gate-set) | done | parent-verified 32/32 exit 0 |
| timeouts-lifecycle | done | parent-verified 65/65 exit 0 + typecheck clean |
| diagnostics (child provenance, malformed output, cleanup ordering) | running (Luna high, sole writer) | pending handoff |
| oracle, preflight, status/report, integration, review, report | pending | — |

## Enforced behavior so far

- Static evaluator attribution only from the declared evaluator's own import graph; explicit nonempty roots nominate only a provisional **unverified dynamic claim** that qualification must prove sensitive; empty roots nominate nothing; static out-of-scope still rejects.
- Qualification writes a bounded redacted receipt (`qualification-evidence-<uuid>.json`) outside disposable copies, with phase/role/command, inert files, fail class, bounded stdout/stderr, effective outer (`wrapperTimeoutMs`) and inner (`workloadTimeoutMs`) allowances.
- Runtime identity is captured once at load: `engineDigest`, `evaluatorDigest`, `instrumentDigest` (wrapper + pinned inputs), node/platform/arch, `contentHash`. A required `identity-stability` check refuses the instrument when the evaluator or a pinned input changes mid-qualification.
- `evaluator_timeout_ms` stays the reviewed outer wrapper cap. Inner allowance = `(cap - 5000 ms cleanup grace) / invocation count`; values below 1000 ms per invocation are refused before any workload runs. Without an explicit cap the wrapper cap is derived from existing sample defaults plus the same grace. Generated wrapper runs each invocation through the shared runner (`runCommand`, shell off) so timeout/abort kill the process tree and cleanup completes before the verdict is written.
- Cleanup failures are returned by `removeScratchDirectory` and recorded as `phase:"cleanup"` receipt events (`failClass: cleanup_failed`, retained scratch basename) instead of only a console warning.
- Gate-set semantics: structural gates may accept inert code when a separate pristine-passing behavioral gate rejects it; all required gates stay mandatory at promotion.

## Known follow-ups

- `docs/autonomous-loop.md` documents the timeout hierarchy, identity pinning, and cleanup evidence.
- Report draft: `C:/Users/juanm/AppData/Local/Temp/dream-rsi-goal-baseline-763v7dm7/report-draft.md` (sections on priorities 2, 3, 6 still marked "verification in progress").
- Baseline full suite (concurrency 2) on the pre-task snapshot: 383 tests, 379 pass, 1 fail (cold-start timing: 243.97 ms vs 245.762 ms), 3 skipped — retained as pre-existing, not weakened.

## Hard constraints

No loop start, no budget increase, no provider/model calls by workloads, no push/publish/deploy/credential action, no hand-edited `.dream-rsi` durable state, no full-suite reruns until the integrator task.
