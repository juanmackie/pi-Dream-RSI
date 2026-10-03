#!/usr/bin/env python3
"""Behavioral replay scorer wrapper; resolves the trusted scorer beside this file."""
import json
from pathlib import Path
import subprocess
import sys

BENCHMARK_VERSION = 2
args = sys.argv[1:]
workspace = Path(next((arg for arg in args if not arg.startswith("-")), ".")).resolve()
output = workspace / "eval" / "score.json"
output.parent.mkdir(parents=True, exist_ok=True)
# A failed invocation must never leave a previous success available to its caller.
output.unlink(missing_ok=True)


def fail(message):
    data = {
        "score": 0,
        "valid": False,
        "fail_class": "scorer_crash",
        "error": message,
        "benchmark_version": BENCHMARK_VERSION,
        "per_world": [],
    }
    output.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("scorer crashed: " + message)
    return 1


def main():
    try:
        result = subprocess.run(
            ["node", str(Path(__file__).resolve().with_suffix(".mjs")), *args],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return fail(result.stderr.strip() or f"node exited with code {result.returncode}")
        data = json.loads(output.read_text(encoding="utf-8"))
        if data.get("benchmark_version") != BENCHMARK_VERSION:
            return fail("missing or unsupported benchmark version")
        print(f"score={data.get('score')} fail_class={data.get('fail_class')} benchmark_version={BENCHMARK_VERSION}")
        return 0
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return fail(str(error))


if __name__ == "__main__":
    sys.exit(main())
