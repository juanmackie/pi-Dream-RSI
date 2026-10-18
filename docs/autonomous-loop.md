# Autonomous loop

Dream-RSI runs a bounded loop over a local project. It ranks measurable levers, qualifies an evaluator, explores candidate changes in isolated workspaces, and applies a change only after confirmation, gates, and adversarial review. An independent post-apply check verifies the result.

## Consent and budgets

Start with `dream_rsi_loop` and `consent: true`. Consent accepts that project code, evaluators, gates, and agents run on the host with the host user's access. Dream-RSI does not contain hostile code.

Defaults are 6 campaigns, 72 agent starts, 200 evaluator runs, and 120 minutes. Budgets persist across runs under `.dream-rsi/loop/` and are not renewed on resume. A campaign receives at most 18 agent starts, 48 evaluator runs, and 60 minutes from the remaining allowance.

The tool accepts a focus, optional evaluator and gates, editable scope, protected assets, command categories, environment allowlist, and budget caps. Without an evaluator, it can qualify a workload duration or test-failure count. With an evaluator, declare its unit and score direction.

## State and recovery

Project state lives under `.dream-rsi/`. Campaign records and append-only attempt evidence are retained. Search-policy configs and dream decisions live under `.dream-rsi/loop/`. Each attempt starts a fresh agent process and receives prior notes and experiment history.

`status` reports progress and spend. `stop` pauses the active campaign. `resume` retries the interrupted attempt and continues the loop. If a 2.x campaign cannot be read, Dream-RSI reports that it cannot resume; v1 stored contracts are normalized when read.

Applied changes remain in the working tree. Review the diff, then keep or revert it with Git.