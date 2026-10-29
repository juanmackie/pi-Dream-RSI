# Verified loop example

This small Node project contains a planted quadratic bottleneck, a declared benchmark, and an exact-output correctness check. It is a deterministic teaching fixture, not evidence of gains on an external repository.

## Run locally

```sh
npm test
npm run bench
```

The baseline is intentionally slow: it recomputes a growing checksum with a nested loop. `src/pipeline.optimized.mjs` contains the equivalent linear implementation used by the deterministic cold-start acceptance test in this repository.

## Try Dream-RSI

Copy this directory to a disposable local Git repository, then run these commands from that copy to initialize and commit the unchanged baseline:

```sh
cd /path/to/copied/verified-loop
git init -b main
git add .
git commit -m "baseline"
```

Load pi with the Dream-RSI extension and run:

```text
/dream-rsi loop "reduce benchmark time without changing output" --consent
```

Inspect the proposal before approval. The project code, benchmark, and test run on the host with your access; this is not sandboxing. In a new Git-backed project, verified auto-commit defaults to the local `dream-rsi/improve` branch. It does not push. The example has no external dependencies and does not require harness generation because it declares both commands.

Dream-RSI may refuse or stop without a win. The deterministic cold-start test uses a fixture agent and verifies measurement, correctness, post-apply checking, and a local commit; the interactive command uses your configured agent and may produce a different result.
