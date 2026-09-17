---
name: dream-rsi
description: Run the Dream-RSI loop (arXiv 2609.14858) — an executable exploration policy drives discovery trees of coding-agent attempts, and every offline phase improves that policy by replaying candidate versions over the frozen history. Use when asked to "run dream-rsi", "set up dream-rsi", "improve the exploration policy", "recursive self-improvement loop", or to optimize a task by parallel discovery over a discovery tree.
---

# Dream-RSI

Recursive self-improvement of an **exploration policy** over a **discovery tree**. Not a keep/discard
ladder: the artifact that improves is the policy *code*, and it improves by **dreaming** — deterministic
offline replay of candidate policies against worlds recorded from real runs.

```
π_t --online--> discovery tree T_t --freeze--> replay world i=t
 ↑                                                   |
 |                             H_t fixed: evaluate π_0..π_{M-1} on every world,
 |                             revise the code between revisions, select argmax V
 └------------------ deploy π_{t+1} <------------------------+
```

- **Online (K1 rounds, W workers):** the policy picks a batch of eligible nodes (`|batch| ≤ W`) each round;
  every selected node runs one attempt that resumes its parent's saved workspace. The task's fixed scorer
  gives each node a score `s_v`.
- **Replay (K2 rounds):** revealing a node returns its *recorded* outcome. No new generation ever happens,
  so replay is deterministic and cheap.
- **Reward:** selection uses Eq. 1, `V = max s_v − β1·N + β2·N/max(1, k*)` (quality, execution cost,
  parallelism). The beta sweep ranks `pareto.reward = pareto.auc − λ·parallel_penalty`, where a full batch
  approaches penalty `1/W` and a serial policy sits near `1`.

## Tools

| Tool | What it does |
|------|--------------|
| `dream_rsi_init` | Write `.dream-rsi/task.json`, seed `.dream-rsi/policy/method.ts` from the shipped parallel-refine baseline, validate the workspace/problem file. Cheap. |
| `dream_rsi_live` | One online cycle: `plan_grid` picks the branch × refinement grid, the policy batches nodes, W attempts run in parallel, the scorer evaluates each — records world `t`. Expensive (real agent time). |
| `dream_rsi_dream` | Offline phase: replay `M` policy versions over all recorded worlds, sweep the beta grid, revision-agent rewrites the policy between revisions, select argmax `V`, deploy the winner. Moderately expensive (M−1 agent calls). |
| `dream_rsi_status` | Iterations with best score + baked beta, worlds, policy versions, last sweep (`pareto.reward`, AUC, parallel penalty). |

`dream_rsi_live` and `dream_rsi_dream` are **gated**: they only become callable in Dream-RSI mode
(`/dream-rsi`, or automatically after `dream_rsi_init`). `/dream-rsi status | live | dream | run [n] | off`.

## Setup (ask, don't guess)

Get these from the user before the first cycle; every one of them changes results:

1. **Problem** — what is being optimized, and where the statement lives (`problem_file`).
2. **Workspace** (`workspace`) — the seed state that *is* the discovery root `r`. Attempts copy it.
3. **Candidate program** (`eval_program`) — the file each attempt must implement/improve.
4. **Scoring command** (`score_program`) — fixed and read-only; it must write `eval/score.json` with
   `{"score": <number>, "valid": <bool>, "fail_class": "ok", "error": null}`. Higher score must mean better
   (set `higher_is_better: false` if it reports a cost). This file is the scientific ground truth: it must
   never depend on the agent's prose, and it must not be modified by attempts.
5. **Budgets** — `workers` (W), `k1` (K1), `k2` (K2), `revisions` (M), `beta_grid`, `beta1`, `beta2`.
   The paper's shape: `W=10, K1=11` (strong model) or `W=32, K1=20` (fast model), 5 outer rounds.
6. **Agent command** — default `pi -p --no-session -na --no-extensions --no-skills ...`, prompt over stdin.

Then run `dream_rsi_init`. Sanity-check the scorer once by hand in the seed workspace before spending agent
time: a broken scorer turns the whole loop into noise.

## The loop

1. `dream_rsi_live` → world `t`. Cycle 1 doubles as the baseline: its best attempt is copied to
   `history/baseline/` and becomes the floor every later attempt must read and beat.
2. `dream_rsi_dream` → versions `v0000..v000M-1`, beta sweep, winner deployed to `policy/method.ts`.
3. Repeat live → dream for as many rounds as the budget allows.

Between cycles, read `dream_rsi_status` (and `history/r####_dream/proposal_results/beta_sweep.json`):

- **live trend** — best score still rising? Keep width. Plateaued? Narrow and go deeper (that is exactly
  what the shipped `plan_grid` does, and what the improvement agent should refine).
- **sweep non-degeneracy** — if every beta gives the same attainment/work, beta buys nothing yet; do not
  pretend it does. `pareto.reward`, AUC, and parallel penalty are the three numbers to compare.
- **default beta rule** (paper Appendix B): improving → keep the previous beta unless the sweep clearly
  shows better; plateau + higher beta reaching higher attainment at reasonable cost → raise ~0.1–0.2
  (clamped to [0,1]); plateaued high beta that only adds work → lower; insufficient/conflicting evidence
  → ~0.6. Never pick the smallest beta that merely reaches a frozen trace's ceiling.
- **batching** — if the penalty approaches 1 the policy is probing serially: that is the first thing the
  next revision must fix.

## Guardrails

- **Never hand-edit `policy/method.ts` yourself** during the loop. Editing the policy *is* the dreaming
  phase; a manual edit outside the evaluated/selected version set breaks the `V* ≥ V_0` guarantee.
- **Attempts must not run the scorer** unless the problem statement says otherwise; the runtime owns
  scoring, and an attempt that games the scorer poisons the world it becomes.
- **Prefix-only**: policy decisions may use revealed observations, the baseline, legal sets, structural
  meta and the helper signals — never unrevealed scores, a true optimum, absolute score targets, hardcoded
  winning cell ids, or internal trace data (`policy_execution_traces.jsonl` is between-round feedback only).
- **Determinism is checked**: replay runs twice and compares decision traces. A reported
  `V* ≥ V_0` violation means the policy is non-deterministic or reaching outside the prefix — never deploy
  that result.
- **Cost**: W attempts per round × K1 rounds per cycle is real agent time. Report grid, beta and budget
  before each cycle; prefer fewer, wider, high-information cycles over many narrow ones.
- **Failures are evidence, not closure**: a repairable implementation failure (compile/shape/timeout) keeps
  its eligibility and can be recovered; only cumulative evidence closes a direction.

## Layout (all names are the paper's)

```
.dream-rsi/
  task.json                                  budgets, scorer contract, agent command
  policy/method.ts                           deployed policy (EVOLVE-BLOCK), with api.ts next to it
  policy/v0000.ts …                          every evaluated version, archived
  history/baseline/                          parallel-refine floor to beat
  history/r0001_live/attempt_<cell>/{proposal.md,eval/score.json,error.txt,agent.log,prompt.md}
  history/r0001_live/tree.json
  history/r0001_dream/proposal_results/{beta_sweep.json,policy_execution_traces.jsonl,selection.json}
  trace_pool/iter0001/{tree.json,live_cycle_manifest.json}     replay world + live sidecar
  trace_pool/iter0001_current/                in-flight mirror
  work/<cellId>/                              attempt workspaces (agent cwd)
```
