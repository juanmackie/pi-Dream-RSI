# Method

Dream-RSI combines a fixed evaluator and keep-only-if-better hill climb with append-only attempt records, fresh agent processes, independent review, paired confirmation, and correctness gates. Usage signals help rank candidate levers. The loop also qualifies its own metric before trusting it.

Each completed experiment is recorded as a world. A deterministic replay compares search configs using only recorded branch and refinement nodes. For one world:

```text
V = g - 0.02 * N + 0.01 * N / max(1, rounds)
```

`g` is normalized gain over baseline, `N` is the number of revealed attempts, and `rounds` is the number of search rounds. Replay scores are averaged across completed worlds. A config is eligible only when its replay coverage is at least 0.6 and its mean value beats the incumbent by more than 0.01. The incumbent is always a candidate. Agent output is config data and is never executed.

The improvement path stays fixed around that search-policy layer: qualify the metric and baseline first, keep candidate experiments bounded, promote only after paired confirmation, correctness gates, and adversarial review, then verify the applied patch independently. The dream step can change how later attempts are allocated; it cannot change the evaluator, safety gates, or acceptance rules. Suite-failure metrics count reported failures from common Node/TAP/Jest, pytest, Cargo, Python unittest, and JUnit summaries; an unrecognized non-zero suite still counts as at least one failure, never as a clean run.

## Relation to the Dream-RSI paper

The [Dream-RSI paper (arXiv:2609.14858, v2)](https://arxiv.org/abs/2609.14858v2) uses completed discovery trees as replay simulators. Its exploration policy chooses branches, batches, and stopping points. A policy-development agent revises executable policy code, then the system replays candidates over prior worlds and redeploys the best-scoring policy. The base discovery agent and evaluator remain fixed in that method.

This project adopts the history-to-replay idea, but it is an adaptation, not a reproduction of the paper's algorithm or evaluation. Dream-RSI stores bounded `SearchConfig` data; it never executes an agent-authored search policy. Deterministic replay uses the project's branch/refine actions and the local value function above. Adoption requires at least 0.6 mean replay coverage and a score margin above 0.01. The paper's budget-preference sweep and normalized quality-cost hypervolume objective are not implemented here; this port uses its simpler gain, attempt-cost, and round-cost score. Its safeguards for code changes—qualified measurement, correctness gates, review, and independent post-apply verification—are product-specific additions, not claims about the paper.

The dream step changes how this system allocates later search attempts. It does not train or fine-tune the coding model, change the evaluator, or guarantee that the codebase improves. Published results in the paper are not results for this extension. Improvement size depends on the repository, measurable workload, evaluator quality, and available budget; no magnitude is promised for arbitrary projects.

Inspirations: autoresearch contributes the fixed metric and hill climb; RSI-Master contributes append-only records and adversarial review; Memento contributes fresh processes and inherited notes; MASS contributes a separate judge; usage-log funnels contribute lever evidence; Dream-RSI contributes world recording and replay.
