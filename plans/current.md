# Current project plan

**Status:** Dream-RSI 3.0.0 is implemented and merged to `main`. Standing checked 2026-10-19 at merge commit `dbc83f3`. This is the maintained baseline; there is no active rewrite plan.

## Repository standing

- `main` is the only persistent local and remote branch. `origin/main` is the shared source of truth.
- Keep local `main` fast-forwarded to `origin/main`. Use review branches only temporarily and remove them after merge.
- Make future implementation plans against the current `main` tree. The removed 2.x policy runtime, self-campaign, tournament, and containment systems are not part of the current direction.

## Product approach

Dream-RSI has two user paths: read-only assessment and a consent-gated autonomous loop. The loop discovers measurable levers, qualifies its metric, runs bounded experiments in isolated workspaces, confirms candidate gains, runs correctness gates and adversarial review, applies accepted changes, and verifies each apply independently.

Completed experiments are retained as worlds. Deterministic replay evaluates bounded search configurations against recorded worlds. A dream agent can propose configuration data, but the runtime never executes agent-authored search-policy code. Metric qualification, gates, confirmation, and independent verification remain fixed guardrails.

Trusted-local consent means repository commands execute with the host user's access. The loop's durable budget and state live under the target project's `.dream-rsi/` directory. See [the loop guide](../docs/autonomous-loop.md) and [the method note](../docs/method.md) for behavior details.

## Future change and release checks

1. Start from an up-to-date `main`; state the user-visible problem and the smallest change that addresses it.
2. Add or update focused tests before changing core loop behavior. Keep assessment read-only and preserve the fixed promotion guardrails.
3. Run `npm run typecheck`, `npm test`, and `DREAM_RSI_HELDOUT=1 npm test` for loop or experiment changes. Check `npm pack --dry-run` for release contents.
4. For changes to the statistics instrument, capture `npm run bench -- --seeds 2000` output and compare it with a saved baseline before claiming equivalence.
5. Get a fresh-context review of the final diff, then merge to `main` and remove the temporary branch refs.
6. Run any real-model fixture only with explicit user approval for its cost.
