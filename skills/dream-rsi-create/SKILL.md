---
name: dream-rsi-create
description: Set up a Dream-RSI task in this project and recommend the best candidate for the goal. Use when asked to "set up dream-rsi", "create a dream-rsi task", "start a dream-rsi loop", "optimize X with dream-rsi", to reconfigure an existing task (`/dream-rsi create --reconfigure`), or when `/dream-rsi create <goal>` was invoked and no task.json exists yet.
---

# Setting up a Dream-RSI task

Dream-RSI runs a discovery tree of coding-agent attempts and improves the *exploration policy* by replaying
what actually happened. Two things must be true before it can help you: a **task** (what to optimize, where,
scored how) and a **trustworthy scorer**. Your job here is to produce both, verify them cheaply, and stop
before spending a cycle.

Read `skills/dream-rsi/SKILL.md` for the loop itself. This skill is only the on-ramp.

## Modes

The prompt that invoked you starts with `reconfigure` or `fresh`; with neither, this is a first-time setup.

- **reconfigure** — a task already exists and the user wants it changed. Read `.dream-rsi/task.json` and
  `.dream-rsi/history/seed/score.json`, present the current values as the defaults, and ask only about what
  should change. Call `dream_rsi_init` with just those fields: it keeps the history, the trace pool and the
  deployed policy. The recorded baseline is kept while the scoring contract still matches (workspace,
  candidate program, scorer, score field, score direction); when it no longer does, `dream_rsi_init`
  re-measures automatically — the old number is archived, and candidates/worlds recorded under the old
  contract stop being ranked, applied and replayed. Never pass `remeasure_seed=true` unless the user asks
  for unchanged code to be re-measured, and re-probe the attempt agent only if the agent command changed
  (attempts use the active session's model and thinking level, so a model change needs no reconfigure).
- **reconfigure leaves other tools stale** — `.dream-rsi/` is not the only loop in a project. If an
  autoresearch loop exists (`.auto/prompt.md`, `.auto/measure.sh`, score wrappers), it still describes the
  old objective and the old scorer: update or delete those files in the same breath, or that loop keeps
  measuring the previous task against the new workspace. `dream_rsi_init` writes `task.json` and touches
  nothing else outside `.dream-rsi/`.
- **fresh** — the extension has already archived the previous task under `.dream-rsi/archive/<timestamp>/`
  and `task.json` is gone. Tell the user where the old state went, then treat everything below as a
  first-time setup.

`reset=true` re-seeds the policy to the shipped default and discards every offline improvement so far. It is
not a way to change a workspace or a scorer. Never pass it unless the user explicitly asks for that loss.

## 1. Interview (ask, or infer from the repo — but never invent)

Collect these; ask the user for anything you cannot find evidence for:

| Field | What you need | How to choose |
|-------|---------------|---------------|
| **Objective** | What is being improved, in one sentence. | From the goal text and the repo's docs. |
| **Seed workspace** | The directory the attempts copy and refine. | Prefer a **small subdirectory** over `"."`: every attempt gets a full copy, so size *is* the cost. |
| **Candidate program** | The file an attempt must implement (`eval_program`). | The file the goal is about, relative to the seed workspace. |
| **Scorer** | A command that prints a number (`score_program`) plus a pass/fail verdict. | Look for an existing harness first — see step 2. |
| **Correctness gate** | What must set `fail_class != "ok"`. | The repo's own checks: its test suite, its assertions, its validity rules. |
| **Problem file** | A short doc every attempt reads: objective, in-scope files, off-limits, correctness, the baseline. | Write it (step 4). |
| **Budgets** | `workers`, `max_loops`, `k1`, `k2`, `revisions`, `beta_grid`. | Start small: `W=2, max_loops=2, K1=3, K2=4, M=2`. `max_loops` is how many online episodes may record worlds at once (`loops x W` agents in flight, shared by every live call); raise it only when the provider and the disk can take it. The paper's shape (`W=10, K1=11`) is hours per cycle. |
| **Attempt agent** | `agent_command`, `agent_args`, optionally `model`. | The CLI that will edit code in the copy. Attempts inherit the active session's model and thinking level, so `model` is only a fallback; confirm the session model exists and is billable — step 6. Keep the default `--no-context-files`/`--no-prompt-templates` flags: attempts read instructions from the prompt and history through tools, never from the host repo's context files. |

Ask in one batch. If the user says "just infer it", infer from the repo and **say what you inferred**, so a
wrong guess is visible before it costs anything.

## 2. Find the scorer before writing one

Search the repo for a harness you can point at, cheapest first:

```bash
ls Makefile justfile pyproject.toml package.json 2>/dev/null
grep -rn "METRIC\\|benchmark\\|bench\\|perf_counter\\|timeit\\|pytest-benchmark" --include="*.sh" --include="*.py" --include="Makefile" --include="*.json" . | head -20
```

If you find one (a `measure.sh`, a bench script, a Makefile target, a test-suite runtime), **wrap it** rather
than reimplementing it: a five-line adapter that runs the harness and writes `{"score": …, "fail_class": …}` to
`eval/score.json` in the workspace. Rules for the wrapper:

- Put it **outside the seed workspace** and reference it by absolute path in `score_program`. Anything inside
  the seed is a copy the candidates can edit — including the file that scores them.
- Invoke the harness the way its authors do. A script that derives its root from `$0` breaks when you call it
  with an absolute Windows path; call it relatively (`./.auto/measure.sh`) with the workspace as cwd.
- Read the number from the harness's own output. Do not recompute it.

If no harness exists, write `task/score.py` next to the seed (never inside it) plus the problem file.

## 3. Verify the scorer before spending anything

Run it by hand on three candidates you construct in a scratch copy:

1. a **known-good** candidate → expect a number and `fail_class: "ok"`;
2. a **deliberately broken** one (delete a symbol, corrupt the output) → expect `fail_class != "ok"`;
3. a **fast-but-wrong** one (e.g. returns a cached/empty result) → expect it to *not* win.

If (2) or (3) passes, the scorer cannot tell success from failure and the whole loop will optimize noise. Fix
that first, then continue. Report the three numbers.

Two failure modes to check for explicitly, both seen in practice:

- **Repeated-query benchmarks are gameable.** If the harness times the same few queries over and over, a
  candidate can win by memoizing them and the loop will happily do that instead of making anything faster.
  Confirm the timed workload issues *distinct* inputs, or add an assertion that a write is visible immediately.
- **A cost metric needs an honest baseline.** Record what the user's own code measures before any cycle runs.

## 4. Write the problem file

Every attempt reads this file. Keep it factual and short:

```markdown
# Task: <objective>
`<eval_program>` implements <what>. Objective: <what to improve>.

The scorer runs <score_program> against <workload> and is the ground truth. You cannot edit it and you do not
need to run it — the runtime scores your workspace after every attempt.

Correctness is non-negotiable: <what the gate checks>.
In scope: `<eval_program>`. Off limits: the scorer, the corpus/fixtures, migrations, dependencies.
Generalization: the workload is a sample of real use — don't special-case its exact inputs; state any
trade-off the scorer cannot see in `proposal.md`.
Baseline: the seed measures <X>. Beating it needs a real mechanism change, not a micro-tweak.
```

## 5. Configure the task

Call `dream_rsi_init` with the interview results. It writes `.dream-rsi/task.json`, seeds the policy, and
measures the user's own code into `history/seed/score.json` — that measurement is the reference point every
candidate is compared against. Report the measured baseline, then confirm the effective attempt command it
prints. It shows the active session's model and thinking level (`… --model <provider/id> --thinking <level>`),
which is what the attempts run on; `model=` would only set a fallback for hosts without a session model.
An existing task keeps its stored `agent_args` verbatim, so if the printed command lacks
`--no-prompt-templates --no-context-files`, pass the full `agent_args=` list when reconfiguring — history and
the recorded baseline are preserved.

Skip the measurement with `measure_seed: false` only if the scorer is slow, and say that the baseline is missing.

## 6. Probe the attempt agent, then stop

Run the effective attempt command once, outside the task, with a trivial prompt:

```bash
pi -p --no-session -na --no-extensions --no-skills --no-prompt-templates --no-context-files --model <session model> --thinking <session level> "Reply with exactly: OK"
```

A bad model id, missing auth, or an empty balance surfaces here for the price of one small call instead of
six failed attempts. Report the outcome verbatim.

Then **stop and ask**. State: the baseline to beat, the planned grid (`W × K1` agent calls per cycle), and the
cost. Do not call `dream_rsi_live` until the user agrees — `create` is an on-ramp, not a spending decision.

## 7. After the first cycle, the recommendation is automatic

Once a cycle has run, every `dream_rsi_live`/`dream_rsi_dream` result ends with the ranked candidates, and
`/dream-rsi suggest <goal>` reproduces it on demand (`fastest`, `safest`, `simplest`, or free text).

Present the top pick with its score delta *and* its caveats — especially any `mentions:` that admit a trade
the scorer cannot see (a staleness window, an approximation). If the project already has a second workload or
held-out set, score the top pick on it before recommending — a win that survives a workload it was never fitted
to is the one to take. Then ask whether to apply it. `dream_rsi_apply`
copies the candidate's file over the user's code, with `confirm: true`, records it in `history/applied.jsonl`
(so it is not offered again), and never commits.

## Anti-patterns

- A scorer inside the seed workspace (candidates can rewrite their own judge).
- A scorer that returns a number for a broken candidate (step 3).
- Timing a workload of identical queries, then believing the speedup (memoization wins, search does not).
- A candidate that wins by detecting or special-casing the benchmark workload instead of improving the implementation.
- Absolute paths handed to shell harnesses that parse `$0`.
- `dream_rsi_init reset=true` used to "change" a task: it discards the improved policy, and re-measuring the
  seed on top of it moves the reference point every candidate is compared against.
- Starting a paid cycle because the setup "looked fine"; probe first, ask first.
- Recommending the top score without reading its proposal: the run that motivated this skill produced a
  candidate that traded a 20 ms staleness window for 2× — invisible to the scorer, obvious in the proposal.
