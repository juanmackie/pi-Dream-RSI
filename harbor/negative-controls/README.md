# Negative controls (design only)

The six-repository pilot requires five no-headroom attempts on a synthetic negative-control fixture. The fixture starts with the declared check passing and has no eligible improvement. The analysis accepts only `attempts: 5`, `headroom: 0`, `commits: 0`, `correctnessRegressions: 0`, and `worktreeSharedWithTreatment: false`. Any commit, regression, or shared treatment worktree fails the gate.

The full-track controls are recorded separately from treatment: four synthetic negative-control repositories (10 attempts each) and the placebo, textbook, shuffled-metric, and A/A development arms. `harbor/analyze.mjs --evidence` checks their denominators, no-commit rule, and treatment isolation. Never put a control repository in a treatment worktree.

Only synthetic local fixtures may be used to test the controls. The checked-in tooling does not run the controls or any study. A real pilot run needs separately approved local repository pins and separately approved study execution.
