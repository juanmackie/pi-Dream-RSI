#!/bin/bash
# Adapter: runs and scores a pinned Mind2Web evaluation for Dream-RSI.
set -euo pipefail

WORKSPACE="${1:-.}"
SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
if [[ "$SCRIPT_DIR" == "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="."
fi
exec node "$SCRIPT_DIR/dream-rsi-mind2web-score.mjs" "$WORKSPACE"
