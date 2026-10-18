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

For unattended work on a repository the tool has never seen, run the loop with an approved run contract. It finds a measurable bottleneck itself, qualifies its own instrument, chains verified campaigns, checks every applied change independently, re-ranks against a fresh baseline, and stops on budget, deadline, plateau, blocked state, or no verifiable lever:

```text
/dream-rsi loop "reduce the benchmark duration by 25% without changing its output"
```

The contract is the one place the objective, permissions and spend are decided, and no autonomous step can widen it. It records the outcome and its units, the smallest change worth applying, the preserved gates, the editable roots and protected assets, trusted-local consent, the allowed command categories, the approved providers, and the durable budgets. See [running the autonomous loop](docs/autonomous-loop.md).

Without a contract the loop keeps the earlier signal-driven path, which needs recorded evidence and a known-better control patch. With one, a metric is qualified from independent evidence instead: it must complete on the unchanged target, reproduce its own baseline, respond to a degraded control in the same measured operation, reject a workload that does not exist, and fail an inert version of the editable code at its declared correctness commands. A lever that cannot pass any of those checks is rejected with its reason.

Trusted-local means trusted, not contained: discovered repository code runs as a host process with host access. Only point it at repositories you would run by hand. Loop budgets are durable and immutable: the caps you set stay in force across runs.

Intake checks the evaluator before a campaign starts. It measures baseline noise, searches within fixed budgets, verifies paired before-and-after scores, runs correctness gates, and asks a separate agent to review each candidate before it applies a change. You can inspect the campaign while it runs:

```text
/dream-rsi watch
```

## Levers

`/dream-rsi assess [intent]` ranks up to five possible improvements. Each lever names its mechanism, file scope, evidence, metric, evaluator, expected effect, readiness, and confidence. The `dream_rsi_signals` tool supplies bounded project evidence. The assess skill connects that evidence to code paths and measurable goals.

`/dream-rsi improve <intent>` runs this assessment when the request does not already name a measurable goal. It continues only when intake can define a ready evaluator and correctness gate. If the evidence does not support a safe campaign, the skill returns the proposed levers for discussion.

`/dream-rsi loop <intent>` uses the same evidence without stopping after one campaign. It scores levers with a UCB-style allocation from durable loop memory, synthesizes a pinned evaluator for scoped levers that have none, and runs one bounded campaign per step. Outcomes are recorded in `.dream-rsi/loop/memory.json` with their provenance; the durable spend lives in `.dream-rsi/loop/budget.json`. Applied patches stay uncommitted, and a plateau (three campaigns without a verified win) stops the loop with a Memento-style note for the next run.

Tried levers are allocated by measured gain per confirmation run, so a large improvement that was expensive to confirm competes honestly with a small cheap one. Each win records the contract, instrument and baseline it was measured against; an experiment from another objective or instrument stays in history but does not steer the run.

## Independent verification

Every applied change is checked once more from outside the campaign: a fresh copy of the result, the declared correctness commands, and the same workload measured again against the baseline recorded before any candidate ran. A promoted change that does not clear the smallest useful change stops the run with `post-apply check failed` instead of becoming the next baseline.

## What it changes

Campaign candidates run in isolated workspace copies. A candidate must improve the metric, pass every declared gate, and receive an accepting adversarial review. The campaign applies at most one verified candidate per cycle, and edits only files in the declared scope.

Dream-RSI writes accepted changes into the project working tree. It does not commit them. Each campaign keeps its patch and recovery journal under `.dream-rsi/campaigns/`, so you can inspect or roll back the applied change. Review the diff and run your normal checks before committing.

## Signals and privacy

The collector reads bounded session files and extracts only tool aggregates; it does not return or analyze user or assistant prose. It considers at most 30 recent sessions from the last 30 days and reads no more than 20 MiB per session. It reports safe command heads, timings, redacted error categories, and nearby edited paths. It also summarizes recent Git changes, existing evaluator files, and campaign outcomes.

Use `--no-logs` to skip all session-directory access. Git and evaluator summaries still run. Signal collection is read-only and does not run project commands.

## Evaluator contract

A campaign needs a numeric score and a correctness result. Its scorer must be fixed outside candidate-editable files, write the configured score JSON, and be declared with its data in `verifier_inputs`. Put the project's tests in the gate commands. Keep credentials and production systems out of candidate workspaces.

Every start checks the evaluator and unchanged-target gates before an agent runs. An optional `action: "check"` measures fresh copies without creating a campaign. Five baseline readings estimate noise and the smallest detectable effect. Checks report direction, resolved gain units, projected confirmation cost, and optional known-better control-patch evidence.

The check is fail-fast. After each reading it compares the observed reading time and the remaining deadline and caps against one verified promotion's floor, and stops before the gates when the remaining readings cannot fund a promotion. Each reading is saved as it completes: duration, exit code, score or fail class and error, the last 2000 characters of stdout and stderr, and a per-reading log path. The status check section and its report file are the campaign's measurement evidence. A project score file is not evidence: each candidate copy deletes the configured score path before scoring, so a leftover `eval/score.json` is never read back as a result.

Resume keeps its remaining budget and deadline and reuses the readings already saved. It does not pay for them again, and a saved invalid reading fails the resume immediately instead of retrying it. A limit or deadline that runs out before a qualified baseline makes the campaign `failed` with an evaluator-preflight reason, not `complete`.

Start also refuses, before creating a campaign directory or calling the scorer, caps that cannot fund one verified promotion. A promotion needs 7 agent starts (1 probe, 5 live attempts, 1 review), five baseline readings, one paired confirmation (2 runs when deterministic; 5 + 2 × pairs, at least 21, when noisy), one evaluator process per gate, and one more paired verification when a control patch is supplied. Until two readings are observed the check uses the deterministic floor; two valid scores that differ switch it to the noisy floor. Readings seeded by a loop qualification under the same instrument identity count toward the five and are not paid again. The refusal names the floor and recommended caps; raise them rather than retrying the same values. The deadline is not refused at start because no reading has been observed yet: it is estimated from the fastest observed reading once two readings exist, and checked at resume. `max_deadline_minutes` (1..720) on `dream_rsi_improve` start sets the campaign deadline.

Set `task.higher_is_better` explicitly. Use a number for absolute `minimum_gain`, or `"5%"` for a relative gain. Percentages require positive raw metric values. Omission tests for positive improvement above zero. Deterministic confirmation uses one exact pair; noisy confirmation alternates before/after order in ABBA blocks and can stop for futility. Live scores rank noisy candidates; confirmation decides whether they improve.

For the loop, a run contract may declare its own score evaluator instead of measuring wall-clock duration: `outcome.evaluator` names `argv`, an `output` of `score-json` or `stdout-number`, and optional `inputs`. The declared evaluator is ranked first, its code and inputs are pinned verifier inputs, and the independent post-apply check measures through the same evaluator. Duration levers are rejected unless the outcome is time-like or the contract supplies a proxy justification. The declaration is part of the contract identity, so changing it starts a non-comparable history.

The shipped [command evaluator](evaluators/measure.mjs) measures numeric stdout or elapsed time for any language. It takes `--mode=elapsed|stdout-number`, `--output=<path>`, `--unit=<label>`, `--warmup=N`, `--repeats=N`, `--timeout=MS`, then `--`, then the command and its arguments. Defaults are elapsed time, 1 warmup, 3 repeats, 300,000 ms, unit `ms`, and `eval/score.json`; warmup is at least 0 and repeats are 1..100. It discards warmups and writes the median, samples, and validity to the output path. It has no help flag.

Status reports the loaded extension directory, campaign module, package version, process counts, and ledger health, plus the campaign check section above. The default evaluator timeout is 300,000 ms; `task.evaluator_timeout_ms` can change it. Reload the extension if its loaded directory or version differs from the checkout you expect.

## Limits

| Limit | Default ceiling |
|---|---:|
| Cycles | 5 |
| Agent starts, including review | 36 |
| Evaluator starts, including pairs and gates | 100 |
| Campaign deadline | 60 minutes |
| Consecutive cycles without a verified gain | 2 |
| Candidates verified per cycle | 2 |
| Evaluator timeout | 300 seconds, configurable |

- The score must measure the outcome you care about. A weak proxy rewards its blind spots.
- Noisy or slow evaluators consume budget and can hide real changes. Stabilize the evaluator before running a campaign.
- A campaign whose caps cannot fund one verified promotion is refused at start: 7 agent starts and evaluator runs for five readings, one confirmation, and each gate. The refusal reports the floor and recommended caps; raise them instead of retrying the same values.
- `max_deadline_minutes` on `dream_rsi_improve start` accepts 1..720; the campaign default is 60 minutes. The loop's whole-run `deadline_minutes` accepts 1..720.
- A cap or deadline that runs out before a qualified baseline ends the campaign as a failed evaluator preflight. It is not a completed campaign and does not show that no improvement exists.
- Parallel candidate runs need isolated workspaces and must not share mutable services.
- Agent-generated code is untrusted. Gate it, review the diff, and keep the candidate away from secrets and production.
- The campaign applies only in-scope files. It does not commit, open a pull request, or chain automatically to another lever.
- The historical live and dream policy loop is not a 1.0 user command. Earlier `.dream-rsi/task.json` and `history/` data remain on disk and are not used by campaigns.
- New campaigns use the 2.0 intake contract. Start a new campaign when upgrading an older installation.

## Experiment memory and self-improvement

Campaigns append facts to `history/ledger.jsonl`: attempts, confirmation pairs, gates, reviews, applies, skips, and integrity events. A SHA-256 chain records event order, and `ledger.jsonl.head.json` plus `ledger.jsonl.head.required` detect edits and tail truncation when those checkpoint files remain intact. The checkpoint is stored with campaign state, so it is not an external witness against coordinated rewriting. A bounded digest of this project's history reaches later attempts. Status distinguishes timeouts, known no-edit attempts, duplicate patches, and applied wins.

DreamBench evaluates the measurement engine with seeded synthetic instruments and exercises the controller with scripted agents. Scenarios cover noise, drift, boundary effects, wrong direction, no-ops, cheats, duplicate patches, and timed-out agents with valid edits. Results apply to the tested distributions and budgets, rather than every possible evaluator.

See [running and evaluating self-improvement](docs/self-improvement.md) for the measurement self-target, held-out validation, size penalty, structural usage mining, and opt-in real-model fixtures.

An unattended start accepts the same JSON payload as the tool:

```text
/dream-rsi start /absolute/path/to/intake.json
```

An OS scheduler can invoke `pi -p "/dream-rsi start /absolute/path/to/intake.json"`. This package does not install a scheduler.

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

## Documentation

- [Running the autonomous loop](docs/autonomous-loop.md): the run contract, cold-start discovery, instrument qualification, whole-run budgets, independent verification, and optimizer generations.
- [Measuring and evaluating self-improvement](docs/self-improvement.md): measurement targets, held-out validation, and real-model fixtures.
- [The method and replay objective](docs/method.md): the paper's online and replay phases.

## Tests

Run the checks from a checkout:

```bash
npm run typecheck
npm test
```

The tests use temporary projects and deterministic subprocess agents. They do not call hosted models or run benchmarks from other projects.
