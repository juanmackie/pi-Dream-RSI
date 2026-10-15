# The exploration policy and replay objective

This document explains the paper's recursive exploration method and the policy runtime retained in this repository. The current extension commands run bounded improvement campaigns. They do not expose the historical manual live and dream workflow.

## Online search records a world

An online cycle starts from a seed workspace. The policy chooses a batch of candidate cells, and coding agents work on isolated copies of the selected parents. The evaluator records each result in a discovery tree. A cycle stops at its round or attempt budget, then freezes its tree as a replay world.

The policy can open independent branches and refine a promising candidate. A branch records one direction. A refinement extends a branch from its latest candidate. The host owns the observed tree and offers only legal actions to the policy.

## Replay compares policies

The offline phase runs candidate policy versions against recorded worlds. Replay reveals the recorded outcome for each selected cell instead of generating a new candidate. That makes policy comparisons cheaper than repeating online work.

For replay objective v1, the runtime computes:

```text
V = best_score - beta1 * N + beta2 * N / max(1, k*)
```

`N` is the number of revealed non-root nodes. `k*` is the number of decision rounds. `beta1` prices each probe, while `beta2` rewards batching those probes into fewer rounds. After a beta sweep, the runtime also ranks the quality and parallelism curve.

The paper's [v2 revision](https://arxiv.org/html/2609.14858v2) replaces Eq. 1 with normalized hypervolume over the quality-call frontier minus a parallelism penalty weighted by `lambda`. This repository's replay runtime still computes the v1 objective. A v2 migration requires an algorithm and evaluation change.

## Policy revisions stay tied to evidence

A policy-development agent receives replay traces and scores, then proposes a new policy version. Each version runs against the same recorded history. The policy that produced the live world remains in the candidate set, so selection cannot lower the replay score on that history.

The worker gives a policy a prefix of the discovery tree, legal actions, and a bounded budget. The host validates each batch for legality, uniqueness, worker limits, and parent-child conflicts. It runs the policy in a worker thread with a deadline and checks that replay decisions are deterministic when requested.

The policy contract and helper modules live under `extensions/pi-dream-rsi/policy/`. The repository's self-campaign evaluator copies a candidate `method.ts` beside the trusted helpers, scans the policy's relative import closure, and scores it against fixed synthetic worlds. It does not trust candidate-reported counters or allow the candidate to import I/O modules.

## What replay cannot establish

Synthetic replay checks the policy contract and guards against regressions on fixed outcomes. It does not show that a policy improves a real project, that its candidate changes are useful, or that its decisions generalize to unseen tasks. The campaign evaluator and gates address a separate code-improvement workflow. Neither synthetic replay nor a passing campaign gate replaces human review of the final diff.

## References

- [Recursive Self-Improvement through Evolving Worlds, v1](https://arxiv.org/pdf/2609.14858v1)
- [Recursive Self-Improvement through Evolving Worlds, v2](https://arxiv.org/html/2609.14858v2)
