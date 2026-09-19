# pi-dream-rsi — Dream-RSI (arXiv 2609.14858) as a pi package

> **Historical document.** This is the plan the package was built from (initial build, before the create /
> suggest / apply surface existed). It is kept as a record of the design decisions and their reasoning, not as
> current documentation. For what the package does today, read `README.md` and `skills/*/SKILL.md`.

## Context

`C:\Users\juanm\Documents\GitHub\pi Dream-RSI` is empty. We build a new pi package implementing
**Dream-RSI: Recursive Self-Improvement through Evolving Worlds** (arXiv 2609.14858) as its only core.

`davebcn87/pi-autoresearch` was reviewed as a *structural* reference for pi-extension plumbing only. Nothing of its
domain logic is carried over.

### What Dream-RSI is (paper §3) — the thing we implement

Not a single-candidate hill climb. It is a loop over **exploration policies**, where a policy is **executable code**
driving a **discovery tree**; each outer iteration improves that code by **dreaming** (offline replay over a simulator
built from accumulated real trajectories).

Per outer iteration `t`:

1. **Online Explore** — policy `π_t` guides a live rollout. Discovery tree `T` rooted at `r` = initial workspace
   state. Every non-root node has exactly one **primary parent**; its attempt resumes the parent's saved workspace +
   accumulated observations. A node records filesystem snapshot, artifact, eval diagnostics, score `s_v`.
   Eligible `A(T) = {r} ∪ leaves`. The policy selects a batch `C ⊆ A(T)`, `|C| ≤ W` — one attempt per worker.
   `≤ K1` decision rounds, empty batch ends it. Transition is stochastic. Result `T_t` joins history
   `H_t = H_{t-1} ∪ {T_t}`.
2. **Replay simulator** — `T_t` is frozen as replay world `i = t`; older worlds stay. Worlds store structure +
   observations + scores only, never workspaces (replay never re-runs discovery).
3. **Dreaming** — history stays fixed. For `m = 0…M-1`: evaluate `π_m` on **every** world `i = 1…t`; the
   policy-development agent reads replay trajectories, scores and prior-round feedback and **revises the executable
   policy code** into `π_{m+1}`. Select `π_{t+1} = argmax_m V_m`, `V_m = (1/t) Σ_i V_m^i`. `π_0 = π_t` is a
   candidate, so `V* ≥ V_0` (we assert this).
4. **Deploy** `π_{t+1}` in the next online iteration.

**Replay transition (deterministic, no new generation)** — `v ≠ r`: reveal its unique recorded child; `v = r`:
reveal the earliest-created child of `r` not yet observed (opens one new branch); empty when no recorded
continuation remains. `≤ K2` rounds (each non-empty batch = one round). Terminates on empty batch, `k = K2`, or all
recorded nodes revealed. `k*` = completed rounds. Newly revealed nodes expose stored observations *before* the next
decision.

**Replay objective (Eq. 1)** — `V_m^i = max_{v∈T} s_v − β1·N + β2·N / max(1, k*)`, `N = |T_i^{m,k*}| − 1`
(revealed non-root nodes = represented generation–evaluation requests). Feedback is between-round only; never read
inside `solve()`.

**No semantic guidance (paper §4 ablation)** — prompt-level semantic direction hints (`$direction_guidance`)
over-constrain the search and *degrade* results. Pure Dream-RSI omits them: guidance stays structural/prefix-based.

### Paper-verified API contract (Appendix B) — all names confirmed in the paper

```ts
question.reset()
question.observed(): Record<CellId, Observation>   // revealed prefix only
question.legal_actions(): CellId[]                 // roots + opened-branch frontiers
question.legal_roots(): CellId[]                   // unopened roots only
question.opened_branches(): number[]
question.meta(cell_id): CellMeta                   // .branch .attempt .parent_id .seq .tags
question.probe_batch(cells, on_reveal): Observation[]
question.baseline_score
question.max_parallelism
```
`Observation`: `branch`, `attempt`, `score`, `evaluated`, `valid`, `fail_class`, `error`, `delta_vs_baseline`,
`delta_vs_parent`, `n_valid`, `n_total`. Success semantics: `evaluated && error == null && fail_class == "ok"`.
Helpers live in `see.policy.observation_signal` → here `policy/observation-signal.ts`: `branch_promising`,
`branch_failed_hard`, … (deterministic prefix derivations, no hidden state).

Required policy shape (paper Listing 2 skeleton):
`NAME = "OptimalPolicy"` · `class OptimalPolicy(LLMDesignedMethod)` · `solve(question, budget?)` ·
**required** `plan_grid(context: GridPlanningContext) -> GridPlan` (`GridPlan(branch_count, refine_count)` + factual
`reason`), run *before* a new live grid, never inspecting a current episode.
Policy helpers: `SimResult`, `_budget_done`, `_record_curve`, `finalize_result`.
Hard constraints: prefix-only (no unrevealed scores, true optimum, hardcoded winning cell ids, absolute score
targets, internal trace data); distinct legal cells per batch; never parent + child together; no fixed
widen-all / deepen-all schedule; replay calls `budget = None` so the policy must stop on its own.

**Beta is one scalar in `[0,1]`** (`self.config.get("beta", default)`), fixed within an episode and routed through one
`_schedule(beta) -> dict` (high beta = more width, deeper patience, weaker pruning). Offline eval sweeps a fixed beta
grid to expose the attainment/work/parallelism trade-off; the improvement agent bakes in one default beta for the next
live episode using the cross-cycle rule over the last 2–3 live sidecars plus their `beta_sweep.json`
(`pareto.reward`, AUC, parallel penalty, per-beta frontier): improving → keep prior beta unless the sweep clearly
shows better; plateau + higher beta reaches higher attainment at reasonable cost → raise ~0.1–0.2 (clamped to
[0,1]); plateaued high beta adding work without attainment → lower; insufficient/conflicting evidence → ~0.6. Never
pick the smallest beta that merely reaches a frozen trace's known ceiling.

## Approach

**TypeScript end-to-end, policy code isolated in a worker thread.** No Python dependency, one test runner, and
`worker.terminate()` guarantees a bad/hanging policy can never hang pi. The paper's API names and contract are kept
exactly; only the host language changes, so the policy-improvement prompt is translated (not rewritten) to TS.

Layering — deterministic engine, no LLM in the driver:

- `engine/tree.ts` — nodes, primary parent, `A(T)`, branch/attempt numbering, observation derivation.
- `engine/live.ts` — `K1`-round online rollout, `W` parallel attempts, stochastic transitions.
- `engine/replay.ts` — deterministic `K2`-round replay of a frozen world.
- `engine/reward.ts` — Eq. 1, beta sweep, `pareto.reward` / AUC / parallel penalty, argmax selection.
- `engine/world.ts` — trace pool read/write, `live_cycle_manifest.json` sidecars, `_current` cycle.
- `agent/runner.ts` — one attempt = one spawned agent process in its own workspace copy (configurable command).
- `policy/api.ts` + `policy/host.ts` — `LLMDesignedMethod`, `question`, `GridPlan`, action-log validation.
- `worker/policy-worker.ts` — loads `method.ts` fresh per version, drives `solve()`/`plan_grid()`, relays live probe
  requests to the host, enforces timeout.
- `prompts/` — the paper's Listing 1 (online discovery agent) and Listing 2 (replay policy improvement) with
  `$node_dir $eval_program $history_dir $baseline_dir $problem_file` and `{method_file} {history_dir} {trace_pool}`.

Attempts: command is configurable, default `pi -p --no-session --no-approve --no-extensions --no-skills --model <m>`
run with `cwd = <workspace copy>` and the prompt piped via stdin (no argv length/quoting limits, Windows-safe). One
mechanism is reused for both discovery attempts and policy revisions; nothing depends on another extension.

**User-facing surface** (4 tools + 1 command):
`dream_rsi_init` (write `task.json`, seed policy, validate eval program) · `dream_rsi_live` (one online rollout →
`T_t`, worlds, sidecar; round 1 populates `history/baseline/`) · `dream_rsi_dream` (freeze history, `M` revisions,
beta sweep, argmax select, deploy) · `dream_rsi_status` (tree, per-round best, beta trend, `V_m` table) ·
`/dream-rsi` (status · run · stop). Tools are gated behind Dream-RSI mode exactly like a mode-flag extension, and
session state is reconstructed from `pi.appendEntry` custom entries so a resumed session recovers the loop.

### Layout (paper-exact names, one root)

```
<project>/.dream-rsi/
  task.json                                  task + evaluator + budgets + agent command
  policy/method.ts                           deployed policy (EVOLVE-BLOCK guarded)
  policy_versions/v0001.ts …                 every candidate version, archived
  history/baseline/attempt_####/             parallel-refine floor to beat
  history/r0001_live/attempt_####/{proposal.md,eval/score.json,error.txt}
  history/r0001_live/tree.json
  history/r0001_dream/proposal_results/{beta_sweep.json,policy_execution_traces.jsonl}
  trace_pool/iter0001/{tree.json,live_cycle_manifest.json}
  trace_pool/iter0001_current/                in-flight cycle mirror
  work/<branch>_<attempt>/                    live workspace copies (attempt cwd)
```

## Files to create

```
package.json                                   name pi-dream-rsi, pi.extensions + pi.skills
README.md  LICENSE  .gitignore
extensions/pi-dream-rsi/index.ts               tools, command, mode gate, session state, status UI
extensions/pi-dream-rsi/engine/{tree,live,replay,reward,world}.ts
extensions/pi-dream-rsi/engine/task.ts         task.json schema + validation
extensions/pi-dream-rsi/agent/runner.ts
extensions/pi-dream-rsi/policy/{api,host,observation-signal}.ts
extensions/pi-dream-rsi/policy/method.ts       default shipping policy (EVOLVE-BLOCK)
extensions/pi-dream-rsi/worker/policy-worker.ts
extensions/pi-dream-rsi/paths.ts  jsonl.ts     workdir resolution, append-only line writes
prompts/discovery-agent.md                     paper Listing 1 ($vars)
prompts/policy-improvement.md                  paper Listing 2 ({vars}, TS-translated skeleton)
skills/dream-rsi/SKILL.md                      setup → live → dream → deploy protocol
tests/*.test.mjs                               engine + integration (node --test)
```

## Reuse

- **pi APIs** (`pi-coding-agent/docs/extensions.md`, verified before coding): `ExtensionAPI`, `registerTool`,
  `registerCommand`, `on("session_start"|"session_tree"|"before_agent_start"|…)`, `pi.appendEntry`,
  `pi.getActiveTools`/`setActiveTools`, `ctx.sessionManager`, plus `truncateTail`/`Text` helpers.
- **pi CLI contract** (`docs/usage.md`): `-p/--print`, `--no-session`, `--no-approve`, `--model`, `--no-extensions`,
  `--no-skills`; piped stdin merges into the initial prompt.
- **Node stdlib only** for mechanics: `node:worker_threads`, `node:child_process`, `node:fs/promises` (`fs.cp`
  recursive for workspace snapshots), `node:crypto`, `node:path`. No new dependencies.
- **Design patterns from pi-autoresearch** (structure, not domain logic): gated-tool registration, custom-entry state
  reconstruction, `before_agent_start` prompt injection, small truncating output helpers.
- **Paper Appendix B** prompt text, adapted verbatim with variables filled.

## Explicitly not carried over

keep/discard ladder · auto-commit & auto-revert · `.auto/` dirs and `prompt.md`/`measure.sh`/`ideas.md`/`checks.sh` ·
single primary metric + secondary metrics table · segments + confidence score · ASI diagnostics · dashboard
overlay + export HTTP server · lifecycle hook scripts (`.auto/hooks/*.sh`) · auto-resume turn guards · compaction
summary writers · `finalize.sh` branch-per-winner · website/site build · karpathy attribution.

## Steps

- [x] Scaffold package: `package.json` (pi.extensions/pi.skills), `.gitignore`, LICENSE, README stub
- [x] `engine/tree.ts`: node/branch/attempt model, `A(T)`, root-child ordering by `seq`, observation derivation
- [x] `policy/api.ts` + `policy/host.ts`: `LLMDesignedMethod`, `question.*`, `GridPlan`, deadline/budget helpers
- [x] `worker/policy-worker.ts`: fresh per-version load, live-probe relay, timeout + terminate, error capture
- [x] `engine/live.ts`: `K1` rounds, batch legality, W-way parallel attempts, workspace copy per node, evaluator run
      (`eval/score.json`, `error.txt`, `fail_class`), snapshotting
- [x] `engine/replay.ts` + `engine/reward.ts`: deterministic replay, Eq. 1, beta sweep, `pareto.reward`/AUC/parallel
      penalty, argmax with `V* ≥ V0` assertion
- [x] `engine/world.ts`: trace pool, `iter####` + `_current` sidecars, `proposal_results` archives
- [x] `agent/runner.ts`: spawn configurable agent command, cwd workspace copy, stdin prompt, timeout, logs
- [x] `extensions/pi-dream-rsi/index.ts`: `dream_rsi_init|live|dream|status`, `/dream-rsi`, mode gate, session state,
      status widget
- [x] `policy/method.ts`: default parallel-refine policy (paper's controlled baseline) with `_schedule(beta)`,
      `plan_grid`, EVOLVE-BLOCK
- [x] `prompts/discovery-agent.md` + `prompts/policy-improvement.md` from paper Listings 1 & 2
- [x] `skills/dream-rsi/SKILL.md`: end-to-end operating protocol + budget guidance
- [x] Tests (below)
- [x] README: install, task setup, the loop, artifact map, budgets, honesty notes on paper-silent knobs

## Verification

Purpose-built checks, all runnable with `npm test` (`node --test tests/*.test.mjs`):

1. **Tree/A(T)** — leaves vs opened frontiers, root always eligible, parent/child exclusivity, branch numbering.
2. **Batch legality** — duplicates rejected, `> max_parallelism` rejected, parent+child rejected, illegal id ignored.
3. **Replay determinism + transition rules** — same world + policy ⇒ identical decision sequence and `k*`; root rule
   reveals *earliest-created* unobserved child; non-root reveals its unique recorded child; stops at `K2`/empty/exhausted.
4. **Eq. 1 exactness** — hand-computed `V` table, including `k* = 0`, `N = 0`, and the `max(1, k*)` guard.
5. **Monotonicity** — selection over `M` candidates that includes `π_0` never yields `V* < V_0`; injected
   regression must trip the assertion.
6. **Prefix-only** — `observed()` never exposes unrevealed nodes; static check rejects policy code referencing raw
   trace/score files inside `solve()`.
7. **Beta sweep** — non-degenerate sweep produces a frontier; `beta_sweep.json` carries `pareto.reward`, AUC,
   parallel penalty, per-beta frontier; high-beta schedule is strictly more patient (partial order on width/prune).
   *(Paper does not publish the numeric grid or `β1/β2`; these ship as documented, configurable defaults.)*
8. **End-to-end, no LLM** — fixture agent (`node` + stub script) writes `proposal.md`/`eval/score.json`; run 2 full
   iterations: live → worlds → `M` revisions → deploy; assert artifact tree, `policy_versions/`, sidecars, baseline
   seeding, and that iteration 2 uses the selected policy version.
9. **Failure paths** — evaluator non-zero / missing `score.json` ⇒ `valid=false` + `fail_class` recorded, attempt
   becomes a repairable-failure node (not a closure); policy throwing/timeout ⇒ version scored invalid, loop
   continues; killed agent process ⇒ node failure, batch still completes.
10. **Manual smoke (documented, user-run)** — real task with a real model: 2 iterations, inspect `dream_rsi_status`
    and the `V_m` table; confirm `trace_pool` growth and that the deployed policy differs from `v0001`.

--- Updates (post-implementation) ---
- `agent.model` reads `PI_MODEL` from session env; visible in `dream_rsi_init` output and `TASK_ENTRY` session state.
- `MODEL_PATTERN` validation applies unconditionally (not only on Windows `shell` mode).
- Cross-cycle default-beta selection (`crossCycleBeta`) implements the paper's explicit rule (raise/lower by 0.1–0.2 based on live trend and sweep evidence).
- No user-facing commands, skills, or archive paths removed.
- `/dream-rsi create` on a configured project asks which job is meant — report the best candidate, reconfigure the
  task (re-interview; history and the recorded baseline are kept), or start an unrelated task — instead of
  silently skipping the interview forever; it also enables Dream-RSI mode, so the "apply it" it prints is
  callable. `--reconfigure` / `--fresh` answer the same question without the dialog (print/RPC hosts have no
  `select`). A fresh task renames the previous state into `.dream-rsi/archive/<timestamp>/` instead of deleting it.
- `dream_rsi_init` keeps an existing `history/seed/score.json` unless the workspace or the scorer changed, or
  `remeasure_seed=true` is passed, and archives the superseded number as `history/seed/score.<timestamp>.json`.
- Session iteration is actually restored: `reconstruct` now reads the entry type `saveTaskEntry` writes
  (`pi-dream-rsi/live`; it read the never-written `pi-dream-rsi/task` before, so the count was always 0). The read
  is scoped to the entry's root, so a session resumed in another project cannot inherit a count. `/dream-rsi
  create --fresh` records a reset entry *and* zeroes the in-memory count, so a fresh task's first cycle is `t=1`
  instead of continuing after the archived cycles.

--- Known gaps (found while implementing the above) ---
- `/dream-rsi suggest` does not enable Dream-RSI mode, so on that path a printed `dream_rsi_apply` can still be
  gated off; `create` does enable it.
