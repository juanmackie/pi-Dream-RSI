# Independent 1.0 review

Use the user's requested Luna model at high reasoning effort. Read-only review after all implementation slices. Do not edit or commit.

Compare `main...v1-campaign-ux` against `.audit/plan.txt`, with the original WIP checkpoint `ce3a13f` as preserved input. Report actionable correctness, compatibility, privacy and packaging findings with verified file lines and concrete triggers. Do not count intentional manual-loop removal as a regression.

Inspect these boundaries in particular:

- Check performs no agent calls, creates no campaign or seed history, diagnoses scratch-relative paths, missing interpreters and actual timeouts, and honors cancellation.
- Calibration distinguishes omitted tolerance from explicit zero and old records. Noisy verification screens once, confirms twice and uses the median; invalid scores veto. Every actual evaluator or gate start consumes the existing budget.
- Review runs after successful metric and gates, before pending apply. Missing, invalid and rejecting verdicts fail closed. Changed bytes, verifier identity and target conflicts cannot bypass measured evidence. Review starts count.
- Every agent role resolves the current session at the call boundary, preserves custom commands, and falls back to saved configuration. Resume retains fixed goal, verifier identity, deadline and budgets, and can recover a dead owner without taking work from a live owner.
- Signals remain bounded and read-only. Metadata filters run before transcript reads. No logs means no session-file reads. Aggregates cannot disclose chat text, raw command arguments, commit subjects or secrets. Missing and malformed sources fail honestly.
- Assess and improve skills agree with the runtime and choose concrete measurable levers without extra approval when a ready lever exists.
- README, release notes, version files, package contents, prompts and skills agree. The self-campaign snapshot preserves the entire immutable scorer closure and never replaces paused campaign inputs.

The parent runs the final verification. If you run additional checks, state their exact scope and outcomes. Separate proven defects from limitations or untested behavior. Native Pi screenshots are unavailable in this environment; the stored dark/light images are browser previews of actual framed ANSI output. Provider-free tests establish routing and controller behavior, not real-model semantic lever selection. No external project benchmarks, push, PR, merge or publication are authorized.
