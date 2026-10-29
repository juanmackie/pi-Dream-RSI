# pi-dream-rsi

Dream-RSI is a pi extension that assesses local projects and runs a verifier-driven improvement loop with durable hard budgets. Continuous continuation is opt-in, plateau-bounded, paced by a minimum interval between campaign starts, and resumes only on an explicit operator action.

## Use it

Use assessment to inspect opportunities without running project commands:

```text
/dream-rsi assess "make the parser faster"
```

Start with the goal. After trusted-local consent, the command prepares the loop in the current chat: the agent reads the project, proposes an evaluator, scope, and gates, then calls the guarded engine with complete settings. You do not need to write a config file:

```text
/dream-rsi loop "reduce benchmark time without changing results"
```

In a non-interactive session, pass `--consent` to accept consent in the command:

```text
/dream-rsi loop "reduce benchmark time without changing results" --consent
```

## Five-minute example

[The deterministic verified-loop example](examples/verified-loop/README.md) is a small Node project with a declared benchmark and exact-output test. Copy it to a disposable Git repository, run its checks, and start Dream-RSI with one goal command. Its baseline and deterministic fixture-agent acceptance test make the workflow reproducible without promising that an arbitrary repository will improve. The fixture test verifies the measurement → correctness/review → independent post-apply check → local branch commit path.

If a new runtime-optimization session has no measurement harness, authorize setup before experiments:

```text
/dream-rsi loop "reduce parser runtime without changing results" --setup-harness --no-auto-commit
```

Setup creates a pinned measurement script and correctness check in `.dream-rsi-harness/`, then qualifies them before search. It uses the same durable budget. In Git projects, setup cannot run in the same contract as auto-commit: use `--no-auto-commit`, put the qualified harness in a clean Git baseline, then separately review a replacement that enables auto-commit. For a non-runtime metric, use `dream_rsi_loop` with `setup_harness: true`, an explicit goal, unit, and direction. See [measurement harness setup](docs/autonomous-loop.md#measurement-harness-setup).

The loop finds measurable levers, qualifies its metric, runs isolated experiments, and applies only changes that pass confirmation, correctness gates, review, and an independent post-apply check. The loop stops when it reaches its budget, cannot find a verifiable lever, or its agent stops working.

Its dream step uses completed experiment worlds to compare bounded search configurations through deterministic replay. An agent may propose configuration data; the loop never executes agent-written code as its search policy. This changes how the loop searches, not model weights.

## What it can and cannot promise

Dream-RSI can find large gains when a repository has a measurable bottleneck, a valid evaluator, and enough approved budget. Results depend on those conditions. It cannot promise a magnitude of improvement for an arbitrary repository, and it may stop without a win when the workload, metric, correctness oracle, or search space is not suitable. A qualified evaluator and passing checks are evidence for a specific change, not proof that every user requirement is covered.

The Dream-RSI paper reports results for its own tasks and algorithm; those are not benchmarks for this extension. This project uses bounded search configurations and deterministic replay rather than executable policies from the paper. See [the method notes](docs/method.md) for the differences.

## Consent and cost

Consent means project code and declared commands run on this host with the host user's access. This is not containment for hostile repositories. Use the loop only on projects you would run by hand. Editable scope limits candidate changes and planned setup writes; existing evaluators, fixtures, and correctness gates may be read or run outside that scope without gaining write permission.

Default durable limits are 6 campaigns, 72 agent starts, 200 evaluator runs, and 120 minutes. A campaign can use at most 18 agent starts, 48 evaluator runs, and 60 minutes from the remaining budget. Agent runs may incur model costs. A real-model run requires an explicit user request.

## Commands

- `/dream-rsi assess [goal]` reads project signals and ranks improvement opportunities.
- `/dream-rsi loop [goal] [--consent] [--no-logs] [--setup-harness] [--auto-commit|--no-auto-commit] [--replace-contract] [--config <file>]` prepares a natural-language goal in chat, then starts the guarded loop. Explicit config/setup commands start directly; without a goal, the command retains saved-setup reuse or declared-workload discovery.
- `/dream-rsi status` shows the saved objective, durable budget, latest blocker, and campaign state, including before a campaign exists. `watch`, `stop`, and `resume` inspect or control campaigns.

A different saved objective needs a separate replacement approval. Interactive sessions offer a summary and full inspection. In headless use with reviewed config/setup settings, `--replace-contract` is explicit replacement authorization; execution consent is still required. During goal preparation, that flag requests a replacement review rather than approving a proposal that does not yet exist. Omitted settings keep the saved scope, gates, and permissions, so use the tool to specify new boundaries when changing domains. Replacement preserves cumulative budgets and one previous approval. See [changing a saved objective](docs/autonomous-loop.md#changing-a-saved-objective).

The preparation workflow prefers an existing evaluator and proposes harness setup only when needed. Its read-only `dream_rsi_loop` `action: "prepare"` resolves the same settings that execution validates and returns instrument suggestions plus a `proposal_id`. New scope, metric choices, and setup writes still need approval. Prepared headless execution uses `approve_proposal: true` with the reviewed digest; changed settings or source require review again. `status` shows preparation before a campaign exists; `stop` invalidates its queued handoff. Preparation uses the current chat model and its normal session cost; spawned setup agents and qualification use the durable loop budget.

For automation, you can bypass agent-led preparation with a reviewed JSON settings file:

```text
/dream-rsi loop --config .dream-rsi/proposal.json --replace-contract
```

The file uses the `dream_rsi_loop` field names and cannot set consent or replacement approval. See [measurement settings file](docs/autonomous-loop.md#measurement-settings-file).

## State and rollback

Invalid preparation settings can be corrected up to three times on the same handoff; no command or durable budget is started just for those corrections. Recovery reports the blocker category and next action, with no blind automatic retries. Engine blockers keep their durable evidence and budget; they do not silently restart.

State lives in `<project>/.dream-rsi/`. Each completed run writes `loop/last-run.md` for operators and `loop/latest-report.json` for tools. A new Git-backed contract defaults to local commits for independently verified wins on `dream-rsi/improve`; the loop never pushes or commits to a default branch. The loop continues through its approved campaign budget until a declared stop condition. See [autonomous-loop.md](docs/autonomous-loop.md) for the clean-tree requirement, opt-out, recovery, and verification details.

## Development

```sh
npm install
npm run typecheck
npm test
```
