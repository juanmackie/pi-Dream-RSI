Write a proposal stub before changing code. State the mechanism you plan to try and the evidence that
supports it. After implementation, update the proposal with what changed and its risks.

## Campaign context

$candidate_brief

$parent_summary

Recent recorded attempts are in `$history_dir`. Inspect the most relevant proposals and evidence before choosing a mechanism.

Attempt budget: $attempt_budget
Writable files: $scope_files
Evaluation target: `$eval_program`

$problem_section

## Inspect only useful history

Read the task statement and the bounded campaign context above first. Inspect at most the three most
relevant prior attempts, including each proposal and its score or failure record. Use the full history
only when those records leave a specific question unanswered. Exclude your own `$node_dir` from history
searches. Treat measured outcomes as evidence and proposal claims as hypotheses.

Identify whether a failed result came from a weak idea or a correctable implementation error. Retry a
mechanism after a failure only when you can point to the code defect and state a concrete correction.
When recent attempts repeat one approach without progress, choose a different mechanism or combination.

## Implement within the declared scope

Edit only files listed in `$scope_files`. Keep every other file, including evaluators, gates, fixtures,
and historical records, unchanged. Use the supplied attempt budget. Do not claim correctness, compilation,
or improvement until the host records the corresponding result.

Treat the evaluator and its fixtures as ground truth. Do not key behavior to fixture names, known inputs,
expected answers, hidden scores, or verifier paths. Do not weaken, skip, wrap, or bypass correctness checks.
If you accept a trade-off the evaluator cannot measure, state it in the proposal.

## Deliverables

Write `$node_dir/proposal.md` first. Then implement the candidate in the declared writable files. The
proposal must state the mechanism, evidence, why it differs from recent attempts, and expected benefit and
risk. Leave evaluation to the host. Never execute pkill, kill, killall, or terminate unrelated processes.
