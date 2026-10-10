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

**Cycles can also run in parallel.** Pass `loops=n`, or start several `dream_rsi_live` calls at once, and `n`
episodes of the *same* policy run side by side, each recording its own world. The fan-out is `loops × W` agents
at once (the cap `max_loops` is shared by everything in flight, default 2), so a batch of worlds costs roughly
one cycle of wall clock instead of `n`.

**The offline phase** (`dream_rsi_dream`). The recorded discovery outcomes are reused. Every completed world
under the current scoring contract, including a whole parallel batch, gets replayed by `M` candidate policy
versions, and replay is deterministic —
revealing a node returns the outcome that was
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
- **You want more worlds than wall clock.** `loops=n` (or several `dream_rsi_live` calls at once) records `n`
  worlds of one policy concurrently and one dream replays them all. The policy then improves `n` worlds later,
  so use it for throughput, not for the first exploratory cycle.
- **Scoring is cheap.** It runs `W × K1` times per cycle. Seconds to minutes is comfortable. Hours is not.
- **You'll run more than one cycle.** Cycle one is just parallel refining — that's Dream-RSI's own baseline. The
  improving starts at cycle two, when the first world can be replayed.
- **Failures are allowed to be ordinary.** Compile errors and shape mismatches are treated as recoverable
  evidence, not dead ends.
- **You can pay for it.** `W × K1` agent calls per cycle (`loops × W` at once when you batch worlds), plus
  `M − 1` for policy revisions per dream, however many worlds that dream replays. The paper's task
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

**1. Let `create` run the interview, then build the scorer.** `/dream-rsi create <goal>` (or the goal in plain
words) loads the `dream-rsi-create` skill, which asks for the seed workspace, candidate program, scorer,
correctness gate and budgets — and refuses to start a cycle until the scorer has been verified. It prefers
wrapping a benchmark that already exists in the repo over authoring one. Once a task exists, the same command
asks whether you meant the ranking, a reconfigure (`--reconfigure`), or a fresh task (`--fresh`). The scorer is
the ground truth of the whole loop:

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

**2. Probe the agent, then start small.** `create` runs the effective attempt command once (`pi -p … --model <id>
"Reply with exactly: OK"`) so a bad model id or empty balance costs one small call instead of a cycle of failed
attempts. `workers=2, max_loops=2, k1=3, k2=4, revisions=2` on a cheap model is about six attempts and one policy revision
per cycle (`max_loops` is how many cycles may record worlds at once — `loops × W` agents in flight, shared by
every live or resume call). New cycles use the **active session's model and thinking level**, so switching model
with `/model` changes the next new cycle's attempts. Resumed cycles keep their saved effective settings.
That's enough to see whether the proposals are real. Once they are, scale to the paper's
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

Maintainers: [version bumps on `main` publish automatically to npm](RELEASING.md#one-time-npm-setup) after the
package checks pass. The npm trusted publisher needs a one-time setup before the first automated release.

```bash
# 1. Register it as a pi package (user settings; pi can update or remove it later)
pi install npm:pi-dream-rsi                      # from npm — https://pi.dev/packages/pi-dream-rsi
pi install "/absolute/path/to/pi-dream-rsi"
pi install ./relative/path/to/pi-dream-rsi
pi install -l ./pi-dream-rsi                     # project-local (.pi/settings.json) instead
pi remove pi-dream-rsi

# 2. Or load it for a single run
pi -e "/absolute/path/to/pi-dream-rsi"

# 3. Or drop the whole package into an auto-discovered spot (then /reload works)
cp -r pi-dream-rsi .pi/extensions/pi-dream-rsi   # or ~/.pi/agent/extensions/pi-dream-rsi
```

You get `/dream-rsi` (including `create`, `suggest`, `watch` and `resume`), the `Ctrl+Shift+D` dashboard shortcut,
the `dream-rsi` and `dream-rsi-create` skills, and the
`dream_rsi_*` tools. The extension contributes its own skill
path, so the skill shows up however you loaded it. No runtime dependencies. Needs Node ≥ 22.18 (22.6+ with
`--experimental-strip-types`) because policies are TypeScript executed in a worker thread — on an older runtime
you get that sentence instead of a broken worker.

Setup and read-only help/watch work before a task is configured. Phases and candidate ranking need a task,
and *where* it is configured matters: every command and tool operates on
`<cwd>/.dream-rsi/`, so `/dream-rsi run` in an unconfigured directory stops with
`No Dream-RSI task in this project: …/task.json is missing.` See **First run** below.

`/dream-rsi` alone prints help; `/dream-rsi status` prints state.

## First run

There are two ways in, and they are not interchangeable:

- **`/dream-rsi create <goal>`** — the on-ramp. In a project with no task it turns mode on and loads the
  `dream-rsi-create` skill, which interviews you (objective, seed workspace, candidate program, scorer,
  budgets, agent), wires up the task, measures your code as the baseline, probes the attempt agent, and stops
  before spending a cycle. In a project that already has a task it asks what you meant — show the config and
  **the best candidate for that goal**, reconfigure the task through a fresh interview, or start an unrelated
  task (the old state is archived, not deleted). `--reconfigure` and `--fresh` answer that question without the
  dialog, for print/scripted use.

- **You, at the prompt.** `/dream-rsi create [--reconfigure|--fresh] [goal]` sets up, reconfigures or reports,
  `/dream-rsi suggest [goal]` ranks candidates, `/dream-rsi status` shows state, and `/dream-rsi watch [iteration]`
  inspects trees and logs. `/dream-rsi live [n]`, `dream`, `run [n]` and `resume [iteration]` enable mode and
  ask the agent to run the selected work. `/dream-rsi off` disables gated tools while running work continues.
  `help` (alias `?`, also the bare command) shows help without changing mode. Free text is treated as a goal.
- **The agent.** The `dream_rsi_*` tools. `dream_rsi_init` writes the configuration, `dream_rsi_live`/
  `dream_rsi_dream` run the phases, `dream_rsi_resume` continues an interrupted live tree,
  `dream_rsi_apply` copies a candidate back, and `dream_rsi_status` reports.

**`create` and free text route themselves** to setup or an existing task. `suggest`/`best`, `live`, `dream`,
`run` and `resume` need `<cwd>/.dream-rsi/task.json`. `/dream-rsi create <goal>` writes it via the interview;
commands that need it report this when it is missing:

```text
No Dream-RSI task in this project: <cwd>/.dream-rsi/task.json is missing.
Run /dream-rsi create <goal> to set one up here (the agent calls dream_rsi_init),
or copy a task.json you configured elsewhere into <cwd>/.dream-rsi.
Current directory: <cwd>
```

Which usually means one of two things: you are in the wrong directory (the task lives in the project you want to
optimize, not in this one), or nobody has configured it yet. If it's the second, `/dream-rsi create <goal>` — or
just say what you want optimized and let the `dream-rsi-create` skill ask the questions:

```text
set up Dream-RSI: seed workspace task/seed, candidate file solution.cpp, scorer `node /abs/path/score.mjs`
```

Or drive the tools yourself (budgets here are the paper's task shape; the shipped defaults are smaller — `W=4,
K1=6, K2=8, M=3`):

```text
dream_rsi_init   name="lasso-path" workspace="task/seed" eval_program="solution.cpp" \
                 score_program="node /abs/task/score.mjs" problem_file="task/PROBLEM.md" \
                 workers=10 k1=11 k2=8 revisions=4 \
                 agent_command="pi" agent_args=["-p","--no-session","-na","--no-extensions","--no-skills","--no-prompt-templates","--no-context-files"]
                 # model="<provider/model>"   (optional fallback; attempts use the active session model)
dream_rsi_live     # cycle 1 — also drops its best attempt in history/baseline as the floor to beat
dream_rsi_dream    # replay it, rewrite the policy, deploy the winner
dream_rsi_live     # cycle 2 with the better policy — a second world
dream_rsi_dream    # now replaying against both
```

`dream_rsi_live`, `dream_rsi_resume`, `dream_rsi_dream` and `dream_rsi_apply` are gated behind Dream-RSI mode:
`create`, `live`, `dream`, `run` and `resume` enable it, as does `dream_rsi_init`. Live, resume and dream can spend
real agent time; apply writes to your code. The bare `/dream-rsi` command only shows help.
Everything above is also in the `dream-rsi` skill, which the agent reads on its own.

## Surface at a glance

| Tool | What it costs | What it does |
|------|---------------|--------------|
| `dream_rsi_init` | up to one scorer run | Writes `task.json`, seeds the policy, measures your code as the baseline candidates must beat (`measure_seed=false` skips it). Reconfiguring keeps that measurement while the scoring contract still matches (workspace, candidate program, scorer, score field, direction); a changed contract re-measures automatically, and the old number is kept as `history/seed/score.<timestamp>.json` (`remeasure_seed=true` forces it on unchanged code). Old-contract candidates and worlds stop being ranked, applied or replayed until a cycle is recorded under the new contract. |
| `dream_rsi_live` | `W × K1` agent calls per episode | One or more online cycles: plan the grid, batch nodes, run attempts in parallel, score each, record a replay world per episode. `loops=n` (or several calls) records `n` worlds of the same policy in parallel; `max_loops` caps everything in flight. |
| `dream_rsi_resume` | remaining original budget + retries | Continue an interrupted live tree with its original effective settings and budget. Completed attempts are reused; a saved completed generator only needs evaluation. Later rounds can start new attempts within the original budget. Retries add calls and are reported separately. |
| `dream_rsi_dream` | `M − 1` agent calls | Offline phase: replay `M` policy versions over completed worlds, sweep beta, rewrite the policy, deploy the winner. Releases interrupted claims while preserving checkpoints, then refuses while a phase is genuinely in flight or its manifest is unreadable. Only worlds under the current scoring contract are replayed. Revision-call count is fixed; replay work and history-reading tokens grow with history. |
| `dream_rsi_apply` | nothing | Copies a candidate's `eval_program` over your code. Needs `confirm: true`; never commits. |
| `dream_rsi_status` | nothing | Iterations, completed worlds, policy versions, last sweep, persisted live progress, recoverable checkpoints and candidates waiting to be applied. |

`dream_rsi_live`, `dream_rsi_resume`, `dream_rsi_dream` and `dream_rsi_apply` only become callable in Dream-RSI mode.

| Command | What it does |
|---------|--------------|
| `/dream-rsi create [--reconfigure\|--fresh] [goal]` | Interview (fresh project), or on a configured project ask: report + best candidate for `<goal>`, reconfigure, or start fresh. Flags before the goal skip the dialog. |
| `/dream-rsi suggest <goal>` | Rank the candidates on demand. `best` is an alias. Preferences: `fastest`, `safest`, `simplest`. |
| `/dream-rsi watch [iteration]` | Open the tree/log dashboard; defaults to the latest active cycle, then latest recorded. `Ctrl+Shift+D` opens it during a run. |
| `/dream-rsi resume [iteration]` | Ask the agent to resume the selected interrupted live cycle, or the latest recoverable one. |
| `/dream-rsi status` | The same state `dream_rsi_status` shows. |
| `/dream-rsi live [n]` \| `dream` | Ask the agent for one phase. Live defaults to 1 new cycle; `n` is 1–8 parallel cycles, clamped to the shared task cap. |
| `/dream-rsi run [n]` | Ask the agent for `n` new full cycles, live then dream. Default 1; range 1–100. |
| `/dream-rsi off` | Disable gated tools; saved state and running work are kept. |
| `/dream-rsi [help\|?]` | Show syntax, defaults and dashboard controls without changing mode. |
| *anything else* | Treated as a goal: interview in a fresh project, suggestion in a configured one. |

Tab completes subcommands, `create` flags and `suggest`/`best` preferences. In RPC/JSON/print mode, help,
status and command errors are delivered as session messages without starting an agent turn.

Starting a fresh task archives the current one instead of deleting it: `task.json`, `policy/`,
`policy_versions/`, `history/`, `trace_pool/`, `work/` and `runtime/` are renamed into
`.dream-rsi/archive/<timestamp>/` (which gets the same `.gitignore` treatment, so archived `work/` and
`trace_pool/` stay out of version control). Reconfiguring touches none of it — it only rewrites the fields you
change.

## Watching and resuming a cycle

Live and dream phases automatically show a terminal widget with the cycle, round budget, active workers,
completed attempts, best score and latest activity. `/dream-rsi watch` or `Ctrl+Shift+D` opens an overlay
while work continues. Left/right selects a cycle; up/down selects a tree node; Tab switches between tree,
tool activity, agent output and evaluator output; `d` switches between live and dream progress.
Page Up loads older log pages from disk, Page Down returns to
the tail, and Esc closes the view. Closing the view leaves the cycle running. Another pi session opened
in the same project can watch its persisted progress. Historical worlds, including worlds from older
versions, can also be inspected with `/dream-rsi watch 1`.

Terminal dashboards run only in `tui` mode. RPC, JSON and print hosts receive text updates and structured
`details.progress`; `dream_rsi_status` includes persisted live progress and recoverable iterations. Watching is
read-only and does not start an agent. Log tails are bounded to 200 lines and 64 KiB per displayed stream;
full logs remain in `history/r####_live/attempt_<cell>/{agent,eval}.log`. Presentation updates are throttled
to four per second, with final states shown immediately.

Interrupting a live cycle kills and drains its children and leaves a recoverable checkpoint. Run
`/dream-rsi resume [iteration]` (or `dream_rsi_resume iteration=1`) explicitly. The agent reports the kept
attempts, unfinished work and remaining budget first. Resume uses the **original effective model, thinking
level, scorer command, grid, budgets, frozen policy/imports and seed snapshot**. Later session model or
budget changes apply to new cycles. Recovery also runs later rounds within the remaining original budget;
it cannot add rounds or extend the original grid. Restoring an interrupted generator reruns that logical attempt from
its committed parent; restoring a finished generator reruns only its evaluator. Abandoned work and logs
are archived per retry, and extra agent/evaluator calls are reported separately from logical attempts.

Resume rebuilds the policy's private state by replaying saved ordered batch requests and results from reset.
It checks that the saved prefix still matches before new agent/scorer calls. A completed sibling survives
an interrupted batch, while policy decisions still wait for the whole batch. Atomic, versioned checkpoints
are saved before dispatch and before replies. Corrupt checkpoints, missing/edited snapshots, changed scoring
contracts and divergent policy requests stop recovery before new calls. External scorer files, datasets,
installed tools and credentials must remain available and unchanged; the checkpoint freezes the command
and settings, not the external environment.

Project locks coordinate live, resume and dream across sessions, share `max_loops`, and prevent duplicate
resume. An owner with a live process is preserved; dead owners can be recovered. Resume also stops a saved
orphan child after verifying its process birth identity, so a reused PID is never killed. Retention protects active
and recoverable workspaces. Only completed worlds enter replay; final publication can be retried without
repeating completed work. Legacy cycles without checkpoints can be watched but cannot be resumed. Completed
trees cannot be extended, and interrupted dream revisions must be started again.

After a resumed tree completes, use `/dream-rsi suggest` to rank its candidates and `/dream-rsi dream` to
include its world in policy improvement. If resume reports a changed scoring contract, restore the original
task fields before retrying. If it reports a corrupt checkpoint or missing/edited snapshot, restore those
files from a backup; starting `/dream-rsi live` creates a separate tree. Keep the saved recovery state intact.

For the default `pi` agent, JSON streaming is added unless `agent.args` already specifies `--mode`.
Custom commands retain raw text output. `agent.output_format` in `task.json` can be `auto` (default), `text`
or `pi-json`; choose `text` to keep a pi invocation in text mode or `pi-json` for a compatible custom CLI.
Explicit CLI modes are retained. Complete raw stdout/stderr is written to the log even when the dashboard
shows decoded assistant text and tool activity.

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
| `max_loops` | Shared cap on live/resume episodes across calls and sessions. Default 2; range 1–8. |
| `beta1`, `beta2`, `beta_grid`, `default_beta` | Reward shaping and the swept beta grid. |
| `agent` | The command spawned per attempt and per policy revision; the prompt goes over stdin. `agent.command` decides the CLI. The default `pi` re-spawns the running pi (`process.execPath` + its `cli.js`/`cli-runtime.js`), so it does not depend on PATH — but only when that entry point really is pi's: inside a host that embeds pi (or any process merely started from inside pi, which inherits `PI_CODING_AGENT`), the fallback is a PATH lookup of `agent.command`, and a bare `pi` that is not on this process's PATH fails fast with `agent_error` naming the command. A host running as `rpc-entry.js` is not re-spawned as-is (that entry forces RPC mode, which ignores `-p` and would hang silently): the sibling `cli.js` is used instead. Session-identity variables (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_WEB_SESSION`) are stripped from spawned attempts so a nested agent cannot attach to the session it was spawned from; `agent.env` in `task.json` can re-add a variable when a task needs one. `agent.model`/`agent.thinking` are fallbacks for new cycles, which use the active session's model and thinking level; resume uses saved effective settings. |
| `agent.output_format` | `auto` (default), `text` or `pi-json`, set in `task.json`. Auto adds `--mode json` for the default pi CLI unless a mode is already explicit; custom CLIs retain text output. Raw logs are always retained. |

Your scorer writes this:

```json
{ "score": 12.5, "valid": true, "fail_class": "ok", "error": null }
```

A non-`ok` fail class, or a score that isn't a finite number, makes the attempt a **repairable failure** with an
`error.txt` — it doesn't score, and it doesn't close the direction. `fail_class == "ok"` with `error === null`
counts as a successful evaluation even when `valid` is false: the measured number beats any claim about it.
The scorer must exit `0` and write a fresh `score_path`: a non-zero exit is an `eval_error` even when an earlier
score file is still present, because an attempt workspace inherits its parent's files.
Crashes, missing files, and timeouts get classified for you (`eval_error`, `timeout`, `no_proposal`,
`agent_error`, `invalid_score`).

## What it leaves on disk

```text
<project>/.dream-rsi/
  task.json                                       budgets, scorer contract, agent command
  policy/method.ts                                the deployed policy (+ api.ts beside it)
  policy/r0001_v0000.ts …                         every evaluated version, archived by cycle and revision
  history/seed/score.json                         what YOUR code measured (the reference point for candidates)
  history/applied.jsonl                           candidates you have already applied (append-only)
  history/baseline/attempt_<cell>/                the floor to beat (best attempt of cycle 1)
  history/r0001_live/attempt_<cell>/              proposal.md, eval/score.json, error.txt, prompt.md, logs
  history/r0001_live/tree.json                    the recorded discovery tree T_1
  history/r0001_dream/proposal_results/
      beta_sweep.json                             pareto.reward, auc, parallel_penalty, frontier, per-version V
      policy_execution_traces.jsonl               per (world, beta, round) — between-round feedback only
      selection.json                              which version won, and the V table
  trace_pool/iter0001/{tree.json,live_cycle_manifest.json}     the replay world + its live sidecar
  trace_pool/iter0001_current/live_cycle_manifest.json       running/interrupted cycle claim
  trace_pool/iter0001_current/checkpoint.json      versioned, checksummed live recovery state
  trace_pool/iter0001_current/{live,dream}_progress.json     persisted dashboard telemetry
  work/r0001/seed/                                frozen seed used by this tree and its resumes
  work/r0001/frozen/                              frozen policy and permitted imports
  work/r0001/agent_finished/<cellId>/             completed generator snapshot for evaluation-only recovery
  work/r0001/<cellId>/                            attempt workspaces — the agents' cwd (one copy per attempt)
  live-1.lock, dream.lock, .allocator.lock         transient process ownership and allocation locks
  runtime/                                        the policy worker + the modules it imports, mirrored out of
                                                  node_modules so the worker can run (npm installs only)
  .gitignore                                      written on the first cycle: ignores work/, trace_pool/ and
                                                  runtime/ (bulk + generated), leaves task.json, policy/ and
                                                  history/ visible
```

Interrupted generators archive abandoned work/logs under `history/r####_live/attempt_<cell>/retry_<n>/`.
Evaluator retries preserve their previous workspace and log under `eval_retry_<n>/` and `eval.log.retry-<n>`.
Checkpoints and their seed, policy and attempt snapshots must stay together; active and recoverable trees
are protected from workspace retention.

## Applying an improvement (nothing is automatic)

**Dream-RSI never writes to your code.** Every candidate lives inside `.dream-rsi/work/r<iter>/<cell>/`, the
scorer runs on that copy, and your own files keep their timestamps. What *is* automatic is the search policy
(`.dream-rsi/policy/method.ts`, deployed only when it wins the replay comparison) — not your program.

So the loop has to tell you when there is something worth taking, and *which* one. It does, in five places:

- `dream_rsi_init` measures your code once (`history/seed/score.json`) — that measurement is the reference
  point every candidate is compared against. Without it "better" would be a guess. Skip it with
  `measure_seed: false` if your scorer is slow; run it later by re-running init. Reconfiguring keeps the
  recorded number unless the workspace or the scorer changed (the old one is kept as
  `history/seed/score.<timestamp>.json`); `remeasure_seed: true` re-measures on purpose.
- After every `dream_rsi_live` and `dream_rsi_dream`, the result ends with either `Nothing to apply: …` (and
  why) or a block that starts `⚠️ IMPROVEMENT READY — NOT APPLIED`, naming the cell, its score versus your
  code, the percentage gain, and the candidate's path.
- The agent is instructed to pass that on and ask you whether to proceed. It will not apply anything on its
  own initiative — `dream_rsi_apply` is only allowed after you say yes.
- `dream_rsi_status` repeats it, and the footer switches to `dream-rsi: improvement ready`.
- `/dream-rsi suggest <goal>` (or `/dream-rsi create <goal>` on a configured project, choosing the report;
  `best` is an alias) ranks the whole field and
  explains the pick: score vs your baseline, secondary metrics, changed files, and the `mentions:` that admit a
  trade the scorer cannot see. The goal picks a preference — `fastest` (strict score), `safest` (within 5% of the
  leader's win, less to take on first), `simplest` (fewest changed files) — and unrecognised text is context,
  never a filter.

On the mnemosyne run this is the difference between `fastest` (a memoization win that trades a 20 ms staleness
window the assertions cannot see) and `safest` (a candidate that keeps freshness and gives up 1.5% of the win).

A candidate is reported only if it beats your measured baseline (or the last thing you applied) by at least
**1%** — noise-level differences stay quiet. The registry is append-only: `history/applied.jsonl` records what
you took, so the same candidate is not offered twice.

### Taking it

```text
dream_rsi_apply                          # without confirm: prints the files, line counts and the diff command
dream_rsi_apply confirm=true             # copies the pending best candidate over your code
dream_rsi_apply confirm=true cell=b1a1 paths=["src/lib/support.py"]   # extra files, if the task needs them
```

What it does and does not do:

- Copies **only** the declared `eval_program` plus any paths you name, and only from the candidate workspace
  into your seed workspace. Paths that are absolute, contain `..`, or escape either workspace are refused.
- Refuses without `confirm: true`, so a misread tool call cannot rewrite your code.
- **Never commits, never creates a branch, never runs your tests.** It prints the files it wrote and tells you
  to review.
- The candidate's `proposal.md` is *not* applied — reports are for reading, not for your repo.

Or do it by hand, which is the same thing:

```bash
BEST=.dream-rsi/$(python3 -c "import json;t=json.load(open('.dream-rsi/trace_pool/iter0001/tree.json'));print(sorted([c for c in t['cells'] if c['fail_class']=='ok'],key=lambda c:-(c['score'] or 0))[0]['workspace'])")
diff -u src/lib/storage.py "$BEST/src/lib/storage.py"   # read before you copy
cp "$BEST/src/lib/storage.py" src/lib/storage.py
```

A score from one benchmark is not a correctness review. Read the diff, run your own checks, then commit — the
tool deliberately stops one step short of your repository.

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
  `node:child_process`, `process.exit`, `getBuiltinModule`, or any bare module specifier — static `import`,
  `import()`, or `export … from` — is refused before it runs, and the scan follows the policy's relative imports
  so a local helper cannot smuggle one in. The trace files are between-round feedback; reading them inside
  `solve()` is cheating, not cleverness.
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
| Beta grid, `K1`, `K2`, `M` defaults | Not published. Shipped defaults: `W=4`, `K1=6`, `K2=8`, `M=3`, grid `[0, .2, .4, .6, .8, 1]`, `beta1=beta2=0.01`, `default_beta=0.6`. The paper's task shape (`W=10, K1=11` for a strong model, `W=32, K1=20` for a fast one, five rounds) is what the create skill recommends. |
| `pareto.auc` normalization | "High per-trace attainment with few total probes" is implemented as mean attainment over the probes actually taken, averaged across worlds, then trapezoidal over the beta→work curve. |
| Grid vs. tree bookkeeping | The paper's trees branch by "opening a root". Here an unopened root is a **root slot** (`b<branch>a0`), so one batch can open several directions, as the prompt describes. Replay opens branches in creation order (the paper's root rule), so a policy that takes roots in `legal_roots()` order behaves exactly as written. |
| Semantic direction guidance | Off by default: the paper's §4 ablation found prompt-level semantic guidance over-constrains the search and hurts, so `$direction_guidance` renders empty. Opt-in experiment: set `guidance: "summary"` in `task.json` (via `dream_rsi_init` or reconfigure) to render a deterministic, ≤1500-char summary of evaluated history instead. Prompt-only (excluded from the scoring fingerprint); existing checkpoints keep `""`. Measure on a scratch task before adopting — protocol: same seed, one cycle each (`W=2, K1=3`, cheap model), compare best score + mechanism diversity across the two worlds; two worlds is signal, not proof. |

## Tests

```bash
npm test          # deterministic unit and integration tests, no LLM
npm run typecheck # tsc --noEmit (CI runs both on Windows and Linux)
```

It covers `A(T)` and frontier rules, batch legality, replay transitions (root rule, unique recorded child, grid
depth cap, `K2`, `Child(v)=∅`), Eq. 1 worked out by hand, AUC/penalty/frontier, determinism detection,
`V* ≥ V_0`, prefix-only enforcement, a full two-cycle loop with stub agents (live → worlds → revisions → deploy →
replay both worlds), every scorer diagnosis (`invalid_score`, `eval_error`, `no_proposal`, `agent_error`,
`timeout`), candidate ranking (score order, `fastest`/`safest`/`simplest`, the win band, applied exclusion,
secondary metrics, scoped-vs-data files, determinism, and that ranking writes nothing), the agent-command
builder (`--model` appended vs `{model}` substituted), and the extension surface (gating, `create`/`suggest`
dispatch and routing, the configured-project choice dialog, archive-on-fresh, baseline retention across
reconfigures, session rebuild, branch-local state, crashed-cycle visibility, schema strictness, package
vs. relocated-directory layouts). Visibility and recovery tests cover split UTF-8/JSON streams, bounded
tails, terminal/headless dashboard behavior, cancellation, saved batch-prefix reconstruction, completed
sibling reuse, evaluator-only recovery, frozen settings/snapshots, process ownership, orphan cleanup,
retention, durable checkpoint-write failures and publication recovery. Command tests cover completion,
headless help/status and invalid iteration arguments.

What tests can't cover is your scorer and your model. For that, on a scratch project: `/dream-rsi create <goal>`
to get set up (the skill interviews you and verifies the scorer), then **How to run it well** steps 3–5 — step 3
tells you whether the task fits, step 5 tells you when to stop.

## Developing the shipped policy

The repository's own optimization task uses a behavioral benchmark in `.auto/`.
Run the trusted scorer by absolute path from a candidate workspace:

```bash
node "/absolute/path/to/pi-Dream-RSI/.auto/score.mjs" --benchmark-version=2
# Or pass a separate workspace:
node "/absolute/path/to/pi-Dream-RSI/.auto/score.mjs" "/path/to/candidate" --benchmark-version=2
```

It stages only the candidate policy beside trusted helpers and uses the production
replay engine on four frozen synthetic worlds: depth, breadth, repair and plateau.
The score is their mean Eq. 1 value at the policy's default beta. Every world runs
twice in fresh workers; any execution, guardrail or determinism failure invalidates
the complete score. `eval/score.json` includes the benchmark version and per-world
metrics. This measures behavior, with no quality points for syntax or source tokens.
It makes no claim about production generalization.

For an existing task, reconfigure its scorer command to include
`--benchmark-version=2` and remeasure the seed. The command change updates the
scoring fingerprint so old structure scores cannot be ranked or replayed with the
new behavioral measurements. See [PROBLEM.md](PROBLEM.md) for the complete contract.
The scorer and Python wrapper are development tools in this repository, outside the
published npm package; keep the trusted harness outside candidate edit scope.

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

--- Related: https://pi.dev/packages ---
