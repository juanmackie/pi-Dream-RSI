#!/bin/bash
# Adapter: wraps the Mind2Web evaluation harness for Dream-RSI.
# Put it outside the seed workspace and reference it by absolute path.
set -euo pipefail

# Usage: measure.sh <workspace>
WORKSPACE="${1:-.}"
cd "$WORKSPACE"
mkdir -p eval

# Load harness environment (credentials stay hidden).
HARNESS_DIR="C:/Users/juanm/Documents/GitHub/prompt-paul-agent-eval"
ENV_FILE="$HARNESS_DIR/.env"

# Point harness at the workspace as extension root (never point at production output).
export PROMPT_PAUL_EXTENSION_ROOT="$PWD"

if [ -f "$ENV_FILE" ]; then
  # Source only variable assignments (never echo values).
  set -a
  source "$ENV_FILE"
  set +a
fi

# Verify dataset presence (dataset authors ask not to redistribute unzipped files).
DATASET_DIR="C:/datasets/Mind2Web"
if [ ! -d "$DATASET_DIR" ]; then
  echo '{"score": 0.0, "fail_class": "dataset_missing", "valid": false, "error": "Mind2Web dataset not found at C:/datasets/Mind2Web; download from https://huggingface.co/datasets/osunlp/Mind2Web (test.zip, ~568MB, expands to ~6.1GB). Adapter verified structurally but harness not run."}' > eval/score.json
  echo "Adapter: dataset missing ($DATASET_DIR). Adapter structured correctly; harness invocation deferred until dataset present." >&2
  exit 1
fi

# Dataset present: attempt a minimal harness run (dry-run, limit 1) to verify adapter reaches harness.
# This uses the harness's own measurement; we never recompute the score.
# If the harness fails, we write fail_class != "ok" so the loop cannot proceed with noise.
result_file="eval/score.json"

# Capture adapter start time before harness invocation to reject stale artifacts.
start_time=$(date +%s)

# Try to run the harness via npm (relative to harness dir, with workspace as cwd for extension root).
# We run a minimal preparation + single-run command to verify adapter works end-to-end.
# Note: full evaluation requires Playwright, the pinned dataset, and working provider auth.
if (cd "$HARNESS_DIR" && npm run eval:mind2web -- --data-dir "$DATASET_DIR" --split test_domain --prepare-cases --limit 1 --temperature 0 > /dev/null 2>&1); then
  # If harness writes an artifact, read the latest result and translate to Dream-RSI format.
  # The harness writes artifacts in artifacts/runs/ or artifacts/mind2web/.
  latest=$(ls -t "$HARNESS_DIR/artifacts/runs"/*.jsonl 2>/dev/null | head -n 1 || echo "")
  if [ -n "$latest" ] && [ -f "$latest" ]; then
    # Extract first scored row's score; this is a minimal translation — verify before relying on it.
    # The harness scores exact actions (operation, target, value); a perfect run = 1.0, failure = 0.
    # We translate to Dream-RSI score: 1.0 = best, 0 = broken.
    # IMPORTANT: this adapter translation needs verification; it reads harness output but does not recompute.
    python -c "
import json, sys, os, time
start_time = int('$start_time')
try:
    # Only read artifacts produced by this adapter invocation (not stale previous runs).
    latest_path = '$latest'
    if not os.path.isfile(latest_path):
        raise FileNotFoundError('No harness artifact file found.')
    mtime = os.path.getmtime(latest_path)
    # The adapter reads only artifacts created after it started; stale artifacts are rejected.
    if mtime < start_time - 5:
        # Allow a 5-second tolerance for clock differences; anything older is considered stale.
        raise ValueError(f'.jsonl artifact is stale (mtime {mtime}, adapter start {start_time}); the adapter reads harness output, not previous runs. Check adapter/manual harness invocation.')
    lines = open('$latest').read().strip().splitlines()
    total = 0
    exact = 0
    for line in lines:
        row = json.loads(line)
        metrics = row.get('metrics', {})
        # The harness records exactMatch as a boolean; count successes.
        if metrics.get('exactMatch') is True:
            exact += 1
        total += 1
    score = exact / total if total > 0 else 0.0
    fail_class = 'ok' if total > 0 else 'harness_no_output'
    out = {'score': float(score), 'fail_class': fail_class, 'valid': True if total > 0 else False, 'adapter_note': 'Adapter reads harness output; does not recompute. Verify this translation against manual harness run before live cycle.', 'source_artifact': '$latest', 'harness_lines_read': total, 'exact_matches': exact}
    open('$result_file', 'w').write(json.dumps(out) + '\n')
    sys.exit(0)
except Exception as e:
    out = {'score': 0.0, 'fail_class': 'adapter_read_error', 'valid': False, 'error': str(e), 'adapter_note': 'Adapter failed to read harness artifact; check harness invocation manually.'}
    open('$result_file', 'w').write(json.dumps(out) + '\n')
    sys.exit(1)
"
    echo "Adapter: harness ran; score written to $result_file (verify translation before live cycle)."
    exit 0
  else
    echo '{"score": 0.0, "fail_class": "harness_no_output", "valid": false, "error": "Harness did not produce artifacts; verify harness invocation manually (npm run eval:mind2web)."}' > "$result_file"
    echo "Adapter: harness produced no artifacts; adapter structured but harness output missing." >&2
    exit 1
  fi
else
  echo '{"score": 0.0, "fail_class": "harness_failed", "valid": false, "error": "Harness command failed; check dataset, Playwright, provider auth, and extension build. Adapter structured correctly."}' > "$result_file"
  echo "Adapter: harness invocation failed; adapter structured correctly but harness did not complete." >&2
  exit 1
fi
