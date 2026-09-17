# pi-dream-rsi

A pi extension that runs the **Dream-RSI** method from *Recursive Self-Improvement through Evolving Worlds*
(arXiv [2609.14858](https://arxiv.org/pdf/2609.14858)): a loop where coding agents try candidate programs in
parallel, your scorer grades them, and the code that decides *what to try next* gets rewritten from what actually
worked.

Created by **Juan Mackie** — [juanmackie.com](https://juanmackie.com)

Compare it with the usual autonomous-research loop. Those try one thing, keep it or revert it, and repeat. The
cleverness never compounds — every round starts as dumb as the first one. Here the thing that compounds is the
*policy*: a real TypeScript module that picks which directions to open, which to keep refining, which to batch
together, and when to walk away.

```
   pi_t  --online (K1 rounds, W workers)-->  discovery tree T_t  --freeze-->  replay world i = t
     ^                                                                              |
     |                    H_t fixed: evaluate pi_0..pi_{M-1} on EVERY world,        |
     |                    revise the executable policy between revisions,            |
     |                    select argmax V, assert V* >= V_0                          |
     +---------------------------- deploy pi_{t+1} <--------------------------------+
```

## What happens when you run it

**One online cycle** (`dream_rsi_live`). The policy looks at everything revealed so far and picks a batch of
nodes — up to `W` of them. Each one runs a coding agent that resumes that node's saved workspace and produces a
candidate; your scorer grades it. Repeat for at most `K1` rounds. What you get is a tree: one root (your seed
workspace), branches for the independent directions, a chain of refinements hanging off each one. That tree is
then frozen as a **replay world**.

**The offline phase** (`dream_rsi_dream`). Nothing new is generated. The whole recorded history gets replayed by
`M` candidate policy versions, and replay is deterministic — revealing a node returns the outcome that was
recorded, so a version can be scored on a world in milliseconds. Versions that make good decisions score well:

```
V = max s_v  -  beta1 * N  +  beta2 * N / max(1, k*)     # quality, minus work, plus batching
```

`N` is how many nodes it revealed, `k*` how many decision rounds it used. A policy-development agent then reads
the traces and the numbers and rewrites the policy code; that new version is replayed on the same history.
After `M` versions, the best one is deployed — and because the version that just ran live is always one of the
candidates, the chosen policy can never be worse on replay than what you already had. Next cycle, the better
policy runs online and its world joins the history.

The evaluator also sweeps beta and ranks the curve:

```
pareto.reward = pareto.auc - lambda * parallel_penalty     # full batches ~ 1/W, a serial policy ~ 1
```

That's the whole trick: replay makes policy comparison cheap, so the loop can afford to improve *how* it searches,
not just *what* it has found.

## Use it when

- **You can score the thing with a number.** Runtime, memory, coverage, error, a benchmark suite: if the same
  input gives the same number, you're in business.
- **There are several genuinely different ways to attack it.** Screening rules vs. block updates vs. a different
  layout. The method rewards diverse directions in parallel.
- **Attempts can run in parallel.** `W` agents per round, each in its own workspace copy. If they'd have to
  serialize on one shared resource, the reward stops making sense.
- **Scoring is cheap.** It runs `W × K1` times per cycle. Seconds to minutes is comfortable. Hours is not.
- **You'll run more than one cycle.** Cycle one is just parallel refining — that's Dream-RSI's own baseline. The
  improving starts at cycle two, when the first world can be replayed.
- **Failures are allowed to be ordinary.** Compile errors and shape mismatches are treated as recoverable
  evidence, not dead ends.
- **You can pay for it.** `W × K1` agent calls per cycle, plus `M − 1` for policy revisions. The paper's task
  shape (`W=10, K1=11`) is ~110 attempts *per cycle*.
- **Your seed workspace is small.** Every attempt copies its parent's copy. A 2 GB monorepo means you'll spend
  your day copying, not discovering.

Sweet spots: algorithm engineering (the paper's Lasso-path solver is the showcase), kernels and libraries with a
benchmark harness, heuristics or control policies with a simulator, solver tuning on a fixed instance set, and
pipelines whose quality you can already measure automatically.

## Don't use it when

- **There's no number, or the number is taste.** API design, UX copy, architecture, prose. Judgement doesn't
  parallelize into a reward. Get a review instead.
- **It's one obvious change.** Just make the edit.
- **Something exact exists.** SMT, ILP, DP, gradients, even `git bisect`. Take the answer; search is for when
  there isn't one.
- **Your scorer is noisy.** Timing jitter, flaky tests, a busy CI box. Fix the scorer first — medians, fixed
  seeds, pinned CPU, isolated runner — or you're just optimizing noise with extra steps.
- **The number is a proxy you wouldn't ship.** The loop will find the proxy's holes, not your goal. Add a
  correctness gate or a held-out set.
- **Attempts can't be isolated.** One database, one port, one lock, shared globals. Serialize it or don't run
  parallel attempts.
- **Secrets or production are reachable.** Attempts are agents running with your permissions, and your scorer
  executes task code. Sandbox it and give it a scratch directory.
- **Everything gets reviewed line by line anyway** — auth, payments, crypto, migrations. It can still propose
  candidates, but every attempt is untrusted input, and the review is still yours to do.
- **You need requirements thinking, not search.** Spec it, plan it, implement it.

## How to run it well

**1. Build the scorer before anything else.** It's the ground truth of the whole loop.

- Deterministic. Fixed instances, seeded randomness, no wall-clock thresholds.
- Reports `score` **and** `valid`/`fail_class`, so a fast-but-wrong candidate can't win. A non-`ok` fail class
  records a repairable failure and doesn't score at all.
- Faster than the agent thinks. It's the loop's heartbeat.
- **Kept outside the attempt's editable files.** Every attempt works in a copy of the seed workspace, so a
  scorer living inside that copy can be rewritten by the candidate. The runtime runs your scorer — it can't
  protect a file the candidate can edit. Keep the scorer next to the task and reference it by absolute path.

Then hand-test it on two or three candidates you already have opinions about: the good one, a broken one, a
fast-but-wrong one. If the ordering surprises you, you have a scorer problem, not a search problem. Fix it before
you spend a cent on agent calls.

**2. Start small.** `workers=2, k1=3, k2=4, revisions=2` on a cheap model is about six attempts and one policy
revision per cycle. That's enough to see whether the proposals are real. Once they are, scale to the paper's
shape: `W=10, K1=11` for a strong model, `W=32, K1=20` for a fast one, roughly five cycles, and `M` somewhere
around 3–5 (the paper doesn't publish its value).

**3. Read what it wrote.** After each cycle, look at `history/baseline/` and
`history/r####_live/attempt_*/proposal.md` next to its `eval/score.json`. Are these real experiments? Do the
scores match what the proposals claim? If the attempts are noise, no amount of dreaming saves you.

**4. Watch three numbers.** `V` (selection score of the winning version), the sweep's `pareto.reward`, and the
live best-score trend. A flat sweep means beta isn't buying you anything yet. A parallel penalty near 1 means the
policy is probing one at a time — batching is the first thing the next revision should fix.

**5. Stop on purpose.**

- Live best plateaued two cycles in a row, sweep flat. The recorded worlds have nothing more to teach this policy.
- The scorer saturated — nearly every attempt lands on the same value, so your metric stopped discriminating.
  Widen the workload, don't run more attempts.
- Proposals keep repeating one mechanism. That's a diversity collapse: change the seed workspace or the task.
- You ran out of budget. Fewer wide cycles beat many narrow ones.

**6. Don't.**

- Don't hand-edit `policy/method.ts` mid-run. Editing the policy *is* the dreaming phase, and manual edits break
  the "this version was actually evaluated on this history" provenance behind `V* ≥ V_0`.
- Don't let attempts run or write the scorer.
- Don't deploy or trust a phase that reports `ok: false`.
- Don't keep a policy whose replay came back non-deterministic. That check exists to catch hidden state.

## Install

```bash
# 1. Register it as a pi package (user settings; pi can update or remove it later)
pi install "/absolute/path/to/pi-dream-rsi"
pi install ./relative/path/to/pi-dream-rsi
pi install -l ./pi-dream-rsi                     # project-local (.pi/settings.json) instead
pi remove pi-dream-rsi

# 2. Or load it for a single run
pi -e "/absolute/path/to/pi-dream-rsi"

# 3. Or drop the whole package into an auto-discovered spot (then /reload works)
cp -r pi-dream-rsi .pi/extensions/pi-dream-rsi   # or ~/.pi/agent/extensions/pi-dream-rsi
```

You get `/dream-rsi`, the `dream-rsi` skill, and the `dream_rsi_*` tools. The extension contributes its own skill
path, so the skill shows up however you loaded it. No runtime dependencies. Needs Node ≥ 22.18 (22.6+ with
`--experimental-strip-types`) because policies are TypeScript executed in a worker thread — on an older runtime
you get that sentence instead of a broken worker.

`/dream-rsi` alone prints help; `/dream-rsi status` prints state.

## First run

```text
dream_rsi_init   name="lasso-path" workspace="task/seed" eval_program="solution.cpp" \
                 score_program="node /abs/task/score.mjs" problem_file="task/PROBLEM.md" \
                 workers=10 k1=11 k2=8 revisions=4 \
                 agent_command="pi" agent_args=["-p","--no-session","-na","--no-extensions","--no-skills"] \
                 model="<provider/model>"
dream_rsi_live     # cycle 1 — also drops its best attempt in history/baseline as the floor to beat
dream_rsi_dream    # replay it, rewrite the policy, deploy the winner
dream_rsi_live     # cycle 2 with the better policy — a second world
dream_rsi_dream    # now replaying against both
```

`dream_rsi_live` and `dream_rsi_dream` are gated behind Dream-RSI mode (`/dream-rsi`, or automatically after
`dream_rsi_init`) because they spend real agent time. Everything above is also in the `dream-rsi` skill, which the
agent reads on its own.

## What you give it

`<project>/.dream-rsi/task.json` holds the domain-specific half; the engine stays generic.

| Field | What it is |
|-------|------------|
| `workspace` | The seed state that **is** the discovery root `r`. Each attempt gets a copy. |
| `eval_program` | The candidate program the attempts must implement (the paper's `$eval_program`). |
| `score_program` | Your fixed scoring command, run in an attempt workspace with a timeout. |
| `score_path`, `score_field` | Where the score lands and which field holds it (defaults `eval/score.json`, `score`). |
| `higher_is_better` | `false` for costs. Raw values are kept as `raw_score`; scores are normalized. |
| `problem_file` | Problem statement handed to every attempt (optional). |
| `workers`, `k1`, `k2`, `revisions` | `W`, `K1`, `K2`, `M`. |
| `beta1`, `beta2`, `beta_grid`, `default_beta` | Reward shaping and the swept beta grid. |
| `agent` | The command spawned per attempt and per policy revision; the prompt goes over stdin. |

Your scorer writes this:

```json
{ "score": 12.5, "valid": true, "fail_class": "ok", "error": null }
```

A non-`ok` fail class, or a score that isn't a finite number, makes the attempt a **repairable failure** with an
`error.txt` — it doesn't score, and it doesn't close the direction. `fail_class == "ok"` with `error === null`
counts as a successful evaluation even when `valid` is false: the measured number beats any claim about it.
Crashes, missing files, and timeouts get classified for you (`eval_error`, `timeout`, `no_proposal`,
`agent_error`, `invalid_score`).

## What it leaves on disk

```text
<project>/.dream-rsi/
  task.json                                       budgets, scorer contract, agent command
  policy/method.ts                                the deployed policy (+ api.ts beside it)
  policy/v0000.ts …                               every evaluated version, archived, immutable
  history/baseline/attempt_<cell>/                the floor to beat (best attempt of cycle 1)
  history/r0001_live/attempt_<cell>/              proposal.md, eval/score.json, error.txt, prompt.md, logs
  history/r0001_live/tree.json                    the recorded discovery tree T_1
  history/r0001_dream/proposal_results/
      beta_sweep.json                             pareto.reward, auc, parallel_penalty, frontier, per-version V
      policy_execution_traces.jsonl               per (world, beta, round) — between-round feedback only
      selection.json                              which version won, and the V table
  trace_pool/iter0001/{tree.json,live_cycle_manifest.json}     the replay world + its live sidecar
  trace_pool/iter0001_current/                    in-flight mirror, so a crashed cycle stays visible
  work/<cellId>/                                  attempt workspaces — the agents' cwd
```

## The policy file

`policy/method.ts` is real code. The dreaming phase rewrites the part between `// EVOLVE-BLOCK-START` and
`// EVOLVE-BLOCK-END`:

```ts
export class OptimalPolicy extends LLMDesignedMethod {
  default_beta = 0.6;                                 // baked in for the next live episode
  plan_grid(context) { … }                            // how many directions, how deep
  async solve(question, budget = null) { … }          // one batch per decision round
}
```

Three contracts the runtime actually enforces:

- **Prefix-only.** `question.observed()` shows revealed cells and nothing else. A policy that imports `node:fs`,
  `node:child_process`, `process.exit`, `getBuiltinModule`, or any bare module specifier is refused before it
  runs. The trace files are between-round feedback; reading them inside `solve()` is cheating, not cleverness.
- **Bounded.** Batches must be legal, duplicate-free, at most `max_parallelism`, and never a parent plus its
  child. The environment owns the round limit: after `K1` (live) or `K2` (replay) rounds, `legal_actions()` is
  empty and further probes are rejected. A policy that hangs gets killed on the worker deadline.
- **Deterministic.** Replay runs each version twice in independent workers and compares decision traces. Differ,
  and the version scores as unsound and can't be deployed. `V* ≥ V_0` is asserted, not assumed.

The shipped policy is the paper's controlled baseline: open directions up to the worker count, refine each
frontier, batch as a dynamic portfolio (bounded exploration, at most one recovery attempt for a repairable
failure, then exploitation), route every threshold through one `_schedule(beta)`, and plan the next grid from live
history — wide while scores are climbing, narrow and deeper once they plateau.

## What the paper doesn't tell you

Read this before trusting a number.

| Knob | What this implementation does |
|------|------------------------------|
| `beta1`, `beta2` (Eq. 1) | The paper gives the form, not the values. Defaults `0.01` / `0.01`, configurable per task. |
| `lambda` (sweep ranking) | Same: default `1`, stored next to every sweep. |
| Beta grid, `K1`, `K2`, `M` defaults | Not published. Grid `[0, .2, .4, .6, .8, 1]`, `K1=6`, `K2=8`, `M=3`. The paper's task shape (`W=10, K1=11` for a strong model, `W=32, K1=20` for a fast one, five rounds) is what the skill recommends. |
| `pareto.auc` normalization | "High per-trace attainment with few total probes" is implemented as mean attainment over the probes actually taken, averaged across worlds, then trapezoidal over the beta→work curve. |
| Grid vs. tree bookkeeping | The paper's trees branch by "opening a root". Here an unopened root is a **root slot** (`b<branch>a0`), so one batch can open several directions, as the prompt describes. Replay opens branches in creation order (the paper's root rule), so a policy that takes roots in `legal_roots()` order behaves exactly as written. |
| Semantic direction guidance | Deliberately absent. The paper's §4 ablation found prompt-level semantic guidance over-constrains the search and hurts; `$direction_guidance` renders empty. |

## Tests

```bash
npm test    # 37 tests, no LLM, ~15s
```

It covers `A(T)` and frontier rules, batch legality, replay transitions (root rule, unique recorded child, grid
depth cap, `K2`, `Child(v)=∅`), Eq. 1 worked out by hand, AUC/penalty/frontier, determinism detection,
`V* ≥ V_0`, prefix-only enforcement, a full two-cycle loop with stub agents (live → worlds → revisions → deploy →
replay both worlds), every scorer diagnosis (`invalid_score`, `eval_error`, `no_proposal`, `agent_error`,
`timeout`), and the extension surface (gating, status, session rebuild, branch-local state, crashed-cycle
visibility, schema strictness, package vs. relocated-directory layouts).

What tests can't cover is your scorer and your model. For that: load it (`pi -e "/path/to/pi-dream-rsi"`), then
walk **How to run it well** steps 1–5 on a scratch project. Step 3 tells you whether the task fits; step 5 tells
you when to stop.

## What this is not

No keep/discard hill climb, no auto-commit/auto-revert ladder, no single-metric session file, no dashboard server,
no hook scripts, no branch-per-winner finalizer. If that's what you want, use
[`pi-autoresearch`](https://github.com/davebcn87/pi-autoresearch) — reviewed while scoping this build, no code
from it here.

## References

- *Dream-RSI: Recursive Self-Improvement through Evolving Worlds*, arXiv
  [2609.14858](https://arxiv.org/pdf/2609.14858) (copy in this repo at `2609.14858v1.pdf`). Appendix B's prompts
  ship nearly verbatim in `prompts/`. The method is the paper's authors' work; this package is an independent
  implementation of it.
- Built for [pi](https://pi.dev/), following its extension API
  ([docs](https://pi.dev/docs/latest/extensions)): default factory over `ExtensionAPI`, JSON-Schema tool
  parameters, `pi.appendEntry` state restored from the current session branch, `resources_discover` for the
  skill, and nothing started at factory time.

## Author

**Juan Mackie** — [juanmackie.com](https://juanmackie.com)

## License

MIT © Juan Mackie — [juanmackie.com](https://juanmackie.com). See [LICENSE](LICENSE).
