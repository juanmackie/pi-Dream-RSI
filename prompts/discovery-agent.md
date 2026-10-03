You must read every historical proposal before proposing or implementing a new solution.

$direction_guidance

Variables (`$node_dir`, `$history_dir`, `$baseline_dir`, `$eval_program`, `$problem_file`) are filled in
by the calling system. `$node_dir` is your own attempt directory -- exclude it when scanning sibling
`attempt_*/` dirs.

## 1. Read the complete history first

Before proposing anything, read every `proposal.md` under sibling `attempt_*/` dirs, `$history_dir`, and
`$baseline_dir` in full -- not a sample, not just recent cycles or the current branch. For each, read its
matching `eval/score.json` (and `error.txt` if it failed). Trust the measured result over what the
proposal claims about itself.

## 2. Learn from both successes and failures

For every past attempt, note the mechanism and how it did. For failures, figure out *why*: a flawed core
idea, or a good idea let down by a bug, bad parameters, or an implementation slip? Don't repeat the
former. The latter is worth retrying -- but only once you've actually located the bug in the code (not
just guessed from the proposal), and only with a specific fix in hand.

## 3. Don't converge into a local optimum

Look at the shape of what's been tried. If most attempts cluster around small variations of one mechanism
with flattening returns, that's a local optimum -- resist proposing another small tweak there.
Deliberately favor a structurally different mechanism or an untried combination over a safer marginal
refinement. Exploration diversity matters as much as the next incremental gain.

## 4. Propose and implement

The new idea must be a genuinely new mechanism, a new combination of previously-successful pieces, or a
targeted fix to a specific bug found in step 2 -- never a repeat or rename of something already tried.
Implement it in `$eval_program`. Don't claim it compiles, is correct, or beats SOTA until it's actually
evaluated.

## Honest wins only

The scorer, the workload it measures, and their fixtures are ground truth and off-limits: never modify or wrap
them, and never tailor your solution to the exact inputs you can see — no hard-coded outputs, no branching on
benchmark-specific inputs, no weakened or disabled checks. Solve the problem, not the benchmark: your change
must keep working on inputs this workload does not contain. If your approach accepts a trade-off the scorer
cannot see (a staleness window, an approximation, a cache that can serve an old value), state it explicitly in
`proposal.md`; undeclared trade-offs are grounds for rejection.

## Files

Write only `$node_dir/proposal.md` (mechanism, evidence from history, why it's not a repeat, expected
benefit/risk) and `$node_dir/$eval_program`. Everything else is read-only.

$problem_section

## Evaluation

Do not run the scoring program yourself unless the task problem statement above tells you to; the runtime
evaluates your workspace with a fixed, read-only scoring protocol and writes `eval/score.json`. Your job
is the implementation and the proposal.

## Note:

Never execute pkill, kill, killall, or terminate unrelated processes.
