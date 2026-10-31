# Trusted-local auto fixture

This small fixture demonstrates the `/dream-rsi auto` contract. It is simulated data, not evidence of a real optimization or magnitude claim.

1. Copy this directory to a temporary Git repository and commit its contents.
2. In pi, run `/dream-rsi auto <goal>` and review the entire contract.
3. Approve trusted-local execution, set a provider-side hard cap, then call `dream_rsi_auto_init` with `command: "node measure.mjs"`, `checks: "node check.mjs"`, and `scope: ["src"]`.
4. A sample experiment changes `src/value.txt` from `10` to `8`; then call `dream_rsi_auto_run` and `dream_rsi_auto_log`.

The auto tool uses a separate temporary copy for measurement and checks. It commits a change only when the check passes and the numeric metric clears the declared gain. Never use this fixture's expected change as a result claim.
