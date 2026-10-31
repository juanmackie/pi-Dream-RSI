# Dream-RSI evidence tooling

This directory is measurement infrastructure, not permission to run a study. The checked-in pilot is design-only and has no repository pins. It cannot run experiments.

## Pilot controls

- `node harbor/validate.mjs --frozen` checks the frozen six-repository protocol and declared thresholds. It does not open participant repositories.
- `node harbor/validate.mjs --ready` additionally requires six local checkout paths, full pinned SHAs, a 3/3 split, five languages, and that each checkout still matches its pin. It only reads Git `HEAD`; it does not run project code.
- `node harbor/run.mjs --pilot` emits a pending schedule. It never launches models, evaluators, tests, repository commands, or network requests. Add `--out FILE` to save a new schedule; existing files are not overwritten.
- `node harbor/analyze.mjs RESULTS.json` evaluates pilot denominators, held-out breadth, correctness, negative-control isolation, replay coverage, evaluator CV, and cost. `source: "fixture"` is reported as simulated, never study evidence.

A target manifest needs separate operator approval before pins are added or external repositories are inspected. Paid experiments and publication require separate approval. Preserve negative results; do not rerun a study to improve its result.

## Optional full evidence track

`evidence-protocol.json` freezes the 16+4 harbor, treatment/control denominators, pass thresholds, caps, and kill conditions. `node harbor/analyze.mjs --evidence RESULTS.json` checks those thresholds, control isolation, clean-checkout replay, 12/12 crash recovery, and 12x3 red-team outcomes. The analyzer reports a gate result only. It does not substantiate or publish a magnitude claim. Publication remains a separate approval.

Use only synthetic, locally generated fixtures to test these tools. Do not place credentials, private repository data, or provider output in result files.
