# Task: Improve Dream-RSI exploration policy

`extensions/pi-dream-rsi/policy/method.ts` implements the executable exploration policy (`eval_program`).
Objective: improve the policy so the Dream-RSI loop achieves higher synthetic replay scores (faster,
more efficient exploration with correct batch decisions).

The scorer (`.auto/score.py`) runs `.auto/score.mjs` against the workspace: it loads the policy file,
checks syntax and guardrail compliance (`extensions/pi-dream-rsi/policy/runner.ts`), and writes
`eval/score.json` with `{"score": <number>, "fail_class": ...}`.

Correctness is non-negotiable:
- The policy must load (valid TypeScript, imports `LLMDesignedMethod` from `./api.ts`).
- The policy must pass guardrail checks (no forbidden imports like `node:fs`, `process.exit`, etc.).
- The policy must implement `solve()` and `plan_grid()` per the contract in `extensions/pi-dream-rsi/policy/api.ts`.

In scope: `extensions/pi-dream-rsi/policy/method.ts` (the policy file). Off limits: the scorer (`.auto/`),
corpus/fixtures (`tests/` fixtures are read-only), migrations, dependencies (`extensions/` source code
other than the policy file), `.dream-rsi/` loop state.

Generalization: the synthetic replay uses a fixed replay trace derived from the extension's own
`engine/reward.ts` (Eq. 1) and `tests/reward-policy.test.mjs`. Don't special-case the exact trace;
state any trade-off the scorer cannot see (e.g., approximation, staleness window) in `proposal.md`.

Baseline: the seed workspace (`.`) measures a synthetic score based on the current `method.ts` (typically
~110 for a passing policy). Beating it needs a real mechanism change — e.g., improving batch selection
logic, reducing unnecessary rounds, strengthening guardrail compliance — not just tweaking comments.
