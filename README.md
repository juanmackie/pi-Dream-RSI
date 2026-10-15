# pi-dream-rsi

Dream-RSI helps a coding agent find measurable improvements in a project, test candidate changes against a fixed evaluator, and apply only verified results. It runs as a [pi](https://pi.dev) extension and follows the method in [Recursive Self-Improvement through Evolving Worlds](https://arxiv.org/abs/2609.14858).

Created by [Juan Mackie](https://juanmackie.com).

## Quick start

Ask for project signals and measurable improvement ideas:

```text
/dream-rsi assess
```

You can focus the assessment and skip session-log access:

```text
/dream-rsi assess "make the parser faster" --no-logs
```

Ask for an improvement in plain language. The improve skill assesses an unmeasured goal, picks a ready lever, and prepares its campaign:

```text
/dream-rsi improve "make the parser faster without changing its output"
```

Intake checks the evaluator before a campaign starts. It measures baseline noise, searches within fixed budgets, verifies paired before-and-after scores, runs correctness gates, and asks a separate agent to review each candidate before it applies a change. You can inspect the campaign while it runs:

```text
/dream-rsi watch
```

## Levers

`/dream-rsi assess [intent]` ranks up to five possible improvements. Each lever names its mechanism, file scope, evidence, metric, evaluator, expected effect, readiness, and confidence. The `dream_rsi_signals` tool supplies bounded project evidence. The assess skill connects that evidence to code paths and measurable goals.

`/dream-rsi improve <intent>` runs this assessment when the request does not already name a measurable goal. It continues only when intake can define a ready evaluator and correctness gate. If the evidence does not support a safe campaign, the skill returns the proposed levers for discussion.

## What it changes

Campaign candidates run in isolated workspace copies. A candidate must improve the metric, pass every declared gate, and receive an accepting adversarial review. The campaign applies at most one verified candidate per cycle, and edits only files in the declared scope.

Dream-RSI writes accepted changes into the project working tree. It does not commit them. Each campaign keeps its patch and recovery journal under `.dream-rsi/campaigns/`, so you can inspect or roll back the applied change. Review the diff and run your normal checks before committing.

## Signals and privacy

The collector reads bounded session files and extracts only tool aggregates; it does not return or analyze user or assistant prose. It considers at most 30 recent sessions from the last 30 days and reads no more than 20 MiB per session. It reports safe command heads, timings, redacted error categories, and nearby edited paths. It also summarizes recent Git changes, existing evaluator files, and campaign outcomes.

Use `--no-logs` to skip all session-directory access. Git and evaluator summaries still run. Signal collection is read-only and does not run project commands.

## Evaluator contract

A campaign needs a numeric score and a correctness result. Its scorer must be fixed outside candidate-editable files, write the configured score JSON, and be declared with its data in `verifier_inputs`. Put the project's tests in the gate commands. Keep credentials and production systems out of candidate workspaces.

The intake runs `dream_rsi_improve` with `action: "check"` before a campaign starts. Check uses fresh copies and reports evaluator or gate diagnoses without creating campaign history. Fix each diagnosis and check again before starting. When `minimum_gain` is omitted, Dream-RSI estimates measurement noise from repeated baseline scores and requires an improvement above that calibrated threshold.

Status also reports the loaded extension directory, campaign module, package version, and the 300,000 ms evaluator cap. If these do not match the checkout you expect, reload the extension before starting a campaign.

## Limits

| Limit | Default ceiling |
|---|---:|
| Cycles | 5 |
| Agent starts, including review | 36 |
| Evaluator starts, including pairs and gates | 100 |
| Campaign deadline | 60 minutes |
| Consecutive cycles without a verified gain | 2 |
| Candidates verified per cycle | 3 deterministic, 2 noisy |
| Evaluator timeout | 300 seconds |

- The score must measure the outcome you care about. A weak proxy rewards its blind spots.
- Noisy or slow evaluators consume budget and can hide real changes. Stabilize the evaluator before running a campaign.
- Parallel candidate runs need isolated workspaces and must not share mutable services.
- Agent-generated code is untrusted. Gate it, review the diff, and keep the candidate away from secrets and production.
- The campaign applies only in-scope files. It does not commit, open a pull request, or chain automatically to another lever.
- The historical live and dream policy loop is not a 1.0 user command. Earlier `.dream-rsi/task.json` and `history/` data remain on disk and are not used by campaigns.
- Paused campaigns from 0.8.x remain loadable. Resume uses their saved goal, scope, verifier identity, remaining budgets, and deadline.

## Watching

`/dream-rsi watch` opens the framed campaign dashboard. It shows the campaign id, current cycle and limit, phase, selected candidate, progress, and recent output. Use `Ctrl+Shift+D` for the same view. `/dream-rsi status`, `/dream-rsi stop`, and `/dream-rsi resume` inspect or control the campaign.

The dashboard reads campaign state only. It does not fall back to legacy history. If an older installation left `.dream-rsi/task.json` or `.dream-rsi/history/`, status reports that the data is retained but unused.

## Install

Install the npm package:

```text
pi install npm:pi-dream-rsi
```

Or load a local checkout:

```text
pi -e "/absolute/path/to/pi-dream-rsi"
```

The extension contributes the `dream-rsi`, `dream-rsi-assess`, and `dream-rsi-improve` skills. It has no runtime npm dependencies and requires Node.js 22.18 or newer.

## Method background

The paper's method improves an exploration policy by evaluating candidate policies against recorded search worlds. The repository still uses that policy runtime in its protected self-evaluator, but the 1.0 extension workflow exposes bounded project campaigns. See [the method and replay objective](docs/method.md) for the paper's online and replay phases, reward, and limits.

The repository's fixed Mind2Web scorer remains documented in [the Mind2Web scorer guide](docs/mind2web-scorer.md). It is not run by the campaign setup script or by the test suite as a benchmark.

## Tests

Run the checks from a checkout:

```bash
npm run typecheck
npm test
```

The tests use temporary projects and deterministic subprocess agents. They do not call hosted models or run benchmarks from other projects.
