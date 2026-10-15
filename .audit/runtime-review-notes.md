# Runtime review follow-ups

Slice 3 parent review requested these behavior checks before commit:

- Share patched-copy preparation between scores and gates.
- Preserve raw-score direction when aggregating paired results. All before and after measurements must be valid in noisy verification.
- Use the same trustworthy-score predicate in check and campaign paths, including a null error.
- Pass cancellation through check, baseline measurement and calibration, and avoid subsequent starts after abort.
- Recheck verifier identity after candidate gates and before pending apply.
- Use deterministic noise fixtures and a changed-declared-gate-input control.
- Keep check report names unique and only leave the JSON report.

Slice 4 needs careful review of the resume resolver. Start has the parsed custom agent config available, while resume currently has only campaign status in index.ts. A resolver must preserve the saved command and args on resume while replacing the session model and thinking at each call. Do not silently replace a custom CLI with default pi. A callback receiving the saved config as an argument is a small compatible refinement: zero-argument callbacks still work, and index.ts can merge the current session into the saved config without rereading campaign JSON itself. This is a design option for the implementer, not an accepted implementation yet.

Also verify explicit stale model/thinking flags in saved args cannot defeat the active session. Retain saved configuration unchanged when no active session model is available. The real SDK context uses live getters for model and thinking level.

Parent full slice 3 passed 174/174 and typecheck. Review then found confirming pairs were incorrectly screened individually. Only pair 0 may stop for a subthreshold valid gain; all confirming pairs contribute to the median. New outcome controls will cover a valid losing confirmation, an invalid later score, a real timeout and a candidate below calibrated gain.

Command resume must route stale running records to the guarded recovery path while retaining actual-owner rejection. Review agents must not change the measured patch: apply the exact pre-review bytes, then recheck verifier identity and target conflicts before pendingApply.
