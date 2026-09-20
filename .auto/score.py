#!/usr/bin/env python3
"""Synthetic replay scorer wrapper — delegates to .auto/score.mjs."""
import subprocess, sys, json, os

workspace = sys.argv[1] if len(sys.argv) > 1 else "."
result = subprocess.run(
    ["node", ".auto/score.mjs", workspace],
    capture_output=True, text=True, timeout=15
)
# .auto/score.mjs writes eval/score.json directly.
if result.returncode != 0:
    # Fallback: write a failure record.
    with open(os.path.join(workspace, "eval", "score.json"), "w") as f:
        json.dump({"score": 0, "fail_class": "scorer_crash", "errors": [result.stderr]}, f)
    print(f"scorer crashed: {result.stderr}")
else:
    with open(os.path.join(workspace, "eval", "score.json"), "r") as f:
        data = json.load(f)
    print(f"score={data.get('score')} fail_class={data.get('fail_class')}")
