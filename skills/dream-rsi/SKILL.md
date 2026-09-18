---
name: dream-rsi
description: Run the Dream-RSI loop (arXiv 2609.14858) — an executable exploration policy drives discovery trees of coding-agent attempts, and every offline phase improves that policy by replaying candidate versions over the frozen history. Use when asked to "run dream-rsi", "run another cycle", "improve the exploration policy", "recursive self-improvement loop", or to continue a loop that is already configured. Setup is a separate skill (`dream-rsi-create`).
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
| `dream_rsi_init` | Write `.dream-rsi/task.json`, seed `.dream-rsi/policy/method.ts` from the shipped parallel-refine baseline, validate the workspace/problem file, and measure your own code into `history/seed/score.json`. Cheap. |
| `dream_rsi_live` | One online cycle: `plan_grid` picks the branch × refinement grid, the policy batches nodes, W attempts run in parallel, the scorer evaluates each — records world `t`. Expensive (real agent time). |
| `dream_rsi_dream` | Offline phase: replay `M` policy versions over all recorded worlds, sweep the beta grid, revision-agent rewrites the policy between revisions, select argmax `V`, deploy the winner. Moderately expensive (M−1 agent calls). |
| `dream_rsi_apply` | Copy a recorded candidate's `eval_program` over the user's code. Requires `confirm: true`, copies only the declared program (plus paths the user names), never commits. |
| `dream_rsi_status` | Iterations with best score + baked beta, worlds, policy versions, last sweep (`pareto.reward`, AUC, parallel penalty), and the best candidate on record. |

`dream_rsi_live`, `dream_rsi_dream` and `dream_rsi_apply` are **gated**: they only become callable in Dream-RSI
mode (`/dream-rsi`, or automatically after `dream_rsi_init`). Commands: `/dream-rsi create [goal]`,
`/dream-rsi suggest [goal]` (alias `best`), `/dream-rsi status | live | dream | run [n] | off`. Free text is
treated as a goal.

## Setup (ask, don't guess)

**Setting up is a separate job with its own skill.** `/dream-rsi create <goal>` loads `dream-rsi-create`, which
interviews the user, prefers wrapping an existing benchmark as the scorer, verifies that scorer on known-good /
broken / fast-but-wrong candidates, writes the problem file, calls `dream_rsi_init`, probes the attempt agent,
and **stops before spending a cycle**. Use that skill rather than improvising a setup.

What good setup looks like, in short:

1. **Problem** — what is being optimized, and where the statement lives (`problem_file`).
2. **Workspace** (`workspace`) — the seed state that *is* the discovery root `r`. Attempts copy it, so prefer a
   small subdirectory over `"."`.
3. **Candidate program** (`eval_program`) — the file each attempt must implement/improve.
4. **Scoring command** (`score_program`) — fixed and read-only, kept **outside the seed workspace** (anything
   inside is a copy the candidates can rewrite, including their own judge). It writes `eval/score.json` with
   `{"score": <number>, "valid": <bool>, "fail_class": "ok", "error": null}`; higher score must mean better
   (set `higher_is_better: false` for a cost). It must not depend on the agent's prose.
5. **Budgets** — `workers` (W), `k1` (K1), `k2` (K2), `revisions` (M), `beta_grid`, `beta1`, `beta2`.
   Start at `W=2, K1=3, K2=4, M=2`; the paper's shape is `W=10, K1=11` (strong model) or `W=32, K1=20` (fast
   model) over ~5 rounds.
6. **Agent command** — default `pi -p --no-session -na --no-extensions --no-skills`, prompt over stdin. A
   configured `model` is passed as `--model <id>` unless `args` already contains `{model}`; `dream_rsi_init`
   prints the effective command line — check it.

Before spending agent time, confirm the scorer distinguishes success from failure. A broken scorer turns the
whole loop into noise, and the cost is paid in agent calls, not in seconds.

## The loop

1. `dream_rsi_live` → world `t`. Cycle 1 doubles as the baseline: its best attempt is copied to
   `history/baseline/` and becomes the floor every later attempt must read and beat.
2. `dream_rsi_dream` → versions `v0000..v000M-1`, beta sweep, winner deployed to `policy/method.ts`.
3. Every cycle result ends with the ranked candidates (see *Recommending and applying*), and that ranking is
   what the user acts on. Repeat live → dream for as many rounds as the budget allows.

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

## Recommending and applying

Nothing in this tool ever writes to the user's source tree: candidates live in `.dream-rsi/work/r<iter>/<cell>/`
until someone says otherwise. Every `dream_rsi_live`/`dream_rsi_dream` result therefore ends with the ranked
candidates, and `/dream-rsi suggest <goal>` reproduces that ranking on demand. Present it like this:

1. **The top pick**, with its score versus the user's measured baseline, the gain, and its secondary metrics.
2. **The caveats that matter**: the `mentions:` line lists words from the candidate's own proposal. When it says
   `stale`, `window`, or `approx`, the candidate is admitting a trade the scorer cannot see — say so in the same
   breath as the win, and point at the proposal.
3. **The runner-ups**, one line each — usually the conservative alternative that gives up a little score for a lot
   less risk.
4. **Then ask.** `dream_rsi_apply cell=<id> confirm=true` copies the declared `eval_program` (plus any paths the
   user names) over their code and appends to `history/applied.jsonl`. It never commits, never branches, never
   runs tests. Applying is the user's decision, every time — never call it on your own initiative, and never
   present it as already done.

`/dream-rsi create <goal>` on a configured project does the same thing, so a user who starts with "set this up"
also ends with "here is what to take". Goal words pick the preference: `fastest` (strict score), `safest` (keeps
≥95% of the best win, less to take on first), `simplest` (fewest changed files).

## Guardrails

- **Never hand-edit `policy/method.ts` yourself** during the loop. Editing the policy *is* the dreaming
  phase; a manual edit outside the evaluated/selected version set breaks the `V* ≥ V_0` guarantee.
- **Never apply a candidate unasked.** No commit, no branch, no "I went ahead and copied it".
- **Attempts must not run the scorer** unless the problem statement says otherwise; the runtime owns
  scoring, and an attempt that games the scorer poisons the world it becomes.
- **Prefix-only**: policy decisions may use revealed observations, the baseline, legal sets, structural
  meta and the helper signals — never unrevealed scores, a true optimum, absolute score targets, hardcoded
  winning cell ids, or internal trace data (`policy_execution_traces.jsonl` is between-round feedback only).
- **Determinism is checked**: replay runs twice and compares decision traces. A reported
  `V* ≥ V_0` violation means the policy is non-deterministic or reaching outside the prefix — never deploy
  that result.
- **A recommended score is not a correctness review.** The scorer measures one metric on one workload; a
  candidate can win by caching repeated work or by trading a guarantee. Read its proposal before recommending it.
- **Cost**: W attempts per round × K1 rounds per cycle is real agent time. Report grid, beta and budget
  before each cycle; prefer fewer, wider, high-information cycles over many narrow ones.
- **Failures are evidence, not closure**: a repairable implementation failure (compile/shape/timeout) keeps
  its eligibility and can be recovered; only cumulative evidence closes a direction.

## Layout (all names are the paper's)

```
.dream-rsi/
  task.json                                  budgets, scorer contract, agent command
  .gitignore                                 written on the first cycle: work/ + trace_pool/ + runtime/ stay out of git
  policy/method.ts                           deployed policy (EVOLVE-BLOCK), with api.ts next to it
  policy/v0000.ts …                          every evaluated version, archived
  history/seed/score.json                    what the user's own code measured — the reference point
  history/baseline/                          parallel-refine floor to beat
  history/applied.jsonl                      candidates already applied (append-only)
  history/r0001_live/attempt_<cell>/{proposal.md,eval/score.json,error.txt,agent.log,prompt.md}
  history/r0001_live/tree.json
  history/r0001_dream/proposal_results/{beta_sweep.json,policy_execution_traces.jsonl,selection.json}
  trace_pool/iter0001/{tree.json,live_cycle_manifest.json}     replay world + live sidecar
  trace_pool/iter0001_current/                in-flight mirror
  work/r0001/<cellId>/                        attempt workspaces (agent cwd), one copy per attempt
  runtime/                                    the policy worker + its imports, mirrored out of node_modules
                                              (npm installs), so the worker entry can actually run
```

Ranks are computed from `.dream-rsi` alone (no agent calls, no scorer runs): scores from `trace_pool`, secondary
metrics from the archived `eval/score.json`, changed files by comparing a workspace against the seed, and the
`mentions:` line from each attempt's `proposal.md`.

--- Note --- Session daemon `PI_MODEL=thinkingmachines/inkling:free` used; `agent.model` visible in output/session.
