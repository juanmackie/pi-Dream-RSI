# pi-dream-rsi

Dream-RSI is a pi extension that assesses local projects and runs a bounded, verifier-driven improvement loop.

## Use it

Use assessment to inspect opportunities without running project commands:

```text
/dream-rsi assess "make the parser faster"
```

Start the autonomous loop with the goal and explicit trusted-local consent:

```text
/dream-rsi loop "reduce benchmark time without changing results"
```

The loop finds measurable levers, qualifies its metric, runs isolated experiments, and applies only changes that pass confirmation, correctness gates, review, and an independent post-apply check. The loop stops when it reaches its budget or cannot find a verifiable lever.

## Consent and cost

Consent means project code and declared commands run on this host with the host user's access. This is not containment for hostile repositories. Use the loop only on projects you would run by hand.

Default durable limits are 6 campaigns, 72 agent starts, 200 evaluator runs, and 120 minutes. A campaign can use at most 18 agent starts, 48 evaluator runs, and 60 minutes from the remaining budget. Agent runs may incur model costs. A real-model run requires an explicit user request.

## Commands

- `/dream-rsi assess [goal]` reads project signals and ranks improvement opportunities.
- `/dream-rsi loop [goal]` starts the unattended loop.
- `/dream-rsi status`, `watch`, `stop`, and `resume` inspect or control it.
- `/dream-rsi improve` and `/dream-rsi start` were removed in 3.0. Use `/dream-rsi loop`.

## State and rollback

State lives in `<project>/.dream-rsi/`. Applied changes stay in the working tree. Review them with Git, then keep or revert the patch with your usual Git workflow. See [autonomous-loop.md](docs/autonomous-loop.md) and [method.md](docs/method.md).

## Development

```sh
npm install
npm run typecheck
npm test
```