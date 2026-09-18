You are improving one **prefix-only exploration policy**. Edit only `{method_file}` and implement
`OptimalPolicy.solve(question, budget = null)`. Do not solve the scientific task and do not edit any other
program.

## Objective: quality, work, and parallelism

The environment is a frozen, irregular branch x attempt grid. A policy opens a root or refines the next
cell of an already-open branch. Each revealed cell costs one probe. The policy sees only the cells it has
revealed so far; unrevealed scores are unknown.

The evaluator sweeps your single `beta` knob and ranks the resulting curve by:

```
pareto.reward = pareto.auc - lambda * parallel_penalty
```

`pareto.auc` rewards reaching high per-trace attainment with few **total probes**. `parallel_penalty` is
the mean of `effective_sequential_rounds / total_probes` over the sweep. For a batch of size `k` with
`W = question.max_parallelism` workers, it costs one decision round and `ceil(k / W)` effective sequential
rounds. A serial policy has penalty near 1; useful full batches approach `1/W`. Therefore choose only
promising probes, but batch independent promising probes whenever possible.

A local implementation failure does not by itself prove that its parent direction is poor. Weigh recovery
value against new roots and ordinary refinements while keeping batches parallel.

## API

```
question.reset()
question.observed() -> Record<cellId, Observation>   # revealed prefix only
question.legal_actions() -> string[]                 # roots + opened-branch frontiers
question.legal_roots() -> string[]                   # unopened roots only
question.opened_branches() -> number[]
question.meta(cellId) -> CellMeta                    # .branch .attempt .parent_id .seq .tags
question.probe_batch(cells, on_reveal?) -> Promise<Observation[]>
question.baseline_score
question.max_parallelism
```

`Observation` supplies `branch`, `attempt`, `score`, `evaluated`, `valid`, `fail_class`, `error`,
`delta_vs_baseline`, `delta_vs_parent`, `n_valid`, and `n_total`. Use the helpers in
`./observation-signal.ts` when useful: `branch_promising`, `branch_failed_hard`,
`probe_improved_vs_parent`, and `probe_improved_vs_baseline`.

**Success semantics:** an evaluated observation with `error === null` and `fail_class == "ok"` is a
successful evaluation, even when `valid === false` or `n_valid`/`n_total` are unavailable. Never label it
repairable solely because `valid` is false. A *successful anchor* below means the best historical score
from such a successful evaluation.

Do **not** use `question.best_so_far` or `question.budget_spent` to decide what to explore; they are
bookkeeping only. Derive any decision statistic from `question.observed()` instead.

## Required branch trajectory and failure interpretation

For each opened branch, reconstruct its ordered prefix trajectory, not only its latest observation or best
score: successful anchor, score trend, regressions, failure/repair sequence, and explored versus remaining
depth.

Before closing or deprioritizing a failed frontier, classify it as hard-unrecoverable, repairable
implementation failure, weak-but-underexplored, or repeatedly unpromising after sufficient valid evidence.
Output/correctness mismatch, shared-memory/resource limits, and variable/code, mask/layout/shape errors
are normally repairable. Do not infer algorithmic failure from one such error. `n_valid == 0` and
`branch_failed_hard(obs)` are signals, not unconditional closure: use `fail_class` and `error` to
distinguish a repairable zero-valid failure from an environment/dependency failure. `compile_other` alone
is not permanently hard. Classify the current failure episode: a later successful result reopens the
branch and cancels closure based only on an earlier failure.

## Required batch decision loop

At each decision round:

1. Read the prefix, reconstruct trajectories, and close only branches with cumulative evidence of being
   hard-unrecoverable or repeatedly unpromising.
2. Rank legal roots and legal branch frontiers using only prefix-derived signals: successful anchor,
   parent -> child gain, complete branch trajectory, actual success versus failure evidence, failure
   recoverability, prior repair outcomes, remaining depth, and cross-branch comparison.
3. Rank actual repairable failures and underexplored frontiers in deterministic queues using trajectory,
   recoverability, remaining depth, repeated failures, and beta. A repairable failure retains eligibility
   unless cumulative evidence lowers its relative priority.
4. Build one **dynamic portfolio** batch of independent candidates, up to `question.max_parallelism`:
   exploitation (strong normal refinements), exploration (new roots or underexplored branches), and at
   most one recovery (an actual repairable failure). When multiple roles are eligible, give exploration
   and justified recovery representation before filling remaining slots with refinements. Rank within
   each role by priority; adapt this to prefix evidence rather than fixed quotas. Recovery must not
   displace normal successful progress. Never fill a batch with parents of the same lineage or with
   simply the highest-scoring cells; prefer distinct branches.

A batch must contain distinct cells that are all legal *before* the call. It may contain several roots
and/or one frontier from each opened branch. It must never contain a parent and its child together. Do
not use a fixed widen-all / deepen-all wave schedule: adapt batch composition after every revealed
prefix.

Minimal structure:

```ts
import { LLMDesignedMethod, SimResult, _budget_done, _record_curve, finalize_result } from "./api.ts";

export const NAME = "OptimalPolicy";

export class OptimalPolicy extends LLMDesignedMethod {
  async solve(question, budget = null) {
    question.reset();
    const res = new SimResult();
    const closed = new Set();
    while (!_budget_done(question, budget)) {
      const prefix = question.observed();
      update_closed(closed, prefix, question);
      const batch = select_batch(prefix, question, closed);
      if (batch.length === 0) break;
      await question.probe_batch(batch, () => _record_curve(res, question));
    }
    return finalize_result(question, res);
  }
}
```

## Hard constraints

- Keep `NAME = "OptimalPolicy"` and implement `class OptimalPolicy extends LLMDesignedMethod` in
  `{method_file}` only.
- **Prefix-only:** decisions may use revealed observations, `baseline_score`, legal sets, structural
  `meta`, and helper signals. Never use unrevealed scores, a true optimum, hardcoded winning cell ids,
  absolute score targets, or internal trace data.
- Every prune, widen, deepen, batch, and stop decision must be justified by prefix evidence.
- The policy must be deterministic and pure: no clocks, no randomness, no I/O, no network, no process
  access, no environment variables. Import only from `./api.ts`, `./observation-signal.ts`, and
  `./tree.ts`.
- `solve()` must terminate on its own. Probe at most `question.max_parallelism` cells per batch, and
  never issue overlapping `probe_batch` calls.
- A repairable latest failure must not erase its historical successful anchor or by itself cause
  permanent starvation.
- Replay calls with `budget = null`. Always terminate when no batch is selected; do not assume a budget
  cap exists.
- A selected batch must be legal, have no duplicate ids, and contain at most `question.max_parallelism`
  cells. Illegal batches are rejected and the version scores as invalid.

## Beta: fixed per run, adaptive across cycles

Read exactly one scalar in the constructor:

```ts
beta = float(this.config.get("beta", <sensible_default>));
```

Beta has three distinct roles. Do not conflate them:

1. **Within one replay or live episode:** beta is fixed. Route every behavioral threshold through one
   `_schedule(beta) -> dict`. High beta means more width, deeper patience, and weaker pruning. Low beta
   means fewer probes, earlier stagnation stops, and stronger pruning. Never change beta from observations
   inside `solve()`. Route recovery eligibility, reserve threshold, and waiting through the same schedule:
   high beta is more patient; low beta remains selective without treating one repairable failure as
   automatic closure.
2. **During offline evaluation:** eval sweeps a fixed beta grid. This measures whether the policy exposes
   a real attainment/work/parallelism trade-off; it is not online beta adaptation.
3. **When proposing the next policy version:** choose the baked-in default beta once, using evidence from
   earlier *live* cycles and their beta sweeps. That default will remain fixed throughout the next live
   exploration episode.

Keep all thresholds relative to the prefix; never use absolute score cutoffs.

Use the following cross-cycle default-beta rule. Read the most recent 2-3 **live** `{trace_pool}` iteration
manifests (and `_current` when present) for each iteration's final best score and actual baked-in beta.
Read the matching archived `beta_sweep.json` values (`pareto.reward`, AUC, parallel penalty, and the
per-beta frontier). Scores alone do not establish that beta caused a change, so always use both sources:

- live best is still improving: keep the prior default beta unless its sweep clearly shows a better nearby
  beta;
- live best has plateaued, and higher beta reaches higher attainment for a reasonable work/parallelism
  cost in the sweep: raise the default by a small step (about 0.1-0.2, clamped to [0, 1]);
- a high default beta has already been tried through a plateau, and high-beta sweep points add work
  without higher attainment: lower it by a small step;
- history is insufficient or evidence conflicts: use a moderately exploratory default (about 0.6), rather
  than pretending the replay ceiling is a live stopping signal.

The beta sweep is non-degenerate only if beta changes the attainment/work trade-off. It also reveals
whether the policy batches. Do not select the default simply as the smallest beta that reaches a frozen
trace's known ceiling.

## Required next-cycle grid planning

Every proposed policy **must** implement this deterministic method:

```ts
plan_grid(context: GridPlanningContext): GridPlan
```

This method runs **before** a new live grid is created. It does not make a within-episode decision and
must never inspect a current episode. It answers how many directions (branches) to open and how deep to
refine them, returning `{ branch_count, refine_count, reason }` with a short factual `reason`. Use the
historical evidence in `context.history` (per-iteration best score, baked-in beta, archived sweep) plus
`context.baseline_score`, `context.max_parallelism`, and `context.budget`. Widening direction diversity
helps early; once directions plateau, reduce or hold width and go deeper on the surviving directions.
Never return fewer than 1 branch or fewer than 1 refinement.

Never solve this task from absolute thresholds: compute the plan from the prefix of live history.

Provide a useful bootstrap default for the very first episode (no history) so that the policy is a working
parallel-refine baseline before any improvement.

## History and traces available to you

Replay-diagnosis files live under `{history_dir}`: the `baseline/` floor to beat, per-round `attempt_*/`
records (`proposal.md`, `eval/score.json`, `error.txt`), and — next to this prompt's objective — the beta
sweep and replay traces described below. Read them to ground your changes in evidence: retain mechanisms
that raised `pareto.reward`, and make a concrete change when progress stalls. A legacy AUC-only sweep is
useful code history but is not numerically comparable to the current reward. The baseline under
`{history_dir}/baseline/` is a parallel-refine floor to beat.

Each current-objective round also archives `proposal_results/policy_execution_traces.jsonl`: one replay
episode per `(frozen trace, beta)`. Use it to diagnose general behavior -- serial batches, premature
stops, over-pruning, or wasted probes -- from the prefix state, selected batch, and revealed outcomes at
each decision round. It is **between-round feedback only**: never read it inside `solve()`, and never copy
a trace-specific branch, cell id, score, or target into policy logic.

`{trace_pool}`, if present, may be read only outside `solve()`. Prefer the `live_cycle_manifest.json`
sidecars over raw replay outcomes for the per-iteration live trend. Never copy trace scores, targets, or
cell ids into policy logic.

## Deliverable

Write a complete adaptive policy in `{method_file}`. Include a short module docstring describing its
prefix signals, batch rule, beta schedule, default-beta rationale, grid-planning rule (if implemented),
and safeguards against over-pruning, over-stopping, permanent starvation after repairable failures, and
serial probes. Before finishing, verify trajectory-based ranking, the stated success semantics,
non-automatic zero-valid closure, deterministic recovery competition, and portfolio-level stop.

Report back with: the mechanism you changed, and the `reason` for your grid plan.

--- Note --- `plan_grid` must return non-None `GridPlan`. `default_beta` selected by cross-cycle rule. Prefix-only observations enforced.
